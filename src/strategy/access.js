import { Vec3 } from 'vec3';

const TERRAIN = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'stone',
  'granite', 'diorite', 'andesite', 'deepslate', 'tuff']);
const HAZARDS = new Set(['water', 'lava', 'fire', 'soul_fire', 'sand', 'red_sand', 'gravel',
  'powder_snow', 'magma_block', 'cactus', 'campfire', 'soul_campfire']);
const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** 允许在已登记木门外修出短通道，入口地板、门框和设施继续保留。 */
export function canAlterEntranceTerrain(bot, state, block) {
  if (!block || !TERRAIN.has(block.name)) return false;
  const p = block.position;
  const rooms = [...(state.house?.rooms || []), ...Object.values(state.buildingRooms || {}).flat()];
  if (rooms.some(({ origin, size }) => p.x >= origin.x - 1 && p.x <= origin.x + size.width
    && p.z >= origin.z - 1 && p.z <= origin.z + size.depth
    && p.y >= origin.y - 1 && p.y <= origin.y + size.wallHeight + 2)) return false;
  const farm = state.farm;
  if (farm && p.x >= farm.origin.x - 2 && p.x <= farm.origin.x + (farm.width || 3) + 1
    && p.z >= farm.origin.z - 2 && p.z <= farm.origin.z + (farm.depth || 2) + 1
    && Math.abs(p.y - farm.origin.y) <= 3) return false;
  if ((state.pastures || []).some(({ origin }) => p.x >= origin.x - 1 && p.x <= origin.x + 5
    && p.z >= origin.z - 1 && p.z <= origin.z + 5 && Math.abs(p.y - origin.y) <= 3)) return false;
  const homes = [state.home, ...(state.archivedStorage || []).map((storage) => storage.home)].filter(Boolean);
  const exterior = homes.some((home) => {
    if (!home.door || home.dimension !== String(bot.game.dimension)) return false;
    const door = home.door;
    const entry = bot.blockAt(new Vec3(door.x, door.y, door.z));
    if (!entry?.name.endsWith('_door') || entry.name.startsWith('iron_')) return false;
    const dx = door.x - home.x;
    const dz = door.z - home.z;
    const outwardX = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0;
    const outwardZ = outwardX ? 0 : Math.sign(dz);
    const depth = (p.x - door.x) * outwardX + (p.z - door.z) * outwardZ;
    const side = Math.abs((p.x - door.x) * outwardZ - (p.z - door.z) * outwardX);
    return depth >= 1 && depth <= 4 && side <= 1 && p.y >= door.y && p.y <= door.y + 4;
  });
  if (!exterior) return false;
  return NEIGHBORS.every((offset) => {
    const neighbor = bot.blockAt(p.offset(...offset));
    return neighbor && !HAZARDS.has(neighbor.name);
  });
}
