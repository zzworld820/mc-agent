export const FARM_DEFAULTS = {
  width: 3, depth: 2, maxWidth: 15, maxDepth: 15, expansionStep: 2,
  autoExpand: true, expansionDays: 2, harvestRatio: 0.9, inspectionTicks: 1200,
  storageMode: 'shed', storageChests: 2, maxStorageChests: 12, storageDirection: 'up',
};

export function validateFarmSettings(settings) {
  const value = { ...FARM_DEFAULTS, ...settings };
  for (const field of ['width', 'depth', 'maxWidth', 'maxDepth']) {
    if (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 32) throw new Error(`${field} 必须为 1～32 的整数`);
  }
  if (value.maxWidth < value.width || value.maxDepth < value.depth) throw new Error('农场最大尺寸不能小于初始尺寸');
  if (!Number.isInteger(value.expansionStep) || value.expansionStep < 1 || value.expansionStep > 8) throw new Error('扩建步长为 1～8');
  if (!Number.isInteger(value.expansionDays) || value.expansionDays < 1) throw new Error('扩建间隔至少一个游戏日');
  if (!Number.isFinite(value.harvestRatio) || value.harvestRatio <= 0 || value.harvestRatio > 1) throw new Error('收割成熟率必须在 (0,1]');
  if (!Number.isInteger(value.inspectionTicks) || value.inspectionTicks < 100) throw new Error('巡检间隔至少 100 游戏刻');
  if (typeof value.autoExpand !== 'boolean') throw new Error('autoExpand 必须是布尔值');
  if (!['home', 'shed'].includes(value.storageMode)) throw new Error('储存方式为 home 或 shed');
  if (!['back', 'up', 'down'].includes(value.storageDirection)) throw new Error('仓储扩建方向为 back/up/down');
  if (![value.storageChests, value.maxStorageChests].every((n) => Number.isInteger(n) && n >= 1 && n <= 32)
    || value.maxStorageChests < value.storageChests) throw new Error('箱子数量为 1～32，上限不小于初始值');
  return value;
}

export function farmSettings(ctx) {
  return validateFarmSettings({ ...ctx.bot.farmOptions, ...ctx.state.farmConfig });
}

export function gameClock(bot) {
  const age = bot.time?.age == null ? NaN : Number(bot.time.age);
  if (Number.isFinite(age) && age >= 0) return Math.floor(age);
  const day = Number(bot.time?.day);
  const time = Number(bot.time?.timeOfDay);
  return Number.isFinite(day) && Number.isFinite(time) ? Math.floor(day * 24000 + time) : null;
}

export function gameDay(bot) {
  return Number.isFinite(bot.time?.day) ? bot.time.day : Math.floor((gameClock(bot) ?? 0) / 24000);
}
