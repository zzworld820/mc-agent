import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { taskBudget } from '../src/supplies/profiles.js';
import { assessSupplies, shouldPauseForSupplies, foodReservations } from '../src/supplies/assessment.js';
import { replenishFood } from '../src/supplies/planner.js';
import { developmentTask } from '../src/strategy/development.js';
import { nextGoal } from '../src/strategy/index.js';
import { getHouseModel, planHouseShell } from '../src/building/models.js';
import { createHouseProject, projectShellPlan } from '../src/building/projects.js';
import { ensureFood } from '../src/autonomy/skills/food.js';
import { moveToBuildPosition } from '../src/autonomy/skills/build.js';

const registry = createRequire(import.meta.url)('prismarine-registry')('1.21.6');
function fixture() {
  const items = ['wooden_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'cooked_chicken']
    .map((name) => ({ name, count: 1 }));
  const bot = { health: 19, food: 18, registry, entity: { position: new Vec3(0, 70, 0) }, entities: {},
    game: { dimension: 'overworld' }, time: { timeOfDay: 1000 }, inventory: { items: () => items, slots: [] },
    blockAt(p) { return { name: p.y < 70 ? 'stone' : 'air', boundingBox: p.y < 70 ? 'block' : 'empty' }; } };
  const state = { home: { x: 0, y: 70, z: 0, dimension: 'overworld', campReady: true },
    storage: { earlyCamp: true, status: 'ready', lastStoredAt: Date.now(), chests: [] },
    pastures: [], reservedItems: new Set(), supplies: {}, failures: { food: { attempts: 52 } }, development: {} };
  return { bot, state, items };
}

test('身体稳定、六点口粮的起步营地继续建房', () => {
  const { bot, state } = fixture();
  assert.equal(nextGoal(bot, state), 'house');
  state.supplies.activeTask = developmentTask('house', state);
  assert.equal(shouldPauseForSupplies(bot, state, 'house'), false);
});

test('附近起步建设可以消耗现有口粮，饥饿后立即恢复补给要求', () => {
  const { bot, state, items } = fixture();
  items.pop();
  const task = developmentTask('house', state);
  state.supplies.activeTask = task;
  assert.equal(assessSupplies(bot, state, task).interrupt, false);
  assert.equal(nextGoal(bot, state), 'house');
  bot.food = 15;
  assert.equal(nextGoal(bot, state), 'food');
  assert.equal(shouldPauseForSupplies(bot, state, 'house'), true);
});

test('离家、受伤、跨维度及矿业任务保留常规口粮预算', () => {
  for (const change of ['distance', 'health', 'dimension', 'mining', 'established']) {
    const { bot, state } = fixture();
    if (change === 'distance') bot.entity.position.x = 65;
    if (change === 'health') bot.health = 13;
    if (change === 'dimension') bot.game.dimension = 'the_nether';
    if (change === 'established') state.farm = { harvestCycles: 1 };
    const budget = taskBudget(bot, developmentTask(change === 'mining' ? 'protection' : 'house', state));
    assert.equal(budget.localConstruction, false, change);
    assert.ok(budget.foodMinimum >= 8, change);
    if (change === 'mining') assert.equal(budget.foodTarget, 40);
  }
});

test('健康条件变化后即使必要工作也会被补给监控打断', () => {
  const { bot, state, items } = fixture();
  items.pop();
  state.supplies.activeTask = developmentTask('base', state);
  bot.food = 15;
  assert.equal(shouldPauseForSupplies(bot, state, 'base', true), true);
});

test('起步补给身体稳定即可返回建设，仓储仍为随身食物保留空间', async () => {
  const { bot, state } = fixture();
  await replenishFood({ bot, state, signal: new AbortController().signal }, developmentTask('house', state));
  assert.equal(state.supplies.retryAt, 0);
  assert.equal(foodReservations(bot, state, developmentTask('house', state)).cooked_chicken, 1);
});

test('临时石制外壳可封闭全部窗位，原模型和扩建信息保持可读取', async () => {
  const model = await getHouseModel('starter');
  const project = createHouseProject({ buildingServer: 'test', game: { dimension: 'overworld' } }, model, new Vec3(0, 70, 0));
  project.construction = { palette: { roof: 'cobblestone', window: 'cobblestone' }, finishingPending: true };
  const plan = projectShellPlan(JSON.parse(JSON.stringify(project)));
  assert.equal(plan.filter((entry) => entry.item === 'cobblestone').length, 168);
  assert.equal(plan.filter((entry) => entry.item === 'glass').length, 0);
  assert.equal(plan.filter((entry) => entry.targetItem === 'glass').length, 6);
  assert.equal(plan.filter((entry) => entry.targetItem === 'oak_planks').length, 49);
  assert.ok(plan.filter((entry) => entry.targetItem === 'glass').every((entry) => entry.acceptedItems.includes('glass')));
  assert.equal(project.model.palette.roof, 'oak_planks');
  assert.ok(project.model.expansions.length);
});

test('旧工程缺少分阶段施工元数据时按原模型续建', async () => {
  const model = await getHouseModel('starter');
  const plan = projectShellPlan({ model });
  assert.deepEqual(plan.map(({ acceptedItems, targetItem, ...entry }) => entry), planHouseShell(model, model.size));
});

test('保存的不可达动物来源在冷却期内被跳过', async () => {
  const { bot, state, items } = fixture();
  items.pop();
  const animal = { name: 'chicken', uuid: 'unreachable-chicken', position: new Vec3(10, 70, 0) };
  state.supplies.huntFailures = { [animal.uuid]: { retryAt: Date.now() + 300000, reason: '路线不可达' } };
  bot.pathfinder = { setMovements(value) { this.movements = value; } };
  let selected = false;
  bot.nearestEntity = (predicate) => {
    selected = predicate(animal);
    return selected ? animal : null;
  };
  await assert.rejects(ensureFood({ bot, state, signal: new AbortController().signal, log() {} }, 16, { maxExplore: 0 }), /本轮找食物/);
  assert.equal(selected, false);
});

test('能从室内地板够到屋顶时直接施工，避免为封顶强求爬墙', async () => {
  const { bot, state } = fixture();
  bot.entity.position = new Vec3(3.5, 72, 30.5);
  await moveToBuildPosition({ bot, state, signal: new AbortController().signal }, new Vec3(0, 75, 29), new Vec3(0, 74, 29));
});
