import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { unsafeDepartureThreat, hasOpenHomeExit } from '../src/strategy/navigation.js';
import { createRequire } from 'node:module';
import { useMovementProfile } from '../src/actions/helpers.js';

const require = createRequire(import.meta.url);
test('缺护甲时出口外有可见远程敌人，拒绝开门取料；隔墙目标不误报', () => {
  const outside = new Vec3(3, 72, 28);
  const skeleton = { type: 'hostile', name: 'skeleton', position: new Vec3(3, 72, 17), height: 1.8 };
  const bot = { health: 20, inventory: { slots: [] }, entities: { 1: skeleton }, world: { raycast: () => null } };
  assert.equal(unsafeDepartureThreat(bot, outside), skeleton);
  bot.world.raycast = () => ({ name: 'cobblestone' });
  assert.equal(unsafeDepartureThreat(bot, outside), undefined);
  bot.world.raycast = () => null;
  bot.inventory.slots[5] = {}; bot.inventory.slots[6] = {};
  assert.equal(unsafeDepartureThreat(bot, outside), null);
  bot.health = 10;
  assert.equal(unsafeDepartureThreat(bot, outside), skeleton);
});

test('回避返家模式保留不挖不搭，允许短距离靠近远程敌人进入掩护但拒绝贴脸路线', () => {
  const bot = { registry: require('prismarine-registry')('1.21.6'), game: { dimension: 'overworld' },
    entity: { position: new Vec3(12, 70, 0), effects: {} }, inventory: { slots: [], items: () => [] },
    entities: { 1: { type: 'hostile', name: 'skeleton', position: new Vec3(0, 70, 0) } },
    strategySupervisor: { active: true, state: {} }, pathfinder: { setMovements(m) { this.movements = m; } } };
  useMovementProfile(bot, 'retreat');
  const movements = bot.pathfinder.movements;
  assert.equal(movements.canDig, false);
  assert.equal(movements.allow1by1towers, false);
  assert.deepEqual(movements.scafoldingBlocks, []);
  assert.equal(movements.exclusionStep({ position: new Vec3(8, 70, 0) }), 0);
  assert.equal(movements.exclusionStep({ position: new Vec3(2, 70, 0) }), 1000);
});


test('死亡后缺门和工作台时允许原入口补给通道，危险或损坏通道仍拒绝', () => {
  const door = new Vec3(3, 72, 29);
  const outside = new Vec3(3, 72, 28);
  const overrides = new Map();
  const bot = { blockAt(p) {
    const name = overrides.get(p.toString()) ?? (p.y === 71 ? 'cobblestone' : 'air');
    if (name === 'unloaded') return null;
    return { name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' };
  } };
  assert.equal(hasOpenHomeExit(bot, door, outside), true);
  for (const [position, names] of [
    [door, ['oak_door', 'cobblestone', 'water', 'unloaded']],
    [outside.offset(0, -1, 0), ['air', 'lava', 'magma_block', 'unloaded']],
    [door.offset(0, 1, 0), ['stone', 'lava', 'unloaded']],
  ]) {
    for (const name of names) {
      overrides.set(position.toString(), name);
      assert.equal(hasOpenHomeExit(bot, door, outside), false, name);
    }
    overrides.clear();
  }
});
