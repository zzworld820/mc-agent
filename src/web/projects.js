import { changeProject, projectsFor, registerProject } from '../projects/engine.js';
import { strategyPartition } from '../strategy/state.js';
import { projectTemplates } from '../projects/templates.js';

function describe(project) {
  if (!project) return null;
  const template = projectTemplates[project.kind];
  const saved = new Map((project.steps || []).map(step => [step.id, step]));
  const steps = (template?.steps(project.options) || []).map(step => {
    const result = project.stepHistory?.[step.id];
    const check = saved.get(step.id);
    return { id: step.id, label: step.label, needs: step.needs,
      status: check?.status === 'verified' ? 'verified' : result?.attempts >= 2 ? 'blocked' : check?.status || 'pending',
      detail: check?.detail, attempts: result?.attempts ?? 0, lastResult: result?.lastResult };
  });
  const labels = new Map(steps.map(step => [step.id, step.label]));
  const activity = Object.entries(project.stepHistory || {}).flatMap(([id, entry]) =>
    (entry.results || []).slice(-8).map(result => ({ ...result, step: labels.get(id) || id.replace(/^support:/, '') })))
    .sort((a, b) => b.at - a.at).slice(0, 8);
  return { id: project.id, kind: project.kind, label: template?.label, objective: project.objective,
    status: project.status, options: project.options, steps, activity, createdAt: project.createdAt,
    updatedAt: project.updatedAt, completedAt: project.completedAt };
}

export function createProjectDashboard({ npc, llm, controller, actions, storage = projectsFor }) {
  let bot;
  let latest = { active: null, history: [] };
  const canUseModel = () => Boolean(!npc.manualControl && bot && bot.survivalPlanner && llm.apiKey && !bot.memory?.suspended
    && npc.autonomy !== 'off' && bot.autonomyOptions?.allowDig !== false
    && (bot.activeAutonomyMode ?? npc.autonomyMode) === 'ai');
  const identity = current => JSON.stringify(strategyPartition(current));
  const enabled = () => canUseModel() && ['overworld', 'minecraft:overworld'].includes(String(bot.game?.dimension));
  const unavailable = () => !bot ? '等待 Agent 连接' : npc.manualControl ? '手动指令模式 · 工程档案可查阅' : !canUseModel() ? '需要已配置模型并启用 AI 生存模式' : '当前模板只适用于主世界';

  async function snapshot() {
    const current = bot;
    if (!current) return { ...latest, enabled: false, unavailable: unavailable(), runtime: null };
    try {
      const partition = identity(current);
      const { active, history } = await storage(current).read();
      if (current !== bot || partition !== identity(current)) return { ...latest, enabled: false, unavailable: '正在切换连接' };
      const supervisor = current.strategySupervisor;
      const runtime = supervisor?.active ? supervisor.projectRuntime : null;
      const sameProject = runtime && active?.id === runtime.id;
      latest = { active: describe(active), history: history.slice(-8).reverse().map(describe) };
      return { ...latest, enabled: enabled(), unavailable: enabled() ? null : unavailable(),
        dimension: String(current.game?.dimension), runtime: sameProject ? runtime : null,
        task: active ? { kind: actions.tasks.current?.kind, goal: supervisor?.active ? supervisor.goal : null,
          progress: actions.tasks.current?.progress } : null };
    } catch (error) {
      return { ...latest, enabled: false, unavailable: '工程记录暂不可读取', error: error.message };
    }
  }

  function requireConnection() {
    if (!bot || bot.memory?.suspended) throw new Error('Agent 未连接或世界身份待确认');
    return bot;
  }

  async function create(data) {
    const current = requireConnection();
    if (!enabled()) throw new Error(unavailable());
    if (current.survivalPlanner.hasRequest()) throw new Error('Agent 正在执行玩家的临时目标');
    const project = await registerProject(storage(current), { kind: data.kind, options: data.options, objective: data.objective,
      owner: { source: 'web' } });
    // Registration is already durable. A subsequent connection failure must
    // not encourage submitting the same project twice.
    let warning;
    if (bot === current && actions.tasks.current?.kind !== 'autonomy') {
      try { await controller.setPrimary('resume'); } catch (error) { warning = error.message; }
    }
    return { project: describe(project), warning };
  }

  async function operate({ id, operation }) {
    if (!['pause', 'resume', 'cancel'].includes(operation)) throw new Error('工程操作无效');
    const current = requireConnection();
    if (operation === 'resume' && !enabled()) throw new Error(unavailable());
    const partition = identity(current);
    const store = storage(current);
    const { active } = await store.read();
    if (!active || active.id !== id) throw new Error('工程已经变化，请刷新后重试');
    if (bot !== current || partition !== identity(current)) throw new Error('Agent 连接或世界已改变');
    const project = await changeProject(store, active, operation);
    if (!project) throw new Error('工程已经变化，请刷新后重试');
    let warning;
    if (operation === 'resume') {
      try { await controller.setPrimary('resume'); } catch (error) { warning = error.message; }
    } else {
      current.strategySupervisor?.interruptProject?.(id, 'Web ' + (operation === 'pause' ? '暂停工程' : '取消工程'));
    }
    return { project: describe(project), warning };
  }

  function attach(current) {
    bot = current;
    latest = { active: null, history: [] };
    current.once('end', () => { if (bot === current) bot = null; });
  }

  return { attach, snapshot, create, operate };
}
