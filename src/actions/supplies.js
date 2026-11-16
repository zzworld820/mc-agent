import { loadStrategyState } from '../strategy/state.js';
import { readSupplyInventory } from '../supplies/inventory.js';
import { assessSupplies } from '../supplies/assessment.js';
import { prepareTaskSupplies } from '../supplies/planner.js';

async function currentState(bot) {
  return bot.strategySupervisor?.active ? bot.strategySupervisor.state
    : bot.supplySupervisor?.active ? bot.supplySupervisor.state : loadStrategyState(bot);
}

const taskProperties = {
  profile: { type: 'string', enum: ['local', 'travel', 'mining', 'expedition'] },
  destination: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
  expectedMinutes: { type: 'number', minimum: 0, maximum: 180 },
  needsLight: { type: 'boolean' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] },
};

export const supplyActions = [
  {
    name: 'inspect_supplies',
    description: '查看身体、随身正常/应急口粮、已知自有仓库最近库存、加工原料、任务补给缺口及暂停原因。仓库快照不是实时库存，未来作物不算现成口粮。',
    parameters: { type: 'object', properties: taskProperties },
    async run({ bot }, task = {}) {
      const state = await currentState(bot);
      return JSON.stringify({ assessment: assessSupplies(bot, state, Object.keys(task).length ? task : state.supplies?.activeTask || {}),
        inventory: readSupplyInventory(bot, state), pausedTask: state.supplies?.pausedTask || state.supplies?.pausedGoal || null,
        productionDebt: state.supplies?.productionDebt || {}, lastMeal: state.supplies?.lastMeal || null });
    },
  },
  {
    name: 'prepare_supplies',
    description: '按任务类型主动备足食物；挖矿或 needsLight 时准备火把和工具，中高风险任务检查武器，高风险任务再检查基础防具。优先取自己的库存，缺粮保持暂停而不假称准备完成。此工具只准备，不执行探险。',
    parameters: { type: 'object', properties: taskProperties },
    run({ bot, tasks, player, isWhisper, supplyResume }, args = {}) {
      const { profile = 'local', destination, expectedMinutes = 0, needsLight = false, risk = 'low' } = args;
      if (!['local', 'travel', 'mining', 'expedition'].includes(profile) || !['low', 'medium', 'high'].includes(risk)
        || !Number.isFinite(expectedMinutes) || expectedMinutes < 0 || expectedMinutes > 180) throw new Error('任务补给参数无效');
      if (destination && ![destination.x, destination.y, destination.z].every(Number.isFinite)) throw new Error('目的地需要完整的 x/y/z');
      const task = { profile, destination, expectedMinutes, needsLight, risk };
      tasks.start({ label: '准备生存补给', kind: 'supply', owner: player, isWhisper, report: 'always',
        supply: { ...task, resumePosition: supplyResume, descriptor: { action: 'prepare_supplies', args: task } } }, async ({ survivalState, supplyContext }) => {
        if (!assessSupplies(bot, survivalState, task).ready) await prepareTaskSupplies(supplyContext, task);
        const assessment = assessSupplies(bot, survivalState, task);
        return JSON.stringify({ ready: assessment.ready, assessment });
      });
      return '开始检查并准备补给，完成后会报告；可以随时叫停';
    },
  },
  {
    name: 'resume_supply_task',
    description: '显式恢复因补给而暂停、或随后被叫停的可恢复任务。重新检查补给；采集只执行剩余数量，建造沿用工程检查点。不会重放赠送物品等不可重复操作。',
    parameters: { type: 'object', properties: {} },
    async run({ bot, runAction }) {
      if (bot.supplySupervisor?.active) return '当前任务仍由补给层管理，补给完成后会自动继续，不重复启动';
      const state = await currentState(bot);
      const saved = state.supplies?.pausedTask;
      const descriptor = saved?.descriptor;
      const supported = ['collect_block', 'build_house', 'build_shelter', 'expand_house', 'go_to', 'come_to_player', 'follow_player', 'prepare_supplies', 'attack_mob'];
      if (!descriptor || !supported.includes(descriptor.action)) return '没有记录可恢复的手动补给任务；自主生存的目标由其自身循环恢复';
      const args = structuredClone(descriptor.args);
      if (descriptor.action === 'collect_block') {
        args.count = Math.max(0, args.count - (saved.progress?.dug || 0));
        if (!args.count) return '记录的采集数量已经完成，不重复采集';
      }
      return runAction(descriptor.action, args, saved.position);
    },
  },
];
