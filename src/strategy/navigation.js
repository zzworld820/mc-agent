import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { goTo, sleep, useMovementProfile, throwIfAborted } from '../actions/helpers.js';
import { listHouseProjects } from '../building/projects.js';

const { goals } = pathfinderPkg;

// pathfinder 会把门板顶面当成站立点；穿过已确认的自有入口时改用短距离直走。
async function passDoor(ctx, door, destination) {
  const { bot, signal } = ctx;
  const dx = destination.x - door.x;
  const dz = destination.z - door.z;
  const direction = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz));
  const from = door.minus(direction);
  await goTo(bot, new goals.GoalBlock(from.x, from.y, from.z), { signal, timeoutMs: 30000 });
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

// 只操作住所档案中记录的自建入口，不靠随机拆墙进入。
export async function reachHome(ctx, home) {
  if (!home || home.dimension !== String(ctx.bot.game.dimension)) return false;
  const { bot, signal } = ctx;
  useMovementProfile(bot, 'safe');
  const inside = new Vec3(home.x, home.y, home.z);
  const door = home.door ? new Vec3(home.door.x, home.door.y, home.door.z) : null;
  if (door && bot.entity.position.distanceTo(inside) > 1.5) {
    await goTo(bot, new goals.GoalNear(door.x, door.y, door.z, 2), { signal, timeoutMs: 60000 });
    const block = bot.blockAt(door);
    if (!block?.name.endsWith('_door') || block.name.startsWith('iron_')) throw new Error('住所入口已经改变，暂不能确认可进入');
    if (!block.getProperties().open) {
      await bot.activateBlock(block);
      await sleep(200, signal);
    }
    await passDoor(ctx, door, inside);
  }
  try {
    await goTo(bot, new goals.GoalBlock(inside.x, inside.y, inside.z), { signal, timeoutMs: 15000 });
  } finally {
    if (door && door.distanceTo(bot.entity.position) < 4) {
      const block = bot.blockAt(door);
      if (block?.name.endsWith('_door') && block.getProperties().open) await bot.activateBlock(block).catch(() => {});
    }
  }
  return bot.entity.position.distanceTo(inside) < 1.8;
}

export async function leaveHome(ctx, home) {
  if (!home?.door || home.dimension !== String(ctx.bot.game.dimension)) return;
  const inside = new Vec3(home.x, home.y, home.z);
  if (ctx.bot.entity.position.distanceTo(inside) > 3.5) {
    let rooms = ctx.state.house?.rooms;
    if (!rooms && ctx.state.house?.projectId) {
      const project = (await listHouseProjects(ctx.bot)).find((entry) => entry.id === ctx.state.house.projectId);
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
  const outside = Math.abs(dx) > Math.abs(dz) ? door.offset(-Math.sign(dx) * 2, 0, 0) : door.offset(0, 0, -Math.sign(dz) * 2);
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
    await passDoor(ctx, door, outside);
    await goTo(ctx.bot, new goals.GoalBlock(outside.x, outside.y, outside.z), { signal: ctx.signal, timeoutMs: 15000 });
  } finally {
    const block = ctx.bot.blockAt(door);
    if (block?.name.endsWith('_door') && block.getProperties().open && door.distanceTo(ctx.bot.entity.position) < 4) {
      await ctx.bot.activateBlock(block).catch(() => {});
    }
    if (!ctx.signal.aborted && previousMovements) ctx.bot.pathfinder.setMovements(previousMovements);
  }
}
