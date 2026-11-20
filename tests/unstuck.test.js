import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { localUnstuckPlans, tryLocalUnstuck } from '../src/strategy/unstuck.js';

const require = createRequire(import.meta.url);
const key = (p) => `${p.x},${p.y},${p.z}`;

function terrain(kind = 'dig') {
  const blocks = new Map();
  const registry = require('prismarine-registry')('1.21.6');
  const set = (x, y, z, name) => blocks.set(`${x},${y},${z}`, name);
  if (kind === 'dig') {
    set(1, 64, 0, 'dirt'); set(1, 65, 0, 'stone');
    for (const [x, z] of [[-1, 0], [0, -1], [0, 1]]) for (const y of [62, 63]) set(x, y, z, 'air');
  } else {
    for (const [x, z] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) for (const y of [64, 65]) set(x, y, z, 'glass');
  }
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry, game: { dimension: 'overworld' }, time: { timeOfDay: 1000 }, health: 20, food: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true }, entities: {},
    inventory: { slots: [], items: () => [{ name: 'cobblestone', type: registry.itemsByName.cobblestone.id, count: 8 }] },
    blockAt(p) {
      const name = blocks.get(key(p)) || (p.y < 64 ? 'stone' : 'air');
      return { position: p, name, type: registry.blocksByName[name].id,
        boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block',
        shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}), canHarvest: () => true };
    },
    clearControlStates() {}, stopDigging() {}, equip: async () => {},
    dig: async (block) => { blocks.set(key(block.position), 'air'); },
  });
  bot.pathfinder = {
    setMovements(movements) { this.movements = movements; }, setGoal() {},
    bestHarvestTool: () => ({ type: registry.itemsByName.stone_pickaxe.id }),
    async goto(goal) {
      if (this.movements.allow1by1towers) blocks.set(key(bot.entity.position.floored()), 'cobblestone');
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    },
  };
  const ctx = { bot, state: {}, signal: new AbortController().signal, log() {}, checkpoint: async () => {} };
  return { bot, ctx, set };
}

test('局部脱困打通相邻两格土石并移动，不挖脚下地板', async () => {
  const { bot, ctx } = terrain();
  assert.equal(await tryLocalUnstuck(ctx, { target: new Vec3(10, 64, 0) }), true);
  assert.equal(ctx.state.localRecovery.action, 'dig');
  assert.equal(bot.blockAt(new Vec3(1, 64, 0)).name, 'air');
  assert.equal(bot.blockAt(new Vec3(1, 65, 0)).name, 'air');
  assert.equal(bot.blockAt(new Vec3(0, 63, 0)).name, 'stone');
});

test('两格高台阶可以在脚下只垫一格，玻璃墙保持完整', async () => {
  const { bot, ctx } = terrain('pillar');
  assert.equal(await tryLocalUnstuck(ctx), true);
  assert.equal(ctx.state.localRecovery.action, 'pillar');
  assert.equal(bot.entity.position.y, 65);
  assert.equal(bot.blockAt(new Vec3(0, 64, 0)).name, 'cobblestone');
  assert.equal(bot.blockAt(new Vec3(1, 64, 0)).name, 'glass');
});

test('液体、砂砾、未加载区域和基地保护范围内均不盲挖', () => {
  for (const hazard of ['lava', 'water', 'gravel']) {
    const { bot, ctx, set } = terrain();
    set(2, 65, 0, hazard);
    assert.equal(localUnstuckPlans(bot, ctx.state).some((plan) => plan.kind === 'dig'), false);
  }
  const f = terrain();
  f.ctx.state.home = { x: 1, y: 64, z: 0 };
  assert.equal(localUnstuckPlans(f.bot, f.ctx.state).some((plan) => plan.kind === 'dig'), false);
  const read = f.bot.blockAt.bind(f.bot);
  f.ctx.state.home = null;
  f.bot.blockAt = (p) => p.equals(new Vec3(2, 65, 0)) ? null : read(p);
  assert.equal(localUnstuckPlans(f.bot, f.ctx.state).some((plan) => plan.kind === 'dig'), false);
});

test('头顶空间不足时不垫高，夜间不触发普通脱困施工', async () => {
  const f = terrain('pillar');
  f.set(0, 66, 0, 'stone');
  assert.equal(localUnstuckPlans(f.bot, f.ctx.state).some((plan) => plan.kind === 'pillar'), false);
  const g = terrain();
  g.bot.time.timeOfDay = 15000;
  assert.equal(await tryLocalUnstuck(g.ctx), false);
  assert.equal(g.bot.blockAt(new Vec3(1, 64, 0)).name, 'dirt');
});

test('中断后不会继续挖第二块方块', async () => {
  const { bot, ctx } = terrain();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const dig = bot.dig;
  let cuts = 0;
  bot.dig = async (block) => { cuts++; await dig(block); controller.abort('危险中断'); };
  await assert.rejects(tryLocalUnstuck(ctx));
  assert.equal(cuts, 1);
});

test('没有镐时允许徒手清理可破坏的土石，不要求取得掉落物', async () => {
  const { bot, ctx } = terrain();
  bot.pathfinder.bestHarvestTool = () => null;
  const read = bot.blockAt.bind(bot);
  bot.blockAt = (p) => ({ ...read(p), diggable: true, canHarvest: () => false });
  assert.equal(await tryLocalUnstuck(ctx), true);
  assert.equal(ctx.state.localRecovery.action, 'dig');
});
