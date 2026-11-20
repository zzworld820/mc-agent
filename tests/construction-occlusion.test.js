import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';

const require = createRequire(import.meta.url);
const Block = require('prismarine-block')('1.21.6');
const registry = require('prismarine-registry')('1.21.6');
const WorldSync = require('prismarine-world/src/worldsync');

test('封闭房屋的边缘地基被墙与地板遮挡，室内可走不等于能挖该地基', () => {
  const target = new Vec3(0, 0, 2);
  const world = {
    getBlock(p) {
      p = p.floored();
      const inHouse = p.x >= 0 && p.x <= 6 && p.z >= 0 && p.z <= 6;
      const solid = inHouse && (p.y === 0 || p.y === 4 || p.y >= 1 && p.y <= 3
        && (p.x === 0 || p.x === 6 || p.z === 0 || p.z === 6));
      const name = p.equals(target) || p.equals(target.offset(0, 1, 0)) ? 'dirt' : solid ? 'cobblestone' : 'air';
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = p;
      return block;
    },
    raycast(...args) { return WorldSync.prototype.raycast.apply(this, args); },
  };
  const { goals } = pathfinderPkg;
  const mining = new goals.GoalCompositeAny([
    new goals.GoalLookAtBlock(target, world, { reach: 4.5 }), new goals.GoalGetToBlock(target.x, target.y, target.z),
  ]);
  for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++) {
    const feet = new Vec3(x, 1, z);
    assert.equal(world.getBlock(feet).boundingBox, 'empty');
    assert.equal(world.getBlock(feet.offset(0, -1, 0)).boundingBox, 'block');
    assert.equal(mining.isEnd(feet), false, `地基在室内站位 ${feet} 仍不可见`);
  }
  const eye = new Vec3(2.5, 2.6, 2.5);
  const face = target.offset(.5, 1, .5);
  assert.ok(world.raycast(eye, face.minus(eye).normalize(), 4.5).position.equals(target.offset(0, 1, 0)));
  // The exposed wall can be reached; the buried foundation is the dependency error.
  assert.equal(new goals.GoalLookAtBlock(target.offset(0, 1, 0), world).isEnd(new Vec3(2, 1, 2)), true);
});
