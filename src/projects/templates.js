import { Vec3 } from 'vec3';
import { getHouseModel, planHouseShell } from '../building/models.js';
import { listHouseProjects, projectShellPlan } from '../building/projects.js';
import { CROPS, inspectFarm } from '../farming/system.js';
import { insidePasture } from '../autonomy/skills/husbandry.js';

const point = ({ x, y, z }) => new Vec3(x, y, z);

function integer(value, fallback, min, max, label) {
  value ??= fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min}～${max} 的整数`);
  return value;
}

function flag(value) {
  if (value != null && typeof value !== 'boolean') throw new Error('验收选项须为布尔值');
  return value ?? false;
}

function result(done, detail, { waiting = false, progress = 0 } = {}) {
  return { done: Boolean(done), detail, waiting, progress };
}

function blocks(bot, entries, origin) {
  const observed = entries.map(({ offset }) => bot.blockAt(origin.offset(...offset)));
  return { count: entries.length, unknown: observed.filter(block => !block).length,
    matched: observed.filter((block, i) => block && entries[i].acceptedItems.includes(block.name)).length };
}

function verifiedShell(bot, house, finished) {
  const entries = projectShellPlan(house).filter(({ offset }) => !house.verticalAccess
    || house.origin.x + offset[0] !== house.verticalAccess.x || house.origin.z + offset[2] !== house.verticalAccess.z
    || offset[1] !== house.model.size.wallHeight + 1);
  if (finished) for (const entry of entries) entry.acceptedItems = [entry.targetItem];
  return blocks(bot, entries, point(house.origin));
}

function verifiedUpperFloor(bot, house, extension, upperAbove) {
  if (!house.verticalAccess || !extension.parentOrigin) return false;
  const { x, z } = house.verticalAccess;
  const { origin, module } = extension;
  const upperModel = { ...house.model, palette: { ...house.model.palette, floor: house.model.palette.roof } };
  const entries = planHouseShell(upperModel, module.size, { entrance: false, windows: true })
    .filter(entry => entry.offset[1] > 0 && !(upperAbove && origin.x + entry.offset[0] === x && origin.z + entry.offset[2] === z
      && entry.offset[1] === module.size.wallHeight + 1))
    .map(entry => ({ ...entry, acceptedItems: [entry.item] }));
  const shell = blocks(bot, entries, point(origin));
  for (let y = extension.parentOrigin.y + 1; y <= origin.y; y++) {
    if (bot.blockAt(new Vec3(x, y, z))?.name !== 'ladder') return false;
  }
  return shell.matched === shell.count && bot.blockAt(new Vec3(x, origin.y + 1, z))?.boundingBox === 'empty';
}

const house = {
  label: '房屋',
  version: 1,
  input: { type: 'object', description: '默认一层，床和工作台各一。floors 是加建后的总层数。', properties: {
    model: { type: 'string', description: '可施工模型 id，例如 starter、warehouse' },
    mode: { type: 'string', enum: ['build', 'expand'], description: 'expand 为已登记房屋加层' },
    floors: { type: 'integer', minimum: 1, maximum: 3 },
    chests: { type: 'integer', minimum: 1, maximum: 8 },
    furnaces: { type: 'integer', minimum: 1, maximum: 12 },
  }, additionalProperties: false },
  support: ['timber', 'bootstrap', 'tools', 'shelter', 'wool', 'food', 'obtain_item'],
  async options(input) {
    const model = await getHouseModel(input.model ?? 'starter');
    const floors = integer(input.floors, 1, 1, 3, '层数');
    const mode = input.mode ?? 'build';
    if (!['build', 'expand'].includes(mode)) throw new Error('房屋模式须为 build 或 expand');
    return { mode, model: model.id, floors,
      chests: integer(input.chests, model.furniture.chests || 1, 1, Math.min(8, model.size.width - 3 + (floors - 1) * (model.size.width - 3)), '箱子数量'),
      furnaces: integer(input.furnaces, Math.min(model.size.depth - 3, model.furniture.furnaces || 1), 1, model.size.depth - 3, '熔炉数量') };
  },
  targetRequired: true,
  target(state, project) {
    if (project.target) return project.target;
    if (project.options.mode === 'build') return { constructionId: project.id };
    return state.house?.projectId ? { facilityId: state.house.projectId } : undefined;
  },
  targetUnavailable(state, project, target) {
    return project.options.mode === 'expand' && state.house?.projectId !== target.facilityId;
  },
  steps(options) {
    return [
      { id: 'shell', label: '选址、备料和施工主体', skill: 'house', needs: [] },
      { id: 'finish', label: '按蓝图完成门窗屋顶', skill: 'house_finish', needs: ['shell'] },
      ...(options.floors > 1 ? [{ id: 'floors', label: '施工上层与梯井', skill: 'expand_house', needs: ['finish'] }] : []),
      { id: 'facilities', label: '核验床、工作台、熔炉和箱子', skill: 'base',
        needs: ['shell'] },
    ];
  },
  skill(step, _state, project) {
    return step.id === 'shell' && project.options.mode === 'expand' ? 'base' : step.skill;
  },
  async observe(bot, state, project) {
    const saved = (await listHouseProjects(bot)).find(entry => project.options.mode === 'expand'
      ? entry.id === project.target?.facilityId : entry.constructionRequestId === project.id);
    const findings = { shell: result(false, saved ? '工程已选址，主体待核验' : '等待安全选址和备料'),
      finish: result(false, '门窗或屋顶待核验'),
      facilities: result(false, '室内设施待安装或核验'),
      floors: result(false, `上层待核验 0/${project.options.floors - 1}`) };
    if (!saved) return findings;
    const raw = verifiedShell(bot, saved, false);
    const final = verifiedShell(bot, saved, true);
    const key = typeof state.house?.projectId === 'string' && saved.id === state.house.projectId;
    const complete = saved.status === 'complete' && key;
    const origin = point(saved.origin);
    const doorAt = origin.offset(Math.floor(saved.model.size.width / 2), 1, 0);
    const door = [doorAt, doorAt.offset(0, 1, 0)].map(p => bot.blockAt(p));
    const doorSound = door.every(block => block?.name === saved.model.palette.door);
    let supported = 0;
    for (let x = 0; x < saved.model.size.width; x++) for (let z = 0; z < saved.model.size.depth; z++) {
      const below = bot.blockAt(origin.offset(x, -1, z));
      if (below?.boundingBox === 'block' && !['water', 'lava', 'magma_block'].includes(below.name)) supported++;
    }
    const foundation = supported === saved.model.size.width * saved.model.size.depth;
    findings.shell = result(complete && raw.matched === raw.count && doorSound && foundation,
      `主体实测 ${raw.matched}/${raw.count} 格${raw.unknown ? `，${raw.unknown} 格未加载` : ''}${foundation ? '' : '，地基支撑待核验'}`, { progress: raw.matched + supported + 1 });
    findings.finish = result(complete && final.matched === final.count && doorSound, `蓝图材料实测 ${final.matched}/${final.count} 格`, { progress: final.matched });
    const upper = (saved.extensions || []).filter(entry => entry.status === 'complete' && entry.module.direction === 'up');
    const verified = upper.filter(entry => verifiedUpperFloor(bot, saved, entry, upper.some(other => other.parentOrigin?.y === entry.origin.y))).length;
    const upperNeedsRepair = upper.length >= project.options.floors - 1 && verified < upper.length;
    findings.floors = result(verified >= project.options.floors - 1,
      `上层外壳及梯井实测 ${verified}/${project.options.floors - 1}${upperNeedsRepair ? '，已有楼层待加载或修复' : ''}`,
      { progress: verified, waiting: upperNeedsRepair });
    const base = key && state.base?.projectId === saved.id ? state.base : null;
    const positions = Object.values(base?.jobs || {}).filter(job => job.position && job.status === 'done');
    const observed = name => new Set(positions.filter(job => job.item === name && bot.blockAt(point(job.position))?.name === name)
      .map(job => JSON.stringify(job.position))).size;
    const chests = observed('chest');
    const furnaces = observed('furnace');
    const crafting = observed('crafting_table');
    const bedPosition = key && state.home?.bed && point(state.home.bed);
    const bed = bedPosition && bot.blockAt(bedPosition);
    const intactBed = bed?.name.endsWith('_bed') && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) =>
      bot.blockAt(bedPosition.offset(x, 0, z))?.name === bed.name);
    const upperNeededForStorage = project.options.chests > saved.model.size.width - 3 && verified < project.options.floors - 1;
    findings.facilities = result(base?.ready && intactBed && crafting >= 1 && chests >= project.options.chests && furnaces >= project.options.furnaces,
      `床 ${intactBed ? 1 : 0}/1，工作台 ${crafting}/1，箱子 ${chests}/${project.options.chests}，熔炉 ${furnaces}/${project.options.furnaces}${upperNeededForStorage ? '，部分箱位依赖上层' : ''}`,
      { progress: Number(!!intactBed) + crafting + chests + furnaces, waiting: upperNeededForStorage });
    return findings;
  },
};

const farm = {
  label: '农田',
  version: 1,
  input: { type: 'object', description: '已有农田按目标尺寸扩建并保留已有作物。', properties: {
    width: { type: 'integer', minimum: 2, maximum: 15 },
    depth: { type: 'integer', minimum: 2, maximum: 15 },
    crop: { type: 'string', enum: CROPS.map(crop => crop.block) },
    harvest: { type: 'boolean', description: '是否要求新完成至少一轮收割和补种' },
  }, additionalProperties: false },
  support: ['bootstrap', 'tools', 'shelter', 'food', 'obtain_item'],
  async options(input) {
    const crop = input.crop ?? 'wheat';
    if (!CROPS.some(definition => definition.block === crop)) throw new Error('支持 wheat、potatoes、beetroots、carrots');
    const width = integer(input.width, 3, 2, 15, '农田宽度');
    const depth = integer(input.depth, 2, 2, 15, '农田长度');
    return { width, depth, crop, harvest: flag(input.harvest) };
  },
  target(state, project) {
    const target = project.target;
    if (target?.facilityId || target && !state.farm) return target;
    return { facilityId: state.farm?.id, existing: target?.existing ?? Boolean(state.farm), harvests: target?.harvests ?? state.farm?.harvestCycles ?? 0,
      cropHarvests: target?.cropHarvests ?? state.farm?.harvestsByCrop?.[project.options.crop] ?? 0 };
  },
  targetUnavailable(state, _project, target) {
    return Boolean(target?.facilityId && state.farm?.id !== target.facilityId);
  },
  steps(options) {
    return [
      { id: 'layout', label: '选择地块并布置目标面积', skill: 'farm', needs: [] },
      { id: 'plant', label: '核验灌溉和指定作物', skill: 'farm', needs: ['layout'] },
      ...(options.harvest ? [{ id: 'harvest', label: '观察一轮收割和补种', skill: 'farm', needs: ['plant'] }] : []),
    ];
  },
  skill(step, state, project) {
    if (step.id === 'layout' && state.farm && (state.farm.width < project.options.width || state.farm.depth < project.options.depth)) return 'expandFarm';
    return step.skill;
  },
  async observe(bot, state, project) {
    const current = state.farm;
    const { options } = project;
    if (!current || project.target?.facilityId && current.id !== project.target.facilityId) return {
      layout: result(false, '等待安全地块和种植材料'), plant: result(false, '未种植'), harvest: result(false, '未收割'),
    };
    const report = inspectFarm(bot, current);
    const positions = new Set(current.plots.map(entry => String(point(entry.position))));
    const infrastructure = new Set([
      ...current.waters.filter(entry => entry.owned && bot.blockAt(point(entry.position))?.name === 'water').map(entry => String(point(entry.position))),
      ...current.lamps.filter(entry => ['torch', 'wall_torch'].includes(bot.blockAt(point(entry.soil).offset(0, 1, 0))?.name))
        .map(entry => String(point(entry.soil))),
    ]);
    let coverage = 0;
    for (let x = 0; x < options.width; x++) for (let z = 0; z < options.depth; z++) {
      const key = String(point(current.origin).offset(x, 0, z));
      if (positions.has(key) || infrastructure.has(key)) coverage++;
    }
    const size = current.width >= options.width && current.depth >= options.depth;
    const covered = coverage === options.width * options.depth;
    const waters = (current.waters || []).filter(entry => bot.blockAt(point(entry.position))?.name === 'water');
    const irrigated = current.plots.filter(({ position }) => waters.some(({ position: water }) =>
      position.y === water.y && Math.abs(position.x - water.x) <= 4 && Math.abs(position.z - water.z) <= 4)).length;
    const desired = report.crops[options.crop] || 0;
    const meetsCrop = project.target?.existing ? desired > 0 : desired === report.plots;
    const planted = size && covered && report.unknown === 0 && irrigated === report.plots && report.damaged === 0
      && report.plots > 0 && report.planted === report.plots && meetsCrop;
    const baseline = project.target?.harvests ?? 0;
    const harvested = planted && current.harvestCycles > baseline
      && (current.harvestsByCrop?.[options.crop] || 0) > (project.target?.cropHarvests || 0);
    return {
      layout: result(size, `已登记 ${current.width}×${current.depth}，目标至少 ${options.width}×${options.depth}`, { progress: current.width * current.depth }),
      plant: result(planted, `播种 ${report.planted}/${report.plots}，${options.crop} ${report.crops[options.crop] || 0}，灌溉 ${irrigated}/${report.plots}，占地 ${coverage}/${options.width * options.depth}，未加载 ${report.unknown}`, { progress: report.planted + irrigated + (report.crops[options.crop] || 0) }),
      harvest: result(harvested, `新增收割 ${Math.max(0, current.harvestCycles - baseline)} 轮，指定作物收割与补种待核验`,
        { waiting: planted && !current.harvestSession && report.matureRatio < (state.farmConfig?.harvestRatio ?? bot.farmOptions?.harvestRatio ?? .9),
          progress: Math.max(0, current.harvestCycles - baseline) }),
    };
  },
};

export const projectTemplates = { house, farm };
