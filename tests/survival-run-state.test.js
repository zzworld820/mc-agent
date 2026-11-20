import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { updateRunStatus, reconcileRunDeaths } from '../scripts/survival-run-state.mjs';
import { attachDeathLogging } from '../scripts/survival-deaths.mjs';

test('多次心跳后死亡计数及报告天数仍更新到同一运行状态', async () => {
  const folder = await mkdtemp(`${tmpdir()}/mc-run-state-`);
  const bot = new EventEmitter();
  Object.assign(bot, { _client: new EventEmitter(), username: 'QA', isAlive: true, health: 20, food: 20,
    entity: { id: 1, position: { x: 1, y: 70, z: 1 } }, time: { day: 2, time: 48000 },
    inventory: { slots: [], items: () => [] } });
  const status = { username: 'QA', deaths: 0, observedCalendarTicks: 24000 };
  const events = [];
  const logger = attachDeathLogging({ bot, status, event: async (type, data) => events.push({ type, ...data }),
    describeTask: () => '测试', directory: pathToFileURL(`${folder}/`) });
  try {
    assert.equal(updateRunStatus(status, { observedCalendarTicks: 48000, health: 20 }), status);
    updateRunStatus(status, { position: { x: 2, y: 70, z: 1 } });
    bot.health = 0; bot.emit('death');
    await logger.flush();
    assert.equal(status.deaths, 1);
    assert.equal(events.find(e => e.type === 'DEATH_REPORT').elapsedDays, 2);
    updateRunStatus(status, { health: 20 });
    assert.equal(status.deaths, 1);
  } finally { bot.emit('end'); await rm(folder, { recursive: true, force: true }); }
});

test('从唯一死亡事件修复旧的漏计，重复报告和截断尾行不重复计数', async () => {
  const folder = await mkdtemp(`${tmpdir()}/mc-run-recover-`);
  const file = `${folder}/events.jsonl`;
  try {
    const death = id => JSON.stringify({ type: 'DEATH', id, time: '2026-11-18T15:00:32Z', serverMessage: 'QA was slain by Spider' });
    await writeFile(file, [death('one'), death('one'), JSON.stringify({ type: 'DEATH_REPORT', id: 'one' }), death('two'), '{'].join('\n'));
    const status = { deaths: 0 };
    await reconcileRunDeaths(status, file);
    assert.equal(status.deaths, 2);
    assert.match(status.lastDeathSummary.reason, /蜘蛛/);
    status.deaths = 3;
    await reconcileRunDeaths(status, file);
    assert.equal(status.deaths, 3);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
