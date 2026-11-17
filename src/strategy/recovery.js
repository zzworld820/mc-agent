import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import physicsPkg from 'prismarine-physics';
import { goTo, haltBot, throwIfAborted, useMovementProfile } from '../actions/helpers.js';

const { goals } = pathfinderPkg;
const { PlayerState } = physicsPkg;
const EMPTY = new Set(['air', 'cave_air', 'void_air']);
const DIRECTIONS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

function steering(position, velocity, target) {
  const x = (target.x - position.x) * 0.08 - velocity.x * 0.8;
  const z = (target.z - position.z) * 0.08 - velocity.z * 0.8;
  return { forward: Math.hypot(x, z) > 0.004, yaw: Math.atan2(-x, -z) };
}

export function waterLanding(bot, column, startY) {
  for (let y = startY - 3; y >= bot.game.minY; y--) {
    const position = new Vec3(column.x, y, column.z);
    const block = bot.blockAt(position);
    if (!block) return null;
    if (EMPTY.has(block.name)) continue;
    if (block.name !== 'water' || startY - y < 12) return null;
    if (bot.blockAt(position.offset(0, -1, 0))?.name !== 'water') return null;
    return position.offset(0.5, 0, 0.5);
  }
  return null;
}

export function simulateWaterDescent(bot, plan, offset = new Vec3(0, 0, 0)) {
  const control = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const state = new PlayerState(bot, control);
  state.pos = plan.approach.offset(0.5, 0, 0.5).plus(offset);
  state.vel = new Vec3(0, 0, 0);
  state.onGround = true;
  let committed = false;
  const world = { getBlock(position) {
    const block = bot.blockAt(position);
    if (!block) throw new Error('脱困轨迹经过未加载区块');
    return block;
  } };
  for (let tick = 0; tick < 240; tick++) {
    committed ||= state.pos.y < plan.approach.y - 2;
    const aim = committed ? plan.landing : plan.exit;
    const move = steering(state.pos, state.vel, aim);
    control.forward = move.forward;
    state.yaw = move.yaw;
    bot.physics.simulatePlayer(state, world);
    if (state.isInWater) return { safe: true, ticks: tick + 1, landing: state.pos.clone() };
    if (state.isInLava || state.pos.y < plan.approach.y - 3 && state.onGround) return { safe: false };
  }
  return { safe: false };
}

// 仅遍历同高度、有支撑的连通站位，再检查平台边缘下方的真实落点。
export async function findWaterDescent(bot, signal) {
  const origin = bot.entity.position.floored();
  const queue = [origin];
  const visited = new Set([`${origin.x},${origin.z}`]);
  let examined = 0;
  for (let index = 0; index < queue.length && index < 2048; index++) {
    throwIfAborted(signal);
    const approach = queue[index];
    for (const direction of DIRECTIONS) {
      const neighbor = approach.plus(direction);
      if (Math.abs(neighbor.x - origin.x) > 32 || Math.abs(neighbor.z - origin.z) > 32) continue;
      if (!EMPTY.has(bot.blockAt(neighbor)?.name) || !EMPTY.has(bot.blockAt(neighbor.offset(0, 1, 0))?.name)) continue;
      const floor = bot.blockAt(neighbor.offset(0, -1, 0));
      if (floor?.boundingBox === 'block' && !['magma_block', 'campfire', 'cactus', 'powder_snow'].includes(floor.name)) {
        const key = `${neighbor.x},${neighbor.z}`;
        if (!visited.has(key)) { visited.add(key); queue.push(neighbor); }
        continue;
      }
      if (!EMPTY.has(floor?.name)) continue;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const landing = waterLanding(bot, neighbor.offset(dx, 0, dz), origin.y);
        if (landing) {
          const plan = { approach, exit: neighbor.offset(0.5, 0, 0.5).plus(direction.scaled(0.2)), landing };
          const offsets = [new Vec3(0, 0, 0), new Vec3(0.15, 0, 0.15), new Vec3(-0.15, 0, -0.15)];
          if (offsets.every((offset) => simulateWaterDescent(bot, plan, offset).safe)) return plan;
        }
        if (++examined % 16 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (index % 16 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}

export async function descendToWater(ctx) {
  const { bot, signal } = ctx;
  useMovementProfile(bot, 'safe');
  const plan = await findWaterDescent(bot, signal);
  if (!plan) throw new Error('已扫描连通平台，尚未找到经物理验证的安全落水路线');
  ctx.log(`发现安全落水方案，目标 ${plan.landing.x}, ${plan.landing.y}, ${plan.landing.z}`);
  await goTo(bot, new goals.GoalBlock(plan.approach.x, plan.approach.y, plan.approach.z), { signal, timeoutMs: 60000 });
  haltBot(bot);
  await bot.waitForTicks(5);
  // 使用实际到达的站位再次验证，避免把站位误差带进高空路线。
  const offset = bot.entity.position.minus(plan.approach.offset(0.5, 0, 0.5));
  if (!simulateWaterDescent(bot, plan, offset).safe) throw new Error('实际站位未通过落水轨迹复核');
  const beforeHealth = bot.health;
  let committed = false;
  const deadline = Date.now() + 20000;
  bot.safeDescent = { landing: plan.landing, expiresAt: deadline };
  try {
    while (Date.now() < deadline && bot.health > 0) {
      // 进入下落后保持落点控制，落水后再处理取消和其他目标。
      if (!committed) throwIfAborted(signal);
      committed ||= bot.entity.position.y < plan.approach.y - 2;
      if (bot.entity.isInWater) {
        ctx.log(`已安全落水，生命值 ${beforeHealth} → ${bot.health}`);
        bot.clearControlStates();
        bot.setControlState('jump', true);
        while (Date.now() < deadline && bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.name === 'water') {
          await bot.waitForTicks(1);
        }
        bot.clearControlStates();
        delete bot.safeDescent;
        const shore = [];
        const center = plan.landing.floored();
        for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = 1; y <= 5; y++) {
          const position = center.offset(x, y, z);
          const floor = bot.blockAt(position.offset(0, -1, 0));
          if (floor?.boundingBox === 'block' && !['magma_block', 'campfire', 'cactus', 'powder_snow'].includes(floor.name)
            && bot.blockAt(position)?.boundingBox === 'empty' && bot.blockAt(position)?.name !== 'water'
            && bot.blockAt(position.offset(0, 1, 0))?.boundingBox === 'empty') shore.push(position);
        }
        shore.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
        let landed = false;
        for (const position of shore.slice(0, 4)) {
          try {
            await goTo(bot, new goals.GoalBlock(position.x, position.y, position.z), { signal, timeoutMs: 10000 });
            landed = true;
            break;
          } catch (error) { throwIfAborted(signal); }
        }
        if (!landed) throw new Error('已落水并浮出水面，仍需寻找可达岸边');
        ctx.log('已到达岸边，恢复地面生存');
        return { landing: bot.entity.position.clone(), beforeHealth, afterHealth: bot.health };
      }
      const move = steering(bot.entity.position, bot.entity.velocity, committed ? plan.landing : plan.exit);
      await bot.look(move.yaw, 0, true);
      bot.setControlState('forward', move.forward);
      await bot.waitForTicks(1);
    }
    throw new Error('落水脱困未在预期时间内完成');
  } finally {
    delete bot.safeDescent;
    bot.clearControlStates();
  }
}
