import { countItem, sleep, throwIfAborted } from '../actions/helpers.js';
import { nearestTreeWood } from '../autonomy/skills/craft.js';
import { ensureFood } from '../autonomy/skills/food.js';
import { prepareTaskSupplies } from '../supplies/planner.js';
import { carriedFood } from '../supplies/inventory.js';
import { taskBudget } from '../supplies/profiles.js';
import { refreshStorage, storeSurplus, visitSupplyChest, withdrawVerified } from '../farming/storage.js';
import { reachHome, reachSurface } from './navigation.js';
import { developmentStatus, developmentTask } from './development.js';

async function returnAndStore(ctx) {
  await reachSurface(ctx, ctx.state.home.y);
  await reachHome(ctx, ctx.state.home);
  await storeSurplus(ctx);
  await refreshStorage(ctx);
}

async function collectForStorage(ctx, name, count) {
  ctx.stockpilingItem = name;
  try { await ctx.obtain(name, countItem(ctx.bot, name) + count); }
  finally { ctx.stockpilingItem = null; }
  await returnAndStore(ctx);
}

// 搬家分批转运，旧箱子继续保留所有权和旧入口，以便中断后接续。
export async function migrateStoredItems(ctx) {
  const { bot, state } = ctx;
  for (const storage of state.archivedStorage || []) {
    if (storage.dimension !== String(bot.game.dimension)) continue;
    for (const chest of storage.chests) {
      if (chest.migrationRetryAt > Date.now() || chest.snapshot?.length === 0 && chest.observedAt) continue;
      try {
        await visitSupplyChest(ctx, chest, storage.mode, async (window) => {
          for (const item of window.containerItems()) {
            if (bot.inventory.emptySlotCount() < 4) break;
            throwIfAborted(ctx.signal);
            await withdrawVerified(ctx, window, item, item.count);
          }
        });
        chest.migrationRetryAt = Date.now() + 60000;
        await returnAndStore(ctx);
        return true;
      } catch (error) {
        throwIfAborted(ctx.signal);
        chest.migrationRetryAt = Date.now() + 60000;
        ctx.log(`旧仓储本轮搬运暂缓：${error.message}`);
        await ctx.checkpoint?.();
      }
    }
  }
  return false;
}

export async function prepareIronTrip(ctx) {
  await returnAndStore(ctx);
  const development = developmentStatus(ctx.bot, ctx.state);
  if (!development.basicReserves || !development.foodReady || !ctx.state.base?.ready) {
    throw new Error('基地备用物资或存粮不足，先恢复基地储备');
  }
  const task = developmentTask('protection');
  ctx.state.supplies.activeTask = task;
  await prepareTaskSupplies(ctx, task);
  // 原有旧工具和剩余材料先入库，口粮和工具按采矿预算保留。
  await storeSurplus(ctx);
  ctx.state.development.tripReady = true;
}

export async function stockBase(ctx, goal) {
  const { bot, state } = ctx;
  await returnAndStore(ctx);
  if (await migrateStoredItems(ctx)) return;
  const development = developmentStatus(bot, state);
  const { settings, stored } = development;
  if (goal === 'reserves') {
    if (stored.logs < settings.logs) {
      const wood = nearestTreeWood(bot);
      return collectForStorage(ctx, `${wood}_log`, Math.min(16, settings.logs - stored.logs));
    }
    if (stored.stone < settings.stone) return collectForStorage(ctx, 'cobblestone', Math.min(32, settings.stone - stored.stone));
    for (const item of ['stone_pickaxe', 'stone_axe', 'stone_sword']) {
      if ((stored.items[item] || 0) < 1) return collectForStorage(ctx, item, 1);
    }
    return;
  }
  if (goal === 'food_stock') {
    if (development.foodReady) { await sleep(10000, ctx.signal); return; }
    const bread = Math.floor(Math.max(0, countItem(bot, 'wheat') - 3) / 3);
    if (bread) await ctx.obtain('bread', countItem(bot, 'bread') + Math.min(bread, 16));
    const carried = carriedFood(bot, state).regular;
    const batch = Math.min(48, development.foodTarget - stored.food);
    const target = taskBudget(bot).foodTarget + batch;
    if (carried < target) await ensureFood(ctx, target, { maxExplore: 2, exploreDistance: 24 });
    await returnAndStore(ctx);
    return;
  }
  if (goal === 'iron_reserve') {
    if (!development.ironReady) {
      await prepareIronTrip(ctx);
      const shortage = settings.spareIron - (stored.items.iron_ingot || 0);
      if (shortage > 0) await collectForStorage(ctx, 'iron_ingot', Math.min(8, shortage));
    }
    const current = developmentStatus(bot, state);
    if (current.ironReady && current.basicReserves && current.foodReady && state.farm?.harvestCycles > 0) {
      state.development.ironCompletedAt ??= Date.now();
      state.development.stage = 'iron_ready';
      state.development.lastAcceptance = { at: Date.now(), foodPoints: current.stored.food,
        logs: current.stored.logs, stone: current.stored.stone, iron: current.stored.items.iron_ingot,
        projectId: state.house.projectId, harvestCycles: state.farm.harvestCycles };
      ctx.log('基地、存粮、备用工具、铁装备和备用铁已达到第一阶段目标');
      await ctx.checkpoint?.();
    }
  }
}
