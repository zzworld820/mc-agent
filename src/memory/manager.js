import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryStore } from './store.js';

export const MEMORY_KINDS = ['note', 'home', 'object', 'asset', 'pet', 'container', 'exploration', 'task', 'project', 'facility', 'event', 'knowledge'];
const SCOPES = ['private', 'team', 'world', 'global'];

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`${label} 必须是非空且不超过 200 字符的字符串`);
  return value.trim();
}

function point(value) {
  if (!value || !['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]))) throw new Error('记忆坐标必须是有限数值');
  return { x: value.x, y: value.y, z: value.z };
}

function digest(parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }

export class MemoryManager {
  constructor(options, name) {
    this.enabled = options.enabled;
    this.options = { ...options, name };
    if (!this.enabled) return;
    this.agentId = identifier(options.agentId, 'AGENT_ID');
    this.worldId = identifier(options.worldId, 'WORLD_ID');
    this.teamId = options.teamId ? identifier(options.teamId, 'AGENT_TEAM_ID') : null;
    this.epoch = identifier(options.worldEpoch, 'WORLD_EPOCH');
    try { this.store = new MongoMemoryStore(options); } catch {
      throw new Error('MongoDB 记忆配置无效，请检查连接地址和数据库设置');
    }
  }

  requireEnabled() {
    if (!this.enabled) throw new Error('长期记忆已被配置为关闭，可设置 MEMORY_ENABLED=true');
  }

  async initialize() {
    this.requireEnabled();
    const agents = await this.store.collection('agents');
    const now = new Date();
    await agents.updateOne({ _id: this.agentId }, {
      $set: { name: this.options.name, role: this.options.role, backstory: this.options.backstory, updatedAt: now },
      $setOnInsert: { createdAt: now },
    }, { upsert: true });
    const worlds = await this.store.collection('worlds');
    // 世界元数据由首次登记建立，其他 Agent 不得用空配置覆盖。
    await worlds.updateOne({ _id: this.worldId }, { $setOnInsert: {
      name: this.options.worldName || this.worldId, seed: this.options.worldSeed || null,
      parentWorldId: this.options.parentWorldId || null, identitySource: this.options.identitySource ?? 'configuration', createdAt: now,
    } }, { upsert: true });
  }

  context(dimension) {
    this.requireEnabled();
    return { worldId: this.worldId, dimension: identifier(dimension, '维度 ID'), epoch: this.epoch };
  }

  readableScope() {
    const allowed = [{ scope: 'private', authorAgentId: this.agentId }, { scope: 'world' }, { scope: 'global', kind: 'knowledge' }];
    if (this.teamId) allowed.push({ scope: 'team', teamId: this.teamId });
    return { $or: allowed };
  }

  async remember(context, { kind, key, title, data, scope = 'private', source = { type: 'reported' }, observedAt = new Date() }) {
    this.requireEnabled();
    if (!MEMORY_KINDS.includes(kind) || !SCOPES.includes(scope)) throw new Error('不支持的记忆类型或共享范围');
    if (scope === 'team' && !this.teamId) throw new Error('当前 Agent 未配置团队');
    if (scope === 'global' && kind !== 'knowledge') throw new Error('只有通用知识可以跨世界发布');
    if (scope !== 'global' && !context) throw new Error('世界内记忆必须绑定世界与维度');
    if (context && (context.worldId !== this.worldId || context.epoch !== this.epoch)) throw new Error('记忆世界上下文不匹配');
    key = identifier(key, '记忆 key');
    title = identifier(title, '记忆标题');
    if (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > 1000000) throw new Error('记忆详情必须是小于 1MB 的对象');
    const time = new Date(observedAt);
    if (!Number.isFinite(time.getTime())) throw new Error('记忆时间无效');
    const global = scope === 'global';
    const partition = global ? { worldId: null, dimension: null, epoch: null } : this.context(context.dimension);
    const _id = digest([this.agentId, partition.worldId, partition.dimension, partition.epoch, scope,
      scope === 'team' ? this.teamId : null, kind, key]);
    const record = {
      schemaVersion: 1, ...partition, kind, key, title, scope,
      authorAgentId: this.agentId, teamId: scope === 'team' ? this.teamId : null,
      data: structuredClone(data), source: structuredClone(source), observedAt: time, updatedAt: new Date(),
    };
    const collection = await this.store.collection('memories');
    // 每个作者独立保留观察。不同 Agent 的矛盾证据不会相互覆盖。
    if (global) {
      try {
        await collection.updateOne({ _id }, { $setOnInsert: { ...record, createdAt: new Date() } }, { upsert: true });
      } catch (err) {
        if (err.code !== 11000) throw new Error('知识发布失败，尚未确认保存');
      }
      const existing = await collection.findOne({ _id });
      if (existing.title !== title || JSON.stringify(existing.data) !== JSON.stringify(data)) {
        throw new Error('该知识版本已发布且不可覆盖，请增加 version');
      }
      const { _id: id, ...saved } = existing;
      return { id, ...saved };
    }
    try {
      await collection.updateOne({ _id }, { $set: record, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    } catch (err) {
      if (err.code !== 11000) throw new Error('长期记忆写入失败，尚未确认保存');
      await collection.updateOne({ _id }, { $set: record });
    }
    return { id: _id, ...record };
  }

  async recall(context, { kind, key, text, scope, limit = 10, dimension = context.dimension } = {}) {
    this.requireEnabled();
    if (context.worldId !== this.worldId || context.epoch !== this.epoch) throw new Error('记忆查询上下文不匹配');
    if (kind && !MEMORY_KINDS.includes(kind)) throw new Error('不支持的记忆类型');
    if (scope && !SCOPES.includes(scope)) throw new Error('不支持的共享范围');
    const filter = { $and: [this.readableScope(), {
      $or: [{ worldId: this.worldId, dimension: identifier(dimension, '维度 ID') }, { worldId: null, kind: 'knowledge', scope: 'global' }],
    }] };
    if (kind) filter.kind = kind;
    if (key) filter.key = identifier(key, '记忆 key');
    if (scope) filter.scope = scope;
    if (text) {
      if (typeof text !== 'string' || text.length > 100) throw new Error('查询文字最多 100 字符');
      // 输入按字面匹配，不接受模型传入的数据库表达式。
      filter.title = { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }
    const count = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(30, Math.floor(Number(limit)))) : 10;
    const records = await (await this.store.collection('memories')).find(filter).sort({ updatedAt: -1 }).limit(count).toArray();
    return records.map(({ _id, ...record }) => ({
      id: _id, ...record, needsRevalidation: record.worldId !== null && record.epoch !== this.epoch,
      personalExperience: record.authorAgentId === this.agentId
        && ['observation', 'placement_verified', 'container_open_observation', 'execution', 'project_record'].includes(record.source.type),
    }));
  }

  async setHome(context, { name, position, facilityId = null }) {
    return this.remember(context, { kind: 'home', key: 'primary', title: name || '主要住所',
      data: { position: point(position), facilityId, agentId: this.agentId, respawnConfirmed: false },
      source: { type: 'player_designation' } });
  }

  async shareMemory(context, { id, scope }) {
    this.requireEnabled();
    if (!['team', 'world'].includes(scope)) throw new Error('只能分享至当前团队或世界');
    const record = await (await this.store.collection('memories')).findOne({
      _id: identifier(id, '记忆 ID'), authorAgentId: this.agentId,
      worldId: this.worldId, dimension: context.dimension, epoch: this.epoch,
      kind: { $nin: ['project', 'task', 'knowledge'] },
    });
    if (!record) throw new Error('只能分享自己在当前世界、维度和 epoch 中的普通记忆，工程、任务和通用知识走专用接口');
    return this.remember(context, { kind: record.kind, key: record.key, title: record.title, data: record.data,
      scope, observedAt: record.observedAt, source: { ...record.source, sharedFrom: record._id, sharedAsSnapshot: true } });
  }

  async loadProjects(context) {
    this.requireEnabled();
    return (await (await this.store.collection('memories')).find({
      worldId: this.worldId, dimension: context.dimension, epoch: this.epoch,
      authorAgentId: this.agentId, scope: 'private', kind: 'project',
    }).toArray()).map((entry) => entry.data);
  }

  async loadBuildingExperiences(context, modelId) {
    this.requireEnabled();
    const filter = { worldId: this.worldId, dimension: context.dimension, epoch: this.epoch,
      authorAgentId: this.agentId, scope: 'private', kind: 'event', 'data.operation': { $exists: true } };
    if (modelId) filter['data.modelId'] = identifier(modelId, '模型 ID');
    return (await (await this.store.collection('memories')).find(filter).sort({ observedAt: 1 }).toArray())
      .map((entry) => ({ ...entry.data, at: entry.observedAt, world: JSON.stringify([entry.worldId, entry.dimension]) }));
  }

  async rememberAsset(context, { position, block, projectId = null }) {
    const location = point(position);
    return this.remember(context, { kind: 'asset', key: `${location.x},${location.y},${location.z}:${block}`,
      title: `放置的 ${block}`, data: { position: location, block, projectId,
        placedBy: this.agentId, owner: null, manager: this.agentId, status: 'last_observed_present' }, source: { type: 'placement_verified' } });
  }

  async rememberPet(context, { entityUuid, name, species, position, owner = null }) {
    return this.remember(context, { kind: 'pet', key: identifier(entityUuid, '宠物持久 UUID'), title: name || species,
      data: { entityUuid, name: name || null, species, position: point(position), owner, status: 'last_seen' }, source: { type: 'observation' } });
  }

  async rememberFacility(context, { id, name, type, position, bounds = null, status = 'planned', projectId = null, components = [] }) {
    if (!['planned', 'building', 'built_unverified', 'operational', 'fault', 'unknown'].includes(status)) throw new Error('设施状态不支持');
    return this.remember(context, { kind: 'facility', key: identifier(id, '设施 ID'), title: name,
      data: { type, position: point(position), bounds, status, projectId, components,
        builtBy: this.agentId, owner: null, manager: this.agentId }, source: { type: 'project_record' } });
  }

  async recordContainerSnapshot(context, { containerId, position, items, operation = 'open' }) {
    if (!Array.isArray(items) || items.length > 256) throw new Error('容器快照必须是有限的槽位列表');
    const slots = items.map((item) => {
      if (!Number.isInteger(item.slot) || item.slot < 0 || typeof item.name !== 'string' || !Number.isInteger(item.count) || item.count < 0) throw new Error('容器槽位无效');
      return { slot: item.slot, name: item.name, count: item.count, metadata: item.metadata ?? null };
    }).sort((a, b) => a.slot - b.slot);
    if (new Set(slots.map((item) => item.slot)).size !== slots.length) throw new Error('容器快照槽位重复');
    const previous = (await this.recall(context, { kind: 'container', key: containerId, scope: 'private', limit: 1 }))
      .find((entry) => !entry.needsRevalidation);
    const changed = previous ? JSON.stringify(previous.data.slots) !== JSON.stringify(slots) : null;
    return this.remember(context, { kind: 'container', key: containerId, title: `容器 ${containerId}`,
      data: { position: point(position), slots, previousObservedAt: previous?.observedAt ?? null,
        changeStatus: changed === null ? 'baseline' : changed ? operation === 'agent_transfer' ? 'change_during_agent_operation' : 'unexplained_change' : 'unchanged',
        changedBy: null }, source: { type: 'container_open_observation' } });
  }

  async recordExploration(context, { position, level = 'visited' }) {
    if (!['loaded', 'visited', 'surface_observed', 'interior_checked'].includes(level)) throw new Error('探索层级不支持');
    const location = point(position);
    const cell = { x: Math.floor(location.x / 16), y: Math.floor(location.y / 16), z: Math.floor(location.z / 16) };
    return this.remember(context, { kind: 'exploration', key: `${cell.x},${cell.y},${cell.z}:${level}`, title: `探索单元 ${cell.x},${cell.y},${cell.z}`,
      data: { cell, level, samplePosition: location, coverage: 'point_sample_not_entire_cell' }, source: { type: 'observation' } });
  }

  async rememberTask(context, { id, title, goal, status, progress = null }) {
    if (!['planned', 'running', 'cancelled', 'failed', 'completed'].includes(status)) throw new Error('任务状态不支持');
    return this.remember(context, { kind: 'task', key: identifier(id, '任务 ID'), title,
      data: { goal, status, progress }, source: { type: 'execution' } });
  }

  async publishKnowledge({ key, title, content, version = 1, sourceIds = [] }) {
    if (!Number.isInteger(version) || version < 1) throw new Error('知识版本必须是正整数');
    return this.remember(null, { kind: 'knowledge', key: `${key}:v${version}`, title, scope: 'global',
      data: { content, version, sourceIds, status: 'published_unvalidated' }, source: { type: 'published_summary', publisher: this.agentId } });
  }

  async inheritKnowledge(context, knowledgeId) {
    this.requireEnabled();
    const filter = { _id: identifier(knowledgeId, '知识 ID'), kind: 'knowledge', scope: 'global', worldId: null };
    const knowledge = await (await this.store.collection('memories')).findOne(filter);
    if (!knowledge) throw new Error('找不到可继承的通用知识');
    return this.remember(context, { kind: 'knowledge', key: `inherited:${knowledge._id}`, title: knowledge.title,
      data: knowledge.data, source: { type: 'inherited', authorAgentId: knowledge.authorAgentId, sourceId: knowledge._id } });
  }

  async recordEvent(context, title, data) {
    return this.remember(context, { kind: 'event', key: randomUUID(), title: title.slice(0, 200), data: { ...data, detail: title }, source: { type: 'execution' } });
  }

  async close() { await this.store?.close(); }
}
