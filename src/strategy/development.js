import { ownedCount, hasAtLeast } from '../autonomy/planner.js';
import { foodKind, knownSupplyChests } from '../supplies/inventory.js';
import { taskBudget } from '../supplies/profiles.js';

export const IRON_EQUIPMENT = [
  'iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_shovel', 'iron_hoe',
  'iron_chestplate', 'iron_helmet', 'iron_boots', 'iron_leggings', 'shield',
];

export function developmentSettings(bot, state) {
  const settings = { recoveryKits: 5, foodPerKit: 64, logs: 32, stone: 128, spareIron: 16,
    homeChests: 4, continueAfterIron: false, ...bot.developmentOptions, ...state.developmentConfig };
  for (const [name, value] of Object.entries(settings)) {
    if (name === 'continueAfterIron') {
      if (typeof value !== 'boolean') throw new Error('continueAfterIron 必须是布尔值');
      continue;
    }
    if (!Number.isInteger(value) || value < 1 || value > 4096) throw new Error(`发育配置 ${name} 应为1～4096的整数`);
  }
  if (settings.homeChests > 32) throw new Error('基地箱子目标最多32个');
  return settings;
}

// 只统计实际开过的容器快照。同一双箱只记一次，缺失箱子不计库存。
export function storedResources(bot, state, { freshOnly = true } = {}) {
  const items = {};
  const containers = new Set();
  const active = new Set((state.storage?.chests || []).map((chest) => chest.id));
  for (const { chest } of knownSupplyChests(state, String(bot.game.dimension))) {
    if (!active.has(chest.id)) continue;
    if (freshOnly && chest.verificationError) continue;
    if (chest.missing || !chest.observedAt || freshOnly && Date.now() - chest.observedAt > 120000) continue;
    const key = chest.containerKey || `${chest.position.x},${chest.position.y},${chest.position.z}`;
    if (containers.has(key)) continue;
    containers.add(key);
    for (const item of chest.snapshot || []) {
      const durable = item.maxDurability || bot.registry.itemsByName[item.name]?.maxDurability;
      if (durable && durable - (item.durabilityUsed || 0) < 32) continue;
      items[item.name] = (items[item.name] || 0) + item.count;
    }
  }
  const food = Object.entries(items).filter(([name]) => foodKind(bot, name) === 'regular')
    .reduce((sum, [name, count]) => sum + bot.registry.foodsByName[name].foodPoints * count, 0);
  const logs = Object.entries(items).filter(([name]) => name.endsWith('_log')).reduce((sum, [, count]) => sum + count, 0);
  return { items, food, logs, stone: items.cobblestone || 0 };
}

export function developmentStatus(bot, state) {
  const settings = developmentSettings(bot, state);
  const stored = storedResources(bot, state);
  const foodTarget = settings.recoveryKits * settings.foodPerKit;
  const base = state.base?.ready && state.base.projectId === state.house?.projectId;
  const basicReserves = stored.logs >= settings.logs && stored.stone >= settings.stone
    && ['stone_pickaxe', 'stone_axe', 'stone_sword'].every((item) => (stored.items[item] || 0) >= 1);
  const foodReady = stored.food >= foodTarget;
  const ironReady = IRON_EQUIPMENT.every((name) => hasAtLeast(bot, name)) && (stored.items.iron_ingot || 0) >= settings.spareIron;
  let stage = 'camp';
  if (state.home?.campReady) stage = 'house';
  if (base) stage = 'reserves';
  if (base && basicReserves) stage = 'farm';
  if (base && basicReserves && state.farm?.harvestCycles > 0) stage = 'food_stock';
  if (base && basicReserves && foodReady && state.farm?.harvestCycles > 0) stage = ironReady ? 'iron_ready' : 'iron';
  return { stage, basicReserves, foodReady, ironReady, foodTarget, stored, settings };
}

export function developmentTask(goal, state) {
  if (['protection', 'iron_reserve'].includes(goal)) return { profile: 'mining', risk: 'medium', tool: 'stone_pickaxe', needsLight: true, goal };
  if (state?.home && !state.farm?.harvestCycles && ['house', 'base', 'camp', 'tools', 'farm', 'storage', 'reserves'].includes(goal)) {
    return { profile: 'local', goal, risk: 'low', constructionHome: { ...state.home } };
  }
  return { profile: 'local', goal };
}

// 随身余量按本次任务保留，建设取料期间由 ctx.materialNeeds 单独保护。
export function carriedReserve(ctx, item) {
  const task = ctx.state.supplies?.activeTask || {};
  const mining = task.profile === 'mining';
  if (ctx.materialNeeds?.has(item.name)) return ctx.materialNeeds.get(item.name);
  if (/_(pickaxe|axe|hoe|shovel|sword)$/.test(item.name)) {
    const tiers = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
    const [tier, kind] = item.name.split('_');
    const better = tiers.slice(tiers.indexOf(tier) + 1).some((name) => ownedCount(ctx.bot, `${name}_${kind}`) > 0);
    return better ? 0 : 1;
  }
  if (/_(helmet|chestplate|leggings|boots)$/.test(item.name) || item.name === 'shield') {
    const equipped = [5, 6, 7, 8, 45].some((slot) => ctx.bot.inventory.slots[slot]?.name === item.name);
    return equipped ? 0 : 1;
  }
  if (item.name === 'torch') return Math.max(8, taskBudget(ctx.bot, task).torches);
  if (['cobblestone', 'dirt'].includes(item.name)) return mining ? 32 : 16;
  if (item.name.endsWith('_log') || item.name.endsWith('_planks')) return mining ? 4 : 8;
  if (['coal', 'charcoal', 'stick'].includes(item.name)) return mining ? 8 : 4;
  return null;
}
