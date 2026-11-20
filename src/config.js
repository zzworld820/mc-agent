// 配置中心：所有可调参数都从环境变量（.env 文件）读取，代码里不写死。
// 新增配置时：1) 在这里加一行  2) 在 .env.example 里补上说明
import 'dotenv/config';
import { validateFarmSettings } from './farming/settings.js';
import { validateSupplySettings } from './supplies/profiles.js';

function readString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBoolean(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(value);
}

export const config = {
  web: {
    enabled: readBoolean('WEB_ENABLED', true),
    host: readString('WEB_HOST', '127.0.0.1'),
    port: readNumber('WEB_PORT', 3000),
    viewDistance: Math.min(6, readNumber('WEB_VIEW_DISTANCE', 3)),
    temporaryPriority: readNumber('WEB_TEMPORARY_PRIORITY', 80),
    primaryPriority: readNumber('WEB_PRIMARY_PRIORITY', 50),
  },
  supplies: validateSupplySettings({
    eatBelow: readNumber('SUPPLY_EAT_BELOW', 18), interruptBelow: readNumber('SUPPLY_INTERRUPT_BELOW', 12),
    emergencyBelow: readNumber('SUPPLY_EMERGENCY_BELOW', 6), hurtBelow: readNumber('SUPPLY_HURT_BELOW', 14),
    localFood: readNumber('SUPPLY_LOCAL_FOOD', 16), localMinimum: readNumber('SUPPLY_LOCAL_MINIMUM', 8),
    travelFood: readNumber('SUPPLY_TRAVEL_FOOD', 40), miningFood: readNumber('SUPPLY_MINING_FOOD', 40),
    expeditionFood: readNumber('SUPPLY_EXPEDITION_FOOD', 48), miningTorches: readNumber('SUPPLY_MINING_TORCHES', 24),
    minimumTorches: readNumber('SUPPLY_MINIMUM_TORCHES', 8),
    snapshotMaxAgeMs: readNumber('SUPPLY_SNAPSHOT_MAX_AGE_MS', 120000),
    failedSourceCooldownMs: readNumber('SUPPLY_SOURCE_COOLDOWN_MS', 60000),
    allowRottenFlesh: readBoolean('SUPPLY_ALLOW_ROTTEN_FLESH', true),
  }),
  farm: validateFarmSettings({
    width: readNumber('FARM_WIDTH', 3), depth: readNumber('FARM_DEPTH', 2),
    maxWidth: readNumber('FARM_MAX_WIDTH', 15), maxDepth: readNumber('FARM_MAX_DEPTH', 15),
    expansionStep: readNumber('FARM_EXPANSION_STEP', 2), autoExpand: readBoolean('FARM_AUTO_EXPAND', true),
    expansionDays: readNumber('FARM_EXPANSION_DAYS', 2), harvestRatio: readNumber('FARM_HARVEST_RATIO', 0.9),
    inspectionTicks: readNumber('FARM_INSPECTION_TICKS', 1200), storageMode: readString('FARM_STORAGE_MODE', 'shed'),
    storageChests: readNumber('FARM_STORAGE_CHESTS', 2), maxStorageChests: readNumber('FARM_MAX_STORAGE_CHESTS', 12),
    storageDirection: readString('FARM_STORAGE_DIRECTION', 'up'),
  }),
  // —— Minecraft 连接 ——
  minecraft: {
    host: readString('MC_HOST', 'localhost'),
    port: readNumber('MC_PORT', 25565),
    username: readString('MC_USERNAME', 'AgentBot'),
    // offline：离线/盗版服、局域网离线账号；microsoft：正版服（首次会让你在浏览器登录）
    auth: readString('MC_AUTH', 'offline'),
    // 留空 = 自动探测服务器版本
    version: readString('MC_VERSION', undefined),
    reconnectDelayMs: readNumber('MC_RECONNECT_DELAY_MS', 5000),
  },

  // —— NPC 人设与聊天规则 ——
  npc: {
    // 人设里的名字，玩家喊这个名字或游戏 ID 都会触发回复
    name: readString('NPC_NAME', '阿方'),
    // mention：被点名（或私聊）才回复；all：公屏每句都回复
    chatTrigger: readString('CHAT_TRIGGER', 'mention'),
    // 每个玩家记住最近多少条消息（一问一答算 2 条）
    memorySize: readNumber('CHAT_MEMORY_SIZE', 12),
    // 允许挖天然方块（原木、泥土、石头、矿石……，只在玩家要求时挖，建材一律不碰）
    allowDig: readBoolean('NPC_ALLOW_DIG', true),
    // 允许打敌对怪物（永远不打玩家和动物）
    allowCombat: readBoolean('NPC_ALLOW_COMBAT', true),
    // auto 默认进服自主生存；on 手动启动；off 关闭。保留显式配置的选择。
    autonomy: readString('NPC_AUTONOMY', 'auto'),
    autonomyMode: readString('AUTONOMY_MODE', 'survival'),
  },

  // 默认自动准备身份并连接 MongoDB；可显式关闭。
  memory: {
    enabled: readBoolean('MEMORY_ENABLED', true),
    mongoUri: readString('MONGODB_URI', 'mongodb://127.0.0.1:27017'),
    database: readString('MEMORY_DATABASE', 'mc_agent'),
    agentId: readString('AGENT_ID', ''),
    profile: readString('MEMORY_PROFILE', ''),
    teamId: readString('AGENT_TEAM_ID', ''),
    worldId: readString('WORLD_ID', ''),
    worldName: readString('WORLD_NAME', ''),
    worldSeed: readString('WORLD_SEED', ''),
    parentWorldId: readString('PARENT_WORLD_ID', ''),
    worldEpoch: readString('WORLD_EPOCH', 'initial'),
    role: readString('AGENT_ROLE', ''),
    backstory: readString('AGENT_BACKSTORY', ''),
  },

  // —— 大模型（任意 OpenAI 兼容接口，默认 DeepSeek）——
  llm: {
    baseUrl: readString('LLM_BASE_URL', 'https://api.deepseek.com'),
    apiKey: readString('LLM_API_KEY', ''),
    model: readString('LLM_MODEL', 'deepseek-chat'),
    timeoutMs: readNumber('LLM_TIMEOUT_MS', 30000),
  },
};
