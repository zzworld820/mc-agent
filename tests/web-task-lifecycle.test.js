import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTaskManager } from '../src/actions/taskManager.js';
import { runAgentLoop } from '../src/chat/agentLoop.js';
import { createChatHandler } from '../src/chat/chatHandler.js';

test('Web临时任务即使取消也通知调度器，并保留所属任务标识', async () => {
  const tasks = createTaskManager();
  const outcomes = [];
  tasks.onSettled((outcome) => outcomes.push(outcome));
  const task = tasks.start({ label: '临时采集', missionId: 'web-one', source: 'web' }, async ({ signal }) => {
    if (signal.aborted) throw new Error('cancelled');
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  });
  tasks.cancel('用户取消临时任务');
  await task.settled;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].task.missionId, 'web-one');
  assert.equal(outcomes[0].task.source, 'web');
  assert.equal(outcomes[0].aborted, true);
});

test('取消后的模型回复无法再执行旧临时任务的工具', async () => {
  const original = globalThis.fetch;
  let finish;
  globalThis.fetch = async () => new Promise((resolve) => { finish = resolve; });
  const abort = new AbortController();
  let calls = 0;
  try {
    const thinking = runAgentLoop({ llm: { baseUrl: 'http://test', apiKey: 'test', model: 'test', timeoutMs: 10000 },
      messages: [{ role: 'user', content: '临时采木' }], context: { signal: abort.signal },
      actions: { toolDefinitions: [], run: async () => { calls++; return 'started'; } } });
    abort.abort('用户取消');
    finish({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '',
      tool_calls: [{ id: 'one', function: { name: 'collect_block', arguments: '{}' } }] } }] }) });
    await assert.rejects(thinking, { name: 'AbortError' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('Web任务结果交回Web调度器，游戏聊天处理器跳过该来源', async () => {
  let resultHandler;
  let sent = 0;
  const handler = createChatHandler({ npc: { name: '测试', memorySize: 12 }, llm: {},
    actions: { tasks: { onFinish(fn) { resultHandler = fn; } } } });
  assert.ok(handler.attach);
  const bot = Object.assign(new EventEmitter(), { username: 'TestAgent',
    whisper() { sent++; }, chat() { sent++; } });
  handler.attach(bot);
  assert.equal(resultHandler({ task: { source: 'web', owner: 'web', label: '临时任务' }, ok: true, result: '完成' }), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, 0);
});
