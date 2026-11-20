import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { testProgress, progressLines, chestLines } from './survival-progress.mjs';

const directory = process.env.SURVIVAL_RUN
  ? new URL(`../reports/runs/${encodeURIComponent(process.env.SURVIVAL_RUN)}/`, import.meta.url)
  : new URL('../reports/', import.meta.url);
const currentPage = new URL('../reports/survival-live.md', import.meta.url);
const statusFile = new URL('survival-status.json', directory);
const journal = new URL('阶段记录.md', directory);
const page = new URL('当前状态.md', directory);
await mkdir(directory, { recursive: true });
let previous = {};
let updating = false;
const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无记录';
const position = (p) => p ? [p.x, p.y, p.z].map((value) => Number(value).toFixed(1)).join(', ') : '暂无记录';
const clean = (value) => String(value ?? '暂无记录').replaceAll('|', '／').replaceAll('\n', ' ');

async function atomicWrite(file, body) {
  const temporary = new URL(`${file.pathname.split('/').at(-1)}.tmp`, file);
  await writeFile(temporary, body);
  await rename(temporary, file);
}

async function update() {
  if (updating) return;
  updating = true;
  try {
    const status = JSON.parse(await readFile(statusFile, 'utf8'));
    const progress = testProgress(status);
    let processAlive = false;
    try {
      const pid = Number((await readFile(new URL('runner.pid', directory), 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); processAlive = true; }
    } catch {}
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(status.lastObservedAt)) / 1000));
    const running = status.phase !== 'stopped' && processAlive && age <= 60;
    const phase = status.phase === 'stopped' ? '已停止' : !processAlive ? '测试进程已退出' : age > 60 ? '心跳超过60秒未更新' : '正在运行';
    const changes = {
      运行状态: phase, 完整生存天数: status.elapsedGameDays || 0, 死亡次数: status.deaths || 0,
      当前目标: status.lastFailure?.goal || status.task,
      住所: status.home ? position(status.home) : '未建成', 房屋: status.house?.projectId || '未建成',
      仓储: status.storage ? `${status.storage.chests}箱，${status.storage.status}` : '未建成',
      农场: status.farm ? `${status.farm.width}×${status.farm.depth}，${status.farm.status}，收割${status.farm.harvestCycles || 0}轮` : '未建成',
      装备: (status.equipment || []).map((item) => item.name || '空').join('、'),
      发育阶段: progress.stage,
      下一步: progress.next,
      最近局部脱困: status.localRecovery ? `${status.localRecovery.status}，${status.localRecovery.action || '尚未完成动作'}，${position(status.localRecovery.position || status.localRecovery.origin)}` : '尚无局部脱困记录',
      待完成树木: status.treeHarvest ? `树根 ${position(status.treeHarvest.base)}，原记录${status.treeHarvest.logs}块原木` : '无未完成采伐记录',
    };
    const entries = Object.entries(changes).filter(([key, value]) => previous[key] !== value);
    if (entries.length) {
      await appendFile(journal, `\n## ${time(Date.now())}\n\n${entries.map(([key, value]) => `- ${key}更新为 ${clean(value)}`).join('\n')}\n`);
      previous = changes;
    }
    const inventory = new Map();
    for (const item of status.inventory || []) inventory.set(item.name, (inventory.get(item.name) || 0) + item.count);
    const lines = [
      '# 生存测试当前状态', '',
      `**${phase}**　角色 ${status.username}`, '',
      `最后游戏心跳为 **${time(status.lastObservedAt)}**（上海时间），距本页刷新约${age}秒。`,
      `本页刷新于 ${time(Date.now())}，每10秒刷新。超过60秒没有新心跳时，以异常或停止状态处理。`, '',
      '## 生存与任务', '',
      `- 已完成 **${status.elapsedGameDays || 0}个游戏日**，累计约${Number(status.activeGameDays || 0).toFixed(2)}天`,
      `- 累计死亡 **${status.deaths || 0}次**`,
      `- 最近死亡原因 ${clean(status.lastDeathSummary?.reason || '本轮尚无死亡报告')}`,
      `- 最近生命 **${Number(status.health || 0).toFixed(1)}/20**，饥饿 **${status.food}/20**`,
      `- 最近坐标 ${position(status.position)}`,
      `- 当前任务 ${clean(status.task)}`,
      `- 最近危险 ${clean(status.danger?.reasons?.join('、') || '未记录到危险')}`, '',
    ];
    if (status.health < 10) lines.push('**最近记录为低生命值，正在核对避险和恢复情况。**', '');
    if (!running) lines.push('**以下数值为最后一次观测，请结合上方心跳时间查看。**', '');
    lines.push(...progressLines(status), ...chestLines(status));
    lines.push('## 设施状态', '', ...Object.entries(changes).filter(([key]) => !['运行状态', '完整生存天数', '死亡次数', '当前目标', '发育阶段', '下一步'].includes(key))
      .map(([key, value]) => `- ${key}为 ${clean(value)}`),
      `- 基地入住检查为 ${status.base?.ready ? '已完成' : '尚未完成'}`,
      `- 重生点睡眠确认 ${status.home?.respawnConfirmed ? '已确认' : '尚未确认'}`, '',
      '## 最近背包', '', '|物品|数量|', '|---|---:|',
      ...[...inventory].map(([name, count]) => `|${clean(name)}|${count}|`), '');
    if (!inventory.size) lines.push('背包为空。', '');
    lines.push('## 当前失败与等待原因', '');
    for (const [goal, failure] of Object.entries(status.failures || {})) {
      lines.push(`- ${goal}累计失败${failure.attempts}次，最近原因为 ${clean(failure.reason)}`);
    }
    if (!Object.keys(status.failures || {}).length) lines.push('最近状态尚无失败记录。');
    lines.push('', '## 文件位置', '',
      `- [阶段变化记录](${journal.pathname})`,
      `- [原始状态 JSON](${statusFile.pathname})`,
      `- [完整事件日志](${new URL('survival-events.jsonl', directory).pathname})`, '',
      `- [死亡原因与轨迹](${new URL('死亡记录.md', directory).pathname})`, '',
      '天数是本轮在线观察的累计值。仓储与农场数据为最近观察结果，阶段验收以实际完成记录为准。', '');
    const body = lines.join('\n');
    await atomicWrite(page, body);
    await atomicWrite(currentPage, body);
  } catch (error) {
    console.error(new Date().toISOString(), error.message);
  } finally { updating = false; }
}
await update();
setInterval(update, 10000);
