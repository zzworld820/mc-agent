import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startWebService } from '../src/web/server.js';
import { createTaskManager } from '../src/actions/taskManager.js';
import { createAgentJournal } from '../src/web/journal.js';
import { trackTaskProgress } from '../src/web/observer.js';
import { loadAgentProfiles } from '../src/agent-profiles.js';

test('多代理的模型、网页快照与三维地址分开，目录不返回密钥', async () => {
  const agents = ['builder', 'farmer'].map(id => ({ id, actions: { tasks: createTaskManager() },
    npc: { name: id }, llm: { model: id + '-model', apiKey: 'secret-' + id } }));
  const web = await startWebService({ agents, options: { port: 0 } });
  try {
    const request = async path => {
      const response = await fetch(web.url + path);
      assert.equal(response.status, 200);
      return response.json();
    };
    const roster = await request('/api/agents');
    assert.deepEqual(roster.map(({ id, model }) => [id, model]), [['builder', 'builder-model'], ['farmer', 'farmer-model']]);
    assert.doesNotMatch(JSON.stringify(roster), /secret-/);
    assert.equal((await request('/api/state')).viewer.url, '/viewer/');
    assert.equal((await request('/api/agents/farmer/state')).viewer.url, '/viewers/farmer/');
    assert.deepEqual((await request('/api/agents/farmer/state')).incidents.entries, []);
    assert.ok((await request('/api/item-tiles')).cobblestone);
    assert.equal((await fetch(web.url + '/api/agents/missing/state')).status, 404);
  } finally { await web.close(); }
});

test('每个模型单独解析密钥，自定义接口不复用其他服务凭证', async () => {
  const path = await mkdtemp(join(tmpdir(), 'mc-profiles-'));
  const file = join(path, 'profiles.json');
  const config = { minecraft: { username: 'Original' }, npc: {}, llm: { baseUrl: 'https://example.org', model: 'a', apiKey: 'original' } };
  try {
    await writeFile(file, JSON.stringify([
      { id: 'a', minecraft: { username: 'Alpha' }, llm: { apiKeyEnv: 'ALPHA_KEY' } },
      { id: 'b', minecraft: { username: 'Beta' }, llm: { baseUrl: 'https://example.com', model: 'b' } },
    ]));
    const profiles = await loadAgentProfiles(config, file, { ALPHA_KEY: 'one' });
    assert.equal(profiles[0].llm.apiKey, 'one');
    assert.equal(profiles[1].llm.apiKey, '');
    assert.equal(profiles[1].llm.model, 'b');
  } finally { await rm(path, { recursive: true, force: true }); }
});

test('卡顿记录按代理追加，重新打开后仍有原因、方法及结果', async () => {
  const path = await mkdtemp(join(tmpdir(), 'mc-journal-'));
  const directory = pathToFileURL(path + '/');
  try {
    const first = createAgentJournal('alpha', directory);
    await first.record({ type: 'attempt', goal: '返家', reason: '无路', solution: '改经侧面', result: '到达入口' });
    const reopened = createAgentJournal('alpha', directory), other = createAgentJournal('beta', directory);
    await Promise.all([reopened.flush(), other.flush()]);
    assert.equal(reopened.snapshot().entries[0].result, '到达入口');
    assert.deepEqual(other.snapshot().entries, []);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test('两游戏日阈值只在活跃任务内累计，休息暂停，空闲清零', () => {
  const tracked = { activeTask: 'house', fingerprint: 'same' };
  let state;
  for (let tick = 0; tick < 48000; tick += 20) state = trackTaskProgress(state, { ...tracked, tick });
  assert.equal(state.stalled, false);
  state = trackTaskProgress(state, { activeTask: 'night', tick: 48000, waiting: true });
  state = trackTaskProgress(state, { ...tracked, tick: 62000 });
  assert.equal(state.elapsed, 47980);
  state = trackTaskProgress(state, { ...tracked, tick: 62020 });
  assert.equal(state.newStall, true);
  state = trackTaskProgress(state, { ...tracked, tick: 62040 });
  assert.equal(state.newStall, false);
  assert.equal(trackTaskProgress(state, { activeTask: null, tick: 62100 }), null);
  assert.equal(trackTaskProgress(state, { ...tracked, fingerprint: 'placed a block', tick: 62100 }).elapsed, 0);
});
