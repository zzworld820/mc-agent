import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { sleep, throwIfAborted } from '../../actions/helpers.js';

const { goals } = pathfinderPkg;
const SOILS = new Set(['dirt', 'grass_block', 'podzol', 'rooted_dirt', 'mud', 'moss_block', 'coarse_dirt', 'mycelium']);
const key = (p) => `${p.x},${p.y},${p.z}`;
const point = (p) => new Vec3(p.x, p.y, p.z);
export const isTreeLog = (name) => typeof name === 'string' && name.endsWith('_log') && !name.startsWith('stripped_');

/** 完整扫描26邻接的树干与枝条。边界不明或多树相接时拒绝开砍。 */
export function inspectWholeTree(bot, seed, allowed = () => true) {
  const name = bot.blockAt(seed)?.name;
  if (!isTreeLog(name)) throw new Error('目标不是天然原木');
  const queue = [seed];
  const seen = new Set([key(seed)]);
  let leaves = 0;
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (queue.length > 128 || p.distanceTo(seed) > 24) throw new Error('树体过大或相连边界不明');
    if (!allowed(p)) throw new Error('整棵树涉及受保护区域');
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const next = p.offset(dx, dy, dz);
      const block = bot.blockAt(next);
      if (!block) throw new Error('树体邻接区域尚未加载');
      if (isTreeLog(block.name) && block.name !== name) throw new Error('不同树种交错，无法确定单棵边界');
      if (block.name === name && !seen.has(key(next))) {
        seen.add(key(next));
        queue.push(next);
      }
      if (block.name.endsWith('_leaves') && block.getProperties().persistent === false) leaves++;
      if (['water', 'lava', 'fire', 'sand', 'gravel'].includes(block.name)) throw new Error('树旁存在液体、火或重力方块');
      if (block.name.endsWith('_planks') || block.name.endsWith('_door') || ['chest', 'crafting_table', 'furnace'].includes(block.name)) {
        throw new Error('树体紧邻建筑，无法确认砍伐边界');
      }
    }
  }
  const roots = queue.filter((p) => SOILS.has(bot.blockAt(p.offset(0, -1, 0))?.name));
  if (roots.length === 0 || leaves === 0 || queue.length < 2) throw new Error('缺少完整树干、天然树叶或土壤支撑');
  if (![1, 4].includes(roots.length)) throw new Error('多棵树相接，无法确定单棵边界');
  const base = roots[0];
  if (roots.some((p) => p.y !== base.y || Math.abs(p.x - base.x) > 1 || Math.abs(p.z - base.z) > 1)) {
    throw new Error('多棵树相接，无法确定单棵边界');
  }
  return { name, dimension: String(bot.game.dimension), base: { x: base.x, y: base.y, z: base.z },
    logs: queue.sort((a, b) => b.y - a.y).map((p) => ({ x: p.x, y: p.y, z: p.z })), started: false };
}

async function preflight(ctx, plan, allowed) {
  const { bot, signal } = ctx;
  const remaining = plan.logs.filter((p) => bot.blockAt(point(p))?.name === plan.name);
  const stackSize = bot.registry.itemsByName[plan.name]?.stackSize || 64;
  const capacity = bot.inventory.emptySlotCount() * stackSize + bot.inventory.items()
    .filter((item) => item.name === plan.name).reduce((sum, item) => sum + stackSize - item.count, 0);
  if (capacity < remaining.length) throw new Error('背包放不下整棵树的原木');
  const time = bot.time?.timeOfDay ?? 0;
  const seconds = remaining.length * 6 + 20;
  if (time >= 10000 || (10000 - time) / 20 < seconds) throw new Error('天色不足以完成整棵树，留待白天');
  if (bot.health < 14 || bot.food < 12) throw new Error('当前生命或饥饿不适合开砍整棵树');
  for (const p of remaining) {
    throwIfAborted(signal);
    if (!allowed(point(p))) throw new Error('树体涉及受保护区域');
    const goal = new goals.GoalLookAtBlock(point(p), bot.world, { reach: 4.5 });
    const search = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, goal, { timeout: 1000 });
    let path;
    do {
      const next = search.next();
      if (next.done) throw new Error('整树路线预检未完成');
      path = next.value.result;
      if (path.status === 'partial') await sleep(0, signal);
      throwIfAborted(signal);
    } while (path.status === 'partial');
    if (path.status !== 'success') throw new Error('有树干或枝条无法安全走到，整棵树暂不砍');
    const standingHeight = path.path.at(-1)?.y ?? bot.entity.position.y;
    if (standingHeight > plan.base.y + 1) throw new Error('需要爬高处理枝条，当前整棵树暂不砍');
    await sleep(0, signal);
  }
}

/** 数量配额由调用者在两棵树之间判断，本函数始终处理完当前树。 */
export async function harvestWholeTree(ctx, names, { dig, pickUp, onDug = async () => {}, allowed = () => true, searchDistance = 32 } = {}) {
  const { bot, state, signal } = ctx;
  let plan = state.wholeTree;
  if (plan && plan.dimension !== String(bot.game.dimension)) throw new Error('上一棵未完成的树属于另一维度，保留记录等待返回');
  if (!plan) {
    const ids = names.map((name) => bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined);
    const seeds = bot.findBlocks({ matching: ids, maxDistance: searchDistance, count: 64 });
    const visited = new Set();
    let lastError;
    for (const seed of seeds) {
      if (visited.has(key(seed))) continue;
      try {
        const candidate = inspectWholeTree(bot, seed, allowed);
        candidate.logs.forEach((p) => visited.add(key(p)));
        await preflight(ctx, candidate, allowed);
        plan = candidate;
        break;
      } catch (error) {
        throwIfAborted(signal);
        lastError = error;
      }
    }
    if (!plan) throw new Error(`附近没有可完整砍伐的树${lastError ? `（${lastError.message}）` : ''}`);
    state.wholeTree = plan;
    await ctx.checkpoint?.();
  }
  ctx.log(`${plan.started ? '继续未完成的树' : '开始整树采伐'}，树根 ${key(plan.base)}，记录原木 ${plan.logs.length} 块`);
  // 开砍后按保存坐标继续，不依赖树叶仍存在，也不会因为已够数量改砍另一棵。
  try { await preflight(ctx, plan, allowed); }
  catch (error) {
    if (!plan.started) {
      delete state.wholeTree;
      await ctx.checkpoint?.();
    }
    throw error;
  }
  plan.started = true;
  await ctx.checkpoint?.();
  for (const p of plan.logs) {
    throwIfAborted(signal);
    const current = bot.blockAt(point(p));
    if (!current) throw new Error('未完成树体尚未加载，保留记录');
    if (current.name !== plan.name) {
      if (isTreeLog(current.name)) throw new Error('树体发生变化，保留记录等待复查');
      continue;
    }
    if (!allowed(point(p))) throw new Error('树体进入受保护范围，保留未完成记录');
    await dig(current);
    if (bot.blockAt(point(p))?.name === plan.name) throw new Error('服务器尚未确认砍除原木，保留记录');
    await onDug();
    await ctx.checkpoint?.();
  }
  if (plan.logs.some((p) => !bot.blockAt(point(p)) || bot.blockAt(point(p)).name === plan.name)) throw new Error('整棵树尚未砍完');
  await pickUp(point(plan.base));
  delete state.wholeTree;
  await ctx.checkpoint?.();
  ctx.log('整棵树的原木已全部砍除，已收集可达掉落物');
}

export function protectedTarget(state, position) {
  const protectedPositions = [state.home, ...(state.archivedStorage || []).flatMap((storage) => [storage.home, ...(storage.chests || []).map((chest) => chest.position)]), ...(state.farm?.plots ?? []).map((plot) => plot.position),
    ...(state.farm?.waters ?? []).map((entry) => entry.position), ...(state.farm?.lamps ?? []).map((entry) => entry.soil),
    ...(state.storage?.chests ?? []).map((entry) => entry.position)];
  if (protectedPositions.some((p) => p && Math.abs(position.x - p.x) <= 4 && Math.abs(position.z - p.z) <= 4 && Math.abs(position.y - p.y) <= 5)) return true;
  const rooms = [...(state.house?.rooms ?? []), ...Object.values(state.buildingRooms ?? {}).flat()];
  if (rooms.some((room) => position.x >= room.origin.x - 1 && position.x <= room.origin.x + room.size.width
    && position.z >= room.origin.z - 1 && position.z <= room.origin.z + room.size.depth && position.y >= room.origin.y - 1
    && position.y <= room.origin.y + room.size.wallHeight + 2)) return true;
  if ((state.pastures ?? []).some((pasture) => position.x >= pasture.origin.x - 1 && position.x <= pasture.origin.x + 5
    && position.z >= pasture.origin.z - 1 && position.z <= pasture.origin.z + 5 && Math.abs(position.y - pasture.origin.y) <= 3)) return true;
  return false;
}
