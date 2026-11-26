import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { projectStore } from '../src/projects/store.js';
import { recordProjectStep } from '../src/projects/engine.js';
import { createProjectDashboard } from '../src/web/projects.js';

test('web engineering dashboard uses the same durable project and displays live step and failures', async t => {
  const path = await mkdtemp(tmpdir() + '/mc-web-projects-');
  t.after(() => rm(path, { recursive: true, force: true }));
  const root = pathToFileURL(path + '/');
  const storeFor = bot => projectStore({ agent: bot.username, dimension: bot.game.dimension }, root);
  const bot = Object.assign(new EventEmitter(), { username: 'Builder', game: { dimension: 'overworld' },
    survivalPlanner: { hasRequest: () => false } });
  const actions = { tasks: { current: null } };
  let resumes = 0;
  const interrupts = [];
  const view = createProjectDashboard({ npc: { autonomyMode: 'ai' }, llm: { apiKey: 'mock' }, actions,
    controller: { setPrimary: async operation => { assert.equal(operation, 'resume'); resumes++; } }, storage: storeFor });
  assert.equal((await view.snapshot()).enabled, false);
  await assert.rejects(view.create({ kind: 'farm' }), /未连接/);
  view.attach(bot);
  const { project } = await view.create({ kind: 'farm', objective: '种一块菜田并收割',
    options: { width: 5, depth: 4, crop: 'carrots', harvest: true } });
  assert.equal(resumes, 1);
  assert.equal(project.steps.length, 3);
  assert.equal((await storeFor(bot).read()).active.id, project.id);
  const runtime = { id: project.id, status: 'executing', stepId: 'layout', plan: '先找水源' };
  bot.strategySupervisor = { active: true, goal: 'farm', projectRuntime: runtime, interruptProject: (...args) => interrupts.push(args) };
  actions.tasks.current = { kind: 'autonomy', progress: '正在找地块' };
  let snapshot = await view.snapshot();
  assert.deepEqual(snapshot.runtime, runtime);
  assert.equal(snapshot.task.progress, '正在找地块');
  assert.equal(snapshot.active.owner, undefined);
  const store = storeFor(bot);
  for (const plan of ['沿河检查', '改到仓库旁']) {
    await recordProjectStep(store, project.id, { id: 'layout' }, { plan, status: 'failed', reason: '地基不够平' });
  }
  snapshot = await view.snapshot();
  assert.equal(snapshot.active.steps[0].status, 'blocked');
  assert.equal(snapshot.active.activity.length, 2);
  assert.equal(snapshot.active.activity[0].reason, '地基不够平');
  await assert.rejects(view.operate({ id: 'older-project', operation: 'pause' }), /变化/);
  await view.operate({ id: project.id, operation: 'pause' });
  assert.equal((await view.snapshot()).active.status, 'paused');
  assert.equal(interrupts[0][0], project.id);
  await view.operate({ id: project.id, operation: 'resume' });
  assert.equal(resumes, 2);
  assert.equal((await view.snapshot()).active.steps[0].attempts, 0);
  bot.game.dimension = 'the_nether';
  assert.equal((await view.snapshot()).active, null);
  assert.equal((await view.snapshot()).enabled, false);
  bot.game.dimension = 'overworld';
  await view.operate({ id: project.id, operation: 'cancel' });
  snapshot = await view.snapshot();
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.history[0].status, 'cancelled');
});
