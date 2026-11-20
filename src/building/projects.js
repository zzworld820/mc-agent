// 工程坐标和模型快照独立于对话记忆，重启后仍能定位扩建接口。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { planHouseShell } from './models.js';

const DIRECTORY = new URL('../../data/building/', import.meta.url);
const FILE = new URL('projects.json', DIRECTORY);
let pending = Promise.resolve();

// 模型快照保留最终设计，临时封闭材料单独记录，续建和入住检查读取同一份计划。
export function projectShellPlan(project) {
  const target = planHouseShell(project.model, project.model.size);
  const model = { ...project.model, palette: { ...project.model.palette, ...project.construction?.palette } };
  return planHouseShell(model, model.size).map((entry, index) => ({
    ...entry, acceptedItems: [...new Set([entry.item, target[index].item])], targetItem: target[index].item,
  }));
}

export function buildingWorldKey(bot) {
  if (bot.memory?.worldId) {
    const context = bot.memory.context();
    return JSON.stringify([context.worldId, context.dimension]);
  }
  const server = bot.buildingServer ?? `${bot._client?.socket?.remoteAddress ?? 'unknown'}:${bot._client?.socket?.remotePort ?? 'unknown'}`;
  return `${server}/${bot.game?.dimension ?? 'unknown'}`;
}

async function readData() {
  try {
    const data = JSON.parse(await readFile(FILE, 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.experiences)) {
      throw new Error('建筑工程记录格式不支持，保留原文件并停止写入');
    }
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { schemaVersion: 1, projects: [], experiences: [] };
  }
}

async function updateData(change) {
  const operation = pending.then(async () => {
    const data = await readData();
    const result = change(data);
    await mkdir(DIRECTORY, { recursive: true });
    const temporary = new URL(`projects-${randomUUID()}.tmp`, DIRECTORY);
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
    await rename(temporary, FILE);
    return result;
  });
  pending = operation.catch(() => {});
  return operation;
}

export async function listHouseProjects(bot) {
  if (bot.memory?.enabled) {
    return bot.memory.manager.loadProjects(bot.memory.context());
  }
  await pending;
  return (await readData()).projects.filter((project) => project.world === buildingWorldKey(bot));
}

/** 后续学习器读取真实施工反馈；不能把 completed 当作实测验收或审美评分。 */
export async function listBuildingExperiences(bot, { modelId } = {}) {
  if (bot.memory?.enabled) return bot.memory.manager.loadBuildingExperiences(bot.memory.context(), modelId);
  await pending;
  return (await readData()).experiences.filter((entry) => entry.world === buildingWorldKey(bot)
    && (!modelId || entry.modelId === modelId));
}

export async function saveHouseProject(project, memory) {
  if (memory?.enabled) {
    const context = memory.context();
    if (project.world !== JSON.stringify([context.worldId, context.dimension])) throw new Error('工程所属世界或维度与当前不符，停止写入');
    await memory.manager.remember(context, { kind: 'project', key: project.id, title: `${project.model.name}工程`,
      data: project, source: { type: 'project_record' } });
    const snapshot = structuredClone(project);
    memory.enqueue(() => memory.manager.rememberFacility(context, {
      id: snapshot.id, name: snapshot.model.name, type: 'house', position: snapshot.origin,
      status: snapshot.status === 'complete' ? 'built_unverified' : 'building', projectId: snapshot.id,
      components: snapshot.extensions.map((entry) => ({ type: 'extension', origin: entry.origin, status: entry.status })),
    }));
    return project;
  }
  return updateData((data) => {
    const index = data.projects.findIndex((entry) => entry.id === project.id);
    const saved = structuredClone({ ...project, updatedAt: new Date().toISOString() });
    if (index < 0) data.projects.push(saved);
    else data.projects[index] = saved;
    return saved;
  });
}

export function createHouseProject(bot, model, origin) {
  return {
    id: randomUUID(), world: buildingWorldKey(bot), model: structuredClone(model),
    ...(bot.portfolioAgentId ? { ownerAgent: bot.portfolioAgentId } : {}),
    origin: { x: origin.x, y: origin.y, z: origin.z }, status: 'building', extensions: [],
  };
}

export async function recordBuildingExperience(project, { operation, outcome, detail }, memory) {
  if (memory?.enabled) {
    const context = memory.context();
    if (project.world !== JSON.stringify([context.worldId, context.dimension])) throw new Error('施工反馈世界不匹配');
    await memory.manager.recordEvent(context, detail, { projectId: project.id, modelId: project.model.id,
      modelVersion: project.model.version, operation, outcome, features: project.model.features });
    return;
  }
  return updateData((data) => {
    data.experiences.push({
      at: new Date().toISOString(), projectId: project.id, world: project.world,
      modelId: project.model.id, modelVersion: project.model.version,
      operation, outcome, detail,
      // 这是施工反馈，不是自动验收或美学评分。
      evidence: 'execution', features: project.model.features,
    });
  });
}
