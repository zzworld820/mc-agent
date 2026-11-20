/* Same-origin API client. All server/user text is rendered with textContent. */
(() => {
  'use strict';

  const selectedAgent = new URLSearchParams(location.search).get('agent');
  const agentApi = selectedAgent && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(selectedAgent)
    ? '/api/agents/' + encodeURIComponent(selectedAgent) : '/api';
  let itemTiles = Object.create(null);
  const $ = (id) => document.getElementById(id);
  const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const list = (value) => Array.isArray(value) ? value : [];
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const text = (value, fallback = '未知') => {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return text(value.label ?? value.name ?? value.text ?? value.message, fallback);
    return String(value);
  };
  const set = (id, value) => { $(id).textContent = text(value); };
  const node = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = text(content, '');
    return element;
  };
  const empty = (content, compact = false) => node('p', `empty-state${compact ? ' compact' : ''}`, content);
  const integer = (value) => number(value) === null ? '未知' : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  const time = (value) => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour12: false });
  };
  const position = (value) => {
    const p = record(value);
    return ['x', 'y', 'z'].every((key) => number(p[key]) !== null)
      ? `${integer(p.x)}, ${integer(p.y)}, ${integer(p.z)}` : '未知';
  };
  const labels = {
    running: '执行中', queued: '排队中', cancelling: '取消中', completed: '已完成', done: '已完成', finishing: '后续收尾',
    cancelled: '已取消', failed: '失败', paused: '已暂停', idle: '空闲',
    interrupted: '已中断', saved: '已保存', resuming: '恢复中', pending: '等待中',
    success: '路径已找到', partial: '部分路径', noPath: '无可达路径', timeout: '寻路超时',
    searching: '搜索中', moving: '移动中', stuck: '受阻',
  };
  const statusLabel = (value) => labels[value] || text(value, '状态未知');
  const statusClass = (value) => ['running', 'completed', 'success'].includes(value) ? 'tag-green'
    : ['failed', 'interrupted', 'noPath', 'stuck'].includes(value) ? 'tag-red'
      : ['queued', 'paused', 'cancelling', 'partial', 'timeout'].includes(value) ? 'tag-amber' : 'tag-blue';
  const badge = (id, label, className = '') => {
    $(id).textContent = label;
    $(id).className = `tag ${className}`;
  };
  const cached = new Map();
  function renderList(id, data, render) {
    const signature = JSON.stringify(data);
    if (cached.get(id) === signature) return;
    cached.set(id, signature);
    render($(id));
  }

  let snapshot = {};
  let receivedAt = 0;
  let revision = 0;
  let stream = null;
  let streamOpen = false;
  let reconnectTimer;
  let reconnectAttempt = 0;
  let connectingSince = Date.now();
  let stateRequest;
  let stopped = false;
  let mode = 'chat';
  let prioritiesDirty = false;
  let toastTimer;
  const pending = new Set();
  const localMessages = [];
  let messageSequence = 0;

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').className = `toast${error ? ' error' : ''}`;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 4000);
  }

  async function request(url, body, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 12000);
    try {
      const response = await fetch(url.replace(/^\/api(?=\/)/, () => agentApi), {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: body === undefined ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(text(result?.error ?? result?.message, `请求失败（HTTP ${response.status}）`));
      if (body === undefined && !result) throw new Error('状态接口未返回 JSON 快照');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(body === undefined ? '获取状态超时或已取消' : '请求超时，结果未确认；请检查最新状态后再重试');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  function connectionUI() {
    const age = receivedAt ? Date.now() - receivedAt : null;
    const fresh = age !== null && age < 15000;
    $('stream-status').className = `connection-pill ${streamOpen && fresh ? 'online' : 'offline'}`;
    set('stream-label', streamOpen ? (fresh ? 'SSE 实时连接' : '等待实时快照') : (receivedAt ? '断线重连中' : '正在连接'));
    set('snapshot-age', age === null ? '等待首次快照' : age < 2000 ? '刚刚更新' : `${Math.floor(age / 1000)} 秒前更新`);
    set('footer-updated', receivedAt ? `最近接收 ${time(receivedAt)}` : '尚未收到数据');
    const banner = $('connection-banner');
    const offline = !streamOpen && Date.now() - connectingSince > 2000;
    banner.hidden = !offline && !(age !== null && !fresh) && !snapshot.observationError;
    banner.textContent = snapshot.observationError ? `观测异常：${text(snapshot.observationError)}。当前显示最后一次快照。`
      : age !== null && !fresh ? '状态已超过 15 秒未更新，正在重新连接；当前显示最后一次快照。'
        : '实时连接暂不可用，正在自动重连。';
    $('sidebar-status').className = `status-dot ${snapshot.connected === true && fresh ? 'online' : 'offline'}`;
    updateControls();
  }

  function meter(id, value, maximum) {
    const n = number(value);
    const bar = $(id);
    bar.style.width = `${n === null ? 0 : Math.max(0, Math.min(100, n / maximum * 100))}%`;
    if (n === null) {
      bar.parentElement.removeAttribute('aria-valuenow');
      bar.parentElement.setAttribute('aria-valuetext', '未知');
    } else {
      bar.parentElement.setAttribute('aria-valuenow', String(Math.max(0, Math.min(maximum, n))));
      bar.parentElement.setAttribute('aria-valuetext', `${n} / ${maximum}`);
    }
  }

  function renderAgent() {
    const agent = record(snapshot.agent);
    const connected = snapshot.connected;
    set('agent-connection', connected === true ? '已连接世界' : connected === false ? 'Agent 离线' : '等待数据');
    set('agent-name', agent.name ?? 'Agent 未知');
    set('sidebar-agent', agent.name ?? '等待 Agent');
    set('agent-initial', text(agent.name, 'A').slice(0, 1).toUpperCase());
    const dimensions = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
    const dimension = text(agent.dimension, '维度未知').replace(/^minecraft:/, '');
    set('dimension', dimensions[dimension] || dimension);
    set('sidebar-world', connected ? dimensions[dimension] || dimension : '尚未连接世界');
    for (const key of ['health', 'food']) {
      set(`${key}-value`, integer(agent[key]));
      set(`${key}-unit`, number(agent[key]) === null ? '' : '/ 20');
      meter(`${key}-bar`, agent[key], 20);
    }
    set('health-note', number(agent.health) === null ? '等待状态同步' : agent.health <= 6 ? '生命值偏低' : '生命值已同步');
    set('food-note', number(agent.food) === null ? '等待状态同步' : agent.food <= 6 ? '需要补充食物' : '饥饿值已同步');
    for (const axis of ['x', 'y', 'z']) set(`position-${axis}`, number(agent.position?.[axis]) === null ? '—' : integer(agent.position[axis]));
    set('position-note', `观察 ${integer(agent.observedDays)} 天 · 死亡 ${integer(agent.deaths)} 次`);
  }

  function mission(value) { return typeof value === 'string' ? { label: value } : record(value); }
  function progressPercent(value) {
    if (typeof value === 'object' && value) {
      const completed = number(value.completed ?? value.current);
      const total = number(value.total ?? value.required);
      return completed !== null && total > 0 ? Math.max(0, Math.min(100, completed / total * 100)) : null;
    }
    if (typeof value === 'string' && /^\s*\d+(\.\d+)?%\s*$/.test(value)) return Math.min(100, Number.parseFloat(value));
    const n = number(value);
    return n === null || n < 0 ? null : Math.min(100, n <= 1 ? n * 100 : n);
  }

  function renderMissions() {
    const missions = record(snapshot.missions);
    const primary = mission(missions.primary);
    const task = record(snapshot.task);
    set('primary-label', primary.label ?? primary.name ?? '等待主任务');
    const detail = text(primary.text ?? primary.description, '');
    const normalize = (value) => text(value, '').replace(/\s+/g, ' ').trim();
    set('primary-detail', detail);
    // The controller may copy task.progress into primary.text on every snapshot.
    // Keep that progress in the execution row and avoid a duplicate paragraph.
    $('primary-detail').hidden = !detail || normalize(detail) === normalize(primary.label)
      || normalize(detail) === normalize(task.progress);
    badge('primary-status', statusLabel(primary.status), statusClass(primary.status));
    badge('task-status', task.label ?? '等待同步', task.label ? 'tag-blue' : '');
    const percent = progressPercent(task.progress);
    set('task-label', typeof task.progress === 'string' && task.progress ? task.progress : `当前执行：${text(task.label)}`);
    set('task-percent', percent === null ? '进度未知' : `${Math.round(percent)}%`);
    meter('task-bar', percent, 100);
    let preservation = '保存 / 恢复状态未知';
    if (primary.pausedBy && primary.pausedBy !== 'user') preservation = '主任务已保留 · 临时任务结束后自动恢复';
    else if (primary.pausedBy === 'user' || primary.enabled === false) preservation = '主任务已暂停 · 等待手动恢复';
    else if (primary.status === 'running') preservation = '主任务正在执行';
    else if (primary.status === 'resuming') preservation = '正在恢复主任务';
    else if (primary.saved === true || primary.savedAt) preservation = '主任务已保存';
    if (primary.restoreError) preservation = `恢复失败：${text(primary.restoreError)}`;
    set('primary-preservation', preservation);
    const temporary = list(missions.temporary);
    const active = temporary.filter((entry) => ['running', 'cancelling'].includes(entry.status));
    const queued = temporary.filter((entry) => entry.status === 'queued');
    const history = temporary.filter((entry) => !['running', 'cancelling', 'queued'].includes(entry.status));
    set('temporary-count', Array.isArray(missions.temporary) ? active.length + queued.length : '—');
    renderList('temporary-list', [missions.temporary, [...pending]], (container) => {
      const children = [];
      const makeRow = (entry, index) => {
        const item = mission(entry);
        const row = node('article', 'temporary-item');
        row.append(node('span', 'task-number', String(index + 1).padStart(2, '0')));
        const copy = node('div', 'task-info');
        copy.append(node('strong', '', item.label ?? item.description ?? item.text ?? '未命名任务'));
        copy.append(node('p', '', `${statusLabel(item.status)}${item.text ? ` · ${text(item.text)}` : ''}`));
        row.append(copy);
        if (['running', 'queued', 'cancelling'].includes(item.status)) {
          const button = node('button', 'button button-small button-danger', item.status === 'cancelling' ? '取消中' : '取消');
          button.type = 'button';
          button.dataset.cancelId = String(item.id ?? '');
          button.dataset.cancelStatus = text(item.status, '');
          button.disabled = item.id == null || item.status === 'cancelling' || pending.has(`cancel:${item.id}`) || !canControl();
          button.addEventListener('click', () => mutate(`cancel:${item.id}`, '/api/temporary/cancel', { id: item.id }, '取消请求已接收，等待任务状态更新'));
          row.append(button);
        }
        return row;
      };
      [...active, ...queued].forEach((entry, index) => children.push(makeRow(entry, index)));
      if (!children.length) children.push(empty(Array.isArray(missions.temporary) ? '暂无运行中或排队的临时任务' : '等待临时任务数据'));
      if (history.length) {
        const details = node('details', 'mission-history');
        details.append(node('summary', 'muted', `历史任务（${history.length}）`));
        history.slice(-12).reverse().forEach((entry, index) => details.append(makeRow(entry, index)));
        children.push(details);
      }
      container.replaceChildren(...children);
    });
    const queue = list(missions.queue);
    set('queue-count', Array.isArray(missions.queue) ? `${queue.length} 项排队` : '等待同步');
    renderList('queue-list', missions.queue ?? null, (container) => {
      container.replaceChildren(...(queue.length ? queue.map((entry, index) => node('div', 'queue-item', `${index + 1}. ${text(entry)}`))
        : [empty(Array.isArray(missions.queue) ? '队列为空' : '队列未知', true)]));
    });
    if (!prioritiesDirty && !$('priorities-form').contains(document.activeElement)) {
      if (number(missions.priorities?.temporary) !== null) $('temporary-priority').value = missions.priorities.temporary;
      if (number(missions.priorities?.primary) !== null) $('primary-priority').value = missions.priorities.primary;
    }
    set('priority-note', missions.priorities ? `已生效：临时 ${text(missions.priorities.temporary)} / 主任务 ${text(missions.priorities.primary)}；数值越大越优先。`
      : '当前值未知；默认临时 80 / 主任务 50。');
  }

  function renderProgress() {
    const progress = record(snapshot.progress);
    const stage = snapshot.task?.stage;
    $('task-stage').hidden = !stage;
    renderList('task-stage', stage ?? null, container => {
      if (!stage) { container.replaceChildren(); return; }
      const steps = node('ol', 'task-stage-steps');
      list(stage.steps).forEach((step, i) => {
        const item = node('li', i === stage.current ? 'active' : '', step);
        if (i === stage.current) item.setAttribute('aria-current', 'step');
        steps.append(item);
      });
      container.replaceChildren(node('strong', '', stage.title), steps);
    });
    const construction = record(snapshot.construction);
    set('stage-label', progress.stage ?? '阶段未知');
    set('next-step', progress.next ?? '等待规划数据');
    set('completed-value', integer(progress.completed));
    set('remaining-value', integer(progress.remaining));
    renderList('checkpoints', progress.checkpoints ?? null, (container) => {
      let activeFound = false;
      const checkpoints = list(progress.checkpoints).map((entry, index) => {
        const point = mission(entry);
        const done = point.done === true || point.completed === true || point.status === 'completed';
        const active = !done && !activeFound;
        if (active) activeFound = true;
        const row = node('li', `checkpoint${done ? ' complete' : active ? ' active' : ''}`);
        row.append(node('span', 'checkpoint-marker', done ? '✓' : index + 1));
        const copy = node('div', 'checkpoint-copy');
        copy.append(node('strong', '', point.name ?? point.label ?? point.text ?? '检查点'));
        if (point.next || point.detail) copy.append(node('p', '', point.detail ?? point.next));
        row.append(copy);
        return row;
      });
      container.replaceChildren(...(checkpoints.length ? checkpoints : [empty(Array.isArray(progress.checkpoints) ? '暂无检查点' : '检查点未知')]));
    });
    const matched = number(construction.matched);
    const total = number(construction.total);
    const shellComplete = matched !== null && total > 0 && matched >= total && !(construction.unknown > 0);
    set('construction-value', `${integer(matched)} / ${integer(total)}`);
    set('finishing-value', construction.finishingPending === true ? '待收尾' : construction.finishingPending === false ? '无待处理' : '未知');
    const facilities = [['beds', '床'], ['chests', '箱子'], ['furnaces', '熔炉'], ['craftingTables', '工作台']];
    let facilitiesComplete = true;
    const cells = facilities.map(([key, label]) => {
      const current = number(construction.facilities?.[key]);
      const target = number(construction.facilityTargets?.[key]);
      const known = current !== null && target !== null;
      const complete = known && current >= target;
      facilitiesComplete &&= complete;
      const cell = node('div', `facility${complete ? ' complete' : ''}`);
      cell.append(node('span', '', label), node('strong', '', `${integer(current)} / ${integer(target)}`), node('small', '', !known ? '未知' : complete ? '已达标' : '待补齐'));
      return cell;
    });
    renderList('facilities-list', [construction.facilities, construction.facilityTargets], (container) => container.replaceChildren(...cells));
    badge('construction-status', shellComplete && facilitiesComplete && construction.finishingPending === false ? '主体与设施达标'
      : shellComplete ? '主体完成 · 设施单独验收' : total === null ? '验收未知' : '主体未完成', shellComplete ? 'tag-green' : '');
    set('construction-note', `床、箱子、熔炉、工作台逐项验收${number(construction.unknown) > 0 ? ` · ${construction.unknown} 个主体方块未知` : ''}${snapshot.base?.finishing?.length ? ` · ${snapshot.base.finishing.length} 格软土已封闭，保留承重并登记收尾` : ''}`);
    const jobs = Object.entries(record(snapshot.base?.jobs)).filter(([, job]) => job.status !== 'done');
    $('base-work').hidden = jobs.length === 0;
    renderList('base-work', [jobs, Math.floor(Date.now() / 5000)], (container) => {
      container.replaceChildren(...jobs.map(([key, job]) => {
        const row = node('article', 'event-item');
        const wait = number(job.retryAt) !== null && job.retryAt > Date.now()
          ? ` · ${Math.ceil((job.retryAt - Date.now()) / 1000)}秒后复查` : '';
        const name = job.item ? `${key.startsWith('material:') ? '准备材料' : key.startsWith('shell:') ? '外壳收尾' : '安装'}：${itemNames[job.item] ?? job.item}`
          : key === 'bed' ? '安装床' : key === 'light' ? '住所照明' : key.startsWith('storage-check:') ? '核验箱子' : key;
        row.append(node('strong', '', `${job.label ?? name}${job.position ? ` (${position(job.position)})` : ''}`), node('p', 'muted',
          `${statusLabel(job.status)}${job.reason ? ` · ${text(job.reason)}` : ''}${wait}`));
        return row;
      }));
    });
    const materials = progress.materials ?? construction.materials;
    set('materials-note', Array.isArray(materials)
      ? materials.length ? '待安装材料：随身已有 / 仍需安装（含收尾，不含合成原料）' : '已观察区域暂无待安装材料'
      : '材料数量未知');
    renderList('materials-list', materials ?? null, (container) => {
      container.replaceChildren(...list(materials).map((item) => {
        const row = node('div', 'material-row');
        row.append(node('span', '', itemNames[item.name] ?? text(item)), node('strong', '', `${integer(item.current ?? item.count)} / ${integer(item.required ?? item.total)}${number(item.missing) !== null ? ` · 缺 ${integer(item.missing)}` : ''}`));
        return row;
      }));
    });
  }

  const itemNames = { cobblestone: '圆石', stone: '石头', dirt: '泥土', sand: '沙子', gravel: '沙砾', coal: '煤炭', charcoal: '木炭', raw_iron: '粗铁', iron_ingot: '铁锭', iron_ore: '铁矿石', diamond: '钻石', stick: '木棍', torch: '火把', chest: '箱子', furnace: '熔炉', crafting_table: '工作台', bread: '面包', wheat: '小麦', wheat_seeds: '小麦种子', apple: '苹果', cooked_beef: '牛排', cooked_porkchop: '熟猪排', oak_log: '橡木原木', oak_planks: '橡木木板', white_bed: '白色床', bucket: '桶', water_bucket: '水桶' };
  const itemName = (item) => text(item.displayName ?? item.label ?? itemNames[item.name] ?? item.name, '未知物品');
  function itemCell(item) {
    const name = itemName(item);
    const cell = node('div', 'inventory-item');
    cell.title = text(item.name, name);
    const tile = itemTiles[item.name];
    const icon = node('span', 'item-mark');
    icon.setAttribute('aria-hidden', 'true');
    if (Array.isArray(tile) && tile.length === 4) {
      const [u, v, width, height] = tile;
      icon.classList.add('item-texture');
      icon.style.backgroundSize = `${100 / width}% ${100 / height}%`;
      icon.style.backgroundPosition = `${100 * u / (1 - width)}% ${100 * v / (1 - height)}%`;
    } else {
      const type = item.name || '';
      icon.textContent = /pickaxe/.test(type) ? '⛏' : /sword/.test(type) ? '⚔'
        : /axe/.test(type) ? '🪓' : /hoe|shovel/.test(type) ? '🛠' : /seeds|wheat/.test(type) ? '🌾'
        : /beef|chicken|pork|mutton|salmon|cod/.test(type) ? '🍖'
        : /bread/.test(type) ? '🍞' : /apple/.test(type) ? '🍎' : /bucket/.test(type) ? '🪣'
        : /diamond|emerald/.test(type) ? '💎' : /ingot/.test(type) ? '🧱' : /coal/.test(type) ? '⬛' : '◇';
    }
    cell.append(icon);
    const copy = node('div', 'item-copy');
    copy.append(node('strong', '', name), node('span', '', `× ${integer(item.count)}`));
    cell.append(copy);
    return cell;
  }

  function renderStorage() {
    const inventory = list(snapshot.inventory);
    const chests = list(snapshot.chests);
    const query = $('inventory-search').value.trim().toLocaleLowerCase();
    const matches = (item) => `${itemName(item)} ${text(item.name, '')}`.toLocaleLowerCase().includes(query);
    set('inventory-count', Array.isArray(snapshot.inventory) ? inventory.length : '—');
    set('chests-count', Array.isArray(snapshot.chests) ? chests.length : '—');
    const totalKnown = Array.isArray(snapshot.inventory) && inventory.every((item) => number(item.count) !== null);
    set('storage-total', totalKnown ? `背包 ${integer(inventory.reduce((sum, item) => sum + item.count, 0))} 件` : '数量未知');
    renderList('inventory-list', [snapshot.inventory, query], (container) => {
      const items = inventory.filter(matches);
      container.replaceChildren(...(items.length ? items.map(itemCell) : [empty(!Array.isArray(snapshot.inventory) ? '背包未知' : query ? '未找到匹配物品' : '背包为空')]));
    });
    renderList('chests-list', [snapshot.chests, query], (container) => {
      const opened = new Set([...container.querySelectorAll('details[open]')].map((element) => element.dataset.chestId));
      const visible = chests.filter((chest) => !query || `${text(chest.label ?? chest.name ?? chest.id, '')} ${text(chest.dimension, '')}`.toLocaleLowerCase().includes(query) || list(chest.items).some(matches));
      const children = visible.map((chest, index) => {
        const details = node('details', 'chest');
        details.dataset.chestId = String(chest.id ?? index);
        details.open = opened.has(details.dataset.chestId) || !!query;
        const summary = node('summary');
        summary.append(node('strong', '', chest.label ?? chest.name ?? `箱子 ${index + 1}`), node('span', 'muted', position(chest.position)));
        details.append(summary);
        const state = chest.missing ? '箱子已缺失' : chest.verificationError ? `核验失败：${text(chest.verificationError)}`
          : !Array.isArray(chest.items) ? '库存未核验' : chest.stale ? '库存快照可能过期' : '库存已观测';
        details.append(node('p', 'chest-note', `${chest.archived ? '旧营地 · ' : ''}${state}${chest.observedAt ? ` · ${time(chest.observedAt)}` : ''}${chest.dimension ? ` · ${text(chest.dimension)}` : ''}`));
        const items = list(chest.items).filter(matches);
        const grid = node('div', 'inventory-grid');
        grid.append(...(items.length ? items.map(itemCell) : [empty(!Array.isArray(chest.items) ? '箱内物品未知' : query ? '无匹配物品' : '箱子为空', true)]));
        details.append(grid);
        return details;
      });
      container.replaceChildren(...(children.length ? children : [empty(!Array.isArray(snapshot.chests) ? '箱子库存未知' : query ? '无匹配箱子' : '暂无已登记箱子')]));
    });
  }

  function eventRows(value, danger = false) {
    if (value == null) return null;
    if (Array.isArray(value)) return value.map((entry) => mission(entry));
    if (typeof value === 'string') return [{ label: value }];
    if (value === false) return [];
    const data = record(value);
    if (danger && (Array.isArray(data.reasons) || Array.isArray(data.threats))) {
      const rows = list(data.reasons).map((reason) => ({ label: reason, severity: 'critical' }));
      for (const threat of [...list(data.threats), ...list(data.projectiles)]) rows.push({
        label: text(threat.name, '附近威胁'), detail: `距离 ${integer(threat.distance)} 格${threat.approaching ? ' · 正在接近' : ''}`, severity: data.retreat ? 'critical' : 'warning',
      });
      if (data.recoveryNeeded) rows.push({ label: '需要恢复生命值', severity: 'warning' });
      if (data.starvationSuspected) rows.push({ label: '疑似饥饿伤害', severity: 'critical' });
      return rows;
    }
    if (data.label || data.message || data.reason || data.level) return [data];
    return Object.entries(data).map(([key, entry]) => typeof entry === 'object' && entry
      ? { ...entry, label: entry.label ?? key } : { label: key, detail: text(entry) });
  }

  function renderSafety() {
    const danger = eventRows(snapshot.danger, true);
    const failures = eventRows(snapshot.failures);
    set('danger-count', danger === null ? '—' : danger.length);
    set('failure-count', failures === null ? '—' : failures.length);
    const diagnostics = record(snapshot.diagnostics);
    const seconds = diagnostics.trackingProgress && number(diagnostics.ticksWithoutProgress) !== null
      ? diagnostics.ticksWithoutProgress / 20 : null;
    const incidents = snapshot.incidents;
    $('incident-write-error').hidden = !incidents?.writeError;
    renderList('incident-list', incidents?.entries ?? null, container => {
      const rows = list(incidents?.entries).map(entry => {
        const title = { stall: '任务卡顿', failure: '执行失败', attempt: '尝试处理', resolved: '已恢复' }[entry.type] || '执行记录';
        const row = node('article', 'incident-row');
        row.append(node('strong', '', `${title} · ${text(entry.goal)}`),
          node('time', 'muted', new Date(entry.at).toLocaleString()));
        for (const [label, value] of [['原因', entry.reason], ['处理', entry.solution], ['结果', entry.result]]) {
          if (value) row.append(node('p', '', `${label} · ${value}`));
        }
        if (entry.position) row.append(node('p', 'muted', `位置 ${position(entry.position)}`));
        return row;
      });
      container.replaceChildren(...(rows.length ? rows : [empty('暂无已保存的处理记录', true)]));
    });
    set('no-progress-time', seconds === null ? '当前未计时' : seconds >= 1200 ? `${(seconds / 1200).toFixed(2)} 游戏日` : seconds < 60 ? `${Math.floor(seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`);
    badge('stalled-status', diagnostics.stalled === true ? '已检测到卡点' : diagnostics.stalled === false ? '未检测到卡点' : '卡点未知', diagnostics.stalled ? 'tag-amber' : '');
    $('no-progress-time').closest('.diagnostics').classList.toggle('is-stalled', diagnostics.stalled === true);
    const navigation = record(diagnostics.navigation);
    set('navigation-status', statusLabel(navigation.status ?? (typeof diagnostics.navigation === 'string' ? diagnostics.navigation : null)));
    set('navigation-nodes', integer(navigation.visitedNodes));
    set('path-summary', `${Array.isArray(diagnostics.path) ? diagnostics.path.length : '未知'} / ${Array.isArray(diagnostics.trail) ? diagnostics.trail.length : '未知'} 节点`);
    set('navigation-goal', position(diagnostics.goal));
    const count = (danger?.length || 0) + (failures?.length || 0) + (diagnostics.stalled ? 1 : 0);
    set('nav-alert-count', count);
    $('nav-alert-count').hidden = !count;
    badge('safety-status', count ? `${count} 项需关注` : danger === null || failures === null ? '未知' : '无告警', count ? 'tag-amber' : '');
    for (const [id, rows, unknown, clear] of [['danger-list', danger, '危险数据未知', '暂无危险记录'], ['failure-list', failures, '失败记录未知', '暂无失败或卡点记录']]) {
      renderList(id, rows, (container) => {
        container.replaceChildren(...(rows?.length ? rows.slice(-30).map((entry) => {
          const critical = ['critical', 'high', 'danger', 'error'].includes(entry.severity ?? entry.level);
          const row = node('article', `event-item${critical ? ' critical' : ''}`);
          row.append(node('span', 'event-bullet'));
          const copy = node('div', 'event-copy');
          copy.append(node('strong', '', entry.label ?? entry.name ?? entry.message ?? entry.reason ?? '告警'));
          const details = [entry.detail ?? entry.reason ?? entry.description, entry.attempts != null ? `尝试 ${entry.attempts} 次` : null,
            entry.retryAt ? `重试时间 ${time(entry.retryAt)}` : null].filter(Boolean);
          if (details.length) copy.append(node('p', '', details.join(' · ')));
          if (entry.at ?? entry.createdAt) copy.append(node('time', '', time(entry.at ?? entry.createdAt)));
          row.append(copy);
          return row;
        }) : [empty(rows === null ? unknown : clear, true)]));
      });
    }
  }

  let viewerURL = null;
  let viewerLoaded = false;
  let viewerReported = false;
  let viewerTimer;
  let camera = 'first';
  const cameraLabels = { first: '第一人称', third: '第三人称', top: '俯视' };
  function viewerState(label, error = false, detail = '') {
    set('viewer-status-label', label);
    $('viewer-status').className = `tag ${error ? 'tag-amber' : viewerReported ? 'tag-green' : ''}`;
    if (detail) set('viewer-note', detail);
  }
  function sendCamera() {
    if (!viewerURL || !viewerLoaded) return;
    $('world-viewer').contentWindow.postMessage({ type: 'camera', mode: camera }, viewerURL.origin);
    set('viewer-caption', `实时画面 · ${cameraLabels[camera]}`);
  }
  function loadViewer() {
    if (!viewerURL) return;
    viewerLoaded = false;
    viewerReported = false;
    clearTimeout(viewerTimer);
    $('world-viewer').hidden = false;
    $('viewer-placeholder').hidden = false;
    $('viewer-caption').hidden = true;
    set('viewer-placeholder-title', '正在连接真实世界画面');
    set('viewer-placeholder-text', '等待 Viewer 与 WebGL 场景就绪');
    viewerState('画面连接中', false, '等待画面服务回报连接状态');
    $('world-viewer').src = viewerURL.href;
    viewerTimer = setTimeout(() => {
      if (!viewerReported) {
        $('viewer-placeholder').hidden = true;
        viewerState(viewerLoaded ? '页面已载入' : '画面响应超时', true, '尚未收到画面就绪确认，可重连画面。');
      }
    }, 15000);
  }
  function renderViewer() {
    const viewer = record(snapshot.viewer);
    let url;
    try {
      url = new URL(viewer.url || '/viewer/', location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin) throw new Error('画面地址必须为同源 HTTP(S) 地址');
    } catch (error) {
      viewerState('画面地址无效', true, error.message);
      return;
    }
    const available = viewer.available === true;
    for (const button of document.querySelectorAll('[data-camera]')) button.disabled = !available;
    $('viewer-retry').disabled = !available;
    if (!available) {
      clearTimeout(viewerTimer);
      if (viewerURL) $('world-viewer').removeAttribute('src');
      viewerURL = null;
      viewerLoaded = false;
      viewerReported = false;
      $('world-viewer').hidden = true;
      $('viewer-placeholder').hidden = false;
      $('viewer-caption').hidden = true;
      set('viewer-placeholder-title', viewer.error ? '画面暂不可用' : '等待世界画面');
      set('viewer-placeholder-text', viewer.error ?? '等待画面服务就绪');
      viewerState(viewer.error ? '画面不可用' : '等待画面', !!viewer.error, viewer.error ?? '画面服务尚未就绪');
    } else if (viewerURL?.href !== url.href) {
      viewerURL = url;
      loadViewer();
    }
  }
  $('world-viewer').addEventListener('load', () => {
    if (!viewerURL) return;
    viewerLoaded = true;
    $('viewer-placeholder').hidden = true;
    $('viewer-caption').hidden = false;
    if (!viewerReported) viewerState('页面已载入', false, '等待 Viewer 回报场景连接状态');
    sendCamera();
  });
  $('world-viewer').addEventListener('error', () => viewerState('画面载入失败', true, '可点击画面重连按钮重试'));
  window.addEventListener('message', (event) => {
    if (!viewerURL || event.origin !== viewerURL.origin || event.source !== $('world-viewer').contentWindow) return;
    const data = record(event.data);
    if (data.type === 'viewer-status') {
      const payload = record(data.status ?? data.data ?? data);
      const status = typeof data.status === 'string' ? data.status : payload.status;
      const wasReady = viewerReported;
      const error = payload.error || payload.connected === false || payload.available === false || ['error', 'disconnected', 'unavailable'].includes(status);
      const ready = !error && (payload.available === true || payload.connected === true || payload.ready === true || ['ready', 'connected', 'live'].includes(status));
      if (wasReady && Object.hasOwn(cameraLabels, payload.mode)) {
        camera = payload.mode;
        for (const button of document.querySelectorAll('[data-camera]')) {
          button.classList.toggle('is-active', button.dataset.camera === camera);
          button.setAttribute('aria-pressed', String(button.dataset.camera === camera));
        }
        set('viewer-caption', `实时画面 · ${cameraLabels[camera]}`);
      }
      viewerReported = ready;
      viewerState(ready ? '画面已连接' : error ? '画面已断开' : '场景载入中', !!error,
        payload.error ? text(payload.error) : payload.message ?? (ready ? 'WebGL 实时场景已连接' : '等待画面连接'));
      if (ready) {
        clearTimeout(viewerTimer);
        $('viewer-placeholder').hidden = true;
        $('viewer-caption').hidden = false;
        if (!wasReady) sendCamera();
      }
    } else if (data.type === 'block-info') {
      const block = record(data.block ?? data.data ?? data.info ?? data);
      $('block-info').hidden = false;
      $('block-info').textContent = block.error ? `方块查询失败：${text(block.error)}`
        : `选中方块：${text(block.displayName ?? block.name ?? block.type)}\n坐标：${position(block.position ?? block.pos)}${list(block.reasons).length ? `\n${block.reasons.map((reason) => text(reason)).join('；')}` : ''}`;
    }
  });
  for (const button of document.querySelectorAll('[data-camera]')) button.addEventListener('click', () => {
    camera = button.dataset.camera;
    for (const peer of document.querySelectorAll('[data-camera]')) {
      peer.classList.toggle('is-active', peer === button);
      peer.setAttribute('aria-pressed', String(peer === button));
    }
    sendCamera();
  });
  $('viewer-retry').addEventListener('click', loadViewer);

  function serverMessages() {
    return list(snapshot.messages).map((entry) => {
      const message = mission(entry);
      return { ...message, content: text(message.content ?? message.text ?? message.message, ''), role: message.role ?? message.sender ?? 'assistant' };
    });
  }
  function renderMessages(forceScroll = false) {
    const server = serverMessages();
    const ids = new Set(server.filter((message) => message.id != null).map((message) => String(message.id)));
    for (const local of localMessages) if (local.serverId != null && ids.has(String(local.serverId))) local.delivery = 'synced';
    const messages = [...server, ...localMessages.filter((message) => message.delivery !== 'synced')];
    renderList('message-list', messages, (container) => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
      const previousScroll = container.scrollTop;
      if (!messages.length) return;
      const rows = messages.slice(-150).map((message) => {
        const role = ['user', 'system'].includes(message.role) ? message.role : 'assistant';
        const row = node('article', `message ${role}`);
        const name = role === 'user' ? '你' : role === 'system' ? '系统' : text(snapshot.agent?.name, 'Agent');
        row.append(node('div', 'message-meta', `${name}${message.mode === 'task' || message.missionId ? ' · 临时任务' : ''} ${time(message.createdAt ?? message.timestamp)}`), node('div', 'message-bubble', message.content));
        if (message.delivery) {
          const delivery = node('div', `message-delivery${message.delivery === 'failed' ? ' failed' : ''}`,
            message.delivery === 'sending' ? '正在发送…' : message.delivery === 'failed' ? message.error : '已接收，等待 Agent');
          if (message.delivery === 'failed') {
            const retry = node('button', 'retry-message', '重试');
            retry.type = 'button';
            retry.addEventListener('click', () => deliver(message));
            delivery.append(retry);
          }
          row.append(delivery);
        }
        return row;
      });
      container.replaceChildren(...rows);
      container.scrollTop = forceScroll || nearBottom ? container.scrollHeight : previousScroll;
    });
  }
  async function deliver(message) {
    if (message.delivery === 'sending' && message.inFlight) return;
    message.delivery = 'sending';
    message.inFlight = true;
    message.error = '';
    renderMessages(true);
    try {
      const result = await request('/api/chat', { message: message.content, mode: message.mode });
      if (result?.id == null) throw new Error('服务已接收请求，但未返回消息 ID；请检查记录后再重试');
      message.serverId = result.id;
      message.delivery = 'accepted';
      $('chat-feedback').className = 'form-feedback';
      set('chat-feedback', message.mode === 'task' ? '临时任务已接收；执行状态见任务区。' : '消息已接收，等待 Agent 回复。');
      refreshState();
    } catch (error) {
      message.delivery = 'failed';
      message.error = error.message || '发送失败，请检查网络';
      $('chat-feedback').className = 'form-feedback error';
      set('chat-feedback', message.error);
    } finally {
      message.inFlight = false;
      renderMessages(true);
    }
  }
  function selectMode(nextMode) {
    mode = nextMode;
    for (const value of ['chat', 'task']) {
      $(`mode-${value}`).classList.toggle('is-active', value === mode);
      $(`mode-${value}`).setAttribute('aria-pressed', String(value === mode));
    }
    set('chat-mode-hint', mode === 'task' ? '抢占主任务 · 结束后自动恢复' : '只读对话');
    $('chat-input').placeholder = mode === 'task' ? '输入临时任务，例如：收集 16 个橡木原木' : '输入消息，询问当前状态…';
    set('send-message', mode === 'task' ? '发送任务' : '发送');
  }
  $('mode-chat').addEventListener('click', () => selectMode('chat'));
  $('mode-task').addEventListener('click', () => selectMode('task'));
  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const content = $('chat-input').value.trim();
    if (!content) return;
    const message = { localId: `local-${Date.now()}-${++messageSequence}`, role: 'user', content, mode, createdAt: Date.now(), delivery: 'sending' };
    localMessages.push(message);
    if (localMessages.length > 150) localMessages.splice(0, localMessages.length - 150);
    $('chat-input').value = '';
    $('chat-input').focus();
    deliver(message);
  });
  $('chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      $('chat-form').requestSubmit();
    }
  });

  function canControl() { return receivedAt > 0 && Date.now() - receivedAt < 15000 && snapshot.connected === true; }
  function updateControls() {
    const primary = mission(snapshot.missions?.primary);
    const disabled = !canControl() || snapshot.missions?.primary == null || pending.has('primary');
    $('pause-primary').disabled = disabled || primary.enabled === false || primary.pausedBy === 'user';
    $('resume-primary').disabled = disabled || (primary.status === 'running' && primary.enabled !== false);
    $('save-priorities').disabled = !canControl() || pending.has('priorities');
    for (const button of $('temporary-list').querySelectorAll('button')) {
      button.disabled = !canControl() || !button.dataset.cancelId || button.dataset.cancelStatus === 'cancelling'
        || pending.has(`cancel:${button.dataset.cancelId}`);
    }
  }
  async function mutate(key, endpoint, body, success) {
    if (pending.has(key)) return;
    pending.add(key);
    updateControls();
    renderMissions();
    try {
      await request(endpoint, body);
      if (key === 'priorities') prioritiesDirty = false;
      toast(success);
      await refreshState();
    } catch (error) { toast(error.message || '操作失败', true); }
    finally {
      pending.delete(key);
      renderMissions();
      updateControls();
    }
  }
  $('pause-primary').addEventListener('click', () => mutate('primary', '/api/primary', { operation: 'pause' }, '暂停请求已接收，等待主任务状态更新'));
  $('resume-primary').addEventListener('click', () => mutate('primary', '/api/primary', { operation: 'resume' }, '恢复请求已接收，等待主任务状态更新'));
  $('priorities-form').addEventListener('input', () => { prioritiesDirty = true; });
  $('priorities-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!$('priorities-form').reportValidity()) return;
    mutate('priorities', '/api/priorities', { temporary: Number($('temporary-priority').value), primary: Number($('primary-priority').value) }, '优先级更新请求已接收');
  });
  $('inventory-search').addEventListener('input', renderStorage);
  function selectStorageTab(active) {
    for (const tab of ['inventory', 'chests']) {
      const selected = active === tab;
      $(`${tab}-tab`).classList.toggle('is-active', selected);
      $(`${tab}-tab`).setAttribute('aria-selected', String(selected));
      $(`${tab}-tab`).tabIndex = selected ? 0 : -1;
      $(`${tab}-panel`).hidden = !selected;
    }
  }
  for (const tab of ['inventory', 'chests']) {
    $(`${tab}-tab`).addEventListener('click', () => selectStorageTab(tab));
    $(`${tab}-tab`).addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'inventory' : event.key === 'End' ? 'chests' : tab === 'inventory' ? 'chests' : 'inventory';
      selectStorageTab(next);
      $(`${next}-tab`).focus();
    });
  }
  for (const link of document.querySelectorAll('.nav-link')) link.addEventListener('click', () => {
    for (const peer of document.querySelectorAll('.nav-link')) peer.classList.toggle('is-active', peer === link);
  });

  function applySnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('快照格式无效');
    snapshot = value;
    receivedAt = Date.now();
    revision++;
    renderAgent();
    renderMissions();
    renderProgress();
    renderStorage();
    renderSafety();
    renderViewer();
    renderMessages();
    connectionUI();
  }
  async function refreshState(manual = false) {
    if (stateRequest) return stateRequest;
    const startRevision = revision;
    $('refresh-state').disabled = true;
    stateRequest = (async () => {
      try {
        const value = await request('/api/state');
        // A slower initial GET must never replace a newer SSE snapshot.
        if (revision === startRevision) applySnapshot(value);
      } catch (error) {
        if (manual) toast(error.message, true);
        connectionUI();
      } finally {
        stateRequest = null;
        $('refresh-state').disabled = false;
      }
    })();
    return stateRequest;
  }
  function reconnect() {
    streamOpen = false;
    if (stream) { stream.close(); stream = null; }
    if (stopped || reconnectTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectStream(); }, delay);
    connectionUI();
  }
  function connectStream() {
    if (stopped) return;
    connectingSince = Date.now();
    if (!('EventSource' in window)) {
      set('stream-label', '浏览器不支持 SSE');
      $('connection-banner').hidden = false;
      set('connection-banner', '此浏览器不支持 EventSource，请使用现代浏览器；可手动刷新状态。');
      return;
    }
    const source = new EventSource(agentApi + '/events');
    stream = source;
    source.onopen = () => {
      if (stream !== source) return;
      streamOpen = true;
      connectionUI();
    };
    source.addEventListener('state', (event) => {
      if (stream !== source) return;
      try {
        applySnapshot(JSON.parse(event.data));
        reconnectAttempt = 0;
      } catch { toast('收到无效状态快照，正在重新连接', true); reconnect(); }
    });
    source.onerror = () => { if (stream === source) reconnect(); };
  }
  $('refresh-state').addEventListener('click', () => refreshState(true));
  window.addEventListener('online', () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    if (stream) stream.close();
    connectStream();
    refreshState();
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(viewerTimer);
    if (stream) stream.close();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) { stopped = false; connectStream(); refreshState(); }
  });
  setInterval(() => {
    if (stopped) return;
    set('current-time', time(Date.now()));
    connectionUI();
    if (stream && Date.now() - Math.max(receivedAt, connectingSince) > 15000) reconnect();
  }, 1000);
  $('agent-select').addEventListener('change', event => {
    const url = new URL(location.href);
    url.searchParams.set('agent', event.target.value);
    location.assign(url);
  });
  fetch('/api/agents', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json()).then(agents => {
    if (!Array.isArray(agents) || !agents.length) return;
    const current = agents.find(agent => agent.id === selectedAgent) ?? agents[0];
    $('agent-select').replaceChildren(...agents.map(agent => {
      const option = node('option', '', agent.name + (agent.connected ? '' : '（离线）'));
      option.value = agent.id;
      option.selected = agent.id === current.id;
      return option;
    }));
    $('agent-select').disabled = agents.length < 2;
    set('model-name', current.modelConfigured ? current.model : '模型未配置密钥');
    if (selectedAgent && selectedAgent !== current.id) location.replace(location.pathname);
  }).catch(() => {});
  fetch('/api/item-tiles').then(r => r.json()).then(tiles => {
    itemTiles = tiles;
    cached.delete('inventory-list');
    cached.delete('chests-list');
    renderStorage();
  }).catch(() => {});
  selectMode('chat');
  renderAgent();
  renderProgress();
  renderSafety();
  connectStream();
  refreshState();
})();
