import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { digWithTimeout, goTo, haltBot, sleep, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { protectedTarget } from '../autonomy/skills/trees.js';
import { canAlterEntranceTerrain } from './access.js';

const { goals } = pathfinderPkg;
const AIR = new Set(['air', 'cave_air']);
const NATURAL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff']);
const HAZARDS = new Set(['water', 'lava', 'fire', 'soul_fire', 'sand', 'red_sand', 'gravel', 'powder_snow', 'magma_block', 'cactus', 'campfire', 'soul_campfire']);
const MATERIALS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate']);
const DIRECTIONS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const point = (p) => new Vec3(p.x, p.y, p.z);

function clear(bot, p) {
  return AIR.has(bot.blockAt(p)?.name);
}

function supported(bot, p) {
  const floor = bot.blockAt(p.offset(0, -1, 0));
  return floor?.boundingBox === 'block' && !HAZARDS.has(floor.name)
    && bot.blockAt(p.offset(0, -2, 0))?.boundingBox === 'block';
}

function safeDig(bot, state, p) {
  const block = bot.blockAt(p);
  const ownedCover = state.emergencyShelter?.placedBlocks?.some((entry) => point(entry).equals(p) && entry.name === block?.name);
  if (!block || (!NATURAL.has(block.name) && !ownedCover)
    || protectedTarget(state, p) && !ownedCover && !canAlterEntranceTerrain(bot, state, block)) return false;
  if (block.diggable === false) return false;
  for (const offset of [...DIRECTIONS, new Vec3(0, 1, 0), new Vec3(0, -1, 0)]) {
    const neighbor = bot.blockAt(p.plus(offset));
    if (!neighbor || HAZARDS.has(neighbor.name)) return false;
  }
  return true;
}

/** 限定在相邻一格，最多挖两块，或只在原脚下垫一块。 */
export function localUnstuckPlans(bot, state, target = null) {
  const feet = bot.entity.position.floored();
  if (!bot.entity.onGround || !supported(bot, feet) || !clear(bot, feet) || !clear(bot, feet.offset(0, 1, 0))) return [];
  const directions = [...DIRECTIONS];
  if (target) directions.sort((a, b) => feet.plus(a).distanceTo(target) - feet.plus(b).distanceTo(target));
  const walks = [];
  const digs = [];
  for (const direction of directions) {
    const destination = feet.plus(direction);
    for (const dy of [0, 1, -1]) {
      const p = destination.offset(0, dy, 0);
      if (!supported(bot, p) || !clear(bot, p) || !clear(bot, p.offset(0, 1, 0))) continue;
      if (dy > 0 && !clear(bot, feet.offset(0, 2, 0))) continue;
      walks.push({ kind: 'walk', destination: p, blocks: [] });
    }
    const cells = [destination.offset(0, 1, 0), destination];
    const blocked = cells.filter((p) => !clear(bot, p));
    if (supported(bot, destination) && blocked.length && blocked.every((p) => safeDig(bot, state, p))) {
      digs.push({ kind: 'dig', destination, blocks: blocked });
    }
  }
  const plans = [...walks.slice(0, 2), ...digs.slice(0, 2)];
  const material = bot.inventory.items().find((item) => MATERIALS.has(item.name));
  const ledge = directions.map((direction) => feet.plus(direction).offset(0, 2, 0))
    .find((p) => supported(bot, p) && clear(bot, p) && clear(bot, p.offset(0, 1, 0)));
  if (material && ledge && !protectedTarget(state, feet) && clear(bot, feet.offset(0, 2, 0)) && clear(bot, feet.offset(0, 3, 0))) {
    plans.push({ kind: 'pillar', destination: feet.offset(0, 1, 0), blocks: [], material: material.name });
  }
  return plans;
}

export async function tryLocalUnstuck(ctx, { target = ctx.state.home } = {}) {
  const { bot, state, signal } = ctx;
  if ((bot.time?.timeOfDay ?? 0) >= 10000 || bot.health < 12 || bot.food < 8 || bot.autonomyOptions?.allowDig === false) return false;
  if (Date.now() - (state.localRecovery?.at || 0) < 15000) return false;
  const origin = bot.entity.position.floored();
  const plans = localUnstuckPlans(bot, state, target && point(target));
  if (!plans.length) return false;
  state.localRecovery = { at: Date.now(), origin: { x: origin.x, y: origin.y, z: origin.z }, status: 'working' };
  await ctx.checkpoint?.();
  const previous = bot.pathfinder.movements;
  try {
    haltBot(bot);
    for (const plan of plans) {
      throwIfAborted(signal);
      // 某个尝试已经改变站位时重新规划，避免继续使用旧脚下坐标。
      if (!bot.entity.position.floored().equals(origin)) break;
      try {
        for (const p of plan.blocks) {
          throwIfAborted(signal);
          if (!safeDig(bot, state, p)) throw new Error('局部挖掘条件已改变');
          const block = bot.blockAt(p);
          const tool = bot.pathfinder.bestHarvestTool(block);
          if (tool) await bot.equip(tool, 'hand');
          const abort = () => bot.stopDigging();
          signal.addEventListener('abort', abort, { once: true });
          const timeout = Math.max(10000, (bot.digTime?.(block) || 0) + 3000);
          try { await digWithTimeout(bot, block, timeout); }
          finally { signal.removeEventListener('abort', abort); }
          if (!clear(bot, p)) throw new Error('服务器未确认局部挖掘');
          await ctx.checkpoint?.();
        }
        if (!supported(bot, plan.destination) && plan.kind !== 'pillar') throw new Error('落脚支撑发生变化');
        useMovementProfile(bot, plan.kind === 'pillar' ? 'free' : 'safe');
        const movements = bot.pathfinder.movements;
        movements.canDig = false;
        movements.allow1by1towers = plan.kind === 'pillar';
        movements.allowParkour = false;
        movements.maxDropDown = 1;
        movements.exclusionAreasStep.push((block) => Math.abs(block.position.x - origin.x) > 2 || Math.abs(block.position.z - origin.z) > 2 ? Infinity : 0);
        if (plan.kind === 'pillar') {
          movements.scafoldingBlocks = [bot.registry.itemsByName[plan.material].id];
          movements.exclusionAreasPlace.push((block) => block.position.equals(origin) ? 0 : Infinity);
        }
        await goTo(bot, new goals.GoalBlock(plan.destination.x, plan.destination.y, plan.destination.z), { signal, timeoutMs: 5000, stuckMs: 4000 });
        haltBot(bot);
        await sleep(300, signal);
        const position = bot.entity.position;
        const reached = bot.entity.onGround && Math.floor(position.x) === plan.destination.x && Math.floor(position.z) === plan.destination.z
          && Math.abs(position.y - plan.destination.y) < 0.3;
        const placed = plan.kind !== 'pillar' || bot.blockAt(origin)?.name === plan.material;
        if (!reached || !placed) throw new Error('局部脱困尚未确认到位');
        state.localRecovery = { ...state.localRecovery, status: 'recovered', action: plan.kind,
          position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } };
        await ctx.checkpoint?.();
        bot.emit?.('agentIncident', { type: 'attempt', goal: '局部脱困', solution: plan.kind,
          result: '确认到达安全站位' });
        ctx.log(`局部脱困成功，${plan.kind === 'dig' ? `挖开${plan.blocks.length}块挡路土石` : plan.kind === 'pillar' ? '脚下垫高一格' : '移动到相邻安全站位'}，继续原任务`);
        return true;
      } catch (error) {
        throwIfAborted(signal);
        haltBot(bot);
        bot.emit?.('agentIncident', { type: 'attempt', goal: '局部脱困', solution: plan.kind, result: error.message });
        ctx.log(`局部脱困本次未完成：${error.message}`);
      }
    }
    state.localRecovery.status = 'unavailable';
    await ctx.checkpoint?.();
    return false;
  } finally {
    haltBot(bot);
    if (previous) bot.pathfinder.setMovements(previous);
  }
}
