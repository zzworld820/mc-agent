import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const DIRECTORY = new URL('../../data/strategy/', import.meta.url);
const writes = new Map();

function location(bot) {
  return { agent: bot.memory?.agentId || bot.username, world: bot.memory?.worldId || bot.buildingServer,
    dimension: String(bot.game.dimension), epoch: bot.memory?.manager.epoch || 'initial' };
}

function stateFile(bot) {
  return new URL(`${createHash('sha256').update(JSON.stringify(location(bot))).digest('hex')}.json`, DIRECTORY);
}

export async function loadStrategyState(bot) {
  let saved;
  let local;
  try { local = JSON.parse(await readFile(stateFile(bot), 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (bot.memory?.enabled && !bot.memory.suspended) {
    try {
      const records = await bot.memory.manager.recall(bot.memory.context(), { kind: 'task', key: 'survival-plan', scope: 'private', limit: 1 });
      saved = records.find((entry) => !entry.needsRevalidation)?.data;
    } catch { bot.strategyMemoryWarning = 'MongoDB 不可用，使用同一分区的本地运行检查点'; }
  }
  if (!saved || (local?.updatedAt ?? 0) > (saved.updatedAt ?? 0)) saved = local;
  if (saved && saved.schemaVersion !== 1) throw new Error('自主生存记录版本不支持，保留原记录');
  return { schemaVersion: 1, home: null, farm: null, storage: null, farmConfig: {}, pastures: [], failures: {}, lastGoal: null, ...saved,
    partition: location(bot),
    unreachable: new Map(), reservedItems: new Set(['wheat_seeds', 'beetroot_seeds', 'pumpkin_seeds', 'melon_seeds', 'potato', 'carrot', 'wheat']) };
}

export async function saveStrategyState(bot, state) {
  if (JSON.stringify(state.partition) !== JSON.stringify(location(bot))) throw new Error('世界或维度已改变，不将旧策略状态写入新分区');
  state.updatedAt = Date.now();
  const { unreachable, reservedItems, ...saved } = state;
  const snapshot = structuredClone(saved);
  const memory = bot.memory;
  const context = memory?.enabled && !memory.suspended ? memory.context() : null;
  const file = stateFile(bot);
  const previous = writes.get(file.href) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await mkdir(DIRECTORY, { recursive: true });
    const temporary = new URL(`${file.pathname.split('/').at(-1)}.tmp`, DIRECTORY);
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(temporary, file);
  });
  writes.set(file.href, operation);
  try { await operation; } finally { if (writes.get(file.href) === operation) writes.delete(file.href); }
  if (context) {
    const accepted = memory.enqueue(() => memory.manager.remember(context, {
      kind: 'task', key: 'survival-plan', title: '自主生存长期计划', data: snapshot, source: { type: 'execution' },
    }));
    if (!accepted) bot.strategyMemoryWarning = '策略检查点已保存在本地，但尚未确认同步到 MongoDB';
  }
}
