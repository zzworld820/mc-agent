// 动作共用的小工具：可取消的等待和寻路、按名字找方块 / 物品 / 玩家。
// 所有错误信息都是中文，因为它们最后会作为“工具结果”交给大模型，再转述给玩家。
import pathfinderPkg from 'mineflayer-pathfinder';
import physicsPkg from 'prismarine-physics';
import { Vec3 } from 'vec3';
import { canAlterEntranceTerrain } from '../strategy/access.js';

const { pathfinder, Movements } = pathfinderPkg;

// ---------- 寻路 ----------

/** 装寻路插件。默认是“安全”走法：绝不挖方块、不搭方块，免得破坏别人的建筑 */
export function setupPathfinder(bot) {
  bot.loadPlugin(pathfinder);
  fixDigTime(bot);
  useMovementProfile(bot, 'safe');
}

/**
 * 修 minecraft-data 1.21.6 的一个数据 bug：矿石、黑曜石这类方块的“材质”被写成了
 * incorrect_for_wooden_tool / incorrect_for_stone_tool 之类（其实是“哪些工具挖不了”的标签），
 * 结果镐子的加速完全不算：钻石镐挖黑曜石算出 75 秒（实际 9.4 秒），石镐挖铁矿 4.6 秒（实际 1.15 秒）。
 * bot.dig 会按这个时间傻等，所以挖矿慢了好几倍。这里把这类方块按“镐子能挖”的材质重新算。
 */
function fixDigTime(bot) {
  const original = bot.digTime;
  bot.digTime = (block) => {
    if (typeof block?.material === 'string' && block.material.startsWith('incorrect_for_')) {
      const patched = Object.create(block);
      patched.material = 'mineable/pickaxe';
      return original(patched);
    }
    return original(block);
  };
}

/**
 * 切换走法：
 *   safe —— 只走路，不挖不搭（公网服聊天模式）
 *   free —— 可以挖穿方块、垫方块往上爬、搭路（自主发育模式，只在测试服用）
 */
export function useMovementProfile(bot, profile) {
  const movements = new Movements(bot);
  const readMovementBlock = movements.getBlock.bind(movements);
  movements.getBlock = (position, dx, dy, dz) => {
    const block = readMovementBlock(position, dx, dy, dz);
    // 原生寻路仍把已打开的门/栅栏门视为实心，导致安全模式无法进出自己的住所。
    // 只认可服务器已确认的打开状态；不自动操作任何人的门。
    if (block.position && (block.name.endsWith('_door') || block.name.endsWith('_fence_gate')) && block.getProperties().open === true) {
      block.safe = true;
      block.physical = false;
      block.replaceable = false;
      block.height = block.position.y;
    }
    return block;
  };
  const passive = profile === 'safe' || profile === 'retreat';
  if (passive) {
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    movements.allowParkour = false;
    movements.maxDropDown = 3;
  } else {
    // 自主挖路也必须保留树干，原木由整树采伐技能统一处理。
    for (const block of bot.registry.blocksArray) {
      if (block.name.endsWith('_log')) movements.blocksCantBreak.add(block.id);
    }
    // 自己放的工作台、熔炉、箱子不要挖掉
    for (const name of ['crafting_table', 'furnace', 'chest', 'bed']) {
      const block = bot.registry.blocksByName[name];
      if (block) movements.blocksCantBreak.add(block.id);
    }
    if (bot.strategySupervisor?.active || bot.supplySupervisor?.active) {
      for (const block of bot.registry.blocksArray) {
        if (block.name.endsWith('_fence') || block.name.endsWith('_fence_gate') || block.name.endsWith('_door')
          || block.name.endsWith('_bed') || ['ladder', 'farmland', 'wheat', 'potatoes', 'carrots', 'beetroots'].includes(block.name)) {
          movements.blocksCantBreak.add(block.id);
        }
      }
      movements.exclusionAreasBreak.push((block) => {
        const state = bot.strategySupervisor?.active ? bot.strategySupervisor.state : bot.supplySupervisor?.state;
        if (!state || state.partition.dimension !== String(bot.game.dimension)) return 0;
        const p = block.position;
        const home = state.home;
        const nearArchive = (state.archivedStorage || []).some((storage) => storage.home && Math.abs(p.x - storage.home.x) <= 4
          && Math.abs(p.z - storage.home.z) <= 4 && Math.abs(p.y - storage.home.y) <= 5);
        const nearHome = home && Math.abs(p.x - home.x) <= 4 && Math.abs(p.z - home.z) <= 4 && Math.abs(p.y - home.y) <= 5;
        const nearFarm = state.farm && p.x >= state.farm.origin.x - 2 && p.x <= state.farm.origin.x + (state.farm.width || 3) + 1
          && p.z >= state.farm.origin.z - 2 && p.z <= state.farm.origin.z + (state.farm.depth || 2) + 1 && Math.abs(p.y - state.farm.origin.y) <= 3;
        const storage = state.storage;
        const nearStorage = storage?.origin && p.x >= storage.origin.x - 1 && p.x <= storage.origin.x + 3
          && p.z >= storage.origin.z - 1 && p.z <= storage.origin.z + Math.ceil(storage.capacity / 2) * 2 + 1 && Math.abs(p.y - storage.origin.y) <= 4;
        const rooms = [...(state.house?.rooms ?? []), ...Object.values(state.buildingRooms ?? {}).flat()];
        const nearRoom = rooms.some((room) => p.x >= room.origin.x - 1 && p.x <= room.origin.x + room.size.width
          && p.z >= room.origin.z - 1 && p.z <= room.origin.z + room.size.depth && p.y >= room.origin.y - 1 && p.y <= room.origin.y + room.size.wallHeight + 2);
        const nearPasture = state.pastures.some((pasture) => p.x >= pasture.origin.x - 1 && p.x <= pasture.origin.x + 5
          && p.z >= pasture.origin.z - 1 && p.z <= pasture.origin.z + 5 && Math.abs(p.y - pasture.origin.y) <= 3);
        const protectedHome = (nearArchive || nearHome) && !canAlterEntranceTerrain(bot, state, block);
        return protectedHome || nearFarm || nearPasture || nearStorage || nearRoom ? Infinity : 0;
      });
    }
    // 垫脚用的方块：泥土、圆石、深板岩圆石、下界岩
    movements.scafoldingBlocks = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']
      .map((name) => bot.registry.itemsByName[name]?.id)
      .filter(Boolean);
    // 尽量别贴着岩浆走：被怪一顶就掉进去了（下界里测试时被疣猪兽顶进岩浆死过）
    movements.exclusionAreasStep = [(block) => (isNextToLava(bot, block.position) ? 50 : 0)];
  }
  if (passive || bot.strategySupervisor?.active || bot.supplySupervisor?.active) {
    const diagonal = movements.getMoveDiagonal.bind(movements);
    movements.getMoveDiagonal = (node, direction, neighbors) => {
      if (passive) return;
      // 高差转角的对角路线可能通过图搜索却无法通过实际跳跃，改走直角站位。
      const columns = [[direction.x, 0], [0, direction.z], [direction.x, direction.z]];
      const clear = columns.every(([x, z]) => movements.getBlock(node, x, -1, z).physical
        && !movements.getBlock(node, x, 0, z).physical && !movements.getBlock(node, x, 1, z).physical);
      if (clear) diagonal(node, direction, neighbors);
    };
  }
  if (bot.strategySupervisor?.active || bot.supplySupervisor?.active) {
    movements.exclusionAreasStep.push((block) => {
      const armored = [5, 6, 7, 8].filter((slot) => bot.inventory.slots[slot]).length >= 2;
      const dangerous = Object.values(bot.entities).some((entity) => {
        if (entity.type !== 'hostile' || entity === bot.entity) return false;
        const ranged = ['witch', 'pillager', 'skeleton', 'stray', 'bogged'].includes(entity.name);
        if (armored && !ranged) return false;
        const range = ranged ? 16 : 9;
        const distance = entity.position.distanceTo(block.position);
        // Returning to verified shelter may require briefly moving closer to a
        // ranged attacker. Prefer cover over an endless flight in open terrain.
        if (profile === 'retreat') return distance < 3;
        if (!(distance < range && distance < entity.position.distanceTo(bot.entity.position) - 0.1)) return false;
        const state = bot.strategySupervisor?.active ? bot.strategySupervisor.state : bot.supplySupervisor?.state;
        return !hasOwnedShelterCover(bot, state, entity, block.position);
      });
      return dangerous ? 1000 : 0;
    });
  }
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = profile === 'safe' ? 5000 : 10000; // 挖路的路线复杂，多给点时间算
}

// A hostile on the OTHER side of a closed, roofed owned room must not forbid
// every indoor step towards the door/workstations. Never grant this exemption
// outside the registered interior, for an indoor hostile, or without real cover.
export function hasOwnedShelterCover(bot, state, entity, position, { entering = false } = {}) {
  const home = state?.home;
  if (!home?.door || home.dimension !== String(bot.game?.dimension) || !bot.world?.raycast) return false;
  const projectId = home.projectId || state.house?.projectId;
  const rooms = state.buildingRooms?.[projectId] || state.house?.rooms || [];
  const inside = (p, room) => p.x >= room.origin.x + 1 && p.x < room.origin.x + room.size.width - 1
    && p.z >= room.origin.z + 1 && p.z < room.origin.z + room.size.depth - 1
    && Math.abs(p.y - (room.origin.y + 1)) < .3;
  const room = rooms.find(room => (entering || inside(bot.entity.position, room)) && indoorRoomStepCost(position, room) === 0);
  if (!room || rooms.some(room => entity.position.x >= room.origin.x && entity.position.x < room.origin.x + room.size.width
    && entity.position.z >= room.origin.z && entity.position.z < room.origin.z + room.size.depth
    && entity.position.y >= room.origin.y + 1 && entity.position.y < room.origin.y + room.size.wallHeight + 1)) return false;
  const door = bot.blockAt(new Vec3(home.door.x, home.door.y, home.door.z));
  if (!door?.name.endsWith('_door') || door.getProperties().open !== false) return false;
  const feet = new Vec3(Math.floor(position.x), room.origin.y + 1, Math.floor(position.z));
  if (bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block'
    || bot.blockAt(new Vec3(feet.x, room.origin.y + room.size.wallHeight + 1, feet.z))?.boundingBox !== 'block') return false;
  const from = entity.position.offset(0, Math.min(entity.height || 1.6, 1.5), 0);
  const to = feet.offset(.5, 1.5, .5);
  const delta = to.minus(from);
  const distance = delta.norm();
  if (!distance) return false;
  const hit = bot.world.raycast(from, delta.normalize(), distance);
  return hit?.boundingBox === 'block' && !['water', 'lava', 'fire', 'soul_fire'].includes(hit.name);
}

// Pathfinder applies step exclusions to BOTH feet and head clearance blocks.
// Allow the two-block body column, while still excluding the doorway, outside,
// lower floor and any route that would climb to the next standing level.
export function indoorRoomStepCost(position, { origin, size }) {
  return position.x > origin.x && position.x < origin.x + size.width - 1
    && position.z > origin.z && position.z < origin.z + size.depth - 1
    && position.y >= origin.y + 1 && position.y <= origin.y + 2 ? 0 : Infinity;
}

export function exposedHostileAt(bot, entity, position) {
  const from = position.offset(0, 1.5, 0);
  const to = entity.position.offset(0, Math.min(entity.height || 1, 1.5), 0);
  const delta = to.minus(from);
  const distance = delta.norm();
  if (!distance || !bot.world?.raycast) return true;
  return !bot.world.raycast(from, delta.scaled(1 / distance), distance);
}

function isNextToLava(bot, position) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]) {
    if (bot.blockAt(position.offset(dx, dy, dz))?.name === 'lava') return true;
  }
  return false;
}

/** 立刻停下所有移动和挖掘（setGoal(null) 立即生效；pathfinder.stop() 要等下一帧，会误杀新目标） */
export function haltBot(bot) {
  bot.pathfinder?.setGoal(null);
  bot.stopDigging?.();
  bot.clearControlStates();
}

// 点击容器、熔炉或工作台表面施工时必须潜行，否则服务器执行的是打开界面。
export async function placeBlockSneaking(bot, reference, face, signal) {
  const previous = bot.controlState?.sneak || false;
  bot.setControlState('sneak', true);
  try {
    await sleep(100, signal);
    throwIfAborted(signal);
    await bot.placeBlock(reference, face);
  } finally { bot.setControlState('sneak', previous); }
}

/**
 * 走到目标位置。可以被 signal 取消，超时会放弃；到不了就抛出中文错误。
 * @param {import('mineflayer').Bot} bot
 * @param {object} goal  mineflayer-pathfinder 的 goal
 */
export async function goTo(bot, goal, { signal, timeoutMs = 30000, stuckMs = 20000, preciseFallback = true } = {}) {
  throwIfAborted(signal);
  if (goal.isEnd(pathPosition(bot))) return;
  try { return await goToNative(bot, goal, { signal, timeoutMs, stuckMs }); }
  catch (error) {
    throwIfAborted(signal);
    if (!preciseFallback || !bot.physics || bot.pathfinder.movements?.canDig !== false) {
      recordNavigationFailure(bot, goal, error);
      throw error;
    }
    try { return await followPrecisePath(bot, goal, { signal, timeoutMs }); }
    catch (preciseError) {
      throwIfAborted(signal);
      recordNavigationFailure(bot, goal, preciseError);
      throw preciseError;
    }
  }
}

function recordNavigationFailure(bot, goal, error) {
  if (Date.now() - (bot.navigationFailure?.at || 0) < 2000) return;
  // Keep a bounded description of the actual collision cells and active rules;
  // do not serialize goals wholesale (they can contain the whole bot/world).
  try {
    const feet = pathPosition(bot);
    const movements = bot.pathfinder.movements;
    const describeGoal = (entry) => ({ type: entry.constructor?.name, x: entry.x, y: entry.y, z: entry.z,
      position: entry.pos, rangeSq: entry.rangeSq,
      goals: entry.goals?.map((child) => ({ type: child.constructor?.name, position: child.pos, x: child.x, y: child.y, z: child.z })) });
    const cells = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = -1; y <= 2; y++) {
      const position = feet.offset(x, y, z);
      const block = bot.blockAt(position);
      const movement = movements.getBlock(feet, x, y, z);
      cells.push({ position, name: block?.name ?? 'unloaded', shapes: block?.shapes,
        safe: movement.safe, physical: movement.physical, height: movement.height,
        stepCost: movements.exclusionStep(movement) });
    }
    bot.navigationFailure = { at: Date.now(), position: bot.entity.position.clone(), reason: error.message,
      canDig: movements.canDig, goal: describeGoal(goal), cells };
    bot.emit?.('agentNavigationFailure', bot.navigationFailure);
  } catch { /* Diagnostics must never change movement semantics. */ }
}

async function goToNative(bot, goal, { signal, timeoutMs, stuckMs }) {
  throwIfAborted(signal);
  await alignStandingPosition(bot, signal);

  const movements = bot.pathfinder.movements;
  const blocked = new Set();
  let currentPath = [];
  let reroutes = 0;
  const blockKey = (position) => `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
  const avoidBlocked = (block) => blocked.has(blockKey(block.position)) ? 1000 : 0;
  movements?.exclusionAreasStep.push(avoidBlocked);
  const onPath = (result) => { currentPath = result.path; };
  bot.on('path_update', onPath);

  const walking = bot.pathfinder.goto(goal);
  walking.catch(() => {}); // 被我们主动打断时它也会报错，这里先接住，避免“未处理的 Promise 错误”

  let timer;
  let watchdog;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(() => {
      bot.pathfinder.setGoal(null);
      reject(new Error(`走了 ${Math.round(timeoutMs / 1000)} 秒还没到，放弃了`));
    }, timeoutMs);
    // 卡住检测：stuckMs 内一格都没挪、也没在挖方块 → 别傻等到超时，早点放弃换目标
    let lastPosition = bot.entity.position.clone();
    let lastProgress = Date.now();
    watchdog = setInterval(() => {
      if (bot.entity.position.distanceTo(lastPosition) > 1 || bot.targetDigBlock) {
        lastPosition = bot.entity.position.clone();
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > stuckMs) {
        bot.pathfinder.setGoal(null);
        reject(new Error(`卡住了，${Math.round(stuckMs / 1000)} 秒没挪动`));
      } else if (Date.now() - lastProgress > 4000 && currentPath.length && reroutes < 3 && !bot.entity.isInWater) {
        // 图上的边可能无法通过实际碰撞。排除这次卡住的下一站，重新寻找路线。
        blocked.add(blockKey(currentPath[0]));
        reroutes++;
        lastProgress = Date.now();
        bot.pathfinder.setGoal(goal);
      }
    }, 1000);
    onAbort = () => {
      bot.pathfinder.setGoal(null);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    await Promise.race([walking, interrupted]);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(PATH_ERRORS[err.name] ?? err.message);
  } finally {
    clearTimeout(timer);
    clearInterval(watchdog);
    signal?.removeEventListener('abort', onAbort);
    bot.removeListener('path_update', onPath);
    if (movements) movements.exclusionAreasStep = movements.exclusionAreasStep.filter((rule) => rule !== avoidBlocked);
  }

  // pathfinder 在“完全找不到路”时也会当成功返回，所以要自己确认真的到了
  if (!goal.isEnd(pathPosition(bot))) {
    throw new Error(movements?.canDig === false ? '没有可直接步行的安全站位路线' : '可施工路径未能到达目标站位');
  }
}

// 耕地顶面低于整格1/16，寻路节点仍使用上方站位高度。
function pathPosition(bot) {
  const position = bot.entity.position.floored();
  if (bot.entity.onGround && bot.entity.position.y - position.y > 0.9) position.y++;
  return position;
}

// 安全模式的普通执行器卡住后，逐个站位验证并走到中心，避免提前切角。
async function followPrecisePath(bot, goal, { signal, timeoutMs }) {
  haltBot(bot);
  const deadline = Date.now() + Math.min(timeoutMs, 45000);
  const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, goal, { optimizePath: false });
  let route;
  do {
    throwIfAborted(signal);
    const next = generator.next();
    if (next.done || Date.now() >= deadline) throw new Error('安全站位路线规划超时');
    route = next.value.result;
    await new Promise((resolve) => setImmediate(resolve));
  } while (route.status === 'partial');
  if (route.status !== 'success' || route.path.some((node) => node.toBreak.length || node.toPlace.length)) throw new Error('没有可直接步行的安全站位路线');
  const world = { getBlock(position) {
    const block = bot.blockAt(position);
    if (!block) throw new Error('安全站位路线经过未加载区块');
    return block;
  } };
  const { PlayerState } = physicsPkg;
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  // 每一站都从上一站的模拟结果继续，避免把整条路线误判成从起点直达每个节点。
  const simulation = new PlayerState(bot, controls);
  const controlFor = (position, velocity, target) => {
    const x = (target.x - position.x) * 0.08 - velocity.x * 0.8;
    const z = (target.z - position.z) * 0.08 - velocity.z * 0.8;
    return { yaw: Math.atan2(-x, -z), forward: Math.hypot(x, z) > 0.004, jump: target.y > position.y + 0.1 };
  };
  const reached = (position, target, grounded) => grounded
    && Math.hypot(position.x - target.x, position.z - target.z) < 0.3 && Math.abs(position.y - target.y) < 0.2;
  try {
    for (const node of route.path) {
      throwIfAborted(signal);
      const target = new Vec3(node.x + 0.5, node.y, node.z + 0.5);
      const nodeStartY = simulation.pos.y;
      if (Math.abs(target.y - nodeStartY) > 3) throw new Error('精确步行路线包含过大高差');
      let feasible = reached(simulation.pos, target, simulation.onGround);
      for (let tick = 0; tick < 80 && !feasible; tick++) {
        const move = controlFor(simulation.pos, simulation.vel, target);
        controls.forward = move.forward;
        controls.jump = move.jump;
        simulation.yaw = move.yaw;
        bot.physics.simulatePlayer(simulation, world);
        if (simulation.isInLava || simulation.pos.y < Math.min(target.y, nodeStartY) - 3) break;
        feasible = reached(simulation.pos, target, simulation.onGround);
      }
      if (!feasible) throw new Error('下一站未通过实际碰撞模型验证');
      const nodeDeadline = Math.min(deadline, Date.now() + 5000);
      while (!reached(bot.entity.position, target, bot.entity.onGround)) {
        throwIfAborted(signal);
        if (Date.now() >= nodeDeadline) throw new Error('精确步行未到达下一站');
        const move = controlFor(bot.entity.position, bot.entity.velocity, target);
        await bot.look(move.yaw, 0, true);
        bot.setControlState('forward', move.forward);
        bot.setControlState('jump', move.jump);
        await sleep(50, signal);
      }
      bot.clearControlStates();
    }
    if (!goal.isEnd(pathPosition(bot))) throw new Error('精确步行尚未到达目标');
  } finally { bot.clearControlStates(); }
}

// 跨在方块边缘时先回到有支撑的格子中心，减少转角与跳跃的起点误差。
async function alignStandingPosition(bot, signal) {
  const position = bot.entity.position;
  if (!bot.blockAt || !bot.entity.onGround || Math.abs(position.y - Math.round(position.y)) > 0.01) return;
  const feet = position.floored();
  const candidates = [];
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    const point = feet.offset(x, 0, z);
    const floor = bot.blockAt(point.offset(0, -1, 0));
    const body = bot.blockAt(point);
    if (floor?.boundingBox !== 'block' || ['magma_block', 'campfire', 'cactus', 'powder_snow'].includes(floor.name)) continue;
    if (body?.boundingBox !== 'empty' || ['water', 'lava', 'fire', 'soul_fire'].includes(body.name)
      || bot.blockAt(point.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
    const center = point.offset(0.5, 0, 0.5);
    if (center.distanceTo(position) <= 1.2) candidates.push(center);
  }
  candidates.sort((a, b) => a.distanceTo(position) - b.distanceTo(position));
  if (!candidates.length) return;
  haltBot(bot);
  const target = candidates[0];
  const deadline = Date.now() + 1200;
  try {
    while (target.distanceTo(bot.entity.position) > 0.2 && Date.now() < deadline) {
      throwIfAborted(signal);
      await bot.lookAt(target.offset(0, 1.5, 0), true);
      bot.setControlState('forward', true);
      await sleep(50, signal);
    }
  } finally { bot.clearControlStates(); }
}

const PATH_ERRORS = {
  NoPath: '当前移动规则下找不到可达目标的路线',
  Timeout: '路线太复杂，没算出来怎么走',
  GoalChanged: '走到一半被别的事打断了',
  PathStopped: '走到一半被叫停了',
};

// ---------- 挖方块 ----------

/**
 * 挖一个方块，带超时。mineflayer 的 bot.dig 没有超时：服务器不确认的话会一直等下去
 * （测试时挖黑曜石卡了 10 分钟）。超时就停止挖掘并报错。
 */
export async function digWithTimeout(bot, block, timeoutMs = 25000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      bot.stopDigging();
      reject(new Error(`挖 ${block.name} 超过 ${Math.round(timeoutMs / 1000)} 秒没挖下来`));
    }, timeoutMs);
  });
  const digging = bot.dig(block, true);
  digging.catch(() => {});
  try {
    await Promise.race([digging, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 合成 ----------

/**
 * 合成并确认真的做出来了。
 * 合成 = 往合成格里点几下再把成品点出来，每一下都要服务器确认。刚打开工作台、背包刚变动时，
 * 服务器偶尔会默默忽略这些点击（不报错，材料退回背包，成品没出来）。所以做完数一数，没变多就重试。
 * @param {() => object | undefined} findRecipe 每次重试前重新找配方（背包变了，能用的配方也会变）
 * @returns {Promise<number>} 实际多出来的数量
 */
export async function craftVerified(bot, itemName, findRecipe, times, table, signal) {
  const before = countItem(bot, itemName);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(250 * attempt, signal);
    const recipe = findRecipe();
    if (!recipe) break;
    try {
      await bot.craft(recipe, times, table ?? undefined);
    } catch (err) {
      lastError = err;
    }
    await sleep(400, signal);
    if (countItem(bot, itemName) > before) return countItem(bot, itemName) - before;
  }
  throw new Error(`合成 ${itemName} 没成功${lastError ? `（${lastError.message}）` : '（服务器没认这次合成）'}`);
}

// ---------- 取消与等待 ----------

/** 可以被取消的 sleep */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal) {
  const err = new Error(String(signal?.reason ?? '已取消'));
  err.name = 'AbortError';
  return err;
}

// ---------- 找玩家 / 方块 / 物品 ----------

/** 玩家的实体（看得见才有：太远或不在同一维度时为 null） */
export function findPlayerEntity(bot, playerName) {
  return bot.players[playerName]?.entity ?? null;
}

export function distanceTo(bot, position) {
  return Math.round(bot.entity.position.distanceTo(position));
}

export function formatPosition(position) {
  return `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`;
}

const NEIGHBORS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** 方块至少有一面露在外面（挨着空气、草、水这类没有碰撞箱的方块）；完全埋在地下的返回 false */
export function isExposed(bot, position) {
  return NEIGHBORS.some(([dx, dy, dz]) => bot.blockAt(position.offset(dx, dy, dz))?.boundingBox === 'empty');
}

// 大模型常用的笼统说法 → 具体的方块 ID
const BLOCK_ALIASES = {
  log: (name) => name.endsWith('_log') && !name.startsWith('stripped_'),
  wood: (name) => name.endsWith('_log') && !name.startsWith('stripped_'),
  ore: (name) => name.endsWith('_ore'),
  leaves: (name) => name.endsWith('_leaves'),
};

/**
 * 把“oak_log / log / logs / 小写大写”之类的说法解析成具体的方块 ID 列表。
 * 规则：完全一致 > 别名（log = 所有原木） > 以 _名字 结尾（iron → iron_ore 不算，必须是 _ore 这种完整后缀）
 */
export function resolveBlockNames(bot, query) {
  const all = Object.keys(bot.registry.blocksByName);
  const name = normalizeName(query);
  if (bot.registry.blocksByName[name]) return [name];
  const singular = name.replace(/s$/, '');
  if (bot.registry.blocksByName[singular]) return [singular];
  const alias = BLOCK_ALIASES[name] ?? BLOCK_ALIASES[singular];
  if (alias) return all.filter(alias);
  return all.filter((blockName) => blockName.endsWith(`_${singular}`));
}

/** 在背包里按名字找物品：完全一致优先，其次以 _名字 结尾，再其次包含 */
export function findInventoryItem(bot, query) {
  const name = normalizeName(query);
  const items = bot.inventory.items();
  return (
    items.find((item) => item.name === name) ??
    items.find((item) => item.name === name.replace(/s$/, '')) ??
    items.find((item) => item.name.endsWith(`_${name.replace(/s$/, '')}`)) ??
    items.find((item) => item.name.includes(name.replace(/s$/, ''))) ??
    null
  );
}

/** 某种物品在背包里一共有几个（同名物品可能分在好几格） */
export function countItem(bot, itemName) {
  return bot.inventory
    .items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
}

/** 背包快照 { 物品名: 数量 }，用来算“干完活多了什么” */
export function inventorySnapshot(bot) {
  const counts = {};
  for (const item of bot.inventory.items()) {
    counts[item.name] = (counts[item.name] ?? 0) + item.count;
  }
  return counts;
}

/** 两次快照的差：返回“oak_log x5、apple x1”这样的文字，没有变化返回空字符串 */
export function describeGain(before, after) {
  return Object.entries(after)
    .map(([name, count]) => [name, count - (before[name] ?? 0)])
    .filter(([, gained]) => gained > 0)
    .map(([name, gained]) => `${name} x${gained}`)
    .join('、');
}

function normalizeName(query) {
  return String(query ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/\s+/g, '_');
}
