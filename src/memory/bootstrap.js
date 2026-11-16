// 本地身份配置自动建立；世界身份只使用显式配置或服务器提供的标识。
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const PROFILES = new URL('../../data/memory/profiles/', import.meta.url);
const CHANNEL = 'mc_agent:world_identity';

export async function prepareMemoryOptions(options, profile) {
  if (!options.enabled || options.agentId) return { ...options };
  const profileKey = options.profile || profile;
  const file = new URL(`${createHash('sha256').update(profileKey).digest('hex')}.json`, PROFILES);
  await mkdir(PROFILES, { recursive: true });
  const temporary = new URL(`profile-${randomUUID()}.tmp`, PROFILES);
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, profile: profileKey, agentId: randomUUID() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // 完整写入后再原子发布，不让并发启动读到半个身份文件。
    try { await link(temporary, file); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  } finally {
    await unlink(temporary).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (saved.schemaVersion !== 1 || typeof saved.agentId !== 'string' || !saved.agentId.trim()) {
    throw new Error('自动身份档案损坏，保留原文件；请修复 data/memory/profiles 中的档案');
  }
  return { ...options, agentId: saved.agentId };
}

export function watchWorldIdentity(bot) {
  bot._client.on('custom_payload', (packet) => {
    if (packet.channel !== CHANNEL || !Buffer.isBuffer(packet.data) || packet.data.length > 4096) return;
    let identity;
    try { identity = JSON.parse(packet.data.toString('utf8')); } catch { return; }
    if (typeof identity.worldId !== 'string' || !identity.worldId.trim() || identity.worldId.length > 200) return;
    if (identity.epoch !== undefined && (typeof identity.epoch !== 'string' || !identity.epoch.trim() || identity.epoch.length > 200)) return;
    bot.memoryServerIdentity = { worldId: identity.worldId.trim(), epoch: identity.epoch || 'initial' };
    if (bot.memory && bot.memory.identitySource === 'server'
      && (bot.memory.worldId !== identity.worldId.trim() || bot.memory.manager.epoch !== (identity.epoch || 'initial'))) {
      bot.memory.suspended = true;
    }
    bot.emit('memoryWorldIdentity');
  });
}

export async function resolveWorldOptions(options, bot) {
  if (!options.enabled) return { ...options, identitySource: 'disabled' };
  if (options.worldId) return { ...options, identitySource: 'configuration' };
  // 服务端可在进入世界时提供持久 ID。等待有界，不拖住正常游戏连接。
  if (!bot.memoryServerIdentity) {
    await new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); bot.removeListener('memoryWorldIdentity', finish); resolve(); };
      const timer = setTimeout(finish, 1000);
      bot.once('memoryWorldIdentity', finish);
    });
  }
  if (bot.memoryServerIdentity) return {
    ...options, worldId: bot.memoryServerIdentity.worldId, worldEpoch: bot.memoryServerIdentity.epoch,
    identitySource: 'server',
  };
  return { ...options, worldId: `session-${randomUUID()}`, identitySource: 'session', worldName: options.worldName || '未确认身份的世界（临时分区）' };
}
