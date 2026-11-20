import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { placeBlockSneaking } from '../src/actions/helpers.js';

test('对交互方块施工时潜行，服务器拒绝后也恢复原控制状态', async () => {
  for (const initial of [false, true]) for (const refused of [false, true]) {
    const bot = { controlState: { sneak: initial },
      setControlState(name, value) { this.controlState[name] = value; },
      async placeBlock(reference) {
        assert.equal(reference.name, 'furnace');
        assert.equal(this.controlState.sneak, true);
        if (refused) throw new Error('server refused');
      } };
    const action = placeBlockSneaking(bot, { name: 'furnace' }, new Vec3(0, 1, 0), new AbortController().signal);
    if (refused) await assert.rejects(action, /server refused/);
    else await action;
    assert.equal(bot.controlState.sneak, initial);
  }
});
