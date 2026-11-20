import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { reachHome, leaveHome } from '../src/strategy/navigation.js';
import { hideUntilMorning } from '../src/autonomy/skills/sleep.js';
import { reachBuildingSite } from '../src/autonomy/skills/build.js';
import { goTo } from '../src/actions/helpers.js';
import pathfinderPkg from 'mineflayer-pathfinder';

const require = createRequire(import.meta.url);

test('建设取料回到关门住所后，先开门出家再恢复施工移动并回到工地', async () => {
  const { bot, home, profiles } = routeBot(1000);
  bot.entity.position = new Vec3(10.5, 70, -7.5);
  const visited = [];
  bot.pathfinder.goto = async (goal) => {
    visited.push({ goal, canDig: bot.pathfinder.movements.canDig });
    bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
  };
  await reachBuildingSite({ bot, state: { home, pastures: [] }, signal: new AbortController().signal }, new Vec3(0, 71, 29), { width: 7 });
  assert.ok(visited.some(({ goal, canDig }) => goal.x === 9 && !canDig));
  assert.equal(bot.blockAt(new Vec3(8, 70, -8)).getProperties().open, false);
  assert.equal(visited.at(-1).canDig, true);
  assert.equal(visited.at(-1).goal.z, 28);
  assert.ok(bot.entity.position.distanceTo(new Vec3(3, 72, 28)) < 1);
  assert.equal(profiles.length, 0);
});

function routeBot(timeOfDay) {
  const bot = new EventEmitter();
  let open = false;
  const profiles = [];
  Object.assign(bot, {
    registry: require('prismarine-registry')('1.21.6'),
    entity: { position: new Vec3(0.5, 64, -8.5), onGround: false },
    game: { dimension: 'overworld' }, time: { timeOfDay }, health: 20, food: 20,
    inventory: { slots: [], items: () => [] }, entities: {},
    blockAt(p) {
      const door = p.x === 8 && p.z === -8 && [70, 71].includes(p.y);
      const solid = p.y < 70 || door;
      return { position: p, name: door ? 'oak_door' : solid ? 'stone' : 'air',
        boundingBox: solid ? 'block' : 'empty', getProperties: () => ({ open }) };
    },
    activateBlock: async () => { open = !open; },
    lookAt: async (p) => { bot.lookTarget = p; },
    setControlState(name, enabled) {
      if (name === 'forward' && enabled) bot.entity.position = new Vec3(bot.lookTarget.x, 70, bot.lookTarget.z);
    },
    clearControlStates() {}, stopDigging() {},
  });
  bot.pathfinder = {
    setMovements(movements) { this.movements = movements; }, setGoal() {},
    async goto(goal) {
      profiles.push(this.movements.canDig);
      if (profiles.length === 1) throw new Error('原有步行路线不可达');
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    },
  };
  const home = { kind: 'cave', x: 10, y: 70, z: -8, dimension: 'overworld', door: { x: 8, y: 70, z: -8 } };
  return { bot, profiles, home };
}

test('白天步行返家失败后可施工回到洞口，并恢复安全移动', async () => {
  const { bot, profiles, home } = routeBot(1000);
  await reachHome({ bot, state: {}, signal: new AbortController().signal, log() {} }, home);
  assert.deepEqual(profiles.slice(0, 2), [false, true]);
  assert.equal(bot.pathfinder.movements.canDig, false);
  assert.ok(bot.entity.position.distanceTo(new Vec3(home.x, home.y, home.z)) < 1.8);
});

test('夜间返家失败时不进入施工模式', async () => {
  const { bot, profiles, home } = routeBot(15000);
  await assert.rejects(reachHome({ bot, state: {}, signal: new AbortController().signal, log() {} }, home), /不可达/);
  assert.deepEqual(profiles, [false]);
});

test('同一站位重复两次返家失败后，先走安全落脚点再从原门进入', async () => {
  const { bot, home } = routeBot(1000);
  const state = {};
  const visited = [];
  const messages = [];
  let alternateVisited = false;
  bot.pathfinder.goto = async goal => {
    visited.push({ x: goal.x, z: goal.z, canDig: bot.pathfinder.movements.canDig });
    if (goal.x === 6) alternateVisited = true;
    if (!alternateVisited) throw new Error('原入口站位不可达');
    bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
  };
  const ctx = { bot, state, signal: new AbortController().signal, log: message => messages.push(message) };
  await assert.rejects(reachHome(ctx, home), /原入口站位不可达/);
  assert.equal(state.homeApproachFailure.repeats, 1);
  await assert.rejects(reachHome(ctx, home), /原入口站位不可达/);
  assert.equal(state.homeApproachFailure.repeats, 2);
  const previousAttempts = visited.length;
  assert.equal(await reachHome(ctx, home), true);
  assert.deepEqual(visited.slice(previousAttempts, previousAttempts + 2).map(({ x, canDig }) => [x, canDig]),
    [[6, false], [7, false]]);
  assert.equal(state.homeApproachFailure, undefined);
  assert.match(messages.at(-1), /已到入口/);
});

test('泥土封顶变为草方块时，确认井道后可拆顶并限制垫脚范围', async () => {
  const { bot, home } = routeBot(1000);
  bot.entity.position = new Vec3(7.5, 67, -7.5);
  bot.entity.onGround = true;
  bot.inventory.items = () => [{ name: 'dirt', count: 2 }];
  let covered = true;
  let blockedExit = true;
  const cap = new Vec3(7, 69, -8);
  const read = bot.blockAt.bind(bot);
  bot.blockAt = (p) => {
    if (p.equals(cap)) return { position: p, name: covered ? 'grass_block' : 'air', boundingBox: covered ? 'block' : 'empty' };
    if (blockedExit && p.equals(cap.offset(0, 2, 0))) return { position: p, name: 'water', boundingBox: 'empty' };
    if (p.x === 7 && p.z === -8 && p.y >= 67) return { position: p, name: 'air', boundingBox: 'empty' };
    return read(p);
  };
  bot.pathfinder.bestHarvestTool = () => null;
  bot.dig = async (block) => { assert.ok(block.position.equals(cap)); covered = false; };
  bot.pathfinder.goto = async (goal) => {
    assert.equal(covered, false);
    assert.equal(bot.pathfinder.movements.canDig, false);
    assert.ok(goal.isEnd(new Vec3(6, 70, -8)));
    assert.equal(goal.isEnd(new Vec3(7, 70, -8)), false);
    bot.entity.position = new Vec3(6.5, 70, -7.5);
  };
  const state = { home, emergencyShelter: { kind: 'pit', surface: { x: 7, y: 70, z: -8 }, dimension: 'overworld', depth: 3,
    placedBlocks: [{ x: 7, y: 69, z: -8, name: 'dirt' }] } };
  const ctx = { bot, state, signal: new AbortController().signal, log() {}, checkpoint: async () => {} };
  await assert.rejects(hideUntilMorning(ctx), /井口净空不足/);
  assert.equal(covered, true);
  blockedExit = false;
  await hideUntilMorning(ctx);
  assert.equal(state.emergencyShelter, undefined);
  assert.equal(bot.entity.position.y, 70);
});

test('已经站在门外时不必重新穿过门内再出门', async () => {
  const { bot, home, profiles } = routeBot(1000);
  bot.entity.position = new Vec3(7.5, 70, -7.5);
  await leaveHome({ bot, state: {}, signal: new AbortController().signal }, home);
  assert.equal(profiles.length, 0);
});

test('已经在山洞安全站位时直接确认返家，避免为精确中心反复寻路', async () => {
  const { bot, home, profiles } = routeBot(15000);
  bot.entity.position = new Vec3(10.5, 70, -8.6);
  assert.equal(await reachHome({ bot, state: {}, signal: new AbortController().signal }, home), true);
  assert.equal(profiles.length, 0);
});

test('房屋角落也是室内，不因远离家庭坐标而绕去关门的屋外', async () => {
  const { bot, profiles } = routeBot(15000);
  const home = { kind: 'house', x: 10, y: 70, z: -6, dimension: 'overworld',
    projectId: 'house', door: { x: 8, y: 70, z: -8 } };
  const state = { home, house: { projectId: 'house' }, buildingRooms: { house: [
    { origin: { x: 7, y: 69, z: -9 }, size: { width: 7, depth: 7, wallHeight: 3 } },
  ] } };
  bot.entity.position = new Vec3(11.5, 70, -4.5);
  assert.ok(bot.entity.position.distanceTo(new Vec3(home.x, home.y, home.z)) > 1.5);
  assert.equal(await reachHome({ bot, state, signal: new AbortController().signal }, home), true);
  assert.equal(profiles.length, 0);
});

test('房屋外面不能仅因同高度而被识别为已返家', async () => {
  const { bot, profiles } = routeBot(15000);
  const home = { kind: 'house', x: 10, y: 70, z: -6, dimension: 'overworld',
    projectId: 'house', door: { x: 8, y: 70, z: -8 } };
  bot.entity.position = new Vec3(6.5, 70, -4.5);
  const state = { home, buildingRooms: { house: [
    { origin: { x: 7, y: 69, z: -9 }, size: { width: 7, depth: 7, wallHeight: 3 } },
  ] } };
  await assert.rejects(reachHome({ bot, state, signal: new AbortController().signal }, home), /不可达/);
  assert.equal(profiles.length, 1);
});

test('已经进入容器交互范围时直接到位，不再启动会失败的寻路', async () => {
  const { bot, profiles } = routeBot(1000);
  bot.entity.position = new Vec3(10.5, 70, -8.5);
  await goTo(bot, new pathfinderPkg.goals.GoalNear(9, 70, -9, 2), { signal: new AbortController().signal });
  assert.equal(profiles.length, 0);
});

test('搬家后从归档山洞前往新房时，先开旧门出洞', async () => {
  const { bot, home } = routeBot(1000);
  bot.entity.position = new Vec3(10.5, 70, -7.5);
  const visited = [];
  bot.pathfinder.goto = async (goal) => {
    visited.push(goal);
    bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
  };
  const destination = { x: 0, y: 70, z: 29, dimension: 'overworld' };
  const state = { home: destination, archivedStorage: [{ home }], pastures: [] };
  assert.equal(await reachHome({ bot, state, signal: new AbortController().signal }, destination), true);
  assert.ok(visited.some((goal) => goal.x === 9));
  assert.equal(bot.blockAt(new Vec3(8, 70, -8)).getProperties().open, false);
  assert.equal(visited.at(-1).z, 29);
});


test('死亡后无门无工作台仍能白天离家找食物，夜间继续检查外出条件', async () => {
  const { bot, home } = routeBot(1000);
  const read = bot.blockAt.bind(bot);
  bot.blockAt = p => {
    const block = read(p);
    return block.name === 'oak_door' ? { ...block, name: 'air', boundingBox: 'empty' } : block;
  };
  bot.entity.position = new Vec3(10.5, 70, -7.5);
  bot.strategySupervisor = { active: true, state: {} };
  const visited = [];
  bot.pathfinder.goto = async goal => {
    visited.push(goal);
    bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
  };
  const ctx = { bot, state: { home }, signal: new AbortController().signal,
    obtain: async () => assert.fail('出门获取补给不应先要求制作工作台或木门') };
  await leaveHome(ctx, home);
  assert.equal(visited.at(-1).x, 7);
  bot.entity.position = new Vec3(10.5, 70, -7.5);
  bot.time.timeOfDay = 15000;
  await assert.rejects(leaveHome(ctx, home), /避难时段/);
});
