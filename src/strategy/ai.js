import { chatCompletion } from '../chat/llm.js';

const COOLDOWN_MS = 30000;
const LONG_TERM_GOAL = '在主世界活下去，逐步建立安全基地、稳定食物来源和备用物资。';

export const survivalSkills = {
  timber: '砍整棵树，补齐起步木料',
  finish_tree: '继续已登记的整树采伐',
  wool: '收集附近羊毛',
  bootstrap: '准备木镐和工作台',
  shelter: '选址施工临时住所',
  camp: '完善临时住所的箱子和床',
  tools: '准备石镐、石斧、石剑',
  workshop: '准备工作台和熔炉',
  house: '备料并施工房屋主体',
  base: '核验与安装正式基地设施',
  house_finish: '完成已有房屋的窗和屋顶',
  expand_house: '按已登记工程加建一层并连接梯井',
  food: '补充可食用口粮',
  storage: '把多余物品转存到仓储并核验',
  reserves: '准备基础储备',
  farm: '建设或巡检、收割、补种农田',
  expandFarm: '扩建已登记农田',
  food_stock: '补齐备用口粮',
  protection: '按安全出发条件准备一件缺少的铁装备',
  iron_reserve: '补齐备用铁',
  recovery_kit: '利用基地恢复食物和基本工具',
  pasture: '建设或维护牧场',
  obtain_item: '把随身某种物品补到指定总数（最多64，仅限清单内物品）',
};

export const obtainableItems = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'cherry_log', 'mangrove_log', 'cobblestone', 'dirt', 'coal', 'torch',
  'wooden_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'crafting_table', 'furnace',
];

export function createSurvivalPlanner({ npc, llm, complete = chatCompletion }) {
  let request = null;
  const owners = new WeakMap();
  const projectActions = new WeakSet();
  let report;
  let recent = [];
  let blocked = new Set();
  let failures = [];
  let paused = false;
  let retryAt = 0;
  let nextDecisionAt = 0;

  function submit(text, notify, receivedAt) {
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('请提供 1～500 字的任务目标');
    if (request) throw new Error('已有玩家任务，请等它完成或先叫停');
    request = { text: text.trim(), notify, receivedAt };
    blocked = new Set();
    failures = [];
    paused = false;
    report = null;
    recent = [];
    nextDecisionAt = 0;
  }

  function finish(message) {
    const owner = request;
    request = null;
    owner?.notify(message);
    blocked = new Set();
    failures = [];
    paused = false;
    nextDecisionAt = Date.now() + COOLDOWN_MS;
  }

  function announce(action) {
    const owner = owners.get(action);
    if (!owner || owner !== request || owner.announced) return;
    owner.announced = true;
    owner.notify(`AI 的第一步方案：${action.plan}`);
  }

  function record({ action, status, reason, evidence }) {
    if (projectActions.has(action) || owners.get(action) !== request) return null;
    report = { action, status, reason, evidence };
    recent = [...recent.slice(-3), { skill: action.skill, status, reason }];
    nextDecisionAt = 0;
    if (status === 'failed' || status === 'no_progress') {
      blocked.add(signature(action));
      failures.push(`${signature(action)}：${reason || '未观察到进展'}`);
      if (failures.length >= 2) {
        const summary = `已暂停，两个方案未取得进展。 ${failures.join('；')}`;
        if (request) finish(`「${request.text}」${summary}`);
        else paused = true;
        return summary;
      }
    } else if (status === 'completed') {
      blocked = new Set();
      failures = [];
    }
    return null;
  }

  async function decide(snapshot, signal) {
    if (!llm.apiKey || Date.now() < retryAt) return { type: 'fallback' };
    if ((!snapshot.project && paused) || Date.now() < nextDecisionAt) return { type: 'wait' };
    const pendingRequest = request;
    const available = snapshot.available;
    const skillList = Object.fromEntries(available.map(name => [name, survivalSkills[name]]));
    const messages = [
      { role: 'system', content: [
        `你是 ${npc.name}，一个 Minecraft 生存 Agent。${LONG_TERM_GOAL}`,
        '根据现场与上一步证据给出简短方案，每次只提交一个下一步。玩家任务优先于一般发育。',
        'skill 是本地可执行技能；wait 表示等条件变化；done 只用于有实测证据支持的玩家任务完成。',
        '工程必须按持久化步骤推进。只能从当前可执行步骤及相关支援技能中选择，整项完成由本地验收。',
        '执行结果由本地确认。遇到失败先换方案，勿重复被排除的调用。屋外行动由本地审核，可随时被避险中断。',
        '工具参数中的 plan 写准备做的事，success 写本步可观察的验收条件。obtain_item 的 count 是背包目标总数。',
      ].join('\n') },
      { role: 'user', content: JSON.stringify({ objective: snapshot.project?.objective ?? request?.text ?? LONG_TERM_GOAL,
        playerTask: Boolean(snapshot.project || request), receivedAt: request?.receivedAt, ...snapshot, skills: skillList,
        feedback: snapshot.project ? undefined : report, recent: snapshot.project ? undefined : recent, tried: snapshot.project ? [] : [...blocked] }) },
    ];
    const tools = [{ type: 'function', function: { name: 'next_survival_step',
      description: '提交下一步生存方案',
      parameters: { type: 'object', required: ['type', 'plan'], properties: {
        type: { type: 'string', enum: ['skill', 'wait', 'done'] },
        skill: available.length ? { type: 'string', enum: available } : { type: 'string' },
        item: { type: 'string', enum: obtainableItems },
        count: { type: 'integer', minimum: 1, maximum: 64 },
        plan: { type: 'string', maxLength: 200 },
        success: { type: 'string', maxLength: 120 },
      } },
    } }];
    // Throttle unanswered and invalid plans too, so they cannot spin on the API.
    nextDecisionAt = Date.now() + 2000;
    let answer;
    try {
      answer = await complete(llm, messages, tools, signal);
    } catch {
      signal.throwIfAborted();
      retryAt = Date.now() + COOLDOWN_MS;
      return { type: 'fallback', reason: '模型请求失败' };
    }
    signal.throwIfAborted();
    if (request !== pendingRequest) return { type: 'wait' };
    try {
      if (answer.toolCalls.length !== 1 || answer.toolCalls[0].function.name !== 'next_survival_step') {
        throw new Error('模型未提交一个有效的下一步');
      }
      const action = JSON.parse(answer.toolCalls[0].function.arguments);
      if (typeof action?.plan !== 'string' || !action.plan.trim() || action.plan.length > 200) throw new Error('方案缺失或过长');
      if (action.type === 'wait') {
        nextDecisionAt = Date.now() + COOLDOWN_MS;
        return action;
      }
      if (action.type === 'done' && !snapshot.project && request && report?.status === 'completed') {
        finish(`「${request.text}」模型已结束本次计划。最近的实测结果：${report.reason}`);
        return { type: 'wait' };
      }
      if (action.type !== 'skill' || !available.includes(action.skill)
        || typeof action.success !== 'string' || !action.success.trim() || action.success.length > 120) {
        throw new Error('未知技能或缺少本步验收条件');
      }
      if (action.skill === 'obtain_item' && (!obtainableItems.includes(action.item)
        || !Number.isInteger(action.count) || action.count < 1 || action.count > 64)) {
        throw new Error('物品或数量不在技能允许范围内');
      }
      if (action.skill === 'obtain_item' && (snapshot.evidence?.inventory?.[action.item] || 0) >= action.count) {
        throw new Error('背包数量已达到目标，选择下一步');
      }
      if (snapshot.project?.supportFailures?.includes(signature(action)) || !snapshot.project && blocked.has(signature(action))) throw new Error('该方案已经失败，请更换技能或物品');
      if (snapshot.project) projectActions.add(action);
      else owners.set(action, pendingRequest);
      return action;
    } catch (error) {
      signal.throwIfAborted();
      nextDecisionAt = Date.now() + COOLDOWN_MS;
      report = { ...report, rejectedProposal: error instanceof SyntaxError ? '方案格式错误' : error.message };
      return { type: 'wait', reason: report.rejectedProposal };
    }
  }

  function cancel() {
    request = null;
    report = null;
    recent = [];
    blocked.clear();
    failures = [];
    paused = false;
    nextDecisionAt = 0;
  }

  return { submit, decide, announce, record, cancel, hasRequest: () => Boolean(request) };
}

function signature(action) {
  return action.skill === 'obtain_item' ? `${action.skill}:${action.item}` : action.skill;
}
