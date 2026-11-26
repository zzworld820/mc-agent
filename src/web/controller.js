import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentLoop } from '../chat/agentLoop.js';
import { buildSystemPrompt, describeWorld } from '../chat/persona.js';
import { startAutonomy } from '../autonomy/index.js';
import { readDanger } from '../strategy/danger.js';

const READ_ONLY = new Set(['assess_danger', 'get_world_state', 'scan_environment', 'look_around', 'find_block', 'check_inventory']);
const FORBIDDEN = /(?:autonomy|chat|whisper)|^(?:stop|say|tell|send_message|send_command|command)$/i;
const UNFINISHED = new Set(['queued', 'running', 'cancelling']);
const STOP_COMMAND = /^(?:请)?(?:停|停下|停止|暂停|别动|站住|别砍|别挖|别打|别跟|不要跟|stop)[。！!.\s]*$/i;
const DEFAULT_DIRECTORY = new URL('../../data/web/', import.meta.url);

function abortError() {
  const error = new Error('Web 操作已中止');
  error.name = 'AbortError';
  return error;
}

// Also works with an injected LLM that ignores cancellation. Its late tool calls
// still go through the connection/mission guard in the facade below.
function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Web-only conversation and FIFO temporary missions. No game chat listeners or
 * senders are installed. `dependencies` is optional; production uses the real
 * agent loop and autonomy entry point.
 *
 * snapshot.temporary contains mission history; snapshot.queue contains queued
 * mission records. send returns the user message id (also the task mission id).
 */
export function createWebController({ actions, llm = {}, npc = {}, storageDirectory = DEFAULT_DIRECTORY,
  priorities = {}, dependencies = {} }) {
  if (typeof actions?.tasks?.onSettled !== 'function') {
    throw new Error('Web controller 需要 tasks.onSettled(fn) 接口');
  }
  const manual = npc.manualControl === true;
  const think = dependencies.runAgentLoop ?? runAgentLoop;
  const start = dependencies.startAutonomy ?? startAutonomy;
  const danger = dependencies.readDanger ?? readDanger;
  const directory = storageDirectory instanceof URL ? fileURLToPath(storageDirectory) : join(storageDirectory);
  if (Object.keys(priorities).some((key) => !['temporary', 'primary'].includes(key))
    || Object.values(priorities).some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('初始优先级必须是 temporary/primary 的有限数值');
  }
  const listeners = new Set();
  const runtimes = new Map();
  const outcomes = new WeakMap();
  const waiters = new Map();
  const secrets = new Set();
  let current = null;
  let closed = false;
  let closing = null;

  function redact(value) {
    if (typeof llm.apiKey === 'string' && llm.apiKey) secrets.add(llm.apiKey);
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  }

  function clean(value) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), clean(entry)]));
    }
    return value;
  }

  function initialState() {
    if (manual) return {
      primary: { id: 'primary', enabled: false, mode: 'manual', label: '指令模式', text: '等待游戏或网页指令', status: 'paused', pausedBy: 'user' },
      temporary: [], priorities: { temporary: 100, primary: 0 }, messages: [],
    };
    const mode = npc.autonomyMode ?? 'survival';
    const label = mode === 'milestones' ? '自主发育' : '自主生存';
    return {
      primary: { id: 'primary', enabled: npc.autonomy === 'auto', mode, label,
        description: mode === 'milestones' ? '按原里程碑计划继续自主发育' : '按原自主生存计划和真实检查点继续',
        text: label, status: npc.autonomy === 'auto' ? 'idle' : 'paused', pausedBy: npc.autonomy === 'auto' ? null : 'user' },
      temporary: [], priorities: { temporary: 80, primary: 50, ...priorities }, messages: [],
    };
  }
  const empty = initialState();

  function partition(bot) {
    return {
      agent: bot.memory?.agentId || bot.username || bot._client?.username || 'unknown',
      world: bot.memory?.worldId || bot.memoryServerIdentity?.worldId || bot.buildingServer
        || `${bot._client?.socket?.remoteAddress ?? 'unknown'}:${bot._client?.socket?.remotePort ?? 'unknown'}`,
      dimension: String(bot.game?.dimension ?? 'unknown').replace(/^minecraft:/, ''),
      epoch: bot.memory?.manager?.epoch || bot.memoryServerIdentity?.epoch || 'initial',
    };
  }

  function live(session) {
    return !closed && current === session && session.connected
      && JSON.stringify(partition(session.bot)) === session.partitionKey;
  }

  function owns(runtime, task) {
    return Boolean(task && task.source === (runtime.mission?.source || 'web') && task.missionId === runtime.id);
  }

  function capturePrimary(session, task) {
    if (manual) return false;
    const primary = session.state.primary;
    const previous = JSON.stringify(primary);
    primary.enabled = true;
    primary.status = 'running';
    primary.pausedBy = null;
    primary.label = redact(task.label || primary.label);
    primary.text = redact(task.progress || task.label || primary.text);
    const mode = session.bot.activeAutonomyMode || primary.mode;
    if (mode !== primary.mode) {
      primary.mode = mode;
      primary.description = mode === 'milestones' ? '按原里程碑计划继续自主发育' : '按原自主生存计划和真实检查点继续';
    }
    session.primaryTask = task;
    return previous !== JSON.stringify(primary);
  }

  function assertLive(runtime) {
    if (!live(runtime.session) || runtime.controller.signal.aborted
      || (runtime.mission && runtime.session.active !== runtime)) throw abortError();
  }

  function emergencyReason(session) {
    if (manual) return session.bot.health <= 0 ? 'Agent 正在等待重生' : null;
    if (session.bot.health <= 6) return `生命值 ${session.bot.health} <= 6，优先生存避险`;
    try {
      const risk = danger(session.bot);
      if (risk.retreat) return redact(`需要紧急撤退：${risk.reasons?.join('、') || '检测到危险'}`);
    } catch { /* World data may be incomplete during spawn; health remains usable. */ }
    return null;
  }

  function checkEmergency(runtime) {
    if (!runtime.mission || runtime.controller.signal.aborted) return;
    const reason = emergencyReason(runtime.session);
    const task = actions.tasks.current;
    if (reason && !(owns(runtime, task) && task.supply)) {
      cancelRuntime(runtime, 'interrupted', reason);
      throw abortError();
    }
  }

  function checkExecutionOwner(runtime) {
    const task = actions.tasks.current;
    if (runtime.mission && task && !owns(runtime, task)) {
      cancelRuntime(runtime, 'interrupted', '执行权已交给其他任务，停止旧临时任务以免覆盖');
      throw abortError();
    }
  }

  function addMessage(session, role, content, missionId, id = randomUUID()) {
    const message = { id, role, content: redact(content), createdAt: Date.now() };
    if (missionId) message.missionId = missionId;
    session.state.messages.push(message);
    return message;
  }

  function view(session = current) {
    const state = session?.state ?? empty;
    const result = clean(state);
    if (session && live(session)) {
      const task = actions.tasks.current;
      if (!manual && task?.kind === 'autonomy') {
        session.primaryTask = task;
        result.primary.status = 'running';
        result.primary.text = redact(task.progress || task.label);
      } else if (session.active && owns(session.active, task)) {
        const mission = result.temporary.find((item) => item.id === session.active.id);
        if (mission && task.progress) mission.text = redact(task.progress);
      }
    }
    const gameIds = new Set(result.temporary.filter(mission => mission.source === 'game').map(mission => mission.id));
    return { manual, primary: result.primary, temporary: result.temporary,
      queue: result.temporary.filter((mission) => mission.status === 'queued'),
      priorities: result.priorities, messages: result.messages.filter(message => !gameIds.has(message.missionId)) };
  }

  function notify() {
    for (const listener of listeners) {
      try { listener(view()); } catch { /* A subscriber cannot break scheduling. */ }
    }
  }

  // Small local records are synchronously replaced: no pending write from an
  // old connection can overwrite a newer partition snapshot.
  function save(session) {
    let temporary;
    try {
      mkdirSync(directory, { recursive: true });
      temporary = `${session.file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(clean({ schemaVersion: 1, partition: session.partition,
        ...session.state }), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, session.file);
    } catch (error) {
      if (temporary) { try { unlinkSync(temporary); } catch { /* Already renamed or never created. */ } }
      throw new Error(redact(`Web 记录保存失败：${error.message}`));
    } finally {
      if (current === session) notify();
    }
  }

  function reportStorageError(session, error) {
    addMessage(session, 'system', error.message);
    if (current === session) notify();
  }

  function saveSafely(session) {
    try { save(session); } catch (error) { reportStorageError(session, error); }
  }

  function settled(task) {
    if (outcomes.has(task)) return Promise.resolve(outcomes.get(task));
    return new Promise((resolve) => {
      const subscribers = waiters.get(task) ?? [];
      subscribers.push(resolve);
      waiters.set(task, subscribers);
    });
  }

  async function drained(task) {
    const outcome = await settled(task);
    // onSettled is emitted inside finish(), before task.settled resolves.
    await task.settled;
    return outcome;
  }

  // Registered before *any* LLM or action call, including instantly settled
  // tasks. Object identity, not reusable numeric task ids, keys these results.
  const unsubscribeTasks = actions.tasks.onSettled((outcome) => {
    const { task } = outcome;
    if (outcomes.has(task)) return;
    const safe = { ...outcome, result: redact(outcome.result) };
    outcomes.set(task, safe);
    for (const resolve of waiters.get(task) ?? []) resolve(safe);
    waiters.delete(task);
    const candidate = runtimes.get(task.missionId);
    const runtime = candidate && owns(candidate, task) ? candidate : null;
    if (runtime) {
      runtime.tasks.add(task);
      runtime.call?.events.push(safe);
    }
    const session = current;
    if (session && live(session) && (session.primaryTask === task || session.blockingTask === task)) {
      if (session.primaryTask === task && !session.state.primary.pausedBy) {
        session.state.primary.status = outcome.aborted ? 'paused' : outcome.ok ? 'completed' : 'failed';
        session.state.primary.text = safe.result;
        saveSafely(session);
      }
      kick(session);
    }
  });

  function transition(session, work) {
    const operation = session.transitions.then(() => session.ready).then(() => live(session) ? work() : undefined);
    session.transitions = operation.catch((error) => {
      if (live(session)) {
        addMessage(session, 'system', redact(`Web 调度失败：${error.message}`));
        saveSafely(session);
      }
    });
    return operation;
  }

  async function resumePrimary(session) {
    const primary = session.state.primary;
    if (!live(session) || !primary.enabled) return;
    if (actions.tasks.current) {
      session.blockingTask = actions.tasks.current;
      session.resumePending = true;
      return;
    }
    let result;
    try {
      result = await start({ bot: session.bot, tasks: actions.tasks, mode: primary.mode });
      if (!live(session)) return;
      if (actions.tasks.current?.kind !== 'autonomy') throw new Error(redact(result ?? '未启动自主任务'));
    } catch (error) {
      primary.status = 'failed';
      primary.pausedBy = null;
      primary.text = redact(`主任务恢复失败：${error.message}`);
      session.resumePending = false;
      saveSafely(session);
      throw new Error(primary.text);
    }
    session.resumePending = false;
    session.primaryTask = actions.tasks.current;
    primary.pausedBy = null;
    primary.status = 'running';
    primary.text = redact(result ?? primary.label);
    save(session);
  }

  function makeRuntime(session, id, mission = null) {
    const command = session.gameCommands.get(id);
    const context = { player: command?.player || 'web', isWhisper: command?.isWhisper ?? true,
      source: mission?.source || 'web', missionId: id };
    const runtime = { session, id, mission, command, context, controller: new AbortController(), tasks: new Set(), rawCalls: new Set(),
      failures: [], toolCount: 0, call: null, desiredStatus: null, resume: false };
    runtimes.set(id, runtime);
    return runtime;
  }

  function cancelRuntime(runtime, status, reason) {
    runtime.desiredStatus = status;
    runtime.reason = redact(reason);
    runtime.controller.abort(reason);
    const task = actions.tasks.current;
    if (owns(runtime, task)) {
      runtime.tasks.add(task);
      actions.tasks.cancel(redact(reason));
    }
  }

  async function cleanup(runtime) {
    // An instant async action (e.g. crafting) may still be unwinding after LLM
    // cancellation. Drain it before restoring autonomy or admitting another job.
    await Promise.allSettled([...runtime.rawCalls]);
    const task = actions.tasks.current;
    if (owns(runtime, task)) {
      runtime.tasks.add(task);
      actions.tasks.cancel('Web 会话结束');
    }
    await Promise.all([...runtime.tasks].map(drained));
  }

  function facade(runtime, mode) {
    const definitions = (actions.toolDefinitions ?? []).filter((tool) => {
      const name = tool.function?.name;
      return mode === 'chat' ? READ_ONLY.has(name) : typeof name === 'string' && !FORBIDDEN.test(name);
    });
    const allowed = new Set(definitions.map((tool) => tool.function.name));
    return {
      toolDefinitions: clean(definitions),
      async run(name, args = {}) {
        assertLive(runtime);
        checkEmergency(runtime);
        checkExecutionOwner(runtime);
        if (!allowed.has(name)) throw new Error('Web 当前模式不允许调用该工具');
        if (runtime.call) throw new Error('Web 工具必须串行调用');
        const call = { events: [] };
        runtime.call = call;
        runtime.toolCount += 1;
        const context = { ...runtime.context, signal: runtime.controller.signal };
        try {
          // agentLoop logs args after run returns; redact its original object as
          // well as the arguments passed into actions.
          const safeArgs = clean(args);
          if (args && typeof args === 'object') {
            for (const key of Object.keys(args)) delete args[key];
            Object.assign(args, safeArgs);
          }
          const raw = Promise.resolve().then(() => {
            assertLive(runtime);
            checkEmergency(runtime);
            checkExecutionOwner(runtime);
            return actions.run(name, safeArgs, context);
          });
          runtime.rawCalls.add(raw);
          const immediate = await raw;
          const task = actions.tasks.current;
          if (owns(runtime, task)) runtime.tasks.add(task);
          assertLive(runtime);
          checkEmergency(runtime);
          if (mode === 'chat' && (owns(runtime, task) || call.events.length)) {
            throw new Error('感知工具意外启动了后台任务');
          }
          const started = new Set(call.events.map((event) => event.task));
          if (owns(runtime, task)) started.add(task);
          if (!started.size) {
            const text = redact(immediate);
            if (/^(?:执行失败|没有叫|我还没进入世界)/.test(text)) runtime.failures.push(text);
            return text;
          }
          const reports = [];
          for (const background of started) {
            const outcome = await abortable(drained(background), runtime.controller.signal);
            assertLive(runtime);
            checkEmergency(runtime);
            if (outcome.aborted) {
              cancelRuntime(runtime, 'interrupted', '后台任务已被其他操作取消');
              throw abortError();
            }
            const report = redact(`【任务结果】「${background.label}」${outcome.ok ? '完成' : '失败'}：${outcome.result}`);
            reports.push(report);
            if (!outcome.ok) runtime.failures.push(report);
            addMessage(runtime.session, 'system', report, runtime.mission ? runtime.id : undefined);
            save(runtime.session);
          }
          return reports.join('\n');
        } catch (error) {
          throw new Error(redact(error.message));
        } finally {
          runtime.call = null;
        }
      },
    };
  }

  async function ask(runtime, mode) {
    assertLive(runtime);
    checkEmergency(runtime);
    if (typeof llm.apiKey !== 'string' || !llm.apiKey.trim()) throw new Error('缺少 LLM_API_KEY，Web 无法调用大模型');
    const session = runtime.session;
    const ownIndex = session.state.messages.findIndex((message) => message.id === runtime.id);
    const recentCommandIds = manual && runtime.mission ? new Set(session.state.temporary
      .filter(item => ['completed', 'failed'].includes(item.status) && item.source === runtime.context.source
        && item.requester === runtime.command?.player).slice(-3).map(item => item.id)) : new Set();
    const history = session.state.messages.filter((message, index) => mode === 'task'
      ? message.missionId === runtime.id || recentCommandIds.has(message.missionId) && message.role !== 'system'
      : !message.missionId && message.id !== runtime.id && (message.role !== 'user' || index < ownIndex));
    if (mode === 'chat') history.push(session.state.messages[ownIndex]);
    const limit = Math.max(2, Number(npc.memorySize) || 12);
    let world;
    try { world = describeWorld(session.bot, actions.describeActivity?.() ?? actions.tasks.describe?.()); }
    catch { world = '当前世界感知信息不完整，请使用感知工具核实。'; }
    const instruction = manual
      ? '这是玩家发给你的直接指令。根据本次消息区分提问和行动。提问就回答，需要动手就调用已有技能。当前发话者是 '
        + runtime.context.player + '。工具会等待实际执行结果；依据工具结果如实回复。只完成本次要求，完成后原地待命。'
      : mode === 'chat'
      ? '这是独立的 Web 只读对话。只能感知和回答，不接受行动指令，不向游戏发送聊天。'
      : '这是 Web 临时任务。主任务由 Web 调度器保留并恢复，你不能启动或停止自主任务，也不能发送游戏聊天。'
        + '工具会等待后台真实完成并返回【任务结果】，收到后对照原始请求继续下一步，全部实际完成后才报告成功；失败如实说明。';
    const messages = [{ role: 'system', content: redact(`${buildSystemPrompt(npc.name ?? session.bot.username, { manual })}\n${instruction}\n${world}`) },
      ...history.slice(mode === 'task' ? 0 : -limit).map(({ role, content }) => ({ role, content }))];
    const operation = think({ llm, actions: facade(runtime, mode), messages,
      context: { ...runtime.context, signal: runtime.controller.signal } });
    const reply = await abortable(operation, runtime.controller.signal);
    assertLive(runtime);
    checkEmergency(runtime);
    if (typeof reply !== 'string' || !reply.trim() || ['……（发呆中）', '我有点手忙脚乱，你再说一遍？'].includes(reply)) {
      throw new Error('大模型未能完成有效回复，请检查接口或任务步骤限制');
    }
    return redact(reply);
  }

  async function executeMission(runtime) {
    const { session, mission } = runtime;
    let reply;
    let error;
    try {
      // Missing configuration should not interrupt a perfectly healthy primary.
      if (!llm.apiKey?.trim()) throw new Error('缺少 LLM_API_KEY，临时任务未执行');
      await transition(session, async () => {
        assertLive(runtime);
        const reason = emergencyReason(session);
        if (reason) { runtime.requeue = true; runtime.reason = reason; return; }
        const primary = session.state.primary;
        const task = actions.tasks.current;
        if (task?.kind === 'autonomy') capturePrimary(session, task);
        runtime.resume = primary.enabled;
        session.bot.autonomyStartupCancelled = true;
        if (primary.enabled || task?.kind === 'autonomy') {
          primary.pausedBy = runtime.id;
          primary.status = 'paused';
        }
        if (task?.kind === 'autonomy') {
          session.primaryTask = task;
          primary.text = redact(task.progress || task.label);
          save(session);
          actions.tasks.cancel('Web 临时任务优先，保存主任务检查点');
          await drained(task);
        }
      });
      if (runtime.requeue) return;
      assertLive(runtime);
      save(session);
      reply = await ask(runtime, 'task');
    } catch (caught) {
      error = redact(caught.message);
    } finally {
      await cleanup(runtime);
      runtime.controller.abort('临时任务结束');
      if (!runtime.requeue) session.gameCommands.delete(runtime.id);
      if (live(session)) {
        mission.status = runtime.requeue ? 'queued' : runtime.desiredStatus ?? (error || runtime.failures.length ? 'failed' : 'completed');
        if (!runtime.requeue) mission.finishedAt = Date.now();
        mission.text = redact(runtime.reason || error || runtime.failures.join('\n') || reply);
        if (mission.status === 'failed') mission.error = mission.text;
        if (runtime.command && !runtime.requeue) {
          try { runtime.command.reply(mission.text || '指令已结束'); } catch { /* Connection may have closed. */ }
        }
        if (reply) addMessage(session, 'assistant', reply, runtime.id);
        if (error && !runtime.desiredStatus) addMessage(session, 'system', `临时任务失败：${error}`, runtime.id);
        if (runtime.failures.length) addMessage(session, 'system', `临时任务包含失败步骤：${runtime.failures.join('\n')}`, runtime.id);
        saveSafely(session);
        await transition(session, async () => {
          if (runtime.resume && session.state.primary.enabled) await resumePrimary(session);
          else if (session.state.primary.pausedBy === runtime.id) {
            session.state.primary.pausedBy = session.state.primary.enabled ? null : 'user';
          }
        }).catch(() => {});
        if (session.active === runtime) session.active = null;
        saveSafely(session);
        kick(session);
      }
      runtimes.delete(runtime.id);
    }
  }

  function kick(session) {
    if (!live(session) || session.kickPending) return;
    session.kickPending = true;
    void transition(session, () => {
      session.kickPending = false;
      if (session.active) return;
      if (session.resumePending && session.state.primary.enabled && !actions.tasks.current) {
        return resumePrimary(session).then(() => kick(session));
      }
      const mission = session.state.temporary.find((item) => item.status === 'queued');
      if (!mission) return;
      const task = actions.tasks.current;
      if (task?.kind === 'autonomy' && capturePrimary(session, task)) save(session);
      const reason = emergencyReason(session);
      if (reason) {
        if (mission.text !== reason) { mission.text = reason; save(session); }
        return;
      }
      if (task) {
        session.blockingTask = task;
        if (task.kind !== 'autonomy') return;
        if (session.state.priorities.temporary <= session.state.priorities.primary) return;
      }
      mission.status = 'running';
      mission.startedAt = Date.now();
      mission.text = '正在执行临时任务';
      const runtime = makeRuntime(session, mission.id, mission);
      session.active = runtime;
      // Establish runtime.done before starting any work (including instant mocks).
      runtime.done = Promise.resolve().then(() => executeMission(runtime));
      runtime.done.catch((error) => {
        if (live(session)) reportStorageError(session, new Error(redact(error.message)));
      });
    }).catch(() => {});
  }

  function detach(session, reason) {
    if (!session) return Promise.resolve();
    session.connected = false;
    for (const remove of session.removeListeners) remove();
    for (const mission of session.state.temporary) {
      if (UNFINISHED.has(mission.status)) Object.assign(mission, { status: 'interrupted', text: redact(reason), finishedAt: Date.now() });
    }
    if (session.state.primary.status === 'running' || session.state.primary.pausedBy !== 'user') {
      session.state.primary.status = 'interrupted';
    }
    const pending = [...runtimes.values()].filter((runtime) => runtime.session === session);
    for (const runtime of pending) cancelRuntime(runtime, 'interrupted', reason);
    saveSafely(session);
    // Keep barriers transitive across rapid A -> B -> C reconnects, even if B
    // has not yet admitted any work of its own.
    return Promise.allSettled([session.ready, session.transitions, ...pending.map((runtime) => runtime.done)]).then(() => {});
  }

  function attach(bot) {
    if (closed) throw new Error('Web controller 已关闭');
    if (!bot) throw new Error('attach 需要 bot');
    const previous = current;
    const ready = detach(previous, '连接或世界分区已改变，旧任务已中断，不自动重放');
    const identity = partition(bot);
    const partitionKey = JSON.stringify(identity);
    const file = join(directory,
      `${createHash('sha256').update(partitionKey).digest('hex')}.json`);
    let state = initialState();
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.schemaVersion !== 1 || JSON.stringify(saved.partition) !== partitionKey
        || !Array.isArray(saved.messages) || !Array.isArray(saved.temporary) || !saved.primary) {
        throw new Error('Web 记录格式或分区不匹配');
      }
      state = clean({ primary: { ...state.primary, ...saved.primary }, temporary: saved.temporary,
        priorities: { ...state.priorities, ...saved.priorities }, messages: saved.messages });
      if (manual || saved.primary.mode === 'manual') {
        const { primary, priorities } = initialState();
        Object.assign(state, { primary, priorities });
      }
      for (const mission of state.temporary) {
        if (UNFINISHED.has(mission.status)) Object.assign(mission, { status: 'interrupted',
          text: '旧连接未完成的任务已中断，不自动重放', finishedAt: Date.now() });
      }
      if (state.primary.status === 'running' || state.primary.pausedBy !== 'user') state.primary.status = 'interrupted';
      state.primary.pausedBy = state.primary.enabled ? null : 'user';
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Preserve an unreadable/corrupt record rather than silently overwriting it.
        throw new Error(redact(`Web 记录读取失败：${error.message}`));
      }
    }
    const session = { bot, partition: identity, partitionKey, file, state, ready, connected: true,
      transitions: Promise.resolve(), chats: Promise.resolve(), active: null, kickPending: false, gameCommands: new Map(), removeListeners: [] };
    current = session;
    if (!state.primary.enabled) bot.autonomyStartupCancelled = true;
    if (actions.tasks.current?.kind === 'autonomy') {
      capturePrimary(session, actions.tasks.current);
    }
    const listen = (event, listener) => {
      bot.on?.(event, listener);
      session.removeListeners.push(() => bot.removeListener?.(event, listener));
    };
    listen('end', () => { if (current === session) void detach(session, '连接已断开，任务已中断'); });
    const checkPartition = () => {
      if (current === session && session.connected && JSON.stringify(partition(bot)) !== partitionKey) {
        try { void attach(bot).catch((error) => reportStorageError(current, error)); }
        catch (error) { reportStorageError(session, error); }
      }
    };
    for (const event of ['game', 'spawn', 'respawn']) listen(event, checkPartition);
    listen('agentProgress', () => { if (live(session)) notify(); });
    listen('health', () => { if (live(session)) reconcile(); });
    save(session);
    // Caller owns normal startup. attach never calls startAutonomy or replays work.
    return ready.then(() => view(session));
  }

  async function sessionForSend() {
    if (closed) throw new Error('Web controller 已关闭');
    if (current?.connected && JSON.stringify(partition(current.bot)) !== current.partitionKey) await attach(current.bot);
    const session = current;
    if (!session || !live(session)) throw new Error('Web 尚未连接到 Minecraft 世界');
    await session.ready;
    if (!live(session)) throw new Error('Web 连接已改变，请重试');
    return session;
  }

  async function send(message, mode = 'chat', gameCommand) {
    if (typeof message !== 'string' || !message.trim()) throw new Error('消息不能为空');
    if (!['chat', 'task'].includes(mode)) throw new Error('mode 必须是 chat 或 task');
    const session = await sessionForSend();
    const id = randomUUID();
    const text = redact(message.trim());
    if (manual && STOP_COMMAND.test(text)) {
      const active = session.active;
      for (const mission of session.state.temporary) {
        if (mission.status !== 'queued') continue;
        Object.assign(mission, { status: 'cancelled', text: '收到停止指令，已取消排队', finishedAt: Date.now() });
        session.gameCommands.delete(mission.id);
      }
      if (active) {
        active.mission.status = 'cancelling';
        cancelRuntime(active, 'cancelled', '玩家叫停，已停止当前指令');
      }
      if (gameCommand) gameCommand.reply('已停止执行，等待下一条指令。');
      else {
        addMessage(session, 'user', text, undefined, id);
        addMessage(session, 'assistant', '已停止执行，等待下一条指令。');
      }
      save(session);
      return { id };
    }
    if (manual) mode = 'task';
    addMessage(session, 'user', text, mode === 'task' ? id : undefined, id);
    if (mode === 'task') {
      if (gameCommand) session.gameCommands.set(id, gameCommand);
      session.state.temporary.push({ id, label: text.slice(0, 80), description: text, text,
        ...(manual ? { source: gameCommand ? 'game' : 'web', requester: gameCommand?.player } : {}),
        status: 'queued', createdAt: Date.now() });
      save(session);
      kick(session);
    } else {
      save(session);
      const runtime = makeRuntime(session, id);
      runtime.done = session.chats.catch(() => {}).then(async () => {
        try {
          const reply = await ask(runtime, 'chat');
          addMessage(session, 'assistant', reply);
        } catch (error) {
          if (live(session) && !runtime.controller.signal.aborted) addMessage(session, 'system', `Web 对话失败：${redact(error.message)}`);
        } finally {
          await cleanup(runtime);
          runtime.controller.abort('Web 对话结束');
          runtimes.delete(id);
          if (live(session)) saveSafely(session);
        }
      });
      session.chats = runtime.done;
      runtime.done.catch(() => {});
    }
    return { id };
  }

  async function cancelTemporary(id) {
    const session = current;
    if (!session || !live(session)) return false;
    const mission = session.state.temporary.find((item) => item.id === id);
    if (!mission || !UNFINISHED.has(mission.status)) return false;
    const runtime = session.active?.id === id ? session.active : null;
    if (runtime) {
      mission.status = 'cancelling';
      cancelRuntime(runtime, 'cancelled', '用户取消了临时任务');
    } else {
      Object.assign(mission, { status: 'cancelled', text: '用户取消了排队任务', finishedAt: Date.now() });
      session.gameCommands.delete(id);
    }
    saveSafely(session);
    if (runtime) await runtime.done;
    else kick(session);
    return true;
  }

  async function setPrimary(operation) {
    if (manual) throw new Error('当前是指令模式，自主生存已停用');
    if (!['pause', 'resume'].includes(operation)) throw new Error('主任务操作必须是 pause 或 resume');
    const session = await sessionForSend();
    // Publish user intent immediately, even while a preemption awaits finally.
    session.state.primary.enabled = operation === 'resume';
    session.state.primary.pausedBy = operation === 'pause' ? 'user' : session.active?.id ?? null;
    session.bot.autonomyStartupCancelled = true;
    save(session);
    await transition(session, async () => {
      const primary = session.state.primary;
      if (!primary.enabled) {
        primary.status = 'paused';
        const task = actions.tasks.current;
        if (task?.kind === 'autonomy') {
          session.primaryTask = task;
          actions.tasks.cancel('Web 暂停主任务，保存检查点');
          await drained(task);
        }
      } else if (!session.active) await resumePrimary(session);
      else {
        session.active.resume = true;
        primary.status = 'paused';
      }
      if (live(session)) save(session);
    });
    kick(session);
    return view(session).primary;
  }

  async function setPriorities(priorities) {
    if (manual) throw new Error('游戏和 Web 指令共用同一优先级');
    if (!priorities || Object.keys(priorities).some((key) => !['temporary', 'primary'].includes(key))
      || Object.values(priorities).some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('优先级必须是 temporary/primary 的有限数值');
    }
    const session = await sessionForSend();
    Object.assign(session.state.priorities, priorities);
    save(session);
    kick(session);
    return { ...session.state.priorities };
  }

  async function waitIdle() {
    // Queued missions blocked by a running primary count as idle. Running
    // background tools and LLM calls do not; no Minecraft process is required.
    for (;;) {
      const session = current;
      if (!session) return;
      await session.transitions;
      const pending = [...runtimes.values()].filter((runtime) => runtime.session === session).map((runtime) => runtime.done);
      if (!pending.length && !session.kickPending) return;
      await Promise.allSettled(pending);
    }
  }

  function reconcile() {
    const session = current;
    if (!session || !live(session)) return view();
    if (!session.active && actions.tasks.current?.kind === 'autonomy'
      && capturePrimary(session, actions.tasks.current)) saveSafely(session);
    if (session.active && !session.active.controller.signal.aborted) {
      try { checkEmergency(session.active); } catch { /* executeMission performs cleanup and restoration. */ }
    }
    kick(session);
    return view();
  }

  const safetyTimer = setInterval(reconcile, 1000);
  safetyTimer.unref();

  function close() {
    if (closing) return closing;
    clearInterval(safetyTimer);
    closed = true;
    closing = detach(current, 'Web controller 已关闭，未完成任务已中断').finally(() => {
      unsubscribeTasks();
      listeners.clear();
    });
    return closing;
  }

  return { attach, send,
    sendGame: (message, command) => send(message, 'task', command),
    cancelTemporary, setPrimary, setPriorities, snapshot: () => view(),
    subscribe(fn) {
      if (typeof fn !== 'function') throw new Error('subscribe 需要函数');
      listeners.add(fn);
      try { fn(view()); } catch { /* Isolate subscriber exceptions. */ }
      return () => listeners.delete(fn);
    }, close, waitIdle, reconcile };
}
