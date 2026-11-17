// 快速、确定性的风险判断；不依赖模型请求，也不把附近的中立动物当作敌人。
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { goTo, haltBot, sleep, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { isFightable, equipBestWeapon } from '../actions/combat.js';
import { reachHome } from './navigation.js';

const { goals } = pathfinderPkg;
const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow']);
const EXTRA_THREATS = new Set(['warden', 'wither', 'ender_dragon', 'elder_guardian', 'piglin_brute', 'creaking']);
const PROJECTILES = new Set(['arrow', 'spectral_arrow', 'fireball', 'small_fireball', 'wither_skull', 'shulker_bullet']);
const previous = new WeakMap();
const BASIC_MELEE = new Set(['zombie', 'zombie_villager', 'husk', 'spider', 'silverfish', 'endermite']);
const AIR = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'fern']);

function exposed(bot, entity) {
  const from = bot.entity.position.offset(0, 1.5, 0);
  const to = entity.position.offset(0, Math.min(entity.height || 1, 1.5), 0);
  const difference = to.minus(from);
  const distance = difference.norm();
  if (bot.world?.raycast && distance > 0) return !bot.world.raycast(from, difference.scaled(1 / distance), distance);
  const steps = Math.max(1, Math.ceil(difference.norm() * 2));
  for (let i = 1; i < steps; i++) {
    const block = bot.blockAt(from.plus(difference.scaled(i / steps)));
    if (!block || block.boundingBox === 'block') return false;
  }
  return true;
}

export function readDanger(bot) {
  const position = bot.entity.position;
  const now = Date.now();
  const old = previous.get(bot);
  const lastSeen = new Map(old?.lastSeen);
  const threats = Object.values(bot.entities).filter((entity) => entity !== bot.entity
    && (isFightable(entity) || EXTRA_THREATS.has(entity.name)) && entity.position.distanceTo(position) <= 24)
    .map((entity) => {
      const distance = entity.position.distanceTo(position);
      const visible = distance <= 16 && exposed(bot, entity);
      if (visible) lastSeen.set(entity.id, now);
      const remembered = now - (lastSeen.get(entity.id) ?? 0) < 10000;
      if (!visible && !remembered && !(entity.name === 'creeper' && distance < 7)) return null;
      return { id: entity.id, name: entity.name, position: entity.position.clone(), distance, visible,
        approaching: old?.distances.has(entity.id) ? old.distances.get(entity.id) - distance > 0.3 : false };
    }).filter(Boolean);
  const armorCoverage = [5, 6, 7, 8].filter((slot) => bot.inventory.slots[slot]).length;
  const projectileHistory = new Map();
  const projectiles = Object.values(bot.entities).filter((entity) => {
    if (!PROJECTILES.has(entity.name) || entity.position.distanceTo(position) > 10 || !entity.velocity) return false;
    const last = old?.projectileHistory?.get(entity.id);
    const movedAt = !last || entity.position.distanceTo(last.position) > 0.1 ? now : last.movedAt;
    projectileHistory.set(entity.id, { position: entity.position.clone(), movedAt });
    const toPlayer = position.minus(entity.position);
    return now - movedAt < 1000 && entity.velocity.norm() > 0.05 && entity.velocity.dot(toPlayer) > 0;
  }).slice(0, 12).map((entity) => ({ name: entity.name, position: entity.position.clone(), distance: entity.position.distanceTo(position) }));
  const feet = position.floored();
  const feetBlock = bot.blockAt(feet);
  const head = bot.blockAt(feet.offset(0, 1, 0));
  const below = bot.blockAt(feet.offset(0, -1, 0));
  const inWater = feetBlock?.name === 'water' || head?.name === 'water';
  const oxygen = bot.ownOxygen ?? bot.oxygenLevel ?? 20;
  const burning = Boolean(Number(bot.entity.metadata?.[0] ?? 0) & 1);
  const reasons = [];
  if (projectiles.length) reasons.push('近处来袭投射物');
  if (inWater && oxygen < 8) reasons.push('缺氧');
  if (feetBlock?.name === 'lava' || head?.name === 'lava') reasons.push('身处熔岩');
  if (burning || HAZARDS.has(feetBlock?.name) || HAZARDS.has(below?.name)) reasons.push('火焰或危险接触');
  if ((bot.entity.velocity?.y ?? 0) < -0.7 && !bot.entity.onGround) reasons.push('快速坠落');
  const close = threats.filter((threat) => threat.distance < 9);
  if (threats.some((threat) => threat.name === 'witch' && threat.distance < 12)) reasons.push('女巫进入投掷范围');
  if (threats.some((threat) => ['pillager', 'skeleton', 'stray', 'bogged'].includes(threat.name) && threat.distance < 14)) reasons.push('远程敌人接近');
  if (bot.autonomyOptions?.allowCombat === false && close.some((threat) => threat.distance < 6)) reasons.push('战斗关闭且敌人接近');
  if (close.some((threat) => EXTRA_THREATS.has(threat.name))) reasons.push('高危敌对生物');
  if (close.some((threat) => threat.name === 'creeper' && threat.distance < 7)) reasons.push('苦力怕近距离爆炸风险');
  const nonSuffocatingPanel = head && (head.name.endsWith('_door') || head.name.endsWith('_fence_gate'));
  if (head?.boundingBox === 'block' && !nonSuffocatingPanel) reasons.push('头部被实心方块阻挡');
  const armed = bot.inventory.items().some((item) => /^(stone|iron|diamond|netherite)_(sword|axe)$/.test(item.name));
  const defend = reasons.length === 0 && bot.autonomyOptions?.allowCombat !== false && armorCoverage >= 2 && armed
    && bot.health >= 8 && close.length === 1 && close[0].visible && close[0].distance < 4.5 && BASIC_MELEE.has(close[0].name);
  if (close.length >= 2 && armorCoverage < 3) reasons.push('装备不足且敌人较多');
  if (close.some((threat) => threat.distance < 5 || threat.approaching) && armorCoverage < 2) reasons.push('缺少护甲且敌人接近');
  if (bot.health <= 10 && close.length && !defend) reasons.push('低生命值且附近有敌人');
  const damagedAt = old && bot.health < old.health ? now : old?.damagedAt ?? 0;
  if (now - damagedAt < 3500 && close.length && !defend) reasons.push('持续受伤且未脱离威胁');
  const starvationSuspected = bot.food === 0 && !close.length && !burning && !inWater
    && !HAZARDS.has(feetBlock?.name) && !HAZARDS.has(below?.name);
  if (now - damagedAt < 2000 && bot.health < 12 && !close.length && !starvationSuspected) reasons.push('近期受到来源不明的伤害');
  // 同一时刻多次读取不吞掉接近趋势。
  if (!old || now - old.at >= 400) previous.set(bot, { at: now, health: bot.health, damagedAt,
    distances: new Map(threats.map((threat) => [threat.id, threat.distance])), projectileHistory,
    lastSeen: new Map([...lastSeen].filter(([id, at]) => now - at < 10000 && bot.entities[id])) });
  return { at: now, health: bot.health, food: bot.food, oxygen, armorCoverage, inWater, burning, starvationSuspected,
    threats, projectiles, reasons, defend, retreat: reasons.length > 0, recoveryNeeded: bot.health < 14 };
}

export function safeStanding(bot, position) {
  const feet = position.floored();
  const below = bot.blockAt(feet.offset(0, -1, 0));
  if (below?.boundingBox !== 'block' || HAZARDS.has(below.name)) return false;
  if (!AIR.has(bot.blockAt(feet)?.name) || !AIR.has(bot.blockAt(feet.offset(0, 1, 0))?.name)) return false;
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 1; y++) {
        const block = bot.blockAt(feet.offset(x, y, z));
        if (!block || HAZARDS.has(block.name)) return false;
      }
    }
  }
  return true;
}

function escapeCandidates(bot, danger, home) {
  const feet = bot.entity.position.floored();
  const positions = [];
  if (home && home.dimension === String(bot.game.dimension) && safeStanding(bot, new Vec3(home.x, home.y, home.z))) {
    positions.push(new Vec3(home.x, home.y, home.z));
  }
  for (let x = -12; x <= 12; x += 3) {
    for (let z = -12; z <= 12; z += 3) {
      for (let y = -2; y <= 2; y++) {
        const position = feet.offset(x, y, z);
        if (position.distanceTo(feet) < 4 || !safeStanding(bot, position)) continue;
        positions.push(position);
      }
    }
  }
  const threats = [...danger.threats, ...danger.projectiles];
  const separation = (position) => Math.min(20, ...threats.map((threat) => threat.position.distanceTo(position)));
  return positions.filter((position) => separation(position) >= 5)
    .sort((a, b) => separation(b) - separation(a) || a.distanceTo(feet) - b.distanceTo(feet));
}

export async function evadeDanger(ctx, home) {
  const { bot, signal } = ctx;
  haltBot(bot);
  useMovementProfile(bot, 'safe');
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  let clearSince = 0;
  const deadline = Date.now() + 60000;
  let failedRoutes = 0;
  let triedHome = false;
  let lastSwing = 0;
  await equipBestWeapon(bot);
  const pushAway = () => {
    if (signal.aborted || !bot.entity || bot.health <= 0 || bot.autonomyOptions?.allowCombat === false || Date.now() - lastSwing < 650) return;
    const enemy = bot.nearestEntity((entity) => BASIC_MELEE.has(entity.name) && entity.position.distanceTo(bot.entity.position) < 2.8);
    if (enemy) { lastSwing = Date.now(); bot.attack(enemy); }
  };
  bot.on('physicsTick', pushAway);
  try {
    while (Date.now() < deadline && bot.health > 0) {
      throwIfAborted(signal);
      const danger = readDanger(bot);
      ctx.log(`避险：${danger.reasons.join('、') || '确认周边安全'}`);
      if (!danger.retreat && !danger.threats.some((threat) => threat.distance < 8)) {
        clearSince ||= Date.now();
        if (Date.now() - clearSince >= 5000) return { safe: true };
        await sleep(500, signal);
        continue;
      }
      clearSince = 0;
      if (danger.inWater && danger.oxygen < 12) {
        bot.setControlState('jump', true);
        try { await sleep(1000, signal); } finally { bot.clearControlStates(); }
        continue;
      }
      if (!triedHome && home && home.dimension === String(bot.game.dimension)
        && new Vec3(home.x, home.y, home.z).distanceTo(bot.entity.position) < 48
        && !danger.threats.some((threat) => threat.position.distanceTo(home) < 5)
        && safeStanding(bot, new Vec3(home.x, home.y, home.z))) {
        triedHome = true;
        try { if (await reachHome(ctx, home)) continue; } catch (err) { if (signal.aborted) throw err; }
      }
      if (danger.burning && !danger.inWater) {
        const water = bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 10, count: 40 })
          .find((p) => bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block'
            && AIR.has(bot.blockAt(p.offset(0, 1, 0))?.name)
            && !danger.threats.some((threat) => threat.position.distanceTo(p) < 5));
        if (water) {
          try { await goTo(bot, new goals.GoalBlock(water.x, water.y, water.z), { signal, timeoutMs: 5000 }); continue; }
          catch (err) { if (signal.aborted) throw err; }
        }
      }
      if (bot.pathfinder.movements) {
        bot.pathfinder.movements.exclusionAreasStep = [(block) => HAZARDS.has(block.name)
          || danger.threats.some((threat) => threat.position.distanceTo(block.position) < 3) ? 100 : 0];
      }
      const candidates = escapeCandidates(bot, danger, home);
      let moved = false;
      for (const destination of candidates.slice(0, 4)) {
        try {
          await goTo(bot, new goals.GoalBlock(destination.x, destination.y, destination.z), { signal, timeoutMs: 7000 });
          moved = true;
          break;
        } catch (err) { if (signal.aborted) throw err; }
      }
      if (!moved) {
        failedRoutes++;
        if (failedRoutes >= 3) throw new Error('没有找到可达的安全退路，暂停发展并稍后重新观察');
        await sleep(1000, signal);
      }
    }
    return { safe: false, reason: '避险窗口结束，仍需重新观察' };
  } finally {
    bot.removeListener('physicsTick', pushAway);
    if (!signal.aborted) { bot.clearControlStates(); bot.pathfinder.setGoal(null); }
  }
}
