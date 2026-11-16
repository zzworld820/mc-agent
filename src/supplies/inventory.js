import { countItem } from '../actions/helpers.js';
import { MEAT } from '../autonomy/knowledge.js';
import { supplySettings } from './profiles.js';

const UNSAFE = new Set(['spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'chorus_fruit', 'suspicious_stew']);
const PROPAGULES = new Set(['potato', 'carrot']);

export function foodKind(bot, name) {
  if (!bot.registry.foodsByName[name] || UNSAFE.has(name)) return null;
  return name === 'rotten_flesh' ? 'emergency' : 'regular';
}

export function productionReserve(state, name) {
  if (!PROPAGULES.has(name)) return 0;
  const block = name === 'potato' ? 'potatoes' : 'carrots';
  return Math.max(2, state?.farm?.plots.filter((plot) => plot.crop === block).length || 0);
}

export function availableFoodCount(bot, state, name, count, { emergency = false } = {}) {
  return foodKind(bot, name) ? Math.max(0, count - (emergency ? 0 : productionReserve(state, name))) : 0;
}

export function carriedFood(bot, state = null, { emergency = false } = {}) {
  const counts = {};
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] || 0) + item.count;
  let regular = 0;
  let fallback = 0;
  for (const [name, count] of Object.entries(counts)) {
    const kind = foodKind(bot, name);
    const points = bot.registry.foodsByName[name]?.foodPoints || 0;
    const available = availableFoodCount(bot, state, name, count, { emergency });
    if (kind === 'regular') regular += available * points;
    if (kind === 'emergency') fallback += available * points;
  }
  return { regular, emergency: fallback };
}

export function shouldEat(bot) {
  const settings = supplySettings(bot);
  return bot.food < settings.eatBelow || bot.health < settings.hurtBelow && bot.food < 20;
}

export function chooseFood(bot, state = null) {
  const policy = supplySettings(bot);
  const urgent = bot.food <= policy.emergencyBelow || bot.health <= 6 && bot.food < policy.eatBelow;
  const candidates = bot.inventory.items().filter((item) => foodKind(bot, item.name) === 'regular')
    .filter((item) => availableFoodCount(bot, state, item.name, countItem(bot, item.name), { emergency: urgent }) > 0);
  const need = 20 - bot.food;
  candidates.sort((a, b) => {
    const aPoints = bot.registry.foodsByName[a.name].foodPoints;
    const bPoints = bot.registry.foodsByName[b.name].foodPoints;
    return Math.abs(aPoints - need) - Math.abs(bPoints - need);
  });
  if (candidates.length) return candidates[0];
  if (urgent && policy.allowRottenFlesh) return bot.inventory.items().find((item) => item.name === 'rotten_flesh') || null;
  return null;
}

export function knownSupplyChests(state, dimension) {
  const chests = [...(state.storage?.dimension === dimension ? state.storage.chests.map((chest) => ({ chest, mode: state.storage.mode })) : []),
    ...(state.supplies?.warehouses || []).filter((chest) => chest.dimension === dimension).map((chest) => ({ chest, mode: chest.mode }))];
  const seen = new Set();
  return chests.filter(({ chest }) => {
    const key = `${chest.position.x},${chest.position.y},${chest.position.z}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function readSupplyInventory(bot, state) {
  const policy = supplySettings(bot);
  const pack = carriedFood(bot, state);
  const seenContainers = new Set();
  const stores = knownSupplyChests(state, String(bot.game.dimension)).map(({ chest, mode }) => {
    const duplicate = chest.containerKey && seenContainers.has(chest.containerKey);
    if (chest.containerKey) seenContainers.add(chest.containerKey);
    const contents = duplicate ? [] : chest.snapshot || [];
    const regularPoints = contents.filter((item) => foodKind(bot, item.name) === 'regular')
      .reduce((sum, item) => sum + item.count * bot.registry.foodsByName[item.name].foodPoints, 0);
    return { id: chest.id, position: chest.position, mode, regularPoints, duplicate: !!duplicate,
      observedAt: chest.observedAt || null, stale: !chest.observedAt || Date.now() - chest.observedAt > policy.snapshotMaxAgeMs,
      access: chest.missing ? 'missing' : 'unverified', retryAt: state.supplies?.sourceFailures?.[chest.id]?.retryAt || 0 };
  });
  const raw = Object.values(MEAT).map(({ raw: name, cooked }) => ({ name, count: countItem(bot, name), output: cooked }))
    .filter((item, i, items) => item.count && items.findIndex((entry) => entry.name === item.name) === i);
  return { carried: pack, stores, processing: { wheat: countItem(bot, 'wheat'), rawMeat: raw,
    fuelObserved: bot.inventory.items().filter((item) => ['coal', 'charcoal'].includes(item.name) || item.name.endsWith('_planks')).map((item) => ({ name: item.name, count: item.count })) },
    farm: state.farm ? { id: state.farm.id, position: state.farm.origin,
      lastInspection: state.farm.lastInspection || null, note: '成熟作物仍需收割；未成熟作物不计入口粮' } : null };
}
