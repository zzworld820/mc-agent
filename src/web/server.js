import express from 'express';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createObserver } from './observer.js';
import { createWebController } from './controller.js';
import { createAgentJournal } from './journal.js';
import { createProjectDashboard } from './projects.js';
import { createViewerService } from './viewer.js';

const require = createRequire(import.meta.url);

function mountInventoryTextures(app) {
  const assetRoot = require.resolve('prismarine-viewer/package.json').replace(/package\.json$/, 'public/');
  const states = require(assetRoot + 'blocksStates/1.21.4.json');
  const tiles = {};
  for (const [name, state] of Object.entries(states)) {
    const variant = Object.values(state.variants || {})[0];
    const model = (Array.isArray(variant) ? variant[0] : variant)?.model;
    const tile = model?.textures?.front || model?.textures?.particle;
    if (tile && tile.su > 0 && tile.sv > 0) tiles[name] = [tile.u, tile.v, tile.su, tile.sv];
  }
  app.get('/api/item-tiles', (req, res) => res.set('Cache-Control', 'public, max-age=86400').json(tiles));
  app.get('/item-atlas.png', (req, res) => res.sendFile(assetRoot + 'textures/1.21.4.png', { maxAge: '1d' }));
}

function mountAgent(app, server, { id, actions, llm, npc, controller: sharedController, options = {} }, settings, legacy) {
  const router = express.Router();
  const clients = new Set();
  const observer = createObserver(actions);
  const controller = sharedController ?? createWebController({ actions, llm, npc,
    storageDirectory: options.controllerDirectory ?? new URL('../../data/web/', import.meta.url),
    priorities: { temporary: settings.temporaryPriority, primary: settings.primaryPriority } });
  const projects = createProjectDashboard({ npc, llm, controller, actions, storage: options.projectStorage });
  const viewer = createViewerService({ app, server, viewDistance: settings.viewDistance, prefix: legacy ? '/viewer' : `/viewers/${id}` });
  let snapshot = { connected: false, inventory: [], chests: [], failures: {}, viewer: viewer.status() };
  let projectSnapshot = null;
  let sampling = false;
  let closed = false;
  const secret = llm.apiKey || '';
  const safe = (value) => {
    if (typeof value === 'string') return secret ? value.replaceAll(secret, '[已隐藏]') : value;
    if (Array.isArray(value)) return value.map(safe);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['apiKey', 'password', 'authorization'].includes(key)).map(([key, item]) => [key, safe(item)]));
    return value;
  };
  const journal = createAgentJournal(id, options.journalDirectory, safe);
  let detachJournal = () => {};
  const state = () => {
    const { messages, ...missions } = controller.snapshot();
    return safe({ ...snapshot, projects: projectSnapshot, missions, messages, incidents: journal.snapshot(), viewer: viewer.status() });
  };
  function broadcast() {
    const payload = `event: state\ndata: ${JSON.stringify(state())}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 262144) { client.end(); clients.delete(client); }
      else client.write(payload);
    }
  }
  async function sample() {
    if (sampling || closed) return;
    sampling = true;
    try {
      projectSnapshot = await projects.snapshot();
      snapshot = await observer.sample(options.getRunStatus?.() || {});
      if (snapshot.connected && snapshot.diagnostics?.newStall) {
        await journal.record({ type: 'stall', goal: snapshot.task.goal ?? snapshot.task.label,
          reason: '两个实际游戏日没有可验证进展',
          position: snapshot.agent.position, world: snapshot.agent.dimension });
      }
      viewer.updateDebug({ ...snapshot.diagnostics, home: snapshot.home, rooms: snapshot.rooms, danger: snapshot.danger });
      broadcast();
    } catch (error) {
      snapshot = { ...snapshot, observationError: safe(error.message) };
      broadcast();
    } finally { sampling = false; }
  }
  router.get('/state', (req, res) => res.json(state()));
  router.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    req.on('close', () => clients.delete(res));
  });
  const post = (route, work) => router.post(route, async (req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ error: '请使用 JSON 请求' });
    try { res.status(202).json(await work(req.body || {}) || { ok: true }); }
    catch (error) { next(error); }
  });
  post('/chat', ({ message, mode = 'chat' }) => {
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw new Error('消息应为1至4000个字符');
    if (!['chat', 'task'].includes(mode)) throw new Error('消息模式无效');
    return controller.send(message.trim(), mode);
  });
  post('/temporary/cancel', ({ id }) => controller.cancelTemporary(id));
  const projectPost = (path, work) => post(path, async data => {
    const response = await work(data);
    projectSnapshot = await projects.snapshot();
    broadcast();
    return safe(response);
  });
  projectPost('/projects', projects.create);
  projectPost('/projects/action', projects.operate);
  post('/primary', ({ operation }) => controller.setPrimary(operation));
  post('/priorities', (priorities) => controller.setPriorities(priorities));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 413 ? 413 : 400).json({ error: safe(error.message || '网页请求处理失败') });
  });
  app.use(`/api/agents/${id}`, router);
  if (legacy) app.use('/api', router);
  const unsubscribe = controller.subscribe(broadcast);
  const unsubscribeTasks = actions.tasks.onSettled(({ task, ok, aborted, result }) => {
    if (!aborted && !ok && task.kind !== 'autonomy') {
      journal.record({ type: 'failure', goal: task.label, reason: result, result: '任务结束，等待重新安排' });
    }
  });
  const timer = setInterval(sample, 1000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); });
  return {
    async attach(bot) {
      detachJournal();
      const record = event => journal.record({ ...event, world: bot.memory?.worldId || bot.buildingServer,
        dimension: String(bot.game?.dimension), position: bot.entity?.position });
      bot.on('agentIncident', record);
      detachJournal = () => bot.removeListener('agentIncident', record);
      projects.attach(bot);
      await observer.attach(bot);
      if (!sharedController) await controller.attach(bot);
      await viewer.attach(bot);
      await sample();
    },
    state,
    async close() {
      closed = true;
      clearInterval(timer); unsubscribe(); unsubscribeTasks(); detachJournal(); observer.close();
      await journal.flush();
      for (const client of clients) client.end();
      clients.clear();
      if (!sharedController) await controller.close();
      await viewer.close();
    },
  };
}


export async function startWebService({ actions, llm, npc, agents, options = {} }) {
  const settings = { host: '127.0.0.1', port: 3000, viewDistance: 3, temporaryPriority: 80, primaryPriority: 50, ...options };
  const app = express();
  const server = createServer(app);
  const roster = agents ?? [{ id: 'default', actions, llm, npc, options }];
  const entries = new Map();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: '请求来源与网页服务不一致' }); }
      catch { return res.status(403).json({ error: '请求来源无效' }); }
    }
    next();
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  mountInventoryTextures(app);
  app.get('/api/agents', (req, res) => res.json(roster.map(({ id, llm, npc }) => {
    const snapshot = entries.get(id).state();
    return { id, name: npc.name, connected: snapshot.connected, model: llm.model, modelConfigured: Boolean(llm.apiKey) };
  })));
  for (const [index, profile] of roster.entries()) {
    entries.set(profile.id, mountAgent(app, server, profile, settings, index === 0));
  }
  app.use(express.static(fileURLToPath(new URL('./public/', import.meta.url)), { index: 'index.html', dotfiles: 'deny' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 413 ? 413 : 400).json({ error: '网页请求格式无效或超过大小限制' });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(settings.port, settings.host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    await Promise.all([...entries.values()].map(entry => entry.close()));
    throw error;
  }
  const first = entries.get(roster[0].id);
  return {
    url: `http://${settings.host}:${server.address().port}`,
    state: first.state,
    async attach(bot, id = roster[0].id) {
      const entry = entries.get(id);
      if (!entry) throw new Error('Agent 档案不存在');
      await entry.attach(bot);
    },
    async close() {
      await Promise.all([...entries.values()].map(entry => entry.close()));
      await new Promise(resolve => server.close(resolve));
    },
  };
}
