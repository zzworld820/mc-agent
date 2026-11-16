import { countItem } from '../actions/helpers.js';
import { carriedFood, chooseFood, shouldEat, foodKind, productionReserve } from './inventory.js';
import { supplySettings, taskBudget } from './profiles.js';

function usableTool(bot, name) {
  if (!name) return true;
  const [tier, ...kind] = name.split('_');
  const tiers = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
  const minimum = tiers.indexOf(tier);
  return bot.inventory.items().some((item) => {
    const matches = minimum < 0 ? item.name === name : item.name.endsWith(`_${kind.join('_')}`) && tiers.indexOf(item.name.split('_')[0]) >= minimum;
    if (!matches) return false;
    const maximum = item.maxDurability || bot.registry.itemsByName[item.name]?.maxDurability;
    return !maximum || maximum - (item.durabilityUsed || 0) >= 16;
  });
}

export function shouldPauseForSupplies(bot, state, goal, essentialStep = false) {
  if (['food', 'eat', 'recover', 'supply_wait', 'defend'].includes(goal)) return false;
  const assessment = assessSupplies(bot, state, state.supplies?.activeTask || {});
  if (essentialStep) return assessment.needsMeal && assessment.mealAvailable || bot.food < supplySettings(bot).interruptBelow;
  return assessment.interrupt;
}

export function assessSupplies(bot, state, task = {}) {
  const policy = supplySettings(bot);
  const budget = taskBudget(bot, task);
  const food = carriedFood(bot, state);
  const carried = chooseFood(bot, state);
  const needsMeal = shouldEat(bot);
  const deficit = needsMeal ? Math.max(0, 20 - bot.food) : 0;
  const emergency = bot.food <= policy.emergencyBelow || bot.health <= 6 && bot.food < policy.eatBelow;
  const shortage = food.regular < budget.foodMinimum;
  const hungryWithoutFood = bot.food < policy.interruptBelow && !carried;
  const level = emergency ? 'emergency' : hungryWithoutFood || shortage ? 'insufficient'
    : food.regular < budget.foodTarget ? 'warning' : 'normal';
  const armor = [5, 6, 7, 8].map((slot) => bot.inventory.slots[slot]).filter(Boolean).length;
  const missing = [];
  if (food.regular < budget.foodTarget + deficit) missing.push('food');
  if (countItem(bot, 'torch') < budget.torches) missing.push('torches');
  if (!usableTool(bot, budget.tool)) missing.push('tool');
  if (!usableTool(bot, budget.weapon)) missing.push('weapon');
  if (budget.armorRequired && armor < 2) missing.push('armor');
  return { level, body: { health: bot.health, hunger: bot.food, saturation: bot.foodSaturation ?? null },
    needsMeal, mealAvailable: !!carried, meal: carried?.name || null, food,
    budget, foodTarget: budget.foodTarget + deficit, missing, ready: missing.length === 0 && !needsMeal,
    interrupt: emergency || needsMeal && !!carried || hungryWithoutFood || shortage
      || budget.minimumTorches > 0 && countItem(bot, 'torch') < budget.minimumTorches
      || !usableTool(bot, budget.tool) || !usableTool(bot, budget.weapon) || budget.armorRequired && armor < 2,
    reason: emergency ? '身体需要紧急补给' : needsMeal && carried ? '先短暂停下进食'
      : hungryWithoutFood ? '饥饿且没有可立即食用的口粮' : shortage ? '随身口粮低于任务安全余量'
        : missing.length ? `任务补给缺少：${missing.join('、')}` : '补给充足' };
}

// 仓储和丢弃物资共用的随身预算；数量由当前任务决定，不给每种食物各留一大堆。
export function foodReservations(bot, state, task = state.supplies?.activeTask || {}) {
  const target = taskBudget(bot, task).foodTarget + Math.max(0, 20 - bot.food);
  let remaining = target;
  const reserves = {};
  const names = [...new Set(bot.inventory.items().map((item) => item.name))]
    .filter((name) => foodKind(bot, name) === 'regular')
    .sort((a, b) => Number(['potato', 'carrot'].includes(a)) - Number(['potato', 'carrot'].includes(b))
      || bot.registry.foodsByName[b].foodPoints - bot.registry.foodsByName[a].foodPoints);
  for (const name of names) {
    const seedReserve = productionReserve(state, name);
    const count = Math.min(Math.max(0, countItem(bot, name) - seedReserve), Math.max(0, Math.ceil(remaining / bot.registry.foodsByName[name].foodPoints)));
    reserves[name] = count + seedReserve;
    remaining -= count * bot.registry.foodsByName[name].foodPoints;
  }
  reserves.rotten_flesh = supplySettings(bot).allowRottenFlesh ? 4 : 0;
  return reserves;
}
