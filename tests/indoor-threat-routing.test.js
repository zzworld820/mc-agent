import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { hasOwnedShelterCover, useMovementProfile, indoorRoomStepCost } from '../src/actions/helpers.js';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.6');
const Block = require('prismarine-block')(registry);
const WorldSync = require('prismarine-world/src/worldsync');
const Move = require('mineflayer-pathfinder/lib/move');

function fixture() {
  const overrides = new Map();
  const room = { origin: { x: 0, y: 71, z: 29 }, size: { width: 7, depth: 7, wallHeight: 3 } };
  const state = { partition: { dimension: 'overworld' }, pastures: [], house: { projectId: 'home' },
    home: { x: 3, y: 72, z: 31, kind: 'house', dimension: 'overworld', projectId: 'home', door: { x: 3, y: 72, z: 29 } },
    buildingRooms: { home: [room] } };
  const bot = { registry, game: { dimension: 'overworld' }, entity: { position: new Vec3(4.5, 72, 33.5), effects: {} },
    inventory: { items: () => [], slots: [] }, strategySupervisor: { active: true, state },
    pathfinder: { setMovements(movements) { this.movements = movements; } },
    blockAt(p) {
      p = p.floored();
      const inRoom = p.x >= 0 && p.x <= 6 && p.z >= 29 && p.z <= 35;
      const solid = inRoom && (p.y === 71 || p.y === 75 || p.y >= 72 && p.y <= 74
        && (p.x === 0 || p.x === 6 || p.z === 29 || p.z === 35));
      const name = overrides.get(p.toString()) ?? (p.equals(new Vec3(3, 72, 29)) ? 'oak_door' : solid ? 'cobblestone' : 'air');
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = p;
      return block;
    } };
  bot.world = { getBlock: p => bot.blockAt(p), raycast(...args) { return WorldSync.prototype.raycast.apply(this, args); } };
  const hostile = { id: 2, type: 'hostile', name: 'zombie', position: new Vec3(-1.5, 72, 33.5), height: 1.95 };
  bot.entities = { 2: hostile };
  return { bot, state, hostile, overrides };
}

test('屋外敌人被实墙隔开时，朝它方向的屋内通道不再被禁行', () => {
  const { bot, state, hostile } = fixture();
  const p = new Vec3(3, 72, 33);
  assert.equal(hasOwnedShelterCover(bot, state, hostile, p), true);
  useMovementProfile(bot, 'safe');
  assert.equal(bot.pathfinder.movements.exclusionStep(bot.pathfinder.movements.getBlock(p, 0, 0, 0)), 0);
  assert.equal(bot.pathfinder.movements.exclusionStep(bot.pathfinder.movements.getBlock(p, 0, 1, 0)), 0);
  const room = state.buildingRooms.home[0];
  bot.pathfinder.movements.exclusionAreasStep.push(block => indoorRoomStepCost(block.position, room));
  const neighbors = [];
  bot.pathfinder.movements.getMoveForward(new Move(4, 72, 33, 0, 0), new Vec3(-1, 0, 0), neighbors);
  assert.ok(neighbors.some(node => node.x === 3 && node.y === 72 && node.z === 33), '真实寻路器必须能通过身体两格的屋内通道');
});

test('室内敌人、室外站位、缺失屋顶和开门不享受房屋遮挡豁免', () => {
  for (const kind of ['inside-hostile', 'outside-node', 'roof', 'open-door']) {
    const { bot, state, hostile, overrides } = fixture();
    let p = new Vec3(3, 72, 33);
    if (kind === 'inside-hostile') hostile.position = new Vec3(1.5, 72, 33.5);
    if (kind === 'outside-node') p = new Vec3(-1, 72, 33);
    if (kind === 'roof') overrides.set(new Vec3(3, 75, 33).toString(), 'air');
    if (kind === 'open-door') {
      const original = bot.blockAt;
      bot.blockAt = p => {
        const block = original(p);
        if (p.equals(new Vec3(3, 72, 29))) block.getProperties = () => ({ open: true });
        return block;
      };
    }
    assert.equal(hasOwnedShelterCover(bot, state, hostile, p), false, kind);
  }
});

test('墙体破口与直接暴露仍保留敌对生物的避让成本', () => {
  const { bot, state, hostile, overrides } = fixture();
  const p = new Vec3(3, 72, 33);
  for (const y of [72, 73, 74]) overrides.set(new Vec3(0, y, 33).toString(), 'air');
  assert.equal(hasOwnedShelterCover(bot, state, hostile, p), false);
  useMovementProfile(bot, 'safe');
  assert.equal(bot.pathfinder.movements.exclusionStep(bot.pathfinder.movements.getBlock(p, 0, 0, 0)), 1000);
});
