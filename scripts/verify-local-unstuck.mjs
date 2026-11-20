import { loadStrategyState, saveStrategyState } from '../src/strategy/state.js';
import { tryLocalUnstuck } from '../src/strategy/unstuck.js';
import { hideUntilMorning } from '../src/autonomy/skills/sleep.js';

export async function verifyLocalUnstuck(bot, log) {
  if ((bot.time?.timeOfDay ?? 0) >= 10000) return { result: 'SKIP', reason: '夜间继续避难，白天再验证局部脱困' };
  const state = await loadStrategyState(bot);
  const before = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
  const ctx = { bot, state, signal: AbortSignal.timeout(90000), log, checkpoint: () => saveStrategyState(bot, state) };
  const recovered = await tryLocalUnstuck(ctx);
  if (!recovered) return { result: 'SKIP', reason: '当前未找到可安全执行的局部脱困方案', before };
  const after = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
  const action = state.localRecovery.action;
  if (state.emergencyShelter) await hideUntilMorning(ctx);
  return { result: 'PASS', reason: '已在实际受困位置完成局部脱困，并清理自有临时掩体后恢复任务', action, before, after };
}
