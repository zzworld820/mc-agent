import { mkdir, open, readFile, writeFile, rename } from 'node:fs/promises';

const run = process.env.SURVIVAL_RUN;
if (!run) throw new Error('需要 SURVIVAL_RUN 指定本轮测试记录');
const root = new URL(`../reports/runs/${encodeURIComponent(run)}/`, import.meta.url);
const folder = new URL('游戏日报/', root);
const cursorFile = new URL('daylog-cursor.json', root);
await mkdir(folder, { recursive: true });
let cursor;
try { cursor = JSON.parse(await readFile(cursorFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  cursor = { offset: 0, firstDay: null, active: null, previous: null };
}
let busy = false;
const time = (value) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const text = (value) => String(value ?? '暂无记录').replaceAll('\n', ' ');
async function save(file, body) {
  const temporary = new URL(`${file.pathname.split('/').at(-1)}.tmp`, file);
  await writeFile(temporary, body);
  await rename(temporary, file);
}
function snapshot(event) {
  return { time: event.time, health: event.health, food: event.food, deaths: event.deaths,
    inventory: event.inventory, equipment: event.equipment, home: event.home, house: event.house,
    farm: event.farm, storage: event.storage, development: event.development, failures: event.failures, task: event.task };
}
async function complete(day, nextDay) {
  const number = day.worldDay - cursor.firstDay + 1;
  const end = day.end;
  const start = day.start;
  const lines = [`# 第${number}个游戏日记录`, '',
    `服务器游戏日编号为 ${day.worldDay}，进入下一游戏日后生成。`,
    `实际观测时间为 ${time(start.time)} 至 ${time(end.time)}（上海时间）。`, '',
    '## 昨天做了什么', ''];
  const work = Object.entries(day.work);
  lines.push(...(work.length ? work.map(([message, count]) => `- ${text(message)}${count > 1 ? `（记录${count}次）` : ''}`) : ['这段观测没有任务进度事件。']));
  lines.push('', '## 昨天结束时的状态', '',
    `- 生命 ${Number(end.health || 0).toFixed(1)}/20，饥饿 ${end.food}/20`,
    `- 当天记录死亡 ${day.deaths}次，累计死亡 ${end.deaths}次`,
    `- 住所 ${end.home ? `${end.home.kind || '已登记'}，坐标 ${end.home.x},${end.home.y},${end.home.z}` : '尚未建成'}`,
    `- 正式房屋 ${end.house ? '已登记工程' : '尚未建成'}`,
    `- 仓储 ${end.storage ? `${end.storage.chests}个箱子，状态${end.storage.status}` : '尚未建成'}`,
    `- 农田 ${end.farm ? `${end.farm.width}×${end.farm.depth}，累计收割${end.farm.harvestCycles || 0}轮，状态${end.farm.status}` : '尚未建成'}`,
    `- 装备 ${(end.equipment || []).map((entry) => entry.name || '空').join('、')}`,
    `- 最后任务 ${text(end.task)}`, '', '## 期末背包', '',
    ...(end.inventory?.length ? end.inventory.map((item) => `- ${item.name} × ${item.count}`) : ['背包为空。']), '',
    '## 卡点与死亡', '',
    ...day.deathRecords.map((event) => `- ${time(event.time)}，死因 ${text(event.serverMessage || '未收到服务器死因，请查看死亡记录')}，任务 ${text(event.task)}，位置 ${JSON.stringify(event.position)}`),
    ...Object.entries(end.failures || {}).map(([goal, failure]) => `- ${goal}最近失败原因为 ${text(failure.reason)}`));
  if (!day.deathRecords.length && !Object.keys(end.failures || {}).length) lines.push('本段记录没有死亡或失败信息。');
  lines.push('', '[完整死亡原因与死亡前轨迹](../死亡记录.md)');
  if (number === 1) lines.push('', '首日从角色入服开始记录，可能只覆盖该游戏日的一部分。');
  if (nextDay > day.worldDay + 1) lines.push('', `随后跳到服务器游戏日${nextDay}，中间${nextDay - day.worldDay - 1}日没有观测记录，可能包含睡眠跳时或离线时段。`);
  lines.push('', '本记录根据游戏内天数和已写入事件生成。没有记录的行为不推断为已完成，背包是期末库存。', '');
  const body = lines.join('\n');
  const filename = `第${String(number).padStart(3, '0')}天.md`;
  await save(new URL(filename, folder), body);
  await save(new URL('昨天.md', folder), body);
  await save(new URL('游戏日报.md', root), `# 游戏日报\n\n最新已完成的游戏日为第${number}天。\n\n- [昨天做了什么](游戏日报/昨天.md)\n- [第${number}天](游戏日报/${filename})\n\n游戏天数变化后自动更新。\n`);
}
async function accept(event) {
  if (event.type === 'HEARTBEAT' && Number.isInteger(event.worldDay)) {
    cursor.firstDay ??= event.worldDay;
    if (cursor.active && cursor.active.worldDay !== event.worldDay) {
      await complete(cursor.active, event.worldDay);
      cursor.active = null;
    }
    cursor.active ??= { worldDay: event.worldDay, start: snapshot(event), end: snapshot(event), work: {}, deaths: 0, deathRecords: [] };
    cursor.active.end = snapshot(event);
    cursor.previous = snapshot(event);
  } else if (cursor.active && event.type === 'PROGRESS' && event.text) {
    const message = event.text;
    if (/等待|留在住所观察|自主生存：|暂缓，留在当前位置/.test(message)) return;
    cursor.active.work[message] = (cursor.active.work[message] || 0) + 1;
  } else if (cursor.active && event.type === 'DEATH') {
    cursor.active.deaths++;
    cursor.active.deathRecords.push(event);
  } else if (cursor.active && event.type === 'DEATH_REPORT') {
    const record = cursor.active.deathRecords.find((entry) => entry.id === event.id);
    if (record) record.serverMessage = event.serverMessage;
  }
}
async function update() {
  if (busy) return;
  busy = true;
  let file;
  try {
    file = await open(new URL('survival-events.jsonl', root), 'r');
    const info = await file.stat();
    if (info.size < cursor.offset) throw new Error('事件日志已截短，需要人工核对日报游标');
    while (cursor.offset < info.size) {
      const buffer = Buffer.alloc(Math.min(2 * 1024 * 1024, info.size - cursor.offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset);
      const boundary = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (boundary < 0) break;
      for (const line of buffer.subarray(0, boundary).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        await accept(JSON.parse(line));
      }
      cursor.offset += boundary + 1;
      await save(cursorFile, JSON.stringify(cursor));
    }
  } catch (error) { console.error(new Date().toISOString(), error.message); }
  finally { await file?.close(); busy = false; }
}
await update();
setInterval(update, 10000);
