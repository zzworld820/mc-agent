import { randomUUID } from 'node:crypto';
import { strategyPartition } from '../strategy/state.js';
import { projectStore } from './store.js';
import { projectTemplates } from './templates.js';

export const projectKinds = Object.keys(projectTemplates);
export const projectArguments = Object.fromEntries(Object.entries(projectTemplates).map(([kind, template]) => [kind, template.input]));

export function projectsFor(bot) {
  return projectStore(strategyPartition(bot));
}

export async function registerProject(store, { kind, options, objective, owner }) {
  if (!Object.hasOwn(projectTemplates, kind)) throw new Error(`当前支持的工程模板：${projectKinds.join('、')}`);
  if (typeof objective !== 'string' || !objective.trim() || objective.length > 500) throw new Error('工程需求须为 1～500 字');
  const template = projectTemplates[kind];
  if (options != null && (typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !Object.hasOwn(template.input.properties, key)))) throw new Error('包含此模板不支持的验收选项');
  const normalized = await template.options(options || {});
  return store.create({ id: randomUUID(), kind, templateVersion: template.version, objective: objective.trim(),
    owner, options: normalized, status: 'active', createdAt: Date.now(), stepHistory: {} });
}

export async function refreshProject(store, bot, state, project, { observing = false } = {}) {
  const template = projectTemplates[project.kind];
  if (!template || template.version !== project.templateVersion) throw new Error('此工程模板版本不受支持');
  if (project.status !== 'active') return { project, ready: [], steps: [], support: [], report: '工程已暂停' };

  const target = template.target?.(state, project) ?? project.target;
  if (template.targetRequired && !target) {
    return { project, ready: [], steps: [], support: [], report: '没有符合要求的已登记设施可扩建' };
  }
  if (!observing && target !== project.target) {
    const saved = await store.update(project.id, current => {
      if (current.status !== 'active') return false;
      current.target = target;
    });
    if (!saved) return { project, ready: [], steps: [], support: [], report: '工程状态已改变' };
    project = saved;
  }

  if (template.targetUnavailable?.(state, project, target)) {
    return { project, ready: [], steps: [], support: [], report: '关联设施不在当前检查点，等待人工核对' };
  }
  const findings = await template.observe(bot, state, { ...project, target });
  const definitions = template.steps(project.options);
  const steps = definitions.map(step => {
    const check = findings[step.id];
    const blocked = (project.stepHistory[step.id]?.attempts || 0) >= 2;
    const unmet = step.needs.filter(id => !findings[id]?.done);
    return { ...step, skill: template.skill?.(step, state, project) ?? step.skill,
      detail: check.detail, progress: check.progress, status: unmet.length ? 'dependent' : check.done ? 'verified'
        : blocked ? 'blocked' : check.waiting ? 'waiting' : 'ready',
      lastResult: project.stepHistory[step.id]?.lastResult };
  });
  const supportFailures = Object.entries(project.stepHistory).filter(([id, entry]) => id.startsWith('support:') && entry.attempts >= 2)
    .map(([id]) => id.slice('support:'.length));
  const ready = steps.filter(step => step.status === 'ready');
  const complete = steps.every(step => step.status === 'verified');
  const changed = JSON.stringify(project.steps) !== JSON.stringify(steps);
  if (!observing && (changed || complete)) {
    const updated = await store.update(project.id, current => {
      if (current.status !== 'active') return false;
      current.steps = steps;
      if (complete) { current.status = 'complete'; current.completedAt = Date.now(); }
    });
    if (!updated) return { project, ready: [], steps, support: [], report: '工程状态已改变' };
    project = updated;
  }
  const report = `${template.label}工程 ${steps.filter(step => step.status === 'verified').length}/${steps.length} 项已验收`;
  return { project, ready, steps, complete, support: ready.length ? template.support.filter(skill => !supportFailures.includes(skill)) : [], supportFailures, report };
}

export async function recordProjectStep(store, id, step, outcome) {
  return store.update(id, project => {
    const history = project.stepHistory[step.id] ??= { attempts: 0, results: [] };
    if (outcome.status === 'progress') history.attempts = 0;
    if (outcome.status === 'failed') history.attempts++;
    history.lastResult = outcome;
    history.results.push({ ...outcome, at: Date.now() });
  });
}

export async function changeProject(store, project, operation) {
  return store.update(project.id, current => {
    if (operation === 'pause') current.status = 'paused';
    if (operation === 'cancel') current.status = 'cancelled';
    if (operation === 'resume') {
      current.status = 'active';
      for (const history of Object.values(current.stepHistory)) history.attempts = 0;
    }
  });
}
