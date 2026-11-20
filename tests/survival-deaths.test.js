import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { explainDeath, renderDeath, attachDeathLogging } from '../scripts/survival-deaths.mjs';

test('死亡原因采用服务器消息，缺失消息时保留未知', () => {
  assert.match(explainDeath('QA was shot by Skeleton'), /骷髅.*射杀/);
  assert.match(explainDeath('QA was killed by Witch using magic'), /女巫.*魔法/);
  assert.match(explainDeath(null), /无法确认/);
});

test('死亡后收到数据包仍写入同一次报告，重生不会改变死亡位置', async () => {
  const folder = await mkdtemp(`${tmpdir()}/mc-death-report-`);
  const bot = new EventEmitter();
  Object.assign(bot, {
    _client: new EventEmitter(), username: 'QA', isAlive: true, health: 3, food: 15,
    entity: { id: 1, position: { x: 10, y: 64, z: 5 }, onGround: true },
    time: { day: 2, time: 48000 }, inventory: { slots: [], items: () => [] },
  });
  const status = { deaths: 0, observedCalendarTicks: 24000 };
  const events = [];
  const logging = attachDeathLogging({ bot, status, event: async (type, data) => events.push({ type, ...data }),
    describeTask: () => '夜间避难', directory: pathToFileURL(`${folder}/`) });
  try {
    bot.emit('health');
    bot.health = 0;
    bot.emit('death');
    bot._client.emit('death_combat_event', { playerId: 1, message: JSON.stringify({ text: 'QA was slain by Zombie' }) });
    bot.entity.position.x = 99;
    bot.health = 20;
    await logging.flush();
    assert.equal(status.deaths, 1);
    const report = events.find((entry) => entry.type === 'DEATH_REPORT');
    assert.equal(report.snapshot.position.x, 10);
    assert.equal(report.history[0].health, 3);
    assert.match(report.serverMessage, /Zombie/);
    assert.match(await readFile(`${folder}/死亡记录.md`, 'utf8'), /被僵尸击杀/);
    assert.match(renderDeath({ ...report, serverMessage: null }), /无法确认/);
    assert.equal(events.filter((entry) => entry.type === 'DEATH').length, 1);
  } finally {
    bot.emit('end');
    await rm(folder, { recursive: true, force: true });
  }
});
