import { loadStrategyState, saveStrategyState } from '../strategy/state.js';
import { startSurvival } from '../strategy/index.js';
import { inspectFarm } from '../farming/system.js';
import { FARM_DEFAULTS, farmSettings, validateFarmSettings } from '../farming/settings.js';

async function currentState(bot) {
  return bot.strategySupervisor?.active ? bot.strategySupervisor.state
    : bot.supplySupervisor?.active ? bot.supplySupervisor.state : loadStrategyState(bot);
}

export const farmingActions = [
  {
    name: 'inspect_farm',
    description: '只读查看自有农田的尺寸、成熟率、缺苗、损坏、缺水、未加载地块，以及仓储最近观察；不将未加载区域当作空地。',
    parameters: { type: 'object', properties: {} },
    async run({ bot }) {
      const state = await currentState(bot);
      return JSON.stringify({ settings: farmSettings({ bot, state }), farm: state.farm ? {
        id: state.farm.id, origin: state.farm.origin, width: state.farm.width, depth: state.farm.depth,
        status: state.farm.status, report: inspectFarm(bot, state.farm), harvestCycles: state.farm.harvestCycles,
        lastMorningInspectionDay: state.farm.lastMorningInspectionDay, repairErrors: state.farm.repairErrors,
      } : null, storage: state.storage, storageObservation: '箱内内容为最近实际打开时的快照，不是实时透视' });
    },
  },
  {
    name: 'configure_farm',
    description: '配置当前世界、当前 Agent 的农场。width/depth 为新田起始占地，已有农田用 manage_farm expand 增大，不缩小旧田。成熟率默认 0.9；storageMode 仅决定新建仓储的位置。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      width: { type: 'integer', minimum: 1, maximum: 32 }, depth: { type: 'integer', minimum: 1, maximum: 32 },
      maxWidth: { type: 'integer', minimum: 1, maximum: 32 }, maxDepth: { type: 'integer', minimum: 1, maximum: 32 },
      expansionStep: { type: 'integer', minimum: 1, maximum: 8 }, expansionDays: { type: 'integer', minimum: 1 },
      autoExpand: { type: 'boolean' }, harvestRatio: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
      inspectionTicks: { type: 'integer', minimum: 100 }, storageMode: { type: 'string', enum: ['shed', 'home'] },
      storageChests: { type: 'integer', minimum: 1, maximum: 32 }, maxStorageChests: { type: 'integer', minimum: 1, maximum: 32 },
      storageDirection: { type: 'string', enum: ['back', 'up', 'down'] },
    } },
    async run({ bot }, changes) {
      for (const key of Object.keys(changes)) if (!Object.hasOwn(FARM_DEFAULTS, key)) throw new Error(`未知农场配置 ${key}`);
      const state = await currentState(bot);
      const value = validateFarmSettings({ ...farmSettings({ bot, state }), ...changes });
      state.farmConfig = value;
      if (state.farm) state.farm.wakeInspectionPending = true;
      await saveStrategyState(bot, state);
      return JSON.stringify({ settings: value, note: '不拆改已有尺寸或迁移已有箱子，下次巡检使用新规则' });
    },
  },
  {
    name: 'manage_farm',
    description: '让自主生存执行建田/巡检(tend)、渐进扩田(expand)、整理仓储(store)。没有田时自动选址建田；危险、饥饿和夜间避难优先。扩建可以指定新总宽深，不重建旧田。',
    parameters: { type: 'object', properties: {
      operation: { type: 'string', enum: ['tend', 'expand', 'store'] },
      width: { type: 'integer', minimum: 1, maximum: 32 }, depth: { type: 'integer', minimum: 1, maximum: 32 },
    } },
    run({ bot, tasks, player, isWhisper }, { operation = 'tend', width, depth }) {
      if (bot.autonomyOptions?.allowDig === false) return 'NPC_ALLOW_DIG=false，不能启动需要采集和建设的自主农场';
      if (!['tend', 'expand', 'store'].includes(operation)) throw new Error('未知农场操作');
      for (const size of [width, depth]) if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 32)) throw new Error('农田尺寸为 1～32');
      bot.farmRequest = { operation, ...(width === undefined ? {} : { width }), ...(depth === undefined ? {} : { depth }) };
      if (!bot.strategySupervisor?.active || tasks.current?.kind !== 'autonomy') startSurvival({ bot, tasks, owner: player, isWhisper });
      return '农场操作已加入自主生存计划；会先处理紧急生存需求，再在当前步骤结束后执行';
    },
  },
];
