import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import { createTaskManager } from '../src/actions/taskManager.js';
import { createWebController } from '../src/web/controller.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await immediate();
  }
  assert.fail('condition did not become true');
}

function bot(world = 'world', dimension = 'overworld', username = 'WebBot') {
  return Object.assign(new EventEmitter(), {
    username, buildingServer: 'test:25565', health: 20, food: 20, entities: {}, players: {},
    game: { dimension }, memory: { agentId: username, worldId: world, manager: { epoch: 'initial' } },
    entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => [], slots: [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    chat() { assert.fail('controller must never send game chat'); },
    whisper() { assert.fail('controller must never send game whispers'); },
  });
}

async function fixture(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'web-controller-'));
  const events = [];
  const tasks = createTaskManager();
  const implementations = new Map();
  const definitions = ['go_to', 'collect_block', 'give_item', 'craft_item', 'look_around', 'find_block',
    'check_inventory', 'scan_environment', 'get_world_state', 'assess_danger', 'start_autonomy', 'stop_autonomy',
    'stop', 'chat', 'whisper', 'send_message', 'remember_note'];
  const actions = {
    tasks, toolDefinitions: definitions.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    describeActivity: () => tasks.describe(),
    async run(name, args, context) {
      events.push({ type: 'tool', name, args, context });
      return implementations.get(name)?.(args, context) ?? '观察完成';
    },
  };
  let checkpoint = 0;
  const starts = [];
  const start = ({ bot: activeBot, mode }) => {
    activeBot.activeAutonomyMode = mode;
    starts.push({ mode, checkpoint });
    events.push({ type: 'primary', checkpoint, mode });
    tasks.start({ kind: 'autonomy', label: mode === 'milestones' ? '手动里程碑' : '原生存计划' }, async ({ signal }) => {
      try {
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('主任务取消')), { once: true }));
      } finally {
        if (options.checkpointGate) await options.checkpointGate.promise;
        checkpoint += 1;
        events.push({ type: 'checkpoint', checkpoint });
      }
    });
    return '从检查点继续原计划';
  };
  const controller = createWebController({ actions, llm: { apiKey: 'test-secret', ...options.llm },
    npc: { name: '测试', autonomy: 'auto', ...options.npc }, storageDirectory: directory,
    priorities: options.priorities,
    dependencies: { startAutonomy: start, ...(options.realDanger ? {} : { readDanger: () => options.risk?.value ?? { retreat: false } }),
      ...(options.realLoop ? {} : { runAgentLoop: options.loop ?? (async () => '已核实完成') }) } });
  const activeBot = options.bot ?? bot();
  await controller.attach(activeBot);
  t.after(async () => {
    options.checkpointGate?.resolve();
    await controller.close();
    const task = tasks.current;
    tasks.cancel('测试结束');
    await task?.settled;
    await rm(directory, { recursive: true, force: true });
  });
  function background(name, gate, { supply = null, report = 'never' } = {}) {
    implementations.set(name, (_args, context) => {
      const task = tasks.start({ label: name, kind: 'work', owner: 'web', isWhisper: true,
        source: context.source, missionId: context.missionId, supply, report }, async ({ signal }) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('动作已取消')), { once: true });
          gate.promise.then(resolve, reject);
        });
      });
      return `已开始 #${task.id}`;
    });
  }
  return { controller, actions, tasks, implementations, events, starts, start, bot: activeBot, directory, background };
}

test('temporary preemption waits for the strategy finally checkpoint, then restores the original plan', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { checkpointGate: gate,
    loop: async ({ actions, context }) => {
      assert.equal(context.player, 'web');
      assert.equal(context.isWhisper, true);
      assert.equal(context.source, 'web');
      assert.ok(context.missionId);
      assert.ok(context.signal instanceof AbortSignal);
      await actions.run('check_inventory', {});
      return '检查完成';
    } });
  f.start({ bot: f.bot, mode: 'survival' });
  await immediate();
  const { id } = await f.controller.send('检查背包', 'task');
  await until(() => f.tasks.current === null);
  assert.equal(f.events.filter((event) => event.type === 'tool').length, 0);
  assert.equal(f.controller.snapshot().primary.pausedBy, id);
  gate.resolve();
  await f.controller.waitIdle();
  assert.deepEqual(f.starts, [{ mode: 'survival', checkpoint: 0 }, { mode: 'survival', checkpoint: 1 }]);
  assert.equal(f.controller.snapshot().temporary[0].status, 'completed');
  assert.equal(f.controller.snapshot().primary.status, 'running');
  assert.equal(f.controller.snapshot().primary.pausedBy, null);
  assert.equal(f.events.find((event) => event.type === 'tool').context.missionId, id);
});

test('manually started milestones are restored even when npc.autonomy is off', async (t) => {
  const f = await fixture(t, { npc: { autonomy: 'off' } });
  f.start({ bot: f.bot, mode: 'milestones' });
  await immediate();
  await f.controller.send('临时检查', 'task');
  await f.controller.waitIdle();
  assert.deepEqual(f.starts.map((entry) => entry.mode), ['milestones', 'milestones']);
  const { primary } = f.controller.snapshot();
  assert.equal(primary.enabled, true);
  assert.equal(primary.mode, 'milestones');
  assert.equal(primary.label, '手动里程碑');
});

test('no key reports a real failure without interrupting or pretending to complete', async (t) => {
  const f = await fixture(t, { llm: { apiKey: '' }, loop: () => assert.fail('missing key must not call LLM') });
  f.start({ bot: f.bot, mode: 'survival' });
  const original = f.tasks.current;
  await f.controller.send('交付物品', 'task');
  await f.controller.send('你好');
  await f.controller.waitIdle();
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.temporary[0].status, 'failed');
  assert.match(snapshot.temporary[0].error, /LLM_API_KEY/);
  assert.equal(f.tasks.current, original);
  assert.equal(snapshot.messages.filter((message) => message.role === 'assistant').length, 0);
  assert.ok(snapshot.messages.filter((message) => /LLM_API_KEY/.test(message.content)).length >= 2);
});

test('temporary missions run FIFO and use onSettled even when report is never', async (t) => {
  const first = deferred();
  const f = await fixture(t, { loop: async ({ actions, messages }) => {
    const request = messages.findLast((message) => message.role === 'user').content;
    await actions.run('collect_block', { request });
    return `完成 ${request}`;
  } });
  f.background('collect_block', first);
  f.start({ bot: f.bot, mode: 'survival' });
  await immediate();
  const a = await f.controller.send('第一件', 'task');
  await until(() => f.tasks.current?.missionId === a.id);
  const b = await f.controller.send('第二件', 'task');
  await immediate();
  assert.deepEqual(f.controller.snapshot().queue.map((mission) => mission.id), [b.id]);
  assert.equal(f.tasks.current.missionId, a.id);
  first.resolve('已采集');
  await f.controller.waitIdle();
  assert.deepEqual(f.events.filter((event) => event.type === 'tool').map((event) => event.args.request), ['第一件', '第二件']);
  assert.deepEqual(f.controller.snapshot().temporary.map((mission) => mission.status), ['completed', 'completed']);
  assert.equal(f.starts.length, 3);
});

test('instant background completion is fed back before the next step', async (t) => {
  const f = await fixture(t, { loop: async ({ actions }) => {
    const result = await actions.run('collect_block', {});
    assert.match(result, /【任务结果】.*完成.*已采集/);
    assert.equal(f.tasks.current, null);
    await actions.run('give_item', {});
    return '采集并交付完成';
  } });
  f.implementations.set('collect_block', async (_args, context) => {
    const task = f.tasks.start({ label: '瞬时采集', source: context.source, missionId: context.missionId, report: 'never' }, async () => '已采集');
    await task.settled; // It has already disappeared from tasks.current when run returns.
    return '已开始';
  });
  await f.controller.send('采集后交给我', 'task');
  await f.controller.waitIdle();
  assert.equal(f.controller.snapshot().temporary[0].status, 'completed');
  assert.deepEqual(f.events.filter((event) => event.type === 'tool').map((event) => event.name), ['collect_block', 'give_item']);
});

test('cancel aborts LLM immediately and stale replies/tools cannot affect the next mission', async (t) => {
  const late = deferred();
  let old;
  let calls = 0;
  const f = await fixture(t, { loop: async (request) => {
    if (calls++ === 0) { old = request; return late.promise; }
    return '新任务已核实';
  } });
  f.start({ bot: f.bot, mode: 'survival' });
  const a = await f.controller.send('旧任务', 'task');
  await until(() => old);
  const b = await f.controller.send('新任务', 'task');
  assert.equal(await f.controller.cancelTemporary(a.id), true);
  assert.equal(old.context.signal.aborted, true);
  await f.controller.waitIdle();
  await assert.rejects(old.actions.run('give_item', {}), /已中止/);
  late.resolve('旧任务成功（不得出现）');
  await immediate();
  const snapshot = f.controller.snapshot();
  assert.deepEqual(snapshot.temporary.map((mission) => [mission.id, mission.status]), [[a.id, 'cancelled'], [b.id, 'completed']]);
  assert.ok(!snapshot.messages.some((message) => message.content.includes('不得出现')));
  assert.equal(f.events.filter((event) => event.type === 'tool').length, 0);
});

test('cancelling a background task waits for settlement before resuming primary', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { loop: async ({ actions }) => {
    await actions.run('go_to', {});
    return '到达';
  } });
  f.background('go_to', gate);
  f.start({ bot: f.bot, mode: 'survival' });
  const { id } = await f.controller.send('去指定地点', 'task');
  await until(() => f.tasks.current?.missionId === id);
  await f.controller.cancelTemporary(id);
  assert.equal(f.controller.snapshot().temporary[0].status, 'cancelled');
  assert.equal(f.tasks.current.kind, 'autonomy');
  assert.equal(f.starts.length, 2);
});

test('a queued cancellation never invokes LLM or displaces the current mission', async (t) => {
  const gate = deferred();
  let thinking = 0;
  const f = await fixture(t, { loop: async () => { thinking++; return gate.promise; } });
  const a = await f.controller.send('运行', 'task');
  await until(() => thinking === 1);
  const b = await f.controller.send('排队', 'task');
  assert.equal(await f.controller.cancelTemporary(b.id), true);
  assert.equal(await f.controller.cancelTemporary(b.id), false);
  assert.equal(f.controller.snapshot().temporary.find((mission) => mission.id === a.id).status, 'running');
  gate.resolve('完成');
  await f.controller.waitIdle();
  assert.equal(thinking, 1);
});

test('configurable priorities queue against a running primary and re-evaluate on increases', async (t) => {
  const f = await fixture(t, { priorities: { temporary: 50, primary: 50 } });
  f.start({ bot: f.bot, mode: 'survival' });
  const original = f.tasks.current;
  await f.controller.send('低优先级任务', 'task');
  await f.controller.waitIdle();
  assert.equal(f.controller.snapshot().queue.length, 1);
  assert.equal(f.tasks.current, original);
  await f.controller.setPriorities({ temporary: 51 });
  await f.controller.waitIdle();
  assert.equal(f.controller.snapshot().temporary[0].status, 'completed');
  assert.equal(f.starts.length, 2);
});

test('pausing primary during a temporary mission prevents automatic restoration', async (t) => {
  const gate = deferred();
  let thinking = false;
  const f = await fixture(t, { loop: async () => { thinking = true; return gate.promise; } });
  f.start({ bot: f.bot, mode: 'survival' });
  await f.controller.send('临时任务', 'task');
  await until(() => thinking);
  await f.controller.setPrimary('pause');
  gate.resolve('临时完成');
  await f.controller.waitIdle();
  assert.equal(f.tasks.current, null);
  assert.equal(f.controller.snapshot().primary.enabled, false);
  await f.controller.setPrimary('resume');
  assert.equal(f.tasks.current.kind, 'autonomy');
});

test('chat exposes only perception and task mode rejects autonomy and game chat tools', async (t) => {
  const seen = [];
  const f = await fixture(t, { loop: async ({ actions }) => {
    seen.push(actions.toolDefinitions.map((tool) => tool.function.name));
    await assert.rejects(actions.run('start_autonomy', {}), /不允许/);
    await assert.rejects(actions.run('stop', {}), /不允许/);
    await assert.rejects(actions.run('whisper', {}), /不允许/);
    if (seen.length === 1) await assert.rejects(actions.run('give_item', {}), /不允许/);
    await actions.run('check_inventory', {});
    return '只在 Web 回答';
  } });
  await f.controller.send('你好');
  await f.controller.waitIdle();
  await f.controller.send('查询', 'task');
  await f.controller.waitIdle();
  assert.deepEqual(seen[0].sort(), ['assess_danger', 'check_inventory', 'find_block', 'get_world_state', 'look_around', 'scan_environment']);
  assert.ok(seen[1].includes('give_item'));
  assert.ok(!seen[1].includes('start_autonomy'));
  assert.equal(f.bot.listenerCount('chat'), 0);
  assert.equal(f.bot.listenerCount('whisper'), 0);
});

test('upstream errors, messages, tool results, persisted records, and subscriber snapshots redact the key', async (t) => {
  const key = 'hidden-deepseek-test-key';
  const snapshots = [];
  const f = await fixture(t, { llm: { apiKey: key }, loop: async ({ actions }) => {
    const result = await actions.run('check_inventory', { text: key });
    assert.ok(!result.includes(key));
    throw new Error(`HTTP 401 Authorization: Bearer ${key}`);
  } });
  f.implementations.set('check_inventory', () => `工具返回 ${key}`);
  const unsubscribe = f.controller.subscribe((snapshot) => snapshots.push(snapshot));
  await f.controller.send(`执行 ${key}`, 'task');
  await f.controller.waitIdle();
  unsubscribe();
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.temporary[0].status, 'failed');
  assert.match(snapshot.temporary[0].error, /HTTP 401.*REDACTED/);
  assert.ok(!JSON.stringify(snapshot).includes(key));
  assert.ok(!JSON.stringify(snapshots).includes(key));
  assert.ok(!JSON.stringify(f.events).includes(key));
  for (const file of await readdir(f.directory)) assert.ok(!(await readFile(join(f.directory, file), 'utf8')).includes(key));
});

test('failed background results continue the LLM but cannot produce a successful mission record', async (t) => {
  const f = await fixture(t, { loop: async ({ actions }) => {
    const result = await actions.run('collect_block', {});
    assert.match(result, /失败.*挖掘失败/);
    return '工具未完成采集';
  } });
  const failure = deferred();
  failure.reject(new Error('挖掘失败'));
  failure.promise.catch(() => {});
  f.background('collect_block', failure);
  f.start({ bot: f.bot, mode: 'survival' });
  await f.controller.send('采集', 'task');
  await f.controller.waitIdle();
  assert.equal(f.controller.snapshot().temporary[0].status, 'failed');
  assert.equal(f.tasks.current.kind, 'autonomy');
});

test('reconnect interrupts the old mission, prevents late results, and keeps partitions isolated', async (t) => {
  const late = deferred();
  let request;
  const f = await fixture(t, { loop: async (input) => { request = input; return late.promise; } });
  await f.controller.send('旧连接任务', 'task');
  await until(() => request);
  await f.controller.attach(bot());
  assert.equal(request.context.signal.aborted, true);
  assert.equal(f.controller.snapshot().temporary[0].status, 'interrupted');
  assert.equal(f.starts.length, 0, 'attach must not start autonomy');
  await assert.rejects(request.actions.run('give_item', {}), /已中止/);
  late.resolve('旧连接不能写入');
  await immediate();
  assert.ok(!f.controller.snapshot().messages.some((message) => message.content.includes('不能写入')));
  await f.controller.attach(bot('another-world'));
  assert.equal(f.controller.snapshot().messages.length, 0);
  await f.controller.attach(bot('world', 'the_nether'));
  assert.equal(f.controller.snapshot().temporary.length, 0);
  await f.controller.attach(bot('world', 'overworld', 'OtherBot'));
  assert.equal(f.controller.snapshot().messages.length, 0);
  await f.controller.attach(bot());
  assert.equal(f.controller.snapshot().temporary[0].status, 'interrupted');
});

test('persisted running records are interrupted on load and never replayed', async (t) => {
  const f = await fixture(t);
  await f.controller.send('原始记录');
  await f.controller.waitIdle();
  const [file] = await readdir(f.directory);
  const path = join(f.directory, file);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.temporary.push({ id: 'delivered-before-crash', label: '交付', text: '正在交付', status: 'running', createdAt: 1 });
  await writeFile(path, JSON.stringify(saved));
  // Reopen without detaching the existing in-memory session into the same file.
  const second = createWebController({ actions: f.actions, npc: { autonomy: 'auto' }, llm: { apiKey: 'test' },
    storageDirectory: f.directory, dependencies: { runAgentLoop: () => assert.fail('must not replay') } });
  t.after(() => second.close());
  await second.attach(bot());
  await second.waitIdle();
  assert.equal(second.snapshot().temporary[0].status, 'interrupted');
  assert.equal(second.snapshot().messages[0].content, '原始记录');
  assert.equal((await readdir(f.directory)).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('emergency danger queues new work until safe, regardless of temporary priority', async (t) => {
  const risk = { value: { retreat: true, reasons: ['苦力怕'] } };
  const f = await fixture(t, { risk, priorities: { temporary: 1000, primary: 1 } });
  f.start({ bot: f.bot, mode: 'survival' });
  const primary = f.tasks.current;
  await f.controller.send('危险时仍要排队', 'task');
  await f.controller.waitIdle();
  assert.equal(f.tasks.current, primary);
  assert.match(f.controller.snapshot().queue[0].text, /苦力怕/);
  risk.value = { retreat: false };
  f.controller.reconcile();
  await f.controller.waitIdle();
  assert.equal(f.controller.snapshot().temporary[0].status, 'completed');
});

test('low health interrupts LLM thinking, restores survival, and retains the reason', async (t) => {
  let request;
  const f = await fixture(t, { realDanger: true, loop: async (input) => { request = input; return new Promise(() => {}); } });
  f.start({ bot: f.bot, mode: 'survival' });
  await f.controller.send('思考期间危险', 'task');
  await until(() => request);
  f.bot.health = 6;
  f.bot.emit('health');
  await f.controller.waitIdle();
  assert.equal(request.context.signal.aborted, true);
  const mission = f.controller.snapshot().temporary[0];
  assert.equal(mission.status, 'interrupted');
  assert.match(mission.text, /生命值 6/);
  assert.equal(f.tasks.current.kind, 'autonomy');
});

test('danger interrupts an unprotected action but leaves supplied actions to runSuppliedTask', async (t) => {
  for (const supplied of [false, true]) {
    const gate = deferred();
    const risk = { value: { retreat: false } };
    let signal;
    const f = await fixture(t, { risk, loop: async ({ actions, context }) => {
      signal = context.signal;
      await actions.run('go_to', {});
      return '已到达';
    } });
    f.background('go_to', gate, { supply: supplied ? { profile: 'travel' } : null });
    f.start({ bot: f.bot, mode: 'survival' });
    const { id } = await f.controller.send('行走', 'task');
    await until(() => f.tasks.current?.missionId === id);
    risk.value = { retreat: true, reasons: ['熔岩'] };
    f.controller.reconcile();
    await immediate();
    assert.equal(signal.aborted, !supplied);
    if (supplied) {
      assert.equal(f.tasks.current.missionId, id);
      risk.value = { retreat: false };
      gate.resolve('抵达');
    }
    await f.controller.waitIdle();
    assert.equal(f.controller.snapshot().temporary[0].status, supplied ? 'completed' : 'interrupted');
    assert.equal(f.tasks.current.kind, 'autonomy');
  }
});

test('the real runAgentLoop consumes background results and performs a second tool without Minecraft', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    bodies.push(body);
    const step = bodies.length;
    const message = step <= 2
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${step}`, type: 'function',
        function: { name: step === 1 ? 'collect_block' : 'give_item', arguments: '{}' } }] }
      : { role: 'assistant', content: '已采集并交付' };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  const f = await fixture(t, { realLoop: true, llm: { baseUrl: 'https://unused.invalid', model: 'test', timeoutMs: 1000 } });
  for (const name of ['collect_block', 'give_item']) f.implementations.set(name, (_args, context) => {
    f.tasks.start({ label: name, report: 'never', source: context.source, missionId: context.missionId }, async () => `${name} 实际完成`);
    return '已开始';
  });
  await f.controller.send('采集后交付', 'task');
  await f.controller.waitIdle();
  assert.equal(bodies.length, 3);
  assert.match(bodies[1].messages.find((message) => message.role === 'tool').content, /实际完成/);
  assert.equal(f.controller.snapshot().temporary[0].status, 'completed');
  assert.equal(f.controller.snapshot().messages.at(-1).content, '已采集并交付');
});

test('real HTTP errors are redacted and cancelled HTTP requests receive the mission signal', async (t) => {
  const key = 'secret-upstream-token';
  const f = await fixture(t, { realLoop: true, llm: { apiKey: key, baseUrl: 'https://unused.invalid', model: 'test', timeoutMs: 10000 } });
  t.mock.method(globalThis, 'fetch', async () => new Response(`authorization ${key}`, { status: 401 }));
  await f.controller.send('请求失败', 'task');
  await f.controller.waitIdle();
  assert.equal(f.controller.snapshot().temporary[0].status, 'failed');
  assert.ok(!JSON.stringify(f.controller.snapshot()).includes(key));
  let requestSignal;
  globalThis.fetch.mock.restore();
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requestSignal = request.signal;
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error(`aborted ${key}`)), { once: true }));
  });
  const { id } = await f.controller.send('取消请求', 'task');
  await until(() => requestSignal);
  await f.controller.cancelTemporary(id);
  assert.equal(requestSignal.aborted, true);
  assert.equal(f.controller.snapshot().temporary.at(-1).status, 'cancelled');
  assert.ok(!JSON.stringify(f.controller.snapshot()).includes(key));
});

test('rapid reconnects retain the drain barrier for an old async action', async (t) => {
  const gate = deferred();
  let oldAction = false;
  let thinks = 0;
  const f = await fixture(t, { loop: async ({ actions }) => {
    if (thinks++ === 0) await actions.run('craft_item', {});
    return '当前任务已核实';
  } });
  f.implementations.set('craft_item', async () => { oldAction = true; await gate.promise; return '旧合成已退出'; });
  await f.controller.send('旧合成', 'task');
  await until(() => oldAction);
  const b = f.controller.attach(bot('world-b'));
  const c = f.controller.attach(bot('world-c'));
  let admitted = false;
  const next = f.controller.send('新任务', 'task').then(() => { admitted = true; });
  await immediate();
  assert.equal(admitted, false);
  assert.equal(thinks, 1);
  gate.resolve();
  await Promise.all([b, c, next]);
  await f.controller.waitIdle();
  assert.equal(thinks, 2);
  assert.equal(f.controller.snapshot().temporary.length, 1);
  assert.equal(f.controller.snapshot().temporary[0].status, 'completed');
});

test('external task takeover interrupts the old mission and defers primary restore until it settles', async (t) => {
  const old = deferred();
  const other = deferred();
  const f = await fixture(t, { loop: async ({ actions }) => {
    await actions.run('go_to', {});
    return '不可冒充完成';
  } });
  f.background('go_to', old);
  f.start({ bot: f.bot, mode: 'survival' });
  const { id } = await f.controller.send('旧临时动作', 'task');
  await until(() => f.tasks.current?.missionId === id);
  const external = f.tasks.start({ kind: 'move', label: '游戏内新任务', source: 'game' }, () => other.promise);
  await f.controller.waitIdle();
  assert.equal(f.controller.snapshot().temporary[0].status, 'interrupted');
  assert.equal(f.tasks.current, external);
  other.resolve('游戏任务完成');
  await external.settled;
  await f.controller.waitIdle();
  assert.equal(f.tasks.current.kind, 'autonomy');
  assert.equal(f.controller.snapshot().primary.pausedBy, null);
});

test('serial chat history excludes future requests and includes the previous completed reply', async (t) => {
  const first = deferred();
  const histories = [];
  const f = await fixture(t, { loop: async ({ messages }) => {
    histories.push(messages.slice(1).map((message) => message.content));
    if (histories.length === 1) return first.promise;
    return '第二个回答';
  } });
  await f.controller.send('第一条');
  await f.controller.send('第二条');
  await until(() => histories.length === 1);
  first.resolve('第一个回答');
  await f.controller.waitIdle();
  assert.deepEqual(histories, [['第一条'], ['第一条', '第一个回答', '第二条']]);
});

test('primary resume failures are explicit, redacted, and do not strand an active mission', async (t) => {
  const f = await fixture(t);
  f.bot.autonomyOptions = { allowDig: false };
  const controller = createWebController({ actions: f.actions, llm: { apiKey: 'test-secret' },
    npc: { autonomy: 'auto' }, storageDirectory: join(f.directory, 'refused'),
    dependencies: { runAgentLoop: async () => '临时处理完成', readDanger: () => ({ retreat: false }),
      startAutonomy: async () => { throw new Error('拒绝 test-secret'); } } });
  t.after(() => controller.close());
  await controller.attach(f.bot);
  await controller.send('检查', 'task');
  await controller.waitIdle();
  assert.equal(controller.snapshot().temporary[0].status, 'completed');
  assert.equal(controller.snapshot().primary.status, 'failed');
  assert.equal(controller.snapshot().primary.pausedBy, null);
  assert.match(controller.snapshot().primary.text, /恢复失败.*REDACTED/);
});

test('manual mode gives game and ordinary Web conversation the same executable FIFO queue', async (t) => {
  const pendingSkill = deferred();
  const f = await fixture(t, {
    npc: { manualControl: true, autonomy: 'auto' },
    risk: { value: { retreat: true, reasons: ['测试危险感知只上报'] } },
    loop: async ({ actions, context, messages }) => {
      const names = actions.toolDefinitions.map(tool => tool.function.name);
      assert.ok(names.includes('collect_block'));
      assert.ok(!names.includes('start_autonomy'));
      assert.match(messages[0].content, /完成或失败后待命/);
      if (context.source === 'game') {
        assert.equal(context.player, 'Player');
        const result = await actions.run('collect_block', { block: 'oak_log' });
        assert.match(result, /实际木料/);
        return '实际采到了木头';
      }
      assert.equal(context.player, 'web');
      return actions.run('go_to', { x: 2, y: 64, z: 0 });
    },
  });
  f.background('collect_block', pendingSkill);
  f.implementations.set('go_to', () => '已到达');
  const replies = [];
  const game = await f.controller.sendGame('砍木头', { player: 'Player', isWhisper: true, reply: value => replies.push(value) });
  await until(() => f.tasks.current?.missionId === game.id);
  const web = await f.controller.send('走到 2 64 0', 'chat');
  assert.deepEqual(f.controller.snapshot().queue.map(item => item.id), [web.id]);
  assert.deepEqual(f.events.filter(event => event.type === 'tool').map(event => event.name), ['collect_block']);
  pendingSkill.resolve('实际木料 oak_log ×4');
  await f.controller.waitIdle();
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.manual, true);
  assert.equal(snapshot.primary.enabled, false);
  assert.deepEqual(snapshot.priorities, { temporary: 100, primary: 0 });
  assert.deepEqual(snapshot.temporary.map(item => [item.source, item.status]), [['game', 'completed'], ['web', 'completed']]);
  assert.deepEqual(replies, ['实际采到了木头']);
  assert.equal(f.starts.length, 0);
  assert.equal(f.tasks.current, null);
  await assert.rejects(f.controller.setPrimary('resume'), /自主生存已停用/);
});

test('manual stop cancels both an executing game skill and queued Web instructions', async (t) => {
  const held = deferred();
  const f = await fixture(t, { npc: { manualControl: true },
    loop: ({ actions }) => actions.run('go_to', {}) });
  f.background('go_to', held);
  const game = await f.controller.sendGame('跟我走', { player: 'Player', reply() {} });
  await until(() => f.tasks.current?.missionId === game.id);
  await f.controller.send('去树边');
  await f.controller.send('停下');
  await f.controller.waitIdle();
  assert.deepEqual(f.controller.snapshot().temporary.map(item => item.status), ['cancelled', 'cancelled']);
  assert.equal(f.tasks.current, null);
  assert.equal(f.starts.length, 0);
});

test('manual startup overrides an earlier autonomous setting without discarding command history', async t => {
  const f = await fixture(t, { npc: { manualControl: true, autonomy: 'auto' } });
  const created = await f.controller.send('查一下背包');
  await f.controller.waitIdle();
  await f.controller.close();
  const [file] = await readdir(f.directory);
  const fullPath = join(f.directory, file);
  const old = JSON.parse(await readFile(fullPath, 'utf8'));
  old.primary = { ...old.primary, enabled: true, mode: 'ai', pausedBy: null, status: 'running' };
  old.priorities = { temporary: 30, primary: 90 };
  await writeFile(fullPath, JSON.stringify(old));
  const reopened = await fixture(t, { directory: f.directory, npc: { manualControl: true } });
  const current = reopened.controller.snapshot();
  assert.equal(current.primary.mode, 'manual');
  assert.equal(current.primary.enabled, false);
  assert.deepEqual(current.priorities, { temporary: 100, primary: 0 });
  assert.ok(current.temporary.some(entry => entry.id === created.id));
  assert.equal(reopened.starts.length, 0);
});
