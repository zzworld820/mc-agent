import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
const WORLD_VERSION = '1.21.6';
const ASSET_VERSION = '1.21.4';

/**
 * Mount on an existing Express app/http server; never listens or closes the server.
 * Current browser meshing build supports Java 1.21.6 (assets use 1.21.4).
 * available means built assets and an attached, spawned bot are ready.
 * Debug fields are partial updates; null/[] clears a field. Positions are {x,y,z}.
 */
export function createViewerService({ app, server, prefix = '/viewer', viewDistance = 3 }) {
  prefix = `/${String(prefix).split('/').filter(Boolean).join('/')}`.replace(/\/$/, '');
  const url = `${prefix}/`;
  const socketPath = `${prefix}/socket.io`;
  viewDistance = Math.max(1, Math.min(16, Math.floor(Number(viewDistance) || 3)));
  let bot = null;
  let closed = false;
  let failure = null;
  let io, engine, router, WorldView;
  let cleanupBot = () => {};
  const sessions = new Map();
  let debug = { path: [], trail: [], goal: null, home: null, rooms: [], danger: [], protectionBoxes: [] };
  const buildError = () => ['web-viewer.js', 'worker.js'].every(f => existsSync(resolve(dist, f)))
    ? null : 'Viewer 尚未构建，请运行 node scripts/build-web.mjs';
  const ready = () => Boolean(bot?.world && bot?.entity?.position);
  const status = () => {
    const error = closed ? 'Viewer 已关闭' : failure || buildError()
      || (bot && bot.version !== WORLD_VERSION ? `Viewer 当前仅支持 Java ${WORLD_VERSION}，收到 ${bot.version}` : null)
      || (!ready() ? '等待机器人进入世界' : null);
    return { available: !error, url, error };
  };
  const announce = () => io?.emit('viewerStatus', status());
  const fail = error => { failure = `Viewer: ${error.message || error}`; announce(); };

  function stopSession(socket) {
    const session = sessions.get(socket);
    if (!session) return;
    session.stopped = true;
    session.view.loadChunk = async () => {};
    session.view.removeListenersFromBot(session.bot);
    socket.off('mouseClick', session.click);
    sessions.delete(socket);
  }

  function startSession(socket) {
    stopSession(socket);
    socket.emit('reset');
    socket.emit('viewerStatus', status());
    if (!status().available) return;
    // WorldView only reads columns already present in bot.world. getColumnAt's
    // synchronous facade prevents a world generator/provider from loading more.
    const attached = bot;
    const source = attached.world;
    const readWorld = source.sync || source;
    const world = { getColumnAt: pos => readWorld.getLoadedColumnAt
      ? readWorld.getLoadedColumnAt(pos) : readWorld.getColumnAt(pos) };
    const view = new WorldView(world, viewDistance, attached.entity.position, socket);
    const session = { view, bot: attached, stopped: false, moving: false, pending: false };
    sessions.set(socket, session);
    // Replace its unvalidated async click listener with a read-only, bounded ray.
    socket.off('mouseClick', socket.listeners('mouseClick').at(-1));
    const { Vec3 } = require('vec3');
    let lastClick = 0;
    session.click = async click => {
      if (session.stopped || Date.now() - lastClick < 100) return;
      if (![click?.origin, click?.direction].every(p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 3e7))) return;
      lastClick = Date.now();
      try {
        const origin = new Vec3(click.origin.x, click.origin.y, click.origin.z);
        const direction = new Vec3(click.direction.x, click.direction.y, click.direction.z);
        if (direction.norm() < 0.001 || origin.distanceTo(attached.entity.position) > 512) return;
        const hit = await (source.sync || source).raycast(origin, direction.normalize(), 256);
        if (!session.stopped && hit) view.emit('blockClicked', hit, hit.face, 0);
      } catch (error) { if (!session.stopped) socket.emit('block-info', { error: error.message }); }
    };
    socket.on('mouseClick', session.click);
    view.on('blockClicked', block => socket.emit('block-info', blockInfo(attached, block, debug.protectionBoxes)));
    view.loadChunk = async pos => {
      if (session.stopped) return;
      if (Math.abs(Math.floor(pos.x / 16) - Math.floor(view.lastPos.x / 16)) >= viewDistance
        || Math.abs(Math.floor(pos.z / 16) - Math.floor(view.lastPos.z / 16)) >= viewDistance) return;
      try {
        const column = world.getColumnAt(pos);
        // A supplied async provider must never generate/load columns for viewing.
        if (!column || typeof column.then === 'function') return;
        socket.emit('loadChunk', { x: pos.x, z: pos.z, chunk: column.toJson() });
        view.loadedChunks[`${pos.x},${pos.z}`] = true;
      } catch (error) { if (!session.stopped) fail(error); }
    };
    socket.emit('world', { version: attached.version, assetVersion: ASSET_VERSION, viewDistance });
    // WorldView 1.33's blockUpdate drops stateId=0; preserve actual air updates.
    view.listenToBot(attached);
    const listeners = view.listeners[attached.username];
    attached.removeListener('blockUpdate', listeners.blockUpdate);
    listeners.blockUpdate = (oldBlock, newBlock) => {
      const pos = newBlock?.position || oldBlock?.position;
      if (pos && Number.isInteger(newBlock?.stateId)) socket.emit('blockUpdate', { pos, stateId: newBlock.stateId });
    };
    attached.on('blockUpdate', listeners.blockUpdate);
    socket.emit('debug', debug);
    sendPosition(socket);
    view.init(attached.entity.position).catch(fail);
  }

  function sendPosition(socket) {
    if (!ready()) return;
    const e = bot.entity;
    socket.emit('position', { pos: e.position, yaw: e.yaw || 0, pitch: e.pitch || 0,
      height: e.height || 1.8, width: e.width || 0.6 });
  }

  async function moveSession(socket, session) {
    sendPosition(socket);
    session.pending = true;
    if (session.moving) return;
    session.moving = true;
    try {
      while (session.pending && !session.stopped) {
        session.pending = false;
        await session.view.updatePosition(session.bot.entity.position);
      }
    } catch (error) { if (!session.stopped) fail(error); }
    finally { session.moving = false; }
  }

  try {
    const express = require('express');
    const { Server } = require('socket.io');
    const { Server: Engine } = require('engine.io');
    ({ WorldView } = require('prismarine-viewer/viewer/lib/worldView.js'));
    const assets = resolve(dirname(require.resolve('prismarine-viewer/package.json')), 'public');
    if (!existsSync(resolve(assets, `blocksStates/${ASSET_VERSION}.json`))
      || !existsSync(resolve(assets, `textures/${ASSET_VERSION}.png`))) throw new Error('本地 Viewer 素材缺失');
    router = express.Router();
    app.use(prefix || '/', (req, res, next) => closed ? next() : router(req, res, next));
    // Bind Engine.IO ourselves, avoiding Socket.IO.attach's replacement of the
    // shared server request listener and Socket.IO.close's httpServer.close().
    engine = new Engine({ maxHttpBufferSize: 1e6, allowRequest(req, done) {
      if (!req.headers.origin) return done(null, true);
      try { done(null, new URL(req.headers.origin).host === req.headers.host); }
      catch { done(null, false); }
    } });
    io = new Server({ serveClient: false });
    io.bind(engine);
    router.use('/socket.io', (req, res) => engine.handleRequest(req, res));
    server.on('upgrade', upgrade);
    server.on('close', close);
    router.get('/', (req, res) => {
      if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(308, url);
      res.type('html').send(viewerHtml(socketPath));
    });
    router.get('/status', (req, res) => res.json(status()));
    for (const filename of ['web-viewer.js', 'worker.js']) {
      router.get(`/${filename}`, (req, res) => {
        if (buildError()) return res.status(503).type('text').send(buildError());
        res.set('Cache-Control', 'no-cache').sendFile(resolve(dist, filename));
      });
    }
    router.use('/textures', express.static(resolve(assets, 'textures'), { maxAge: '1d', index: false }));
    router.use('/blocksStates', express.static(resolve(assets, 'blocksStates'), { maxAge: '1d', index: false }));
    io.on('connection', socket => {
      startSession(socket);
      socket.on('disconnect', () => stopSession(socket));
    });
  } catch (error) { fail(error); }

  function upgrade(req, socket, head) {
    if (!closed && req.url.split('?')[0] === `${socketPath}/`) engine.handleUpgrade(req, socket, head);
  }

  function attach(nextBot) {
    if (closed) return status();
    for (const socket of sessions.keys()) stopSession(socket);
    cleanupBot();
    bot = nextBot || null;
    if (!bot) {
      io?.emit('reset');
      announce();
      return status();
    }
    const attached = bot;
    const restart = () => {
      // Mineflayer resets columns on respawn/changed dimension. Each socket gets
      // a fresh WorldView, worker generation and initial loaded-column snapshot.
      for (const socket of io?.sockets.sockets.values() || []) startSession(socket);
      announce();
    };
    const move = () => { for (const [socket, session] of sessions) void moveSession(socket, session); };
    const unload = pos => { for (const session of sessions.values()) session.view.unloadChunk(pos); };
    const end = () => { if (bot === attached) attach(null); };
    attached.on('spawn', restart);
    attached.on('respawn', restart);
    attached.on('move', move);
    attached.on('chunkColumnUnload', unload);
    attached.on('end', end);
    cleanupBot = () => {
      for (const [event, listener] of [['spawn', restart], ['respawn', restart], ['move', move], ['chunkColumnUnload', unload], ['end', end]]) attached.removeListener(event, listener);
    };
    restart();
    return status();
  }

  function updateDebug(patch = {}) {
    for (const key of ['path', 'trail', 'goal', 'home', 'rooms', 'danger', 'protectionBoxes']) {
      if (Object.hasOwn(patch, key)) debug[key] = patch[key];
    }
    io?.emit('debug', debug);
  }

  function close() {
    if (closed) return;
    closed = true;
    cleanupBot();
    for (const socket of sessions.keys()) stopSession(socket);
    io?.disconnectSockets(true);
    io?.removeAllListeners();
    engine?.close();
    server.removeListener('upgrade', upgrade);
    server.removeListener('close', close);
    bot = null;
    debug = {};
  }

  return { attach, status, updateDebug, close };
}

export function blockInfo(bot, block, protectionBoxes = []) {
  const movement = bot.pathfinder?.movements || bot.movement;
  const reasons = [];
  if (movement?.blocksCantBreak?.has(block.type)) reasons.push(`blocksCantBreak 禁挖：${block.name}`);
  let exclusion = 0;
  try {
    exclusion = movement?.exclusionBreak?.(block) || 0;
    if (exclusion >= 100) reasons.push(`exclusionBreak 保护区域（${exclusion === Infinity ? 'Infinity' : exclusion}）`);
    else if (exclusion > 0) reasons.push(`exclusionBreak 挖掘代价 +${exclusion}`);
  } catch { reasons.push('保护规则无法计算'); }
  const boxes = Array.isArray(protectionBoxes) ? protectionBoxes : Object.values(protectionBoxes || {});
  let protectedBox = false;
  for (const box of boxes) {
    const min = box.min || box.start || box.bounds?.min;
    const max = box.max || box.end || box.bounds?.max;
    const p = block.position;
    if (min && max && ['x', 'y', 'z'].every(k => p[k] >= min[k] && p[k] <= max[k])) {
      protectedBox = true;
      reasons.push(String(box.reason || box.label || box.name || '保护范围'));
    }
  }
  if (movement?.canDig === false) reasons.push('当前 movement.canDig=false');
  return { name: block.name, displayName: block.displayName, position: { x: block.position.x, y: block.position.y, z: block.position.z },
    stateId: block.stateId, protected: Boolean(movement?.blocksCantBreak?.has(block.type) || exclusion >= 100 || protectedBox || movement?.canDig === false),
    exclusionBreak: Number.isFinite(exclusion) ? exclusion : String(exclusion), reasons };
}

function viewerHtml(socketPath) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Minecraft 3D Viewer</title><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#14212d;color:#fff;font:13px system-ui}canvas{display:block;width:100%;height:100%}#status{position:absolute;left:10px;top:10px;padding:7px 10px;border-radius:6px;background:#10202bcb;pointer-events:none;max-width:85%}nav{position:absolute;bottom:10px;left:10px;display:flex;gap:5px}button{background:#10202bdd;color:white;border:1px solid #6c849a;border-radius:5px;padding:6px 10px;cursor:pointer}button[aria-pressed=true]{background:#286b9c}
</style></head><body><div id="status" role="status">连接真实世界…</div><nav aria-label="相机"><button data-camera="first">第一人称</button><button data-camera="third" aria-pressed="true">第三人称</button><button data-camera="top">俯视</button></nav><script id="viewer-config" type="application/json">${JSON.stringify({ socketPath }).replace(/</g, '\\u003c')}</script><script src="web-viewer.js" defer></script></body></html>`;
}
