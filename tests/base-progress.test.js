import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Vec3 } from 'vec3';
import { planHouseShell } from '../src/building/models.js';

// Mock only game I/O: exercise the actual ensureBase scheduler, persisted jobs,
// safety checks and inventory/material ordering without joining the live world.
const sources = {
  'actions/helpers.js': `
    export const countItem = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
    export const craftVerified = (bot, itemName, findRecipe) => bot.craft(findRecipe(), 1);
    export function throwIfAborted(signal) { if (signal?.aborted) throw Object.assign(new Error(String(signal.reason)), {name:'AbortError'}); }
    export const sleep = async () => {};
    export const goTo = async () => {};
    export function useMovementProfile(bot) { bot.pathfinder.movements = { exclusionAreasStep: [] }; }
    export const indoorRoomStepCost = (p, {origin:o,size:s}) => p.x > o.x && p.x < o.x+s.width-1
      && p.z > o.z && p.z < o.z+s.depth-1 && p.y >= o.y+1 && p.y <= o.y+2 ? 0 : Infinity;
  `,
  'autonomy/skills/build.js': `export const placeBlockAt = (...args) => globalThis.baseFixture.place(...args);`,
  'building/projects.js': `export const listHouseProjects = async () => [globalThis.baseFixture.project];
    export const projectShellPlan = () => globalThis.baseFixture.shell;`,
  'autonomy/skills/sleep.js': `export const isNight = bot => bot.time.timeOfDay >= 13000;`,
  'autonomy/skills/world.js': `export const attackUntilDead = async () => { throw new Error('unexpected hunt'); };
    export const collectDrops = async () => {};`,
  'strategy/navigation.js': `export const reachHome = async () => { globalThis.baseFixture.events.push('home'); };
    export const leaveHome = async () => { globalThis.baseFixture.events.push('leave'); };`,
  'farming/storage.js': `export const ensureStorage = async () => { throw new Error('unexpected batch storage'); };
    export const refreshStorage = async () => { throw new Error('unexpected batch refresh'); };
    export const storeSurplus = async () => { throw new Error('unexpected batch deposit'); };
    export const retrieveMaterials = async () => { globalThis.baseFixture.events.push('retrieve'); };
    export const visitSupplyChest = async (ctx, chest) => { globalThis.baseFixture.events.push('verify');
      await globalThis.baseFixture.verify(chest); chest.observedAt = Date.now(); chest.missing = false; delete chest.verificationError; };`,
  'strategy/development.js': `export const developmentSettings = () => ({homeChests: 1});`,
  'autonomy/skills/mine.js': `export const digBlock = async () => { throw new Error('must never dig closed shell'); };`,
};
const mocks = new Map(Object.entries(sources).map(([name, source]) => [new URL(`../src/${name}`, import.meta.url).href, source]));
const hook = registerHooks({ load(url, context, nextLoad) {
  if (mocks.has(url)) return { format: 'module', source: mocks.get(url), shortCircuit: true };
  return nextLoad(url, context);
} });
const { ensureBase } = await import('../src/strategy/base.js');
hook.deregister();

function fixture({ installed = true } = {}) {
  const world = new Map();
  const inventory = {};
  const origin = new Vec3(0, 71, 29);
  const model = { size: { width: 7, depth: 7, wallHeight: 3 }, furniture: { furnaces: 1 },
    palette: { floor: 'cobblestone', wall: 'cobblestone', roof: 'oak_planks', window: 'glass', door: 'oak_door' } };
  const shell = planHouseShell(model, model.size).map(entry => ({ ...entry, acceptedItems: [entry.item] }));
  const put = (p, name) => world.set(p.toString(), name);
  for (const entry of shell) put(origin.offset(...entry.offset), entry.item);
  put(origin.offset(3, 2, 0), 'oak_door');
  put(new Vec3(0, 71, 31), 'dirt');
  put(new Vec3(0, 72, 31), 'dirt');
  const furnace = origin.offset(5, 1, 1);
  const table = origin.offset(1, 1, 1);
  const chest = origin.offset(1, 1, 5);
  if (installed) for (const [p, name] of [[furnace, 'furnace'], [table, 'crafting_table'], [chest, 'chest']]) put(p, name);
  put(origin.offset(2, 1, 1), 'torch');
  put(origin.offset(1, 1, 2), 'white_bed'); put(origin.offset(1, 1, 3), 'white_bed');
  const controller = new AbortController();
  const events = [];
  const bot = { entity: { position: origin.offset(3.5, 1, 2.5) },
    game: { dimension: 'overworld' }, time: { timeOfDay: 1000 }, pathfinder: { movements: { exclusionAreasStep: [] } },
    inventory: { items: () => Object.entries(inventory).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) },
    blockAt(p) { const name = world.get(p.toString()) ?? (p.y < origin.y ? 'stone' : 'air');
      return { name, position: p, boundingBox: ['air', 'torch', 'white_bed'].includes(name) ? 'empty' : 'block' }; },
  };
  const state = { home: { kind: 'house', x: 3, y: 72, z: 30, door: { x: 3, y: 72, z: 29 } },
    house: { projectId: 'own-house' }, pastures: [] };
  const f = { bot, state, origin, furnace, table, chest, shell, inventory, events, put, controller,
    project: { id: 'own-house', status: 'complete', origin, model, extensions: [] },
    async place(ctx, p, item) { events.push(`place:${item}`); await f.beforePlace(ctx, p, item);
      if (!inventory[item]) throw new Error('no item'); put(p, item); inventory[item]--; },
    async beforePlace() {}, async verify() {},
    ctx: { bot, state, signal: controller.signal, log() {}, async checkpoint() {},
      async obtain(item) { events.push(`obtain:${item}`); await f.obtain(item); } },
    async obtain(item) { inventory[item] = (inventory[item] || 0) + 1; },
  };
  globalThis.baseFixture = f;
  return f;
}
const jobAt = (f, item, p) => f.state.base.jobs[`${item}:${p.x},${p.y},${p.z}`];

test('夜间在屋内用随身木板合成并安装工作台，无需外出取料', async () => {
  const f = fixture({ installed: false });
  f.bot.time.timeOfDay = 15000;
  f.inventory.oak_planks = 4;
  f.bot.registry = { itemsByName: { crafting_table: { id: 1 } } };
  f.bot.recipesFor = () => f.inventory.oak_planks >= 4 ? [{}] : [];
  f.bot.craft = async () => {
    f.inventory.oak_planks -= 4;
    f.inventory.crafting_table = 1;
    f.events.push('craft');
  };
  await ensureBase(f.ctx, { permanent: true, availableOnly: true });
  assert.deepEqual(f.events, ['craft', 'place:crafting_table']);
  assert.equal(f.bot.blockAt(f.table).name, 'crafting_table');
});

test('遮挡地基保留承重登记finishing，现成熔炉先放再取工作台材料', async () => {
  const f = fixture({ installed: false }); f.inventory.furnace = 1;
  const result = await ensureBase(f.ctx, { permanent: true });
  assert.equal(f.bot.blockAt(new Vec3(0, 71, 31)).name, 'dirt');
  assert.equal(f.state.base.jobs['shell:0,71,31'].status, 'finishing');
  assert.equal(f.state.base.jobs['shell:0,72,31'].status, 'finishing');
  assert.equal(f.bot.blockAt(f.furnace).name, 'furnace');
  assert.equal(f.bot.blockAt(f.table).name, 'crafting_table');
  assert.ok(f.events.indexOf('place:furnace') < f.events.indexOf('obtain:crafting_table'));
  assert.equal(f.events.filter(e => e.startsWith('obtain:')).length, 1);
  assert.equal(result.pending, true); assert.equal(result.ready, false);
  assert.ok(result.reason); assert.ok(result.next.id);
});

test('单项放置失败不阻塞箱子，冷却期间不重复放置已完成设施', async () => {
  const f = fixture({ installed: false }); Object.assign(f.inventory, { furnace: 1, crafting_table: 1, chest: 1 });
  f.beforePlace = async (_, __, item) => { if (item === 'crafting_table') throw new Error('站位暂不可达'); };
  const first = await ensureBase(f.ctx, { permanent: true });
  assert.equal(first.pending, true); assert.equal(jobAt(f, 'crafting_table', f.table).status, 'failed');
  assert.equal(jobAt(f, 'chest', f.chest).status, 'done');
  assert.ok(first.retryAt > Date.now());
  const count = f.events.filter(e => e.startsWith('place:')).length;
  await ensureBase(f.ctx, { permanent: true });
  assert.equal(f.events.filter(e => e.startsWith('place:')).length, count);
});

test('缺材项单独冷却，下一种材料仍可推进且不虚报ready', async () => {
  const f = fixture({ installed: false });
  f.obtain = async item => { if (item === 'furnace') throw new Error('缺少圆石'); f.inventory[item] = 1; };
  await ensureBase(f.ctx, { permanent: true });
  assert.equal(f.state.base.jobs['material:furnace'].status, 'failed');
  await ensureBase(f.ctx, { permanent: true });
  assert.equal(f.bot.blockAt(f.table).name, 'crafting_table');
  assert.equal(f.events.filter(e => e === 'obtain:furnace').length, 1);
  assert.equal(f.state.base.ready, false);
});

test('现场未变化的放置返回不能当作成功', async () => {
  const f = fixture({ installed: false }); f.inventory.furnace = 1;
  f.place = async () => {};
  const result = await ensureBase(f.ctx, { permanent: true, availableOnly: true });
  assert.equal(jobAt(f, 'furnace', f.furnace).status, 'failed');
  assert.equal(result.ready, false);
});

test('availableOnly只用背包设施且施工路径严格留在主屋内', async () => {
  const f = fixture({ installed: false }); f.bot.time.timeOfDay = 14000;
  Object.assign(f.inventory, { furnace: 1, crafting_table: 1, chest: 1 });
  let guarded = 0;
  f.beforePlace = async (ctx) => {
    const exclusions = ctx.bot.pathfinder.movements.exclusionAreasStep;
    assert.ok(exclusions.length);
    const cost = p => exclusions.reduce((n, fn) => n + fn({ position: p }), 0);
    assert.equal(cost(f.origin.offset(2, 1, 2)), 0);
    assert.equal(cost(f.origin.offset(2, 2, 2)), 0);
    for (const p of [[0, 1, 2], [6, 1, 2], [2, 1, 0], [2, 1, 6], [-1, 1, 2], [7, 1, 2], [2, 0, 2], [2, 3, 2]]) {
      assert.equal(cost(f.origin.offset(...p)), Infinity, String(p));
    }
    guarded++;
  };
  await ensureBase(f.ctx, { permanent: true, availableOnly: true });
  assert.equal(guarded, 3);
  assert.deepEqual(f.events, ['place:furnace', 'place:crafting_table', 'place:chest']);
});

test('availableOnly拒绝屋外调用，真实缺口也不修墙或安装设施', async () => {
  const f = fixture({ installed: false }); f.inventory.furnace = 1;
  f.bot.entity.position = f.origin.offset(-1, 1, 2);
  await assert.rejects(ensureBase(f.ctx, { permanent: true, availableOnly: true }), { code: 'BASE_UNSAFE' });
  f.bot.entity.position = f.origin.offset(3, 1, 2);
  f.put(f.origin.offset(0, 2, 3), 'air');
  const result = await ensureBase(f.ctx, { permanent: true, availableOnly: true });
  assert.equal(result.pending, true); assert.deepEqual(f.events, []);
});

test('危险液体、未知占用和无支撑软土先阻止施工', async () => {
  for (const name of ['lava', 'water', 'mod_block']) {
    const f = fixture({ installed: false }); f.inventory.furnace = 1;
    f.put(new Vec3(0, 71, 31), name);
    await assert.rejects(ensureBase(f.ctx, { permanent: true }), { code: 'BASE_UNSAFE' });
    assert.ok(!f.events.some(e => e.startsWith('place:')));
  }
  const f = fixture(); f.put(new Vec3(-1, 71, 31), 'lava');
  await assert.rejects(ensureBase(f.ctx, { permanent: true }), { code: 'BASE_UNSAFE' });
});

test('取消和fatal原样传播，绝不继续下一设施', async () => {
  for (const kind of ['abort', 'fatal', 'danger']) {
    const f = fixture({ installed: false }); Object.assign(f.inventory, { furnace: 1, crafting_table: 1 });
    f.beforePlace = async () => {
      if (kind === 'abort') { f.controller.abort('危险避让'); throw new Error('route cancelled'); }
      throw Object.assign(new Error('stop now'), kind === 'fatal' ? { fatal: true } : { name: 'DangerError' });
    };
    await assert.rejects(ensureBase(f.ctx, { permanent: true }), kind === 'abort' ? /危险避让/ : /stop now/);
    assert.ok(!f.events.includes('place:crafting_table'));
    assert.equal(f.ctx.signal, f.controller.signal);
  }
});

test('所有必需设施逐项核验后ready，finishing不妨碍生产可用性', async () => {
  const f = fixture();
  const result = await ensureBase(f.ctx, { permanent: true });
  assert.equal(result.ready, true); assert.equal(result.pending, false);
  assert.equal(result.retryAt, 0); assert.equal(result.next, null);
  assert.equal(f.state.base.finishing.length, 2);
  assert.equal(f.state.storage.status, 'ready');
  // Saved success never masks a subsequently destroyed required facility.
  f.put(f.furnace, 'air');
  const second = await ensureBase(f.ctx, { permanent: true, availableOnly: true });
  assert.equal(second.ready, false); assert.equal(jobAt(f, 'furnace', f.furnace).status, 'pending');
});

test('只有半张床或开箱失败时保留pending，不能ready', async () => {
  const f = fixture(); f.put(f.origin.offset(1, 1, 3), 'air');
  f.verify = async () => { throw new Error('箱子无法打开'); };
  const result = await ensureBase(f.ctx, { permanent: true });
  assert.equal(result.ready, false); assert.notEqual(f.state.base.jobs.bed.status, 'done');
  assert.ok(Object.values(result.jobs).some(job => job.reason === '箱子无法打开'));
});

test('单项超时真正取消并等待工作结束，恢复父signal后返回冷却', async t => {
  const f = fixture(); f.put(f.furnace, 'air'); f.inventory.furnace = 1;
  let started = false; let stopped = false;
  f.beforePlace = ctx => new Promise((resolve, reject) => {
    started = true;
    ctx.signal.addEventListener('abort', () => { stopped = true;
      reject(Object.assign(new Error('local timeout'), { name: 'AbortError' })); }, { once: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = ensureBase(f.ctx, { permanent: true });
  for (let i = 0; i < 20 && !started; i++) await Promise.resolve();
  assert.equal(started, true);
  t.mock.timers.tick(10000);
  const result = await running;
  assert.equal(stopped, true); assert.equal(f.ctx.signal, f.controller.signal);
  assert.equal(f.controller.signal.aborted, false);
  assert.equal(result.pending, true); assert.ok(result.retryAt > Date.now());
});

test('原有材料失败历史跨冷却轮保留，背包补齐立即推进对应设施', async () => {
  const f = fixture({ installed: false });
  f.obtain = async () => { throw new Error('暂时缺材'); };
  await ensureBase(f.ctx, { permanent: true });
  const failure = { ...f.state.base.jobs['material:furnace'] };
  await ensureBase(f.ctx, { permanent: true });
  assert.equal(f.state.base.jobs['material:furnace'].attempts, failure.attempts);
  assert.equal(f.state.base.jobs['material:furnace'].retryAt, failure.retryAt);
  f.inventory.furnace = 1;
  await ensureBase(f.ctx, { permanent: true, availableOnly: true });
  assert.equal(f.bot.blockAt(f.furnace).name, 'furnace');
  assert.equal(jobAt(f, 'furnace', f.furnace).status, 'done');
  assert.equal(f.state.base.jobs['material:furnace'], undefined);
});

test('真实缺口优先封闭，本轮不同时往暴露房间安装设施', async () => {
  const f = fixture({ installed: false });
  const gap = f.origin.offset(0, 2, 3); f.put(gap, 'air');
  Object.assign(f.inventory, { cobblestone: 1, furnace: 1 });
  const result = await ensureBase(f.ctx, { permanent: true });
  assert.equal(f.bot.blockAt(gap).name, 'cobblestone');
  assert.equal(f.bot.blockAt(f.furnace).name, 'air');
  assert.equal(result.pending, true); assert.match(result.reason, /复核/);
});

test('每轮最多六个局部动作，剩余工作明确pending', async () => {
  const f = fixture({ installed: false }); f.project.model.furniture.furnaces = 4;
  f.put(f.origin.offset(2, 1, 1), 'air');
  Object.assign(f.inventory, { furnace: 4, crafting_table: 1, chest: 1, torch: 1 });
  const result = await ensureBase(f.ctx, { permanent: true });
  assert.equal(f.events.filter(e => e.startsWith('place:')).length, 6);
  assert.equal(result.pending, true); assert.equal(result.jobs.light.status, 'pending');
});

test('第一座熔炉已有后先补工作台和箱子，再补额外熔炉', async () => {
  const f = fixture({ installed: false }); f.project.model.furniture.furnaces = 3;
  f.inventory.furnace = 1;
  await ensureBase(f.ctx, { permanent: true });
  assert.deepEqual(f.events.filter(e => e.startsWith('obtain:')), ['obtain:crafting_table']);
  await ensureBase(f.ctx, { permanent: true });
  assert.deepEqual(f.events.filter(e => e.startsWith('obtain:')), ['obtain:crafting_table', 'obtain:chest']);
});
