// 感知类动作：看看周围、找某种方块、看背包。都是瞬间完成的，不用排任务。
// 大模型自己看不见游戏世界，需要什么信息就调用这些工具“睁眼看”，而不是瞎猜。
import { distanceTo, formatPosition, isExposed, resolveBlockNames } from './helpers.js';
import { scanEnvironment } from '../perception/environment.js';
import { PERCEPTION_TYPES } from '../perception/structures.js';
import { describeLocation, readWorldState } from '../perception/state.js';
import { rememberScene } from '../memory/runtime.js';
import { developmentStatus } from '../strategy/development.js';
import { readDanger } from '../strategy/danger.js';

// look_around 会特别留意的方块（资源点、功能方块、危险方块）
const NOTABLE_BLOCK = (name) =>
  name.endsWith('_log') ||
  name.endsWith('_ore') ||
  ['crafting_table', 'furnace', 'chest', 'barrel', 'bed', 'water', 'lava'].includes(name) ||
  name.endsWith('_bed');

const LOOK_RADIUS = 16;
const MAX_FIND_DISTANCE = 64;

/** @type {import('./index.js').Action[]} */
export const perceptionActions = [
  {
    name: 'assess_danger',
    description: '读取当前生命、饥饿、自己的氧气、护甲覆盖、可见威胁及撤退原因；属于启发式风险判断，不保证路线安全或一定能逃生。',
    parameters: { type: 'object', properties: {} },
    run({ bot }) {
      return JSON.stringify({ ...readDanger(bot), strategy: bot.strategySupervisor ? {
        active: bot.strategySupervisor.active, goal: bot.strategySupervisor.goal,
        pausedGoal: bot.strategySupervisor.pausedGoal, retreating: bot.strategySupervisor.retreating,
        development: developmentStatus(bot, bot.strategySupervisor.state),
        base: bot.strategySupervisor.state.base || null,
      } : null });
    },
  },
  {
    name: 'get_world_state',
    description: '读取自身生命、饥饿、饱和度、氧气、背包、坐标、当前维度和当前位置群系。未知字段返回 null，不猜测。只读，不改变行动策略。',
    parameters: { type: 'object', properties: {} },
    run({ bot }) {
      return JSON.stringify(readWorldState(bot));
    },
  },
  {
    name: 'scan_environment',
    description: '多方块语义感知：识别树木、河流、水域、房屋、村庄、下界要塞、堡垒遗迹、主世界要塞及神殿等候选。' +
      '返回位置、证据范围、置信等级、识别依据和局限。读取已加载客户端区块，不是纯视线，也不会探索未加载区域。' +
      '仅感知，不会移动、砍树、挖矿、存物品；结构候选不代表天然生成、归属或内部已探索。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['all', ...PERCEPTION_TYPES.map((entry) => entry.type)],
          description: `默认 all；类型：${PERCEPTION_TYPES.map((entry) => `${entry.type}=${entry.name}`).join('，')}` },
        radius: { type: 'integer', minimum: 4, maximum: 32, description: '以当前位置为中心的扫描半径，默认 24，最大 32 格' },
      },
    },
    async run({ bot }, args) {
      const scene = await scanEnvironment(bot, args);
      scene.memory = await rememberScene(bot, scene);
      return JSON.stringify(scene);
    },
  },
  {
    name: 'look_around',
    description:
      '看看周围 16 格：当前维度和群系、玩家、生物、掉落物、值得注意的方块，以及树木、河流、房屋和结构候选摘要。深入识别用 scan_environment；没检出不代表不存在。',
    parameters: { type: 'object', properties: {} },
    async run({ bot }) {
      const lines = [describeLocation(bot)];

      const entities = Object.values(bot.entities).filter(
        (entity) => entity !== bot.entity && entity.position.distanceTo(bot.entity.position) <= LOOK_RADIUS,
      );

      const players = entities.filter((entity) => entity.type === 'player');
      lines.push(
        players.length
          ? `玩家：${players.map((p) => `${p.username}（${distanceTo(bot, p.position)} 格）`).join('、')}`
          : '附近没有玩家',
      );

      const mobs = entities.filter((entity) => ['hostile', 'animal', 'passive', 'mob', 'water_creature'].includes(entity.type));
      if (mobs.length) {
        lines.push(
          `生物：${summarize(mobs.map((m) => `${m.name}${m.type === 'hostile' ? '（敌对）' : ''}`))}，最近的 ${nearestLabel(bot, mobs)}`,
        );
      }

      const drops = entities.filter((entity) => entity.name === 'item');
      if (drops.length) {
        const names = drops.map((drop) => drop.getDroppedItem()?.name ?? '未知物品');
        lines.push(`地上的掉落物：${summarize(names)}`);
      }

      const blockPositions = bot.findBlocks({
        matching: (block) => NOTABLE_BLOCK(block.name),
        maxDistance: LOOK_RADIUS,
        count: 300,
      });
      if (blockPositions.length) {
        const nearestByName = new Map();
        for (const position of blockPositions) {
          const name = bot.blockAt(position)?.name;
          if (!name) continue;
          const info = nearestByName.get(name) ?? { count: 0, nearest: position };
          info.count += 1;
          if (bot.entity.position.distanceTo(position) < bot.entity.position.distanceTo(info.nearest)) info.nearest = position;
          nearestByName.set(name, info);
        }
        const described = [...nearestByName.entries()].map(
          ([name, { count, nearest }]) => `${name} x${count}（最近 ${formatPosition(nearest)}，${distanceTo(bot, nearest)} 格）`,
        );
        lines.push(`方块：${described.join('；')}`);
      } else {
        lines.push('本次方块扫描未检出原木、矿或功能方块（仅限已加载区域和采样范围）');
      }

      const scene = await scanEnvironment(bot, { radius: LOOK_RADIUS });
      await rememberScene(bot, scene);
      if (scene.objects.length) {
        lines.push(`对象候选：${scene.objects.slice(0, 8).map((object) =>
          `${object.name}${object.species ? `（${object.species}）` : ''}，${object.confidence} 证据等级，在 ${formatPosition(object.position)}`).join('；')}`);
      } else {
        lines.push('本次未识别出多方块对象，可能是范围不够或证据不足');
      }
      lines.push('识别基于已加载区块，非纯视线；建筑仅为候选，完整边界、内部和归属未知。详细证据请用 scan_environment。');
      return lines.join('\n');
    },
  },

  {
    name: 'find_block',
    description:
      '找最近的某种方块，返回坐标和距离。block 用 Minecraft 英文 ID，例如 oak_log、iron_ore、crafting_table；也可以写 log（任意原木）、ore（任意矿石）。',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', description: '方块的 Minecraft 英文 ID' },
        max_distance: { type: 'number', description: '最远找多少格，默认 48，最大 64' },
      },
      required: ['block'],
    },
    run({ bot }, { block, max_distance: maxDistance = 48 }) {
      const names = resolveBlockNames(bot, block);
      if (names.length === 0) return `不认识方块「${block}」，请用 Minecraft 英文 ID`;

      const ids = names.map((name) => bot.registry.blocksByName[name].id);
      const positions = bot.findBlocks({
        matching: ids,
        maxDistance: Math.min(Number(maxDistance) || 48, MAX_FIND_DISTANCE),
        count: 3,
      });
      if (positions.length === 0) return `附近 ${maxDistance} 格内没找到 ${block}`;

      return positions
        .map(
          (position) =>
            `${bot.blockAt(position).name} 在 ${formatPosition(position)}，${distanceTo(bot, position)} 格${isExposed(bot, position) ? '' : '（四面被挡住，够不着）'}`,
        )
        .join('；');
    },
  },

  {
    name: 'check_inventory',
    description: '看看自己背包里有什么、手上拿着什么、血量和饱食度。',
    parameters: { type: 'object', properties: {} },
    run({ bot }) {
      const items = bot.inventory.items();
      const held = bot.heldItem ? `${bot.heldItem.name}` : '空手';
      const status = `血量 ${Math.round(bot.health)}/20，饱食度 ${bot.food}/20，手上：${held}`;
      if (items.length === 0) return `背包是空的。${status}`;

      const counts = {};
      for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count;
      const list = Object.entries(counts)
        .map(([name, count]) => `${name} x${count}`)
        .join('、');
      return `背包：${list}。空格子 ${bot.inventory.emptySlotCount()} 个。${status}`;
    },
  },
];

// ["zombie","zombie","cow"] → "zombie x2、cow x1"
function summarize(names) {
  const counts = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return Object.entries(counts)
    .map(([name, count]) => `${name} x${count}`)
    .join('、');
}

function nearestLabel(bot, entities) {
  const nearest = entities.reduce((a, b) =>
    a.position.distanceTo(bot.entity.position) <= b.position.distanceTo(bot.entity.position) ? a : b,
  );
  return `${nearest.name}（${distanceTo(bot, nearest.position)} 格）`;
}
