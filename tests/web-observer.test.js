import test from 'node:test';
import assert from 'node:assert/strict';
import { constructionMaterials } from '../src/web/observer.js';

const facilities = { beds: 0, chests: 1, furnaces: 1, craftingTables: 1 };
const targets = { beds: 1, chests: 4, furnaces: 3, craftingTables: 1 };

test('material gaps include final finishing even when temporary shelter is sealed', () => {
  const blocks = [
    { entry: { targetItem: 'glass' }, block: { name: 'cobblestone' } },
    { entry: { targetItem: 'oak_planks' }, block: { name: 'cobblestone' } },
    { entry: { targetItem: 'glass' }, block: { name: 'glass' } },
  ];
  const rows = constructionMaterials(blocks, [{ name: 'oak_planks', count: 3 }, { name: 'chest', count: 1 }, { name: 'red_bed', count: 1 }], facilities, targets);
  assert.deepEqual(rows.find(row => row.name === 'glass'), { name: 'glass', label: 'glass', current: 0, required: 1, missing: 1 });
  assert.equal(rows.find(row => row.name === 'oak_planks').missing, 0);
  assert.equal(rows.find(row => row.name === 'chest').missing, 2);
  assert.equal(rows.find(row => row.name === 'bed').missing, 0);
  assert.ok(!rows.some(row => row.name === 'crafting_table'));
});

test('unloaded blocks do not become invented material requirements', () => {
  assert.deepEqual(constructionMaterials([{ entry: { targetItem: 'glass' }, block: null }], [], targets, targets), []);
});
