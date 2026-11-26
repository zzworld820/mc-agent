import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Vec3 } from 'vec3';
import { projectStore } from '../src/projects/store.js';
import { registerProject, refreshProject, recordProjectStep, changeProject } from '../src/projects/engine.js';
import { createSurvivalPlanner } from '../src/strategy/ai.js';
import { getHouseModel } from '../src/building/models.js';
import { projectShellPlan } from '../src/building/projects.js';

async function fixture(t) {
  const path = await mkdtemp(`${tmpdir()}/mc-projects-`);
  t.after(() => rm(path, { recursive: true, force: true }));
  const root = pathToFileURL(`${path}/`);
  const partition = { agent: 'test', world: 'world-a', dimension: 'overworld' };
  const reopen = () => projectStore(partition, root);
  const cells = new Map();
  const put = (p, name) => cells.set(String(p), { name, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => ({ age: 0, moisture: 7 }) });
  const world = { house: null };
  const bot = { game: { dimension: 'overworld' }, blockAt: p => cells.get(String(p)) ?? null,
    memory: { enabled: true, context: () => ({}), manager: { loadProjects: async () => world.house ? [world.house] : [] } } };
  return { reopen, store: reopen(), other: projectStore({ ...partition, world: 'world-b' }, root), world, put, bot };
}

test('housing goal and steps survive reopen and require the observed shell and facilities', async t => {
  const { store, reopen, other, world, put, bot } = await fixture(t);
  const project = await registerProject(store, { kind: 'house',
    options: { chests: 1, furnaces: 1 }, objective: '盖个房子，有床、箱子和熔炉', owner: { player: 'Owner' } });
  const state = { house: null, home: null, base: null };
  let view = await refreshProject(store, bot, state, project);
  assert.deepEqual(view.ready.map(job => job.id), ['shell']);
  assert.equal((await other.read()).active, null);
  const planner = createSurvivalPlanner({ npc: { name: '阿方' }, llm: { apiKey: 'mock' }, complete: async (_llm, messages) => {
    const data = JSON.parse(messages[1].content);
    assert.equal(data.objective, project.objective);
    return { toolCalls: [{ function: { name: 'next_survival_step', arguments: JSON.stringify({ type: 'done', plan: '木头已收齐' }) } }] };
  } });
  const decision = await planner.decide({ available: ['obtain_item'], project: { objective: project.objective, steps: view.steps } },
    new AbortController().signal);
  assert.equal(decision.type, 'wait');
  assert.equal((await reopen().read()).active.objective, project.objective);

  const origin = new Vec3(0, 70, 0);
  world.house = { id: 'actual-house', constructionRequestId: project.id, status: 'complete',
    origin, model: await getHouseModel('starter'), extensions: [] };
  state.house = { projectId: 'actual-house' };
  const door = origin.offset(3, 1, 0);
  for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) put(origin.offset(x, -1, z), 'stone');
  for (const entry of projectShellPlan(world.house)) put(origin.offset(...entry.offset), entry.targetItem);
  put(door.offset(0, 1, 0), 'oak_door');
  view = await refreshProject(reopen(), bot, state, (await reopen().read()).active);
  assert.deepEqual(view.ready.map(job => job.id), ['facilities']);

  const furniture = ['chest', 'furnace', 'crafting_table'];
  state.base = { ready: true, projectId: 'actual-house', jobs: {} };
  for (const [i, item] of furniture.entries()) {
    const position = origin.offset(i + 1, 1, 2);
    state.base.jobs[item] = { position, item, status: 'done' };
    if (item !== 'chest') put(position, item);
  }
  state.home = { bed: origin.offset(1, 1, 3) };
  put(state.home.bed, 'white_bed');
  put(state.home.bed.offset(0, 0, 1), 'white_bed');
  view = await refreshProject(store, bot, state, (await store.read()).active);
  assert.ok(view.ready.find(job => job.id === 'facilities'));
  put(state.base.jobs.chest.position, 'chest');
  put(origin.offset(0, -1, 0), 'air');
  view = await refreshProject(store, bot, state, (await store.read()).active);
  assert.equal(view.project.status, 'active');
  put(origin.offset(0, -1, 0), 'stone');
  view = await refreshProject(store, bot, state, (await store.read()).active);
  assert.equal(view.project.status, 'complete');
  assert.equal((await reopen().read()).history[0].id, project.id);
});

test('farm waits for newly verified crop harvest and planting on its original pinned farm', async t => {
  const { store, bot, put } = await fixture(t);
  const origin = new Vec3(0, 70, 0);
  const plot = origin.offset(1, 0, 0);
  const plots = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, z]) => ({ position: origin.offset(x, 0, z) }));
  const water = origin.offset(-1, 0, 0);
  const farm = { id: 'farm-one', width: 2, depth: 2, origin, dimension: 'overworld', lamps: [], expansions: [],
    plots, waters: [{ position: water }], harvestCycles: 3, harvestsByCrop: { wheat: 8 } };
  for (const entry of plots) {
    put(entry.position, 'farmland');
    put(entry.position.offset(0, 1, 0), 'wheat');
  }
  put(water, 'water');
  const project = await registerProject(store, { kind: 'farm',
    options: { width: 2, depth: 2, crop: 'wheat', harvest: true }, objective: '建小麦田并收割一轮' });
  let view = await refreshProject(store, bot, { farm }, project);
  assert.equal(view.steps.find(job => job.id === 'harvest').status, 'waiting');
  const replaced = { ...farm, id: 'wrong-farm', harvestCycles: 9 };
  view = await refreshProject(store, bot, { farm: replaced }, (await store.read()).active);
  assert.equal(view.ready.length, 0);
  farm.harvestCycles++;
  farm.harvestsByCrop.wheat++;
  put(plot.offset(0, 1, 0), 'air');
  view = await refreshProject(store, bot, { farm }, (await store.read()).active);
  assert.equal(view.steps.find(job => job.id === 'harvest').status, 'dependent');
  put(plot.offset(0, 1, 0), 'wheat');
  view = await refreshProject(store, bot, { farm }, (await store.read()).active);
  assert.equal(view.project.status, 'complete');
});

test('failed or paused steps preserve history and can resume without changing the requirements', async t => {
  const { store, reopen, bot } = await fixture(t);
  const project = await registerProject(store, { kind: 'farm', options: { width: 5, depth: 4 }, objective: '建 5×4 农田' });
  const view = await refreshProject(store, bot, {}, project);
  const step = view.ready[0];
  const operations = [
    { status: 'failed', plan: '往南找地', reason: '坡太陡' },
    { status: 'deferred', plan: '暂停观察', reason: '夜间避险' },
    { status: 'failed', plan: '往北找地', reason: '积水太深' },
  ];
  for (const operation of operations) await recordProjectStep(store, project.id, step, operation);
  let saved = (await reopen().read()).active;
  assert.equal(saved.stepHistory.layout.attempts, 2);
  assert.equal((await refreshProject(store, bot, {}, saved)).steps[0].status, 'blocked');
  await changeProject(store, saved, 'pause');
  saved = (await reopen().read()).active;
  assert.equal(saved.status, 'paused');
  assert.equal((await refreshProject(store, bot, {}, saved)).ready.length, 0);
  await changeProject(store, saved, 'resume');
  saved = (await reopen().read()).active;
  assert.equal(saved.options.width, 5);
  assert.equal(saved.stepHistory.layout.results.length, 3);
  assert.deepEqual((await refreshProject(store, bot, {}, saved)).ready.map(job => job.id), ['layout']);
});

test('in-game engineering command persists the original request with the selected template and dimensions', async t => {
  const { store } = await fixture(t);
  const { EventEmitter, once } = await import('node:events');
  const { createChatHandler } = await import('../src/chat/chatHandler.js');
  const bot = Object.assign(new EventEmitter(), {
    username: 'TestBot', players: {}, game: { dimension: 'overworld' },
    whisper(player, reply) { this.emit('reply', player, reply); },
  });
  const tasks = { onFinish() {}, start(info) { this.current = info; } };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { messages, tools } = JSON.parse(options.body);
    assert.ok(tools.some(tool => tool.function.name === 'submit_survival_project'));
    const message = messages.at(-1).role === 'tool' ? { role: 'assistant', content: '工程已登记。' }
      : { role: 'assistant', tool_calls: [{ id: 'build-call', function: { name: 'submit_survival_project',
        arguments: JSON.stringify({ kind: 'house', house: { floors: 2, chests: 4, furnaces: 2 } }) } }] };
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  createChatHandler({ npc: { name: '阿方', autonomy: 'on', autonomyMode: 'ai', memorySize: 10 },
    llm: { apiKey: 'mock', baseUrl: 'http://example.invalid', timeoutMs: 1000 }, projectStorage: () => store,
    actions: { tasks, describeActivity: () => '' } }).attach(bot);
  const reply = once(bot, 'reply');
  const objective = '给我建两层房子，装四个箱子和两个熔炉。';
  bot.emit('whisper', 'Owner', objective);
  assert.deepEqual(await reply, ['Owner', '工程已登记。']);
  const { active } = await store.read();
  assert.equal(active.objective, objective);
  assert.deepEqual(active.options, { mode: 'build', model: 'starter', floors: 2, chests: 4, furnaces: 2 });
  assert.equal(active.owner.player, 'Owner');
  assert.equal(tasks.current.kind, 'autonomy');
});
