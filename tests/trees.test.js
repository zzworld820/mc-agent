import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { inspectWholeTree, harvestWholeTree } from '../src/autonomy/skills/trees.js';

function forest() {
  const blocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const set = (x, y, z, name) => blocks.set(`${x},${y},${z}`, name);
  for (let y = 1; y <= 4; y++) set(0, y, 0, 'oak_log');
  set(0, 0, 0, 'dirt');
  set(1, 4, 0, 'oak_log');
  set(2, 4, 0, 'oak_leaves');
  let held = 0;
  const bot = {
    game: { dimension: 'overworld' }, time: { timeOfDay: 1000 }, health: 20, food: 20,
    entity: { position: new Vec3(0, 1, -3) },
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: { oak_log: { stackSize: 64 } } },
    world: {}, inventory: { emptySlotCount: () => 1, items: () => held ? [{ name: 'oak_log', count: held }] : [] },
    blockAt(p) {
      const name = blocks.get(key(p)) || 'air';
      return { name, position: p, getProperties: () => ({ persistent: false }) };
    },
    findBlocks: () => [new Vec3(0, 1, 0)],
    pathfinder: { movements: {}, getPathTo: () => ({ status: 'success', path: [{ y: 1 }] }),
      *getPathFromTo() { yield { result: this.getPathTo() }; } },
  };
  const ctx = { bot, state: {}, signal: new AbortController().signal, log() {}, checkpoint: async () => {} };
  const dig = async (block) => { blocks.delete(key(block.position)); held++; };
  return { bot, ctx, set, dig, blocks };
}

test('整树识别包括斜向连接的枝条', () => {
  const f = forest();
  assert.equal(inspectWholeTree(f.bot, new Vec3(0, 1, 0)).logs.length, 5);
});

test('树体未加载、建筑相邻、两树相接时均拒绝开砍', () => {
  const f = forest();
  const read = f.bot.blockAt.bind(f.bot);
  f.bot.blockAt = (p) => p.x === -1 ? null : read(p);
  assert.throws(() => inspectWholeTree(f.bot, new Vec3(0, 1, 0)), /尚未加载/);
  f.bot.blockAt = read;
  f.set(1, 1, 0, 'oak_planks');
  assert.throws(() => inspectWholeTree(f.bot, new Vec3(0, 1, 0)), /建筑/);
  f.set(1, 1, 0, 'air');
  for (let y = 1; y <= 4; y++) f.set(2, y, 0, 'oak_log');
  f.set(2, 0, 0, 'dirt');
  f.set(3, 4, 0, 'oak_leaves');
  assert.throws(() => inspectWholeTree(f.bot, new Vec3(0, 1, 0)), /多棵树/);
});

test('背包容量、天色或枝条路线不足时一块也不砍', async () => {
  for (const kind of ['capacity', 'night', 'route']) {
    const f = forest();
    if (kind === 'capacity') f.bot.inventory.emptySlotCount = () => 0;
    if (kind === 'night') f.bot.time.timeOfDay = 9900;
    if (kind === 'route') f.bot.pathfinder.getPathTo = () => ({ status: 'noPath', path: [] });
    await assert.rejects(harvestWholeTree(f.ctx, ['oak_log'], { dig: f.dig, pickUp: async () => {} }));
    assert.equal(f.bot.blockAt(new Vec3(0, 4, 0)).name, 'oak_log');
    assert.equal(f.ctx.state.wholeTree, undefined);
  }
});

test('整树执行收完所有枝干，采集超出配额仍完成当前树', async () => {
  const f = forest();
  let dug = 0;
  await harvestWholeTree(f.ctx, ['oak_log'], { dig: f.dig, pickUp: async () => {}, onDug: async () => { dug++; } });
  assert.equal(dug, 5);
  assert.equal(f.ctx.state.wholeTree, undefined);
  assert.equal([...f.blocks.values()].filter((name) => name === 'oak_log').length, 0);
});

test('危险中断后保存完整树体，树叶消失后仍能继续原树', async () => {
  const f = forest();
  let cuts = 0;
  await assert.rejects(harvestWholeTree(f.ctx, ['oak_log'], {
    dig: async (block) => { if (++cuts === 3) throw new Error('危险中断'); await f.dig(block); }, pickUp: async () => {},
  }), /危险中断/);
  const saved = JSON.parse(JSON.stringify(f.ctx.state));
  assert.ok(saved.wholeTree.started);
  f.ctx.state = saved;
  f.set(2, 4, 0, 'air');
  await harvestWholeTree(f.ctx, ['oak_log'], { dig: f.dig, pickUp: async () => {} });
  assert.equal(f.ctx.state.wholeTree, undefined);
  assert.equal([...f.blocks.values()].filter((name) => name === 'oak_log').length, 0);
});

test('数量已够时白天优先续砍原树，夜间仍先避难', async () => {
  const { nextGoal } = await import('../src/strategy/index.js');
  const f = forest();
  f.bot.entity = { position: new Vec3(0, 1, -3) };
  f.bot.entities = {};
  f.bot.registry.foodsByName = { bread: { foodPoints: 5 } };
  f.bot.inventory.slots = [];
  f.bot.inventory.items = () => [{ name: 'bread', count: 4 }, { name: 'oak_log', count: 64 }];
  f.ctx.state.wholeTree = inspectWholeTree(f.bot, new Vec3(0, 1, 0));
  f.ctx.state.pastures = [];
  assert.equal(nextGoal(f.bot, f.ctx.state), 'finish_tree');
  f.bot.time.timeOfDay = 15000;
  assert.equal(nextGoal(f.bot, f.ctx.state), 'night');
});

test('整树预检等待分段搜索完成，并允许途中翻过山坡后从低处砍树', async () => {
  const f = forest();
  let searches = 0;
  f.bot.pathfinder.getPathFromTo = function* (movements, position, goal, options) {
    assert.equal(typeof options.timeout, 'number');
    searches++;
    yield { result: { status: 'partial', path: [] } };
    yield { result: { status: 'success', path: [{ y: 4 }, { y: 1 }] } };
  };
  await harvestWholeTree(f.ctx, ['oak_log'], { dig: f.dig, pickUp: async () => {} });
  assert.ok(searches >= 5);
  assert.equal([...f.blocks.values()].filter((name) => name === 'oak_log').length, 0);
});

test('首次开砍前复查失败时释放尚未动过的树，允许重新选择', async () => {
  const f = forest();
  let searches = 0;
  f.bot.pathfinder.getPathFromTo = function* () {
    yield { result: ++searches <= 5 ? { status: 'success', path: [{ y: 1 }] } : { status: 'noPath', path: [] } };
  };
  await assert.rejects(harvestWholeTree(f.ctx, ['oak_log'], { dig: f.dig, pickUp: async () => {} }), /无法安全走到/);
  assert.equal(f.ctx.state.wholeTree, undefined);
  assert.equal([...f.blocks.values()].filter((name) => name === 'oak_log').length, 5);
});
