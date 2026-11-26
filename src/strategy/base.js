import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, craftVerified, goTo, sleep, throwIfAborted, useMovementProfile, indoorRoomStepCost } from '../actions/helpers.js';
import { placeBlockAt } from '../autonomy/skills/build.js';
import { listHouseProjects, projectShellPlan } from '../building/projects.js';
import { isNight } from '../autonomy/skills/sleep.js';
import { attackUntilDead, collectDrops } from '../autonomy/skills/world.js';
import { reachHome, leaveHome } from './navigation.js';
import { ensureStorage, refreshStorage, storeSurplus, retrieveMaterials, visitSupplyChest } from '../farming/storage.js';
import { developmentSettings } from './development.js';
import { digBlock } from '../autonomy/skills/mine.js';

const { goals } = pathfinderPkg;
const point = (p) => new Vec3(p.x, p.y, p.z);
const plain = (p) => ({ x: p.x, y: p.y, z: p.z });
const EMPTY = new Set(['air', 'cave_air']);

// Only soft terrain occupying an exact cell of the registered house shell may
// be repaired. Furniture, unknown blocks and liquid/gravity hazards stay intact.
export function repairableShellTerrain(bot, position) {
  const block = bot.blockAt(position);
  if (!['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt'].includes(block?.name)) return false;
  const feet = bot.entity.position.floored();
  if (position.x === feet.x && position.z === feet.z && position.y <= feet.y) return false;
  return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].every((offset) => {
    const neighbor = bot.blockAt(position.offset(...offset));
    return neighbor && !['water', 'lava', 'sand', 'red_sand', 'gravel', 'fire', 'soul_fire'].includes(neighbor.name);
  });
}

async function homeLayout(ctx) {
  if (ctx.state.house) {
    const project = (await listHouseProjects(ctx.bot)).find((entry) => entry.id === ctx.state.house.projectId);
    if (!project || project.status !== 'complete') throw new Error('房屋工程尚未完成');
    const origin = point(project.origin);
    const { width, depth } = project.model.size;
    const cells = [];
    for (let x = 1; x < width - 1; x++) for (let z = 1; z < depth - 1; z++) cells.push(origin.offset(x, 1, z));
    return { cells, origin, project, bedCells: cells.filter((p) => p.x < origin.x + Math.floor(width / 2) && p.z >= origin.z + 2) };
  }
  const site = ctx.state.plannedShelter;
  if (!site) throw new Error('缺少自有山洞布局记录，无法确认家具位置');
  const entrance = point(site.entrance);
  const at = (depth, side) => entrance.offset(site.direction.x * depth + site.lateral.x * side, 0,
    site.direction.z * depth + site.lateral.z * side);
  const cells = [];
  for (let depth = 1; depth < 4; depth++) for (let side = -1; side <= 1; side++) cells.push(at(depth, side));
  return { cells, bedCells: [at(1, 1), at(2, 1)], chest: at(1, -1), table: at(3, 1), furnace: at(3, -1) };
}

export function archiveStorage(state) {
  if (!state.storage) return;
  state.archivedStorage ??= [];
  if (!state.archivedStorage.some((entry) => entry.id === state.storage.id)) {
    const storage = state.storage;
    if (state.home?.kind === 'house' && state.house) state.home.projectId ??= state.house.projectId;
    storage.home ??= structuredClone(state.home);
    for (const chest of storage.chests) chest.home ??= structuredClone(storage.home);
    state.archivedStorage.push(storage);
  }
  state.storage = null;
}

export async function collectNearbyWool(ctx) {
  const { bot } = ctx;
  const wool = bot.inventory.items().filter((item) => item.name.endsWith('_wool'));
  if (wool.some((item) => countItem(bot, item.name) >= 3)) return;
  // 起步时只收集附近安全的羊，每步处理一只，夜幕和危险可正常打断。
  const sheep = bot.nearestEntity((entity) => entity.name === 'sheep' && entity.position.distanceTo(bot.entity.position) <= 32
    && !Object.values(bot.entities).some((enemy) => enemy.type === 'hostile' && enemy.position.distanceTo(entity.position) < 16));
  if (!sheep) throw new Error('附近暂时没有安全可收集羊毛的羊');
  await leaveHome(ctx, ctx.state.home);
  useMovementProfile(bot, 'free');
  const position = await attackUntilDead(ctx, sheep);
  await collectDrops(ctx, position, 5);
}

async function bedItem(ctx, acquire) {
  const { bot } = ctx;
  let item = bot.inventory.items().find((entry) => entry.name.endsWith('_bed'));
  if (item) return item;
  for (const storage of [ctx.state.storage, ...(ctx.state.archivedStorage || [])].filter(Boolean)) {
    const names = new Set(storage.chests.flatMap((chest) => (chest.snapshot || []).map((entry) => entry.name))
      .filter((name) => name.endsWith('_wool')));
    for (const name of names) await retrieveMaterials(ctx, name, 3);
  }
  let wool = bot.inventory.items().find((entry) => entry.name.endsWith('_wool') && countItem(bot, entry.name) >= 3);
  if (!wool && acquire) {
    await collectNearbyWool(ctx);
    wool = bot.inventory.items().find((entry) => entry.name.endsWith('_wool') && countItem(bot, entry.name) >= 3);
  }
  if (!wool) return null;
  await ctx.obtain(wool.name.replace('_wool', '_bed'), 1);
  item = bot.inventory.items().find((entry) => entry.name.endsWith('_bed'));
  return item;
}

async function ensurePermanentBed(ctx, layout, acquire, insideOnly = false) {
  const { bot, state } = ctx;
  const existing = layout.bedCells.map((p) => bot.blockAt(p)).find((block) => block?.name.endsWith('_bed'));
  if (existing) { state.home.bed = plain(existing.position); return existing; }
  state.home.respawnConfirmed = false;
  const item = await bedItem(ctx, acquire);
  if (!item) return null;
  if (!insideOnly) await reachHome(ctx, state.home);
  const cells = new Set(layout.bedCells.map((p) => p.toString()));
  for (const foot of layout.bedCells) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const head = foot.offset(dx, 0, dz);
    if (!cells.has(head.toString())) continue;
    if (![foot, head].every((p) => EMPTY.has(bot.blockAt(p)?.name)
      && EMPTY.has(bot.blockAt(p.offset(0, 1, 0))?.name)
      && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block')) continue;
    baseMovement(ctx, layout, insideOnly);
    await goTo(bot, new goals.GoalNear(foot.x, foot.y, foot.z, 2), { signal: ctx.signal, timeoutMs: 15000 });
    await bot.equip(item, 'hand');
    await bot.look(Math.atan2(-dx, -dz), 0, true);
    await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0)), new Vec3(0, 1, 0));
    await sleep(300, ctx.signal);
    if (![foot, head].every((p) => bot.blockAt(p)?.name === item.name)) throw new Error('永久床的两半未确认，保留现场等待复查');
    state.home.bed = plain(foot);
    await ctx.checkpoint?.();
    return bot.blockAt(foot);
  }
  throw new Error('自有住所内缺少连续两格的安全床位');
}

export async function sleepAtHome(ctx) {
  const { bot, state } = ctx;
  if (!state.home?.bed || !isNight(bot)) return false;
  if (!['overworld', 'minecraft:overworld'].includes(String(bot.game.dimension))) return false;
  const bed = bot.blockAt(point(state.home.bed));
  if (!bed?.name.endsWith('_bed')) { state.home.respawnConfirmed = false; return false; }
  useMovementProfile(bot, 'safe');
  await goTo(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), { signal: ctx.signal, timeoutMs: 15000 });
  await bot.sleep(bed);
  state.home.respawnConfirmed = true;
  state.home.respawnConfirmedAt = Date.now();
  await ctx.checkpoint?.();
  try {
    // 多人服可能需要其他玩家睡觉，按短周期返回策略复查。
    for (let i = 0; i < 10 && bot.isSleeping; i++) await sleep(1000, ctx.signal);
  } finally {
    if (ctx.signal.aborted && bot.isSleeping) await bot.wake().catch(() => {});
  }
  return true;
}

const SOFT_SHELL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt']);
const SHELL_HAZARDS = new Set(['water', 'lava', 'sand', 'red_sand', 'gravel', 'fire', 'soul_fire',
  'magma_block', 'campfire', 'soul_campfire', 'powder_snow']);
const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const ITEM_LABELS = { furnace: '熔炉', crafting_table: '工作台', chest: '箱子', torch: '火把', bed: '床',
  cobblestone: '圆石', oak_planks: '橡木木板', glass: '玻璃', oak_door: '橡木门' };
const itemLabel = (item) => ITEM_LABELS[item] || item;

function unsafeBase(reason) {
  const error = new Error(reason);
  error.fatal = true;
  error.code = 'BASE_UNSAFE';
  return error;
}

function checkHomeSafety(ctx) {
  const { bot, state } = ctx;
  const door = state.home.door && bot.blockAt(point(state.home.door));
  if (!door?.name.endsWith('_door') || door.name.startsWith('iron_')) throw unsafeBase('住所木门缺失或改变');
  const floor = point(state.home);
  const below = bot.blockAt(floor.offset(0, -1, 0));
  if (below?.boundingBox !== 'block' || SHELL_HAZARDS.has(below.name)
    || bot.blockAt(floor.offset(0, 1, 0))?.boundingBox !== 'empty') {
    throw unsafeBase('住所站位地板或头部空间不安全');
  }
}

// Closed solid soil is a usable temporary shell, never a reason to dig a
// load-bearing floor/wall. Keep the exact material difference for later review.
function temporaryShell(bot, p, block) {
  if (!SOFT_SHELL.has(block?.name) || block.boundingBox !== 'block') return false;
  const neighbors = NEIGHBORS.map((offset) => bot.blockAt(p.offset(...offset)));
  return neighbors.every((neighbor) => neighbor && !SHELL_HAZARDS.has(neighbor.name))
    && neighbors.some((neighbor, i) => i !== 2 && neighbor.boundingBox === 'block');
}

function baseMovement(ctx, layout, insideOnly) {
  useMovementProfile(ctx.bot, 'safe');
  if (!insideOnly) return;
  ctx.bot.pathfinder.movements.exclusionAreasStep.push((block) =>
    indoorRoomStepCost(block.position, { origin: layout.origin, size: layout.project.model.size }));
}

async function ensurePermanentBase(ctx, layout, { availableOnly = false } = {}) {
  const { bot, state } = ctx;
  ctx.stage?.({ title: '完善基地', steps: ['核对外壳', '安装设施', '核验仓储'], current: 0 });
  const settings = developmentSettings(bot, state);
  if (ctx.project?.kind === 'house') settings.homeChests = ctx.project.options.chests;
  const projectId = state.house.projectId;
  if (state.base?.projectId !== projectId) state.base = { projectId, ready: false };
  const base = state.base;
  base.ready = false;
  base.jobs ??= {};
  const jobs = base.jobs;
  const active = new Set();
  const tasks = [];
  const observe = (id, complete, reason, detail = {}) => {
    active.add(id);
    const old = jobs[id];
    const kind = id.split(':')[0];
    const label = kind === 'shell' ? '外壳检查' : kind === 'material' ? `准备${itemLabel(detail.item || 'bed')}`
      : kind === 'storage-check' ? '箱子可用性核验' : kind === 'shell-review' ? '外壳封闭复核' : kind === 'light' ? '室内照明'
        : kind === 'storage-layout' ? '仓储扩建' : itemLabel(kind);
    return jobs[id] = { ...old, attempts: old?.attempts || 0, ...detail,
      label,
      status: complete ? 'done' : old?.status === 'failed' ? 'failed' : 'pending',
      reason: complete ? null : old?.status === 'failed' ? old.reason : reason,
      retryAt: complete ? 0 : old?.retryAt || 0, checkedAt: Date.now() };
  };
  const task = (id, check, run, reason, detail = {}) => {
    observe(id, check(), reason, detail);
    tasks.push({ id, check, run, ...detail });
  };
  state.home.projectId = projectId;
  checkHomeSafety(ctx);
  const gaps = [];
  for (const entry of projectShellPlan(layout.project)) {
    const p = layout.origin.offset(...entry.offset);
    const shaft = layout.project.verticalAccess;
    const [x, y, z] = entry.offset;
    if (shaft && p.x === shaft.x && p.z === shaft.z) continue;
    if (x === Math.floor(layout.project.model.size.width / 2) && z === layout.project.model.size.depth - 1
      && [1, 2].includes(y) && layout.project.extensions?.some((extension) => extension.module.direction === 'back')) continue;
    const id = `shell:${p.x},${p.y},${p.z}`;
    const current = bot.blockAt(p);
    const detail = { position: plain(p), item: entry.item, targetItem: entry.targetItem || entry.item };
    if (entry.acceptedItems.includes(current?.name)) observe(id, true, null, detail);
    else if (!entry.allowDoor && temporaryShell(bot, p, current)) {
      observe(id, false, '封闭软土保留承重，材质替换待安全装修', detail);
      Object.assign(jobs[id], { status: 'finishing', actualItem: current.name, retryAt: 0,
        reason: '封闭软土保留承重，材质替换待安全装修' });
    } else if (EMPTY.has(current?.name)) {
      observe(id, false, '房屋外壳存在真实缺口，先封闭后安装设施', detail);
      gaps.push({ id, p, entry });
    } else {
      observe(id, false, `房屋外壳不安全或未知占用：${current?.name || '未加载'}`, detail);
      jobs[id].status = 'failed';
      throw unsafeBase(`房屋外壳 ${p} 不安全或未知占用 ${current?.name || '未加载'}，保留现场`);
    }
  }
  base.finishing = Object.keys(jobs).filter((id) => active.has(id) && jobs[id].status === 'finishing');
  const deadline = Date.now() + 40000;
  let operations = 0;
  let acquired = false;
  // Use the SAME ctx: the strategy's obtain closure captures it. Replacing it
  // with a spread copy would leave material gathering on the unbounded signal.
  const attempt = async (id, run, check) => {
    const job = jobs[id];
    if (operations >= 6 || Date.now() >= deadline || job.retryAt > Date.now()) return false;
    throwIfAborted(ctx.signal);
    const parentSignal = ctx.signal;
    const budget = new AbortController();
    ctx.signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), budget.signal]);
    const timer = setTimeout(() => budget.abort('基地局部工作达到本轮时间预算'), Math.min(10000, deadline - Date.now()));
    operations++;
    job.attempts++;
    const previousReason = job.reason;
    const wasFailed = job.status === 'failed';
    try {
      await run();
      throwIfAborted(parentSignal);
      if (!check()) throw new Error('操作返回后尚未在现场确认完成');
      Object.assign(job, { status: 'done', reason: null, retryAt: 0 });
      if (wasFailed) bot.emit?.('agentIncident', { type: 'resolved', goal: job.label, reason: previousReason,
        solution: '逐项重试', result: '已按现场状态核验' });
      return true;
    } catch (error) {
      throwIfAborted(parentSignal);
      if (error.fatal || ['DangerError', 'SafetyError'].includes(error.name)
        || error.name === 'AbortError' && !budget.signal.aborted) throw error;
      Object.assign(job, { status: 'failed', reason: budget.signal.aborted ? String(budget.signal.reason) : error.message,
        retryAt: Date.now() + Math.min(60000, 10000 * job.attempts) });
      if (!wasFailed || previousReason !== job.reason) bot.emit?.('agentIncident', {
        type: 'failure', goal: job.label, reason: job.reason, result: '暂缓该项，继续可执行工作' });
      ctx.log?.(`${job.label} 暂缓：${job.reason}`);
      return false;
    } finally {
      clearTimeout(timer);
      ctx.signal = parentSignal;
      job.checkedAt = Date.now();
      await ctx.checkpoint?.();
    }
  };
  const acquire = async (item) => {
    const id = `material:${item}`;
    observe(id, countItem(bot, item) > 0, `缺少${itemLabel(item)}，等待逐步取料`, { item });
    if (countItem(bot, item) > 0) return true;
    if (availableOnly || acquired || operations >= 6 || Date.now() >= deadline || jobs[id].retryAt > Date.now()) {
      return false;
    }
    acquired = true;
    return attempt(id, async () => { await ctx.obtain(item, 1); }, () => countItem(bot, item) > 0);
  };
  const place = async (p, item, options) => {
    if (!availableOnly) await reachHome(ctx, state.home);
    checkHomeSafety(ctx);
    const below = bot.blockAt(p.offset(0, -1, 0));
    if (below?.boundingBox !== 'block' || SHELL_HAZARDS.has(below.name)) throw unsafeBase(`设施 ${p} 地板不安全`);
    if (!EMPTY.has(bot.blockAt(p)?.name)) throw new Error(`设施预留位 ${p} 被占用，保留现有方块`);
    baseMovement(ctx, layout, availableOnly);
    await placeBlockAt(ctx, p, item, options);
  };
  if (gaps.length) {
    if (!availableOnly) {
      for (const { id, p, entry } of gaps) {
        if (jobs[id].retryAt > Date.now()) continue;
        if (!countItem(bot, entry.item) && !await acquire(entry.item)) {
          jobs[id].retryAt = jobs[`material:${entry.item}`].retryAt || 0;
          continue;
        }
        await attempt(id, async () => {
          await reachHome(ctx, state.home);
          useMovementProfile(bot, 'safe');
          // Only fill air. Never open a wall for a cosmetic replacement.
          if (!EMPTY.has(bot.blockAt(p)?.name)) throw unsafeBase('房屋缺口现场已改变');
          await placeBlockAt(ctx, p, entry.item, { allowDoor: entry.allowDoor });
        }, () => entry.acceptedItems.includes(bot.blockAt(p)?.name));
      }
    }
    // A round repairing a real breach does not also furnish the exposed room.
  } else {
    if (state.storage?.projectId !== projectId || state.storage?.mode !== 'home') archiveStorage(state);
    state.farmConfig ??= {};
    state.farmConfig.storageMode = 'home';
    state.farmConfig.storageChests = Math.max(settings.homeChests, state.farmConfig.storageChests || 0);
    state.farmConfig.maxStorageChests = Math.max(state.farmConfig.storageChests, state.farmConfig.maxStorageChests || 12);
    state.storage ??= { id: randomUUID(), mode: 'home', projectId, home: structuredClone(state.home),
      dimension: String(bot.game.dimension), capacity: settings.homeChests, chests: [], status: 'building' };
    const storage = state.storage;
    if (storage.dimension !== String(bot.game.dimension)) throw unsafeBase('仓储不在当前维度');
    storage.capacity = Math.max(storage.capacity || 0, settings.homeChests);
    const { width, depth } = layout.project.model.size;
    const furnaces = ctx.project?.kind === 'house' ? ctx.project.options.furnaces : Math.max(1, layout.project.model.furniture.furnaces);
    // Inventory pass comes before ANY material acquisition, furnace first.
    const slots = [{ p: layout.origin.offset(width - 2, 1, 1), item: 'furnace' },
      { p: layout.origin.offset(1, 1, 1), item: 'crafting_table' }];
    const rooms = [{ origin: layout.project.origin, size: layout.project.model.size },
      ...(layout.project.extensions || []).filter((entry) => entry.status === 'complete')
        .map((entry) => ({ origin: entry.origin, size: entry.module.size }))];
    for (const room of rooms) for (let x = 1; x < room.size.width - 1; x++) {
      if (x === Math.floor(room.size.width / 2) || storage.chests.length >= storage.capacity) continue;
      const p = point(room.origin).offset(x, 1, room.size.depth - 2);
      if (!storage.chests.some((chest) => point(chest.position).equals(p))) storage.chests.push({
        id: randomUUID(), position: plain(p), home: structuredClone(state.home), projectId, ownership: 'own_project_slot' });
    }
    for (const chest of storage.chests) slots.push({ p: point(chest.position), item: 'chest' });
    for (let z = 2; z <= Math.min(furnaces, depth - 3); z++) {
      slots.push({ p: layout.origin.offset(width - 2, 1, z), item: 'furnace' });
    }
    for (const { p, item } of slots) {
      task(`${item}:${p.x},${p.y},${p.z}`, () => bot.blockAt(p)?.name === item,
        () => place(p, item), `等待安装${itemLabel(item)}`, { item, position: plain(p) });
    }
    if (storage.chests.length < storage.capacity) task('storage-layout', () => storage.chests.length >= storage.capacity,
      async () => { await ensureStorage(ctx); }, '现有自有房间箱位不足，需要继续扩建');
    const lit = () => layout.cells.some((p) => [p, p.offset(0, 1, 0)].some((q) =>
      ['torch', 'wall_torch'].includes(bot.blockAt(q)?.name)));
    task('light', lit, async () => {
      const p = layout.cells.find((p) => EMPTY.has(bot.blockAt(p)?.name)
        && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block' && !layout.bedCells.some((q) => q.equals(p)));
      if (!p) throw new Error('住所没有安全照明位置');
      await place(p, 'torch');
    }, '等待安装住所照明', { item: 'torch' });
    const bedPresent = () => {
      const bed = layout.bedCells.map((p) => bot.blockAt(p)).find((block) => block?.name.endsWith('_bed')
        && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
          bot.blockAt(block.position.offset(dx, 0, dz))?.name === block.name));
      if (bed) state.home.bed = plain(bed.position);
      else { delete state.home.bed; state.home.respawnConfirmed = false; }
      return Boolean(bed);
    };
    task('bed', bedPresent, async () => { await ensurePermanentBed(ctx, layout, false, availableOnly); }, '等待安全双格床位与现成床');
    // Recipes the server accepts directly from the bag need no trip or nearby
    // workstation. Run them while sheltered, then install in the normal pass.
    if (availableOnly && bot.recipesFor) {
      const tableJob = tasks.find(entry => entry.item === 'crafting_table');
      const tableId = bot.registry.itemsByName.crafting_table?.id;
      if (tableJob && tableId != null && !tableJob.check() && !countItem(bot, 'crafting_table')) {
        const findRecipe = () => bot.recipesFor(tableId, null, 1)[0];
        if (findRecipe()) {
          const id = 'material:crafting_table';
          observe(id, false, '用随身木板在屋内合成工作台', { item: 'crafting_table' });
          await attempt(id, () => craftVerified(bot, 'crafting_table', findRecipe, 1, null, ctx.signal),
            () => countItem(bot, 'crafting_table') > 0);
        }
      }
    }
    ctx.stage?.({ title: '完善基地', steps: ['核对外壳', '安装设施', '核验仓储'], current: 1 });
    for (const entry of tasks) {
      if (jobs[entry.id].status === 'done') continue;
      const supplied = entry.item ? countItem(bot, entry.item) > 0
        : entry.id === 'bed' && bot.inventory.items().some((item) => item.name.endsWith('_bed'));
      if (supplied) {
        if (jobs[entry.id].waitingMaterial) jobs[entry.id].retryAt = 0;
        jobs[entry.id].waitingMaterial = false;
        await attempt(entry.id, entry.run, entry.check);
      }
    }
    if (!availableOnly) for (const entry of tasks) {
      if (jobs[entry.id].status === 'done' || jobs[entry.id].retryAt > Date.now()) continue;
      if (entry.item && !countItem(bot, entry.item)) {
        if (!await acquire(entry.item)) {
          Object.assign(jobs[entry.id], { waitingMaterial: true,
            reason: jobs[`material:${entry.item}`].reason || `缺少${itemLabel(entry.item)}`,
            retryAt: jobs[`material:${entry.item}`].retryAt || 0 });
          continue;
        }
      } else if (entry.id === 'bed' && !bot.inventory.items().some((item) => item.name.endsWith('_bed'))) {
        observe('material:bed', false, '等待同色羊毛与床材料');
        if (!acquired) {
          acquired = true;
          await attempt('material:bed', async () => { await bedItem(ctx, true); },
            () => bot.inventory.items().some((item) => item.name.endsWith('_bed')));
        }
        if (!bot.inventory.items().some((item) => item.name.endsWith('_bed'))) {
          Object.assign(jobs.bed, { waitingMaterial: true, reason: jobs['material:bed'].reason,
            retryAt: jobs['material:bed'].retryAt || 0 });
          continue;
        }
      }
      await attempt(entry.id, entry.run, entry.check);
    }
    storage.status = storage.chests.length >= storage.capacity
      && storage.chests.every((chest) => bot.blockAt(point(chest.position))?.name === 'chest') ? 'ready' : 'building';
    // Opening a missing box or storing surplus would re-enter the old all-or-
    // nothing ensureStorage loop. Verify each real container independently.
    if (!availableOnly) ctx.stage?.({ title: '完善基地', steps: ['核对外壳', '安装设施', '核验仓储'], current: 2 });
    for (const chest of storage.chests) {
      if (bot.blockAt(point(chest.position))?.name !== 'chest') continue;
      const id = `storage-check:${chest.id}`;
      observe(id, !chest.verificationError && !chest.missing && Date.now() - (chest.observedAt || 0) < 120000,
        '等待开箱核验可用仓储');
      if (!availableOnly && jobs[id].status !== 'done') await attempt(id,
        () => visitSupplyChest(ctx, chest, 'home', async () => {}),
        () => !chest.verificationError && !chest.missing && Date.now() - (chest.observedAt || 0) < 120000);
    }
  }
  throwIfAborted(ctx.signal);
  if (gaps.length && gaps.every(({ id }) => jobs[id].status === 'done')) {
    observe('shell-review', false, '外壳缺口已封闭，下一轮复核后继续安装设施');
  }
  for (const id of Object.keys(jobs)) if (!active.has(id) && !id.startsWith('material:')) delete jobs[id];
  // Keep failed material history while its dependent task is cooling down.
  // Consumed material is not a separate requirement after installation.
  for (const id of Object.keys(jobs).filter((id) => id.startsWith('material:'))) {
    const needed = id === 'material:bed' ? jobs.bed && jobs.bed.status !== 'done'
      : Object.entries(jobs).some(([other, job]) => !other.startsWith('material:')
        && job.item === jobs[id].item && !['done', 'finishing'].includes(job.status));
    if (!needed) delete jobs[id];
  }
  const pending = Object.entries(jobs).filter(([, job]) => !['done', 'finishing'].includes(job.status));
  base.ready = !gaps.length && pending.length === 0;
  base.checkedAt = Date.now();
  if (base.ready) {
    base.bed = state.home.bed;
    state.workshop = { ...plain(layout.cells.find((p) => bot.blockAt(p)?.name === 'furnace')), dimension: String(bot.game.dimension) };
    state.storage.lastVerifiedAt = Date.now();
  }
  const nextEntry = pending.sort((a, b) => (a[1].retryAt || 0) - (b[1].retryAt || 0))[0];
  const retryAt = nextEntry ? nextEntry[1].retryAt > Date.now() ? nextEntry[1].retryAt : 0 : 0;
  const next = nextEntry ? { id: nextEntry[0], label: nextEntry[1].label, reason: nextEntry[1].reason } : null;
  const productionJobs = Object.entries(jobs).filter(([id]) => !id.startsWith('shell:') && !id.startsWith('material:'));
  base.summary = { completed: productionJobs.filter(([, job]) => job.status === 'done').length,
    total: productionJobs.length, finishing: base.finishing.length };
  const result = { ready: base.ready, pending: !base.ready, deferred: !base.ready,
    retryAt, reason: next?.reason || null, next, jobs, summary: base.summary };
  Object.assign(base, { retryAt, next });
  ctx.log?.(base.ready ? `基地必需设施已逐项核验，装修待办 ${base.finishing.length} 项`
    : `设施与仓储核验 ${base.summary.completed}/${base.summary.total} 项；${next?.label}：${next?.reason}`);
  await ctx.checkpoint?.();
  return result;
}

export async function ensureBase(ctx, { permanent = false, availableOnly = false } = {}) {
  const { bot, state } = ctx;
  throwIfAborted(ctx.signal);
  if (!availableOnly) await reachHome(ctx, state.home);
  else if (!permanent || !state.home || !state.house) throw unsafeBase('仅已确认的正式住所支持夜间现有物资安装');
  const layout = await homeLayout(ctx);
  if (availableOnly) {
    const feet = bot.entity.position.floored();
    const { width, depth } = layout.project.model.size;
    if (feet.y !== layout.origin.y + 1 || feet.x <= layout.origin.x || feet.x >= layout.origin.x + width - 1
      || feet.z <= layout.origin.z || feet.z >= layout.origin.z + depth - 1) throw unsafeBase('现有物资安装要求已经位于自有房屋内');
  }
  if (permanent) return ensurePermanentBase(ctx, layout, { availableOnly });
  if (!permanent) {
    // 寻路施工可能留下垫脚土石，恢复已登记洞室的家具空间。
    const debris = new Set(['dirt', 'grass_block', 'cobblestone', 'stone', 'deepslate', 'granite', 'diorite', 'andesite']);
    useMovementProfile(bot, 'safe');
    for (const cell of layout.cells) for (const dy of [1, 0]) {
      const block = bot.blockAt(cell.offset(0, dy, 0));
      if (block && debris.has(block.name)) await digBlock(ctx, block);
    }
    const site = state.plannedShelter;
    const passage = point(site.entrance).offset(site.direction.x, 0, site.direction.z);
    const obstruction = bot.blockAt(passage);
    if (obstruction?.name === 'crafting_table' && !passage.equals(layout.table)) {
      await digBlock(ctx, obstruction);
      await ctx.obtain('crafting_table', 1);
      await placeBlockAt(ctx, layout.table, 'crafting_table');
      ctx.log('工作台已移到洞室侧面，入口通道恢复');
    }
    if (!state.storage?.earlyCamp) {
      archiveStorage(state);
      state.storage = { id: randomUUID(), mode: 'home', earlyCamp: true, home: structuredClone(state.home),
        dimension: String(bot.game.dimension), capacity: 1, chests: [{ id: randomUUID(), position: plain(layout.chest),
          home: structuredClone(state.home), placedByAgent: true }], status: 'building' };
      await ctx.checkpoint?.();
    }
    if (bot.blockAt(layout.chest)?.name !== 'chest') {
      await ctx.obtain('chest', 1);
      await reachHome(ctx, state.home);
      await placeBlockAt(ctx, layout.chest, 'chest');
    }
    state.storage.status = 'ready';
  }
  const entrance = state.home.door && bot.blockAt(point(state.home.door));
  if (!entrance?.name.endsWith('_door') || entrance.name.startsWith('iron_')) throw new Error('住所木门缺失或改变');
  const floor = point(state.home);
  if (bot.blockAt(floor.offset(0, -1, 0))?.boundingBox !== 'block'
    || bot.blockAt(floor.offset(0, 1, 0))?.boundingBox !== 'empty') throw new Error('住所站位地板或头部空间不安全');
  if (!layout.cells.some((p) => ['torch', 'wall_torch'].includes(bot.blockAt(p)?.name)
    || ['torch', 'wall_torch'].includes(bot.blockAt(p.offset(0, 1, 0))?.name))) {
    await ctx.obtain('torch', 1);
    await reachHome(ctx, state.home);
    const light = layout.cells.find((p) => EMPTY.has(bot.blockAt(p)?.name)
      && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block' && !layout.bedCells.some((q) => q.equals(p)));
    if (!light) throw new Error('住所没有安全照明位置');
    await placeBlockAt(ctx, light, 'torch');
  }
  const bed = await ensurePermanentBed(ctx, layout, permanent);
  await refreshStorage(ctx);
  await storeSurplus(ctx);
  if (bed && isNight(bot)) await sleepAtHome(ctx);
  state.home.campReady = true;
  await ctx.checkpoint?.();
}
