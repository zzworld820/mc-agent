import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { digWithTimeout, goTo, sleep, useMovementProfile, throwIfAborted, exposedHostileAt } from '../actions/helpers.js';
import { listHouseProjects } from '../building/projects.js';
import { placeBlockAt } from '../autonomy/skills/build.js';
import { placeBlockNear } from '../autonomy/skills/world.js';
import { tryLocalUnstuck } from './unstuck.js';

const { goals } = pathfinderPkg;
const UNSAFE_APPROACH = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus',
  'campfire', 'soul_campfire', 'powder_snow', 'sand', 'red_sand', 'gravel']);

export function unsafeDepartureThreat(bot, outside) {
  const armor = [5, 6, 7, 8].filter(slot => bot.inventory?.slots?.[slot]).length;
  if (armor >= 2 && bot.health >= 14) return null;
  return Object.values(bot.entities || {}).find(entity => {
    const ranged = ['skeleton', 'stray', 'bogged', 'witch', 'pillager'].includes(entity.name);
    if (entity.type !== 'hostile' && !ranged && !['zombie', 'husk', 'spider', 'creeper', 'drowned'].includes(entity.name)) return false;
    return entity.position.distanceTo(outside) < (ranged ? 18 : 8) && exposedHostileAt(bot, entity, outside.offset(.5, 0, .5));
  });
}

export class GoalSurface extends goals.Goal {
  constructor(bot, height) { super(); this.bot = bot; this.height = height; }
  heuristic(node) { return Math.max(0, this.height - node.y); }
  isEnd(node) {
    const position = new Vec3(node.x, node.y, node.z);
    const block = this.bot.blockAt(position);
    return block?.skyLight > 0 && ['air', 'short_grass', 'fern', 'tall_grass'].includes(block.name)
      && this.bot.blockAt(position.offset(0, -1, 0))?.boundingBox === 'block'
      && this.bot.blockAt(position.offset(0, 1, 0))?.boundingBox === 'empty';
  }
}

export async function reachSurface(ctx, height) {
  const { bot, signal } = ctx;
  if (height - bot.entity.position.y <= 8 || bot.blockAt(bot.entity.position.floored())?.skyLight !== 0) return;
  ctx.log('先沿可施工路径返回地表，再前往设施');
  useMovementProfile(bot, 'free');
  await goTo(bot, new GoalSurface(bot, height), { signal, timeoutMs: 60000 });
}

// pathfinder 会把门板顶面当成站立点；穿过已确认的自有入口时改用短距离直走。
async function passDoor(ctx, door, destination, checkDeparture) {
  const { bot, signal } = ctx;
  const dx = destination.x - door.x;
  const dz = destination.z - door.z;
  const direction = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz));
  const from = door.minus(direction);
  await goTo(bot, new goals.GoalBlock(from.x, from.y, from.z), { signal, timeoutMs: ctx.shelterRetreat ? 5000 : 30000 });
  throwIfAborted(signal);
  checkDeparture?.();
  let block = bot.blockAt(door);
  if (!block?.name.endsWith('_door') || block.name.startsWith('iron_')) throw new Error('自有入口不再是可操作的木门');
  if (!block.getProperties().open) await bot.activateBlock(block);
  for (let i = 0; i < 30 && !bot.blockAt(door)?.getProperties().open; i++) await sleep(50, signal);
  if (!bot.blockAt(door)?.getProperties().open) throw new Error('服务器未确认木门打开');
  const target = door.plus(direction).offset(0.5, 0, 0.5);
  for (const p of [from, door, door.plus(direction)]) {
    if (bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') throw new Error('门口通道缺少地板');
    for (const y of [0, 1]) {
      const current = bot.blockAt(p.offset(0, y, 0));
      if (!current || current.boundingBox !== 'empty' && !(current.name.endsWith('_door') && current.getProperties().open)) throw new Error('门口通道受阻');
    }
  }
  bot.pathfinder.setGoal(null);
  const deadline = Date.now() + 5000;
  try {
    while (Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z) > 0.3) {
      throwIfAborted(signal);
      if (Date.now() > deadline) throw new Error('未能通过自有入口，停止移动');
      await bot.lookAt(new Vec3(target.x, bot.entity.position.y + 1.5, target.z), true);
      bot.setControlState('sprint', false);
      bot.setControlState('forward', true);
      await sleep(50, signal);
    }
  } finally { bot.clearControlStates(); }
}

// Keep the registered doorway fixed. An alternative is a staging point outside
// that door, so a failed approach never authorizes dismantling another wall.
async function approachHomeDoor(ctx, outside, axis, profile) {
  const { bot, signal, state } = ctx;
  const start = bot.entity.position.clone();
  const destination = new goals.GoalBlock(outside.x, outside.y, outside.z);
  const key = `${bot.game.dimension}:${outside.x},${outside.y},${outside.z}`;
  const previous = state?.homeApproachFailure;
  const repeats = previous?.key === key && start.distanceTo(previous.position) < 1.5 ? previous.repeats : 0;
  let waypoint;
  try {
    if (repeats >= 2 && !ctx.shelterRetreat && (bot.time?.timeOfDay ?? 0) < 10000 && bot.health >= 14 && bot.food >= 12) {
      const lateral = new Vec3(axis.z, 0, -axis.x);
      const candidates = [-2, 2, -1, 1].flatMap(side => [0, -1, 1].map(dy =>
        outside.minus(axis).plus(lateral.scaled(side)).offset(0, dy, 0)))
        .filter(p => {
          const cells = [-1, 0, 1].map(y => bot.blockAt(p.offset(0, y, 0)));
          return cells.every(block => block && !UNSAFE_APPROACH.has(block.name))
            && cells[0].boundingBox === 'block' && cells.slice(1).every(block => block.boundingBox === 'empty')
            && start.distanceTo(p.offset(.5, 0, .5)) > 1.25 && !unsafeDepartureThreat(bot, p);
        });
      if (candidates.length) {
        waypoint = candidates[(previous.nextWaypoint ?? 0) % candidates.length];
        ctx.log?.(`返家在原站位重复失败 ${repeats} 次（${previous.reason}），改经门外落脚点 ${waypoint}`);
        await goTo(bot, new goals.GoalBlock(waypoint.x, waypoint.y, waypoint.z), { signal, timeoutMs: 10000 });
      }
    }
    try {
      await goTo(bot, destination, { signal, timeoutMs: ctx.shelterRetreat ? 5000 : 15000 });
    } catch (error) {
      throwIfAborted(signal);
      if (waypoint || ctx.shelterRetreat || (bot.time?.timeOfDay ?? 0) >= 10000 || bot.health < 14 || bot.food < 12) throw error;
      ctx.log?.(`步行返家路线不可用，白天沿可施工路线返回入口：${error.message}`);
      useMovementProfile(bot, 'free');
      try {
        try { await goTo(bot, destination, { signal, timeoutMs: 60000 }); }
        catch (routeError) {
          throwIfAborted(signal);
          if (!await tryLocalUnstuck(ctx, { target: outside })) throw routeError;
          useMovementProfile(bot, 'free');
          await goTo(bot, destination, { signal, timeoutMs: 60000 });
        }
      } finally { useMovementProfile(bot, profile); }
    }
  } catch (error) {
    throwIfAborted(signal);
    if (state && !ctx.shelterRetreat) {
      const p = bot.entity.position;
      const sameFailure = repeats > 0 && error.message === previous.reason && p.distanceTo(start) < 1.5;
      state.homeApproachFailure = { key, reason: error.message, repeats: sameFailure ? repeats + 1 : 1,
        nextWaypoint: (repeats > 0 ? previous.nextWaypoint ?? 0 : 0) + Number(Boolean(waypoint)),
        position: { x: p.x, y: p.y, z: p.z } };
    }
    if (waypoint) {
      ctx.log?.(`改经 ${waypoint} 未到入口：${error.message}`);
      bot.emit?.('agentIncident', { type: 'attempt', goal: '返家', reason: previous.reason,
        solution: `改走门外站位 ${waypoint}`, result: error.message });
    }
    throw error;
  }
  if (state?.homeApproachFailure?.key === key) delete state.homeApproachFailure;
  if (waypoint) {
    ctx.log?.(`改经 ${waypoint} 已到入口，继续通过木门`);
    bot.emit?.('agentIncident', { type: 'attempt', goal: '返家', reason: previous.reason,
      solution: `改走门外站位 ${waypoint}`, result: '到达门外入口，等待进门确认' });
  }
}

// 只操作住所档案中记录的自建入口，不靠随机拆墙进入。
export async function reachHome(ctx, home) {
  if (!home || home.dimension !== String(ctx.bot.game.dimension)) return false;
  const { bot, signal } = ctx;
  const knownHomes = [ctx.state?.home, ...(ctx.state?.archivedStorage || []).map((storage) => storage.home)].filter(Boolean);
  for (const previous of knownHomes) {
    const position = new Vec3(previous.x, previous.y, previous.z);
    if (previous.dimension === home.dimension && previous.door && position.distanceTo(new Vec3(home.x, home.y, home.z)) > 1
      && bot.entity.position.distanceTo(position) < 3.5) await leaveHome(ctx, previous);
  }
  const profile = ctx.shelterRetreat ? 'retreat' : 'safe';
  useMovementProfile(bot, profile);
  const inside = new Vec3(home.x, home.y, home.z);
  const door = home.door ? new Vec3(home.door.x, home.door.y, home.door.z) : null;
  const inward = door && inside.minus(door);
  const axis = inward && (Math.abs(inward.x) > Math.abs(inward.z) ? new Vec3(Math.sign(inward.x), 0, 0) : new Vec3(0, 0, Math.sign(inward.z)));
  const relative = door && bot.entity.position.minus(door.offset(0.5, 0, 0.5));
  const depth = axis && relative.dot(axis);
  const side = axis && Math.abs(relative.x * axis.z - relative.z * axis.x);
  const projectId = home.projectId || (home === ctx.state?.home ? ctx.state.house?.projectId : null);
  let rooms = projectId ? ctx.state?.buildingRooms?.[projectId] : null;
  if (!rooms && projectId && projectId === ctx.state?.house?.projectId) rooms = ctx.state.house.rooms;
  if (!rooms && home.kind === 'house' && projectId) {
    const project = (await listHouseProjects(bot)).find((entry) => entry.id === projectId);
    if (project) rooms = [{ origin: project.origin, size: project.model.size },
      ...project.extensions.map((entry) => ({ origin: entry.origin, size: entry.module.size }))];
  }
  const p = bot.entity.position;
  // A house is a room, not one exact center coordinate. Routing an occupant
  // outside first traps it behind its own closed door and repeats forever.
  const insideHouse = home.kind === 'house' && rooms?.some(({ origin, size }) =>
    p.x >= origin.x + 1 && p.x < origin.x + size.width - 1
    && p.z >= origin.z + 1 && p.z < origin.z + size.depth - 1
    && Math.abs(p.y - (origin.y + 1)) < 0.3);
  const alreadyInside = insideHouse || home.kind === 'cave' && depth > 0 && depth < 3.6 && side < 1.5
    && Math.abs(p.y - home.y) < 1;
  if (alreadyInside) {
    const feet = bot.entity.position.floored();
    const entry = bot.blockAt(door);
    const clear = [feet, feet.offset(0, 1, 0)].every((p) => bot.blockAt(p)?.boundingBox === 'empty');
    if (clear && bot.blockAt(feet.offset(0, -1, 0))?.boundingBox === 'block'
      && entry?.name.endsWith('_door') && !entry.name.startsWith('iron_')) {
      if (entry.getProperties().open) {
        await bot.activateBlock(entry);
        await sleep(200, signal);
        if (bot.blockAt(door)?.getProperties().open) throw new Error('服务器未确认住所木门关闭');
      }
      return true;
    }
  }
  if (door && !alreadyInside && bot.entity.position.distanceTo(inside) > 1.5) {
    const outside = door.minus(axis);
    await approachHomeDoor(ctx, outside, axis, profile);
    const block = bot.blockAt(door);
    if (!block?.name.endsWith('_door') || block.name.startsWith('iron_')) throw new Error('住所入口已经改变，暂不能确认可进入');
    if (!block.getProperties().open) {
      await bot.activateBlock(block);
      await sleep(200, signal);
    }
    await passDoor(ctx, door, inside);
  }
  try {
    await goTo(bot, home.kind === 'cave' ? new goals.GoalNear(inside.x, inside.y, inside.z, 1)
      : new goals.GoalBlock(inside.x, inside.y, inside.z), { signal, timeoutMs: ctx.shelterRetreat ? 5000 : 15000 });
  } finally {
    if (door && door.distanceTo(bot.entity.position) < 4) {
      const block = bot.blockAt(door);
      if (block?.name.endsWith('_door') && block.getProperties().open) await bot.activateBlock(block).catch(() => {});
    }
  }
  return bot.entity.position.distanceTo(inside) < 1.8;
}

/** 缺门时只允许穿过原入口的完整步行通道，先取补给再修门。 */
export function hasOpenHomeExit(bot, door, outside) {
  const axis = outside.minus(door).normalize();
  return [door.minus(axis), door, outside].every(position => {
    const floor = bot.blockAt(position.offset(0, -1, 0));
    return floor?.boundingBox === 'block' && !UNSAFE_APPROACH.has(floor.name)
      && [0, 1].every(y => ['air', 'cave_air'].includes(bot.blockAt(position.offset(0, y, 0))?.name));
  });
}

export async function leaveHome(ctx, home) {
  if (!home?.door || home.dimension !== String(ctx.bot.game.dimension)) return;
  const inside = new Vec3(home.x, home.y, home.z);
  const entrance = new Vec3(home.door.x, home.door.y, home.door.z);
  const inward = inside.minus(entrance);
  const axis = Math.abs(inward.x) > Math.abs(inward.z) ? new Vec3(Math.sign(inward.x), 0, 0) : new Vec3(0, 0, Math.sign(inward.z));
  if (ctx.bot.entity.position.minus(entrance.offset(0.5, 0, 0.5)).dot(axis) < -0.2) return;
  if (ctx.bot.entity.position.distanceTo(inside) > 3.5) {
    const projectId = home.projectId || ctx.state.house?.projectId;
    let rooms = projectId === ctx.state.house?.projectId ? ctx.state.house?.rooms : null;
    if (!rooms && projectId) {
      const project = (await listHouseProjects(ctx.bot)).find((entry) => entry.id === projectId);
      if (project) rooms = [{ origin: project.origin, size: project.model.size }, ...project.extensions.map((entry) => ({ origin: entry.origin, size: entry.module.size }))];
    }
    const p = ctx.bot.entity.position;
    if (!rooms?.some(({origin,size}) => p.x >= origin.x && p.x < origin.x + size.width
      && p.z >= origin.z && p.z < origin.z + size.depth && p.y >= origin.y && p.y <= origin.y + size.wallHeight + 1)) return;
    useMovementProfile(ctx.bot, 'safe');
    await goTo(ctx.bot, new goals.GoalNear(inside.x, inside.y, inside.z, 1), { signal: ctx.signal, timeoutMs: 30000 });
  }
  const door = new Vec3(home.door.x, home.door.y, home.door.z);
  const dx = home.x - door.x;
  const dz = home.z - door.z;
  const outside = Math.abs(dx) > Math.abs(dz) ? door.offset(-Math.sign(dx), 0, 0) : door.offset(0, 0, -Math.sign(dz));
  const checkDeparture = () => {
    if (ctx.bot.strategySupervisor?.active && (ctx.bot.time?.timeOfDay ?? 0) >= 10000) {
      throw new Error('已到避难时段，留在住所，天亮后复查外出条件');
    }
    const threat = unsafeDepartureThreat(ctx.bot, outside);
    if (threat) throw new Error(`出口外有可见 ${threat.name}，当前防护不足，留在住所等待安全外出窗口`);
  };
  checkDeparture();
  if (hasOpenHomeExit(ctx.bot, door, outside)) {
    const previousMovements = ctx.bot.pathfinder.movements;
    useMovementProfile(ctx.bot, 'safe');
    try {
      ctx.log?.('原入口敞开且通道完整，先出门获取补给，修门留待材料齐备');
      await goTo(ctx.bot, new goals.GoalBlock(outside.x, outside.y, outside.z), { signal: ctx.signal, timeoutMs: 15000 });
    } finally {
      if (!ctx.signal.aborted && previousMovements) ctx.bot.pathfinder.setMovements(previousMovements);
    }
    return;
  }
  await repairEntrance(ctx, door, outside);
  const floor = ctx.bot.blockAt(outside.offset(0, -1, 0));
  if (floor?.boundingBox !== 'block' || ctx.bot.blockAt(outside)?.boundingBox !== 'empty'
    || ctx.bot.blockAt(outside.offset(0, 1, 0))?.boundingBox !== 'empty'
    || ['magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow'].includes(floor.name)
    || ['water', 'lava'].includes(ctx.bot.blockAt(outside.offset(0, 1, 0))?.name)
    || ['water', 'lava', 'fire', 'soul_fire'].includes(ctx.bot.blockAt(outside)?.name)) throw new Error('住所外侧缺少可确认的安全出口');
  const previousMovements = ctx.bot.pathfinder.movements;
  useMovementProfile(ctx.bot, 'safe');
  try {
    const block = ctx.bot.blockAt(door);
    if (!block?.name.endsWith('_door')) throw new Error('住所门已改变');
    await passDoor(ctx, door, outside, checkDeparture);
    await goTo(ctx.bot, new goals.GoalBlock(outside.x, outside.y, outside.z), { signal: ctx.signal, timeoutMs: 15000 });
  } finally {
    const block = ctx.bot.blockAt(door);
    if (block?.name.endsWith('_door') && block.getProperties().open && door.distanceTo(ctx.bot.entity.position) < 4) {
      await ctx.bot.activateBlock(block).catch(() => {});
    }
    if (!ctx.signal.aborted && previousMovements) ctx.bot.pathfinder.setMovements(previousMovements);
  }
}

// 仅修复档案入口的两格外侧地面和木门，材料全部来自现有背包。
export async function repairCaveEntrance(ctx, home) {
  if (home?.kind !== 'cave' || !home.door || home.dimension !== String(ctx.bot.game.dimension)) return;
  const door = new Vec3(home.door.x, home.door.y, home.door.z);
  const inside = new Vec3(home.x, home.y, home.z);
  const delta = door.minus(inside);
  const outward = Math.abs(delta.x) > Math.abs(delta.z) ? new Vec3(Math.sign(delta.x), 0, 0) : new Vec3(0, 0, Math.sign(delta.z));
  const blocked = [1, 0].map((dy) => door.plus(outward).offset(0, dy, 0))
    .map((p) => ctx.bot.blockAt(p)).filter((block) => block?.boundingBox === 'block');
  if (!blocked.length) return;
  const plan = ctx.state.plannedShelter;
  if (!plan || !door.equals(new Vec3(plan.entrance.x, plan.entrance.y, plan.entrance.z))) throw new Error('没有匹配的自建洞口记录，暂不清理堵塞');
  if ((ctx.bot.time?.timeOfDay ?? 0) >= 10000) throw new Error('洞口受阻，等待白天再恢复出口');
  if (blocked.some((block) => !['dirt', 'grass_block', 'cobblestone'].includes(block.name))) throw new Error('自有洞口被未知材料堵塞，保留现场');
  const entrance = ctx.bot.blockAt(door);
  if (!entrance?.name.endsWith('_door')) throw new Error('洞口木门缺失，暂不打开出口');
  const wasOpen = entrance.getProperties().open;
  try {
    if (!wasOpen) await ctx.bot.activateBlock(entrance);
    for (const block of blocked) {
      throwIfAborted(ctx.signal);
      const tool = ctx.bot.pathfinder.bestHarvestTool(block);
      if (tool) await ctx.bot.equip(tool, 'hand');
      if (!block.canHarvest(ctx.bot.heldItem?.type ?? null)) throw new Error('缺少清理自有洞口的工具');
      const abort = () => ctx.bot.stopDigging();
      ctx.signal.addEventListener('abort', abort, { once: true });
      try { await digWithTimeout(ctx.bot, block, 15000); }
      finally { ctx.signal.removeEventListener('abort', abort); }
    }
    ctx.log?.('已恢复档案中自建山洞的门外通道');
  } finally {
    const current = ctx.bot.blockAt(door);
    if (!wasOpen && current?.getProperties().open) await ctx.bot.activateBlock(current).catch(() => {});
  }
}

async function repairEntrance(ctx, door, outside) {
  const { bot, signal } = ctx;
  await repairCaveEntrance(ctx, ctx.state.home);
  const direction = outside.minus(door).scaled(0.5);
  const floors = [door, door.plus(direction), outside].map((p) => p.offset(0, -1, 0));
  for (const position of floors) {
    const block = bot.blockAt(position);
    if (block?.boundingBox === 'block') continue;
    if (!block || !['air', 'cave_air'].includes(block.name)
      || bot.blockAt(position.offset(0, -1, 0))?.boundingBox !== 'block') throw new Error('入口地基损坏，无法在已确认支撑上修补');
    await craftCarried('oak_planks');
    const material = bot.inventory.items().find((item) => ['cobblestone', 'dirt', 'oak_planks'].includes(item.name));
    if (!material) throw new Error('缺少修复入口地面的随身材料');
    await placeBlockAt(ctx, position, material.name);
    ctx.log?.('已修补自有入口地面');
  }
  const entrance = bot.blockAt(door);
  if (!entrance || entrance.name.endsWith('_door')) return;
  if (!['air', 'cave_air'].includes(entrance.name)
    || !['air', 'cave_air'].includes(bot.blockAt(door.offset(0, 1, 0))?.name)) throw new Error('入口被其他方块占据，无法恢复木门');
  for (let i = 0; i < 2; i++) await craftCarried('oak_planks');
  if (!bot.inventory.items().some((item) => item.name === 'oak_door')) {
    let table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 3 });
    if (!table) {
      await craftCarried('crafting_table');
      table = await placeBlockNear(ctx, 'crafting_table');
    }
    await craftCarried('oak_door', table);
  }
  await placeBlockAt(ctx, door, 'oak_door', { allowDoor: true });
  ctx.log?.('已恢复自有入口木门');

  async function craftCarried(name, table = null) {
    throwIfAborted(signal);
    const recipe = bot.recipesFor(bot.registry.itemsByName[name].id, null, 1, table)[0];
    if (recipe) await bot.craft(recipe, 1, table);
  }
}
