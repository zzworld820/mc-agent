# Fabric 生存验收案例与进度

目标：用户现有 127.0.0.1:25565，QA_Agent；至少100个游戏日，同时建成大房子、大农场和稳定生存物资。

不使用管理命令、不给物资、不伪造天数。规则单测和实服结果分开。原始记录：survival-events.jsonl、survival-console.log、fabric-regression.jsonl。

## 规则回归

41项通过，详见 unit-regression.tap。不能代替实服行为验收。

- SUP-01 full hunger but no carried food requests supplies
- SUP-02 normal carried food is measured in points
- SUP-03 rotten flesh is not expedition food
- SUP-04 emergency allows rotten flesh
- SUP-05 normal hunger does not use rotten flesh
- SUP-06 harmful foods are rejected even in emergency
- SUP-07 propagules reserved normally
- SUP-08 propagules available in emergency
- SUP-09 hunger interrupts active work
- SUP-10 eating at hunger 18 is not required when healthy
- SUP-11 injured agent eats to recover
- SUP-12 mining requires light and tool
- SUP-13 high risk requires weapon and armor
- SUP-14 expedition budget exceeds local budget
- SUP-15 food reserves are shared across food types
- SUP-16 stale warehouse is not carried food
- SUP-17 configuration rejects inverted thresholds
- FARM-01 configurable small and large dimensions
- FARM-02 shrinking maximum is rejected
- FARM-age-wheat
- FARM-age-potatoes
- FARM-age-beetroots
- FARM-age-carrots
- FARM-03 unloaded crops remain unknown
- BUILD-01 builtin models and all expansion directions validate
- BUILD-02 derived model remains draft with lineage
- BUILD-03 material counts use the actual blueprint
- BUILD-foundation-lava
- BUILD-foundation-water
- BUILD-foundation-air
- BUILD-04 complete dry supported site is accepted
- TASK-01 old task exits before new task starts
- SUP-18 emergency policy can explicitly disable rotten flesh
- SUP-19 duplicate double-chest snapshots not counted twice
- SUP-20 other dimension containers ignored
- FARM-04 90 percent maturity computed against planted crops
- FARM-05 missing soil reported as damaged
- BUILD-05 unrelated occupied structures rejected
- BUILD-06 model characteristics required
- BUILD-07 vertical model footprint must match
- TASK-02 cancellation before queued task prevents work

## 实服与服务依赖案例

|编号|案例|状态|判据/备注|
|---|---|---|---|
|LIVE-01|连接用户 Fabric 25565、断线重连|通过|日志已有多次入服，玩家 zz 和 QA_Agent 同服|
|LIVE-02|真实地形树木候选识别|通过|实际区块识别橡树/桦树，保留证据与置信度|
|LIVE-03|无指令自主采集与合成起步|进行中|已自然采集原木、合成木板/木棍，木镐链尚待验收|
|LIVE-04|玩家停止任务、退出修改后重连|通过|原任务取消、退出和重连均有日志|
|LIVE-05|无补给持续生存至少100游戏日|进行中|仅累计在线观察到的日历刻；同时记录活动刻和死亡|
|LIVE-06|山洞避难所门/照明/家具|待执行|自然地形施工和进入/离开|
|LIVE-07|大房屋/门窗/工作区/床|待执行|自然采集并建造 warehouse 模型|
|LIVE-08|后方扩建、保留原主体|待执行|材料充足后追加模块并验证通行|
|LIVE-09|上层扩建、梯井和出门|待执行|实际施工、通行、取粮后出屋|
|LIVE-10|地下室扩建和围岩风险|待执行|自然地形安全施工；不可行需记录原因|
|LIVE-11|农田初建、照明、灌溉、四种作物|待执行|仅使用实际取得的种植材料|
|LIVE-12|农田成熟率九成、收割补种|待执行|观察完整生长/收获周期|
|LIVE-13|农田逐步扩到15×15|待执行|保留旧地块扩建|
|LIVE-14|缺水、缺灯、缺苗、浅坑维修|待执行|只在自有设施安排可恢复破坏|
|LIVE-15|仓储棚、自有室内箱位、扩容|待执行|核对真实容器和物品数量|
|LIVE-16|饥饿进食、应急食物、保护种子|待执行|自然消耗触发，不伪造身体状态|
|LIVE-17|取粮/加工/狩猎方案切换及冷却|待执行|观察真实物资消耗和库存|
|LIVE-18|工作暂停、补给、返回并恢复|待执行|记录已完成数量，避免重复采满|
|LIVE-19|远行火把/工具/武器防具检查|待执行|生存物资充足后执行分段探索|
|LIVE-20|危险感知、自卫、撤退、恢复|待执行|遭遇真实威胁，不主动制造致命处境|
|LIVE-21|鸡牛羊牧场、围栏修复、繁殖|待执行|找到真实动物后逐类验收|
|LIVE-22|物资长期充足、农业自循环|待执行|结合100日轨迹验收|
|LIVE-23|村庄/河流/神殿/要塞等感知|待执行|需要真实遇到相应结构；未遇到不算通过|
|MEM-01|MongoDB真实持久化/共享/宠物/回档分区|受限|本机27017未监听；不把模拟数据库结果称实库通过|
|MEM-02|本地策略检查点与跨重连续接|进行中|使用验收专用agent分区，已有原木跨重连保留|

## 已修改、待实服复测

- 救急收割不先筹材料修水槽/火把，不强制先补种。
- 自主采原木也检查天然树，避免把原木建筑当树。
- 地下室不把地板高度的外侧空气误认作地下空洞。
- 农场配置复用正在工作的补给控制器状态，避免旧快照覆盖。
- 上下层/翼房中先回入口层，再开门离开。
- 补给失败但身体稳定时允许必要的自救生产；夜间先避难。

未完成案例保持待执行，不计PASS。最终报告须同时满足天数和建设物资目标后生成。
