import { IRON_EQUIPMENT } from '../src/strategy/development.js';

const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未核验';
const clean = (value) => String(value ?? '未知').replaceAll('|', '／').replaceAll('\n', ' ');
const position = (p) => p ? `${p.x}, ${p.y}, ${p.z}` : '未知';
const sumItems = (items) => {
  const counts = new Map();
  for (const item of items || []) counts.set(item.name, (counts.get(item.name) || 0) + item.count);
  return counts;
};

export function testProgress(status) {
  const check = status.developmentCheck;
  const owned = sumItems(status.inventory);
  for (const item of status.equipment || []) if (item.name) owned.set(item.name, (owned.get(item.name) || 0) + 1);
  const missingIron = IRON_EQUIPMENT.filter((name) => !owned.get(name));
  const baseReady = !!status.base?.ready && !!status.house && status.base.projectId === status.house.projectId;
  const previousCamp = !!status.house && (status.chestContents || []).some((chest) => chest.archived
    && chest.observedAt && Array.isArray(chest.items) && !chest.verificationError);
  const checkpoints = [
    { name: '安全住所', done: !!status.homeVerified, next: '完成并确认能入住的避难所' },
    { name: '营地检查与可靠物资转存', done: !!status.home?.campReady || baseReady || previousCamp, next: '核对箱子转存，完成营地检查' },
    { name: '正式房屋与基地设施', done: baseReady, next: '建造正式房屋，配齐床、工作台、熔炉和多箱仓储' },
    { name: '睡眠确认重生点', done: !!status.home?.respawnConfirmed, next: '在基地床上实际睡眠，确认重生点' },
    { name: '基础材料与备用工具入库', done: !!check?.basicReserves, next: '储存基础材料与备用石制工具' },
    { name: '农场运作并完成收割', done: (status.farm?.harvestCycles || 0) > 0, next: '建立可维护的农场，完成首轮收割和补种' },
    { name: '足量食物储备', done: !!check?.foodReady, next: '积累可支持多次恢复的食物储备' },
    { name: '铁制装备与工具', done: missingIron.length === 0, next: '备足食物、火把和石器后采铁，配齐铁制装备与工具' },
    { name: '备用铁入库并通过第一阶段验收', done: !!status.development?.ironCompletedAt && !!check?.ironReady,
      next: '储存备用铁并复核第一阶段所有条件' },
  ];
  const first = checkpoints.find((entry) => !entry.done);
  const completed = checkpoints.filter((entry) => entry.done).length;
  const elapsed = (status.observedCalendarTicks || 0) / 24000;
  const target = status.targetDays || 100;
  const night = (status.worldTime || 0) % 24000 >= 10000;
  const blockers = Object.entries(status.failures || {}).filter(([goal]) => goal === status.lastFailure?.goal || first?.name.includes('营地') && goal === 'camp');
  return {
    checkpoints, completed, remaining: checkpoints.length - completed, missingIron, elapsed, target,
    daysRemaining: Math.max(0, target - elapsed),
    stage: first?.name || '第一阶段条件已满足，继续生存观察',
    next: `${night && first ? '天亮且安全后，' : ''}${first?.next || '维护基地、农场和物资，继续完成生存天数目标'}`,
    blockers,
  };
}

export function progressLines(status) {
  const progress = testProgress(status);
  const lines = ['## 当前阶段与下一步', '',
    `- 当前阶段 **${progress.stage}**`,
    `- 下一步 ${progress.next}`,
    `- 第一阶段完成 **${progress.completed}/${progress.checkpoints.length}项**，还差 **${progress.remaining}项**`,
    `- 百日目标已累计 ${progress.elapsed.toFixed(2)}/${progress.target}个游戏日，还差约 **${progress.daysRemaining.toFixed(2)}天**`, '',
    '第一阶段进度按下列验收项计数。剩余天数与建设进度分别计算，建设剩余耗时尚无可靠估算。', '',
    ...progress.checkpoints.map((entry) => `- [${entry.done ? 'x' : ' '}] ${entry.name}`), ''];
  for (const [goal, failure] of progress.blockers) lines.push(`- 当前阻碍 ${clean(failure.reason)}（${goal}累计失败${failure.attempts}次）`);
  if (status.nightShelter) lines.push(`- 本夜留守的自有避难所 ${position(status.nightShelter.home)}`);
  if (status.houseConstruction) {
    const house = status.houseConstruction;
    lines.push('', '### 房屋实际施工', '',
      `- 工程 ${clean(house.model)}，位置 ${position(house.origin)}`,
      `- 实地匹配外壳 ${house.matched}/${house.total}格，尚未匹配 ${house.total - house.matched}格，其中未加载 ${house.unknown}格`,
      `- 最近读取 ${time(house.observedAt)}（上海时间）`,
      `- 待完善 ${house.finishingPending ? '临时封闭材料将在食物生产和储备稳定后替换为原模型窗户、屋顶' : '主体按原模型核验，家具与基地验收见上方清单'}`, '');
    if(house.facilities) lines.push(`- 实地设施 床${house.facilities.beds}、箱子${house.facilities.chests}、熔炉${house.facilities.furnaces}、工作台${house.facilities.craftingTables}`, '');
  }
  const check = status.developmentCheck;
  if (check) {
    const stored = check.stored;
    const settings = check.settings;
    lines.push('', '### 库存目标', '', '|项目|近期成功核验库存|目标|缺口|', '|---|---:|---:|---:|');
    const rows = [
      ['原木', stored.logs, settings.logs], ['圆石', stored.stone, settings.stone],
      ['食物点数', stored.food, check.foodTarget], ['备用铁锭', stored.items.iron_ingot || 0, settings.spareIron],
      ...['stone_pickaxe', 'stone_axe', 'stone_sword'].map((name) => [name, stored.items[name] || 0, 1]),
    ];
    for (const [name, count, target] of rows) lines.push(`|${name}|${count}|${target}|${Math.max(0, target - count)}|`);
    lines.push('', '库存目标仅计入近期成功核验的基地箱子。缓存过期或转存核对失败的箱子需要重新检查，当前背包单独列在下方。',
      `铁制装备与工具尚缺 ${progress.missingIron.length}项${progress.missingIron.length ? `，包括 ${progress.missingIron.join('、')}` : ''}。`, '');
  }
  return lines;
}

export function chestLines(status, now = Date.now()) {
  const lines = ['## 已有箱子的内容', ''];
  const chests = status.chestContents || [];
  if (!chests.length) return [...lines, '尚无箱子内容快照，等待实际开箱核验。', ''];
  const seen = new Set();
  for (const chest of chests) {
    const key = `${chest.dimension || ''}:${chest.containerKey || chest.id || position(chest.position)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const observed = chest.observedAt && Array.isArray(chest.items);
    const stale = observed && now - chest.observedAt > 120000;
    lines.push(`### ${chest.archived ? '归档仓库' : '当前基地'}箱子 ${position(chest.position)}`, '',
      `- 维度 ${clean(chest.dimension)}`,
      `- 最近开箱读取 ${time(chest.observedAt)}（上海时间）`,
      `- 核验状态 ${chest.missing ? '箱子缺失或被替换' : !observed ? '尚未读取内容' : chest.verificationError ? '转存核验失败，实际库存待复查' : stale ? '历史快照，超过两分钟未复查' : '最近两分钟内读取'}`);
    if (chest.verificationError) lines.push(`- 核验问题 ${clean(chest.verificationError)}`);
    if (Number.isFinite(chest.freeSlots)) lines.push(`- 上次读取空槽位 ${chest.freeSlots}`);
    lines.push('');
    if (!observed) { lines.push('箱内物品未知。', ''); continue; }
    const items = sumItems(chest.items);
    if (!items.size) { lines.push('最近一次读取时箱子为空。', ''); continue; }
    lines.push('|物品|上次读取数量|', '|---|---:|', ...[...items].map(([name, count]) => `|${clean(name)}|${count}|`), '');
  }
  return lines;
}
