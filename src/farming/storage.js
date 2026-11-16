import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, goTo, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { placeBlockAt, expandHouse } from '../autonomy/skills/build.js';
import { listHouseProjects } from '../building/projects.js';
import { leaveHome, reachHome } from '../strategy/navigation.js';
import { farmSettings } from './settings.js';
import { CROPS } from './system.js';
import { foodReservations } from '../supplies/assessment.js';
import { taskBudget } from '../supplies/profiles.js';

const { goals } = pathfinderPkg;
const point = (p) => new Vec3(p.x, p.y, p.z);
const plain = (p) => ({ x: p.x, y: p.y, z: p.z });
const EMPTY = new Set(['air', 'cave_air', 'short_grass', 'fern']);

// 单箱间隔一格，避免双箱合并后把同一容器重复记账；中央始终保留通道。
function shedPlan(storage) {
  const origin = point(storage.origin);
  const depth = Math.ceil(storage.capacity / 2) * 2 + 1;
  const blocks = [];
  for (let x = 0; x < 3; x++) for (let z = 0; z < depth; z++) {
    blocks.push({ position: origin.offset(x, 3, z), item: 'oak_planks' });
  }
  for (const x of [0, 2]) for (const z of [0, depth - 1]) for (let y = 1; y <= 2; y++) {
    blocks.push({ position: origin.offset(x, y, z), item: 'cobblestone' });
  }
  const chests = Array.from({ length: storage.capacity }, (_, i) => origin.offset(i % 2 * 2, 1, Math.floor(i / 2) * 2 + 1));
  return { blocks, chests, depth };
}

function safeShed(bot, storage, resuming) {
  const { blocks, chests, depth } = shedPlan(storage);
  const planned = new Map(blocks.map((entry) => [entry.position.toString(), entry.item]));
  for (const p of chests) planned.set(p.toString(), 'chest');
  const origin = point(storage.origin);
  for (let x = -1; x <= 3; x++) for (let z = -1; z <= depth; z++) for (let y = -1; y <= 3; y++) {
    const p = origin.offset(x, y, z);
    const block = bot.blockAt(p);
    if (!block || ['lava', 'water', 'fire', 'magma_block', 'campfire', 'powder_snow'].includes(block.name)) return false;
    if (x < 0 || x > 2 || z < 0 || z >= depth) continue;
    if (y === -1 && block.boundingBox !== 'block') return false;
    if (y === 0 && !resuming && !['dirt', 'grass_block', 'stone'].includes(block.name)) return false;
    if (y === 0 && resuming && !['dirt', 'grass_block', 'stone', 'cobblestone'].includes(block.name)) return false;
    if (y > 0 && !EMPTY.has(block.name) && !(resuming && (block.name === planned.get(p.toString())
      || x !== 1 && y <= 2 && block.name === 'cobblestone'))) return false;
  }
  return true;
}

async function buildShed(ctx, storage) {
  if (!safeShed(ctx.bot, storage, true)) throw new Error('仓储棚地基、液体或占用检查未通过，保留原建筑');
  const plan = shedPlan(storage);
  // 直接使用自然地基，不额外铺地板；先建低处支柱，再架屋顶。
  const missing = plan.blocks.filter((entry) => ctx.bot.blockAt(entry.position)?.name !== entry.item)
    .sort((a, b) => a.position.y - b.position.y);
  const counts = {};
  for (const entry of missing) counts[entry.item] = (counts[entry.item] ?? 0) + 1;
  for (const [item, count] of Object.entries(counts)) await ctx.obtain(item, count);
  const missingChests = plan.chests.filter((p) => ctx.bot.blockAt(p)?.name !== 'chest').length;
  if (missingChests) await ctx.obtain('chest', missingChests);
  await leaveHome(ctx, ctx.state.home);
  useMovementProfile(ctx.bot, 'safe');
  if (!safeShed(ctx.bot, storage, true)) throw new Error('采集后仓储棚位置已改变');
  for (const entry of missing) { throwIfAborted(ctx.signal); await placeBlockAt(ctx, entry.position, entry.item); }
  for (const p of plan.chests) {
    await placeBlockAt(ctx, p, 'chest');
    if (!storage.chests.some((entry) => point(entry.position).equals(p))) storage.chests.push({ id: randomUUID(), position: plain(p), placedByAgent: true });
    await ctx.checkpoint?.();
  }
  storage.depth = plan.depth;
  storage.status = 'ready';
  await ctx.checkpoint?.();
}

async function homeChests(ctx, storage) {
  const projects = await listHouseProjects(ctx.bot);
  const house = projects.find((project) => project.id === ctx.state.house?.projectId);
  if (!house) throw new Error('室内仓储需要先建成自己的房屋工程');
  const rooms = [{ origin: house.origin, size: house.model.size }, ...house.extensions.filter((entry) => entry.status === 'complete')
    .map((entry) => ({ origin: entry.origin, size: entry.module.size }))];
  for (const room of rooms) for (let x = 1; x < room.size.width - 1; x++) {
    if (x === Math.floor(room.size.width / 2)) continue;
    const p = point(room.origin).offset(x, 1, room.size.depth - 2);
    // 只接管自有工程的既定箱位；不会打开村民或玩家的随机箱子。
    if (ctx.bot.blockAt(p)?.name !== 'chest' || storage.chests.some((entry) => point(entry.position).equals(p))) continue;
    if (storage.chests.length >= storage.capacity) return;
    storage.chests.push({ id: randomUUID(), position: plain(p), projectId: house.id, ownership: 'own_project_slot' });
  }
  storage.projectId = house.id;
  storage.status = storage.chests.length ? 'ready' : 'building';
  await ctx.checkpoint?.();
}

export async function ensureStorage(ctx, { expand = false } = {}) {
  const settings = farmSettings(ctx);
  let storage = ctx.state.storage;
  if (!storage) {
    storage = { id: randomUUID(), mode: settings.storageMode, dimension: String(ctx.bot.game.dimension),
      capacity: settings.storageChests, chests: [], status: 'building' };
    if (storage.mode === 'shed') {
      const anchor = point(ctx.state.farm?.origin || ctx.state.home || ctx.bot.entity.position).floored();
      const candidates = [];
      for (const distance of [6, 10, 14, 18]) for (const [x, z] of [[distance, 0], [-distance, 0], [0, distance], [0, -distance]]) {
        for (let y = -2; y <= 2; y++) candidates.push(anchor.offset(x, y, z));
      }
      const origin = candidates.find((p) => safeShed(ctx.bot, { ...storage, origin: plain(p) }, false));
      if (!origin) throw new Error('农田附近没有落地、无液体且未占用的仓储棚位置');
      storage.origin = plain(origin);
    }
    ctx.state.storage = storage;
    await ctx.checkpoint?.();
  }
  if (storage.dimension !== String(ctx.bot.game.dimension)) throw new Error('仓储不在当前维度');
  if (expand && storage.status !== 'building') {
    if (storage.capacity >= settings.maxStorageChests) return { full: true, reason: '已达到配置的箱子上限' };
    storage.capacity = Math.min(settings.maxStorageChests, storage.capacity + 2);
    storage.status = 'building';
    if (storage.mode === 'home') storage.expansionPending = true;
    await ctx.checkpoint?.();
  }
  if (storage.mode === 'shed') await buildShed(ctx, storage);
  else {
    await reachHome(ctx, ctx.state.home);
    if (storage.expansionPending) {
      // 标记保存到策略状态，房屋工程另有未完成模块档案，取消后接续同一层。
      await homeChests(ctx, storage);
      if (storage.chests.length < storage.capacity) {
        await expandHouse(ctx, { projectId: storage.projectId || ctx.state.house?.projectId, direction: settings.storageDirection });
      }
      storage.expansionPending = false;
      await ctx.checkpoint?.();
    }
    await homeChests(ctx, storage);
    for (const chest of storage.chests) {
      const p = point(chest.position);
      const block = ctx.bot.blockAt(p);
      if (!EMPTY.has(block?.name)) continue;
      if (ctx.bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') throw new Error('室内箱位地板受损，停止补箱');
      await ctx.obtain('chest', 1);
      await reachHome(ctx, ctx.state.home);
      useMovementProfile(ctx.bot, 'safe');
      await placeBlockAt(ctx, p, 'chest');
      chest.replacedAt = Date.now();
      chest.snapshot = null;
      chest.missing = false;
    }
    if (!storage.chests.length) throw new Error('自己的房屋暂时没有可使用的箱位');
  }
  return { storage };
}

function reserveCount(ctx, item) {
  const { bot, state } = ctx;
  if (item.nbt || /_(pickaxe|axe|hoe|shovel|sword|helmet|chestplate|leggings|boots)$/.test(item.name)
    || ['shield', 'bucket', 'water_bucket', 'bed'].includes(item.name) || item.name.endsWith('_bed')) return Infinity;
  const crop = CROPS.find((entry) => entry.seed === item.name);
  if (crop) {
    const assigned = state.farm?.plots.filter((plot) => plot.crop === crop.block).length || 0;
    return Math.max(16, assigned + farmSettings(ctx).expansionStep * Math.min(state.farm?.width || 3, state.farm?.depth || 2), foodReservations(bot, state)[item.name] || 0);
  }
  if (bot.registry.foodsByName[item.name]) return foodReservations(bot, state)[item.name] || 0;
  if (item.name === 'wheat') return 12;
  if (item.name === 'torch') return Math.max(16, taskBudget(bot, state.supplies?.activeTask || {}).torches);
  if (['dirt', 'cobblestone'].includes(item.name) || item.name.endsWith('_planks')) return 32;
  if (item.name.endsWith('_log') || ['coal', 'charcoal', 'stick'].includes(item.name)) return 16;
  return 0;
}

export function hasSurplus(ctx) {
  return ctx.bot.inventory.items().some((item) => countItem(ctx.bot, item.name) > reserveCount(ctx, item));
}

function snapshot(ctx, chest, window, operation) {
  const items = window.containerItems().map((item) => ({ slot: item.slot, name: item.name, count: item.count, metadata: item.metadata }));
  const previous = chest.snapshot;
  chest.lastChange = previous && JSON.stringify(previous) !== JSON.stringify(items) ? operation === 'open' ? 'unexplained_change' : 'change_during_agent_operation' : previous ? 'unchanged' : 'baseline';
  chest.snapshot = items;
  chest.observedAt = Date.now();
  chest.freeSlots = window.slots.slice(0, window.inventoryStart).filter((slot) => !slot).length;
  const memory = ctx.bot.memory;
  if (memory?.enabled && !memory.suspended) {
    const context = memory.context();
    memory.enqueue(() => memory.manager.recordContainerSnapshot(context, { containerId: chest.id, position: chest.position, items, operation }));
  }
}

async function withChest(ctx, chest, work, mode = ctx.state.storage?.mode) {
  throwIfAborted(ctx.signal);
  if (mode === 'home') await reachHome(ctx, ctx.state.home);
  else await leaveHome(ctx, ctx.state.home);
  useMovementProfile(ctx.bot, 'safe');
  const p = point(chest.position);
  await goTo(ctx.bot, new goals.GoalNear(p.x, p.y, p.z, 2), { signal: ctx.signal, timeoutMs: 30000 });
  if (ctx.bot.blockAt(p)?.name !== 'chest') { chest.missing = true; throw new Error('记录的仓储箱已损坏或被替换'); }
  const block = ctx.bot.blockAt(p);
  const properties = block.getProperties();
  const paired = ['left', 'right'].includes(properties.type) && [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    .map((offset) => ctx.bot.blockAt(p.offset(...offset))).find((neighbor) => neighbor?.name === 'chest'
      && neighbor.getProperties().facing === properties.facing && neighbor.getProperties().type !== properties.type
      && ['left', 'right'].includes(neighbor.getProperties().type));
  chest.containerKey = [p.toString(), ...(paired ? [paired.position.toString()] : [])].sort().join('|');
  const window = await ctx.bot.openContainer(ctx.bot.blockAt(p));
  const close = () => window.close();
  ctx.signal.addEventListener('abort', close, { once: true });
  try {
    throwIfAborted(ctx.signal);
    chest.missing = false;
    snapshot(ctx, chest, window, 'open');
    await work(window);
    throwIfAborted(ctx.signal);
    snapshot(ctx, chest, window, 'agent_transfer');
  } finally {
    ctx.signal.removeEventListener('abort', close);
    window.close();
    await ctx.checkpoint?.();
  }
}

export async function visitSupplyChest(ctx, chest, mode, work) {
  return withChest(ctx, chest, work, mode);
}

export async function withdrawVerified(ctx, window, item, count) {
  const before = countItem(ctx.bot, item.name);
  const storedBefore = window.containerItems().filter((entry) => entry.name === item.name).reduce((sum, entry) => sum + entry.count, 0);
  await window.withdraw(item.type, item.metadata, count);
  throwIfAborted(ctx.signal);
  const storedAfter = window.containerItems().filter((entry) => entry.name === item.name).reduce((sum, entry) => sum + entry.count, 0);
  if (countItem(ctx.bot, item.name) - before !== count || storedBefore - storedAfter !== count) throw new Error('出库数量未能核对，停止本次取料');
}

export async function storeSurplus(ctx) {
  ctx.storageBusy = true;
  try {
    await ensureStorage(ctx);
    let deposited = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const chest of ctx.state.storage.chests) {
        await withChest(ctx, chest, async (window) => {
          for (const item of ctx.bot.inventory.items()) {
            throwIfAborted(ctx.signal);
            const count = Math.min(item.count, countItem(ctx.bot, item.name) - reserveCount(ctx, item));
            if (count <= 0) continue;
            const before = countItem(ctx.bot, item.name);
            const stored = window.containerItems().filter((entry) => entry.type === item.type && entry.metadata === item.metadata)
              .reduce((total, entry) => total + entry.count, 0);
            let error;
            try { await window.deposit(item.type, item.metadata, count); } catch (err) { error = err; }
            throwIfAborted(ctx.signal);
            const moved = before - countItem(ctx.bot, item.name);
            const nowStored = window.containerItems().filter((entry) => entry.type === item.type && entry.metadata === item.metadata)
              .reduce((total, entry) => total + entry.count, 0);
            if (moved < 0 || nowStored - stored !== moved) throw new Error('箱子转存数量未能核对，暂停并保留现场快照');
            deposited += moved;
            if (error && !/full|space|destination/i.test(error.message)) throw error;
          }
        });
      }
      if (!hasSurplus(ctx)) break;
      // 一次维护最多增建一段，避免为了无限库存不再照顾生存。
      if (pass === 0) {
        const result = await ensureStorage(ctx, { expand: true });
        if (result.full) break;
      }
    }
    ctx.state.storage.lastStoredAt = Date.now();
    ctx.state.storage.full = hasSurplus(ctx);
    await ctx.checkpoint?.();
    return { deposited, full: ctx.state.storage.full };
  } finally { ctx.storageBusy = false; }
}

export async function retrieveMaterials(ctx, itemName, required) {
  if (ctx.storageBusy || !ctx.state.storage?.chests.length || ctx.state.storage.dimension !== String(ctx.bot.game.dimension)) return;
  ctx.storageBusy = true;
  try {
    for (const chest of ctx.state.storage.chests) {
      if (countItem(ctx.bot, itemName) >= required) break;
      if (chest.snapshot && Date.now() - chest.observedAt < 60000 && !chest.snapshot.some((item) => item.name === itemName && item.count > 0)) continue;
      await withChest(ctx, chest, async (window) => {
        for (const item of window.containerItems().filter((entry) => entry.name === itemName && !entry.nbt)) {
          throwIfAborted(ctx.signal);
          const count = Math.min(item.count, required - countItem(ctx.bot, itemName));
          if (count <= 0) break;
          await withdrawVerified(ctx, window, item, count);
        }
      });
    }
  } finally { ctx.storageBusy = false; }
}
