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
import { loadAgentProfiles } from './agent-profiles.js';
import { startWebService } from './web/server.js';

const log = createLogger('main');
const memorySessions = new Set();
const profiles = await loadAgentProfiles(config);
const agents = profiles.map(profile => ({ ...profile, actions: createActionRegistry({
  allowDig: profile.npc.allowDig,
  allowCombat: profile.npc.allowCombat,
  allowAutonomy: profile.npc.autonomy !== 'off',
}) }));
const web = config.web.enabled ? await startWebService({ agents, options: config.web })
  .catch((error) => { log.warn(`Web 服务启动失败：${error.code || '请检查网页配置'}`); return null; }) : null;
if (web) log.info(`Web 监控与对话 ${web.url}`);

async function startAgent(profile) {
  const { actions } = profile;
  const memoryOptions = await prepareMemoryOptions(profile.memory, profile.minecraft.username);
  const chat = createChatHandler({ npc: profile.npc, llm: profile.llm, actions });
  return startBot(profile.minecraft, async (bot) => {
    bot.portfolioAgentId = profiles.length > 1 ? profile.id : null;
    let ended = false;
    bot.once('end', () => { ended = true; });
    const options = await resolveWorldOptions(memoryOptions, bot);
    const memory = new MemoryManager(options, profile.npc.name);
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
    bot.farmOptions = profile.farm;
    bot.supplyOptions = profile.supplies;
    actions.attach(bot); // 先装好动作（寻路插件、本能反应），聊天里才能调用
    bot.once('end', () => actions.tasks.cancel('连接断开，停止旧连接的任务'));
    chat.attach(bot);
    await web?.attach(bot, profile.id);
    if (profile.npc.autonomy === 'auto') {
      // 等区块加载一会儿再开始，不然一进服什么都“看不见”
      const startup = setTimeout(() => {
        if (!ended && !bot.autonomyStartupCancelled && !actions.tasks.current) log.info(startAutonomy({ bot, tasks: actions.tasks, mode: profile.npc.autonomyMode }));
      }, Number(process.env.SURVIVE_DELAY_MS ?? 3000));
      bot.once('end', () => clearTimeout(startup));
    }
  }, { prepareBot: watchWorldIdentity });
}
const handles = await Promise.all(agents.map(startAgent));

// Ctrl+C 时让机器人体面下线，而不是直接掉线
function shutdown() {
  log.info('收到退出信号，机器人下线');
  for (const handle of handles) handle.stop();
  const deadline = setTimeout(() => process.exit(0), 5000);
  Promise.all([web?.close(), ...[...memorySessions].map((session) => session.flush())])
    .then(() => Promise.all([...memorySessions].map((session) => session.manager.close())))
    .catch(() => log.warn('退出时未能完成全部记忆写入'))
    .finally(() => { clearTimeout(deadline); process.exit(0); });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
