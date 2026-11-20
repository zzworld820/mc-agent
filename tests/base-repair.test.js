import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { repairableShellTerrain } from '../src/strategy/base.js';

test('自有外壳软土可修复，保留设施、未知方块及脚下支撑', () => {
  const p = new Vec3(0, 71, 31);
  let name = 'dirt';
  const bot = { entity: { position: new Vec3(2.5, 72, 33.5) },
    blockAt: v => ({ name: v.equals(p) ? name : 'air' }) };
  assert.equal(repairableShellTerrain(bot, p), true);
  for (name of ['chest', 'cobblestone', 'glass', 'sand', 'mod_block']) assert.equal(repairableShellTerrain(bot, p), false, name);
  name = 'dirt'; bot.entity.position = p.offset(.5, 1, .5);
  assert.equal(repairableShellTerrain(bot, p), false);
});

test('软土旁有液体、重力方块或未加载区块时不拆换', () => {
  const p = new Vec3(0, 72, 31);
  for (const hazard of ['water', 'lava', 'gravel', 'sand', null]) {
    const bot = { entity: { position: new Vec3(2.5, 72, 33.5) }, blockAt: v =>
      v.equals(p) ? { name: 'dirt' } : v.equals(p.offset(0, 1, 0)) ? hazard && { name: hazard } : { name: 'air' } };
    assert.equal(repairableShellTerrain(bot, p), false, String(hazard));
  }
});
