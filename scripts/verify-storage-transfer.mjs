import { loadStrategyState, saveStrategyState } from '../src/strategy/state.js';
import { depositVerified, withdrawVerified, visitSupplyChest } from '../src/farming/storage.js';

export async function verifyStorageTransfer(bot, log) {
  const state = await loadStrategyState(bot);
  const chest = state.storage?.chests[0];
  if (!chest || !state.home || bot.entity.position.distanceTo(state.home) > 6) return { result: 'SKIP', reason: '尚未处于自有仓储附近' };
  const ctx = { bot, state, signal: AbortSignal.timeout(30000), log,
    checkpoint: () => saveStrategyState(bot, state) };
  let expected;
  let checked = false;
  const counts = (window) => ({
    stored: window.containerItems().filter((item) => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0),
    carried: window.slots.slice(window.inventoryStart, window.inventoryEnd).filter((item) => item?.name === 'cobblestone')
      .reduce((sum, item) => sum + item.count, 0),
  });
  await visitSupplyChest(ctx, chest, state.storage.mode, async (window) => {
    const item = window.containerItems().find((entry) => entry.name === 'cobblestone');
    if (!item) return;
    expected = counts(window);
    await withdrawVerified(ctx, window, item, 1);
    const carried = window.slots.slice(window.inventoryStart, window.inventoryEnd).find((entry) => entry?.name === 'cobblestone');
    await depositVerified(ctx, window, carried, 1);
    if (JSON.stringify(counts(window)) !== JSON.stringify(expected)) throw new Error('同窗口往返后数量不一致');
    checked = true;
  });
  if (!checked) return { result: 'SKIP', reason: '箱内没有可用于核验的圆石' };
  await visitSupplyChest(ctx, chest, state.storage.mode, async (window) => {
    if (JSON.stringify(counts(window)) !== JSON.stringify(expected)) throw new Error('重新开箱后圆石数量不一致');
  });
  return { result: 'PASS', reason: '取出1个圆石并存回，同窗口及重新开箱后的双方数量均一致', counts: expected };
}
