// 运行时桥接：感知和放置只提交事实；不会因此采集、存箱、移动或改变规划策略。
const ASSET_NAMES = new Set(['chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker', 'crafting_table']);

export function attachMemory(bot, manager, log) {
  let pending = Promise.resolve();
  let queued = 0;
  let retryAfter = 0;
  const session = {
    enabled: manager.enabled,
    manager,
    agentId: manager.agentId ?? null,
    worldId: manager.worldId ?? null,
    suspended: false,
    async ensureAvailable() {
      if (session.suspended) throw new Error('服务器世界身份发生变化，记忆已暂停；重新连接后会重新识别');
      if (!manager.enabled) throw new Error('记忆已被 MEMORY_ENABLED=false 显式关闭');
      if (!session.enabled) {
        await manager.initialize();
        session.enabled = true;
        retryAfter = 0;
      }
    },
    context() {
      if (session.suspended) throw new Error('世界身份已改变，记忆上下文已暂停');
      return manager.context(String(bot.game?.dimension ?? 'unknown').replace('minecraft:', ''));
    },
    enqueue(work) {
      if (!session.enabled || session.suspended || Date.now() < retryAfter) return false;
      if (queued >= 64) return false;
      queued++;
      pending = pending.then(async () => {
        if (Date.now() < retryAfter) return;
        try { await work(); } catch {
          retryAfter = Date.now() + 30000;
          log.warn('自动记忆保存失败，暂缓自动写入；本次记录未保证持久化，可检查 MongoDB 后重试');
        }
      }).finally(() => { queued--; });
      return true;
    },
    async flush() { await pending; },
  };
  bot.memory = session;
  if (!manager.enabled) return session;

  let lastVisitTime = 0;
  let lastCell = '';
  bot.on('physicsTick', () => {
    const now = Date.now();
    if (!session.enabled || session.suspended || !bot.entity || now - lastVisitTime < 5000) return;
    const context = session.context();
    const { x, y, z } = bot.entity.position;
    const cell = `${context.dimension}:${Math.floor(x / 16)},${Math.floor(y / 16)},${Math.floor(z / 16)}`;
    if (cell === lastCell && now - lastVisitTime < 60000) return;
    if (session.enqueue(() => manager.recordExploration(context, { position: { x, y, z }, level: 'visited' }))) {
      lastCell = cell;
      lastVisitTime = now;
    }
  });

  const placeBlock = bot.placeBlock.bind(bot);
  bot.placeBlock = async (reference, face, ...args) => {
    const context = session.enabled && !session.suspended ? session.context() : null;
    const target = reference.position.plus(face);
    const result = await placeBlock(reference, face, ...args);
    const block = bot.blockAt(target);
    if (context && block && (ASSET_NAMES.has(block.name) || block.name.endsWith('_bed') || block.name.endsWith('_door'))) {
      const asset = { position: { x: target.x, y: target.y, z: target.z }, block: block.name };
      session.enqueue(() => manager.rememberAsset(context, asset));
    }
    return result;
  };
  return session;
}

export async function rememberScene(bot, scene) {
  const memory = bot.memory;
  if (!memory?.enabled || memory.suspended) return { status: memory?.manager.enabled ? 'unavailable' : 'disabled' };
  const context = memory.manager.context(scene.dimension.id);
  const accepted = memory.enqueue(async () => {
    for (const object of scene.objects) {
      const { x, y, z } = object.position;
      await memory.manager.remember(context, {
        kind: 'object', key: `${object.type}:${x},${y},${z}`, title: object.name,
        data: object, observedAt: scene.endedAt,
        source: { type: 'observation', method: 'heuristic_loaded_chunk_scan', classification: object.classification },
      });
    }
    // 区块扫描不等于走到过，也不等于看完整个单元。
    await memory.manager.recordExploration(context, { position: scene.origin, level: 'loaded' });
  });
  return { status: accepted ? 'queued_not_confirmed' : 'not_queued', note: '自动记录异步写入，排队不等于持久化完成' };
}
