import test from 'node:test';
import assert from 'node:assert/strict';
import { depositVerified, withdrawVerified } from '../src/farming/storage.js';

function transferWindow() {
  const item = (count) => ({ name: 'cobblestone', type: 1, metadata: 0, count });
  const window = {
    inventoryStart: 2, inventoryEnd: 4, slots: [item(10), null, item(16), null],
    containerItems() { return this.slots.slice(0, 2).filter(Boolean); },
    async deposit(type, metadata, count) { this.slots[0].count += count; this.slots[2].count -= count; },
    async withdraw(type, metadata, count) { this.slots[0].count -= count; this.slots[2].count += count; },
  };
  const ctx = { bot: { inventory: { items: () => [item(16)] } }, signal: new AbortController().signal };
  return { ctx, window };
}

test('箱子打开时独立背包缓存未同步，转存仍能正确核验', async () => {
  const { ctx, window } = transferWindow();
  assert.equal(await depositVerified(ctx, window, window.slots[2], 5), 5);
  assert.equal(window.slots[2].count, 11);
  assert.equal(ctx.bot.inventory.items()[0].count, 16);
});

test('出库读取同一窗口的背包区域', async () => {
  const { ctx, window } = transferWindow();
  await withdrawVerified(ctx, window, window.slots[0], 3);
  assert.equal(window.slots[2].count, 19);
});

test('箱子部分满时只接受双方数量一致的实际转存', async () => {
  const { ctx, window } = transferWindow();
  window.deposit = async () => { window.slots[0].count += 2; window.slots[2].count -= 2; throw new Error('destination full'); };
  assert.equal(await depositVerified(ctx, window, window.slots[2], 5), 2);
});

test('真实不一致立即报告数量差异', async () => {
  const { ctx, window } = transferWindow();
  window.deposit = async () => { window.slots[2].count -= 5; };
  await assert.rejects(depositVerified(ctx, window, window.slots[2], 5), /窗口背包减少5，箱内增加0/);
});
