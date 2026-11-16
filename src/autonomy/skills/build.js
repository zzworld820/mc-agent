// 建造技能：先解决“能活下来”，再逐步提升居住质量。
//
// 这一层不让大模型自由发挥坐标，而是由代码生成可验证的建筑计划：
//   1. 洞穴避难所：在附近山体中挖一个小房间，装门、火把和基础功能方块。
//   2. 基础房屋：找一块落地且安全的地面，按 7x7 模板建造地板、墙、屋顶、门和窗。
//
// 所有耗时操作都复用自主发育的 ctx（包含 signal、obtain、log），所以能取消、缺
// 材料时会自动递归采集，死后也能由上层重新执行。
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { countItem, goTo, sleep, throwIfAborted } from '../../actions/helpers.js';
import { digBlock } from './mine.js';
import { placeBed as placeBedNearPlayer } from './sleep.js';
import { getHouseModel, planHouseShell, shellMaterials, windowOffsets } from '../../building/models.js';
import { createHouseProject, listHouseProjects, saveHouseProject, recordBuildingExperience } from '../../building/projects.js';
import { reachHome } from '../../strategy/navigation.js';

const { goals } = pathfinderPkg;

const CARDINALS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];

const BUILD_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'fern', 'tall_grass']);
const NATURAL_WALLS = new Set([
  'stone', 'deepslate', 'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'sand', 'red_sand',
  'gravel', 'clay', 'mud', 'tuff', 'granite', 'diorite', 'andesite', 'calcite', 'netherrack',
]);
const HOUSE_BLOCKS = new Set([
  'cobblestone', 'stone', 'deepslate', 'oak_planks', 'glass', 'glass_pane', 'oak_door',
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'lantern', 'soul_lantern',
  'crafting_table', 'furnace', 'chest', 'white_bed', 'ladder',
]);
const LIQUIDS = new Set(['water', 'lava']);
const HOUSE_SEARCH_RADIUS = 32;

/** 建一个低成本的山洞避难所。 */
export async function buildShelter(ctx, { resultDetails = false } = {}) {
  let remembered = ctx.state.plannedShelter;
  if (remembered && !isSafeCaveSite(ctx.bot, toPosition(remembered.entrance), remembered.direction, remembered.lateral)) {
    ctx.state.abandonedShelters ??= [];
    ctx.state.abandonedShelters.push({ ...remembered, reason: '旧入口不再具备安全通行条件', at: Date.now() });
    if (ctx.state.home?.status === 'building') ctx.state.home = null;
    ctx.state.plannedShelter = null;
    remembered = null;
    await ctx.checkpoint?.();
  }
  const site = remembered ? { ...remembered, entrance: toPosition(remembered.entrance) } : findCaveSite(ctx.bot);
  if (!site) throw new Error('附近没有适合挖避难所的山体，先换个位置再试');
  if (!isSafeCaveSite(ctx.bot, site.entrance, site.direction, site.lateral)) throw new Error('避难所地基或围岩发生变化，停止开挖');
  ctx.state.plannedShelter = { entrance: { x: site.entrance.x, y: site.entrance.y, z: site.entrance.z }, direction: site.direction, lateral: site.lateral };
  await ctx.checkpoint?.();

  ctx.log(`找到山体，准备在 ${format(site.entrance)} 挖避难所`);
  const roomBlocks = [];
  // 入口向山体内延伸 4 格，横向 3 格、高 3 格；保留最底下一层作为地面。
  for (let depth = 0; depth < 4; depth++) {
    for (let side = -1; side <= 1; side++) {
      for (let height = 0; height < 3; height++) {
        if (depth === 0 && (side !== 0 || height === 2)) continue; // 保留入口两侧和门楣，不能挖出敞开的三格入口
        roomBlocks.push(site.entrance.offset(site.direction.x * depth + site.lateral.x * side, height, site.direction.z * depth + site.lateral.z * side));
      }
    }
  }

  // 先挖高处和深处，减少掉落物/实体把入口堵住的机会。
  roomBlocks.sort((a, b) => b.y - a.y || b.distanceTo(site.entrance) - a.distanceTo(site.entrance));
  for (const position of roomBlocks) {
    throwIfAborted(ctx.signal);
    const block = ctx.bot.blockAt(position);
    if (!block || BUILD_BLOCKS.has(block.name)) continue;
    if (block.name === 'water' || block.name === 'lava') throw new Error(`避难所位置碰到 ${block.name}，为安全起见停止挖掘`);
    if (!NATURAL_WALLS.has(block.name)) {
      if (HOUSE_BLOCKS.has(block.name)) continue;
      throw new Error('洞体中存在未知建筑方块，停止开挖');
    }
    await digBlock(ctx, block);
  }

  const frame = [site.entrance.offset(0, 2, 0)];
  for (const side of [-1, 1]) for (let y = 0; y < 3; y++) frame.push(site.entrance.offset(site.lateral.x * side, y, site.lateral.z * side));
  const missingFrame = frame.filter((p) => ctx.bot.blockAt(p)?.boundingBox !== 'block');
  if (missingFrame.length) await ensureObtained(ctx, 'cobblestone', missingFrame.length);
  for (const p of missingFrame) await placePlannedBlock(ctx, p, 'cobblestone');
  await ensureObtained(ctx, 'oak_door', 1);
  await placeBlockAt(ctx, site.entrance, 'oak_door', { allowDoor: true });
  const provisionalInside = site.entrance.offset(site.direction.x * 2, 0, site.direction.z * 2);
  if (!ctx.state.home || ctx.state.home.status === 'building') {
    ctx.state.home = { x: provisionalInside.x, y: provisionalInside.y, z: provisionalInside.z,
      door: { x: site.entrance.x, y: site.entrance.y, z: site.entrance.z },
      dimension: String(ctx.bot.game.dimension), kind: 'cave', status: 'building' };
    await ctx.checkpoint?.();
  }

  await ensureObtained(ctx, 'torch', 4);
  // 备料可能走远；门装好后必须显式开门返回，不能靠拆墙进入。
  for (const item of ['crafting_table', 'furnace']) {
    try { await ensureObtained(ctx, item, 1); }
    catch (err) { throwIfAborted(ctx.signal); ctx.log(`避难所家具暂缓：${err.message}`); }
  }
  const shelterInside = site.entrance.offset(site.direction.x * 2, 0, site.direction.z * 2);
  await reachHome(ctx, { x: shelterInside.x, y: shelterInside.y, z: shelterInside.z,
    door: { x: site.entrance.x, y: site.entrance.y, z: site.entrance.z }, dimension: String(ctx.bot.game.dimension) });
  const torchPositions = [
    site.entrance.offset(site.direction.x * 2 + site.lateral.x, 1, site.direction.z * 2 + site.lateral.z),
    site.entrance.offset(site.direction.x * 3 - site.lateral.x, 1, site.direction.z * 3 - site.lateral.z),
  ];
  for (const position of torchPositions) {
    if (ctx.bot.blockAt(position)?.name === 'air') await placeBlockAt(ctx, position, 'torch');
  }

  await placeManyFurniture(ctx, 'crafting_table', [site.entrance.offset(site.direction.x * 3 + site.lateral.x, 0, site.direction.z * 3 + site.lateral.z)]);
  await placeManyFurniture(ctx, 'furnace', [site.entrance.offset(site.direction.x * 3 - site.lateral.x, 0, site.direction.z * 3 - site.lateral.z)]);
  ctx.log('山洞避难所已完成');
  const message = `山洞避难所建好了：入口在 ${format(site.entrance)}，有门、火把，并尝试布置工作台和熔炉`;
  const inside = site.entrance.offset(site.direction.x * 2, 0, site.direction.z * 2);
  return resultDetails ? { message, position: { x: inside.x, y: inside.y, z: inside.z }, door: { x: site.entrance.x, y: site.entrance.y, z: site.entrance.z } } : message;
}

/** 按注册模型施工；未完工项目使用自己的模型快照恢复。 */
export async function buildHouse(ctx, { style = 'starter', modelId = style, resultDetails = false } = {}) {
  const projects = await listHouseProjects(ctx.bot);
  let project = projects.find((entry) => entry.id === ctx.state.activeHouseProjectId && entry.model.id === modelId)
    ?? nearestProject(ctx.bot, projects.filter((entry) => entry.model.id === modelId && entry.status === 'building'));
  const activeModel = project?.model ?? await getHouseModel(modelId);
  const plan = activeModel.size;
  if (project && toPosition(project.origin).distanceTo(ctx.bot.entity.position) > 24) {
    const origin = toPosition(project.origin);
    await goTo(ctx.bot, new goals.GoalNear(origin.x, origin.y + 1, origin.z, 4), { signal: ctx.signal, timeoutMs: 90000 });
  }
  const site = project ? { origin: toPosition(project.origin), existing: true }
    : findHouseSite(ctx.bot, plan, { model: activeModel, emptyOnly: true });
  if (!site) throw new Error(`附近没有连续 ${plan.width}x${plan.depth}、落地且安全的空地，无法安全开工`);
  if (!isSafeHouseSite(ctx.bot, site.origin, plan, activeModel)) throw new Error('原工程地基或周边环境已改变，停止施工');
  project ??= createHouseProject(ctx.bot, activeModel, site.origin);
  ctx.state.activeHouseProjectId = project.id;
  await ctx.checkpoint?.();
  await saveHouseProject(project, ctx.bot.memory);
  return runProjectOperation(ctx, project, 'build', async () => {
    await obtainShellMaterials(ctx, activeModel, plan, { origin: site.origin });
    if (!isSafeHouseSite(ctx.bot, site.origin, plan, activeModel)) throw new Error('采集材料后地基已改变，停止施工');
    ctx.log(`开始建造 ${activeModel.name}，位置 ${format(site.origin)}${site.existing ? '（继续已有工程）' : ''}`);
    await buildShell(ctx, site.origin, plan, { model: activeModel });
    await furnishHouse(ctx, site.origin, plan, { furniture: activeModel.furniture });
    throwIfAborted(ctx.signal);
    project.status = 'complete';
    await saveHouseProject(project, ctx.bot.memory);
    const message = `${activeModel.name}主体施工完成：${plan.width}x${plan.depth}，门窗已安装，家具按材料和空位尽力布置；可继续扩建`;
    const inside = site.origin.offset(Math.floor(plan.width / 2), 1, 2);
    const entrance = site.origin.offset(Math.floor(plan.width / 2), 1, 0);
    return resultDetails ? { message, position: { x: inside.x, y: inside.y, z: inside.z },
      door: { x: entrance.x, y: entrance.y, z: entrance.z }, projectId: project.id } : message;
  });
}

/** 按工程快照追加模型声明的翼房，重复扩建接到上一段后方。 */
export async function expandHouse(ctx, { modelId, moduleId, projectId, direction = 'back' } = {}) {
  if (!['back', 'up', 'down'].includes(direction)) throw new Error('扩建方向必须为 back/up/down');
  const projects = await listHouseProjects(ctx.bot);
  let project = nearestProject(ctx.bot, projects.filter((entry) => entry.status === 'complete'
    && (!modelId || entry.model.id === modelId) && (!projectId || entry.id === projectId)));
  // 兼容框架加入前的 starter 房屋；不靠相似方块猜测其他模型。
  if (!project && !projectId && (!modelId || modelId === 'starter')) {
    const model = await getHouseModel('starter');
    const base = findHouseSite(ctx.bot, model.size, { existingOnly: true, model });
    if (base) {
      project = createHouseProject(ctx.bot, model, base.origin);
      project.status = 'complete';
      await saveHouseProject(project, ctx.bot.memory);
    }
  }
  if (!project) throw new Error('附近没有匹配的已完成房屋工程，暂时不能安全扩建');
  const pending = project.extensions.find((entry) => entry.status === 'building');
  if (pending && pending.module.direction !== direction) throw new Error(`先继续未完工的 ${pending.module.direction} 扩建`);
  if (direction !== 'back') {
    const { expandVertical } = await import('../../building/vertical.js');
    return runProjectOperation(ctx, project, `expand:${direction}`, () => expandVertical(ctx, project, { direction, moduleId }));
  }
  const model = project.model;
  const unfinished = project.extensions.find((entry) => entry.status === 'building');
  if (unfinished && moduleId && unfinished.module.id !== moduleId) throw new Error('先继续当前未完工模块，再切换扩建模块');
  const module = unfinished?.module ?? model.expansions.find((entry) => entry.direction === 'back' && (!moduleId || entry.id === moduleId));
  if (!module) throw new Error(`模型 ${model.id} 没有匹配的扩建模块`);
  if (!unfinished && !module.repeatable && project.extensions.some((entry) => entry.module.id === module.id)) {
    throw new Error('该扩建模块不能重复追加');
  }
  const last = project.extensions.filter((entry) => entry.status === 'complete' && entry.module.direction === 'back').at(-1);
  const previousOrigin = toPosition(last?.origin ?? project.origin);
  const previousSize = last?.module.size ?? model.size;
  if (!isSafeProjectRoom(ctx.bot, project, previousOrigin, previousSize)) throw new Error('已有房间的地基或环境已改变，停止扩建');
  const origin = unfinished ? toPosition(unfinished.origin) : previousOrigin.offset(0, 0, previousSize.depth - 1);
  const plan = module.size;
  if (!isSafeHouseSite(ctx.bot, origin, plan, model) || !isClearExtension(ctx.bot, origin, plan, model, !!unfinished)) {
    throw new Error('扩建位置缺少安全地基或被占用，不会拆掉其他建筑');
  }
  const extension = unfinished ?? { module: structuredClone(module), origin: { x: origin.x, y: origin.y, z: origin.z }, status: 'building' };
  if (!unfinished) project.extensions.push(extension);
  await saveHouseProject(project, ctx.bot.memory);
  return runProjectOperation(ctx, project, `expand:${module.id}`, async () => {
    await obtainShellMaterials(ctx, model, plan, { sharedFront: true, origin });
    await ensureObtained(ctx, 'wooden_pickaxe', 1);
    if (!isSafeHouseSite(ctx.bot, origin, plan, model) || !isClearExtension(ctx.bot, origin, plan, model, true)) {
      throw new Error('采集材料后扩建环境已改变，停止施工');
    }
    ctx.log(`追加 ${module.name}，位置 ${format(origin)}`);
    // 先完成翼房外壳，再打开连接，避免施工失败后主屋敞开。
    await buildShell(ctx, origin, plan, { sharedFront: true, model });
    const connection = origin.offset(Math.floor(plan.width / 2), 1, 0);
    for (let height = 0; height < 2; height++) {
      const position = connection.offset(0, height, 0);
      const block = ctx.bot.blockAt(position);
      if (BUILD_BLOCKS.has(block?.name)) continue;
      if (block?.name !== model.palette.wall) throw new Error(`连接口 ${format(position)} 不是该模型的墙，不会拆除`);
      await digBlock(ctx, block);
    }
    await furnishHouse(ctx, origin, plan, { extension: true, furniture: module.furniture });
    throwIfAborted(ctx.signal);
    extension.status = 'complete';
    await saveHouseProject(project, ctx.bot.memory);
    return `保留原主体，已追加 ${module.name}；当前完成 ${project.extensions.length} 段扩建`;
  });
}

function isSafeProjectRoom(bot, project, origin, size) {
  if (!project.extensions.some((entry) => entry.module.direction === 'down')) return isSafeHouseSite(bot, origin, size, project.model);
  const { width, depth } = size;
  for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) {
    const p = origin.offset(x, 0, z);
    const floor = bot.blockAt(p);
    if (floor?.boundingBox !== 'block' && !(p.x === project.verticalAccess?.x && p.z === project.verticalAccess?.z && floor?.name === 'ladder')) return false;
    if (isPerimeter(x, z, width, depth) && bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') return false;
  }
  return true;
}

async function runProjectOperation(ctx, project, operation, work) {
  try {
    throwIfAborted(ctx.signal);
    const result = await work();
    await recordBuildingExperience(project, { operation, outcome: 'completed', detail: typeof result === 'string' ? result : result.message }, ctx.bot.memory)
      .catch((err) => ctx.log(`主体施工完成，但施工反馈保存失败：${err.message}`));
    return result;
  } catch (err) {
    await recordBuildingExperience(project, { operation, outcome: ctx.signal?.aborted ? 'cancelled' : 'failed', detail: err.message }, ctx.bot.memory)
      .catch((storageError) => ctx.log(`施工反馈保存失败：${storageError.message}`));
    throw err;
  }
}

async function obtainShellMaterials(ctx, model, size, { origin, sharedFront = false }) {
  const materials = shellMaterials(model, size, { sharedFront });
  for (const block of planHouseShell(model, size, { sharedFront })) {
    if (ctx.bot.blockAt(origin.offset(...block.offset))?.name === block.item) materials[block.item]--;
  }
  for (const [item, count] of Object.entries(materials)) {
    if (count > 0) await ensureObtained(ctx, item, count);
  }
}

function toPosition({ x, y, z }) { return new Vec3(x, y, z); }

function nearestProject(bot, projects) {
  const distance = (project) => Math.min(...[project.origin, ...project.extensions.map((entry) => entry.origin)]
    .map((origin) => toPosition(origin).distanceTo(bot.entity.position)));
  return projects.filter((project) => distance(project) <= HOUSE_SEARCH_RADIUS * 2)
    .sort((a, b) => distance(a) - distance(b))[0];
}

function isClearExtension(bot, origin, { width, depth, wallHeight }, model, resuming) {
  const windows = makeWindowPositions(origin, width, depth);
  for (let x = 0; x < width; x++) {
    for (let z = 1; z < depth; z++) {
      for (let y = 0; y <= wallHeight + 1; y++) {
        const name = bot.blockAt(origin.offset(x, y, z))?.name;
        if (BUILD_BLOCKS.has(name)) continue;
        if (!resuming) return false;
        let expected = null;
        if (y === 0) expected = model.palette.floor;
        else if (y === wallHeight + 1) expected = model.palette.roof;
        else if (isPerimeter(x, z, width, depth)) expected = y === 2 && windows.has(key(origin.offset(x, y, z))) ? model.palette.window : model.palette.wall;
        else if (y === 1 && x !== Math.floor(width / 2)
          && (['chest', 'furnace', 'crafting_table', 'torch'].includes(name) || name?.endsWith('_bed'))) continue;
        if (name !== expected) return false;
      }
    }
  }
  return true;
}

async function buildShell(ctx, origin, size, { sharedFront = false, model }) {
  for (const block of planHouseShell(model, size, { sharedFront })) {
    throwIfAborted(ctx.signal);
    await placePlannedBlock(ctx, origin.offset(...block.offset), block.item, { allowDoor: block.allowDoor });
  }
}

export async function furnishHouse(ctx, origin, { width, depth }, { extension = false, reserved = [], furniture = { chests: 4, furnaces: extension ? 2 : 3, craftingTables: 1, beds: 2 } } = {}) {
  const available = (p) => !reserved.some((entry) => entry.x === p.x && entry.z === p.z);
  const center = Math.floor(width / 2);
  const chestPositions = Array.from({ length: width - 2 }, (_, i) => i + 1).filter((x) => x !== center)
    .slice(0, furniture.chests).map((x) => origin.offset(x, 1, depth - 2)).filter(available);
  const furnacePositions = Array.from({ length: depth - 3 }, (_, i) => i + 1)
    .slice(0, furniture.furnaces).map((z) => origin.offset(width - 2, 1, z)).filter(available);
  await placeManyFurniture(ctx, 'chest', chestPositions);
  await placeManyFurniture(ctx, 'furnace', furnacePositions);
  if (furniture.craftingTables) await placeManyFurniture(ctx, 'crafting_table', [origin.offset(1, 1, 1)]);
  const lightPositions = extension
    ? [origin.offset(2, 1, 1), origin.offset(4, 1, 1), origin.offset(1, 1, 2)]
    : [origin.offset(2, 1, 1), origin.offset(4, 1, 1), origin.offset(1, 1, 3), origin.offset(width - 3, 1, depth - 3)];
  for (const position of lightPositions) {
    if (position.x === origin.x + center || !available(position)) continue;
    if (BUILD_BLOCKS.has(ctx.bot.blockAt(position)?.name)) {
      try {
        await placeBlockAt(ctx, position, 'torch');
      } catch (err) {
        throwIfAborted(ctx.signal);
        ctx.log(`火把在 ${format(position)} 暂时放不下：${err.message}`);
      }
    }
  }

  let existingBeds = 0;
  for (let x = 1; x < width - 1; x++) {
    for (let z = 1; z < depth - 1; z++) {
      const block = ctx.bot.blockAt(origin.offset(x, 1, z));
      if (block?.name.endsWith('_bed') && block.getProperties().part === 'head') existingBeds++;
    }
  }
  const missingBeds = Math.max(0, furniture.beds - existingBeds);
  const bed = missingBeds > 0 && findBedItem(ctx.bot);
  const bedOptions = { canPlace: (position) => position.y === origin.y + 1
    && position.x > origin.x && position.x < origin.x + width - 1
    && position.z > origin.z && position.z < origin.z + depth - 1
    && position.x !== origin.x + center && available(position) };
  if (bed) {
    await goTo(ctx.bot, new goals.GoalBlock(origin.x + Math.floor(width / 2), origin.y + 1, origin.z + Math.floor(depth / 2)), { signal: ctx.signal, timeoutMs: 30000 }).catch(() => { throwIfAborted(ctx.signal); });
    const firstBedPlaced = await placeBedNearPlayer(ctx, bed, bedOptions).then(() => true).catch((err) => {
      throwIfAborted(ctx.signal);
      ctx.log(`第一张床暂时放不下：${err.message}`);
      return false;
    });
    if (!firstBedPlaced) ctx.log('第一张床未完成，保留床位');
    const secondBed = missingBeds > 1 && findBedItem(ctx.bot);
    if (secondBed) {
      await goTo(ctx.bot, new goals.GoalBlock(origin.x + center, origin.y + 1, origin.z + 1), { signal: ctx.signal, timeoutMs: 30000 }).catch(() => { throwIfAborted(ctx.signal); });
      const secondBedPlaced = await placeBedNearPlayer(ctx, secondBed, bedOptions).then(() => true).catch((err) => {
        throwIfAborted(ctx.signal);
        ctx.log(`第二张床暂时放不下：${err.message}`);
        return false;
      });
      if (!secondBedPlaced) ctx.log('第二张床未完成，保留为空位');
    }
  } else if (missingBeds > 0) {
    ctx.log('没有现成的床，先保留床位，避免为了装饰强行猎羊');
  }
}

async function placeManyFurniture(ctx, itemName, positions) {
  const emptyPositions = [];
  for (const position of positions) {
    const name = ctx.bot.blockAt(position)?.name;
    if (name === itemName) continue;
    if (BUILD_BLOCKS.has(name)) emptyPositions.push(position);
    else ctx.log(`${itemName} 预留位 ${format(position)} 已被占用，保留现有方块`);
  }
  if (!emptyPositions.length) return;
  try {
    await ensureObtained(ctx, itemName, emptyPositions.length);
  } catch (err) {
    throwIfAborted(ctx.signal);
    ctx.log(`暂时没有足够的 ${itemName}，跳过部分家具：${err.message}`);
    return;
  }
  for (const position of emptyPositions) {
    try {
      await placeBlockAt(ctx, position, itemName);
    } catch (err) {
      throwIfAborted(ctx.signal);
      ctx.log(`${itemName} 在 ${format(position)} 暂时放不下：${err.message}`);
    }
  }
}

function findBedItem(bot) {
  return bot.inventory.items().find((item) => item.name.endsWith('_bed'));
}

async function placePlannedBlock(ctx, position, itemName, options = {}) {
  return placeBlockAt(ctx, position, itemName, options);
}

async function ensureObtained(ctx, item, count) {
  throwIfAborted(ctx.signal);
  if (countItem(ctx.bot, item) >= count) return;
  if (!ctx.obtain) throw new Error(`缺少 ${item} x${count}，当前上下文不能自动采集材料`);
  await ctx.obtain(item, count);
  throwIfAborted(ctx.signal);
  if (countItem(ctx.bot, item) < count) throw new Error(`材料 ${item} 不够，无法继续建造`);
}

export async function placeBlockAt(ctx, position, itemName, { allowDoor = false, allowExisting = false } = {}) {
  const { bot, signal } = ctx;
  let current = bot.blockAt(position);
  if (current?.name === itemName || itemName === 'torch' && current?.name === 'wall_torch' || (allowDoor && current?.name.endsWith('_door'))) return;
  if (allowDoor && current && !BUILD_BLOCKS.has(current.name) && HOUSE_BLOCKS.has(current.name)) {
    await digBlock(ctx, current);
    current = bot.blockAt(position);
  }
  if (allowExisting && HOUSE_BLOCKS.has(current?.name)) return;
  if (!current || !BUILD_BLOCKS.has(current.name)) throw new Error(`${format(position)} 不是空位，不能放 ${itemName}`);

  const references = CARDINALS.concat([{ x: 0, z: 0 }])
    .flatMap(({ x, z }) => [position.offset(x, 0, z), position.offset(0, -1, 0), position.offset(0, 1, 0)])
    .filter((reference, index, all) => all.findIndex((other) => other.equals(reference)) === index)
    .filter((reference) => bot.blockAt(reference)?.boundingBox === 'block')
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));

  const item = bot.inventory.items().find((entry) => entry.name === itemName);
  if (!item) throw new Error(`背包里没有 ${itemName}`);
  let lastError = null;
  for (const reference of references) {
    throwIfAborted(signal);
    try {
      // 不只判断“理论上够不够得着”：明确走到目标旁的可站立格，避免
      // pathfinder 停在目标格里或停在参考块太远的位置，导致服务器拒绝放置。
      await moveToBuildPosition(ctx, position, reference);
      await bot.equip(item, 'hand');
      await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
      await sleep(120, signal);
      const face = new Vec3(position.x - reference.x, position.y - reference.y, position.z - reference.z);
      await bot.placeBlock(bot.blockAt(reference), face);
      await sleep(120, signal);
      const placed = bot.blockAt(position);
      if (placed?.name === itemName || itemName === 'torch' && placed?.name === 'wall_torch' || (allowDoor && placed?.name.endsWith('_door'))) return;
    } catch (err) {
      // 当前参考面不合适，换一个面重试。
      lastError = err;
    }
  }
  throw new Error(`${format(position)} 放不了 ${itemName}${lastError?.message ? `（${lastError.message}）` : ''}`);
}

/** 找一个不占目标格、脚下有支撑且距离目标足够近的施工站位。 */
async function moveToBuildPosition(ctx, target, reference, { force = false, blocked = [] } = {}) {
  const { bot, signal } = ctx;
  const current = bot.entity.position.floored();
  const isBlocked = (position) => blocked.some((other) => other.equals(position));
  const currentCloseEnough = !force && reference.distanceTo(bot.entity.position) <= 2.8 && !current.equals(target) && !isBlocked(current);
  if (currentCloseEnough) return;

  const candidates = CARDINALS
    .flatMap(({ x, z }) => [target.offset(x, 0, z), target.offset(x, 1, z), target.offset(x, -1, z)])
    .filter((position) => {
      const here = bot.blockAt(position);
      const below = bot.blockAt(position.offset(0, -1, 0));
      return !position.equals(target) && !isBlocked(position)
        && here && BUILD_BLOCKS.has(here.name)
        && below?.boundingBox === 'block'
        && !LIQUIDS.has(below.name)
        && position.distanceTo(target) <= 3.5;
    })
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
  for (const position of candidates) {
    try {
      await goTo(bot, new goals.GoalBlock(position.x, position.y, position.z), { signal, timeoutMs: 15000 });
      if (!bot.entity.position.floored().equals(target) && reference.distanceTo(bot.entity.position) <= 4.5) return;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  await goTo(bot, new goals.GoalNear(reference.x, reference.y, reference.z, 1), { signal, timeoutMs: 15000 });
  if (bot.entity.position.floored().equals(target)) throw new Error(`我站在目标格 ${format(target)} 里，找不到安全的施工站位`);
}

function findCaveSite(bot) {
  const feet = bot.entity.position.floored();
  for (const direction of CARDINALS) {
    const lateral = { x: -direction.z, z: direction.x };
    for (let distance = 2; distance <= 12; distance++) {
      const entrance = feet.offset(direction.x * distance, 0, direction.z * distance);
      let solidWall = true;
      for (let side = -1; side <= 1 && solidWall; side++) {
        for (let height = 0; height < 3; height++) {
          const block = bot.blockAt(entrance.offset(lateral.x * side, height, lateral.z * side));
          if (!block || block.boundingBox !== 'block' || !NATURAL_WALLS.has(block.name)) solidWall = false;
        }
      }
      if (solidWall && isSafeCaveSite(bot, entrance, direction, lateral)) return { entrance, direction, lateral };
    }
  }
  return null;
}

function isSafeCaveSite(bot, entrance, direction, lateral) {
  for (const distance of [1, 2]) {
    const outside = entrance.offset(-direction.x * distance, 0, -direction.z * distance);
    if (bot.blockAt(outside.offset(0, -1, 0))?.boundingBox !== 'block'
      || !BUILD_BLOCKS.has(bot.blockAt(outside)?.name) || !BUILD_BLOCKS.has(bot.blockAt(outside.offset(0, 1, 0))?.name)) return false;
  }
  for (let depth = 0; depth < 4; depth++) {
    for (let side = -1; side <= 1; side++) {
      const floor = entrance.offset(direction.x * depth + lateral.x * side, -1, direction.z * depth + lateral.z * side);
      if (bot.blockAt(floor)?.boundingBox !== 'block' || bot.blockAt(floor.offset(0, -1, 0))?.boundingBox !== 'block') return false;
      if (bot.blockAt(floor.offset(0, 4, 0))?.boundingBox !== 'block') return false;
    }
    for (const side of [-2, 2]) {
      for (let y = 0; y < 3; y++) {
        if (bot.blockAt(entrance.offset(direction.x * depth + lateral.x * side, y, direction.z * depth + lateral.z * side))?.boundingBox !== 'block') return false;
      }
    }
  }

  // 连洞体积和一圈缓冲区都不能含水/岩浆，否则挖开后会灌入避难所。
  for (let depth = -1; depth <= 4; depth++) {
    for (let side = -2; side <= 2; side++) {
      for (let height = -1; height <= 3; height++) {
        const position = entrance.offset(
          direction.x * depth + lateral.x * side,
          height,
          direction.z * depth + lateral.z * side,
        );
        const block = bot.blockAt(position);
        if (!block || LIQUIDS.has(block.name) || ['sand', 'red_sand', 'gravel'].includes(block.name)) return false;
      }
    }
  }
  return true;
}

export function findHouseSite(bot, plan = { width: 7, depth: 7, wallHeight: 3 }, { existingOnly = false, emptyOnly = false, model } = {}) {
  const feet = bot.entity.position.floored();
  const allowed = new Set([...HOUSE_BLOCKS, ...Object.values(model?.palette ?? {})]);
  const candidates = [];
  for (let dx = -HOUSE_SEARCH_RADIUS; dx <= HOUSE_SEARCH_RADIUS; dx++) {
    for (let dz = -HOUSE_SEARCH_RADIUS; dz <= HOUSE_SEARCH_RADIUS; dz++) {
      if (!existingOnly && Math.abs(dx) < 4 && Math.abs(dz) < 4) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const origin = feet.offset(dx, dy, dz);
        if (!isSafeHouseSite(bot, origin, plan, model)) continue;
        let valid = true;
        let existing = 0;
        let existingFloor = 0;
        let existingRoof = 0;
        let existingPerimeter = 0;
        for (let x = 0; x < plan.width && valid; x++) {
          for (let z = 0; z < plan.depth && valid; z++) {
            if (allowed.has(bot.blockAt(origin.offset(x, 0, z))?.name)) existingFloor += 1;
            for (let y = 0; y <= plan.wallHeight + 1; y++) {
              if (allowed.has(bot.blockAt(origin.offset(x, y, z))?.name)) {
                existing += 1;
                if (y === plan.wallHeight + 1) existingRoof += 1;
                if (y >= 1 && y <= plan.wallHeight && isPerimeter(x, z, plan.width, plan.depth)) existingPerimeter += 1;
              }
            }
          }
        }
        const completeLike = existingFloor >= Math.ceil(plan.width * plan.depth * 0.9)
          && existingRoof >= Math.ceil(plan.width * plan.depth * 0.9)
          && existingPerimeter >= Math.ceil((plan.width * 2 + plan.depth * 2 - 4) * 1.5);
        const existingScore = completeLike ? existing : 0;
        if (emptyOnly && existing > 0) continue;
        if (valid && (!existingOnly || existingScore > 0)) candidates.push({ origin, existing: existingScore });
      }
    }
  }
  candidates.sort((a, b) => b.existing - a.existing || a.origin.distanceTo(feet) - b.origin.distanceTo(feet));
  return candidates[0] ? { origin: candidates[0].origin, existing: candidates[0].existing > 0 } : null;
}

/** 建造选址硬约束：必须落地、有连续支撑、无水无岩浆，且不会吞掉非本项目方块。 */
export function isSafeHouseSite(bot, origin, { width, depth, wallHeight = 3 } = {}, model) {
  const allowed = new Set([...HOUSE_BLOCKS, ...Object.values(model?.palette ?? {})]);
  if (![width, depth].every((value) => Number.isInteger(value) && value > 0)) return false;
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      const floor = bot.blockAt(origin.offset(x, -1, z));
      const support = bot.blockAt(origin.offset(x, -2, z));
      if (!floor || floor.boundingBox !== 'block' || !support || (!NATURAL_WALLS.has(floor.name) && !allowed.has(floor.name))) return false;
      if (support.boundingBox !== 'block' || LIQUIDS.has(support.name)) return false;
    }
  }

  // 检查建筑体积和一格缓冲区，避免半空、液体和树/山体把房子顶穿。
  for (let x = -1; x <= width; x++) {
    for (let z = -1; z <= depth; z++) {
      for (let y = -2; y <= wallHeight + 2; y++) {
        const block = bot.blockAt(origin.offset(x, y, z));
        if (!block || LIQUIDS.has(block.name)) return false;
      }
    }
  }

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      for (let y = 0; y <= wallHeight + 1; y++) {
        const block = bot.blockAt(origin.offset(x, y, z));
        if (!block || (!BUILD_BLOCKS.has(block.name) && !allowed.has(block.name) && !block.name.endsWith('_bed'))) return false;
      }
    }
  }
  return true;
}

function isPerimeter(x, z, width, depth) {
  return x === 0 || x === width - 1 || z === 0 || z === depth - 1;
}

function makeWindowPositions(origin, width, depth) {
  const positions = windowOffsets({ width, depth }).map(([x, y, z]) => origin.offset(x, y, z));
  return new Set(positions.map(key));
}

function key(position) {
  return `${position.x},${position.y},${position.z}`;
}

function format(position) {
  return `(${position.x}, ${position.y}, ${position.z})`;
}
