export const SUPPLY_DEFAULTS = {
  eatBelow: 18, interruptBelow: 12, emergencyBelow: 6, hurtBelow: 14,
  localFood: 16, localMinimum: 8, travelFood: 40, miningFood: 40,
  expeditionFood: 48, miningTorches: 24, minimumTorches: 8,
  snapshotMaxAgeMs: 120000, failedSourceCooldownMs: 60000,
  allowRottenFlesh: true, pointsPerMinute: 1.2, pointsPerBlock: 0.08,
};

export function supplySettings(bot) {
  return { ...SUPPLY_DEFAULTS, ...bot.supplyOptions };
}

export function validateSupplySettings(settings) {
  const value = { ...SUPPLY_DEFAULTS, ...settings };
  for (const [name, number] of Object.entries(value)) {
    if (name === 'allowRottenFlesh') {
      if (typeof number !== 'boolean') throw new Error('allowRottenFlesh 必须为布尔值');
    } else if (!Number.isFinite(number) || number <= 0) throw new Error(`补给配置 ${name} 必须为正数`);
  }
  if (!(value.emergencyBelow < value.interruptBelow && value.interruptBelow < value.eatBelow && value.eatBelow <= 20)
    || value.hurtBelow > 20) throw new Error('补给阈值应满足 0 < 紧急 < 打断 < 进食 <= 20');
  if (value.localMinimum >= Math.min(value.localFood, value.travelFood, value.miningFood, value.expeditionFood)) throw new Error('目标口粮必须大于最低余量');
  if (value.minimumTorches >= value.miningTorches) throw new Error('目标火把数量必须大于最低余量');
  if (!Number.isInteger(value.minimumTorches) || !Number.isInteger(value.miningTorches)) throw new Error('火把预算必须为整数');
  return value;
}

/** 预算是保守估计，不把它冒充真实耗尽时间；目的地和持续时间未知时用类型基线。 */
export function taskBudget(bot, task = {}) {
  const policy = supplySettings(bot);
  const profile = task.profile || 'local';
  const destination = task.destination;
  const distance = destination ? bot.entity.position.distanceTo(destination) : 0;
  const minutes = Math.max(0, task.expectedMinutes || 0);
  const base = profile === 'mining' ? policy.miningFood : profile === 'expedition' ? policy.expeditionFood
    : profile === 'travel' ? policy.travelFood : policy.localFood;
  const foodTarget = Math.ceil(Math.max(base, distance * 2 * policy.pointsPerBlock + minutes * policy.pointsPerMinute + policy.localMinimum));
  const needsLight = profile === 'mining' || task.needsLight === true;
  return { profile, foodTarget, foodMinimum: Math.max(policy.localMinimum, Math.ceil(foodTarget / 3)),
    torches: needsLight ? Math.max(policy.miningTorches, Math.ceil(minutes)) : 0,
    minimumTorches: needsLight ? policy.minimumTorches : 0,
    tool: task.tool || (profile === 'mining' ? 'stone_pickaxe' : null),
    weapon: ['medium', 'high'].includes(task.risk) ? 'stone_sword' : null,
    armorRequired: task.risk === 'high', destination: destination || null,
    estimate: 'heuristic_not_guaranteed_range' };
}
