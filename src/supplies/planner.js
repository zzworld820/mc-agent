import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, goTo, sleep, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { ensureFood } from '../autonomy/skills/food.js';
import { smelt } from '../autonomy/skills/smelt.js';
import { MEAT } from '../autonomy/knowledge.js';
import { tendFarm, inspectFarm } from '../farming/system.js';
import { visitSupplyChest, withdrawVerified } from '../farming/storage.js';
import { listHouseProjects } from '../building/projects.js';
import { leaveHome } from '../strategy/navigation.js';
import { readDanger } from '../strategy/danger.js';
import { assessSupplies } from './assessment.js';
import { chooseFood, foodKind, knownSupplyChests, productionReserve, shouldEat, carriedFood } from './inventory.js';
import { supplySettings, taskBudget } from './profiles.js';

const { goals } = pathfinderPkg;
const meals = new WeakMap();

export function supplyState(state) {
  state.supplies ??= {};
  const supplies = state.supplies;
  supplies.warehouses ??= [];
  supplies.sourceFailures ??= {};
  supplies.productionDebt ??= {};
  return supplies;
}

export async function eatIfNeeded(ctx) {
  const { bot, signal, state } = ctx;
  if (bot.health <= 0 || !shouldEat(bot) || bot.food >= 20 || readDanger(bot).retreat) return false;
  const previous = meals.get(bot);
  if (previous) { await previous; throwIfAborted(signal); return false; }
  const food = chooseFood(bot, state);
  if (!food) return false;
  const operation = (async () => {
    throwIfAborted(signal);
    const before = countItem(bot, food.name);
    const hunger = bot.food;
    await bot.equip(food, 'hand');
    let rejectInterrupt;
    const interrupted = new Promise((_, reject) => { rejectInterrupt = reject; });
    const abort = () => {
      bot.deactivateItem();
      const error = new Error('进食已取消');
      error.name = 'AbortError';
      rejectInterrupt(error);
    };
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, 15000);
    try {
      throwIfAborted(signal);
      await Promise.race([bot.consume(), interrupted]);
      await sleep(200, signal);
      if (countItem(bot, food.name) >= before && bot.food <= hunger) throw new Error('进食结果未确认');
      if (state) {
        const supplies = supplyState(state);
        supplies.lastMeal = { item: food.name, before: hunger, after: bot.food, at: Date.now(), emergency: food.name === 'rotten_flesh' };
        const reserve = productionReserve(state, food.name);
        if (reserve && countItem(bot, food.name) < reserve) supplies.productionDebt[food.name] = reserve - countItem(bot, food.name);
      }
      ctx.log?.(`进食 ${food.name}，当前饥饿值 ${bot.food}`);
      return true;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
    }
  })();
  meals.set(bot, operation);
  try { return await operation; } finally { if (meals.get(bot) === operation) meals.delete(bot); }
}

async function eatUntilStable(ctx) {
  for (let i = 0; i < 10 && shouldEat(ctx.bot); i++) {
    if (!await eatIfNeeded(ctx)) break;
  }
}

export async function discoverHomeStores(ctx) {
  const supplies = supplyState(ctx.state);
  if (!ctx.state.house || Date.now() - (supplies.lastHomeScanAt || 0) < 30000) return;
  const house = (await listHouseProjects(ctx.bot)).find((project) => project.id === ctx.state.house.projectId);
  if (!house) return;
  const rooms = [{ origin: house.origin, size: house.model.size }, ...house.extensions.filter((entry) => entry.status === 'complete')
    .map((entry) => ({ origin: entry.origin, size: entry.module.size }))];
  for (const room of rooms) for (let x = 1; x < room.size.width - 1; x++) {
    if (x === Math.floor(room.size.width / 2)) continue;
    const position = { x: room.origin.x + x, y: room.origin.y + 1, z: room.origin.z + room.size.depth - 2 };
    const block = ctx.bot.blockAt(new Vec3(position.x, position.y, position.z));
    if (block && block.name !== 'chest') continue;
    if (knownSupplyChests(ctx.state, String(ctx.bot.game.dimension)).some(({ chest }) => JSON.stringify(chest.position) === JSON.stringify(position))) continue;
    supplies.warehouses.push({ id: randomUUID(), position, dimension: String(ctx.bot.game.dimension), mode: 'home', projectId: house.id });
  }
  supplies.lastHomeScanAt = Date.now();
  await ctx.checkpoint?.();
}

async function withdrawFood(ctx, budget) {
  const { bot, state } = ctx;
  const supplies = supplyState(state);
  const policy = supplySettings(bot);
  const candidates = knownSupplyChests(state, String(bot.game.dimension))
    .filter(({ chest }) => (supplies.sourceFailures[chest.id]?.retryAt || 0) <= Date.now())
    .sort((a, b) => bot.entity.position.distanceTo(a.chest.position) - bot.entity.position.distanceTo(b.chest.position));
  for (const { chest, mode } of candidates) {
    throwIfAborted(ctx.signal);
    if (readDanger(bot).retreat) throw new Error('补给途中出现危险，需要先撤退');
    if (assessSupplies(bot, state, budget).food.regular >= taskBudget(bot, budget).foodTarget + Math.max(0, 20 - bot.food)) break;
    const before = carriedFood(bot, state).regular;
    try {
      await visitSupplyChest(ctx, chest, mode, async (window) => {
        const urgent = assessSupplies(bot, state, budget).level === 'emergency';
        const candidates = window.containerItems().filter((item) => !item.nbt && (foodKind(bot, item.name) === 'regular'
          || urgent && policy.allowRottenFlesh && item.name === 'rotten_flesh'))
          .sort((a, b) => Number(a.name === 'rotten_flesh') - Number(b.name === 'rotten_flesh'));
        for (const item of candidates) {
          const gap = taskBudget(bot, budget).foodTarget + Math.max(0, 20 - bot.food) - carriedFood(bot, state).regular;
          if (gap <= 0) break;
          const needed = item.name === 'rotten_flesh' ? 4 : Math.ceil(gap / bot.registry.foodsByName[item.name].foodPoints)
            + Math.max(0, productionReserve(state, item.name) - countItem(bot, item.name));
          const count = Math.min(item.count, needed);
          await withdrawVerified(ctx, window, item, count);
        }
        // 即食不足时带回少量加工原料；不取整库，不把它算成立刻可食用。
        if (carriedFood(bot, state).regular < taskBudget(bot, budget).foodTarget) {
          for (const item of window.containerItems().filter((entry) => entry.name === 'wheat' || Object.values(MEAT).some((meat) => meat.raw === entry.name))) {
            if (item.nbt) continue;
            const count = Math.min(item.count, Math.max(0, 12 - countItem(bot, item.name)));
            if (count) await withdrawVerified(ctx, window, item, count);
          }
        }
      });
      if (carriedFood(bot, state).regular <= before) supplies.sourceFailures[chest.id] = { reason: '本次未取得足够即食粮，稍后复查', retryAt: Date.now() + policy.failedSourceCooldownMs };
      else delete supplies.sourceFailures[chest.id];
      await eatUntilStable(ctx);
    } catch (err) {
      throwIfAborted(ctx.signal);
      supplies.sourceFailures[chest.id] = { reason: err.message, retryAt: Date.now() + policy.failedSourceCooldownMs };
      ctx.log(`仓储补给暂缓：${err.message}`);
    }
    await ctx.checkpoint?.();
  }
}

async function processCarriedFood(ctx, task) {
  const { bot, state } = ctx;
  const assessment = assessSupplies(bot, state, task);
  if (assessment.food.regular >= assessment.foodTarget) return;
  const preserveWheat = assessment.level === 'emergency' ? 0 : 3;
  const bread = Math.min(8, Math.floor((countItem(bot, 'wheat') - preserveWheat) / 3));
  if (bread > 0) await ctx.obtain('bread', countItem(bot, 'bread') + bread);
  await eatUntilStable(ctx);
  if (carriedFood(bot, state).regular >= taskBudget(bot, task).foodTarget) return;
  const raw = Object.values(MEAT).find((entry) => countItem(bot, entry.raw) > 0);
  if (raw) await smelt(ctx, raw.cooked, countItem(bot, raw.cooked) + Math.min(8, countItem(bot, raw.raw)));
  await eatUntilStable(ctx);
  if (carriedFood(bot, state).regular >= taskBudget(bot, task).foodTarget) return;
  const potatoes = countItem(bot, 'potato') - productionReserve(state, 'potato');
  if (potatoes > 0) await smelt(ctx, 'baked_potato', countItem(bot, 'baked_potato') + Math.min(8, potatoes));
  await eatUntilStable(ctx);
}

/** 到达仓库不算成功：只有实际随身口粮达到目标、身体稳定才允许恢复工作。 */
export async function replenishFood(ctx, task = {}) {
  const supplies = supplyState(ctx.state);
  const enough = () => {
    const assessment = assessSupplies(ctx.bot, ctx.state, task);
    return !assessment.needsMeal && assessment.food.regular >= assessment.budget.foodTarget;
  };
  await eatUntilStable(ctx);
  if (enough()) { supplies.retryAt = 0; return; }
  const attempt = async (name, work) => {
    if (enough()) return;
    try { throwIfAborted(ctx.signal); await work(); }
    catch (err) { throwIfAborted(ctx.signal); ctx.log(`${name}暂不可用：${err.message}`); }
  };
  await attempt('检查自有房屋箱位', () => discoverHomeStores(ctx));
  const closestStore = knownSupplyChests(ctx.state, String(ctx.bot.game.dimension))
    .filter(({ chest }) => (supplies.sourceFailures[chest.id]?.retryAt || 0) <= Date.now())
    .sort((a, b) => ctx.bot.entity.position.distanceTo(a.chest.position) - ctx.bot.entity.position.distanceTo(b.chest.position))[0];
  const processingSeconds = countItem(ctx.bot, 'wheat') >= 6 ? 15 : 60;
  const preferStore = closestStore && ctx.bot.entity.position.distanceTo(closestStore.chest.position) * 0.4 + 8 < processingSeconds;
  if (!preferStore) await attempt('加工随身原料', () => processCarriedFood(ctx, task));
  await attempt('仓储取粮', () => withdrawFood(ctx, task));
  await attempt('加工取出的原料', () => processCarriedFood(ctx, task));
  await attempt('农田取粮', async () => {
    const farm = ctx.state.farm;
    if (!farm || farm.dimension !== String(ctx.bot.game.dimension)) return;
    await leaveHome(ctx, ctx.state.home);
    useMovementProfile(ctx.bot, 'safe');
    await goTo(ctx.bot, new goals.GoalNear(farm.origin.x, farm.origin.y + 1, farm.origin.z, 3), { signal: ctx.signal, timeoutMs: 30000 });
    if (!inspectFarm(ctx.bot, farm)?.mature) return;
    await tendFarm(ctx, { emergency: ctx.bot.food < supplySettings(ctx.bot).interruptBelow });
    await processCarriedFood(ctx, task);
    await eatUntilStable(ctx);
  });
  await attempt('寻找新食物', async () => {
    if (ctx.bot.autonomyOptions?.allowAutonomy === false) throw new Error('当前模式未授权主动采集补给');
    await leaveHome(ctx, ctx.state.home);
    useMovementProfile(ctx.bot, 'free');
    const target = taskBudget(ctx.bot, task).foodTarget + Math.max(0, 20 - ctx.bot.food);
    await ensureFood(ctx, target, { maxExplore: 3, exploreDistance: ctx.bot.food < 12 ? 16 : 32 });
    await eatUntilStable(ctx);
  });
  const result = assessSupplies(ctx.bot, ctx.state, task);
  supplies.lastAssessment = { ...result, at: Date.now() };
  if (!enough()) {
    supplies.retryAt = Date.now() + (result.level === 'emergency' ? 8000 : supplySettings(ctx.bot).failedSourceCooldownMs);
    const error = new Error(`尚未补足口粮：随身 ${result.food.regular} 点，任务目标 ${result.budget.foodTarget} 点；主任务继续暂停`);
    error.code = 'SUPPLY_UNAVAILABLE';
    await ctx.checkpoint?.();
    throw error;
  }
  supplies.retryAt = 0;
  await ctx.checkpoint?.();
}

export async function prepareTaskSupplies(ctx, task = {}) {
  const supplies = supplyState(ctx.state);
  supplies.activeTask = task;
  await replenishFood(ctx, task);
  const assessment = assessSupplies(ctx.bot, ctx.state, task);
  const { budget } = assessment;
  if (assessment.missing.includes('torches')) await ctx.obtain('torch', budget.torches);
  if (assessment.missing.includes('tool')) await ctx.obtain(budget.tool, countItem(ctx.bot, budget.tool) + 1);
  if (assessment.missing.includes('weapon')) await ctx.obtain(budget.weapon, countItem(ctx.bot, budget.weapon) + 1);
  if (assessment.missing.includes('armor')) {
    await ctx.obtain('iron_helmet', 1);
    await ctx.obtain('iron_chestplate', 1);
    for (const name of ['iron_helmet', 'iron_chestplate']) {
      const item = ctx.bot.inventory.items().find((entry) => entry.name === name);
      if (item) await ctx.bot.equip(item, name.endsWith('helmet') ? 'head' : 'torso');
    }
  }
  // 备火把和工具本身也会消耗口粮，出发前再核对一次。
  await replenishFood(ctx, task);
  const ready = assessSupplies(ctx.bot, ctx.state, task);
  if (!ready.ready) throw new Error(`尚不能出发：${ready.reason}`);
  await ctx.checkpoint?.();
  return ready;
}
