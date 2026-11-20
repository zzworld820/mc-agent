// 简单规则策略：只选择一个主要目标，危险可打断，恢复后按真实状态继续。
// 与旧里程碑模式分开，不需要玩家消息或大模型调用才能持续推进。
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { countItem, goTo, haltBot, sleep, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { obtain, hasAtLeast } from '../autonomy/planner.js';
import { MINING, MOB_DROPS } from '../autonomy/knowledge.js';
import { nearestTreeWood, ensureCraftingTable } from '../autonomy/skills/craft.js';
import { ensureFurnace } from '../autonomy/skills/smelt.js';
import { buildHouse, buildShelter, finishHouse } from '../autonomy/skills/build.js';
import { mineUntil } from '../autonomy/skills/mine.js';
import { ensureFarm, expandFarm, inspectFarm } from '../autonomy/skills/farming.js';
import { farmSettings, gameClock, gameDay } from '../farming/settings.js';
import { storeSurplus, hasSurplus, retrieveMaterials } from '../farming/storage.js';
import { ensurePasture, tendPasture } from '../autonomy/skills/husbandry.js';
import { explore, placeBlockNear } from '../autonomy/skills/world.js';
import { hideUntilMorning, isNight } from '../autonomy/skills/sleep.js';
import { readDanger, evadeDanger } from './danger.js';
import { loadStrategyState, saveStrategyState } from './state.js';
import { createLogger } from '../logger.js';
import { wearArmor } from '../autonomy/milestones.js';
import { leaveHome, reachHome, reachSurface } from './navigation.js';
import { equipBestWeapon, isFightable } from '../actions/combat.js';
import { assessSupplies, shouldPauseForSupplies } from '../supplies/assessment.js';
import { chooseFood } from '../supplies/inventory.js';
import { descendToWater } from './recovery.js';
import { tryLocalUnstuck } from './unstuck.js';
import { ensureBase, archiveStorage, collectNearbyWool, sleepAtHome } from './base.js';
import { developmentStatus, developmentTask, IRON_EQUIPMENT } from './development.js';
import { refreshStorage } from '../farming/storage.js';
import { stockBase, prepareIronTrip, migrateStoredItems } from './stockpile.js';
import { eatIfNeeded, replenishFood, supplyState } from '../supplies/planner.js';

const { goals } = pathfinderPkg;
const log = createLogger('strategy');
const pending = new WeakMap();

const GOAL_NAMES = { timber: '起步采木', wool: '附近收集羊毛', camp: '山洞箱子与床', base: '基地建设与验收',
  finish_tree: '完成先前中断的整树采伐',
  house_finish: '完善房屋窗户与屋顶',
  reserves: '基础物资与备用工具入库', food_stock: '积累恢复口粮', bind_home: '确认基地重生点',
  iron_reserve: '铁器与剩余铁入库', recovery_kit: '回基地补充恢复物资', eat: '进食', recover: '安全恢复', food: '补充生存口粮', supply_wait: '补给暂缓与复查', bootstrap: '木器与工作台',
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
  const assessment = assessSupplies(bot, state, developmentTask('house', state));
  if (danger.defend) return 'defend';
  if (assessment.needsMeal && assessment.mealAvailable) return 'eat';
  const feet = bot.entity.position.floored();
  const highPlatform = !state.home && feet.y > 200 && bot.blockAt(feet.offset(0, -1, 0))?.name === 'bedrock';
  if (highPlatform || state.home && bot.entity.position.y - state.home.y > 64) return 'escape';
  if (state.emergencyShelter) return 'night';
  // 日落前停止普通发育。缺粮和恢复流程也不能绕过夜间避难。
  if (isNight(bot) || (bot.time?.timeOfDay ?? 0) >= 10000) return 'night';
  if (bot.health < 14 && bot.food >= 18) return 'recover';
  const foodGoal = () => supplies.retryAt > Date.now() ? 'supply_wait' : 'food';
  if (assessment.level === 'emergency' || bot.food < 12 && !assessment.mealAvailable) return foodGoal();
  if (state.wholeTree) return 'finish_tree';
  if (state.development?.recoveryPending && state.home) return 'recovery_kit';
  const development = developmentStatus(bot, state);
  if (!state.home && !state.development?.initialWoodCollected) return 'timber';
  if (!hasAtLeast(bot, 'wooden_pickaxe')) return 'bootstrap';
  if (!state.home) return 'shelter';
  if (state.home?.status === 'building' && state.plannedShelter) return 'shelter';
  if (state.home && !state.house && (!state.storage?.earlyCamp || state.storage.status !== 'ready' || !state.home.campReady)) return 'camp';
  if (assessment.food.regular < assessment.budget.foodMinimum) return foodGoal();
  if (!hasAtLeast(bot, 'stone_pickaxe') || !hasAtLeast(bot, 'stone_axe') || !hasAtLeast(bot, 'stone_sword')) return 'tools';
  if (state.storage?.status === 'ready' && hasSurplus({ bot, state })
    && !state.storage.full && Date.now() - (state.storage.lastStoredAt || 0) > 60000) return 'storage';
  if (!state.house) return 'house';
  if (!state.storage || !state.base?.ready || state.base.projectId !== state.house.projectId
    || Date.now() - (state.base.checkedAt || 0) > 120000) return 'base';
  if (Date.now() - (state.storage.lastVerifiedAt || 0) > 90000) return 'storage';
  if (!development.basicReserves) return 'reserves';
  if (!state.home.respawnConfirmed) return 'bind_home';
  if (state.farm && farmDue(bot, state)) return 'farm';
  if (!state.farm || ['building', 'needs_seeds'].includes(state.farm.status)) return 'farm';
  if (!development.foodReady || !state.farm.harvestCycles) return 'food_stock';
  if (state.house.finishingPending) return 'house_finish';
  if (IRON_EQUIPMENT.some((item) => !hasAtLeast(bot, item))) return 'protection';
  if (!development.ironReady) return 'iron_reserve';
  if (!state.development?.ironCompletedAt) return 'iron_reserve';
  if (bot.farmRequest) return bot.farmRequest.operation === 'expand' ? 'expandFarm' : bot.farmRequest.operation === 'store' ? 'storage' : 'farm';
  const policy = farmSettings({ bot, state });
  const day = gameDay(bot);
  const roomToGrow = state.farm.width < policy.maxWidth || state.farm.depth < policy.maxDepth;
  const seedCount = ['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato'].reduce((sum, name) => sum + countItem(bot, name), 0);
  if (development.settings.continueAfterIron && policy.autoExpand && roomToGrow && state.farm.harvestCycles > 0 && state.farm.status === 'growing'
    && day - state.farm.lastExpansionDay >= policy.expansionDays && seedCount >= policy.expansionStep * Math.min(state.farm.width, state.farm.depth)
    && state.storage && !state.storage.full) return 'expandFarm';
  if (development.settings.continueAfterIron && state.pastures.length < 3) return 'pasture';
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
    data: { position: home, respawnConfirmed: home.respawnConfirmed === true }, source: { type: 'project_record' } }));
}

async function executeGoal(ctx, goal) {
  const { bot, state } = ctx;
  if (goal === 'escape') {
    if (!state.home) return descendToWater(ctx);
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
    if (state.nightShelter?.day === gameDay(bot)) {
      try {
        await reachHome(ctx, state.nightShelter.home);
        ctx.log('留在本夜已确认的自有避难所，天亮继续建设');
        await sleep(10000, ctx.signal);
        return;
      } catch (error) {
        throwIfAborted(ctx.signal);
        delete state.nightShelter;
        ctx.log(`本夜避难所需要重新评估：${error.message}`);
      }
    }
    if (state.emergencyShelter && !state.emergencyShelter.placedBlocks?.length && state.home?.kind === 'cave') {
      const location = new Vec3(state.home.x, state.home.y, state.home.z);
      if (bot.entity.position.distanceTo(location) < 3) {
        try {
          if (await reachHome(ctx, state.home)) {
            delete state.emergencyShelter;
            await ctx.checkpoint();
          }
        } catch (error) { throwIfAborted(ctx.signal); ctx.log(`洞内站位暂未确认：${error.message}`); }
      }
    }
    if (state.emergencyShelter || !state.home) {
      if (await hideUntilMorning(ctx)) return;
      ctx.log('附近缺少可用掩体条件，暂停普通任务并持续复查危险');
      await sleep(3000, ctx.signal);
      return;
    }
    try { await returnHome(ctx); }
    catch (error) {
      throwIfAborted(ctx.signal);
      const nearbyShelters = (state.archivedStorage || []).map((storage) => storage.home)
        .filter((home) => home?.door && home.dimension === String(bot.game.dimension)
          && bot.entity.position.distanceTo(new Vec3(home.x, home.y, home.z)) <= 16)
        .sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
      for (const home of nearbyShelters) {
        try {
          if (await reachHome(ctx, home)) {
            state.nightShelter = { home: structuredClone(home), day: gameDay(bot) };
            await ctx.checkpoint();
            ctx.log('已回到附近保留的自有避难所，先安全过夜，天亮继续基地建设');
            await sleep(10000, ctx.signal);
            return;
          }
        } catch (shelterError) { throwIfAborted(ctx.signal); ctx.log(`旧避难所暂不可用：${shelterError.message}`); }
      }
      ctx.log(`返回住所失败，尝试就地封闭掩体：${error.message}`);
      if (await hideUntilMorning(ctx)) return;
      throw error;
    }
    if (bot.isSleeping) { await sleep(1000, ctx.signal); return; }
    if (state.house && !state.base?.ready) {
      // Staying indoors at night still permits installing already-carried
      // production blocks. This mode cannot gather materials or open the shell.
      try { await ensureBase(ctx, { permanent: true, availableOnly: true }); }
      catch (error) { throwIfAborted(ctx.signal); ctx.log(`夜间屋内设施暂缓：${error.message}`); }
    }
    const storage = state.storage;
    const nearbyChests = storage?.mode === 'home' && storage.status === 'ready'
      && storage.chests.every((chest) => new Vec3(chest.position.x, chest.position.y, chest.position.z)
        .distanceTo(new Vec3(state.home.x, state.home.y, state.home.z)) <= 6);
    if (nearbyChests && Date.now() - (storage.lastVerifiedAt || 0) >= 60000) {
      try { await refreshStorage(ctx); }
      catch (error) { throwIfAborted(ctx.signal); ctx.log(`住所箱子内容暂未核验：${error.message}`); }
    }
    try { if (await sleepAtHome(ctx)) return; }
    catch (error) { throwIfAborted(ctx.signal); ctx.log(`暂时不能睡觉：${error.message}`); }
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
  if (goal === 'recovery_kit') {
    await returnHome(ctx);
    await replenishFood(ctx, { profile: 'local' });
    for (const item of ['stone_pickaxe', 'stone_axe', 'stone_sword']) {
      if (!hasAtLeast(bot, item)) await ctx.obtain(item, 1);
    }
    await retrieveMaterials(ctx, 'torch', 8);
    state.development.recoveryPending = false;
    await ctx.checkpoint();
    return;
  }
  if (goal === 'timber') {
    await ctx.obtain(`${nearestTreeWood(bot)}_log`, 12);
    state.development.initialWoodCollected = true;
    return;
  }
  if (goal === 'finish_tree') {
    const item = state.wholeTree.name;
    await mineUntil(ctx, [item], () => true);
    return;
  }
  if (goal === 'wool') {
    state.development.lastWoolAttempt = Date.now();
    await collectNearbyWool(ctx);
    return;
  }
  if (goal === 'camp') return ensureBase(ctx);
  if (goal === 'base') return ensureBase(ctx, { permanent: true });
  if (['reserves', 'food_stock', 'iron_reserve'].includes(goal)) return stockBase(ctx, goal);
  if (goal === 'bind_home') {
    await returnHome(ctx);
    if (isNight(bot)) await sleepAtHome(ctx);
    else { ctx.log('床已就位，等待夜间实际睡眠确认重生点'); await sleep(10000, ctx.signal); }
    return;
  }
  if (goal === 'bootstrap') { await ctx.obtain('wooden_pickaxe', 1); await ensureCraftingTable(ctx); return; }
  if (goal === 'tools') {
    await ctx.obtain('stone_pickaxe', 1);
    await ctx.obtain('stone_axe', 1);
    await ctx.obtain('stone_sword', 1);
    state.development.recoveryPending = false;
    return;
  }
  if (goal === 'workshop') {
    await ensureCraftingTable(ctx);
    const furnace = await ensureFurnace(ctx);
    state.workshop = { x: furnace.position.x, y: furnace.position.y, z: furnace.position.z, dimension: String(bot.game.dimension) };
    return;
  }
  if (goal === 'protection') {
    await prepareIronTrip(ctx);
    const item = IRON_EQUIPMENT.find((name) => !hasAtLeast(bot, name));
    if (item) await ctx.obtain(item, 1);
    await wearArmor(ctx);
    await returnHome(ctx);
    await storeSurplus(ctx);
    return;
  }
  if (goal === 'shelter') {
    await ctx.obtain('stone_pickaxe', 1);
    try {
      const shelter = await buildShelter(ctx, { resultDetails: true, furnish: false });
      state.home = { ...shelter.position, door: shelter.door, dimension: String(bot.game.dimension), kind: 'cave' };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`山洞方案暂不可行：${err.message}；先准备土石应急掩体`);
      const available = bot.inventory.items().filter((item) => ['dirt', 'cobblestone', 'cobbled_deepslate'].includes(item.name))
        .reduce((sum, item) => sum + item.count, 0);
      if (available < 9) await ctx.obtain('dirt', 9);
      if (!await hideUntilMorning(ctx, { buildOnly: true })) throw new Error('当前位置无法封闭应急掩体，白天重新选址');
      return;
    }
    await ctx.checkpoint();
    if (state.house) await ensureBase(ctx, { permanent: true });
    else await ensureBase(ctx);
    rememberHome(ctx);
    return;
  }
  if (goal === 'house') {
    await leaveHome(ctx, state.home);
    if (!state.activeHouseProjectId && state.surveyPosition
      && bot.entity.position.distanceTo(new Vec3(state.surveyPosition.x, state.surveyPosition.y, state.surveyPosition.z)) < 48) {
      await goNear(ctx, state.surveyPosition);
    }
    const house = await buildHouse(ctx, { resultDetails: true, modelId: bot.autonomyHouseModel || 'starter', basicShell: true });
    archiveStorage(state);
    state.house = { projectId: house.projectId, finishingPending: house.finishingPending };
    state.home = { ...house.position, door: house.door, dimension: String(bot.game.dimension), kind: 'house', projectId: house.projectId };
    state.base = null;
    await ctx.checkpoint();
    await ensureBase(ctx, { permanent: true });
    await migrateStoredItems(ctx);
    rememberHome(ctx);
    return;
  }
  if (goal === 'food') {
    await replenishFood(ctx, supplyState(state).pausedGoal?.task || developmentTask('house', state));
    return;
  }
  if (goal === 'house_finish') {
    await leaveHome(ctx, state.home);
    await finishHouse(ctx, state.house.projectId);
    state.house.finishingPending = false;
    await ctx.checkpoint();
    return;
  }
  if (goal === 'storage') {
    if (!state.storage || state.storage.status !== 'ready') await ensureBase(ctx, { permanent: !!state.house });
    const result = await storeSurplus(ctx);
    if (bot.farmRequest?.operation === 'store') bot.farmRequest = null;
    await refreshStorage(ctx);
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
    const anchor = state.farm?.origin || state.home;
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
    if (hasSurplus(ctx)) await storeSurplus(ctx);
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
  if (!isNight(bot) && !state.house && state.surveyPosition) {
    await goNear(ctx, state.surveyPosition);
    ctx.log('在已探索的新选址附近复查，等待下一轮建设尝试');
  } else {
    await returnHome(ctx);
    ctx.log('基础生活条件维护中，等待作物生长并定期复查');
  }
  await sleep(10000, ctx.signal);
}

async function run(bot, { signal, setProgress, setStage }) {
  let state = await loadStrategyState(bot);
  state.development ??= {};
  // Migrate the old whole-base backoff once. Its historical failure remains
  // recorded while the new scheduler gets an immediate chance to do other work.
  if (!state.development.baseWorkSchedulerVersion) {
    state.development.baseWorkSchedulerVersion = 1;
    if (state.failures.base) {
      state.development.previousBaseFailure = structuredClone(state.failures.base);
      delete state.failures.base;
    }
  }
  state.farmConfig ??= {};
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
    const preparingTrip = ['protection', 'iron_reserve'].includes(supervisor.goal) && !state.development.tripReady;
    const needsFoodBreak = supervisor.goal !== 'night' && shouldPauseForSupplies(bot, state, supervisor.goal, supervisor.essentialStep || preparingTrip);
    const needsDefense = danger.defend && supervisor.goal !== 'defend';
    const shelterDeadline = !state.home && (bot.time?.timeOfDay ?? 0) >= 10000
      && !['night', 'escape', 'eat'].includes(supervisor.goal);
    const nightfall = (isNight(bot) || (bot.time?.timeOfDay ?? 0) >= 10000) && state.home
      && !['night', 'escape', 'eat', 'defend'].includes(supervisor.goal);
    if (needsFoodBreak) {
      const supplies = supplyState(state);
      supplies.pausedGoal ??= { goal: supervisor.goal, task: supplies.activeTask || {}, position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        reason: assessment.reason, at: Date.now() };
    }
    if (bot.health <= 0 || bot.memory?.suspended || danger.retreat || needsDefense || needsFoodBreak || nightfall || shelterDeadline || String(bot.game.dimension) !== state.partition.dimension) {
      supervisor.pausedGoal = supervisor.goal;
      step.abort(danger.reasons.join('、') || (needsDefense ? '先处理近身敌人' : nightfall || shelterDeadline ? '接近夜晚，先建立或返回住所' : assessment.reason) || '补给或世界状态需要重新评估');
      haltBot(bot);
    }
  };
  bot.on('physicsTick', check);
  const urgentCheck = () => check(true);
  bot.on('health', urgentCheck);
  bot.on('ownBreath', urgentCheck);
  const onDeath = () => {
    state.development.lastDeathAt = Date.now();
    state.development.recoveryPending = true;
    delete state.emergencyShelter;
    state.base = null;
    state.failures = {};
    state.supplies.pausedGoal = null;
    state.supplies.retryAt = 0;
  };
  const onSpawnReset = () => { if (state.home) state.home.respawnConfirmed = false; };
  bot.on('death', onDeath);
  bot.on('spawnReset', onSpawnReset);
  const onWake = () => { if (state.farm) state.farm.wakeInspectionPending = true; };
  bot.on('wake', onWake);
  const checkpoint = async () => {
    try { await saveStrategyState(bot, state); } catch (err) { log.warn(`运行检查点保存失败：${err.message}`); }
  };
  try {
    while (!signal.aborted) {
      if (bot.memory?.suspended) throw new Error('世界身份已改变，自主生存已停止，等待重新连接');
      if (bot.health <= 0 || bot.isSleeping) { await sleep(1000, signal); continue; }
      if (String(bot.game.dimension) !== state.partition.dimension) {
        state = await loadStrategyState(bot);
        state.development ??= {};
        state.farmConfig ??= {};
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
      if (state.development.recoveryPending && state.home) {
        setProgress('死亡后先返回基地，使用库存恢复基础生产');
      }
      const assessment = assessSupplies(bot, state, developmentTask('house', state));
      const needsSupplies = assessment.needsMeal || assessment.level !== 'normal';
      if (!['overworld', 'minecraft:overworld'].includes(String(bot.game.dimension)) && !needsSupplies) {
        setProgress('当前不在主世界，保持生存观察，不跨维度套用农牧建设计划');
        await sleep(3000, signal);
        continue;
      }
      let goal = nextGoal(bot, state);
      if (goal !== 'night') delete state.nightShelter;
      if (state.failures.food?.attempts >= 3 && assessment.budget.localConstruction
        && ['house', 'base', 'tools', 'farm', 'reserves'].includes(goal)
        && !state.development.supplyRecoveryDecision) {
        state.development.supplyRecoveryDecision = { at: Date.now(), attempts: state.failures.food.attempts,
          goal, reason: '身体稳定，限定在住所附近先恢复建设与食物生产' };
        state.supplies.pausedGoal = null;
        setProgress(`补粮已连续失败 ${state.failures.food.attempts} 次，改为${GOAL_NAMES[goal]}，先建立生产条件`);
        await checkpoint();
      }
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
        if (assessment.level === 'insufficient') goal = 'supply_wait';
        else {
          setProgress(`${GOAL_NAMES[goal]}：${failure.reason}；${Math.ceil((failure.retryAt - Date.now()) / 1000)}秒后重试`);
          await sleep(Math.min(5000, failure.retryAt - Date.now()), signal);
          continue;
        }
      }
      setStage?.(null);
      supervisor.goal = goal;
      state.development.tripReady = false;
      supervisor.essentialStep = ['bootstrap', 'timber', 'finish_tree', 'tools', 'camp', 'base', 'reserves', 'food_stock', 'bind_home', 'shelter', 'recovery_kit'].includes(goal);
      supplyState(state).activeTask = developmentTask(goal, state);
      state.development.stage = developmentStatus(bot, state).stage;
      state.lastGoal = { goal, status: 'running', at: Date.now() };
      setProgress(`自主生存：${GOAL_NAMES[goal]}`);
      step = new AbortController();
      const stepSignal = AbortSignal.any([signal, step.signal]);
      const budget = setTimeout(() => step?.abort('单步时间预算耗尽，稍后继续'), 4 * 60 * 1000);
      const ctx = { bot, signal: stepSignal, state, depth: 0, checkpoint,
        log(text) { setProgress(`${GOAL_NAMES[goal]}：${text}`); }, stage: setStage, materialNeeds: new Map() };
      const reservedBefore = new Set(state.reservedItems);
      ctx.obtain = async (item, count) => {
        if ((isNight(bot) || (bot.time?.timeOfDay ?? 0) >= 10000) && countItem(bot, item) < count) {
          throw new Error('夜间缺料，等待天亮后再采集');
        }
        state.reservedItems.add(item);
        const previousNeed = ctx.materialNeeds.get(item);
        ctx.materialNeeds.set(item, Math.max(count, previousNeed || 0));
        try {
          if (countItem(bot, item) < count && ctx.stockpilingItem !== item) {
            try { await retrieveMaterials(ctx, item, count); }
            catch (err) { throwIfAborted(stepSignal); ctx.log(`仓储暂不可取用，改为准备材料：${err.message}`); }
          }
          if ((item.endsWith('_log') || MINING[item] || MOB_DROPS[item]) && countItem(bot, item) < count) {
            await leaveHome(ctx, state.home);
            useMovementProfile(bot, 'free');
          }
          return await obtain(ctx, item, count);
        } finally {
          if (previousNeed === undefined) ctx.materialNeeds.delete(item);
          else ctx.materialNeeds.set(item, previousNeed);
        }
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
        const result = await executeGoal(ctx, goal);
        throwIfAborted(stepSignal);
        const previousFailure = state.failures[goal];
        delete state.failures[goal];
        const deferredBase = goal === 'base' && (result?.pending || result?.deferred);
        state.lastGoal.status = deferredBase ? 'deferred' : 'completed';
        if (deferredBase) {
          state.lastGoal.reason = `${result.summary ? `设施与仓储核验 ${result.summary.completed}/${result.summary.total} 项；` : ''}${result.reason || '基地尚有待办，已记录各项进度'}`;
          ctx.log(state.lastGoal.reason);
          // A deferred subtask is not a failed whole-base goal. Keep survival
          // checks responsive and let another ready job run on the next pass.
          await sleep(Math.min(5000, Math.max(1000, (result.retryAt || Date.now() + 1000) - Date.now())), stepSignal);
        }
        if (previousFailure && !deferredBase) bot.emit('agentIncident', { type: 'resolved', goal, reason: previousFailure.reason,
          result: '原任务已完成并通过现有执行检查' });
        if (state.supplies.pausedGoal?.goal === goal) state.supplies.pausedGoal = null;
        supervisor.pausedGoal = null;
        if (goal === 'recovery_kit') state.supplies.pausedGoal = null;
      } catch (err) {
        if (signal.aborted) throw err;
        if (step.signal.aborted) {
          state.lastGoal.status = 'paused';
          state.lastGoal.reason = String(step.signal.reason);
        } else {
          const previousFailure = state.failures[goal];
          const sameProject = goal !== 'farm' || previousFailure?.farmId === state.farm?.id;
          const attempts = (sameProject ? previousFailure?.attempts ?? 0 : 0) + 1;
          const p = bot.entity.position;
          const stayed = previousFailure?.position && p.distanceTo(new Vec3(previousFailure.position.x, previousFailure.position.y, previousFailure.position.z)) < 1.5;
          state.failures[goal] = { attempts, reason: err.message, retryAt: Date.now() + (goal === 'night' ? 5000 : goal === 'base' ? 15000 : Math.min(180000, attempts * 20000)),
            position: { x: p.x, y: p.y, z: p.z },
            ...(goal === 'farm' ? { farmId: state.farm?.id } : {}) };
          state.lastGoal.status = 'deferred';
          ctx.log(`暂缓：${err.message}`);
          if (previousFailure?.reason !== err.message || !stayed) bot.emit('agentIncident',
            { type: 'failure', goal, reason: err.message, attempts });

          if (stayed && !state.emergencyShelter && /路线|路径|走不通|走过去|卡住|没挪动/.test(err.message)) {
            try {
              if (await tryLocalUnstuck(ctx)) state.failures[goal].retryAt = 0;
            } catch (recoveryError) {
              throwIfAborted(signal);
              ctx.log(`局部脱困暂缓：${recoveryError.message}`);
            }
          }
          const explorationSupplies = assessSupplies(bot, state);
          if (['farm', 'pasture', 'shelter', 'house', 'base'].includes(goal) && attempts % 2 === 0 && !isNight(bot)
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
        if (!signal.aborted && !bot.isSleeping) haltBot(bot);
        await checkpoint();
      }
      await sleep(1000, signal);
    }
  } finally {
    bot.removeListener('physicsTick', check);
    bot.removeListener('health', urgentCheck);
    bot.removeListener('ownBreath', urgentCheck);
    bot.removeListener('wake', onWake);
    bot.removeListener('death', onDeath);
    bot.removeListener('spawnReset', onSpawnReset);
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
  return '开始自主生存：采木与临时住所 → 箱子和床 → 正式基地与备用物资 → 农业和存粮 → 铁器与备用铁';
}
