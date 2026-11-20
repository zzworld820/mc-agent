import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import * as THREE from 'three';
import { Vec3 } from 'vec3';
import { buildWeb, viewerBuildPlugin } from '../scripts/build-web.mjs';
import { createViewerService, blockInfo } from '../src/web/viewer.js';
import { meshSection, prepareBlockStates } from '../src/web/mesh-worker.js';

const require = createRequire(import.meta.url);
const express = require('express');
const { io } = require('socket.io-client');
const { World } = require('prismarine-viewer/viewer/lib/world.js');
const Chunk = require('prismarine-chunk')('1.21.6');
const mcData = require('minecraft-data')('1.21.6');
let temp, workerSource, models, client, buildResult;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'mc-viewer-test-'));
  buildResult = await buildWeb({ outdir: temp });
  workerSource = await readFile(join(temp, 'worker.js'), 'utf8');
  models = JSON.parse(await readFile(require.resolve('prismarine-viewer/public/blocksStates/1.21.4.json'), 'utf8'));
  const result = await build({ entryPoints: ['src/web/viewer-client.js'], bundle: true, write: false,
    platform: 'browser', format: 'iife', globalName: 'ViewerTest', plugins: [viewerBuildPlugin()], inject: ['viewer-polyfills'],
    define: { global: 'globalThis', __dirname: '""', 'globalThis.isElectron': 'false' } });
  const context = { console };
  vm.runInNewContext(result.outputFiles[0].text, context);
  client = context.ViewerTest;
});
after(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

function worker() {
  const messages = [];
  let tick;
  const self = { postMessage: data => messages.push(data) };
  vm.runInNewContext(workerSource, { self, performance, console, setInterval: fn => { tick = fn; } });
  return { messages, send: data => self.onmessage({ data }), flush: () => { for (let i = 0; i < 30; i++) tick(); } };
}

test('built worker uses true 1.21.6 stateIds and renders all six faces below zero and above 256', () => {
  const block = mcData.blocksByName.diamond_block;
  assert.equal(require('minecraft-data')('1.21.4').blocksByStateId[block.defaultState].name, 'wheat');
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const heights = [-64, -33, -1, 300, 319];
  for (const y of heights) chunk.setBlockStateId(new Vec3(8, y, 8), block.defaultState);
  const json = chunk.toJson();
  const w = worker();
  w.send({ type: 'version', version: '1.21.6', generation: 7 });
  w.send({ type: 'blockStates', json: models });
  w.send({ type: 'chunk', x: -16, z: -16, chunk: json });
  for (const y of heights) w.send({ type: 'dirty', x: -16, y, z: -16 });
  w.flush();
  assert.equal(w.messages.filter(m => m.type === 'error').length, 0);
  const reference = new World('1.21.6');
  reference.addColumn(-16, -16, json);
  for (const y of heights) {
    const sectionY = Math.floor(y / 16) * 16;
    const result = w.messages.find(m => m.type === 'geometry' && m.key === `-16,${sectionY},-16`);
    assert.ok(result, `section ${sectionY} has geometry`);
    assert.equal(result.generation, 7);
    assert.equal(result.geometry.positions.length, 6 * 4 * 3, `all faces at Y=${y}`);
    const expected = meshSection(reference, models, -16, sectionY, -16);
    assert.deepEqual(Array.from(result.geometry.uvs), Array.from(expected.uvs), 'diamond texture, not wheat');
    const ys = Array.from(result.geometry.positions).filter((_, i) => i % 3 === 1).map(v => v + result.geometry.sy);
    assert.equal(Math.min(...ys), y);
    assert.equal(Math.max(...ys), y + 1);
  }
  w.send({ type: 'blockUpdate', pos: { x: -8, y: -33, z: -8 }, stateId: 0 });
  w.send({ type: 'dirty', x: -16, y: -33, z: -16 });
  w.flush();
  assert.equal(w.messages.filter(m => m.type === 'geometry' && m.key === '-16,-48,-16').at(-1).geometry.positions.length, 0);
  w.send({ type: 'reset', generation: 8 });
  w.send({ type: 'version', version: '1.21.6', generation: 8 });
  w.send({ type: 'blockStates', json: models });
  const nether = new Chunk({ minY: 0, worldHeight: 256 });
  nether.setBlockStateId(new Vec3(8, 255, 8), block.defaultState);
  w.send({ type: 'chunk', x: 0, z: 0, chunk: nether.toJson() });
  w.send({ type: 'dirty', x: 0, y: 255, z: 0 });
  w.flush();
  assert.equal(w.messages.find(m => m.generation === 8 && m.type === 'geometry').geometry.positions.length, 72);
  w.send({ type: 'unloadChunk', x: 0, z: 0 });
  w.send({ type: 'dirty', x: 0, y: 255, z: 0 });
  assert.equal(w.messages.at(-1).type, 'sectionFinished');
});

test('missing noncolliding plants get flowerbeds, flat litter or crosses without altering native models', () => {
  const sourceCross = JSON.stringify(models.dead_bush);
  const prepared = prepareBlockStates(models);
  assert.equal(prepared.wildflowers, models.pink_petals);
  assert.equal(prepared.stone, models.stone);
  assert.equal(models.wildflowers, undefined, 'source assets stay unchanged');
  assert.equal(JSON.stringify(models.dead_bush), sourceCross, 'scaled crosses do not mutate existing plants');
  for (const name of ['wildflowers', 'leaf_litter', 'short_dry_grass', 'tall_dry_grass', 'bush', 'firefly_bush', 'cactus_flower',
    'pale_oak_sapling', 'pale_hanging_moss', 'open_eyeblossom', 'closed_eyeblossom']) assert.ok(prepared[name], name);
  const native = { variants: { native: true } };
  assert.equal(prepareBlockStates({ ...models, leaf_litter: native, wildflowers: native }).leaf_litter, native);
  assert.equal(prepareBlockStates({ ...models, wildflowers: native }).wildflowers, native);
  const registry = {
    blocksArray: ['future_flower', 'solid_flower', 'colliding_flower', 'sensor'].map(name => ({ name, boundingBox: name === 'solid_flower' ? 'block' : 'empty' })),
    blockCollisionShapes: { blocks: { future_flower: 0, solid_flower: 1, colliding_flower: 1, sensor: 0 }, shapes: [[], [[0, 0, 0, 1, 1, 1]]] }
  };
  const future = prepareBlockStates(models, registry);
  assert.ok(future.future_flower);
  assert.equal(future.solid_flower, undefined);
  assert.equal(future.colliding_flower, undefined);
  assert.equal(future.sensor, undefined);
});

test('built worker renders new plants with non-placeholder UVs and their expected heights', () => {
  const w = worker();
  w.send({ type: 'version', version: '1.21.6', generation: 1 });
  w.send({ type: 'blockStates', json: models });
  const heights = { wildflowers: 3 / 16, leaf_litter: 1 / 16, short_dry_grass: 0.5, tall_dry_grass: 1,
    bush: 0.75, firefly_bush: 1, cactus_flower: 6 / 16, pale_oak_sapling: 1, pale_hanging_moss: 1, open_eyeblossom: 1, closed_eyeblossom: 1 };
  for (const [name, height] of Object.entries(heights)) {
    const chunk = new Chunk();
    const stateId = mcData.blocksByName[name].defaultState;
    chunk.setBlockStateId(new Vec3(8, -32, 8), stateId);
    const original = chunk.toJson();
    w.send({ type: 'chunk', x: 0, z: 0, chunk: original });
    w.send({ type: 'dirty', x: 0, y: -32, z: 0 });
    w.flush();
    assert.equal(w.messages.filter(m => m.type === 'error').length, 0, name);
    const { geometry } = w.messages.filter(m => m.type === 'geometry').at(-1);
    assert.ok(geometry.positions.length > 0, `${name} is visible`);
    const ys = Array.from(geometry.positions).filter((_, i) => i % 3 === 1).map(v => v + geometry.sy);
    assert.ok(Math.min(...ys) >= -32 - 1e-6, name);
    assert.ok(Math.max(...ys) <= -32 + height + 1e-6, `${name} uses low/plant geometry`);
    for (let i = 0; i < geometry.uvs.length; i += 2) assert.ok(
      geometry.uvs[i] > 1 / 64 || geometry.uvs[i + 1] > 1 / 64, `${name} does not sample the question-mark tile`);
    assert.equal(chunk.toJson(), original);
    assert.equal(chunk.getBlock(new Vec3(8, -32, 8)).stateId, stateId);
    assert.equal(chunk.getBlock(new Vec3(8, -32, 8)).name, name);
  }
});

test('litter density/facing and wildflower density follow actual block properties', () => {
  const Block = require('prismarine-block')('1.21.6');
  const w = worker();
  w.send({ type: 'version', version: '1.21.6', generation: 1 });
  w.send({ type: 'blockStates', json: models });
  function render(name, properties) {
    const block = Block.fromProperties(name, properties, 0);
    const chunk = new Chunk();
    chunk.setBlockStateId(new Vec3(8, -32, 8), block.stateId);
    w.send({ type: 'chunk', x: 0, z: 0, chunk: chunk.toJson() });
    w.send({ type: 'dirty', x: 0, y: -32, z: 0 });
    w.flush();
    const geometry = w.messages.filter(m => m.type === 'geometry').at(-1).geometry;
    return { geometry, block };
  }
  for (let amount = 1; amount <= 4; amount++) {
    const { geometry, block } = render('leaf_litter', { segment_amount: String(amount), facing: 'north' });
    assert.equal(geometry.positions.length, amount * 2 * 4 * 3, 'two-sided ground patch per segment');
    assert.ok(Array.from(geometry.normals).every((n, i) => i % 3 === 1 || Math.abs(n) < 1e-6), 'only horizontal faces');
    assert.equal(block.name, 'leaf_litter');
    assert.equal(String(block.getProperties().segment_amount), String(amount));
  }
  const north = render('leaf_litter', { segment_amount: '1', facing: 'north' }).geometry;
  const east = render('leaf_litter', { segment_amount: '1', facing: 'east' }).geometry;
  assert.notDeepEqual(Array.from(north.positions), Array.from(east.positions), 'facing rotates the patch');
  assert.ok(render('wildflowers', { flower_amount: '4', facing: 'south' }).geometry.positions.length
    > render('wildflowers', { flower_amount: '1', facing: 'south' }).geometry.positions.length);
});

test('browser bundles exclude Minecraft protocol/recipe/item data and do not need Node globals', () => {
  for (const result of [buildResult.client, buildResult.worker]) {
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(!inputs.some(p => /minecraft-data\/.*\/(protocol|recipes|items|entities|commands|language)\.json$/.test(p)));
    assert.ok(!inputs.some(p => /prismarine-chunk\/src\/bedrock/.test(p)));
    assert.ok(Object.values(result.metafile.outputs).find(p => p.entryPoint).bytes < 3e6);
  }
});

test('WorldRenderer adapter schedules -64..319, unloads full columns, and rejects obsolete worker generations', () => {
  const dispatched = [];
  let handled = 0;
  const fake = {
    workers: [{ postMessage: data => dispatched.push(data), onmessage: () => handled++ }],
    sectionMeshs: {}, loadedChunks: {}, sectionsOutstanding: new Set(), renderUpdateEmitter: new EventEmitter(), scene: { remove() {} },
    resetWorld() { this.sectionMeshs = {}; },
    setSectionDirty(pos, value) { this.sectionsOutstanding.add(`${pos.x},${pos.y},${pos.z}`); dispatched.push({ type: 'dirty', ...pos, value }); }
  };
  client.adaptWorldRenderer(fake);
  fake.addColumn(-16, -16, new Chunk().toJson());
  const ys = dispatched.filter(m => m.type === 'dirty').map(m => m.y);
  assert.equal(Math.min(...ys), -64);
  assert.equal(Math.max(...ys), 304);
  assert.equal(ys.length, 24);
  fake.removeColumn(-16, -16);
  assert.equal(fake.sectionsOutstanding.size, 0);
  fake.resetWorld();
  fake.workers[0].onmessage({ data: { type: 'sectionFinished', key: '0,0,0', generation: 0 } });
  assert.equal(handled, 0);
  fake.workers[0].onmessage({ data: { type: 'sectionFinished', key: '0,0,0', generation: 1 } });
  assert.equal(handled, 1);
});

test('camera modes actually change position and heading; debug draws and clears every overlay', () => {
  const camera = new THREE.PerspectiveCamera();
  const pose = { pos: { x: 10, y: -32, z: 20 }, yaw: 1.2, pitch: 0.4 };
  client.applyCamera(camera, 'first', pose);
  assert.equal(camera.position.x, 10);
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).y > 0);
  client.applyCamera(camera, 'third', pose);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(10, -32, 20)) > 7);
  client.applyCamera(camera, 'top', pose);
  assert.equal(camera.position.y, 16);
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).y < -0.99);
  const overlays = new THREE.Group();
  const min = { x: 0, y: -64, z: 0 }, max = { x: 4, y: -60, z: 4 };
  client.drawDebug(overlays, { path: [min, max], trail: [max, min], goal: min, home: min,
    rooms: [{ min, max }], danger: [{ min, max }], protectionBoxes: [{ min, max }] });
  assert.equal(overlays.children.length, 7);
  client.drawDebug(overlays, {});
  assert.equal(overlays.children.length, 0);
});

test('click protection explains current movement and protection-box rules', () => {
  const block = { name: 'diamond_block', type: 2, stateId: 4340, position: new Vec3(1, -32, 1) };
  const bot = { pathfinder: { movements: { blocksCantBreak: new Set([2]), exclusionBreak: () => Infinity } } };
  const info = blockInfo(bot, block, [{ min: { x: 0, y: -64, z: 0 }, max: { x: 4, y: 0, z: 4 }, reason: '住所保护' }]);
  assert.equal(info.protected, true);
  assert.equal(info.exclusionBreak, 'Infinity');
  assert.match(info.reasons.join(' '), /blocksCantBreak.*exclusionBreak.*住所保护/);
});

test('shared HTTP service streams only loaded chunks, handles reconnect/air/clicks, checks Origin and leaves HTTP alive on close', { timeout: 10000 }, async t => {
  const app = express();
  const server = createServer(app);
  const viewer = createViewerService({ app, server, prefix: '/custom/viewer', viewDistance: 2 });
  const bot = new EventEmitter();
  const chunk = new Chunk();
  const block = { name: 'stone', type: 1, stateId: 1, position: new Vec3(8, -32, 8) };
  let providerCalls = 0;
  bot.username = 'ViewerTest'; bot.version = '1.21.6'; bot.entity = { position: new Vec3(8, -32, 8), yaw: 0, pitch: 0 };
  bot.entities = { 1: { id: 1, name: 'pig', position: new Vec3(1, -32, 1), width: 0.9, height: 0.9 } };
  bot.world = { getColumnAt() { providerCalls++; throw new Error('must not call async provider'); },
    sync: { getColumnAt: pos => pos.x === 0 && pos.z === 0 ? chunk : null, raycast: () => block } };
  bot.pathfinder = { movements: { blocksCantBreak: new Set([1]), exclusionBreak: () => 0 } };
  app.get('/health', (req, res) => res.send('ok'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let socket;
  t.after(async () => { socket?.disconnect(); viewer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  assert.equal(viewer.attach(bot).available, true);
  assert.equal((await fetch(`${base}/custom/viewer/`)).status, 200);
  assert.match(await (await fetch(`${base}/custom/viewer/`)).text(), /custom\/viewer\/socket.io/);
  const jsResponse = await fetch(`${base}/custom/viewer/web-viewer.js`);
  assert.equal(jsResponse.status, 200);
  await jsResponse.arrayBuffer();
  const modelsResponse = await fetch(`${base}/custom/viewer/blocksStates/1.21.4.json`);
  assert.equal(modelsResponse.status, 200);
  await modelsResponse.arrayBuffer();
  const rejected = await fetch(`${base}/custom/viewer/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://unrelated.invalid' } });
  assert.equal(rejected.status, 403);
  socket = io(base, { path: '/custom/viewer/socket.io', transports: ['polling', 'websocket'], extraHeaders: { Origin: base }, autoConnect: false, reconnection: false });
  const events = [];
  socket.onAny((name, payload) => events.push({ name, payload }));
  socket.connect();
  await once(socket, 'connect');
  await waitFor(() => events.some(e => e.name === 'loadChunk'));
  await waitFor(() => socket.io.engine.transport.name === 'websocket');
  assert.equal(providerCalls, 0);
  assert.equal(events.find(e => e.name === 'world').payload.version, '1.21.6');
  assert.ok(events.findIndex(e => e.name === 'world') < events.findIndex(e => e.name === 'entity'));
  const updated = once(socket, 'blockUpdate');
  bot.emit('blockUpdate', block, { ...block, stateId: 0 });
  assert.equal((await updated)[0].stateId, 0);
  const clicked = once(socket, 'block-info');
  socket.emit('mouseClick', { origin: bot.entity.position, direction: { x: 0, y: 0, z: -1 } });
  assert.equal((await clicked)[0].protected, true);
  const debugged = once(socket, 'debug');
  viewer.updateDebug({ protectionBoxes: [{ reason: 'test' }] });
  assert.equal((await debugged)[0].protectionBoxes[0].reason, 'test');
  bot.emit('respawn');
  await waitFor(() => events.filter(e => e.name === 'world').length === 2);
  assert.equal(bot.listenerCount('blockUpdate'), 1);
  socket.disconnect();
  await waitFor(() => bot.listenerCount('blockUpdate') === 0);
  socket.connect();
  await once(socket, 'connect');
  await waitFor(() => bot.listenerCount('blockUpdate') === 1);
  const reset = once(socket, 'reset');
  bot.emit('end');
  await reset;
  assert.equal(viewer.status().available, false);
  assert.equal(bot.listenerCount('move'), 0);
  viewer.close();
  assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
  assert.equal(server.listenerCount('upgrade'), 0);
});

async function waitFor(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for viewer event');
}
