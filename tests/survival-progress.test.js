import test from 'node:test';
import assert from 'node:assert/strict';
import { testProgress, chestLines, progressLines } from '../scripts/survival-progress.mjs';

test('状态页显示营地验收、下一步和距离百日目标的天数', () => {
  const status = { home: {}, homeVerified: true, observedCalendarTicks: 5.25 * 24000, targetDays: 100, worldTime: 15000 };
  const progress = testProgress(status);
  assert.equal(progress.completed, 1);
  assert.equal(progress.remaining, 8);
  assert.equal(progress.stage, '营地检查与可靠物资转存');
  assert.match(progress.next, /天亮.*箱子转存/);
  assert.equal(progress.daysRemaining, 94.75);
  assert.match(progressLines(status).join('\n'), /1\/9项/);
});

test('箱子按物品汇总数量，并显示核验时间、失效快照与转存错误', () => {
  const observedAt = Date.now() - 300000;
  const chest = { id: 'one', position: { x: 1, y: 70, z: 2 }, dimension: 'overworld', observedAt,
    items: [{ name: 'coal', count: 2 }, { name: 'coal', count: 3 }, { name: 'oak_log', count: 4 }] };
  const body = chestLines({ chestContents: [chest, { ...chest }] }).join('\n');
  assert.match(body, /coal\|5/);
  assert.match(body, /历史快照/);
  assert.match(body, /最近开箱读取/);
  assert.equal(body.match(/### 当前基地箱子/g).length, 1);
  assert.match(chestLines({ chestContents: [{ ...chest, verificationError: '数量核对失败' }] }).join('\n'), /实际库存待复查/);
});

test('尚未读取内容不会被报告为空箱，已读取空箱显示为空', () => {
  assert.match(chestLines({ chestContents: [{ id: 'unknown' }] }).join('\n'), /箱内物品未知/);
  assert.match(chestLines({ chestContents: [{ id: 'empty', observedAt: Date.now(), items: [] }] }).join('\n'), /箱子为空/);
});

test('施工状态页展示实地匹配数和待完善材料', () => {
  const body = progressLines({ houseConstruction: { model: '石木生存小屋', origin: { x: 0, y: 71, z: 29 },
    matched: 119, total: 169, unknown: 0, observedAt: Date.now(), finishingPending: true } }).join('\n');
  assert.match(body, /119\/169格/);
  assert.match(body, /尚未匹配 50格/);
  assert.match(body, /食物生产和储备稳定后/);
});

test('搬进新房后保留已完成的营地检查记录', () => {
  const progress = testProgress({ house: { projectId: 'new' }, homeVerified: true,
    chestContents: [{ archived: true, observedAt: Date.now(), items: [] }] });
  assert.equal(progress.checkpoints[1].done, true);
  assert.equal(progress.stage, '正式房屋与基地设施');
});
