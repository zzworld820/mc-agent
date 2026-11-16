import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, goTo, sleep, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { digBlock } from '../autonomy/skills/mine.js';
import { collectDrops } from '../autonomy/skills/world.js';
import { placeBlockAt } from '../autonomy/skills/build.js';
import { farmSettings, gameClock, gameDay } from './settings.js';

const { goals } = pathfinderPkg;
const SOIL = new Set(['dirt', 'grass_block', 'farmland']);
const EMPTY = new Set(['air', 'cave_air', 'short_grass', 'fern']);
export const CROPS = [
  { seed: 'wheat_seeds', block: 'wheat', age: 7 }, { seed: 'potato', block: 'potatoes', age: 7 },
  { seed: 'beetroot_seeds', block: 'beetroots', age: 3 }, { seed: 'carrot', block: 'carrots', age: 7 },
];
export const farmPoint = (p) => new Vec3(p.x, p.y, p.z);
const plain = (p) => ({ x: p.x, y: p.y, z: p.z });
const key = (p) => `${p.x},${p.y},${p.z}`;
const hydratedBy = (p, water) => p.y === water.y && Math.abs(p.x - water.x) <= 4 && Math.abs(p.z - water.z) <= 4;

function migrateFarm(farm, bot) {
  farm.width ??= Math.max(...farm.plots.map((plot) => plot.position.x)) - farm.origin.x + 1;
  farm.depth ??= Math.max(...farm.plots.map((plot) => plot.position.z)) - farm.origin.z + 1;
  farm.waters ??= farm.water ? [{ position: farm.water, owned: false }] : [];
  farm.lamps ??= [];
  if (!farm.lamps.length && farm.dimension === String(bot.game.dimension)) {
    farm.lamps = [[-1, 0], [3, 1], [0, -1], [2, 2]].map(([x, z]) => farmPoint(farm.origin).offset(x, 0, z))
      .filter((p) => SOIL.has(bot.blockAt(p)?.name) && (EMPTY.has(bot.blockAt(p.offset(0, 1, 0))?.name)
        || ['torch', 'wall_torch'].includes(bot.blockAt(p.offset(0, 1, 0))?.name))).slice(0, 2).map((p) => ({ soil: plain(p) }));
  }
  farm.harvestCycles ??= 0;
  farm.expansions ??= [];
  return farm;
}

export function inspectFarm(bot, farm) {
  if (!farm) return null;
  migrateFarm(farm, bot);
  const report = { plots: farm.plots.length, planted: 0, mature: 0, immature: 0, empty: 0,
    damaged: 0, unknown: 0, blocked: 0, dry: 0, matureRatio: 0, crops: {} };
  if (farm.dimension !== String(bot.game.dimension)) return { ...report, unknown: farm.plots.length, reason: '农田不在当前维度' };
  for (const plot of farm.plots) {
    const p = farmPoint(plot.position);
    const soil = bot.blockAt(p);
    const plant = bot.blockAt(p.offset(0, 1, 0));
    if (!soil || !plant) { report.unknown++; continue; }
    if (soil.name !== 'farmland') report.damaged++;
    else if (Number(soil.getProperties().moisture ?? 0) === 0) report.dry++;
    const crop = CROPS.find((entry) => entry.block === plant.name);
    if (crop) {
      report.planted++;
      report.crops[crop.block] = (report.crops[crop.block] ?? 0) + 1;
      if (Number(plant.getProperties().age) >= crop.age) report.mature++;
      else report.immature++;
    } else if (EMPTY.has(plant.name)) report.empty++;
    else report.blocked++;
  }
  report.matureRatio = report.planted + report.unknown ? report.mature / (report.planted + report.unknown) : 0;
  return report;
}

async function gatherSeeds(ctx) {
  if (CROPS.some((crop) => countItem(ctx.bot, crop.seed) > 0)) return;
  const ids = ['short_grass', 'tall_grass', 'grass'].map((name) => ctx.bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined);
  if (!ids.length) return;
  for (const p of ctx.bot.findBlocks({ matching: ids, maxDistance: 24, count: 40 })) {
    throwIfAborted(ctx.signal);
    const block = ctx.bot.blockAt(p);
    if (!['short_grass', 'tall_grass', 'grass'].includes(block?.name)) continue;
    try { await digBlock(ctx, block); } catch (err) { if (ctx.signal.aborted) throw err; }
    if (countItem(ctx.bot, 'wheat_seeds') >= 8) break;
  }
}

function clearSoil(bot, p) {
  if (!['dirt', 'grass_block'].includes(bot.blockAt(p)?.name) || bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') return false;
  if (!EMPTY.has(bot.blockAt(p.offset(0, 1, 0))?.name)) return false;
  for (let y = 2; y <= 6; y++) if (bot.blockAt(p.offset(0, y, 0))?.boundingBox !== 'empty') return false;
  return true;
}

function planArea(bot, farm, width, depth) {
  const old = new Set([...farm.plots.map((plot) => key(plot.position)), ...farm.waters.filter((entry) => entry.owned).map((entry) => key(entry.position)), ...farm.lamps.map((entry) => key(entry.soil))]);
  const added = [];
  for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) {
    const p = farmPoint(farm.origin).offset(x, 0, z);
    if (old.has(key(p))) continue;
    if (!clearSoil(bot, p)) return null;
    added.push(p);
  }
  const reserved = new Set();
  const lamps = [];
  for (let x = 0; x < width; x += 5) for (let z = 0; z < depth; z += 5) {
    const center = farmPoint(farm.origin).offset(Math.min(x + 2, width - 1), 0, Math.min(z + 2, depth - 1));
    if ([...farm.lamps, ...lamps].some((entry) => Math.abs(entry.soil.x - center.x) + Math.abs(entry.soil.z - center.z) <= 3)) continue;
    const external = width * depth < 9 ? [center.offset(-width, 0, 0), center.offset(0, 0, 1)].find((p) => clearSoil(bot, p)
      && !old.has(key(p)) && !added.some((entry) => key(entry) === key(p))) : null;
    const p = external || added.filter((entry) => !reserved.has(key(entry))).sort((a, b) => a.distanceTo(center) - b.distanceTo(center))[0];
    if (p) { reserved.add(key(p)); lamps.push({ soil: plain(p) }); }
  }
  const waters = [];
  const allWaters = farm.waters.map((entry) => entry.position);
  let uncovered = added.filter((p) => !reserved.has(key(p)) && !allWaters.some((water) => hydratedBy(p, water)));
  while (uncovered.length) {
    const p = uncovered[Math.floor(uncovered.length / 2)];
    reserved.add(key(p));
    waters.push({ position: plain(p), owned: true });
    uncovered = uncovered.filter((other) => !hydratedBy(other, p));
  }
  return { plots: added.filter((p) => !reserved.has(key(p))).map((p) => ({ position: plain(p), crop: null })), waters, lamps };
}

function findSite(ctx, anchor, width, depth) {
  const bot = ctx.bot;
  const waters = bot.findBlocks({ point: anchor, matching: bot.registry.blocksByName.water.id, maxDistance: 24, count: 60 });
  const origins = waters.flatMap((p) => [-4, -1, 1].flatMap((x) => [-4, -1, 1].map((z) => p.offset(x, 0, z))));
  const feet = bot.entity.position.floored();
  for (let x = -16; x <= 16; x += 8) for (let z = -16; z <= 16; z += 8) origins.push(feet.offset(x, -1, z));
  for (const origin of origins) {
    const farm = { origin: plain(origin), plots: [], lamps: [], waters: waters.filter((p) => p.y === origin.y).map((p) => ({ position: plain(p), owned: false })) };
    const plan = planArea(bot, farm, width, depth);
    if (plan && plan.plots.length) return { farm, plan };
  }
  return null;
}

function walkProfile(bot) {
  useMovementProfile(bot, 'safe');
  bot.pathfinder.movements.allowParkour = false;
  bot.pathfinder.movements.allowSprinting = false;
}

async function approach(ctx, p) {
  await goTo(ctx.bot, new goals.GoalNear(p.x, p.y + 1, p.z, 2), { signal: ctx.signal, timeoutMs: 25000 });
}

async function waterBucket(ctx, farm) {
  if (countItem(ctx.bot, 'water_bucket')) return;
  await ctx.obtain('bucket', 1);
  const owned = new Set(farm.waters.filter((entry) => entry.owned || farm.plots.some((plot) => hydratedBy(plot.position, entry.position)))
    .map((entry) => key(entry.position)));
  const sources = ctx.bot.findBlocks({ matching: ctx.bot.registry.blocksByName.water.id, maxDistance: 48, count: 160 })
    .filter((p) => !owned.has(key(p)) && Number(ctx.bot.blockAt(p)?.getProperties().level) === 0
      && ctx.bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty');
  for (const p of sources.slice(0, 8)) {
    throwIfAborted(ctx.signal);
    try {
    await approach(ctx, p);
    await ctx.bot.equip(ctx.bot.inventory.items().find((item) => item.name === 'bucket'), 'hand');
    await ctx.bot.lookAt(p.offset(0.5, 0.8, 0.5), true);
    const aimed = ctx.bot.blockAtCursor(4.5, (block, ray) => block.name === 'water' && Number(block.getProperties().level) === 0
      || !!ray.intersect(block.shapes, block.position));
    if (!aimed?.position.equals(p)) continue;
    ctx.bot.activateItem();
    await sleep(600, ctx.signal);
    if (countItem(ctx.bot, 'water_bucket')) return;
    } catch (err) {
      throwIfAborted(ctx.signal);
      ctx.log(`跳过暂不可达水源 ${key(p)}：${err.message}`);
    }
  }
  throw new Error('未找到能安全取用的外部水源，不抽干农田自有水槽');
}

async function repairSoil(ctx, p) {
  const block = ctx.bot.blockAt(p);
  if (!block) throw new Error('地块未加载');
  if (SOIL.has(block.name)) return;
  if (!EMPTY.has(block.name)) throw new Error(`地块被 ${block.name} 占用，保留原状`);
  const below = p.offset(0, -1, 0);
  if (ctx.bot.blockAt(below)?.boundingBox !== 'block') {
    if (ctx.bot.blockAt(p.offset(0, -2, 0))?.boundingBox !== 'block' || !EMPTY.has(ctx.bot.blockAt(below)?.name)) throw new Error('地块破坏过深，不能悬空补土');
    await ctx.obtain('dirt', 2);
    await placeBlockAt(ctx, below, 'dirt');
  } else await ctx.obtain('dirt', 1);
  await placeBlockAt(ctx, p, 'dirt');
}

async function repairInfrastructure(ctx, farm) {
  // 河边老农田失去外部水源时，补建可管理的小水槽，不尝试重造整条河。
  const uncovered = farm.plots.filter((plot) => !farm.waters.some((entry) => hydratedBy(plot.position, entry.position)
    && ctx.bot.blockAt(farmPoint(entry.position))?.name === 'water'));
  if (uncovered.length && !farm.waters.some((entry) => entry.owned && uncovered.some((plot) => hydratedBy(plot.position, entry.position)))) {
    const p = farmPoint(uncovered[0].position);
    const candidates = [];
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) candidates.push(p.offset(x, 0, z));
    const target = candidates.filter((q) => clearSoil(ctx.bot, q) && !farm.plots.some((plot) => key(plot.position) === key(q))
      && !farm.lamps.some((entry) => key(entry.soil) === key(q)))
      .sort((a, b) => uncovered.filter((plot) => hydratedBy(plot.position, b)).length - uncovered.filter((plot) => hydratedBy(plot.position, a)).length)[0];
    if (target) {
      farm.waters.push({ position: plain(target), owned: true });
      await ctx.checkpoint?.();
    }
  }
  for (const water of farm.waters.filter((entry) => entry.owned)) {
    const p = farmPoint(water.position);
    const current = ctx.bot.blockAt(p);
    if (!current) throw new Error('水槽未加载');
    if (current.name !== 'water' && !SOIL.has(current.name) && !EMPTY.has(current.name)) throw new Error('水槽被未知方块占用');
    if (ctx.bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') await repairSoil(ctx, p.offset(0, -1, 0));
    for (const offset of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const sidePosition = p.offset(...offset);
      let side = ctx.bot.blockAt(sidePosition);
      if (EMPTY.has(side?.name)) { await repairSoil(ctx, sidePosition); side = ctx.bot.blockAt(sidePosition); }
      if (!side || side.boundingBox !== 'block' && side.name !== 'water') throw new Error('水槽侧面缺失，不能让灌溉水外泄');
    }
    if (current.name === 'water') continue;
    await waterBucket(ctx, farm);
    walkProfile(ctx.bot);
    if (SOIL.has(current.name)) await digBlock(ctx, ctx.bot.blockAt(p));
    const stand = [p.offset(1, 1, 0), p.offset(-1, 1, 0), p.offset(0, 1, 1), p.offset(0, 1, -1)]
      .find((q) => ctx.bot.blockAt(q.offset(0, -1, 0))?.boundingBox === 'block' && ctx.bot.blockAt(q)?.boundingBox === 'empty');
    if (!stand) throw new Error('水槽没有安全倒水站位');
    await goTo(ctx.bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { signal: ctx.signal, timeoutMs: 15000 });
    await ctx.bot.equip(ctx.bot.inventory.items().find((item) => item.name === 'water_bucket'), 'hand');
    await ctx.bot.lookAt(p.offset(0.5, 0.01, 0.5), true);
    if (!ctx.bot.blockAtCursor(4.5)?.position.equals(p.offset(0, -1, 0))) throw new Error('倒水瞄准未通过检查');
    ctx.bot.activateItem();
    await sleep(600, ctx.signal);
    if (ctx.bot.blockAt(p)?.name !== 'water') throw new Error('灌溉水放置未确认');
    await ctx.checkpoint?.();
  }
  for (const lamp of farm.lamps) {
    const soil = farmPoint(lamp.soil);
    await repairSoil(ctx, soil);
    const target = soil.offset(0, 1, 0);
    const current = ctx.bot.blockAt(target);
    if (['torch', 'wall_torch'].includes(current?.name)) continue;
    if (!EMPTY.has(current?.name)) throw new Error('照明位被占用，不能覆盖');
    await ctx.obtain('torch', 1);
    walkProfile(ctx.bot);
    await placeBlockAt(ctx, target, 'torch');
  }
}

export async function ensureFarm(ctx, { anchor = ctx.bot.entity.position } = {}) {
  const settings = farmSettings(ctx);
  await gatherSeeds(ctx);
  if (!ctx.state.farm) {
    if (!CROPS.some((crop) => countItem(ctx.bot, crop.seed))) return { deferred: true, reason: '未取得种植材料' };
    const site = findSite(ctx, farmPoint(anchor), settings.width, settings.depth);
    if (!site) return { deferred: true, reason: '没有适合所配置尺寸的安全地基' };
    ctx.state.farm = { id: randomUUID(), ...site.farm, ...site.plan, waters: [...site.farm.waters, ...site.plan.waters],
      width: settings.width, depth: settings.depth, dimension: String(ctx.bot.game.dimension), status: 'building',
      expansions: [], harvestCycles: 0, lastTendedAt: 0, lastExpansionDay: gameDay(ctx.bot) };
    await ctx.checkpoint?.();
  }
  return tendFarm(ctx);
}

export async function expandFarm(ctx, { width, depth } = {}) {
  if (!ctx.state.farm) {
    const result = await ensureFarm(ctx);
    if (result.deferred) return result;
  }
  const farm = migrateFarm(ctx.state.farm, ctx.bot);
  if (farm.dimension !== String(ctx.bot.game.dimension)) throw new Error('农田不在当前维度');
  const settings = farmSettings(ctx);
  width ??= Math.max(farm.width, Math.min(settings.maxWidth, farm.width + settings.expansionStep));
  depth ??= width === farm.width ? Math.max(farm.depth, Math.min(settings.maxDepth, farm.depth + settings.expansionStep)) : farm.depth;
  if (![width, depth].every((n) => Number.isInteger(n) && n >= 1 && n <= 32) || width < farm.width || depth < farm.depth) throw new Error('只支持增大尺寸，不缩小原田或超过 32×32');
  if (width === farm.width && depth === farm.depth) return { expanded: false, reason: '已达到目标尺寸' };
  const plan = planArea(ctx.bot, farm, width, depth);
  if (!plan || !plan.plots.length) return { deferred: true, reason: '扩建区域被占用、未加载或地基不安全' };
  farm.expansions.push({ at: gameClock(ctx.bot), previousWidth: farm.width, previousDepth: farm.depth, width, depth });
  farm.plots.push(...plan.plots); farm.waters.push(...plan.waters); farm.lamps.push(...plan.lamps);
  farm.width = width; farm.depth = depth; farm.status = 'building';
  farm.lastExpansionDay = gameDay(ctx.bot);
  await ctx.checkpoint?.();
  return { expanded: true, ...await tendFarm(ctx) };
}

export async function tendFarm(ctx, { emergency = false } = {}) {
  if (!ctx.state.farm) return ensureFarm(ctx);
  const farm = migrateFarm(ctx.state.farm, ctx.bot);
  const settings = farmSettings(ctx);
  if (farm.dimension !== String(ctx.bot.game.dimension)) return { deferred: true, reason: '农田不在当前维度' };
  walkProfile(ctx.bot);
  if (!emergency) await repairInfrastructure(ctx, farm);
  const before = inspectFarm(ctx.bot, farm);
  if (!farm.harvestSession && (before.unknown === 0 || emergency) && before.mature > 0 && (before.matureRatio >= settings.harvestRatio || emergency)) {
    farm.harvestSession = { id: randomUUID(), startedAt: gameClock(ctx.bot), ratio: before.matureRatio, harvested: 0,
      targets: farm.plots.filter((plot) => {
        const crop = ctx.bot.blockAt(farmPoint(plot.position).offset(0, 1, 0));
        const definition = CROPS.find((entry) => entry.block === crop?.name);
        return definition && Number(crop.getProperties().age) >= definition.age;
      }).map((plot) => key(plot.position)) };
    await ctx.checkpoint?.();
  }
  let planted = 0;
  let harvested = 0;
  const errors = [];
  for (const plot of farm.plots) {
    throwIfAborted(ctx.signal);
    const soil = farmPoint(plot.position);
    try {
      await approach(ctx, soil);
      if (!emergency && !farm.waters.some((entry) => hydratedBy(soil, entry.position) && ctx.bot.blockAt(farmPoint(entry.position))?.name === 'water')) throw new Error('灌溉水源缺失');
      let plant = ctx.bot.blockAt(soil.offset(0, 1, 0));
      if (!plant) throw new Error('地块未加载');
      let existing = CROPS.find((entry) => entry.block === plant.name);
      if (farm.harvestSession?.targets.includes(key(soil))) {
        if (existing && Number(plant.getProperties().age) >= existing.age) {
          if (ctx.bot.inventory.emptySlotCount() < 2) {
            await ctx.storeMaterials?.();
            walkProfile(ctx.bot);
            await approach(ctx, soil);
            if (ctx.bot.inventory.emptySlotCount() < 2) throw new Error('背包空间不足，先保留成熟作物，不让收成散落');
          }
          await digBlock(ctx, plant); await collectDrops(ctx, soil.offset(0, 1, 0), 4);
          if (CROPS.some((entry) => entry.block === ctx.bot.blockAt(soil.offset(0, 1, 0))?.name)) throw new Error('收割未确认');
          harvested++; farm.harvestSession.harvested++;
        }
        farm.harvestSession.targets = farm.harvestSession.targets.filter((id) => id !== key(soil));
        plot.crop = null;
        await ctx.checkpoint?.();
        plant = ctx.bot.blockAt(soil.offset(0, 1, 0));
        existing = CROPS.find((entry) => entry.block === plant?.name);
      }
      if (existing) { plot.crop = existing.block; continue; }
      if (emergency) continue; // 救急只取粮，不让缺水、补灯和重新播种阻塞进食。
      if (!EMPTY.has(plant?.name)) throw new Error(`作物位被 ${plant?.name} 占用`);
      await repairSoil(ctx, soil);
      if (ctx.bot.blockAt(soil)?.name !== 'farmland') {
        await ctx.obtain('stone_hoe', 1); walkProfile(ctx.bot); await approach(ctx, soil);
        if (!['air', 'cave_air'].includes(plant.name)) await digBlock(ctx, plant);
        await ctx.bot.equip(ctx.bot.inventory.items().find((item) => item.name.endsWith('_hoe')), 'hand');
        await ctx.bot.activateBlock(ctx.bot.blockAt(soil), new Vec3(0, 1, 0));
        await sleep(250, ctx.signal);
        if (ctx.bot.blockAt(soil)?.name !== 'farmland') throw new Error('耕地操作未确认');
      }
      const crop = CROPS.filter((entry) => countItem(ctx.bot, entry.seed) > 0).sort((a, b) =>
        farm.plots.filter((entry) => entry.crop === a.block).length - farm.plots.filter((entry) => entry.crop === b.block).length)[0];
      if (!crop) { errors.push('缺少补种材料'); continue; }
      await ctx.bot.equip(ctx.bot.inventory.items().find((item) => item.name === crop.seed), 'hand');
      await ctx.bot.placeBlock(ctx.bot.blockAt(soil), new Vec3(0, 1, 0));
      await sleep(200, ctx.signal);
      if (ctx.bot.blockAt(soil.offset(0, 1, 0))?.name !== crop.block) throw new Error('播种未确认');
      plot.crop = crop.block; planted++;
      await ctx.checkpoint?.();
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      errors.push(`${key(soil)}：${err.message}`);
      if (errors.length >= 8) break;
    }
  }
  if (farm.harvestSession && !farm.harvestSession.targets.length) {
    if (farm.harvestSession.harvested > 0) farm.harvestCycles++;
    farm.lastHarvest = { ...farm.harvestSession, endedAt: gameClock(ctx.bot) }; farm.harvestSession = null;
  }
  farm.lastInspection = inspectFarm(ctx.bot, farm);
  farm.lastTendedAt = Date.now(); farm.lastInspectionTick = gameClock(ctx.bot);
  const incomplete = farm.lastInspection.unknown > 0 || farm.lastInspection.blocked > 0 || farm.lastInspection.damaged > 0;
  farm.status = farm.lastInspection.planted ? errors.length || incomplete ? 'needs_repair' : 'growing' : 'needs_seeds';
  farm.repairErrors = [...new Set(errors)].slice(0, 8);
  await ctx.checkpoint?.();
  return { farm, planted, harvested, report: farm.lastInspection, deferred: errors.length > 0 || incomplete || !farm.lastInspection.planted,
    reason: errors.length ? farm.repairErrors.join('；') : incomplete ? '仍有未加载、被占用或受损地块，保留待复查' : !farm.lastInspection.planted ? '缺少种植材料' : undefined };
}
