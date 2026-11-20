import { Vec3 } from 'vec3';
import worldModule from 'prismarine-viewer/viewer/lib/world.js';
import modelsModule from 'prismarine-viewer/viewer/lib/models.js';
import minecraftData from 'minecraft-data';

const { World } = worldModule;
const { getSectionGeometry } = modelsModule;

/** Add visual-only substitutes; never translate block names, stateIds or props. */
export function prepareBlockStates(source, registry = minecraftData('1.21.6')) {
  const states = { ...source };
  const alias = (name, target) => {
    if (!states[name] && states[target]) states[name] = states[target];
  };
  // The existing flowerbed model already understands facing + flower_amount.
  alias('wildflowers', 'pink_petals');
  alias('pale_oak_sapling', 'birch_sapling');
  alias('pale_hanging_moss', 'hanging_roots');
  alias('open_eyeblossom', 'orange_tulip');
  alias('closed_eyeblossom', 'white_tulip');

  const cross = (name, target, height = 16, width = 1) => {
    if (states[name] || !states[target]?.variants?.['']) return;
    const state = JSON.parse(JSON.stringify(states[target]));
    const variants = state.variants[''];
    for (const variant of Array.isArray(variants) ? variants : [variants]) {
      for (const element of variant.model.elements) {
        for (const p of [element.from, element.to, element.rotation?.origin].filter(Boolean)) {
          p[0] = 8 + (p[0] - 8) * width;
          p[1] *= height / 16;
          p[2] = 8 + (p[2] - 8) * width;
        }
      }
    }
    states[name] = state;
  };
  cross('short_dry_grass', 'dead_bush', 8, 0.8);
  cross('tall_dry_grass', 'dead_bush');
  cross('bush', 'fern', 12);
  cross('firefly_bush', 'fern');
  cross('cactus_flower', 'allium', 6, 0.6);

  if (!states.leaf_litter) {
    // The transparent brown dead-bush sprite makes a close ground-level
    // substitute. Four independently rotated patches honor segment_amount.
    const texture = states.dead_bush?.variants?.['']?.model.textures.cross;
    if (texture) {
      const multipart = [];
      const quadrants = [[0, 0], [0, 8], [8, 8], [8, 0]];
      for (let i = 0; i < 4; i++) {
        const [x, z] = quadrants[i];
        const y = 0.25 + i * 0.03;
        const model = { ao: false, textures: { particle: texture }, elements: [{
          from: [x, y, z], to: [x + 8, y, z + 8],
          faces: { up: { texture: { ...texture } }, down: { texture: { ...texture } } }
        }] };
        for (const [rotation, facing] of ['north', 'east', 'south', 'west'].entries()) multipart.push({
          when: { facing, segment_amount: Array.from({ length: 4 - i }, (_, n) => String(n + i + 1)).join('|') },
          apply: { model, y: rotation * 90 }
        });
      }
      states.leaf_litter = { multipart };
    }
  }

  // Guard future/other missing plants too, using both collision metadata and
  // their name/properties. An unknown solid block keeps the diagnostic model.
  for (const block of registry.blocksArray) {
    if (states[block.name] || block.boundingBox !== 'empty') continue;
    const ids = registry.blockCollisionShapes?.blocks[block.name];
    if (ids === undefined || !(Array.isArray(ids) ? ids : [ids]).every(id => registry.blockCollisionShapes.shapes[id]?.length === 0)) continue;
    if (!/(?:grass|flower|sapling|moss|bush|litter|eyeblossom|fern|roots|vine)/.test(block.name)
      && !block.states?.some(state => ['flower_amount', 'segment_amount'].includes(state.name))) continue;
    cross(block.name, 'fern', 10, 0.8);
  }
  return states;
}

export function sectionAt(column, y) {
  return column?.sections[Math.floor((y - (column.minY ?? 0)) / 16)];
}

/** Reuse the upstream model mesher without its hard-coded neighbor Y >= 0 cull. */
export function meshSection(world, states, x, y, z) {
  const column = world.getColumn(x, z);
  // Include one extra section so even minY's bottom neighbor stays >= 0.
  const shift = Math.max(0, -(column.minY ?? 0)) + 16;
  const shiftedWorld = {
    getBlock(pos) {
      const block = world.getBlock(pos.offset(0, -shift, 0));
      if (block) block.position = pos.floored();
      return block;
    }
  };
  const geometry = getSectionGeometry(x, y + shift, z, shiftedWorld, states);
  geometry.sy -= shift;
  return geometry;
}

// Exported runtime also permits regression tests against real prismarine chunks
// without starting Minecraft, a browser, or a background worker process.
export function createMesher(post) {
  let world = null;
  let states = null;
  let generation = 0;
  const dirty = new Set();
  function finish(key) { post({ type: 'sectionFinished', key, generation }); }
  function receive(data) {
    try {
      if (data.type === 'reset') { world = null; states = null; dirty.clear(); generation = data.generation; }
      else if (data.type === 'version') {
        if (data.version !== '1.21.6') throw new Error(`Mesher only supports Java 1.21.6, received ${data.version}`);
        world = new World(data.version);
        generation = data.generation;
        dirty.clear();
      } else if (data.type === 'blockStates') states = prepareBlockStates(data.json);
      else if (data.type === 'chunk' && world) world.addColumn(data.x, data.z, data.chunk);
      else if (data.type === 'unloadChunk' && world) {
        world.removeColumn(data.x, data.z);
        for (const key of dirty) {
          const [x, , z] = key.split(',').map(Number);
          if (x === data.x && z === data.z) { dirty.delete(key); finish(key); }
        }
      } else if (data.type === 'blockUpdate' && world) world.setBlockStateId(new Vec3(data.pos.x, data.pos.y, data.pos.z), data.stateId);
      else if (data.type === 'dirty') {
        const x = Math.floor(data.x / 16) * 16;
        const y = Math.floor(data.y / 16) * 16;
        const z = Math.floor(data.z / 16) * 16;
        const key = `${x},${y},${z}`;
        if (data.value !== false && sectionAt(world?.getColumn(x, z), y)) dirty.add(key);
        else { dirty.delete(key); finish(key); }
      }
    } catch (error) { post({ type: 'error', error: error.message, generation }); }
  }
  function flush() {
    if (!world || !states) return;
    // Bound each task so incoming block changes/unloads can be processed.
    const start = performance.now();
    for (const key of dirty) {
      dirty.delete(key);
      const [x, y, z] = key.split(',').map(Number);
      try {
        if (sectionAt(world.getColumn(x, z), y)) {
          const geometry = meshSection(world, states, x, y, z);
          const transfer = ['positions', 'normals', 'colors', 'uvs'].map(k => geometry[k].buffer);
          post({ type: 'geometry', key, geometry, generation }, transfer);
        }
      } catch (error) { post({ type: 'error', key, error: error.message, generation }); }
      finish(key);
      if (performance.now() - start > 12) break;
    }
  }
  return { receive, flush };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const mesher = createMesher((data, transfer) => self.postMessage(data, transfer));
  self.onmessage = ({ data }) => mesher.receive(data);
  setInterval(mesher.flush, 16);
}
