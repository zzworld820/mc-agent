import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { goTo, haltBot, useMovementProfile, indoorRoomStepCost } from '../src/actions/helpers.js';
import { loadStrategyState } from '../src/strategy/state.js';

// Read-only inspection of the exact live-world target that stalled base setup.
export function inspectConstructionAccess(bot, target = new Vec3(0, 71, 31)) {
  const { goals } = pathfinderPkg;
  useMovementProfile(bot, 'safe');
  const inspect = (p) => {
    const block = bot.blockAt(p);
    return { position: p, name: block?.name ?? 'unloaded', stateId: block?.stateId,
      boundingBox: block?.boundingBox, shapes: block?.shapes };
  };
  const goal = new goals.GoalCompositeAny([
    new goals.GoalLookAtBlock(target, bot.world, { reach: 4.5 }),
    new goals.GoalGetToBlock(target.x, target.y, target.z),
  ]);
  const plan = (goal) => {
    const route = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, 250);
    return { status: route.status, visitedNodes: route.visitedNodes,
      path: route.path.map(({ x, y, z }) => ({ x, y, z })) };
  };
  const candidates = [];
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
    const p = target.offset(x, 1, z);
    if (bot.blockAt(p)?.boundingBox !== 'empty' || bot.blockAt(p.offset(0, 1, 0))?.boundingBox !== 'empty'
      || bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') continue;
    candidates.push({ position: p, satisfiesMiningGoal: goal.isEnd(p),
      walking: plan(new goals.GoalBlock(p.x, p.y, p.z)) });
  }
  const from = bot.entity.position.offset(0, 1.6, 0);
  const rays = [[.5, 1, .5], [1, .5, .5], [0, .5, .5], [.5, .5, 1], [.5, .5, 0]].map((offset) => {
    const face = target.offset(...offset);
    const hit = bot.world.raycast(from, face.minus(from).normalize(), 4.5);
    return { face, hit: hit ? inspect(hit.position) : null };
  });
  const blocks = [];
  for (let x = -2; x <= 8; x++) for (let z = 27; z <= 37; z++) for (let y = 69; y <= 76; y++) {
    blocks.push(inspect(new Vec3(x, y, z)));
  }
  return { at: new Date().toISOString(), position: bot.entity.position, target: inspect(target),
    above: inspect(target.offset(0, 1, 0)), currentSatisfiesGoal: goal.isEnd(bot.entity.position.floored()),
    miningRoute: plan(goal), candidates, rays, blocks };
}

export async function verifyIndoorWorkRoute(bot) {
  const state = await loadStrategyState(bot);
  const home = state.home;
  const rooms = state.buildingRooms?.[home?.projectId] || [];
  const contains = (p, room) => p.x >= room.origin.x + 1 && p.x < room.origin.x + room.size.width - 1
    && p.z >= room.origin.z + 1 && p.z < room.origin.z + room.size.depth - 1
    && Math.abs(p.y - room.origin.y - 1) < .3;
  const room = rooms.find(room => contains(bot.entity.position, room) && contains(home, room));
  if (!room || home.dimension !== String(bot.game.dimension)) return { result: 'SKIP', reason: '当前不在已登记的自有房间内' };
  const before = bot.entity.position.clone();
  const oldSupervisor = bot.strategySupervisor;
  const controller = new AbortController();
  const health = bot.health;
  const stopOnDamage = () => { if (bot.health < health) controller.abort('室内通道验证时受到伤害，停止验证'); };
  bot.on('health', stopOnDamage);
  bot.strategySupervisor = { active: true, state };
  useMovementProfile(bot, 'safe');
  bot.pathfinder.movements.exclusionAreasStep.push(block => indoorRoomStepCost(block.position, room));
  const costs = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const p = before.floored().offset(dx, 0, dz);
    if (contains(p, room)) costs.push({ position: p, cost: bot.pathfinder.movements.exclusionStep(bot.pathfinder.movements.getBlock(p, 0, 0, 0)) });
  }
  try {
    await goTo(bot, new pathfinderPkg.goals.GoalBlock(home.x, home.y, home.z), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), timeoutMs: 10000, stuckMs: 5000 });
    return { result: 'PASS', reason: '已在真实自有房屋内走回工作区，未关闭避怪规则、未经过屋外',
      before, after: bot.entity.position.clone(), costs, health: bot.health };
  } catch (error) {
    return { result: 'FAIL', reason: error.message, before, after: bot.entity.position.clone(), costs,
      failure: bot.navigationFailure };
  } finally {
    haltBot(bot);
    bot.removeListener('health', stopOnDamage);
    bot.strategySupervisor = oldSupervisor;
  }
}
