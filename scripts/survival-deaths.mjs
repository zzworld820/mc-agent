import { appendFile, writeFile } from 'node:fs/promises';
import chatLoader from 'prismarine-chat';

const localTime = (value) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const coordinates = (p) => p ? [p.x, p.y, p.z].map((n) => Number(n).toFixed(1)).join(', ') : '未知';

export function explainDeath(message) {
  if (!message) return '未收到服务器死因，暂时无法确认直接原因';
  const enemies = [['Zombie', '僵尸'], ['Skeleton', '骷髅'], ['Witch', '女巫'], ['Creeper', '苦力怕'], ['Spider', '蜘蛛'], ['Drowned', '溺尸']];
  const enemy = enemies.find(([name]) => message.includes(name));
  if (/slain by|shot by|killed by|blown up by/.test(message)) return enemy ? `被${enemy[1]}${message.includes('using magic') ? '使用魔法' : message.includes('shot by') ? '射杀' : '击杀'}` : `服务器记录被击杀，原文为 ${message}`;
  if (/drowned/.test(message)) return '溺水死亡';
  if (/lava/.test(message)) return '接触熔岩死亡';
  if (/burned|flames/.test(message)) return '燃烧死亡';
  if (/fell|hit the ground/.test(message)) return '坠落死亡';
  if (/starved/.test(message)) return '饥饿死亡';
  if (/suffocated/.test(message)) return '陷入方块窒息死亡';
  return `服务器死因原文为 ${message}`;
}

export function renderDeath(record) {
  const before = [...record.history].reverse().find((entry) => entry.health > 0) || record.snapshot;
  const equipment = before.equipment.map((item) => item.name || '空').join('、');
  const reasons = before.danger?.reasons || [];
  const lines = [
    `## 第${record.number}次死亡`, '',
    `- 时间 ${localTime(record.time)}（上海时间），服务器游戏日 ${record.snapshot.worldDay}`,
    `- 本轮累计约 ${record.elapsedDays.toFixed(2)} 个游戏日`,
    `- 直接死因 ${explainDeath(record.serverMessage)}`,
    `- 服务器原文 ${record.serverMessage || '尚未收到'}`,
    `- 证据来源 ${record.source || '未收到服务器死亡消息'}`,
    `- 死亡位置 ${coordinates(record.snapshot.position)}`,
    `- 当时任务 ${record.snapshot.task}`,
    `- 临死前最近生命 ${before.health}/20，饥饿 ${before.food}/20，记录时间 ${localTime(before.time)}`,
    `- 装备 ${equipment}`,
    `- 住所 ${before.home ? coordinates(before.home) : '尚未建立'}`,
    `- 应急掩体 ${before.emergencyShelter ? `${before.emergencyShelter.kind}，深度 ${before.emergencyShelter.depth}` : '未登记'}`,
    `- 危险判定 ${reasons.join('、') || '该采样时刻没有危险理由'}`,
    `- 最近失败 ${JSON.stringify(before.failures)}`,
    '', '### 死亡前轨迹', '',
    '|时间（上海）|生命|饥饿|位置|任务|感知到的危险|', '|---|---:|---:|---|---|---|',
  ];
  for (const entry of record.history) {
    const threats = (entry.danger?.threats || []).map((enemy) => `${enemy.name} ${Number(enemy.distance).toFixed(1)}格`).join('、');
    const clean = (value) => String(value ?? '').replaceAll('|', '／').replaceAll('\n', ' ');
    lines.push(`|${localTime(entry.time)}|${entry.health}|${entry.food}|${coordinates(entry.position)}|${clean(entry.task)}|${clean(threats)}|`);
  }
  lines.push('', '轨迹来自每秒及生命变化时的采样。直接死因依据服务器消息，任务与危险记录用于复盘，无法确认的环节保留为未知。', '');
  return lines.join('\n');
}

export function attachDeathLogging({ bot, status, event, describeTask, directory }) {
  const ChatMessage = chatLoader('1.21.6');
  const history = [];
  let serverCause = null;
  let pending = null;
  let reportWrites = Promise.resolve();
  const scheduledReports = new Map();

  function snapshot() {
    const state = bot.strategySupervisor?.state;
    return structuredClone({
      time: new Date().toISOString(), health: bot.health, food: bot.food,
      position: bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
      task: describeTask(), worldDay: bot.time?.day, worldTime: bot.time?.time,
      home: state?.home || null, emergencyShelter: state?.emergencyShelter || null,
      failures: state?.failures || {}, danger: bot.strategySupervisor?.danger || null,
      equipment: [5, 6, 7, 8, 45].map((slot) => ({ slot, name: bot.inventory?.slots[slot]?.name || null })),
      inventory: bot.inventory?.items().map((item) => ({ name: item.name, count: item.count })) || [],
      oxygen: bot.oxygenLevel, onGround: bot.entity?.onGround,
    });
  }

  function capture() {
    if (!bot.entity || !bot.isAlive || bot.health <= 0) return;
    const entry = snapshot();
    history.push(entry);
    while (history.length > 250 || history.length && Date.parse(history[0].time) < Date.now() - 60000) history.shift();
  }

  function rememberCause(message, source) {
    serverCause = { message, source, at: Date.now() };
    if (pending && Date.now() - Date.parse(pending.time) < 3000) {
      pending.serverMessage = message;
      pending.source = source;
    }
  }

  async function publish(record) {
    status.lastDeathSummary = { number: record.number, time: record.time, reason: explainDeath(record.serverMessage) };
    await event('DEATH_REPORT', record);
    const body = renderDeath(record);
    await appendFile(new URL('死亡记录.md', directory), body + '\n');
    await writeFile(new URL('最近一次死亡.md', directory), body);
    console.log(`\n${body}`);
  }

  function queueReport(record) {
    reportWrites = reportWrites.then(() => publish(record)).catch((error) => {
      console.error('死亡报告写入失败', error.message);
    });
  }

  bot._client.on('death_combat_event', (packet) => {
    if (packet.playerId !== bot.entity?.id) return;
    try { rememberCause(ChatMessage.fromNotch(packet.message).toString(), '服务器 death_combat_event 数据包'); }
    catch (error) { console.error('死亡消息解析失败', error.message); }
  });
  bot.on('messagestr', (message) => {
    if (message.startsWith(`${bot.username} `) && /slain by|shot by|killed by|blown up|drowned|fell|hit the ground|lava|burned|flames|starved|suffocated|died/.test(message)) {
      rememberCause(message, '服务器死亡广播');
    }
  });
  const timer = setInterval(capture, 1000);
  bot.on('health', capture);
  bot.on('death', () => {
    status.deaths++;
    const current = snapshot();
    const cause = serverCause && Date.now() - serverCause.at < 3000 ? serverCause : null;
    const record = {
      id: `${status.username}-${Date.now()}-${status.deaths}`, number: status.deaths,
      time: current.time, elapsedDays: (status.observedCalendarTicks || 0) / 24000,
      position: current.position, task: current.task, snapshot: current,
      serverMessage: cause?.message || null, source: cause?.source || null,
      history: structuredClone([...history, current]),
    };
    pending = record;
    event('DEATH', { id: record.id, number: record.number, position: record.position, task: record.task, serverMessage: record.serverMessage })
      .catch((error) => console.error('死亡事件写入失败', error.message));
    console.log(`\n[死亡] 第${record.number}次，位置 ${coordinates(record.position)}，正在汇总死因\n`);
    const reportTimer = setTimeout(() => {
      scheduledReports.delete(record);
      queueReport(record);
      if (pending === record) pending = null;
    }, 1500);
    scheduledReports.set(record, reportTimer);
    history.length = 0;
    serverCause = null;
  });
  bot.once('end', () => clearInterval(timer));
  return {
    async flush() {
      for (const [record, reportTimer] of scheduledReports) {
        clearTimeout(reportTimer);
        queueReport(record);
      }
      scheduledReports.clear();
      await reportWrites;
    },
  };
}
