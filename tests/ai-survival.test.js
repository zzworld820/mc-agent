import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvivalPlanner } from '../src/strategy/ai.js';

const signal = new AbortController().signal;
const snapshot = { available: ['food', 'farm', 'obtain_item'], timeOfDay: 600, health: 20,
  evidence: { inventory: {} } };
const toolResult = (action) => ({ toolCalls: [{ function: {
  name: 'next_survival_step', arguments: JSON.stringify(action),
} }] });
const skill = (name, extra) => ({ type: 'skill', skill: name, plan: '选择下一步', success: '查看实测值', ...extra });

function makePlanner(complete, apiKey = 'test-key') {
  return createSurvivalPlanner({ npc: { name: '阿方' }, llm: { apiKey }, complete });
}

test('player goal and actual skill feedback reach the model before it selects another skill', async () => {
  const prompts = [];
  const planner = makePlanner(async (_llm, messages, tools) => {
    assert.equal(tools[0].function.name, 'next_survival_step');
    prompts.push(JSON.parse(messages[1].content));
    return toolResult(skill(prompts.length === 1 ? 'food' : 'farm'));
  });
  let notification;
  planner.submit('补充口粮', message => { notification = message; });
  const first = await planner.decide(snapshot, signal);
  assert.equal(first.skill, 'food');
  planner.record({ action: first, status: 'failed', reason: '箱子已打开，食物为零', evidence: { count: 0 } });
  const second = await planner.decide(snapshot, signal);
  assert.equal(second.skill, 'farm');
  assert.equal(prompts[1].objective, '补充口粮');
  assert.equal(prompts[1].feedback.evidence.count, 0);
  assert.deepEqual(prompts[1].tried, ['food']);
  planner.record({ action: second, status: 'failed', reason: '农田不可达' });
  assert.match(notification, /箱子已打开.*农田不可达/);
  assert.deepEqual(await planner.decide(snapshot, signal), { type: 'wait' });
});

test('a repeat, forbidden skill, or invalid quantity is held locally', async () => {
  const repeated = makePlanner(async () => toolResult(skill('food')));
  const first = await repeated.decide(snapshot, signal);
  repeated.record({ action: first, status: 'failed', reason: '没有食物' });
  assert.match((await repeated.decide(snapshot, signal)).reason, /更换/);
  for (const action of [skill('arbitrary_command'), skill('obtain_item', { item: 'cobblestone', count: 65 })]) {
    const planner = makePlanner(async () => toolResult(action));
    assert.equal((await planner.decide(snapshot, signal)).type, 'wait');
  }
});

test('completion requires real skill feedback and reports it to the player', async () => {
  let response = skill('obtain_item', { item: 'cobblestone', count: 20 });
  const planner = makePlanner(async () => toolResult(response));
  let notification;
  planner.submit('收集20块圆石', message => { notification = message; });
  const action = await planner.decide(snapshot, signal);
  planner.announce(action);
  assert.match(notification, /第一步方案/);
  planner.record({ action, status: 'completed', reason: '背包实测 cobblestone ×20', evidence: { inventory: { cobblestone: 20 } } });
  response = { type: 'done', plan: '已达到数量' };
  await planner.decide(snapshot, signal);
  assert.match(notification, /实测.*×20/);
});

test('danger abort discards an in-flight action and model outage requests local fallback', async () => {
  const interrupted = new AbortController();
  const planner = makePlanner(async () => {
    interrupted.abort(new Error('夜间审核'));
    return toolResult(skill('farm'));
  });
  await assert.rejects(planner.decide(snapshot, interrupted.signal), /夜间审核/);
  const offline = makePlanner(async () => { throw new Error('provider down'); });
  assert.equal((await offline.decide(snapshot, signal)).type, 'fallback');
  assert.equal((await makePlanner(async () => assert.fail('unexpected call'), '').decide(snapshot, signal)).type, 'fallback');
});

test('a newly submitted goal is not completed with an earlier autonomous action', async () => {
  let planner;
  planner = makePlanner(async () => {
    planner.submit('玩家新目标', () => {});
    return toolResult(skill('food'));
  });
  assert.deepEqual(await planner.decide(snapshot, signal), { type: 'wait' });
});

test('in-game chat registers an objective and starts the supervised AI task', async (t) => {
  const { EventEmitter, once } = await import('node:events');
  const { createChatHandler } = await import('../src/chat/chatHandler.js');
  const bot = Object.assign(new EventEmitter(), {
    username: 'TestBot', players: {}, game: { dimension: 'overworld' },
    whisper(player, reply) { this.emit('reply', player, reply); },
  });
  const tasks = {
    onFinish() {},
    start(info, work) { this.current = { ...info, work }; },
  };
  const actions = { tasks, describeActivity: () => '' };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { messages, tools } = JSON.parse(options.body);
    let message;
    if (tools[0].function.name === 'next_survival_step') {
      assert.equal(JSON.parse(messages[1].content).objective, '收集20块圆石');
      message = { role: 'assistant', tool_calls: toolResult(skill('obtain_item', { item: 'cobblestone', count: 20 })).toolCalls };
    } else if (messages.at(-1).role === 'tool') {
      assert.match(messages.at(-1).content, /目标已登记/);
      message = { role: 'assistant', content: '已收到。' };
    } else {
      assert.deepEqual(tools.map(tool => tool.function.name), ['submit_survival_goal', 'submit_survival_project', 'manage_survival_project']);
      message = { role: 'assistant', tool_calls: [{ id: 'call-1', function: {
        name: 'submit_survival_goal', arguments: JSON.stringify({ objective: '收集20块圆石' }),
      } }] };
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  createChatHandler({ actions, npc: { name: '阿方', autonomy: 'on', autonomyMode: 'ai', memorySize: 12 },
    llm: { apiKey: 'test-key', baseUrl: 'http://example.invalid', timeoutMs: 1000 } }).attach(bot);
  const reply = once(bot, 'reply');
  bot.emit('whisper', 'Player', '收集20块圆石');
  assert.deepEqual(await reply, ['Player', '已收到。']);
  assert.equal(bot.activeAutonomyMode, 'ai');
  assert.equal(tasks.current.kind, 'autonomy');
  assert.equal((await bot.survivalPlanner.decide(snapshot, signal)).count, 20);
});
