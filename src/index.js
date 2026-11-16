// 入口：读配置 → 准备各项能力 → 启动机器人，进服后把能力挂上去。
//
// 三层能力：
//   - 动作（actions/）：NPC 能做的事（走路、砍树、送东西、打怪……），由大模型通过工具调用来触发。
//     耗时的动作在后台以“任务”形式运行，新增动作见 src/actions/index.js。
//   - 本能（behaviors/）：不用思考自动发生的反应：饿了吃东西、怪物贴脸还手。
//   - 聊天（chat/）：听玩家说话、收任务结果，交给大模型思考、回复、决定下一步。
import { config } from './config.js';
import { startBot } from './bot.js';
import { createActionRegistry } from './actions/index.js';
import { startAutonomy } from './autonomy/index.js';
import { createChatHandler } from './chat/chatHandler.js';
import { createLogger } from './logger.js';
import { MemoryManager } from './memory/manager.js';
import { attachMemory } from './memory/runtime.js';
import { prepareMemoryOptions, resolveWorldOptions, watchWorldIdentity } from './memory/bootstrap.js';

const log = createLogger('main');
const memoryOptions = await prepareMemoryOptions(config.memory, config.minecraft.username);
const memorySessions = new Set();

const actions = createActionRegistry({
  allowDig: config.npc.allowDig,
  allowCombat: config.npc.allowCombat,
  allowAutonomy: config.npc.autonomy !== 'off',
});
const chat = createChatHandler({ npc: config.npc, llm: config.llm, actions });

log.info(
  `能力开关：挖方块 ${config.npc.allowDig ? '开' : '关'}，打怪 ${config.npc.allowCombat ? '开' : '关'}，自主发育 ${config.npc.autonomy}`,
);

const botHandle = startBot(config.minecraft, async (bot) => {
  let ended = false;
  bot.once('end', () => { ended = true; });
  const options = await resolveWorldOptions(memoryOptions, bot);
  const memory = new MemoryManager(options, config.npc.name);
  let available = memory.enabled;
  if (memory.enabled) {
    if (options.identitySource === 'session') log.warn('服务器未提供持久世界 ID：已自动建立临时分区，重连不会猜测合并旧记忆；设置一次 WORLD_ID 或接入服务端身份通道后可持久续接');
    try { await memory.initialize(); } catch {
      available = false;
      log.warn('MongoDB 暂不可用，游戏继续；长期记忆尚未在线，可通过记忆工具重试连接');
    }
  }
  if (ended) { await memory.close(); return; }
  const session = attachMemory(bot, memory, log);
  session.enabled = available;
  session.identitySource = options.identitySource;
  memorySessions.add(session);
  bot.once('end', () => session.flush().then(() => memory.close()).finally(() => memorySessions.delete(session)));
  bot.farmOptions = config.farm;
  bot.supplyOptions = config.supplies;
  actions.attach(bot); // 先装好动作（寻路插件、本能反应），聊天里才能调用
  bot.once('end', () => actions.tasks.cancel('连接断开，停止旧连接的任务'));
  chat.attach(bot);
  if (config.npc.autonomy === 'auto') {
    // 等区块加载一会儿再开始，不然一进服什么都“看不见”
    const startup = setTimeout(() => {
      if (!ended && !bot.autonomyStartupCancelled && !actions.tasks.current) log.info(startAutonomy({ bot, tasks: actions.tasks, mode: config.npc.autonomyMode }));
    }, Number(process.env.SURVIVE_DELAY_MS ?? 3000));
    bot.once('end', () => clearTimeout(startup));
  }
}, { prepareBot: watchWorldIdentity });

// Ctrl+C 时让机器人体面下线，而不是直接掉线
process.on('SIGINT', () => {
  log.info('收到退出信号，机器人下线');
  botHandle.stop();
  const deadline = setTimeout(() => process.exit(0), 5000);
  Promise.all([...memorySessions].map((session) => session.flush()))
    .then(() => Promise.all([...memorySessions].map((session) => session.manager.close())))
    .catch(() => log.warn('退出时未能完成全部记忆写入'))
    .finally(() => { clearTimeout(deadline); process.exit(0); });
});
