// 自主模式入口；默认生存循环，可显式选择旧里程碑路线。
import { startAutonomy } from '../autonomy/index.js';

/** @type {import('./index.js').Action[]} */
export const autonomyActions = [
  {
    name: 'start_autonomy',
    description:
      '开始持续自主生存：优先危险、食物和恢复，再推进工具、住所、农田及鸡牛羊牧场，条件不足则暂缓并重新观察。' +
      '默认 survival；明确要求旧版装备/下界路线时可用 milestones。玩家说停下可以取消，不会自动重启。',
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['survival', 'milestones'] } } },
    run({ bot, tasks, player, isWhisper }, { mode = 'survival' } = {}) {
      return startAutonomy({ bot, tasks, owner: player, isWhisper, mode });
    },
  },
];
