import { Vec3 } from 'vec3';
import { loadStrategyState } from '../strategy/state.js';
import { developmentStatus } from '../strategy/development.js';
import { readDanger } from '../strategy/danger.js';
import { listHouseProjects, projectShellPlan } from '../building/projects.js';
import { testProgress } from '../../scripts/survival-progress.mjs';

const point = (p) => p ? { x: p.x, y: p.y, z: p.z } : null;

// Only loaded blocks contribute to a known shortage. Temporary shell blocks
// count as shelter, but still need replacement to reach the final design.
export function constructionMaterials(blocks, inventory, facilities, targets) {
  const required = new Map();
  const add = (name, count) => { if (count > 0) required.set(name, (required.get(name) || 0) + count); };
  for (const { entry, block } of blocks) {
    if (block && block.name !== entry.targetItem) add(entry.targetItem, 1);
  }
  for (const [facility, name] of Object.entries({ beds: 'bed', chests: 'chest', furnaces: 'furnace', craftingTables: 'crafting_table' })) {
    add(name, Math.max(0, targets[facility] - facilities[facility]));
  }
  return [...required].map(([name, needed]) => {
    const current = inventory.filter(item => name === 'bed' ? item.name.endsWith('_bed') : item.name === name)
      .reduce((sum, item) => sum + item.count, 0);
    return { name, label: name, current, required: needed, missing: Math.max(0, needed - current) };
  });
}

const EXPECTED_WAITS = new Set(['night', 'maintain', 'bind_home', 'supply_wait', 'recover']);
const TWO_GAME_DAYS = 48000;

export function trackTaskProgress(previous, { activeTask, tick, fingerprint, waiting }) {
  if (!activeTask || !Number.isFinite(tick)) return null;
  if (waiting) return previous && { ...previous, tick, waiting: true, newStall: false };
  const same = previous?.task === activeTask && previous.fingerprint === fingerprint && tick >= previous.tick;
  // Age measures server ticks without sleeping or /time jumping the counter.
  const elapsed = same ? previous.elapsed + (previous.waiting ? 0 : Math.min(100, tick - previous.tick)) : 0;
  return { task: activeTask, tick, fingerprint, elapsed, waiting: false,
    stalled: elapsed >= TWO_GAME_DAYS,
    newStall: elapsed >= TWO_GAME_DAYS && !previous?.stalled };
}

export function createObserver(actions) {
  let bot;
  let connected = false;
  let savedState;
  let projects = [];
  let lastProjectsAt = 0;
  let lastProgressAt = Date.now();
  let taskProgress;
  let path = [];
  let trail = [];
  let navigation = null;
  let detach = () => {};
  let lastSnapshot = { connected: false, inventory: [], chests: [], failures: {} };

  async function attach(nextBot) {
    detach();
    bot = nextBot;
    connected = true;
    savedState = await loadStrategyState(bot);
    if (bot !== nextBot) return;
    lastProjectsAt = 0;
    taskProgress = null;
    lastProgressAt = Date.now();
    trail = [];
    path = [];
    const moved = () => {
      const p = nextBot.entity?.position;
      if (p && (!trail.length || p.distanceTo(trail.at(-1)) >= 1)) {
        trail.push(point(p));
        trail = trail.slice(-600);
      }
    };
    const planned = (result) => {
      path = (result.path || []).map((node) => ({ ...point(node),
        toBreak: (node.toBreak || []).map(point), toPlace: (node.toPlace || []).map(point) }));
      navigation = { status: result.status, visitedNodes: result.visitedNodes, at: Date.now() };
    };
    const ended = () => { if (bot === nextBot) connected = false; };
    nextBot.on('move', moved);
    nextBot.on('path_update', planned);
    nextBot.on('end', ended);
    detach = () => {
      nextBot.removeListener('move', moved);
      nextBot.removeListener('path_update', planned);
      nextBot.removeListener('end', ended);
    };
    moved();
  }

  async function sample(run = {}) {
    if (!connected || !bot?.entity) return { ...lastSnapshot, connected: false };
    const current = bot;
    let state = bot.strategySupervisor?.active ? bot.strategySupervisor.state
      : bot.supplySupervisor?.state || bot.supplyState || bot.strategySupervisor?.state || savedState;
    if (state.partition?.dimension !== String(bot.game.dimension)) {
      savedState = await loadStrategyState(bot);
      state = savedState;
      lastProjectsAt = 0;
    }
    if (Date.now() - lastProjectsAt > 3000) {
      projects = await listHouseProjects(bot);
      lastProjectsAt = Date.now();
    }
    if (bot !== current || !connected) return { ...lastSnapshot, connected: false };
    const inventory = bot.inventory.items().map((item) => ({ name: item.name, count: item.count,
      durabilityUsed: item.durabilityUsed || 0, maxDurability: item.maxDurability || null }));
    const chests = [state.storage, ...(state.archivedStorage || [])].filter(Boolean).flatMap((storage) =>
      (storage.chests || []).map((chest) => ({ id: chest.id, position: chest.position, dimension: storage.dimension,
        archived: storage !== state.storage, missing: !!chest.missing, observedAt: chest.observedAt || null,
        stale: !chest.observedAt || Date.now() - chest.observedAt > 120000,
        verificationError: chest.verificationError || null, items: chest.snapshot || null })));
    const project = projects.find((entry) => entry.id === (state.house?.projectId || state.activeHouseProjectId));
    let construction = null;
    if (project) {
      const origin = new Vec3(project.origin.x, project.origin.y, project.origin.z);
      const shell = projectShellPlan(project);
      const blocks = shell.map((entry) => ({ entry, block: bot.blockAt(origin.offset(...entry.offset)) }));
      const furniture = { beds: 0, chests: 0, furnaces: 0, craftingTables: 0 };
      for (let x = 1; x < project.model.size.width - 1; x++) for (let z = 1; z < project.model.size.depth - 1; z++) {
        const block = bot.blockAt(origin.offset(x, 1, z));
        if (block?.name === 'chest') furniture.chests++;
        if (block?.name === 'furnace') furniture.furnaces++;
        if (block?.name === 'crafting_table') furniture.craftingTables++;
        if (block?.name.endsWith('_bed') && block.getProperties().part === 'foot') furniture.beds++;
      }
      const facilityTargets = { beds: 1, chests: state.developmentConfig?.homeChests || 4,
        furnaces: Math.max(1, project.model.furniture.furnaces), craftingTables: 1 };
      construction = { projectId: project.id, model: project.model.name, origin: project.origin,
        matched: blocks.filter(({ entry, block }) => entry.acceptedItems.includes(block?.name)).length,
        total: shell.length, unknown: blocks.filter(({ block }) => !block).length,
        finishingPending: !!project.construction?.finishingPending, facilities: furniture,
        facilityTargets, materials: constructionMaterials(blocks, inventory, furniture, facilityTargets) };
    }
    const danger = bot.strategySupervisor?.active ? bot.strategySupervisor.danger || readDanger(bot) : readDanger(bot);
    const running = actions.tasks.current;
    const activeGoal = bot.strategySupervisor?.goal || (running?.kind === 'autonomy' ? state.lastGoal?.goal : null);
    const wait = bot.isSleeping || danger.retreat || EXPECTED_WAITS.has(activeGoal)
      || (running?.kind === 'autonomy' && !activeGoal);
    const position = bot.entity.position.floored();
    const actual = JSON.stringify([point(position), inventory, construction?.matched,
      construction?.facilities, state.farm?.harvestCycles, state.base?.ready,
      chests.map(chest => chest.items)]);
    const previous = taskProgress;
    taskProgress = trackTaskProgress(previous, { activeTask: running && `${state.partition?.dimension}:${running.id}:${activeGoal ?? running.kind}`,
      tick: bot.time?.age, fingerprint: actual, waiting: wait });
    if (!taskProgress?.elapsed) lastProgressAt = Date.now();
    const home = state.home;
    const homeVerified = !!home?.door && bot.blockAt(new Vec3(home.x, home.y - 1, home.z))?.boundingBox === 'block'
      && bot.blockAt(new Vec3(home.x, home.y, home.z))?.boundingBox === 'empty'
      && bot.blockAt(new Vec3(home.x, home.y + 1, home.z))?.boundingBox === 'empty'
      && !!bot.blockAt(new Vec3(home.door.x, home.door.y, home.door.z))?.name.endsWith('_door');
    const status = { ...run, inventory, equipment: [5, 6, 7, 8, 45].map((slot) => ({ name: bot.inventory.slots[slot]?.name })),
      home: state.home, house: state.house, base: state.base, farm: state.farm, chestContents: chests,
      development: state.development, developmentCheck: developmentStatus(bot, state), failures: state.failures,
      lastFailure: state.lastGoal, worldTime: bot.time?.time, homeVerified };
    const goal = bot.pathfinder?.goal;
    const secondsWithoutProgress = Math.floor((Date.now() - lastProgressAt) / 1000);
    lastSnapshot = { connected: true, observedAt: new Date().toISOString(),
      agent: { name: bot.username, position: point(bot.entity.position), dimension: String(bot.game.dimension),
        health: bot.health, food: bot.food, oxygen: bot.ownOxygen ?? bot.oxygenLevel ?? null,
        version: bot.version, timeOfDay: bot.time?.timeOfDay, worldDay: bot.time?.day,
        observedDays: run.observedCalendarTicks == null ? null : run.observedCalendarTicks / 24000, deaths: run.deaths ?? null },
      task: { label: actions.tasks.current?.label || '空闲', progress: actions.tasks.current?.progress || '',
        goal: activeGoal, stage: running?.stage || null, source: running?.source || null },
      progress: testProgress(status), inventory, chests, construction, danger, failures: state.failures || {},
      home: state.home, farm: state.farm, base: state.base, nightShelter: state.nightShelter,
      diagnostics: { navigation, failure: bot.navigationFailure || null,
        homeApproachFailure: state.homeApproachFailure || null, secondsWithoutProgress,
        trackingProgress: Boolean(taskProgress && !taskProgress.waiting), ticksWithoutProgress: taskProgress?.elapsed ?? null,
        stalled: Boolean(taskProgress?.stalled && !taskProgress.waiting), newStall: Boolean(taskProgress?.newStall),
        path, trail, goal: Number.isFinite(goal?.x) ? point(goal) : null },
      rooms: Object.values(state.buildingRooms || {}).flat() };
    return lastSnapshot;
  }

  return { attach, sample, close() { detach(); connected = false; } };
}
