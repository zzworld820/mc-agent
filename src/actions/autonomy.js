// 自主模式入口；默认生存循环，可显式选择旧里程碑路线。
import { startAutonomy } from '../autonomy/index.js';

/** @type {import('./index.js').Action[]} */
export const autonomyActions = [
  {
    name: 'start_autonomy',
    description:
      '开始持续自主生存：优先危险、食物和恢复，按采木、临时山洞和箱子、带床与多箱的正式基地、备用物资、农业存粮、铁装备和备用铁推进，条件不足则补齐当前阶段。' +
      '默认 survival；明确要求旧版装备/下界路线时可用 milestones。玩家说停下可以取消，不会自动重启。',
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['survival', 'milestones'] } } },
    run({ bot, tasks, player, isWhisper }, { mode = 'survival' } = {}) {
      return startAutonomy({ bot, tasks, owner: player, isWhisper, mode });
    },
  },
];
