// 聊天能力：听玩家说话 / 收到任务结果 → 交给 Agent 循环思考（必要时执行动作）→ 把回复发回游戏。
//
// NPC 的“思考”有两个触发来源：
//   1. 玩家说话：「阿方 帮我砍点木头」
//   2. 后台任务结束：【任务结果】「挖 4 个 log」完成：背包新增 oak_log x4
//      —— 大模型看到结果，会接着做下一步（比如把木头交给玩家），这样多步骤的事就能自己做完
//
// 一次思考的流程：
//   触发 ──> 排队（同一时间只想一件事，避免刷屏和乱序）
//        ──> 拼 prompt（人设 + 当前状态 + 该玩家的历史 + 新消息）
//        ──> runAgentLoop()：问大模型，它要动手就执行动作，直到它给出回复
//        ──> 写入记忆 ──> 切成短句发到公屏 / 私聊
import { createLogger } from '../logger.js';
import { runAgentLoop } from './agentLoop.js';
import { ConversationMemory } from './memory.js';
import { createSurvivalPlanner, survivalSkills } from '../strategy/ai.js';
import { startAutonomy } from '../autonomy/index.js';
import { changeProject, projectArguments, projectKinds, projectsFor, registerProject } from '../projects/engine.js';
import { buildSystemPrompt, describeWorld } from './persona.js';

const log = createLogger('chat');

// Minecraft 单条聊天上限 256 字符，留点余量
const MAX_CHAT_LENGTH = 200;
// 连发多条之间的间隔，太快会被服务器当成刷屏踢掉
const SEND_INTERVAL_MS = 600;
// 没有玩家插话时，最多连续自动做几步（防止大模型失败了反复重试、停不下来）
const MAX_AUTO_STEPS = 6;
// “停下”类的话不用等大模型思考（要 1~3 秒），先立刻停住
const STOP_PATTERN = /(停下|停止|别动|站住|别跟|不要跟|不用跟|算了|不用了|别挖|别砍|别打|\bstop\b)|^停/i;

/**
 * 创建聊天能力。返回的 attach(bot) 在每次（重新）进服时调用。
 * 记忆放在 attach 外面，所以断线重连后 NPC 还记得之前聊过什么。
 */
export function createChatHandler({ npc, llm, actions, projectStorage = projectsFor, commands }) {
  const memory = new ConversationMemory(npc.memorySize);
  const systemPrompt = buildSystemPrompt(npc.name);
  let bot = null;
  let queue = Promise.resolve(); // 简单的串行队列
  let stopVersion = 0;
  let autoSteps = 0; // 连续几次思考是由任务结果自动触发的

  if (!llm.apiKey) {
    log.warn('没有配置 LLM_API_KEY：NPC 能进服，但只会回一句固定的话。');
  }

  // 后台任务干完了 → 让大模型看结果、决定下一步
  actions.tasks.onFinish((outcome) => {
    if (commands || outcome.task.source === 'web' || (outcome.task.kind === 'autonomy' && bot?.activeAutonomyMode === 'ai')) return;
    enqueue(() => handleTaskResult(outcome));
  });

  function attach(newBot) {
    bot = newBot;
    if (!commands) bot.survivalPlanner = createSurvivalPlanner({ npc, llm });
    newBot.once('end', () => { newBot.survivalPlanner?.cancel(); if (bot === newBot) bot = null; });

    newBot.on('projectNotice', (project, text) => {
      if (project.owner?.player) enqueue(() => send(text, project.owner.player, project.owner.isWhisper, newBot));
    });

    // 公屏聊天
    newBot.on('chat', (username, message) => {
      if (bot !== newBot || username === newBot.username) return; // 忽略自己说的话
      if (!shouldReply(message)) return;
      onPlayerMessage(username, message, false);
    });

    // 私聊（/msg、/tell）：一律回复
    newBot.on('whisper', (username, message) => {
      if (bot !== newBot || username === newBot.username) return;
      onPlayerMessage(username, message, true);
    });

    log.info(`聊天已就绪：喊「${npc.name}」或「${bot.username}」就会回复（模式：${npc.chatTrigger}）`);
  }

  function shouldReply(message) {
    if (npc.chatTrigger === 'all') return true;
    const text = message.toLowerCase();
    return text.includes(npc.name.toLowerCase()) || text.includes(bot.username.toLowerCase());
  }

  function onPlayerMessage(username, message, isWhisper) {
    autoSteps = 0; // 玩家说话了，自动步数重新计
    const connectedBot = bot;
    const aiMode = (bot.activeAutonomyMode ?? npc.autonomyMode) === 'ai';
    const withoutName = message.split(npc.name).join('').split(bot.username).join('').trim();
    if (commands) {
      const text = withoutName.replace(/^[，,：:\s]+/u, '');
      if (!text) return;
      const reply = result => enqueue(() => send(result, username, isWhisper, connectedBot));
      commands.sendGame(text, { player: username, isWhisper, reply }).catch(error => reply(error.message));
      return;
    }
    if (STOP_PATTERN.test(withoutName)) {
      stopVersion++;
      bot.autonomyStartupCancelled = true;
      if (actions.interrupt()) log.info(`${username} 叫停，已立刻停下`);
      if (aiMode) {
        bot.survivalPlanner.cancel();
        enqueue(async () => {
          if (bot !== connectedBot) return;
          const store = projectStorage(connectedBot);
          const active = (await store.read()).active;
          if (active) await changeProject(store, active, 'pause');
          await send(active ? '已暂停工程，原需求和进度已保留。' : '已停止当前任务。', username, isWhisper, connectedBot);
        });
        return;
      }
    }
    const version = stopVersion;
    enqueue(() => bot === connectedBot && (!aiMode || version === stopVersion)
      && handlePlayerMessage(username, message, isWhisper, aiMode));
  }

  function enqueue(job) {
    queue = queue.then(job).catch((err) => log.error('处理消息失败：', err.message));
  }

  async function handlePlayerMessage(username, message, isWhisper, aiMode) {
    log.info(`${isWhisper ? '[私聊] ' : ''}${username}: ${message}`);
    if (!actions.tasks.current) lookAtPlayer(bot, username); // 忙着干活时不转头，免得打断

    const connectedBot = bot;
    const reply = await think(username, `${username} 说：${message}`, { player: username, isWhisper },
      undefined, aiMode ? goalTools(connectedBot, username, isWhisper, message) : actions);
    await send(reply, username, isWhisper, connectedBot);
  }

  function goalTools(connectedBot, player, isWhisper, originalMessage) {
    let submitted = false;
    const version = stopVersion;
    const tool = (name, description, properties, required) => ({ type: 'function', function: {
      name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
    } });
    function startIfIdle() {
      if (actions.tasks.current) return;
      connectedBot.autonomyStartupCancelled = false;
      startAutonomy({ bot: connectedBot, tasks: actions.tasks, mode: 'ai' });
    }
    return {
      toolDefinitions: [
        tool('submit_survival_goal', '登记简单目标，例如补齐指定物品数量。', {
          objective: { type: 'string', maxLength: 500 },
        }, ['objective']),
        tool('submit_survival_project', '登记多步骤房屋或农田工程，保留玩家原话，由本地逐项验收。', {
          kind: { type: 'string', enum: projectKinds },
          ...projectArguments,
        }, ['kind']),
        tool('manage_survival_project', '读取或管理此世界的现有工程。只有玩家明确要求时才暂停、恢复或取消。', {
          operation: { type: 'string', enum: ['status', 'pause', 'resume', 'cancel'] },
        }, ['operation']),
      ],
      async run(name, args) {
        if (bot !== connectedBot || version !== stopVersion) return '旧请求已失效，请重新下达任务';
        const store = projectStorage(connectedBot);
        try {
          const { active, history } = await store.read();
          if (bot !== connectedBot || version !== stopVersion) return '旧请求已失效，请重新下达任务';
          if (name === 'manage_survival_project' && args?.operation === 'status') {
            const project = active || history.at(-1);
            if (!project) return '此世界没有工程记录';
            return JSON.stringify({ objective: project.objective, status: project.status, steps: project.steps });
          }
          if (submitted) return '一次聊天最多执行一个登记或管理动作';
          if (npc.autonomy === 'off' || connectedBot.autonomyOptions?.allowDig === false) return '自主任务已关闭';
          if (connectedBot.memory?.suspended) return '当前世界身份待确认';
          if (actions.tasks.current && actions.tasks.current.kind !== 'autonomy') return 'Agent 正在执行其他任务';
          if (name === 'submit_survival_goal') {
            if (active) return '有持久化工程正在占用任务槽，可先查询或取消该工程';
            connectedBot.survivalPlanner.submit(args?.objective, result => {
              enqueue(() => send(result, player, isWhisper, connectedBot));
            }, { day: connectedBot.time?.day, timeOfDay: connectedBot.time?.timeOfDay });
          } else if (name === 'submit_survival_project') {
            if (connectedBot.survivalPlanner.hasRequest()) return '已有临时任务，请等它完成或先叫停';
            if (!['overworld', 'minecraft:overworld'].includes(String(connectedBot.game.dimension))) return '当前工程模板只适用于主世界';
            await registerProject(store, { kind: args?.kind, options: args?.[args.kind], objective: originalMessage,
              owner: { player, isWhisper } });
          } else if (name === 'manage_survival_project' && ['resume', 'pause', 'cancel'].includes(args?.operation)) {
            if (!active || active.owner?.player !== player) return '只有当前工程的发起人可以管理该工程';
            if (args.operation !== 'resume') actions.interrupt();
            if (!await changeProject(store, active, args.operation)) return '工程状态已变化，请查询后重试';
            submitted = true;
            if (args.operation === 'resume') startIfIdle();
            return { resume: '工程已恢复，将根据现场继续', pause: '工程已暂停，进度已保存', cancel: '工程已取消，已有建筑与历史记录保留' }[args.operation];
          } else return '未知任务工具';
          submitted = true;
          if (bot === connectedBot && version === stopVersion) startIfIdle();
          return '目标已登记，实际执行结果将另行反馈';
        } catch (error) { return error.message; }
      },
    };
  }

  async function handleTaskResult({ task, ok, result }) {
    if (!task.owner || !bot) return;
    const report = `【任务结果】「${task.label}」${ok ? '完成' : '失败'}：${result}`;
    log.info(report);

    autoSteps += 1;
    if (autoSteps > MAX_AUTO_STEPS) {
      // 自动做了太多步还没停：不再让大模型继续，直接把结果说出来，等玩家发话
      log.warn(`已连续自动执行 ${MAX_AUTO_STEPS} 步，暂停自动续做`);
      await send(`${task.label}${ok ? '完成了' : '没成功'}：${result}`, task.owner, task.isWhisper);
      return;
    }

    // 任务结果不是玩家说的话，要明确告诉大模型“该你决定下一步了”，
    // 否则它常常只回一句“这就给你”却忘了真的调用工具
    const prompt =
      `${report}\n` +
      `（系统消息，不是玩家说的话。对照 ${task.owner} 最初的要求：如果还有没做完的步骤，现在就调用对应的工具去做，` +
      `只说不做是不行的；全部做完了就用一句话告诉 ${task.owner} 结果；失败了就照实说原因。）`;
    const reply = await think(task.owner, prompt, { player: task.owner, isWhisper: task.isWhisper }, report);
    await send(reply, task.owner, task.isWhisper);
  }

  /**
   * 问大模型（带工具），成功的话把这一问一答写进该玩家的记忆
   * @param {string} [memoryContent] 写进记忆的版本（默认和 content 一样；任务结果只记结果，不记那段系统提示）
   */
  async function think(player, content, context, memoryContent = content, tools = actions) {
    if (!llm.apiKey) {
      return `${player}，我的大脑还没接上（缺 LLM_API_KEY），暂时只会说这句。`;
    }

    const instructions = tools === actions ? systemPrompt : [
      `你是 ${npc.name}，一个 Minecraft 生存 Agent。先判断玩家在提问还是明确下达任务。`,
      '简单收集等目标用 submit_survival_goal。建房、农田或加层等多步骤需求必须用 submit_survival_project，完整填写已明确的验收参数。',
      '房屋自带一张床与工作台；农田可指定一种作物。模板参数无法表达的硬性要求先说明并请玩家确认，勿擅自缩减或转为简单目标。',
      '查询工程状态用 manage_survival_project。只有玩家明确要求时才变更工程状态。',
      '任务会由独立的 AI 生存调度执行并回报结果，登记后仅确认收到。',
      `可用技能：${Object.values(survivalSkills).join('；')}。`,
    ].join('\n');
    const messages = [
      { role: 'system', content: `${instructions}\n\n${describeWorld(bot, actions.describeActivity())}` },
      ...memory.get(player),
      { role: 'user', content },
    ];

    try {
      const reply = await runAgentLoop({ llm, actions: tools, messages, context });
      // 调用成功才写入记忆，失败的那轮不留痕迹。
      // 只记“发生了什么、NPC 回了什么”，中间的工具调用不进记忆——
      // NPC 正在做什么、背包里有什么，每次都会通过 describeWorld 重新告诉它。
      memory.add(player, 'user', memoryContent);
      memory.add(player, 'assistant', reply);
      return reply;
    } catch (err) {
      log.error(err.message);
      return '我脑子卡了一下，你再说一遍？';
    }
  }

  async function send(reply, player, isWhisper, connectedBot = bot) {
    log.info(`→ 回复 ${player}: ${reply}`);
    for (const line of splitForChat(reply)) {
      if (bot !== connectedBot || !connectedBot) return;
      try {
        if (isWhisper) connectedBot.whisper(player, line);
        else connectedBot.chat(line);
      } catch (err) {
        log.warn('发送失败（可能掉线了）：', err.message);
        return;
      }
      await sleep(SEND_INTERVAL_MS);
    }
  }

  return { attach };
}

// 说话时转头看着对方，更像个 NPC（对方不在视野内就算了）
function lookAtPlayer(bot, username) {
  const entity = bot.players[username]?.entity;
  if (!entity) return;
  bot.lookAt(entity.position.offset(0, entity.height, 0)).catch(() => {});
}

// 去掉换行，并把长回复按长度切成多条
function splitForChat(text) {
  const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
  const lines = [];
  for (let i = 0; i < flat.length; i += MAX_CHAT_LENGTH) {
    lines.push(flat.slice(i, i + MAX_CHAT_LENGTH));
  }
  return lines;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
