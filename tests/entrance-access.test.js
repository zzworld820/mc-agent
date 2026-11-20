import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { useMovementProfile } from '../src/actions/helpers.js';
import { canAlterEntranceTerrain } from '../src/strategy/access.js';

const require = createRequire(import.meta.url);
const Move = require('mineflayer-pathfinder/lib/move');
const registry = require('prismarine-registry')('1.21.6');
const key = (p) => `${p.x},${p.y},${p.z}`;

function entrance() {
  const overrides = new Map();
  for (const x of [5, 7]) for (const y of [70, 71, 72]) overrides.set(`${x},${y},-8`, 'air');
  overrides.set('6,70,-8', 'crafting_table');
  overrides.set('6,71,-8', 'air');
  overrides.set('8,70,-8', 'oak_door');
  overrides.set('8,71,-8', 'oak_door');
  const cave = { kind: 'cave', x: 10, y: 70, z: -8, dimension: 'overworld', door: { x: 8, y: 70, z: -8 } };
  const state = { partition: { dimension: 'overworld' }, home: { x: 3, y: 72, z: 31 },
    archivedStorage: [{ home: cave }], pastures: [] };
  const bot = { registry, game: { dimension: 'overworld' }, entities: {},
    entity: { position: new Vec3(7.5, 70, -7.5), effects: {} }, inventory: { slots: [], items: () => [] },
    strategySupervisor: { active: true, state },
    blockAt(p) {
      const name = overrides.get(key(p)) || (p.y < 74 ? 'stone' : 'air');
      return { position: p, name, type: registry.blocksByName[name].id,
        boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]],
        getProperties: () => ({ open: false }), digTime: () => 100 };
    }, pathfinder: { setMovements(value) { this.movements = value; }, bestHarvestTool: () => null } };
  return { bot, state, overrides };
}

test('旧洞口保护范围内可以清除天然头顶障碍，从原来没有出口的站位迈出一步', () => {
  const { bot } = entrance();
  const origin = new Move(7, 70, -8, 0, 0);
  useMovementProfile(bot, 'safe');
  assert.equal(bot.pathfinder.movements.getNeighbors(origin).length, 0);
  useMovementProfile(bot, 'free');
  const exit = bot.pathfinder.movements.getNeighbors(origin).find((node) => node.x === 6 && node.y === 71 && node.z === -8);
  assert.ok(exit);
  assert.deepEqual(exit.toBreak.map(key), ['6,72,-8']);
  assert.equal(bot.pathfinder.movements.safeToBreak(bot.blockAt(new Vec3(6, 70, -8))), false);
  assert.equal(bot.pathfinder.movements.safeToBreak(bot.blockAt(new Vec3(8, 70, -8))), false);
});

test('入口例外保留地板、门框、未知材料，遇到液体、重力方块或未加载邻格时停止', () => {
  const { bot, state, overrides } = entrance();
  const target = new Vec3(6, 72, -8);
  assert.equal(canAlterEntranceTerrain(bot, state, bot.blockAt(target)), true);
  for (const p of [new Vec3(6, 69, -8), new Vec3(8, 72, -8), new Vec3(9, 72, -8)]) {
    assert.equal(canAlterEntranceTerrain(bot, state, bot.blockAt(p)), false);
  }
  for (const name of ['glass', 'cobblestone', 'oak_log', 'chest']) {
    overrides.set(key(target), name);
    assert.equal(canAlterEntranceTerrain(bot, state, bot.blockAt(target)), false);
  }
  overrides.set(key(target), 'stone');
  for (const name of ['water', 'lava', 'gravel']) {
    overrides.set('6,73,-8', name);
    assert.equal(canAlterEntranceTerrain(bot, state, bot.blockAt(target)), false);
  }
  const read = bot.blockAt;
  bot.blockAt = (p) => p.equals(new Vec3(6, 73, -8)) ? null : read(p);
  assert.equal(canAlterEntranceTerrain(bot, state, bot.blockAt(target)), false);
});
