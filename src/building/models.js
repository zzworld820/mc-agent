// 房屋模型是数据，不是可执行脚本。新模型复用施工器，不复制建造流程。
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

export const MODEL_DIRECTORY = new URL('../../data/building/models/', import.meta.url);

const starter = {
  schemaVersion: 1,
  id: 'starter',
  version: 2,
  name: '石木生存小屋',
  description: '低成本石墙、平木顶和玻璃窗，后方翼房可连续扩建，也可用梯井连接上层或地下储藏层。',
  features: {
    style: ['石木', '平顶', '玻璃窗'],
    purposes: ['早期生存', '居住', '储物', '加工'],
    materialTier: 'early',
    highlights: ['保留主屋扩建', '中央通道', '通用功能区', '梯井连接上下层'],
  },
  provenance: { kind: 'builtin', parents: [] },
  status: 'ready',
  layout: 'rectangular',
  size: { width: 7, depth: 7, wallHeight: 3 },
  palette: { floor: 'cobblestone', wall: 'cobblestone', roof: 'oak_planks', window: 'glass', door: 'oak_door', light: 'torch' },
  // 床只使用背包现有材料；不为装修强制猎羊。
  furniture: { chests: 4, furnaces: 3, beds: 2, craftingTables: 1 },
  expansions: [{
    id: 'utility', name: '通用功能翼房', description: '沿后方追加储物和加工空间，中央连接门洞保持通行。',
    size: { width: 7, depth: 5, wallHeight: 3 },
    furniture: { chests: 4, furnaces: 2, beds: 0, craftingTables: 0 },
    direction: 'back', repeatable: true,
  }, {
    id: 'upper-storage', name: '上层储藏室', description: '复用原屋顶作楼板，保留原主体，以梯井连接。',
    size: { width: 7, depth: 7, wallHeight: 3 }, furniture: { chests: 4, furnaces: 0, beds: 0, craftingTables: 0 },
    direction: 'up', repeatable: true,
  }, {
    id: 'basement', name: '地下储藏层', description: '在完整干燥围岩中开挖，保留天然围墙和原地板作顶板，以梯井连接。',
    size: { width: 7, depth: 7, wallHeight: 3 }, furniture: { chests: 4, furnaces: 0, beds: 0, craftingTables: 0 },
    direction: 'down', repeatable: true,
  }],
};

const warehouse = {
  ...structuredClone(starter),
  id: 'warehouse', name: '石木仓储工坊',
  description: '9x9 石木平顶工坊，扩大箱子与熔炉区，不默认布置床；可连续增加仓储翼房。',
  features: { style: ['石木', '平顶', '宽开间'], purposes: ['集中储物', '批量加工'], materialTier: 'early', highlights: ['更多箱子', '更多熔炉', '连续仓储扩建'] },
  size: { width: 9, depth: 9, wallHeight: 3 },
  furniture: { chests: 6, furnaces: 6, beds: 0, craftingTables: 1 },
  expansions: [{
    id: 'storage', name: '仓储翼房', description: '追加箱子和熔炉区，保留中央通道。',
    size: { width: 9, depth: 7, wallHeight: 3 },
    furniture: { chests: 6, furnaces: 4, beds: 0, craftingTables: 0 },
    direction: 'back', repeatable: true,
  }, {
    id: 'upper-storage', name: '上层仓库', description: '同占地加层，以梯井连接，不拆主屋。',
    size: { width: 9, depth: 9, wallHeight: 3 }, furniture: { chests: 6, furnaces: 0, beds: 0, craftingTables: 0 },
    direction: 'up', repeatable: true,
  }, {
    id: 'basement', name: '地下仓库', description: '在完整干燥围岩中开挖，以梯井连接。',
    size: { width: 9, depth: 9, wallHeight: 3 }, furniture: { chests: 6, furnaces: 0, beds: 0, craftingTables: 0 },
    direction: 'down', repeatable: true,
  }],
};

function check(condition, message) {
  if (!condition) throw new Error(`房屋模型无效：${message}`);
}

function validateSize(size) {
  check(size && Number.isInteger(size.width) && size.width >= 7 && size.width <= 31, '宽度应为 7～31');
  check(Number.isInteger(size.depth) && size.depth >= 5 && size.depth <= 31, '深度应为 5～31');
  check(Number.isInteger(size.wallHeight) && size.wallHeight >= 3 && size.wallHeight <= 8, '墙高应为 3～8');
}

function validateFurniture(furniture, size) {
  for (const name of ['chests', 'furnaces', 'beds', 'craftingTables']) {
    check(Number.isInteger(furniture?.[name]) && furniture[name] >= 0, `家具 ${name} 必须是非负整数`);
  }
  check(furniture.chests <= size.width - 3, '箱子数超过后墙非通道位置');
  check(furniture.furnaces <= size.depth - 3, '熔炉数超过侧墙位置');
  check(furniture.beds <= 2 && furniture.craftingTables <= 1, '当前布局支持最多两张床和一个工作台');
}

export function validateHouseModel(model) {
  check(model?.schemaVersion === 1, '不支持的 schemaVersion');
  check(typeof model.id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(model.id), 'id 应是小写英文、数字、下划线或连字符');
  check(Number.isInteger(model.version) && model.version > 0, 'version 必须是正整数');
  for (const field of ['name', 'description']) check(typeof model[field] === 'string' && model[field].trim(), `缺少 ${field}`);
  check(['ready', 'draft'].includes(model.status), 'status 应为 ready 或 draft');
  check(model.layout === 'rectangular', '当前施工器只支持 rectangular，其他形状需增加施工器');
  validateSize(model.size);
  validateFurniture(model.furniture, model.size);
  for (const field of ['style', 'purposes', 'highlights']) {
    check(Array.isArray(model.features?.[field]) && model.features[field].length > 0
      && model.features[field].every((value) => typeof value === 'string' && value.trim()), `缺少特征 ${field}`);
  }
  check(['early', 'mid', 'late'].includes(model.features.materialTier), '材料阶段应为 early、mid 或 late');
  check(model.provenance && ['builtin', 'imported', 'derived'].includes(model.provenance.kind)
    && Array.isArray(model.provenance.parents), '缺少来源和父模型记录');
  for (const parent of model.provenance.parents) {
    check(typeof parent?.id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(parent.id)
      && Number.isInteger(parent.version) && parent.version > 0, '父模型需要有效 id 和 version');
  }
  // V1 只接受当前放置器已支持的完整方块，不能把楼梯/半砖当普通墙执行。
  const solids = /^(cobblestone|stone|stone_bricks|deepslate|cobbled_deepslate|bricks|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry)_planks)$/;
  for (const part of ['floor', 'wall', 'roof']) check(solids.test(model.palette?.[part]), `不支持的 ${part} 材料`);
  check(model.palette.window === 'glass' && model.palette.door === 'oak_door'
    && model.palette.light === 'torch', 'V1 门窗照明使用 oak_door / glass / torch');
  check(Array.isArray(model.expansions), 'expansions 必须是数组');
  const ids = new Set();
  for (const expansion of model.expansions) {
    check(typeof expansion.id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(expansion.id) && !ids.has(expansion.id), '扩建模块 id 重复或无效');
    ids.add(expansion.id);
    check(typeof expansion.name === 'string' && expansion.name.trim()
      && typeof expansion.description === 'string' && expansion.description.trim(), '扩建模块缺少名称或描述');
    validateSize(expansion.size);
    validateFurniture(expansion.furniture, expansion.size);
    check(['back', 'up', 'down'].includes(expansion.direction) && typeof expansion.repeatable === 'boolean', '扩建方向为 back/up/down，需声明 repeatable');
    check(expansion.size.width === model.size.width && expansion.size.wallHeight === model.size.wallHeight, '扩建接口宽度和墙高必须匹配主屋');
    check(expansion.direction === 'back' || expansion.size.depth === model.size.depth, '垂直模块必须与主屋占地匹配');
  }
  return structuredClone(model);
}

export async function listHouseModels({ includeDrafts = false } = {}) {
  const models = new Map([starter, warehouse].map((model) => [model.id, validateHouseModel(model)]));
  let files;
  try { files = await readdir(MODEL_DIRECTORY); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    files = [];
  }
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const model = validateHouseModel(JSON.parse(await readFile(new URL(encodeURIComponent(file), MODEL_DIRECTORY), 'utf8')));
    check(!models.has(model.id), `模型 id ${model.id} 重复，不能覆盖其他模型`);
    models.set(model.id, model);
  }
  return [...models.values()].filter((model) => includeDrafts || model.status === 'ready');
}

export async function getHouseModel(id = 'starter') {
  const model = (await listHouseModels()).find((entry) => entry.id === id);
  if (!model) throw new Error(`没有可施工的房屋模型「${id}」，先查询 list_house_models`);
  return model;
}

/** 后续学习器的接入点：从模型派生候选，记录谱系；不冒充已验证模型。 */
export function deriveHouseModel(parent, changes) {
  check(changes.id && changes.id !== parent.id, '派生模型必须使用新的 id');
  return validateHouseModel({
    ...structuredClone(parent), ...structuredClone(changes), schemaVersion: 1, version: 1, status: 'draft',
    provenance: { kind: 'derived', parents: [{ id: parent.id, version: parent.version }] },
  });
}

export async function saveHouseModelDraft(model) {
  const draft = validateHouseModel({ ...model, status: 'draft' });
  check(!(await listHouseModels({ includeDrafts: true })).some((entry) => entry.id === draft.id), '模型 id 已存在');
  await mkdir(MODEL_DIRECTORY, { recursive: true });
  await writeFile(new URL(`${draft.id}.json`, MODEL_DIRECTORY), `${JSON.stringify(draft, null, 2)}\n`, { flag: 'wx' });
  return draft;
}

/** 从同一布局生成施工材料，避免换模型后仍按 starter 数量采集。 */
export function shellMaterials(model, size, { sharedFront = false } = {}) {
  const materials = {};
  for (const block of planHouseShell(model, size, { sharedFront })) materials[block.item] = (materials[block.item] ?? 0) + 1;
  materials[model.palette.light] = (materials[model.palette.light] ?? 0) + 4;
  return materials;
}

/** 相对坐标蓝图同时用于材料统计和施工，后续其他布局在此增加适配器。 */
export function planHouseShell(model, { width, depth, wallHeight }, { sharedFront = false, entrance = true, windows: glazed = true } = {}) {
  const blocks = [];
  const center = Math.floor(width / 2);
  const windows = new Set(windowOffsets({ width, depth }).map((offset) => offset.join(',')));
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) blocks.push({ offset: [x, 0, z], item: model.palette.floor });
  }
  for (let y = 1; y <= wallHeight; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        const perimeter = x === 0 || x === width - 1 || z === 0 || z === depth - 1;
        if (!perimeter || (sharedFront && z === 0)) continue;
        if (!sharedFront && entrance && z === 0 && x === center && y <= 2) continue;
        const offset = [x, y, z];
        blocks.push({ offset, item: glazed && windows.has(offset.join(',')) ? model.palette.window : model.palette.wall });
      }
    }
  }
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) blocks.push({ offset: [x, wallHeight + 1, z], item: model.palette.roof });
  }
  if (!sharedFront && entrance) blocks.push({ offset: [center, 1, 0], item: model.palette.door, allowDoor: true });
  return blocks;
}

export function windowOffsets({ width, depth }) {
  const offsets = [[0, 2, 2], [0, 2, depth - 3], [width - 1, 2, 2], [width - 1, 2, depth - 3], [2, 2, depth - 1], [width - 3, 2, depth - 1]];
  return [...new Map(offsets.map((offset) => [offset.join(','), offset])).values()];
}
