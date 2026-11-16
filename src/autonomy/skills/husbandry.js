import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { countItem, goTo, sleep, throwIfAborted, useMovementProfile } from '../../actions/helpers.js';
import { placeBlockAt } from './build.js';
import { digBlock } from './mine.js';

const { goals } = pathfinderPkg;
const SPECIES = { chicken: 'wheat_seeds', cow: 'wheat', sheep: 'wheat' };
const SOIL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol']);
const AIR = new Set(['air', 'cave_air', 'short_grass', 'fern']);
const plain = (p) => ({ x: p.x, y: p.y, z: p.z });
const position = (p) => new Vec3(p.x, p.y, p.z);

export function insidePasture(pasture, location) {
  const { x, y, z } = pasture.origin;
  return location.x > x + 0.8 && location.x < x + 4.2 && location.z > z + 0.8
    && location.z < z + 4.2 && location.y >= y - 0.5 && location.y <= y + 2;
}

function findSite(bot, anchor) {
  const center = position(anchor).floored();
  for (let dx = -20; dx <= 20; dx += 4) {
    for (let dz = -20; dz <= 20; dz += 4) {
      if (Math.abs(dx) < 8 && Math.abs(dz) < 8) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const origin = center.offset(dx, dy, dz);
        let valid = true;
        for (let x = -1; x <= 5 && valid; x++) {
          for (let z = -2; z <= 5 && valid; z++) {
            const p = origin.offset(x, 0, z);
            valid = SOIL.has(bot.blockAt(p.offset(0, -1, 0))?.name)
              && bot.blockAt(p.offset(0, -2, 0))?.boundingBox === 'block'
              && AIR.has(bot.blockAt(p)?.name) && AIR.has(bot.blockAt(p.offset(0, 1, 0))?.name);
          }
        }
        if (valid) return origin;
      }
    }
  }
  return null;
}

function wildCandidate(bot, entity, pastures) {
  if (!SPECIES[entity.name] || entity.position.distanceTo(bot.entity.position) > 32) return false;
  if (pastures.some((pasture) => insidePasture(pasture, entity.position))) return false;
  const keys = bot.registry.entitiesByName[entity.name]?.metadataKeys ?? [];
  if (entity.metadata?.[keys.indexOf('custom_name')]) return false;
  const fences = Object.values(bot.registry.blocksByName).filter((block) => block.name.endsWith('_fence') || block.name.endsWith('_fence_gate')).map((block) => block.id);
  return !bot.findBlock({ point: entity.position, matching: fences, maxDistance: 4 });
}

async function gateState(ctx, pasture, open) {
  const gate = position(pasture.gate);
  await goTo(ctx.bot, new goals.GoalNear(gate.x, gate.y, gate.z, 2), { signal: ctx.signal, timeoutMs: 15000 });
  const block = ctx.bot.blockAt(gate);
  if (block?.name !== 'oak_fence_gate') throw new Error('牧场门已改变或未加载，不能确认围栏封闭');
  if (block.getProperties().open !== open) {
    await ctx.bot.activateBlock(block);
    await sleep(250, ctx.signal);
  }
  if (ctx.bot.blockAt(gate)?.getProperties().open !== open) throw new Error('牧场门开关未得到确认');
  pasture.needsGateClosure = open;
}

async function construct(ctx, pasture) {
  const origin = position(pasture.origin);
  let missing = 0;
  for (let x = 0; x <= 4; x++) {
    for (let z = 0; z <= 4; z++) {
      if ((x === 0 || x === 4 || z === 0 || z === 4) && !(x === 2 && z === 0)
        && ctx.bot.blockAt(origin.offset(x, 0, z))?.name !== 'oak_fence') missing++;
    }
  }
  if (missing) await ctx.obtain('oak_fence', missing);
  await ctx.obtain('oak_fence_gate', 1);
  useMovementProfile(ctx.bot, 'safe');
  for (let x = 0; x <= 4; x++) {
    for (let z = 0; z <= 4; z++) {
      if (x !== 0 && x !== 4 && z !== 0 && z !== 4) continue;
      if (x === 2 && z === 0) continue;
      throwIfAborted(ctx.signal);
      await placeBlockAt(ctx, origin.offset(x, 0, z), 'oak_fence');
    }
  }
  const gate = position(pasture.gate);
  const oldGate = ctx.bot.blockAt(gate);
  if (oldGate?.name === 'oak_fence_gate' && !['north', 'south'].includes(oldGate.getProperties().facing)) await digBlock(ctx, oldGate);
  if (ctx.bot.blockAt(gate)?.name !== 'oak_fence_gate') {
    if (!AIR.has(ctx.bot.blockAt(gate)?.name)) throw new Error('牧场入口被其他方块占用');
    const stand = origin.offset(2, 0, -2);
    await goTo(ctx.bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { signal: ctx.signal, timeoutMs: 20000 });
    await ctx.bot.equip(ctx.bot.inventory.items().find((item) => item.name === 'oak_fence_gate'), 'hand');
    await ctx.bot.lookAt(gate.offset(0.5, 0.5, 0.5), true);
    await ctx.bot.placeBlock(ctx.bot.blockAt(gate.offset(0, -1, 0)), new Vec3(0, 1, 0));
    await sleep(250, ctx.signal);
  }
  const placed = ctx.bot.blockAt(gate);
  if (placed?.name !== 'oak_fence_gate' || !['north', 'south'].includes(placed.getProperties().facing)) throw new Error('牧场门方向或放置结果不正确');
  await gateState(ctx, pasture, false);
  pasture.status = 'ready';
  await ctx.checkpoint?.();
}

export async function ensurePasture(ctx, { anchor = ctx.bot.entity.position } = {}) {
  useMovementProfile(ctx.bot, 'safe');
  ctx.state.pastures ??= [];
  const unfinished = ctx.state.pastures.find((pasture) => pasture.status === 'building');
  if (unfinished) { await construct(ctx, unfinished); return tendPasture(ctx, unfinished); }
  const missing = Object.keys(SPECIES).filter((species) => !ctx.state.pastures.some((pasture) => pasture.species === species));
  const candidate = Object.values(ctx.bot.entities).find((entity) => missing.includes(entity.name)
    && countItem(ctx.bot, SPECIES[entity.name]) >= 4 && wildCandidate(ctx.bot, entity, ctx.state.pastures));
  if (!candidate) return { deferred: true, reason: '缺少适合引导的鸡、牛、羊或对应饲料，暂缓新建栏位' };
  const origin = findSite(ctx.bot, anchor);
  if (!origin) return { deferred: true, reason: '基地附近没有安全且不覆盖建筑的围栏地基' };
  const pasture = { id: randomUUID(), species: candidate.name, origin: plain(origin), gate: plain(origin.offset(2, 0, 0)),
    dimension: String(ctx.bot.game.dimension), status: 'building', animals: [], lastFedAt: 0, lastTendedAt: 0, needsGateClosure: false };
  ctx.state.pastures.push(pasture);
  await ctx.checkpoint?.();
  await construct(ctx, pasture);
  return tendPasture(ctx, pasture);
}

function occupants(bot, pasture) {
  return Object.values(bot.entities).filter((entity) => entity.name === pasture.species && insidePasture(pasture, entity.position));
}

function isBaby(bot, entity) {
  const index = bot.registry.entitiesByName[entity.name]?.metadataKeys?.indexOf('baby');
  if (!(index >= 0)) return undefined;
  const value = entity.metadata?.[index];
  // 这三种原版动物的 baby 标志默认 false，服务器可能不发送默认值。
  return value === undefined ? false : typeof value === 'boolean' ? value : undefined;
}

export async function tendPasture(ctx, pasture) {
  useMovementProfile(ctx.bot, 'safe');
  if (pasture.dimension !== String(ctx.bot.game.dimension)) return { deferred: true, reason: '牧场不在当前维度' };
  const { bot } = ctx;
  if (pasture.status === 'building') await construct(ctx, pasture);
  // 方块被破坏后不谎称围栏仍然有效；只修复本档案中的缺失空位。
  const origin = position(pasture.origin);
  for (let x = 0; x <= 4; x++) {
    for (let z = 0; z <= 4; z++) {
      if (x !== 0 && x !== 4 && z !== 0 && z !== 4 || x === 2 && z === 0) continue;
      const location = origin.offset(x, 0, z);
      const block = bot.blockAt(location);
      if (!block) return { deferred: true, reason: '牧场区域未加载' };
      if (block.name !== 'oak_fence') {
        if (!AIR.has(block.name)) return { deferred: true, reason: '牧场围栏被改动，需要重新确认' };
        await ctx.obtain('oak_fence', 1);
        useMovementProfile(ctx.bot, 'safe');
        await placeBlockAt(ctx, location, 'oak_fence');
      }
    }
  }
  await gateState(ctx, pasture, false);
  const feed = SPECIES[pasture.species];
  const closeGate = async () => {
    const gate = bot.blockAt(position(pasture.gate));
    if (gate?.name === 'oak_fence_gate' && gate.getProperties().open
      && gate.position.distanceTo(bot.entity.position) <= 4) {
      await bot.activateBlock(gate).catch(() => {});
      await sleep(150);
    }
    pasture.needsGateClosure = bot.blockAt(position(pasture.gate))?.getProperties().open !== false;
  };
  try {
    if (occupants(bot, pasture).length < 2 && countItem(bot, feed) >= 2) {
      const candidates = Object.values(bot.entities).filter((entity) => entity.name === pasture.species && wildCandidate(bot, entity, ctx.state.pastures)).slice(0, 2);
      for (const animal of candidates) {
        throwIfAborted(ctx.signal);
        if (insidePasture(pasture, bot.entity.position)) {
          await bot.unequip('hand');
          await gateState(ctx, pasture, true);
          const outside = origin.offset(2, 0, -2);
          await goTo(bot, new goals.GoalBlock(outside.x, outside.y, outside.z), { signal: ctx.signal, timeoutMs: 15000 });
          await gateState(ctx, pasture, false);
        }
        await goTo(bot, new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 5), { signal: ctx.signal, timeoutMs: 20000 });
        await bot.equip(bot.inventory.items().find((item) => item.name === feed), 'hand');
        await sleep(1500, ctx.signal);
        await gateState(ctx, pasture, true);
        const entry = origin.offset(2, 0, -1);
        const center = origin.offset(2, 0, 3);
        await goTo(bot, new goals.GoalBlock(entry.x, entry.y, entry.z), { signal: ctx.signal, timeoutMs: 25000 });
        await bot.equip(bot.inventory.items().find((item) => item.name === feed), 'hand');
        const deadline = Date.now() + 25000;
        // 等动物跟到入口后再进入栏内，不让机器人跑得太快甩掉动物。
        while (animal.isValid && animal.position.distanceTo(entry) > 6 && Date.now() < deadline) await sleep(500, ctx.signal);
        await goTo(bot, new goals.GoalBlock(center.x, center.y, center.z), { signal: ctx.signal, timeoutMs: 15000 });
        await bot.equip(bot.inventory.items().find((item) => item.name === feed), 'hand');
        while (animal.isValid && !insidePasture(pasture, animal.position) && Date.now() < deadline) await sleep(500, ctx.signal);
        await gateState(ctx, pasture, false);
      }
    }
    const inside = occupants(bot, pasture);
    pasture.animals = inside.map((entity) => ({ uuid: entity.uuid ?? null, species: entity.name, lastSeenAt: Date.now(), position: plain(entity.position) }));
    pasture.status = inside.length ? 'occupied' : 'ready';
    const adults = inside.filter((entity) => isBaby(bot, entity) === false);
    if (adults.length >= 2 && countItem(bot, feed) >= 4 && Date.now() - pasture.lastFedAt > 5 * 60 * 1000) {
      const previousBabies = inside.filter((entity) => isBaby(bot, entity) === true).length;
      pasture.lastFedAt = Date.now();
      pasture.breedingStatus = 'feeding_attempted';
      await ctx.checkpoint?.();
      for (const animal of adults.slice(0, 2)) {
        await goTo(bot, new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2), { signal: ctx.signal, timeoutMs: 10000 });
        await bot.equip(bot.inventory.items().find((item) => item.name === feed), 'hand');
        await bot.activateEntity(animal);
        await sleep(500, ctx.signal);
      }
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && occupants(bot, pasture).filter((entity) => isBaby(bot, entity) === true).length <= previousBabies) await sleep(500, ctx.signal);
      pasture.breedingStatus = occupants(bot, pasture).filter((entity) => isBaby(bot, entity) === true).length > previousBabies ? 'new_juvenile_observed' : 'not_confirmed';
    }
    pasture.animals = occupants(bot, pasture).map((entity) => ({ uuid: entity.uuid ?? null, species: entity.name,
      lastSeenAt: Date.now(), position: plain(entity.position) }));
    pasture.lastTendedAt = Date.now();
    await ctx.checkpoint?.();
    return { pasture, observedAnimals: inside.length, deferred: inside.length < 2, reason: inside.length < 2 ? '尚未引导到足够动物，后续继续观察' : undefined };
  } finally { await closeGate(); }
}
