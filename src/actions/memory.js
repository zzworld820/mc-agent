import { MEMORY_KINDS } from '../memory/manager.js';

async function session(bot) {
  if (!bot.memory) throw new Error('记忆尚未初始化');
  await bot.memory.ensureAvailable();
  return bot.memory;
}

export const memoryActions = [
  {
    name: 'share_memory',
    description: '玩家明确要求时，把自己当前世界和维度中的一条普通记忆作为快照分享给团队或同世界 Agent，保留原作者、观察时间和来源。不会自动持续同步，也不转移所有权。任务和工程不可通过此工具共享。',
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, scope: { type: 'string', enum: ['team', 'world'] },
    }, required: ['id', 'scope'] },
    async run({ bot }, args) {
      const memory = await session(bot);
      const record = await memory.manager.shareMemory(memory.context(), args);
      return `记忆快照已分享，ID：${record.id}；保留作者与观察时间，不代表实时状态`;
    },
  },
  {
    name: 'publish_knowledge',
    description: '仅在玩家明确要求分享通用经验时，发布带版本的知识摘要，供其他 Agent 跨世界读取。不要发布私人经历、关系、库存或坐标作为通用事实。发布不代表已经验证，也不会训练模型权重。',
    parameters: { type: 'object', properties: {
      key: { type: 'string' }, title: { type: 'string' },
      content: { type: 'string', maxLength: 4000 }, version: { type: 'integer', minimum: 1 },
    }, required: ['key', 'title', 'content'] },
    async run({ bot }, args) {
      if (typeof args.content !== 'string' || !args.content.trim() || args.content.length > 4000) throw new Error('知识内容需为 1～4000 字符');
      const memory = await session(bot);
      const record = await memory.manager.publishKnowledge(args);
      return `通用知识已发布，ID：${record.id}；状态为未验证摘要，可供其他 Agent 继承`;
    },
  },
  {
    name: 'inherit_knowledge',
    description: '根据已查询的通用知识 ID，将知识及作者来源保存到自己的当前世界记忆。只继承知识，不复制作者身份、经历、私人关系或故事进度。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ bot }, { id }) {
      const memory = await session(bot);
      const record = await memory.manager.inheritKnowledge(memory.context(), id);
      return `知识已继承，ID：${record.id}；保留原作者，不能当作自己的亲身经历`;
    },
  },
  {
    name: 'memory_identity',
    description: '读取当前 Agent 稳定身份、称呼、角色设定、世界 ID 和长期记忆开关；设定不代表亲历事件。',
    parameters: { type: 'object', properties: {} },
    run({ bot }) {
      const memory = bot.memory;
      const options = memory?.manager.options;
      return JSON.stringify({ source: 'configuration_or_automatic_profile', requested: memory?.manager.enabled ?? false,
        enabled: memory?.enabled ?? false, suspended: memory?.suspended ?? false, identitySource: memory?.identitySource ?? null,
        persistentWorldIdentity: ['configuration', 'server'].includes(memory?.identitySource), agentId: memory?.agentId ?? null,
        name: options?.name ?? bot.username, role: options?.role ?? '', backstory: options?.backstory ?? '',
        worldId: memory?.worldId ?? null, dimension: bot.game?.dimension ?? null });
    },
  },
  {
    name: 'recall_memories',
    description: '查询当前世界中自己、团队和世界共享的长期记忆，以及跨世界通用知识。返回来源、作者、时间、是否亲历、是否因回档需要复查。结果是旧记录，不是实时感知。',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: MEMORY_KINDS },
      text: { type: 'string', description: '标题中的字面关键词，最多 100 字符' },
      scope: { type: 'string', enum: ['private', 'team', 'world', 'global'] },
      dimension: { type: 'string', description: '可选，当前世界内的维度 ID，默认当前维度' },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
    } },
    async run({ bot }, args) {
      const memory = await session(bot);
      return JSON.stringify(await memory.manager.recall(memory.context(), args));
    },
  },
  {
    name: 'remember_note',
    description: '在玩家要求记住信息时保存备注，默认个人可见，可指定团队或同世界共享。仅记录玩家陈述，不当作现场事实；不可用于发布通用知识、编造经历或更改归属。',
    parameters: { type: 'object', properties: {
      key: { type: 'string', description: '稳定备注标识，用相同 key 更新同一备注' },
      title: { type: 'string' }, content: { type: 'string', maxLength: 4000 },
      scope: { type: 'string', enum: ['private', 'team', 'world'] },
    }, required: ['key', 'title', 'content'] },
    async run({ bot, player }, { key, title, content, scope = 'private' }) {
      if (typeof content !== 'string' || !content.trim() || content.length > 4000) throw new Error('备注内容需为 1～4000 字符');
      if (!['private', 'team', 'world'].includes(scope)) throw new Error('备注共享范围无效');
      const memory = await session(bot);
      const record = await memory.manager.remember(memory.context(), { kind: 'note', key, title, scope,
        data: { content }, source: { type: 'player_report', player } });
      return `备注已保存，ID：${record.id}；来源为玩家陈述，不是现场验证`;
    },
  },
  {
    name: 'set_home_memory',
    description: '仅在玩家明确指定住所时记住家名和坐标。不建房、不移动、不设置重生点，也不改变产权。',
    parameters: { type: 'object', properties: {
      name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
    }, required: ['x', 'y', 'z'] },
    async run({ bot }, { name, x, y, z }) {
      const memory = await session(bot);
      const record = await memory.manager.setHome(memory.context(), { name, position: { x, y, z } });
      return `住所记录已保存，ID：${record.id}；没有设置重生点或确认产权`;
    },
  },
];
