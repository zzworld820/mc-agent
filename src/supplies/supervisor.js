import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, goTo, haltBot, sleep, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { obtain } from '../autonomy/planner.js';
import { MINING } from '../autonomy/knowledge.js';
import { retrieveMaterials, storeSurplus } from '../farming/storage.js';
import { loadStrategyState, saveStrategyState } from '../strategy/state.js';
import { readDanger, evadeDanger } from '../strategy/danger.js';
import { leaveHome, reachHome } from '../strategy/navigation.js';
import { assessSupplies } from './assessment.js';
import { eatIfNeeded, prepareTaskSupplies, supplyState } from './planner.js';

const { goals } = pathfinderPkg;
const plain = (p) => ({ x: p.x, y: p.y, z: p.z });

export async function createSupplyContext(bot, task, savedState = null) {
  const state = savedState || await loadStrategyState(bot);
  supplyState(state);
  bot.supplyState = state;
  const ctx = { bot, signal: task.signal, state, depth: 0,
    log: task.setProgress || (() => {}), checkpoint: () => saveStrategyState(bot, state) };
  ctx.obtain = async (item, count) => {
    throwIfAborted(ctx.signal);
    state.reservedItems.add(item);
    if (countItem(bot, item) < count) {
      try { await retrieveMaterials(ctx, item, count); }
      catch (err) { throwIfAborted(ctx.signal); ctx.log(`库存材料暂不可取：${err.message}`); }
    }
    if (countItem(bot, item) >= count) return;
    if (bot.autonomyOptions?.allowDig === false && (MINING[item] || item.endsWith('_log'))) throw new Error('当前配置禁止为补给主动挖掘材料');
    await leaveHome(ctx, state.home);
    useMovementProfile(bot, 'free');
    return obtain(ctx, item, count);
  };
  ctx.rest = () => eatIfNeeded(ctx);
  ctx.storeMaterials = async () => {
    const result = await storeSurplus(ctx);
    await leaveHome(ctx, state.home);
    return result;
  };
  return ctx;
}

/** 只重入声明了可恢复语义的任务；交付物品、合成等不可盲目重放的动作不使用此包装。 */
export async function runSuppliedTask(bot, task, work) {
  if (!task.supply || bot.autonomyOptions?.allowAutonomy === false) return work(task);
  const resumePosition = task.supply.resumePosition;
  if (resumePosition && ![resumePosition.x, resumePosition.y, resumePosition.z].every(Number.isFinite)) throw new Error('保存的任务恢复坐标无效');
  const ctx = await createSupplyContext(bot, task);
  const supplies = supplyState(ctx.state);
  const guard = { active: true, phase: 'preparing', state: ctx.state, task: task.supply, reason: null };
  bot.supplySupervisor = guard;
  const progress = {};
  const initialPosition = plain(resumePosition || bot.entity.position);
  const dimension = String(bot.game.dimension);
  let returnPosition = initialPosition;
  let paused = false;
  let prepared = false;
  supplies.activeTask = task.supply;
  const recordPause = async (reason) => {
    paused = true;
    guard.reason = reason;
    supplies.pausedTask = { status: 'paused', descriptor: task.supply.descriptor || null,
      task: task.supply, progress: structuredClone(progress), position: returnPosition, reason, at: Date.now() };
    task.setProgress(`暂停补给：${reason}`);
    await ctx.checkpoint();
  };
  const saveProgress = async () => {
    supplies.pausedTask = { status: 'running', descriptor: task.supply.descriptor || null,
      task: task.supply, progress: structuredClone(progress), position: plain(bot.entity?.position || returnPosition), at: Date.now() };
    await ctx.checkpoint();
  };
  try {
    while (!task.signal.aborted) {
      throwIfAborted(task.signal);
      if (!bot.entity || bot.memory?.suspended || String(bot.game.dimension) !== dimension || bot.health <= 0) throw new Error('世界、维度或生命状态改变，停止恢复旧任务');
      if (readDanger(bot).retreat) {
        await recordPause('当前有危险，先撤退再补给');
        guard.phase = 'retreating';
        try { await evadeDanger(ctx, ctx.state.home); }
        catch (err) { throwIfAborted(task.signal); task.setProgress(`避险暂未完成：${err.message}`); await sleep(3000, task.signal); }
        continue;
      }
      await eatIfNeeded(ctx);
      const current = assessSupplies(bot, ctx.state, task.supply);
      if (supplies.retryAt > Date.now() && (prepared ? current.interrupt : !current.ready)) {
        task.setProgress(`补给暂不可用，任务保持暂停：${guard.reason || '等待复查食物来源'}`);
        await sleep(Math.min(3000, supplies.retryAt - Date.now()), task.signal);
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([task.signal, controller.signal]);
      let interruption = null;
      let lastCheck = 0;
      const check = () => {
        if (controller.signal.aborted || Date.now() - lastCheck < 500) return;
        lastCheck = Date.now();
        if (!bot.entity || String(bot.game.dimension) !== dimension || bot.memory?.suspended || bot.health <= 0) interruption = '世界或生命状态发生改变';
        else if (readDanger(bot).retreat) interruption = '危险出现，需要先撤退';
        else if (guard.phase === 'working' || guard.phase === 'returning') {
          const assessment = assessSupplies(bot, ctx.state, task.supply);
          if (assessment.interrupt) interruption = assessment.reason;
        }
        if (interruption) { controller.abort(interruption); haltBot(bot); }
      };
      bot.on('physicsTick', check);
      bot.on('health', check);
      bot.on('ownBreath', check);
      ctx.signal = signal;
      try {
        guard.phase = 'preparing';
        if (!prepared || assessSupplies(bot, ctx.state, task.supply).interrupt) await prepareTaskSupplies(ctx, task.supply);
        prepared = true;
        throwIfAborted(signal);
        // 取粮可能离开原工作点；先返回，再基于真实世界继续，不在仓库旁重新砍另一片树。
        guard.phase = 'returning';
        await leaveHome(ctx, ctx.state.home);
        const p = new Vec3(returnPosition.x, returnPosition.y, returnPosition.z);
        if (bot.entity.position.distanceTo(p) > 3) {
          if (ctx.state.home && p.distanceTo(new Vec3(ctx.state.home.x, ctx.state.home.y, ctx.state.home.z)) < 5) await reachHome(ctx, ctx.state.home);
          useMovementProfile(bot, 'safe');
          await goTo(bot, new goals.GoalNear(p.x, p.y, p.z, 2), { signal, timeoutMs: 45000 });
        }
        guard.phase = 'working';
        useMovementProfile(bot, 'safe');
        if (paused) task.setProgress('补给复查通过，继续原任务');
        const result = await work({ ...task, signal, checkpoint: progress, survivalState: ctx.state,
          saveCheckpoint: saveProgress, supplyContext: ctx });
        throwIfAborted(signal);
        supplies.pausedTask = null;
        supplies.lastCompletedTask = { descriptor: task.supply.descriptor || null, at: Date.now() };
        return result;
      } catch (err) {
        throwIfAborted(task.signal);
        if (guard.phase === 'working' && !interruption) throw err;
        returnPosition = guard.phase === 'working' ? plain(bot.entity?.position || returnPosition) : returnPosition;
        await recordPause(interruption || err.message);
        if (!interruption) supplies.retryAt ||= Date.now() + 60000;
      } finally {
        bot.removeListener('physicsTick', check);
        bot.removeListener('health', check);
        bot.removeListener('ownBreath', check);
        ctx.signal = task.signal;
        haltBot(bot);
      }
    }
    throwIfAborted(task.signal);
  } finally {
    guard.active = false;
    useMovementProfile(bot, 'safe');
    supplies.activeTask = null;
    if (task.signal.aborted) supplies.pausedTask = { status: 'cancelled', descriptor: task.supply.descriptor || null,
      task: task.supply, progress: structuredClone(progress), position: guard.phase === 'working' ? plain(bot.entity?.position || returnPosition) : returnPosition,
      reason: String(task.signal.reason), at: Date.now() };
    await ctx.checkpoint();
  }
}
