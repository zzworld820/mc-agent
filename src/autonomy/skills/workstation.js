import pathfinderPkg from 'mineflayer-pathfinder';
import { goTo, throwIfAborted } from '../../actions/helpers.js';
import { placeBlockNear } from './world.js';
import { reachHome } from '../../strategy/navigation.js';

const { goals } = pathfinderPkg;

export async function ensureWorkstation(ctx, name) {
  const { bot, signal, state } = ctx;
  const existing = bot.findBlock({ matching: bot.registry.blocksByName[name].id, maxDistance: 24 });
  const key = existing ? `workstation:${existing.position}` : null;
  if (existing && (state.unreachable?.get(key) ?? 0) <= Date.now()) {
    const timeout = AbortSignal.timeout(12000);
    const approachSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const home = state.home;
      if (home && home.dimension === String(bot.game.dimension) && existing.position.distanceTo(home) < 5) {
        await reachHome({ ...ctx, signal: approachSignal }, home);
      }
      if (existing.position.distanceTo(bot.entity.position) > 3.5) {
        const { x, y, z } = existing.position;
        await goTo(bot, new goals.GoalNear(x, y, z, 2), { signal: approachSignal, timeoutMs: 12000 });
      }
      const current = bot.blockAt(existing.position);
      if (current?.name !== name) throw new Error('原工作设施已经改变');
      return current;
    } catch (error) {
      throwIfAborted(signal);
      state.unreachable?.set(key, Date.now() + 300000);
      ctx.log(`${name} 暂不可达，在当前位置准备工作设施：${error.message}`);
    }
  }
  await ctx.obtain(name, 1);
  return placeBlockNear(ctx, name);
}
