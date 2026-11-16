import { Vec3 } from 'vec3';
import { matchesFeature, PERCEPTION_TYPES, STRUCTURE_RULES } from './structures.js';
import { readWorldState } from './state.js';

const MAX_RADIUS = 32;
const FEATURE_LIMIT = 256;
const MAX_OBJECTS = 32;
const AIR = new Set(['air', 'cave_air', 'void_air']);
const SURFACE_COVER = new Set([...AIR, 'snow', 'lily_pad']);
const RIVER_BIOMES = new Set(['river', 'frozen_river']);
const SOILS = new Set(['dirt', 'grass_block', 'podzol', 'rooted_dirt', 'mud', 'moss_block', 'coarse_dirt', 'mycelium']);

function dimensionKind(id) {
  if (['the_nether', 'nether'].includes(id)) return 'nether';
  if (['the_end', 'end'].includes(id)) return 'end';
  return id;
}

function coordinates(position) { return { x: position.x, y: position.y, z: position.z }; }
function key(position) { return `${position.x},${position.y},${position.z}`; }

function bounds(positions) {
  return {
    min: { x: Math.min(...positions.map((p) => p.x)), y: Math.min(...positions.map((p) => p.y)), z: Math.min(...positions.map((p) => p.z)) },
    max: { x: Math.max(...positions.map((p) => p.x)), y: Math.max(...positions.map((p) => p.y)), z: Math.max(...positions.map((p) => p.z)) },
  };
}

function findFeature(bot, origin, radius, feature) {
  const ids = Object.values(bot.registry.blocksByName).filter((block) => matchesFeature(block.name, feature)).map((block) => block.id);
  if (!ids.length) return [];
  return bot.findBlocks({
    point: origin, matching: ids, maxDistance: radius, count: FEATURE_LIMIT,
    useExtraInfo: (block) => {
      const properties = block.getProperties();
      return Object.entries(feature.properties ?? {}).every(([name, value]) => properties[name] === value)
        && (!feature.surfaceOnly || SURFACE_COVER.has(bot.blockAt(block.position.offset(0, 1, 0))?.name));
    },
  });
}

function objectReport(type, name, anchor, evidencePositions, evidence, confidence, caveat, extra = {}) {
  return {
    type, name, position: coordinates(anchor), evidenceBounds: bounds(evidencePositions),
    classification: 'inferred', confidence, evidence, caveat, ...extra,
  };
}

function chooseAnchors(positions, separation, limit = 24) {
  const selected = [];
  for (const position of positions) {
    if (selected.every((other) => other.distanceTo(position) >= separation)) selected.push(position);
    if (selected.length >= limit) break;
  }
  return selected;
}

function detectStructure(bot, origin, radius, rule, scan) {
  const features = [];
  for (const group of rule.groups) {
    const feature = { ...group, positions: findFeature(bot, origin, radius, group) };
    if (feature.positions.length === FEATURE_LIMIT) scan.sampleCaps.push(`${rule.type}:${feature.id}`);
    if (feature.min && feature.positions.length < feature.min) return [];
    features.push(feature);
  }
  // 稀有特征优先作为锚点，避免普通建材占满候选名额。
  const seeds = features.filter((feature) => feature.positions.length)
    .sort((a, b) => a.positions.length - b.positions.length)
    .flatMap((feature) => chooseAnchors(feature.positions, 4, 8));
  const anchors = chooseAnchors(seeds, 4);
  if (anchors.length === 24) scan.candidateLimitReached = true;
  const candidates = [];
  for (const anchor of anchors) {
    const nearby = features.map((feature) => ({ ...feature, positions: feature.positions.filter((position) => position.distanceTo(anchor) <= rule.radius) }));
    if (nearby.some((feature) => feature.min && feature.positions.length < feature.min)) continue;
    if (rule.spread) {
      const positions = nearby.find((feature) => feature.id === rule.spread.group).positions;
      if (!positions.some((a) => positions.some((b) => a.distanceTo(b) >= rule.spread.min))) continue;
    }
    const evidence = nearby.filter((feature) => feature.positions.length >= (feature.threshold ?? feature.min ?? 1))
      .map((feature) => ({ feature: feature.id, description: feature.label, observedCount: feature.positions.length, samples: feature.positions.slice(0, 3).map(coordinates) }));
    const entityPositions = [];
    for (const group of rule.entities ?? []) {
      const entities = Object.values(bot.entities).filter((entity) => entity !== bot.entity && group.names.includes(entity.name)
        && entity.position.distanceTo(origin) <= radius && entity.position.distanceTo(anchor) <= rule.radius);
      if (entities.length < (group.threshold ?? 1)) continue;
      entityPositions.push(...entities.map((entity) => entity.position));
      evidence.push({ feature: group.id, description: group.label, observedCount: entities.length, samples: entities.slice(0, 3).map((entity) => coordinates(entity.position)) });
    }
    const supported = new Set(evidence.map((entry) => entry.feature));
    if (rule.alternatives && !rule.alternatives.some((group) => group.every((id) => supported.has(id)))) continue;
    const positions = [...nearby.flatMap((feature) => feature.positions), ...entityPositions];
    candidates.push(objectReport(rule.type, rule.name, anchor, positions, evidence,
      evidence.length >= 5 ? 'high' : 'medium', rule.caveat));
  }
  candidates.sort((a, b) => b.evidence.length - a.evidence.length);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.every((other) => new Vec3(other.position.x, other.position.y, other.position.z)
      .distanceTo(new Vec3(candidate.position.x, candidate.position.y, candidate.position.z)) > rule.radius)) selected.push(candidate);
    if (selected.length >= 4) { scan.candidateLimitReached = true; break; }
  }
  return selected;
}

function detectTrees(bot, origin, radius, scan) {
  const seeds = findFeature(bot, origin, radius, { suffix: '_log' })
    .filter((position) => !bot.blockAt(position)?.name.startsWith('stripped_'));
  if (seeds.length === FEATURE_LIMIT) scan.sampleCaps.push('tree:logs');
  const seen = new Set();
  const trees = [];
  let visits = 0;
  for (const seed of seeds) {
    if (seen.has(key(seed))) continue;
    const species = bot.blockAt(seed)?.name;
    if (!species) continue;
    const queue = [seed];
    const logs = [];
    let partial = false;
    seen.add(key(seed));
    for (let cursor = 0; cursor < queue.length && cursor < 256; cursor++) {
      const position = queue[cursor];
      logs.push(position);
      visits++;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dy && !dz) continue;
            const next = position.offset(dx, dy, dz);
            if (seen.has(key(next))) continue;
            if (next.distanceTo(origin) > radius) { partial = true; continue; }
            const block = bot.blockAt(next);
            if (!block) { partial = true; continue; }
            if (block.name !== species) continue;
            seen.add(key(next));
            queue.push(next);
          }
        }
      }
      if (visits >= 2048) { partial = true; break; }
    }
    if (queue.length > logs.length) partial = true;
    const leaves = new Map();
    // 检查多处树干周围的树冠，不把“附近一个叶子”当成整棵树。
    const probes = chooseAnchors(logs.slice().sort((a, b) => b.y - a.y), 3, 8);
    for (const position of probes) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -1; dy <= 3; dy++) {
          for (let dz = -2; dz <= 2; dz++) {
            const next = position.offset(dx, dy, dz);
            if (next.distanceTo(origin) > radius) continue;
            const block = bot.blockAt(next);
            if (!block) { partial = true; continue; }
            if (block.name.endsWith('_leaves') && block.getProperties().persistent === false) leaves.set(key(next), next);
          }
        }
      }
    }
    const roots = logs.filter((position) => SOILS.has(bot.blockAt(position.offset(0, -1, 0))?.name));
    const upright = logs.filter((position) => bot.blockAt(position)?.getProperties().axis === 'y');
    const height = Math.max(...logs.map((position) => position.y)) - Math.min(...logs.map((position) => position.y)) + 1;
    if (logs.length >= 2 && upright.length >= 2 && height >= 2 && leaves.size >= 4) {
      const base = logs.reduce((a, b) => a.y < b.y ? a : b);
      const evidence = [
        { feature: 'trunk', description: '连通原木', observedCount: logs.length },
        { feature: 'upright', description: '竖直轴原木', observedCount: upright.length },
        { feature: 'crown', description: '附近非持久树叶', observedCount: leaves.size },
        { feature: 'ground', description: '土壤支撑的树干', observedCount: roots.length },
      ];
      trees.push(objectReport('tree', '树木', base, [...logs, ...leaves.values()], evidence,
        roots.length && !partial ? 'high' : 'medium',
        '相接的同种树干可能合并；原木建筑紧邻天然树冠也可能误判。此结果不授予砍伐权限。',
        { species: species.replace(/_log$/, ''), observedLogs: logs.length, trunkHeight: height, partial,
          logSamples: logs.slice(0, 12).map(coordinates) }));
    }
    if (trees.length >= 12 || visits >= 2048) { scan.candidateLimitReached = true; break; }
  }
  return trees;
}

function detectWater(bot, origin, radius, scan, target) {
  const seeds = findFeature(bot, origin, radius, { names: ['water', 'ice', 'frosted_ice'], surfaceOnly: true });
  if (seeds.length === FEATURE_LIMIT) scan.sampleCaps.push('water:seeds');
  const seen = new Set();
  const objects = [];
  let visits = 0;
  for (const seed of seeds) {
    if (seen.has(key(seed))) continue;
    const above = bot.blockAt(seed.offset(0, 1, 0));
    if (!above || !SURFACE_COVER.has(above.name)) continue;
    const queue = [seed];
    const surface = [];
    let partial = false;
    seen.add(key(seed));
    for (let cursor = 0; cursor < queue.length && cursor < 512; cursor++) {
      const position = queue[cursor];
      surface.push(position);
      visits++;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = position.offset(dx, 0, dz);
        if (seen.has(key(next))) continue;
        if (next.distanceTo(origin) > radius) { partial = true; continue; }
        const block = bot.blockAt(next);
        const head = bot.blockAt(next.offset(0, 1, 0));
        if (!block || !head) { partial = true; continue; }
        if (!['water', 'ice', 'frosted_ice'].includes(block.name) || !SURFACE_COVER.has(head.name)) continue;
        seen.add(key(next));
        queue.push(next);
      }
      if (visits >= 2048) { partial = true; break; }
    }
    if (queue.length > surface.length) partial = true;
    if (surface.length >= 8) {
      const riverCells = surface.filter((position) => RIVER_BIOMES.has(bot.blockAt(position)?.biome?.name));
      const area = bounds(surface);
      const width = area.max.x - area.min.x + 1;
      const depth = area.max.z - area.min.z + 1;
      const river = riverCells.length >= 4 && riverCells.length / surface.length >= 0.5;
      const elongated = Math.max(width, depth) >= 12 && Math.max(width, depth) / Math.max(1, Math.min(width, depth)) >= 2.5;
      const type = river ? 'river' : 'water_body';
      if (target !== 'river' || river) {
        objects.push(objectReport(type, river ? '河流' : '水域', seed, surface, [
          { feature: 'surface', description: '同高连通的水面或冰面', observedCount: surface.length },
          { feature: 'river_biome', description: '河流群系水面采样', observedCount: riverCells.length },
        ], river ? 'high' : 'medium', '只观察局部表面；水深、流向、完整边界和可渡性未确认。',
        { partial, shape: elongated ? 'elongated' : 'undetermined', observedSurfaceCells: surface.length }));
      }
    }
    if (objects.length >= 6 || visits >= 2048) { scan.candidateLimitReached = true; break; }
  }
  return objects;
}

/** 读取已加载区块；结果不等于视线可见，更不代表服务器全地图。 */
export async function scanEnvironment(bot, { radius = 24, target = 'all' } = {}) {
  if (!PERCEPTION_TYPES.some((entry) => entry.type === target) && target !== 'all') throw new Error(`不支持的感知类型：${target}`);
  const numericRadius = Number(radius);
  if (!Number.isFinite(numericRadius) || numericRadius < 4) throw new Error('扫描半径需为 4～32 格');
  radius = Math.min(MAX_RADIUS, Math.floor(numericRadius));
  const state = readWorldState(bot);
  if (!state.position) throw new Error('还没有进入世界，无法扫描');
  const origin = bot.entity.position.floored();
  const kind = dimensionKind(state.dimension.id);
  const scan = { source: 'loaded_client_chunks', radius, sampleCaps: [], candidateLimitReached: false, incomplete: true };
  const objects = [];
  if (target === 'all' || target === 'tree') objects.push(...detectTrees(bot, origin, radius, scan));
  await new Promise((resolve) => setImmediate(resolve));
  if (['all', 'river', 'water_body'].includes(target)) objects.push(...detectWater(bot, origin, radius, scan, target));
  for (const rule of STRUCTURE_RULES) {
    if (target !== 'all' && target !== rule.type) continue;
    if (!rule.dimensions.includes(kind)) continue;
    await new Promise((resolve) => setImmediate(resolve));
    if (String(bot.game?.dimension ?? 'unknown').replace('minecraft:', '') !== state.dimension.id) throw new Error('扫描期间切换了维度，请重新扫描');
    objects.push(...detectStructure(bot, origin, radius, rule, scan));
  }
  const endedAt = new Date().toISOString();
  if (String(bot.game?.dimension ?? 'unknown').replace('minecraft:', '') !== state.dimension.id) throw new Error('扫描期间切换了维度，请重新扫描');
  objects.sort((a, b) => new Vec3(a.position.x, a.position.y, a.position.z).distanceTo(origin)
    - new Vec3(b.position.x, b.position.y, b.position.z).distanceTo(origin));
  if (objects.length > MAX_OBJECTS) scan.candidateLimitReached = true;
  return {
    startedAt: state.observedAt, endedAt, origin: coordinates(origin), dimension: state.dimension, biome: state.biome,
    target, scan, objects: objects.slice(0, MAX_OBJECTS),
    interpretation: '置信度为规则证据等级，不是统计概率。结构名称均为候选分类；证据边界不是建筑完整边界。未检出不等于不存在；不推断所有权、箱内物品或未观察的房间。',
  };
}
