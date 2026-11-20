import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFurnace } from '../src/autonomy/skills/smelt.js';

function furnaceSlots(input, fuel, output = null) {
  const recovered = [];
  const furnace = {
    input, fuel, output,
    inputItem() { return this.input; }, fuelItem() { return this.fuel; }, outputItem() { return this.output; },
    async takeInput() { recovered.push(this.input); this.input = null; },
    async takeFuel() { recovered.push(this.fuel); this.fuel = null; },
    async takeOutput() { recovered.push(this.output); this.output = null; },
    async putInput(type, metadata, count) {
      if (this.input && this.input.type !== type) throw new Error('destination full');
      this.input = { name: 'chicken', type, count: (this.input?.count || 0) + count };
      if (this.input.count > 64) throw new Error('destination full');
    },
    async putFuel(type, metadata, count) {
      if (this.fuel && this.fuel.type !== type) throw new Error('destination full');
      this.fuel = { type, count: (this.fuel?.count || 0) + count };
      if (this.fuel.count > 64) throw new Error('destination full');
    },
  };
  const bot = { registry: { itemsByName: { chicken: { id: 1 }, oak_planks: { id: 2 }, coal: { id: 3 } } } };
  return { bot, furnace, recovered };
}

test('旧原料和不同燃料占槽时先回收，再加载烤肉任务', async () => {
  const f = furnaceSlots({ name: 'sand', type: 4, count: 5 }, { name: 'coal', type: 3, count: 64 }, { name: 'glass', count: 1 });
  await loadFurnace(f.bot, f.furnace, 'chicken', 1, { name: 'oak_planks', count: 1 });
  assert.deepEqual(f.recovered.map((item) => item.name), ['glass', 'sand', 'coal']);
  assert.equal(f.furnace.input.count, 1);
  assert.equal(f.furnace.fuel.count, 1);
});

test('原料和燃料已足够时续作不会重复填满槽位', async () => {
  const f = furnaceSlots({ name: 'chicken', type: 1, count: 64 }, { name: 'coal', type: 3, count: 64 });
  await loadFurnace(f.bot, f.furnace, 'chicken', 64, { name: 'coal', count: 8 });
  assert.equal(f.furnace.input.count, 64);
  assert.equal(f.furnace.fuel.count, 64);
});

test('同种原料只补足差额', async () => {
  const f = furnaceSlots({ name: 'chicken', type: 1, count: 2 }, { name: 'coal', type: 3, count: 1 });
  await loadFurnace(f.bot, f.furnace, 'chicken', 5, { name: 'coal', count: 1 });
  assert.equal(f.furnace.input.count, 5);
  assert.equal(f.furnace.fuel.count, 1);
});
