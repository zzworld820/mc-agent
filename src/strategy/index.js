// 简单规则策略：只选择一个主要目标，危险可打断，恢复后按真实状态继续。
// 与旧里程碑模式分开，不需要玩家消息或大模型调用才能持续推进。
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { countItem, goTo, haltBot, sleep, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { obtain, hasAtLeast } from '../autonomy/planner.js';
import { MINING, MOB_DROPS } from '../autonomy/knowledge.js';
import { ensureCraftingTable } from '../autonomy/skills/craft.js';
import { ensureFurnace } from '../autonomy/skills/smelt.js';
import { buildHouse, buildShelter } from '../autonomy/skills/build.js';
import { ensureFarm, expandFarm, inspectFarm } from '../autonomy/skills/farming.js';
import { farmSettings, gameClock, gameDay } from '../farming/settings.js';
import { storeSurplus, hasSurplus, retrieveMaterials } from '../farming/storage.js';
import { ensurePasture, tendPasture } from '../autonomy/skills/husbandry.js';
import { explore, placeBlockNear } from '../autonomy/skills/world.js';
import { isNight } from '../autonomy/skills/sleep.js';
import { readDanger, evadeDanger } from './danger.js';
import { loadStrategyState, saveStrategyState } from './state.js';
import { createLogger } from '../logger.js';
import { wearArmor } from '../autonomy/milestones.js';
import { leaveHome, reachHome, reachSurface } from './navigation.js';
import { equipBestWeapon, isFightable } from '../actions/combat.js';
import { assessSupplies, shouldPauseForSupplies } from '../supplies/assessment.js';
import { chooseFood } from '../supplies/inventory.js';
import { descendToWater } from './recovery.js';
import { eatIfNeeded, replenishFood, supplyState } from '../supplies/planner.js';

const { goals } = pathfinderPkg;
const log = createLogger('strategy');
const pending = new WeakMap();
const PROTECTION_ITEMS = ['iron_chestplate', 'iron_helmet', 'iron_boots', 'iron_leggings', 'shield'];
const GOAL_NAMES = { eat: '进食', recover: '安全恢复', food: '补充生存口粮', supply_wait: '补给暂缓与复查', bootstrap: '木器与工作台',
  tools: '基础石器', workshop: '工作台与熔炉', shelter: '临时住所', house: '基础房屋', escape: '高处脱困', protection: '准备防具',
  farm: '农田巡检与维护', expandFarm: '渐进扩建农田', storage: '仓储整理', pasture: '牧场维护', night: '夜间避难', defend: '近身自卫', maintain: '基地巡检与等待' };
const eat = eatIfNeeded;

function shelteredUnderground(bot, state) {
  if (!state.home || bot.entity.position.y >= state.home.y - 8) return false;
  const block = bot.blockAt(bot.entity.position.floored());
  const canCraftLight = countItem(bot, 'stick') > 0 && countItem(bot, 'coal') + countItem(bot, 'charcoal') > 0;
  return block?.skyLight === 0 && (block.light >= 8 || countItem(bot, 'torch') > 0 || canCraftLight);
}

function farmDue(bot, state) {
  if (!state.farm) return false;
  const tick = gameClock(bot);
  const report = inspectFarm(bot, state.farm);
  const policy = farmSettings({ bot, state });
  const morning = tick !== null && !isNight(bot) && state.farm.lastMorningInspectionDay !== gameDay(bot);
  return state.farm.harvestSession || morning || state.farm.wakeInspectionPending
    || report.unknown === 0 && report.mature > 0 && report.matureRatio >= policy.harvestRatio
    || tick !== null && (state.farm.lastInspectionTick == null || tick - state.farm.lastInspectionTick >= policy.inspectionTicks || tick < state.farm.lastInspectionTick);
}

export function nextGoal(bot, state) {
  const danger = readDanger(bot);
  const supplies = supplyState(state);
  const assessment = assessSupplies(bot, state, supplies.pausedGoal?.task || {});
  if (danger.defend) return 'defend';
  if (assessment.needsMeal && assessment.mealAvailable) return 'eat';
  if (state.home && bot.entity.position.y - state.home.y > 64) return 'escape';
  if (bot.health < 14 && bot.food >= 18) return 'recover';
  const foodGoal = () => supplies.retryAt > Date.now() ? 'supply_wait' : 'food';
  if (assessment.level === 'emergency' || bot.food < 12 && !assessment.mealAvailable) return foodGoal();
  if (isNight(bot) && state.home && bot.food >= 12 && !shelteredUnderground(bot, state)) return 'night';
  if (!hasAtLeast(bot, 'wooden_pickaxe')) return 'bootstrap';
  if (state.home?.status === 'building' && state.plannedShelter && bot.food >= 12) return 'shelter';
  if (isNight(bot) && !state.home && bot.food >= 12) return 'shelter';
  // 补给失败时允许必要的自救生产，不能把造避难所/建立食物来源一并饿死锁住。
  if (supplies.retryAt > Date.now() && bot.food >= 18) {
    if (!hasAtLeast(bot, 'stone_pickaxe') || !hasAtLeast(bot, 'stone_axe')) return 'tools';
    if (!state.workshop) return 'workshop';
    if (!state.home) return 'shelter';
    if (!state.farm || ['building', 'needs_seeds', 'needs_repair'].includes(state.farm.status)) return 'farm';
  }
  if (assessment.food.regular < assessment.budget.foodMinimum
    || !supplies.pausedGoal && assessment.food.regular < assessment.budget.foodTarget) return foodGoal();
  if (isNight(bot) && !state.home) return 'shelter';
  if (isNight(bot) && state.home && !shelteredUnderground(bot, state)) return 'night';
  if (bot.farmRequest && state.home) return bot.farmRequest.operation === 'expand' ? 'expandFarm' : bot.farmRequest.operation === 'store' ? 'storage' : 'farm';
  if (!hasAtLeast(bot, 'stone_pickaxe') || !hasAtLeast(bot, 'stone_axe')) return 'tools';
  if (!state.workshop) return 'workshop';
  if (!state.home) return 'shelter';
  if (PROTECTION_ITEMS.some((item) => !hasAtLeast(bot, item))) return assessment.food.regular < 16 ? foodGoal() : 'protection';
  if (state.farm && farmDue(bot, state)) return 'farm';
  if (supplies.pausedGoal && GOAL_NAMES[supplies.pausedGoal.goal]) return supplies.pausedGoal.goal;
  if (!state.farm || ['building', 'needs_seeds'].includes(state.farm.status)) return 'farm';
  if (!state.storage && farmSettings({ bot, state }).storageMode === 'home' && !state.house) return 'house';
  if (!state.storage || Date.now() - (state.storage.lastStoredAt || 0) >= 60000 && hasSurplus({ bot, state })) return 'storage';
  if (state.pastures.some((pasture) => pasture.status === 'building' || pasture.needsGateClosure)) return 'pasture';
  if (!state.house) return 'house';
  const policy = farmSettings({ bot, state });
  const day = gameDay(bot);
  const roomToGrow = state.farm.width < policy.maxWidth || state.farm.depth < policy.maxDepth;
  const seedCount = ['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato'].reduce((sum, name) => sum + countItem(bot, name), 0);
  if (policy.autoExpand && roomToGrow && state.farm.harvestCycles > 0 && state.farm.status === 'growing'
    && day - state.farm.lastExpansionDay >= policy.expansionDays && seedCount >= policy.expansionStep * Math.min(state.farm.width, state.farm.depth)
    && state.storage && !state.storage.full) return 'expandFarm';
  if (state.pastures.length < 3) return 'pasture';
  const duePasture = state.pastures.some((pasture) => Date.now() - pasture.lastTendedAt > 60000);
  if (duePasture) return 'pasture';
  return 'maintain';
}

async function returnHome(ctx) {
  const home = ctx.state.home;
  if (!home || home.dimension !== String(ctx.bot.game.dimension)) return;
  if (shelteredUnderground(ctx.bot, ctx.state) && ['recover', 'supply_wait'].includes(ctx.bot.strategySupervisor?.goal)) return;
  await reachSurface(ctx, home.y);
  await reachHome(ctx, home);
}

async function goNear(ctx, location) {
  if (!location) return;
  if (ctx.bot.entity.position.distanceTo(new Vec3(location.x, location.y, location.z)) > 5) {
    await leaveHome(ctx, ctx.state.home);
    await reachSurface(ctx, location.y);
    await goTo(ctx.bot, new goals.GoalNear(location.x, location.y, location.z, 3), { signal: ctx.signal, timeoutMs: 45000 });
  }
}

async function rememberFacilities(ctx) {
  const memory = ctx.bot.memory;
  if (!memory?.enabled || memory.suspended) return;
  const context = memory.context();
  const state = structuredClone({ farm: ctx.state.farm, storage: ctx.state.storage, home: ctx.state.home, pastures: ctx.state.pastures });
  memory.enqueue(async () => {
    if (state.farm) await memory.manager.rememberFacility(context, { id: state.farm.id, name: '基地农田', type: 'farm',
      position: state.farm.origin, status: state.farm.status === 'growing' ? 'built_unverified' : 'building', components: state.farm.plots });
    if (state.storage) await memory.manager.rememberFacility(context, { id: state.storage.id, name: '农场仓储', type: 'storage',
      position: state.storage.origin || state.home, status: state.storage.status === 'ready' ? 'built_unverified' : 'building', components: state.storage.chests });
    for (const pasture of state.pastures) await memory.manager.rememberFacility(context, {
      id: pasture.id, name: `${pasture.species}牧场`, type: 'pasture', position: pasture.origin,
      status: pasture.status === 'building' ? 'building' : 'built_unverified', components: pasture.animals });
  });
}

function rememberHome(ctx) {
  const memory = ctx.bot.memory;
  if (!memory?.enabled || memory.suspended) return;
  const home = structuredClone(ctx.state.home);
  const context = memory.context();
  memory.enqueue(() => memory.manager.remember(context, { kind: 'home', key: 'primary', title: '自主建立的住所',
    data: { position: home, respawnConfirmed: false }, source: { type: 'project_record' } }));
}

async function executeGoal(ctx, goal) {
  const { bot, state } = ctx;
  if (goal === 'escape') {
    try { await returnHome(ctx); }
    catch (error) {
      throwIfAborted(ctx.signal);
      ctx.log(`常规回家路线不可用，检查平台落水路线：${error.message}`);
      await descendToWater(ctx);
    }
    return;
  }
  if (goal === 'eat') return eat(ctx);
  if (goal === 'supply_wait') {
    await eat(ctx);
    await returnHome(ctx);
    ctx.log('已知补给暂不可用，暂停非必要工作，等待来源复查；新获得食物会立即重新评估');
    await sleep(3000, ctx.signal);
    return;
  }
  if (goal === 'defend') {
    const enemy = bot.nearestEntity((entity) => isFightable(entity) && entity.position.distanceTo(bot.entity.position) < 3.5);
    if (!enemy) return;
    await equipBestWeapon(bot);
    try {
      for (let i = 0; i < 8 && enemy.isValid && bot.entities[enemy.id] && enemy.position.distanceTo(bot.entity.position) < 4; i++) {
        throwIfAborted(ctx.signal);
        if (readDanger(bot).retreat) return;
        bot.deactivateItem();
        await bot.lookAt(enemy.position.offset(0, Math.min(enemy.height || 1, 1.5), 0), true);
        bot.attack(enemy);
        if (bot.inventory.slots[45]?.name === 'shield') bot.activateItem(true);
        await sleep(650, ctx.signal);
      }
    } finally { bot.deactivateItem(); }
    return;
  }
  if (goal === 'night') {
    await returnHome(ctx);
    ctx.log('夜间留在住所观察，饥饿或危险会打断等待');
    await sleep(10000, ctx.signal);
    return;
  }
  if (goal === 'recover') {
    await returnHome(ctx);
    ctx.log('在安全位置恢复；若食物不足会重新转向补给');
    for (let i = 0; i < 20 && bot.health < 16; i++) {
      await eat(ctx);
      if (bot.food < 15 && !chooseFood(bot, state)) break;
      await sleep(1000, ctx.signal);
    }
    return;
  }
  if (goal === 'bootstrap') { await ctx.obtain('wooden_pickaxe', 1); await ensureCraftingTable(ctx); return; }
  if (goal === 'tools') {
    await ctx.obtain('stone_pickaxe', 1);
    await ctx.obtain('stone_axe', 1);
    await ctx.obtain('stone_sword', 1);
    return;
  }
  if (goal === 'workshop') {
    await ensureCraftingTable(ctx);
    const furnace = await ensureFurnace(ctx);
    state.workshop = { x: furnace.position.x, y: furnace.position.y, z: furnace.position.z, dimension: String(bot.game.dimension) };
    return;
  }
  if (goal === 'protection') {
    await ctx.obtain('torch', 16);
    const item = PROTECTION_ITEMS.find((name) => !hasAtLeast(bot, name));
    if (item) await ctx.obtain(item, 1);
    await wearArmor(ctx);
    return;
  }
  if (goal === 'shelter') {
    await ctx.obtain('stone_pickaxe', 1);
    try {
      const shelter = await buildShelter(ctx, { resultDetails: true });
      state.home = { ...shelter.position, door: shelter.door, dimension: String(bot.game.dimension), kind: 'cave' };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`山洞方案暂不可行：${err.message}；改用基础房屋`);
      const house = await buildHouse(ctx, { resultDetails: true, modelId: bot.autonomyHouseModel || 'starter' });
      state.home = { ...house.position, door: house.door, dimension: String(bot.game.dimension), kind: 'house' };
      state.house = { projectId: house.projectId };
    }
    rememberHome(ctx);
    return;
  }
  if (goal === 'house') {
    await leaveHome(ctx, state.home);
    if (!state.activeHouseProjectId && state.surveyPosition
      && bot.entity.position.distanceTo(new Vec3(state.surveyPosition.x, state.surveyPosition.y, state.surveyPosition.z)) < 48) {
      await goNear(ctx, state.surveyPosition);
    }
    const house = await buildHouse(ctx, { resultDetails: true, modelId: bot.autonomyHouseModel || 'starter' });
    state.house = { projectId: house.projectId };
    state.home = { ...house.position, door: house.door, dimension: String(bot.game.dimension), kind: 'house' };
    rememberHome(ctx);
    return;
  }
  if (goal === 'food') {
    await replenishFood(ctx, supplyState(state).pausedGoal?.task || {});
    return;
  }
  if (goal === 'storage') {
    const result = await storeSurplus(ctx);
    if (bot.farmRequest?.operation === 'store') bot.farmRequest = null;
    await rememberFacilities(ctx);
    ctx.log(`已核对存入 ${result.deposited} 件物品${result.full ? '，仍有余料未入库，保留背包并稍后处理' : ''}`);
    return;
  }
  if (goal === 'farm' || goal === 'expandFarm') {
    if (state.storage && bot.inventory.emptySlotCount() < 3) await storeSurplus(ctx);
    await leaveHome(ctx, state.home);
    if (goal === 'farm' && state.farm && ['building', 'needs_seeds'].includes(state.farm.status)
      && state.failures.farm?.farmId === state.farm.id && state.failures.farm?.attempts >= 3) {
      const report = inspectFarm(bot, state.farm);
      if (report.unknown === 0 && report.planted === 0) {
        state.suspendedFarms ??= [];
        state.suspendedFarms.push({ ...state.farm, suspendedAt: Date.now(), reason: state.failures.farm.reason });
        state.farm = null;
        delete state.failures.farm;
        const position = bot.entity.position;
        state.surveyPosition = { x: position.x, y: position.y, z: position.z };
        await ctx.checkpoint();
        ctx.log('旧农田未种植且多次不可达，保留原工程记录，在当前位置重新选址');
      }
    }
    const anchor = state.farm?.origin || bot.entity.position;
    await goNear(ctx, anchor);
    const result = goal === 'expandFarm' ? await expandFarm(ctx, bot.farmRequest?.operation === 'expand' ? bot.farmRequest : {})
      : await ensureFarm(ctx, { anchor });
    if (state.farm && result.report?.unknown === 0) {
      if (!isNight(bot)) state.farm.lastMorningInspectionDay = gameDay(bot);
      state.farm.wakeInspectionPending = false;
    }
    if (bot.farmRequest?.operation === (goal === 'expandFarm' ? 'expand' : 'tend') && !result.deferred) bot.farmRequest = null;
    await rememberFacilities(ctx);
    if (result.deferred) throw new Error(result.reason);
    if (countItem(bot, 'wheat') >= 6) await ctx.obtain('bread', countItem(bot, 'bread') + Math.floor((countItem(bot, 'wheat') - 3) / 3));
    if (hasSurplus(ctx) && (farmSettings(ctx).storageMode !== 'home' || state.house)) await storeSurplus(ctx);
    return;
  }
  if (goal === 'pasture') {
    const due = state.pastures.find((pasture) => pasture.status === 'building' || pasture.needsGateClosure || Date.now() - pasture.lastTendedAt > 60000);
    const anchor = due?.origin || state.surveyPosition || state.home || bot.entity.position;
    await goNear(ctx, anchor);
    const result = due ? await tendPasture(ctx, due) : await ensurePasture(ctx, { anchor });
    await rememberFacilities(ctx);
    if (result.deferred) throw new Error(result.reason);
    return;
  }
  if (!isNight(bot) && !state.house && !state.farm && state.surveyPosition) {
    await goNear(ctx, state.surveyPosition);
    ctx.log('在已探索的新选址附近复查，等待下一轮建设尝试');
  } else {
    await returnHome(ctx);
    ctx.log('基础生活条件维护中，等待作物生长并定期复查');
  }
  await sleep(10000, ctx.signal);
}

async function run(bot, { signal, setProgress }) {
  let state = await loadStrategyState(bot);
  supplyState(state);
  bot.supplyState = state;
  const supervisor = { active: true, retreating: false, goal: null, pausedGoal: null, danger: null, state };
  bot.strategySupervisor = supervisor;
  let step = null;
  let lastCheck = 0;
  const check = (force = false) => {
    if (!step || !bot.entity || !force && Date.now() - lastCheck < 200) return;
    if (bot.safeDescent && Date.now() < bot.safeDescent.expiresAt && bot.health > 0) return;
    lastCheck = Date.now();
    const danger = readDanger(bot);
    supervisor.danger = danger;
    const assessment = assessSupplies(bot, state, state.supplies?.activeTask || {});
    const needsFoodBreak = shouldPauseForSupplies(bot, state, supervisor.goal, supervisor.essentialStep);
    const needsDefense = danger.defend && supervisor.goal !== 'defend';
    const nightfall = isNight(bot) && state.home && bot.food >= 12 && !shelteredUnderground(bot, state)
      && !['night', 'recover', 'escape', 'supply_wait', 'eat'].includes(supervisor.goal);
    if (needsFoodBreak) {
      const supplies = supplyState(state);
      supplies.pausedGoal ??= { goal: supervisor.goal, task: supplies.activeTask || {}, position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        reason: assessment.reason, at: Date.now() };
    }
    if (bot.health <= 0 || bot.memory?.suspended || danger.retreat || needsDefense || needsFoodBreak || nightfall || String(bot.game.dimension) !== state.partition.dimension) {
      supervisor.pausedGoal = supervisor.goal;
      step.abort(danger.reasons.join('、') || (needsDefense ? '先处理近身敌人' : nightfall ? '天黑了，先返回住所' : assessment.reason) || '补给或世界状态需要重新评估');
      haltBot(bot);
    }
  };
  bot.on('physicsTick', check);
  const urgentCheck = () => check(true);
  bot.on('health', urgentCheck);
  bot.on('ownBreath', urgentCheck);
  const onWake = () => { if (state.farm) state.farm.wakeInspectionPending = true; };
  bot.on('wake', onWake);
  const checkpoint = async () => {
    try { await saveStrategyState(bot, state); } catch (err) { log.warn(`运行检查点保存失败：${err.message}`); }
  };
  try {
    while (!signal.aborted) {
      if (bot.memory?.suspended) throw new Error('世界身份已改变，自主生存已停止，等待重新连接');
      if (bot.health <= 0) { await sleep(1000, signal); continue; }
      if (String(bot.game.dimension) !== state.partition.dimension) {
        state = await loadStrategyState(bot);
        supplyState(state);
        bot.supplyState = state;
        supervisor.state = state;
      }
      const danger = readDanger(bot);
      if (danger.retreat) {
        supervisor.retreating = true;
        useMovementProfile(bot, 'safe');
        try {
          await evadeDanger({ bot, signal, state, log: setProgress }, state.home);
        } catch (err) {
          if (signal.aborted) throw err;
          log.warn(`避险暂未成功：${err.message}`);
          await sleep(3000, signal);
        } finally { supervisor.retreating = false; }
        continue;
      }
      const assessment = assessSupplies(bot, state);
      const needsSupplies = assessment.needsMeal || assessment.level !== 'normal';
      if (!['overworld', 'minecraft:overworld'].includes(String(bot.game.dimension)) && !needsSupplies) {
        setProgress('当前不在主世界，保持生存观察，不跨维度套用农牧建设计划');
        await sleep(3000, signal);
        continue;
      }
      let goal = nextGoal(bot, state);
      if (!['overworld', 'minecraft:overworld'].includes(String(bot.game.dimension))) {
        goal = assessment.needsMeal && assessment.mealAvailable ? 'eat' : state.supplies.retryAt > Date.now() ? 'supply_wait' : 'food';
      }
      await wearArmor({ bot, log: () => {} }).catch((error) => log.warn(`穿戴防具失败：${error.message}`));
      const failure = state.failures[goal];
      if (failure && failure.retryAt > Date.now() && !['eat', 'food', 'recover', 'supply_wait'].includes(goal)) {
        if (['night', 'bootstrap', 'shelter', 'escape'].includes(goal)) {
          setProgress(`${GOAL_NAMES[goal]}暂缓，留在当前位置复查安全条件`);
          await sleep(3000, signal);
          continue;
        }
        const alternative = ['farm', 'house', 'pasture'].find((candidate) => candidate !== goal
          && (assessment.level !== 'insufficient' || candidate === 'farm')
          && (state.failures[candidate]?.retryAt ?? 0) <= Date.now()
          && state.home && (candidate !== 'house' || !state.house) && (candidate !== 'pasture' || state.farm)
          && (candidate !== 'farm' || !state.farm || Date.now() - state.farm.lastTendedAt > 45000));
        goal = alternative || (assessment.level === 'insufficient' ? 'supply_wait' : 'maintain');
      }
      supervisor.goal = goal;
      supervisor.essentialStep = goal === 'bootstrap' || ['tools', 'workshop', 'shelter', 'farm'].includes(goal)
        && (state.supplies.retryAt > Date.now() || !state.home || state.home.status === 'building');
      supplyState(state).activeTask = { profile: 'local', goal };
      state.lastGoal = { goal, status: 'running', at: Date.now() };
      setProgress(`自主生存：${GOAL_NAMES[goal]}`);
      step = new AbortController();
      const stepSignal = AbortSignal.any([signal, step.signal]);
      const budget = setTimeout(() => step?.abort('单步时间预算耗尽，稍后继续'), 4 * 60 * 1000);
      const ctx = { bot, signal: stepSignal, state, depth: 0, checkpoint,
        log(text) { setProgress(`${GOAL_NAMES[goal]}：${text}`); } };
      const reservedBefore = new Set(state.reservedItems);
      ctx.obtain = async (item, count) => {
        state.reservedItems.add(item);
        if (countItem(bot, item) < count) {
          try { await retrieveMaterials(ctx, item, count); }
          catch (err) { throwIfAborted(stepSignal); ctx.log(`仓储暂不可取用，改为准备材料：${err.message}`); }
          if (state.storage?.mode === 'home') await leaveHome(ctx, state.home);
        }
        if ((item.endsWith('_log') || MINING[item] || MOB_DROPS[item]) && countItem(bot, item) < count) {
          await leaveHome(ctx, state.home);
          useMovementProfile(bot, 'free');
        }
        return obtain(ctx, item, count);
      };
      // 旧技能内部的 rest 检查也参与补给；夜间不调用会盲目挖坑的回退技能。
      let lastLightCheck = 0;
      ctx.rest = async () => {
        throwIfAborted(stepSignal);
        await eat(ctx);
        if (Date.now() - lastLightCheck < 5000) return;
        lastLightCheck = Date.now();
        const block = bot.blockAt(bot.entity.position.floored());
        if (block && Number.isFinite(block.light) && block.light < 8 && (isNight(bot) || block.skyLight < 8)) {
          try {
            if (!countItem(bot, 'torch') && countItem(bot, 'stick') > 0
              && countItem(bot, 'coal') + countItem(bot, 'charcoal') > 0) await ctx.obtain('torch', 4);
            if (countItem(bot, 'torch')) await placeBlockNear(ctx, 'torch');
          }
          catch (err) { throwIfAborted(stepSignal); ctx.log(`附近暂不能安全补灯：${err.message}`); }
        }
      };
      ctx.storeMaterials = async () => {
        const result = await storeSurplus(ctx);
        await leaveHome(ctx, state.home);
        return result;
      };
      useMovementProfile(bot, 'free');
      try {
        await executeGoal(ctx, goal);
        throwIfAborted(stepSignal);
        delete state.failures[goal];
        state.lastGoal.status = 'completed';
        if (state.supplies.pausedGoal?.goal === goal) state.supplies.pausedGoal = null;
        supervisor.pausedGoal = null;
      } catch (err) {
        if (signal.aborted) throw err;
        if (step.signal.aborted) {
          state.lastGoal.status = 'paused';
          state.lastGoal.reason = String(step.signal.reason);
        } else {
          const previousFailure = state.failures[goal];
          const sameProject = goal !== 'farm' || previousFailure?.farmId === state.farm?.id;
          const attempts = (sameProject ? previousFailure?.attempts ?? 0 : 0) + 1;
          state.failures[goal] = { attempts, reason: err.message, retryAt: Date.now() + Math.min(180000, attempts * 20000),
            ...(goal === 'farm' ? { farmId: state.farm?.id } : {}) };
          state.lastGoal.status = 'deferred';
          ctx.log(`暂缓：${err.message}`);
          const explorationSupplies = assessSupplies(bot, state);
          if (['farm', 'pasture', 'shelter', 'house'].includes(goal) && attempts % 2 === 0 && !isNight(bot)
            && bot.food >= 12 && explorationSupplies.food.regular >= explorationSupplies.budget.foodMinimum) {
            try {
              await leaveHome(ctx, state.home);
              const from = bot.entity.position;
              const openBiomes = new Set(['plains', 'sunflower_plains', 'meadow', 'savanna']);
              const candidates = [];
              for (let x = -96; x <= 96; x += 16) for (let z = -96; z <= 96; z += 16) {
                if (Math.hypot(x, z) < 32) continue;
                const point = from.offset(x, 0, z);
                if (openBiomes.has(bot.blockAt(point)?.biome?.name)) candidates.push(point);
              }
              candidates.sort((a, b) => a.distanceTo(from) - b.distanceTo(from));
              if (candidates.length) {
                state.heading = Math.atan2(candidates[0].z - from.z, candidates[0].x - from.x);
                ctx.log('已加载区块中发现开阔群系，向该方向继续检查地基');
              }
              await explore(ctx, 24);
              const p = bot.entity.position;
              state.surveyPosition = { x: p.x, y: p.y, z: p.z };
            } catch (exploreError) { if (signal.aborted) throw exploreError; }
          }
        }
      } finally {
        clearTimeout(budget);
        step = null;
        state.reservedItems = reservedBefore;
        if (!signal.aborted) haltBot(bot);
        await checkpoint();
      }
      await sleep(1000, signal);
    }
  } finally {
    bot.removeListener('physicsTick', check);
    bot.removeListener('health', urgentCheck);
    bot.removeListener('ownBreath', urgentCheck);
    bot.removeListener('wake', onWake);
    supervisor.active = false;
    supplyState(state).activeTask = null;
    if (!signal.aborted) {
      haltBot(bot);
      useMovementProfile(bot, 'safe');
    }
    await checkpoint();
  }
}

export function startSurvival({ bot, tasks, owner = null, isWhisper = false }) {
  if (tasks.current?.kind === 'autonomy' && bot.strategySupervisor?.active) return '自主生存已经在运行';
  tasks.start({ label: '自主生存', kind: 'autonomy', owner, isWhisper, report: 'failure' }, (task) => {
    const previous = pending.get(bot) || Promise.resolve();
    const work = previous.catch(() => {}).then(() => { throwIfAborted(task.signal); return run(bot, task); });
    pending.set(bot, work);
    return work;
  });
  return '开始自主生存：优先避险和食物，再逐步建立住所、农田与牧场；可以随时叫停';
}
