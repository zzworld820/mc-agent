import { readFile } from 'node:fs/promises';

export async function loadAgentProfiles(config, file = process.env.AGENT_PROFILES_FILE, env = process.env) {
  if (!file) return [{ id: 'default', ...config }];
  const profiles = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 16) {
    throw new Error('Agent 配置需包含 1 至 16 个档案');
  }
  const ids = new Set();
  const accounts = new Set();
  return profiles.map(profile => {
    if (!profile || typeof profile.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(profile.id) || ids.has(profile.id)) {
      throw new Error('Agent 档案 ID 无效或重复');
    }
    ids.add(profile.id);
    const minecraft = { ...config.minecraft, ...profile.minecraft };
    const account = minecraft.username?.toLowerCase();
    if (!account || accounts.has(account)) throw new Error('每个 Agent 必须使用不同的 Minecraft 账号');
    accounts.add(account);
    const { apiKeyEnv, baseUrl = config.llm.baseUrl, model = config.llm.model } = profile.llm ?? {};
    const endpoint = new URL(baseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error(`Agent ${profile.id} 的模型接口地址无效`);
    }
    if (typeof model !== 'string' || !model.trim()) throw new Error(`Agent ${profile.id} 的模型名无效`);
    if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))) {
      throw new Error(`Agent ${profile.id} 的密钥环境变量名无效`);
    }
    if (profile.llm && Object.hasOwn(profile.llm, 'apiKey')) throw new Error('请通过 apiKeyEnv 引用密钥');
    // An overridden provider never inherits credentials for a different endpoint.
    const apiKey = apiKeyEnv ? env[apiKeyEnv] || '' : baseUrl === config.llm.baseUrl ? config.llm.apiKey : '';
    return { ...config, id: profile.id, minecraft,
      npc: { ...config.npc, name: minecraft.username, ...profile.npc },
      llm: { ...config.llm, baseUrl, model, apiKey } };
  });
}
