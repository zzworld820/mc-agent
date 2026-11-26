import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { hideUntilMorning } from '../src/autonomy/skills/sleep.js';
import { repairCaveEntrance } from '../src/strategy/navigation.js';

test('掩体封顶使用上方支撑，旧围墙被纳入白天拆除记录', async () => {
  const blocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const put = (p, name) => blocks.set(key(p), name);
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) put(new Vec3(x, 4, z), 'stone');
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const y of [5, 6]) put(new Vec3(x, y, z), 'cobblestone');
  }
  put(new Vec3(0, 8, 0), 'stone');
  const placements = [];
  const bot = {
    game: { dimension: 'overworld' }, time: { timeOfDay: 15000 },
    entity: { position: new Vec3(0.5, 5, 0.5), onGround: true },
    inventory: { items: () => [{ name: 'cobblestone', count: 10 }] },
    blockAt(p) {
      const name = blocks.get(key(p)) || 'air';
      return { position: p, name, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true };
    },
    pathfinder: { setGoal() {}, bestHarvestTool: () => null }, clearControlStates() {}, equip: async () => {},
    controlState: {}, setControlState(name, value) { this.controlState[name] = value; },
    dig: async (block) => { blocks.delete(key(block.position)); },
    placeBlock: async (reference, face) => {
      assert.equal(bot.controlState.sneak, true);
      const target = reference.position.plus(face);
      placements.push({ reference: reference.position, target });
      put(target, 'cobblestone');
    },
  };
  const state = { emergencyShelter: { kind: 'hut', dimension: 'overworld', surface: { x: 0, y: 5, z: 0 }, depth: 0 } };
  await hideUntilMorning({ bot, state, signal: new AbortController().signal, log() {}, checkpoint: async () => {} }, { buildOnly: true });
  assert.equal(placements.length, 1);
  assert.equal(placements[0].reference.y, 8);
  assert.equal(placements[0].target.y, 7);
  assert.equal(bot.blockAt(new Vec3(0, 6, 0)).name, 'air');
  assert.equal(state.emergencyShelter.placedBlocks.length, 9);
  bot.time.timeOfDay = 1000;
  await hideUntilMorning({ bot, state, signal: new AbortController().signal, log() {}, checkpoint: async () => {} });
  assert.equal(state.emergencyShelter, undefined);
  assert.equal(bot.blockAt(new Vec3(1, 5, 0)).name, 'air');
});

test('仅在白天清理档案中自建洞口的已知堵塞材料', async () => {
  const blocked = new Map();
  let open = false;
  const bot = {
    game: { dimension: 'overworld' }, time: { timeOfDay: 1000 },
    pathfinder: { bestHarvestTool: () => null }, heldItem: null, stopDigging() {},
    blockAt(p) {
      const name = p.equals(new Vec3(2, 5, 0)) ? 'oak_door' : blocked.get(p.toString()) || 'air';
      return { position: p, name, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => ({ open }), canHarvest: () => true };
    },
    activateBlock: async () => { open = !open; },
    dig: async (block) => { blocked.delete(block.position.toString()); },
  };
  blocked.set(new Vec3(3, 6, 0).toString(), 'cobblestone');
  blocked.set(new Vec3(3, 5, 0).toString(), 'dirt');
  const home = { kind: 'cave', x: 0, y: 5, z: 0, door: { x: 2, y: 5, z: 0 }, dimension: 'overworld' };
  const ctx = { bot, state: { home, plannedShelter: { entrance: home.door } }, signal: new AbortController().signal, log() {} };
  bot.time.timeOfDay = 15000;
  await assert.rejects(repairCaveEntrance(ctx, home), /白天/);
  assert.equal(blocked.size, 2);
  bot.time.timeOfDay = 1000;
  await repairCaveEntrance(ctx, home);
  assert.equal(blocked.size, 0);
  assert.equal(open, false);
});

test('应急坑出口记录允许在井口七格外安全站稳后清除', async () => {
  const surface = { x: -148, y: 67, z: 106 };
  const state = { emergencyShelter: { kind: 'pit', dimension: 'overworld', surface, depth: 3, exiting: true } };
  const bot = {
    game: { dimension: 'overworld' }, time: { timeOfDay: 7509 },
    entity: { position: new Vec3(-147.56, 67, 113.38), onGround: true },
    blockAt(p) { return p.y < 67 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air' }; },
  };
  let saved = false;
  const ctx = { bot, state, signal: new AbortController().signal, log() {}, checkpoint: async () => {
    assert.equal(state.emergencyShelter, undefined);
    saved = true;
  } };
  assert.equal(await hideUntilMorning(ctx), true);
  assert.equal(saved, true);
});

test('井外仍在下落、脚下未加载或是危险方块时不清除档案', async () => {
  for (const [onGround, floor] of [[false, 'grass_block'], [true, null], [true, 'magma_block']]) {
    const shelter = { kind: 'pit', dimension: 'overworld', surface: { x: 0, y: 65, z: 0 }, depth: 3, exiting: true };
    const state = { emergencyShelter: shelter };
    const bot = {
      game: { dimension: 'overworld' }, time: { timeOfDay: 1000 },
      entity: { position: new Vec3(6.5, 65, 0.5), onGround },
      blockAt(p) { return p.y < 65 ? floor && { name: floor, boundingBox: 'block' } : { name: 'air' }; },
    };
    await assert.rejects(hideUntilMorning({ bot, state, signal: new AbortController().signal, log() {} }), /安全落脚点/);
    assert.equal(state.emergencyShelter, shelter);
  }
});

test('已经出坑但天仍黑时，丢弃旧井状态并继续检查新掩体', async () => {
  const state = { emergencyShelter: { kind: 'pit', dimension: 'overworld',
    surface: { x: 0, y: 65, z: 0 }, depth: 3, exiting: true } };
  const bot = {
    game: { dimension: 'overworld' }, time: { timeOfDay: 15000 },
    entity: { position: new Vec3(6.5, 65, 0.5), onGround: true },
    inventory: { items: () => [] },
    blockAt(p) { return p.y < 65 ? { name: 'stone', boundingBox: 'block', canHarvest: () => false } : { name: 'air' }; },
  };
  assert.equal(await hideUntilMorning({ bot, state, signal: new AbortController().signal, log() {} }), false);
  assert.equal(state.emergencyShelter, undefined);
});
