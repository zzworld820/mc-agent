// 食物与打猎：打动物拿生肉 → 烧成熟肉，直到背包里的食物够吃。
import { countItem, throwIfAborted } from '../../actions/helpers.js';
import { MEAT } from '../knowledge.js';
import { smelt } from './smelt.js';
import { attackUntilDead, collectDrops, explore } from './world.js';
import { carriedFood } from '../../supplies/inventory.js';
import { isFightable } from '../../actions/combat.js';

/** 背包里的食物一共能顶多少饱食度 */
export function foodPoints(bot, state = null) {
  return carriedFood(bot, state).regular;
}

/** 打猎 + 烤肉，直到食物够 minPoints 点饱食度 */
export async function ensureFood(ctx, minPoints, { maxExplore = 8, exploreDistance = 48 } = {}) {
  const { bot, signal } = ctx;
  let explores = 0;
  while (foodPoints(bot, ctx.state) < minPoints) {
    throwIfAborted(signal);
    await ctx.rest?.();

    // 先把背包里的生肉烤了
    const raw = Object.values(MEAT).find(({ raw }) => countItem(bot, raw) > 0);
    if (raw && (countItem(bot, raw.raw) >= 3 || bot.health < 14 || bot.food < 18)) {
      await smelt(ctx, raw.cooked, countItem(bot, raw.cooked) + countItem(bot, raw.raw));
      continue;
    }

    if (bot.autonomyOptions?.allowCombat === false) throw new Error('战斗已关闭，暂缺足够的非战斗食物来源');
    const animal = bot.nearestEntity((entity) => Object.keys(MEAT).includes(entity.name)
      && entity.position.distanceTo(bot.entity.position) <= 64
      && !Object.values(bot.entities).some((enemy) => isFightable(enemy) && enemy.position.distanceTo(entity.position) < 16)
      && !(ctx.state.pastures ?? []).some((pasture) => {
        const p = pasture.origin;
        return pasture.dimension === String(bot.game.dimension) && entity.position.x >= p.x && entity.position.x <= p.x + 5
          && entity.position.z >= p.z && entity.position.z <= p.z + 5 && Math.abs(entity.position.y - p.y) < 4
          || entity.uuid && pasture.animals?.some((animal) => animal.uuid === entity.uuid);
      }));
    if (!animal) {
      if (raw) {
        // 附近没动物了，手上的生肉不多也先烤了
        await smelt(ctx, raw.cooked, countItem(bot, raw.cooked) + countItem(bot, raw.raw));
        continue;
      }
      if (explores++ >= maxExplore) throw new Error('本轮找食物未找到安全可用的动物，暂停复查其他补给来源');
      await explore(ctx, exploreDistance);
      continue;
    }

    ctx.log(`打猎：${animal.name}`);
    const where = await attackUntilDead(ctx, animal);
    await collectDrops(ctx, where, 5);
  }
}
