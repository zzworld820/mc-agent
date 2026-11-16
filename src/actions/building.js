// 建造动作：只在开启自主能力时暴露，避免公网陪玩模式被模型随意改造地形。
import { buildHouse, buildShelter, expandHouse } from '../autonomy/skills/build.js';
import { obtain } from '../autonomy/planner.js';
import { throwIfAborted, useMovementProfile } from './helpers.js';
import { listHouseModels } from '../building/models.js';
import { listHouseProjects } from '../building/projects.js';

// 新建造任务等待被取消的旧建造任务退出，避免同一工程被两个任务交错写入。
let pendingBuild = Promise.resolve();

function runBuildingTask(bot, task, work) {
  const operation = pendingBuild.then(async () => {
    throwIfAborted(task.signal);
    useMovementProfile(bot, 'free');
    try {
      return await work(makeBuildContext(bot, task));
    } finally {
      useMovementProfile(bot, 'safe');
    }
  });
  pendingBuild = operation.catch(() => {});
  return operation;
}

/** @type {import('./index.js').Action[]} */
export const buildingActions = [
  {
    name: 'list_house_models',
    description: '查询可施工房屋模型：返回模型 ID、版本、外观特征、用途、材料阶段、尺寸、家具目标和扩建模块。先据此区分模型，再建造。家具目标不保证材料不足时全部放齐。',
    parameters: { type: 'object', properties: {} },
    async run() {
      return JSON.stringify(await listHouseModels());
    },
  },
  {
    name: 'list_house_projects',
    description: '查询当前服务器和维度内的房屋工程 ID、坐标、模型、未完成工程及各段扩建状态，用于继续施工或选择扩建对象。',
    parameters: { type: 'object', properties: {} },
    async run({ bot }) {
      return JSON.stringify((await listHouseProjects(bot)).map((project) => ({
        projectId: project.id, modelId: project.model.id, modelVersion: project.model.version,
        origin: project.origin, status: project.status,
        extensions: project.extensions.map((entry) => ({ moduleId: entry.module.id, origin: entry.origin, status: entry.status })),
      })));
    },
  },
  {
    name: 'build_shelter',
    description:
      '建造一个低成本山洞避难所：寻找附近山体，挖出小房间，安装木门和火把，并尝试放置工作台和熔炉。' +
      '只在玩家明确要求建避难所、挖山洞或找地方过夜时使用。会持续一段时间，玩家说停下可以取消。',
    parameters: { type: 'object', properties: {} },
    run({ bot, tasks, player, isWhisper, supplyResume }) {
      tasks.start({ label: '建造山洞避难所', kind: 'build', owner: player, isWhisper, report: 'always',
        supply: { profile: 'local', resumePosition: supplyResume, descriptor: { action: 'build_shelter', args: {} } } }, async (task) => {
        return runBuildingTask(bot, task, async (ctx) => {
          const result = await buildShelter(ctx, { resultDetails: true });
          if (ctx.state.partition && !ctx.state.home) {
            ctx.state.home = { ...result.position, door: result.door, dimension: String(bot.game.dimension), kind: 'cave' };
            await ctx.checkpoint();
          }
          return result.message;
        });
      });
      return '开始寻找山体并建造低成本避难所';
    },
  },
  {
    name: 'build_house',
    description:
      '按模型 ID 建造可扩展房屋，默认 starter 生存小屋；先用 list_house_models 区分模型特征。保留旧 style 参数兼容。' +
      '会先自动检查并采集材料，只在玩家明确要求建房子或小屋时使用。',
    parameters: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'list_house_models 返回的模型 ID，默认 starter' },
        style: { type: 'string', description: '旧版模型 ID 参数，优先使用 modelId' },
      },
    },
    run({ bot, tasks, player, isWhisper, supplyResume }, { style = 'starter', modelId = style }) {
      tasks.start({ label: '建造基础小屋', kind: 'build', owner: player, isWhisper, report: 'always',
        supply: { profile: 'local', resumePosition: supplyResume, descriptor: { action: 'build_house', args: { modelId } } } }, async (task) => {
        return runBuildingTask(bot, task, async (ctx) => {
          const result = await buildHouse(ctx, { modelId, resultDetails: true });
          if (ctx.state.partition && !ctx.state.house) {
            ctx.state.house = { projectId: result.projectId };
            ctx.state.home = { ...result.position, door: result.door, dimension: String(bot.game.dimension), kind: 'house' };
            await ctx.checkpoint();
          }
          return result.message;
        });
      });
      return '开始规划基础小屋，会先准备材料再施工';
    },
  },
  {
    name: 'expand_house',
    description:
      '按工程所属模型的扩建模块继续追加房间，保留原主体；重复扩建会接到上一段后面，中断后先继续未完成模块。' +
      '如果找不到完整且安全的扩建地基，停止并说明原因，不会拆掉整栋房子。',
    parameters: { type: 'object', properties: {
      modelId: { type: 'string', description: '可选，限定房屋模型 ID' },
      moduleId: { type: 'string', description: '可选，模型目录中的扩建模块 ID' },
      projectId: { type: 'string', description: '可选，从 list_house_projects 选择工程；省略时选附近最近的匹配工程' },
      direction: { type: 'string', enum: ['back', 'up', 'down'], description: '向后追加翼房、向上加层或向下建地下室；默认 back，垂直层用梯井连接' },
    } },
    run({ bot, tasks, player, isWhisper, supplyResume }, args) {
      tasks.start({ label: '扩建基础小屋', kind: 'build', owner: player, isWhisper, report: 'always',
        supply: { profile: args.direction === 'down' ? 'mining' : 'local', needsLight: args.direction === 'down', resumePosition: supplyResume,
          descriptor: { action: 'expand_house', args } } }, async (task) => {
        return runBuildingTask(bot, task, (ctx) => expandHouse(ctx, args));
      });
      return '开始检查现有小屋，并规划不拆主体的扩建';
    },
  },
];

function makeBuildContext(bot, task) {
  if (task.supplyContext) return task.supplyContext;
  const state = { unreachable: new Map(), stage: '建造' };
  const setProgress = task.setProgress ?? (() => {});
  const ctx = {
    bot,
    signal: task.signal,
    state,
    depth: 0,
    log(text) {
      setProgress(text);
    },
  };
  // 建造动作复用自主规划器的递归采集能力；保持同一个 ctx，确保递归 obtain 可继续工作。
  ctx.obtain = (item, count) => obtain(ctx, item, count);
  return ctx;
}
