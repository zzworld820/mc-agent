// 睡觉技能：晚上把床放下、睡一觉跳过黑夜、醒来把床收回背包。
// 为什么重要：晚上满地怪物，机器人只会站着还手，很容易死（测试时真的被僵尸打死过）。
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { digWithTimeout, goTo, sleep, throwIfAborted, useMovementProfile, placeBlockSneaking } from '../../actions/helpers.js';
import { collectDrops } from './world.js';
import { unsafeDepartureThreat } from '../../strategy/navigation.js';

// 能上床睡觉的时间段（游戏刻）：大约晚上 7 点半到早上 6 点
const NIGHT_START = 12542;
const NIGHT_END = 23459;
const CHECK_INTERVAL_MS = 20000;

export function isNight(bot) {
  const time = bot.time?.timeOfDay ?? 0;
  return time >= NIGHT_START && time <= NIGHT_END;
}

/**
 * 是晚上、背包里有床，就睡一觉。在各个技能的循环里经常调用，内部自己节流（20 秒最多检查一次）。
 * @returns {Promise<boolean>} 有没有睡
 */
export async function restIfNight(ctx) {
  const { bot, state } = ctx;
  if (Date.now() - (state.lastRestCheck ?? 0) < CHECK_INTERVAL_MS) return false;
  state.lastRestCheck = Date.now();
  if (!isNight(bot)) return false;
  const bedItem = bot.inventory.items().find((item) => item.name.endsWith('_bed'));
  if (bedItem && (await sleepInBed(ctx, bedItem))) return true;
  // 在地下（头顶有方块挡着天空）的话，白天黑夜一样黑，躲也没用，接着干活
  if (isUnderground(bot)) return false;
  return hideUntilMorning(ctx);
}

/** 头顶 40 格内有实心方块 = 在地下 / 室内 */
function isUnderground(bot) {
  const head = bot.entity.position.floored().offset(0, 2, 0);
  for (let dy = 0; dy < 40; dy++) {
    if (bot.blockAt(head.offset(0, dy, 0))?.boundingBox === 'block') return true;
  }
  return false;
}

async function sleepInBed(ctx, bedItem) {
  const { bot, signal } = ctx;
  ctx.log('天黑了，放床睡觉');
  let bed = null;
  try {
    bed = await placeBed(ctx, bedItem);
    await bot.sleep(bed);
    // 睡着以后等天亮（服务器上只有它一个人时，几秒就跳到早上了）
    const deadline = Date.now() + 8 * 60 * 1000;
    while (bot.isSleeping && Date.now() < deadline) await sleep(1000, signal);
    ctx.log('睡醒了');
    return true;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    ctx.log(`睡不了：${err.message}`); // 附近有怪物、床放不下……改成躲起来
    return false;
  } finally {
    if (bot.isSleeping) await bot.wake().catch(() => {});
    if (bed) {
      // 把床收回来，下次还要用
      const placed = bot.blockAt(bed.position);
      if (placed?.name.endsWith('_bed')) {
        await bot.dig(placed, true).catch(() => {});
        await collectDrops(ctx, bed.position, 4).catch(() => {});
      }
    }
  }
}

const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * 放床：床占两格，放在“脚前一格”，床头会朝着面对的方向再伸出一格。
 * 所以要找一个方向，前面连续两格都是空的、下面都是实心的。放完等一下，确认两半都出现了。
 */
export async function placeBed(ctx, bedItem, { canPlace = () => true } = {}) {
  const { bot, signal } = ctx;
  const feet = bot.entity.position.floored();
  const isFree = (position) => {
    const here = bot.blockAt(position);
    const below = bot.blockAt(position.offset(0, -1, 0));
    return here?.boundingBox === 'empty' && !['water', 'lava'].includes(here.name) && below?.boundingBox === 'block';
  };
  for (const [dx, dz] of CARDINALS) {
    const foot = feet.offset(dx, 0, dz);
    const head = feet.offset(dx * 2, 0, dz * 2);
    if (!canPlace(foot) || !canPlace(head) || !isFree(foot) || !isFree(head)) continue;
    await bot.equip(bedItem, 'hand');
    await bot.lookAt(head.offset(0.5, 0, 0.5), true); // 面朝床头方向
    await sleep(150, signal);
    try {
      await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0)), new Vec3(0, 1, 0));
    } catch {
      continue;
    }
    await sleep(500, signal); // 等服务器把床的另一半也发过来
    if (bot.blockAt(foot)?.name.endsWith('_bed') && bot.blockAt(head)?.name.endsWith('_bed')) return bot.blockAt(foot);
    if (bot.blockAt(foot)?.name.endsWith('_bed')) {
      await bot.dig(bot.blockAt(foot), true).catch(() => {}); // 只放出半张（不应该发生），收回来换个方向
    }
  }
  throw new Error('身边没有能放下一张床的空地（要连续两格）');
}

const SHELTER_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt'];
const SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol']);
const ROCK = new Set(['stone', 'granite', 'diorite', 'andesite', 'tuff']);
const AIR = new Set(['air', 'cave_air']);
const EXIT_HAZARDS = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus',
  'campfire', 'soul_campfire', 'powder_snow', 'sand', 'red_sand', 'gravel']);
const PASSABLE_EXIT = new Set([...AIR, 'short_grass', 'fern', 'tall_grass']);

function safeExitStanding(bot, position, { needsFloor = true } = {}) {
  const floor = bot.blockAt(position.offset(0, -1, 0));
  return (!needsFloor || floor?.boundingBox === 'block' && !EXIT_HAZARDS.has(floor.name))
    && [0, 1].every(dy => PASSABLE_EXIT.has(bot.blockAt(position.offset(0, dy, 0))?.name));
}

function pitLandings(bot, surface) {
  return CARDINALS.flatMap(([dx, dz]) => [0, -1].map(dy => surface.offset(dx, dy, dz)))
    .filter(p => safeExitStanding(bot, p) && !unsafeDepartureThreat(bot, p));
}

function pillarMaterialCount(bot) {
  return bot.inventory.items().filter(item => SHELTER_BLOCKS.includes(item.name))
    .reduce((total, item) => total + item.count, 0);
}

function diggableGround(bot, block) {
  if (SOIL.has(block?.name)) return true;
  return ROCK.has(block?.name) && bot.inventory.items().some((item) => item.name.endsWith('_pickaxe') && block.canHarvest(item.type));
}

function safePit(bot, feet, state) {
  if (!bot.entity.onGround) return false;
  const rooms = Object.values(state.buildingRooms || {}).flat();
  if (rooms.some(({ origin, size }) => feet.x >= origin.x && feet.x < origin.x + size.width
    && feet.z >= origin.z && feet.z < origin.z + size.depth
    && feet.y - 4 <= origin.y + size.wallHeight + 1 && feet.y >= origin.y)) return false;
  if (!safeExitStanding(bot, feet) || !pitLandings(bot, feet).length) return false;
  // 检查整根井及外围，拒绝未加载区域、空洞、液体和重力方块。
  for (let dy = -4; dy <= -1; dy++) {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const block = bot.blockAt(feet.offset(dx, dy, dz));
      if (!diggableGround(bot, block)) return false;
    }
  }
  return true;
}

function safeHut(bot, feet) {
  if (![0, 1].every((dy) => AIR.has(bot.blockAt(feet.offset(0, dy, 0))?.name))) return false;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const floor = bot.blockAt(feet.offset(dx, -1, dz));
    if (floor?.boundingBox !== 'block' || ['magma_block', 'campfire', 'cactus'].includes(floor.name)) return false;
  }
  return CARDINALS.every(([dx, dz]) => [0, 1].every((dy) => {
    const block = bot.blockAt(feet.offset(dx, dy, dz));
    return AIR.has(block?.name) || block?.boundingBox === 'block';
  }));
}

async function digLocal(ctx, position) {
  throwIfAborted(ctx.signal);
  const block = ctx.bot.blockAt(position);
  if (!diggableGround(ctx.bot, block)) throw new Error('应急挖掘位置已改变');
  if (ROCK.has(block.name)) {
    const pickaxe = ctx.bot.inventory.items().find((item) => item.name.endsWith('_pickaxe') && block.canHarvest(item.type));
    if (!pickaxe) throw new Error('缺少可用镐子');
    await ctx.bot.equip(pickaxe, 'hand');
  }
  throwIfAborted(ctx.signal);
  const abort = () => ctx.bot.stopDigging();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try { await digWithTimeout(ctx.bot, block, 15000); }
  finally { ctx.signal.removeEventListener('abort', abort); }
  await sleep(300, ctx.signal);
  if (!AIR.has(ctx.bot.blockAt(position)?.name)) throw new Error('服务器未确认应急挖掘');
}

async function coverLocal(ctx, position, supportDepth = 0) {
  const { bot, signal } = ctx;
  if (bot.blockAt(position)?.boundingBox === 'block') return;
  if (!AIR.has(bot.blockAt(position)?.name)) throw new Error('封闭位置被占用');
  const item = bot.inventory.items().find((entry) => SHELTER_BLOCKS.includes(entry.name));
  if (!item) throw new Error('应急封闭材料不足');
  const offsets = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  let reference = offsets.map((offset) => bot.blockAt(position.plus(offset))).find((block) => block?.boundingBox === 'block');
  if (!reference && supportDepth < 2 && AIR.has(bot.blockAt(position.offset(0, -1, 0))?.name)) {
    await coverLocal(ctx, position.offset(0, -1, 0), supportDepth + 1);
    reference = bot.blockAt(position.offset(0, -1, 0));
  }
  if (!reference) throw new Error('封闭位置缺少浅层支撑');
  throwIfAborted(signal);
  await bot.equip(item, 'hand');
  await placeBlockSneaking(bot, reference, position.minus(reference.position), signal);
  await sleep(200, signal);
  if (bot.blockAt(position)?.boundingBox !== 'block') throw new Error('服务器未确认封闭方块');
  const shelter = ctx.state.emergencyShelter;
  if (shelter) {
    shelter.placedBlocks = (shelter.placedBlocks || []).filter((p) => p.x !== position.x || p.y !== position.y || p.z !== position.z);
    shelter.placedBlocks.push({ x: position.x, y: position.y, z: position.z, name: item.name });
    await ctx.checkpoint?.();
  }
}

function outsidePit(position, surface) {
  return position.x !== surface.x || position.z !== surface.z || position.y >= surface.y;
}

async function confirmPitExit(ctx, surface) {
  const { bot, signal, state } = ctx;
  throwIfAborted(signal);
  const feet = bot.entity.position.floored();
  if (!outsidePit(feet, surface) || !bot.entity.onGround || !safeExitStanding(bot, feet)) return false;
  delete state.emergencyShelter;
  await ctx.checkpoint?.();
  ctx.log('已确认在应急坑外安全站稳，清除避难状态');
  return true;
}

async function exitPit(ctx, surface, shelter) {
  const { bot, signal } = ctx;
  if (await confirmPitExit(ctx, surface)) return true;
  const feet = bot.entity.position.floored();
  const inShaft = !outsidePit(feet, surface) && feet.y >= surface.y - 3;
  if (!inShaft || !safeExitStanding(bot, feet) || bot.entity.onGround === false) {
    throw new Error('尚未确认井内站位或井外安全落脚点，暂缓出坑');
  }
  const capPosition = surface.offset(0, -1, 0);
  const cap = bot.blockAt(capPosition);
  const recorded = shelter.placedBlocks?.find(p => capPosition.equals(new Vec3(p.x, p.y, p.z)));
  const dirtAndGrass = ['dirt', 'grass_block'];
  const hasCap = feet.y < capPosition.y && !AIR.has(cap?.name);
  if (hasCap && (!cap || cap.boundingBox !== 'block' || cap.diggable === false || !recorded
    || !SHELTER_BLOCKS.includes(recorded.name)
    || (cap.name !== recorded.name && !(dirtAndGrass.includes(recorded.name) && dirtAndGrass.includes(cap.name))))) {
    throw new Error('井口覆盖物无法确认为可安全拆除的自建封顶');
  }
  if (!safeExitStanding(bot, surface, { needsFloor: false }) || unsafeDepartureThreat(bot, surface)) {
    throw new Error('井口净空不足或附近有敌人，留在掩体复查');
  }
  for (let y = feet.y; y <= surface.y + 1; y++) {
    const cell = new Vec3(surface.x, y, surface.z);
    for (const [dx, dz] of [[0, 0], ...CARDINALS]) {
      const block = bot.blockAt(cell.offset(dx, 0, dz));
      if (!block || EXIT_HAZARDS.has(block.name)) throw new Error('井道附近存在液体、危险方块或未加载区域');
    }
    if (!(hasCap && cell.equals(capPosition)) && !PASSABLE_EXIT.has(bot.blockAt(cell)?.name)) {
      throw new Error('井道净空不足，暂缓出坑');
    }
  }
  const count = pillarMaterialCount(bot);
  // With two blocks in a three-deep shaft, a checked adjacent landing can
  // provide the last step. Never rely on collecting an unconfirmed cap drop.
  const landings = pitLandings(bot, surface).filter(p => count >= Math.max(1, p.y - feet.y - 1));
  const canPillarToSurface = count >= surface.y - feet.y;
  if (!canPillarToSurface && !landings.length) throw new Error('垫脚材料不足，也没有可借力的井口落脚点');
  if (hasCap) {
    const tool = bot.pathfinder.bestHarvestTool(cap);
    if (tool) await bot.equip(tool, 'hand');
    if (cap.canHarvest && !cap.canHarvest(bot.heldItem?.type ?? null)) throw new Error('缺少可拆除坑顶的工具');
    throwIfAborted(signal);
    const abort = () => bot.stopDigging();
    signal.addEventListener('abort', abort, { once: true });
    try { await digWithTimeout(bot, cap, Math.max(15000, (bot.digTime?.(cap) || 0) + 3000)); }
    finally { signal.removeEventListener('abort', abort); }
    if (!AIR.has(bot.blockAt(capPosition)?.name)) throw new Error('服务器未确认坑顶已拆开');
  }
  shelter.exiting = true;
  await ctx.checkpoint?.();
  ctx.log('井口净空已确认，沿登记井道垫高返回地面');
  useMovementProfile(bot, 'free');
  const movements = bot.pathfinder.movements;
  movements.canDig = false;
  movements.allowParkour = false;
  movements.maxDropDown = 0;
  movements.scafoldingBlocks = SHELTER_BLOCKS.map(name => bot.registry.itemsByName[name]?.id).filter(Boolean);
  const exits = canPillarToSurface ? [surface, ...landings] : landings;
  const getNeighbors = movements.getNeighbors.bind(movements);
  movements.getNeighbors = node => getNeighbors(node).filter(next => {
    const shaft = next.x === surface.x && next.z === surface.z && next.y <= surface.y;
    return next.y >= node.y && (shaft || exits.some(p => p.equals(next)))
      && next.toPlace.every(p => p.jump && p.x === surface.x && p.z === surface.z);
  });
  const goals = pathfinderPkg.goals;
  await goTo(bot, new goals.GoalCompositeAny(exits.map(p => new goals.GoalBlock(p.x, p.y, p.z))), {
    signal, timeoutMs: 15000, stuckMs: 6000, preciseFallback: false,
  });
  if (await confirmPitExit(ctx, surface)) return true;
  throw new Error('尚未确认到达井外安全站位');
}

function enclosed(bot, feet) {
  if (bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) > 0.8) return false;
  if (![0, 1].every((dy) => AIR.has(bot.blockAt(feet.offset(0, dy, 0))?.name))) return false;
  if (bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block' || bot.blockAt(feet.offset(0, 2, 0))?.boundingBox !== 'block') return false;
  return CARDINALS.every(([dx, dz]) => [0, 1].every((dy) => bot.blockAt(feet.offset(dx, dy, dz))?.boundingBox === 'block'));
}

async function sealShelter(ctx, shelter, feet) {
  if (shelter.kind === 'hut') {
    for (const [dx, dz] of CARDINALS) for (const dy of [0, 1]) await coverLocal(ctx, feet.offset(dx, dy, dz));
  }
  await coverLocal(ctx, feet.offset(0, 2, 0));
  if (!enclosed(ctx.bot, feet)) throw new Error('掩体尚未确认封闭，继续优先修复避难条件');
}

/** 用独立档案恢复未完工掩体，避免任务打断后把自己困在地下。 */
export async function hideUntilMorning(ctx, { buildOnly = false } = {}) {
  const { bot, state, signal } = ctx;
  let shelter = state.emergencyShelter;
  if (shelter && shelter.dimension !== String(bot.game.dimension)) {
    delete state.emergencyShelter;
    shelter = null;
  }
  if (shelter?.kind === 'hut' && !safeHut(bot, new Vec3(shelter.surface.x, shelter.surface.y, shelter.surface.z))) {
    delete state.emergencyShelter;
    shelter = null;
  }
  if (shelter?.kind === 'hut' && !shelter.placedBlocks) {
    const base = new Vec3(shelter.surface.x, shelter.surface.y, shelter.surface.z);
    const oldShell = CARDINALS.flatMap(([dx, dz]) => [0, 1].map((dy) => base.offset(dx, dy, dz)));
    oldShell.push(base.offset(0, 2, 0));
    shelter.placedBlocks = oldShell.filter((p) => SHELTER_BLOCKS.includes(bot.blockAt(p)?.name))
      .map((p) => ({ x: p.x, y: p.y, z: p.z, name: bot.blockAt(p).name }));
    await ctx.checkpoint?.();
  }
  if (!buildOnly && shelter?.kind === 'pit' && (shelter.depth > 0 || shelter.exiting)
    && (isNight(bot) || (bot.time?.timeOfDay ?? 0) >= 10000)) {
    const mouth = new Vec3(shelter.surface.x, shelter.surface.y, shelter.surface.z);
    if (outsidePit(bot.entity.position.floored(), mouth)) {
      if (!await confirmPitExit(ctx, mouth)) return false;
      shelter = null;
    }
  }
  if (!shelter) {
    const surface = bot.entity.position.floored();
    const pit = safePit(bot, surface, state);
    if (!pit) {
      if (!safeHut(bot, surface)) {
        ctx.log('脚下不适合封闭掩体，在近处寻找有完整地基的站位');
        useMovementProfile(bot, 'safe');
        let attempts = 0;
        for (let radius = 1; radius <= 6; radius++) {
          for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
            for (const dy of [0, 1, -1]) {
              const candidate = surface.offset(dx, dy, dz);
              if (!safeHut(bot, candidate)) continue;
              try {
                await goTo(bot, new pathfinderPkg.goals.GoalBlock(candidate.x, candidate.y, candidate.z), { signal, timeoutMs: 8000 });
                return hideUntilMorning(ctx, { buildOnly });
              } catch (error) {
                throwIfAborted(signal);
                if (++attempts >= 3) return false;
              }
            }
          }
        }
        return false;
      }
      // 最小地面掩体为一格站位、两格高围墙和封顶，最多消耗九块。
      const cells = CARDINALS.flatMap(([dx, dz]) => [0, 1].map((dy) => surface.offset(dx, dy, dz)));
      cells.push(surface.offset(0, 2, 0));
      const floorSafe = bot.blockAt(surface.offset(0, -1, 0))?.boundingBox === 'block';
      if (!floorSafe || cells.some((p) => !AIR.has(bot.blockAt(p)?.name) && bot.blockAt(p)?.boundingBox !== 'block')) return false;
      const missing = cells.filter((p) => bot.blockAt(p)?.boundingBox !== 'block').length;
      const available = bot.inventory.items().filter((item) => SHELTER_BLOCKS.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
      if (available < missing) return false;
    }
    shelter = { dimension: String(bot.game.dimension), surface: { x: surface.x, y: surface.y, z: surface.z }, kind: pit ? 'pit' : 'hut', depth: 0, placedBlocks: [] };
    state.emergencyShelter = shelter;
    await ctx.checkpoint?.();
    ctx.log(pit ? '建立三格深应急掩体，封闭后等待天亮' : '使用背包现有土石封闭简易掩体');
  }
  const surface = new Vec3(shelter.surface.x, shelter.surface.y, shelter.surface.z);
  const feet = surface.offset(0, shelter.kind === 'pit' ? -3 : 0, 0);
  if (!buildOnly && !isNight(bot) && (bot.time?.timeOfDay ?? 0) < 10000) {
    ctx.log('天亮了，沿可施工路线离开应急掩体');
    if (shelter.kind === 'hut') {
      // 旧检查点没有逐块档案，仅恢复这个掩体记录中的墙和顶。
      const legacy = CARDINALS.flatMap(([dx, dz]) => [0, 1].map((dy) => surface.offset(dx, dy, dz)));
      legacy.push(surface.offset(0, 2, 0));
      const covers = shelter.placedBlocks || legacy;
      for (const p of covers) {
        throwIfAborted(signal);
        const block = bot.blockAt(new Vec3(p.x, p.y, p.z));
        if (!block || !SHELTER_BLOCKS.includes(block.name) || p.name && p.name !== block.name) continue;
        const tool = bot.pathfinder.bestHarvestTool(block);
        if (tool) await bot.equip(tool, 'hand');
        if (block.diggable === false) throw new Error('临时围墙方块无法拆除');
        const abort = () => bot.stopDigging();
        signal.addEventListener('abort', abort, { once: true });
        const timeout = Math.max(15000, (bot.digTime?.(block) || 0) + 3000);
        try { await digWithTimeout(bot, block, timeout); }
        finally { signal.removeEventListener('abort', abort); }
      }
      delete state.emergencyShelter;
      await ctx.checkpoint?.();
      ctx.log('临时围墙已拆除，恢复白天任务');
      return true;
    }
    return exitPit(ctx, surface, shelter);
  }
  if (shelter.kind === 'pit' && shelter.exiting && bot.entity.position.y > feet.y + 0.3) {
    ctx.log('出坑中途入夜，保持当前站位，白天复查井口');
    await sleep(2000, signal);
    return true;
  }
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  // 站在方格中心，避免身体跨过格线导致服务器拒绝贴身砌墙。
  const center = (shelter.kind === 'hut' ? surface : bot.entity.position.floored()).offset(0.5, 0, 0.5);
  const deadline = Date.now() + 3000;
  try {
    while (Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z) > 0.08) {
      throwIfAborted(signal);
      if (Date.now() > deadline) throw new Error('未能站稳掩体中心');
      await bot.lookAt(new Vec3(center.x, bot.entity.position.y + 1.6, center.z), true);
      bot.setControlState('forward', true);
      await sleep(50, signal);
    }
  } finally { bot.clearControlStates(); }
  if (shelter.kind === 'pit') {
    for (let depth = shelter.depth + 1; depth <= 3; depth++) {
      const target = surface.offset(0, -depth, 0);
      if (!AIR.has(bot.blockAt(target)?.name)) await digLocal(ctx, target);
      await sleep(400, signal);
      if (bot.entity.position.y < target.y - 0.3) {
        shelter.depth = depth;
        continue;
      }
      if (Math.abs(bot.entity.position.y - target.y) > 0.3) throw new Error('尚未落稳，暂停下挖');
      shelter.depth = depth;
      await ctx.checkpoint?.();
    }
    await sleep(800, signal);
  }
  await sealShelter(ctx, shelter, feet);
  if (buildOnly) {
    ctx.log('应急掩体已封闭，后续白天继续完善正式住所');
    return true;
  }
  ctx.log('已确认掩体封闭，留在内部等待天亮');
  while (isNight(bot) || (bot.time?.timeOfDay ?? 0) >= 10000) {
    throwIfAborted(signal);
    if (!enclosed(bot, feet)) {
      ctx.log('掩体封闭状态改变，立即复查并修补');
      await sealShelter(ctx, shelter, feet);
    }
    await sleep(2000, signal);
  }
  return hideUntilMorning(ctx);
}
