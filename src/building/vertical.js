import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { digWithTimeout, goTo, sleep, throwIfAborted, useMovementProfile } from '../actions/helpers.js';
import { placeBlockAt, furnishHouse } from '../autonomy/skills/build.js';
import { planHouseShell } from './models.js';
import { saveHouseProject } from './projects.js';
import { reachHome } from '../strategy/navigation.js';

const { goals } = pathfinderPkg;
const point = (p) => new Vec3(p.x, p.y, p.z);
const plain = (p) => ({ x: p.x, y: p.y, z: p.z });
const AIR = new Set(['air', 'cave_air']);
const ROCK = new Set(['stone', 'deepslate', 'dirt', 'grass_block', 'granite', 'diorite', 'andesite', 'tuff', 'clay']);

export function validateRoom(bot, project, extension, shaft) {
  const { width, depth, wallHeight } = extension.module.size;
  const origin = point(extension.origin);
  const min = bot.game.minY ?? -64;
  const max = min + (bot.game.height ?? 384);
  if (origin.y - 1 < min || origin.y + wallHeight + 2 >= max) throw new Error('扩建超出世界高度范围');
  const down = extension.module.direction === 'down';
  const palette = new Set(Object.values(project.model.palette));
  for (let x = -1; x <= width; x++) for (let z = -1; z <= depth; z++) for (let y = -1; y <= wallHeight + 1; y++) {
    const p = origin.offset(x, y, z);
    const block = bot.blockAt(p);
    if (!block || ['water', 'lava', 'sand', 'red_sand', 'gravel', 'fire', 'magma_block'].includes(block.name)) throw new Error('垂直扩建范围未加载，或存在液体、落沙及危险方块');
    const inside = x >= 0 && x < width && z >= 0 && z < depth;
    if (down) {
      if (!inside && y === wallHeight + 1 && AIR.has(block.name)) continue;
      const interior = x > 0 && x < width - 1 && z > 0 && z < depth - 1 && y > 0 && y <= wallHeight;
      const shaftCell = p.x === shaft.x && p.z === shaft.z && y === wallHeight + 1;
      if (ROCK.has(block.name) || inside && palette.has(block.name) && block.boundingBox === 'block') continue;
      if (shaftCell && project.verticalAccess && (AIR.has(block.name) || block.name === 'ladder')) continue;
      if (extension.started && interior && (AIR.has(block.name) || ['ladder', 'torch', 'chest', 'furnace', 'crafting_table'].includes(block.name) || block.name.endsWith('_bed'))) continue;
      throw new Error('地下室外围有空洞或非天然结构，不开挖、不灌浆猜测修复');
    }
    if (!inside) continue;
    if (y === 0) {
      if (block.boundingBox !== 'block' && !(extension.started && p.x === shaft.x && p.z === shaft.z && ['ladder', 'air'].includes(block.name))) throw new Error('上层楼面不完整，不能悬空加层');
    } else if (y > 0 && !AIR.has(block.name) && !(extension.started && (palette.has(block.name) || ['ladder', 'chest', 'furnace', 'torch', 'crafting_table'].includes(block.name) || block.name.endsWith('_bed')))) {
      throw new Error('楼顶上方已有建筑或其他占用');
    }
  }
  // 底层围墙必须连续承接楼面；不是只找到一块漂浮木板就算有地基。
  if (!down) for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) {
    if (x !== 0 && x !== width - 1 && z !== 0 && z !== depth - 1) continue;
    if (bot.blockAt(origin.offset(x, -1, z))?.boundingBox !== 'block') throw new Error('下层承接墙不完整');
  }
}

async function digOwn(ctx, p, allowed) {
  throwIfAborted(ctx.signal);
  const block = ctx.bot.blockAt(p);
  if (AIR.has(block?.name) || block?.name === 'ladder') return;
  if (!block || !allowed.has(block.name)) throw new Error('梯井或地下室出现未知占用，不继续拆除');
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const neighbor = ctx.bot.blockAt(p.offset(...d));
    if (!neighbor || ['water', 'lava', 'sand', 'gravel', 'red_sand'].includes(neighbor.name)) throw new Error('开挖邻面出现液体或落沙风险');
  }
  await goTo(ctx.bot, new goals.GoalLookAtBlock(p, ctx.bot.world, { reach: 4.5 }), { signal: ctx.signal, timeoutMs: 25000 });
  const tool = ctx.bot.pathfinder.bestHarvestTool(block);
  if (tool) await ctx.bot.equip(tool, 'hand');
  const abort = () => ctx.bot.stopDigging();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try { await digWithTimeout(ctx.bot, block, ctx.bot.digTime(block) + 15000); }
  finally { ctx.signal.removeEventListener('abort', abort); }
}

async function ladder(ctx, shaft, y) {
  const p = new Vec3(shaft.x, y, shaft.z);
  if (ctx.bot.blockAt(p)?.name === 'ladder') return;
  const support = p.offset(0, 0, -1);
  if (ctx.bot.blockAt(support)?.boundingBox !== 'block') throw new Error('梯井承接墙缺失');
  if (!AIR.has(ctx.bot.blockAt(p)?.name)) throw new Error('梯井有障碍');
  await ctx.bot.equip(ctx.bot.inventory.items().find((item) => item.name === 'ladder'), 'hand');
  await ctx.bot.placeBlock(ctx.bot.blockAt(support), new Vec3(0, 0, 1));
  await sleep(150, ctx.signal);
  if (ctx.bot.blockAt(p)?.name !== 'ladder') throw new Error('梯子安装未确认');
}

export async function expandVertical(ctx, project, { direction, moduleId }) {
  const model = project.model;
  const existing = project.extensions.find((entry) => entry.status === 'building');
  const declared = model.expansions.find((entry) => entry.direction === direction && (!moduleId || entry.id === moduleId));
  if (moduleId && !declared && existing?.module.id !== moduleId) throw new Error('没有匹配的垂直模型模块');
  const module = existing?.module || declared || { id: `rectangular-${direction}`, name: direction === 'up' ? '加建楼层' : '地下储藏层',
    description: '继承原屋矩形占地和材料，以独立梯井连接，不拆原主体。', direction, repeatable: true,
    size: { ...model.size }, furniture: { chests: model.furniture.chests, furnaces: 0, beds: 0, craftingTables: 0 } };
  if (!existing && !module.repeatable && project.extensions.some((entry) => entry.module.id === module.id)) throw new Error('该模块不能重复扩建');
  const parent = project.extensions.filter((entry) => entry.status === 'complete' && entry.module.direction === direction).at(-1);
  const parentOrigin = point(parent?.origin || project.origin);
  const height = module.size.wallHeight + 1;
  const origin = existing ? point(existing.origin) : parentOrigin.offset(0, direction === 'up' ? height : -height, 0);
  const homeOrigin = point(project.origin);
  ctx.state.home ??= { x: homeOrigin.x + Math.floor(model.size.width / 2), y: homeOrigin.y + 1, z: homeOrigin.z + 2,
    dimension: String(ctx.bot.game.dimension), door: plain(homeOrigin.offset(Math.floor(model.size.width / 2), 1, 0)) };
  const shaft = project.verticalAccess || { x: project.origin.x + 2, z: project.origin.z + 1 };
  const extension = existing || { module: structuredClone(module), origin: plain(origin), parentOrigin: plain(parentOrigin), status: 'building', started: false };
  validateRoom(ctx.bot, project, extension, shaft);
  if (!existing) project.extensions.push(extension);
  project.verticalAccess = shaft;
  await saveHouseProject(project, ctx.bot.memory);
  if (ctx.state.house?.projectId === project.id) {
    ctx.state.house.rooms = [{ origin: project.origin, size: model.size }, ...project.extensions.map((entry) => ({ origin: entry.origin, size: entry.module.size }))];
    await ctx.checkpoint?.();
  }
  const verticalModel = { ...model, palette: { ...model.palette,
    floor: direction === 'up' ? model.palette.roof : model.palette.floor,
    roof: direction === 'down' ? model.palette.floor : model.palette.roof } };
  const plan = planHouseShell(verticalModel, module.size, { entrance: false, windows: direction === 'up' })
    .filter((entry) => !(direction === 'up' && entry.offset[1] === 0 || direction === 'down' && entry.offset[1] === height));
  const counts = {};
  for (const entry of plan) {
    if (ctx.bot.blockAt(origin.offset(...entry.offset))?.name !== entry.item) counts[entry.item] = (counts[entry.item] || 0) + 1;
  }
  for (const [item, count] of Object.entries(counts)) await ctx.obtain(item, count);
  await ctx.obtain('ladder', height + 2);
  await ctx.obtain('torch', 4);
  await ctx.obtain('stone_pickaxe', 1);
  for (const [item, count] of [['chest', module.furniture.chests], ['furnace', module.furniture.furnaces], ['crafting_table', module.furniture.craftingTables]]) {
    if (count > 0) await ctx.obtain(item, count);
  }
  await reachHome(ctx, ctx.state.home);
  useMovementProfile(ctx.bot, 'safe');
  validateRoom(ctx.bot, project, extension, shaft);
  extension.started = true;
  await saveHouseProject(project, ctx.bot.memory);
  const bottom = direction === 'up' ? parentOrigin.y + 1 : origin.y + 1;
  const top = direction === 'up' ? origin.y : parentOrigin.y;
  const removable = new Set([...ROCK, ...Object.values(model.palette), 'torch']);
  // 从上面开地下梯井时逐格下降，侧面有天然墙支持梯子，不一次挖穿整条竖井。
  const levels = Array.from({ length: top - bottom + 1 }, (_, i) => bottom + i);
  if (direction === 'down') levels.reverse();
  for (const y of levels) {
    await digOwn(ctx, new Vec3(shaft.x, y, shaft.z), removable);
    await ladder(ctx, shaft, y);
    if (direction === 'up' && y + 1 === origin.y) await digOwn(ctx, new Vec3(shaft.x, y + 1, shaft.z), removable);
    await goTo(ctx.bot, new goals.GoalBlock(shaft.x, y, shaft.z), { signal: ctx.signal, timeoutMs: 20000 });
  }
  if (direction === 'down') {
    // 保留外圈天然承重墙，先挖内部，从高到低，顶板不挖。
    for (let z = 1; z < module.size.depth - 1; z++) for (let x = 1; x < module.size.width - 1; x++) for (let y = module.size.wallHeight; y >= 1; y--) {
      if (origin.x + x === shaft.x && origin.z + z === shaft.z) continue;
      await digOwn(ctx, origin.offset(x, y, z), ROCK);
    }
  } else {
    // 顶层梯口旁的原屋顶就是安全站台；不在梯口脚下重新铺楼板。
    await goTo(ctx.bot, new goals.GoalBlock(shaft.x + 1, origin.y + 1, shaft.z), { signal: ctx.signal, timeoutMs: 25000 });
  }
  for (const entry of plan) {
    const p = origin.offset(...entry.offset);
    if (p.x === shaft.x && p.z === shaft.z && entry.offset[1] === 0) continue;
    if (direction === 'down') {
      // 地下室只开内部，不替换仍完整的天然外墙和地面。
      if (ctx.bot.blockAt(p)?.boundingBox === 'block') continue;
    }
    await placeBlockAt(ctx, p, entry.item);
  }
  await furnishHouse(ctx, origin, module.size, { extension: true, reserved: [shaft], furniture: module.furniture });
  throwIfAborted(ctx.signal);
  extension.status = 'complete';
  await saveHouseProject(project, ctx.bot.memory);
  if (ctx.state.house?.projectId === project.id) {
    ctx.state.house.rooms = [{ origin: project.origin, size: model.size }, ...project.extensions.map((entry) => ({ origin: entry.origin, size: entry.module.size }))];
    await ctx.checkpoint?.();
  }
  return `原主体保留，${module.name}已施工，使用梯井连接；施工完成不等同于实服验收`;
}
