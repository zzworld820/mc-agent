// 多种相互独立的特征需要在同一个局部区域内出现，单块建材不构成结构证据。
// 这些规则用于识别候选，不读取世界种子、/locate 或服务端结构数据。
export const STRUCTURE_RULES = [
  {
    type: 'house', name: '房屋', radius: 10, dimensions: ['overworld', 'nether', 'end'],
    groups: [
      { id: 'doors', label: '独立门', suffix: '_door', properties: { half: 'lower' }, min: 1 },
      { id: 'walls', label: '建材组合', names: ['cobblestone', 'stone_bricks', 'bricks'], suffixes: ['_planks'], min: 12 },
      { id: 'windows', label: '窗户', names: ['glass', 'glass_pane'], suffixes: ['_stained_glass', '_stained_glass_pane'] },
      { id: 'beds', label: '床', suffix: '_bed', properties: { part: 'head' } },
      { id: 'work', label: '生活设施', names: ['crafting_table', 'furnace', 'chest', 'barrel'] },
    ],
    alternatives: [['windows'], ['beds'], ['work']],
    caveat: '仅识别房屋候选，未验证完整围护、室内可达性或所有权。',
  },
  {
    type: 'village', name: '村庄', radius: 24, dimensions: ['overworld'],
    groups: [
      { id: 'doors', label: '多个建筑入口', suffix: '_door', properties: { half: 'lower' }, min: 2 },
      { id: 'beds', label: '多张床', suffix: '_bed', properties: { part: 'head' }, min: 2 },
      { id: 'bell', label: '钟', names: ['bell'] },
      { id: 'paths', label: '道路', names: ['dirt_path'], threshold: 8 },
      { id: 'farms', label: '农田', names: ['farmland'], threshold: 6 },
    ],
    entities: [{ id: 'villagers', label: '村民', names: ['villager'], threshold: 2 }],
    alternatives: [['bell'], ['paths', 'villagers'], ['farms', 'villagers']],
    spread: { group: 'doors', min: 4 },
    caveat: '可能是玩家聚落或仿建；村民、床或钟单独出现不能证明天然村庄。',
  },
  {
    type: 'nether_fortress', name: '下界要塞', radius: 18, dimensions: ['nether'],
    groups: [
      { id: 'masonry', label: '下界砖主体', names: ['nether_bricks'], min: 24 },
      { id: 'details', label: '下界砖栏杆或楼梯', names: ['nether_brick_fence', 'nether_brick_stairs'], min: 3 },
      { id: 'wart', label: '下界疣', names: ['nether_wart'] },
      { id: 'spawner', label: '刷怪笼', names: ['spawner'] },
    ],
    entities: [{ id: 'guards', label: '烈焰人或凋灵骷髅', names: ['blaze', 'wither_skeleton'] }],
    alternatives: [['wart'], ['spawner'], ['guards']],
    caveat: '未确认刷怪笼类型，也不能排除玩家仿建。',
  },
  {
    type: 'bastion_remnant', name: '堡垒遗迹', radius: 18, dimensions: ['nether'],
    groups: [
      { id: 'masonry', label: '磨制黑石砖主体', names: ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks'], min: 24 },
      { id: 'gilded', label: '镶金黑石', names: ['gilded_blackstone'] },
      { id: 'details', label: '黑石装饰', names: ['chiseled_polished_blackstone', 'polished_blackstone_brick_stairs'], threshold: 3 },
      { id: 'treasure', label: '金块或箱子', names: ['gold_block', 'chest'] },
    ],
    entities: [{ id: 'piglins', label: '猪灵或猪灵蛮兵', names: ['piglin', 'piglin_brute'] }],
    alternatives: [['gilded', 'details'], ['gilded', 'treasure'], ['gilded', 'piglins'], ['details', 'treasure', 'piglins']],
    caveat: '普通黑石地形不会单独作为堡垒证据，仍可能是仿建。',
  },
  {
    type: 'stronghold', name: '主世界要塞', radius: 16, dimensions: ['overworld'],
    groups: [
      { id: 'masonry', label: '石砖组合', names: ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks'], min: 24 },
      { id: 'portal', label: '末地传送门框架', names: ['end_portal_frame'], threshold: 3 },
      { id: 'infested', label: '虫蚀石砖', names: ['infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks'] },
      { id: 'bars', label: '铁栏杆', names: ['iron_bars'], threshold: 3 },
      { id: 'library', label: '书架', names: ['bookshelf'], threshold: 6 },
    ],
    alternatives: [['portal'], ['infested', 'bars'], ['infested', 'library']],
    caveat: '要塞候选不代表已找到传送门；框架也不代表传送门已经激活。',
  },
  {
    type: 'desert_pyramid', name: '沙漠神殿', radius: 16, dimensions: ['overworld'],
    groups: [
      { id: 'sandstone', label: '砂岩建筑', names: ['sandstone', 'cut_sandstone', 'chiseled_sandstone'], min: 24 },
      { id: 'orange', label: '橙色陶瓦图案', names: ['orange_terracotta'], min: 4 },
      { id: 'blue', label: '蓝色陶瓦中心', names: ['blue_terracotta'], min: 1 },
    ],
    caveat: '仅依据建筑配色与组合识别；未探索的内部和陷阱状态未知。',
  },
  {
    type: 'jungle_temple', name: '丛林神庙', radius: 14, dimensions: ['overworld'],
    groups: [
      { id: 'masonry', label: '苔石与圆石', names: ['mossy_cobblestone', 'cobblestone'], min: 24 },
      { id: 'moss', label: '苔石', names: ['mossy_cobblestone'], min: 8 },
      { id: 'levers', label: '拉杆机关', names: ['lever'], threshold: 2 },
      { id: 'traps', label: '绊线机关', names: ['tripwire_hook', 'tripwire'], threshold: 2 },
      { id: 'dispensers', label: '发射器', names: ['dispenser'] },
    ],
    alternatives: [['levers', 'dispensers'], ['traps', 'dispensers']],
    caveat: '可能与玩家机关建筑相似，内部机关是否有效未知。',
  },
  {
    type: 'ocean_monument', name: '海底神殿', radius: 18, dimensions: ['overworld'],
    groups: [
      { id: 'prismarine', label: '海晶石主体', names: ['prismarine', 'prismarine_bricks', 'dark_prismarine'], min: 32 },
      { id: 'lights', label: '海晶灯', names: ['sea_lantern'], min: 3 },
      { id: 'water', label: '水域', names: ['water'], min: 16 },
    ],
    entities: [{ id: 'guardians', label: '守卫者', names: ['guardian', 'elder_guardian'] }],
    caveat: '仅候选识别，未确认结构完整性，也可能是海晶石建筑。',
  },
  {
    type: 'ruined_portal', name: '废弃传送门', radius: 10, dimensions: ['overworld', 'nether'],
    groups: [
      { id: 'obsidian', label: '黑曜石', names: ['obsidian'], min: 4 },
      { id: 'crying', label: '哭泣的黑曜石', names: ['crying_obsidian'], min: 1 },
      { id: 'surroundings', label: '下界岩或岩浆块', names: ['netherrack', 'magma_block'], min: 6 },
      { id: 'details', label: '金块或箱子', names: ['gold_block', 'chest'] },
    ],
    caveat: '不代表传送门可用，也可能是人工装饰。',
  },
  {
    type: 'mineshaft', name: '废弃矿井', radius: 12, dimensions: ['overworld'],
    groups: [
      { id: 'rails', label: '铁轨', names: ['rail'], min: 4 },
      { id: 'supports', label: '木支撑', suffixes: ['_planks', '_fence'], min: 8 },
      { id: 'webs', label: '蜘蛛网', names: ['cobweb'], min: 2 },
    ],
    caveat: '可能与玩家矿道相似；未确认通道连通性。',
  },
  {
    type: 'end_city', name: '末地城', radius: 18, dimensions: ['end'],
    groups: [
      { id: 'purpur', label: '紫珀建筑', names: ['purpur_block', 'purpur_pillar', 'purpur_stairs'], min: 24 },
      { id: 'bricks', label: '末地石砖', names: ['end_stone_bricks'], min: 12 },
      { id: 'rods', label: '末地烛', names: ['end_rod'] },
    ],
    entities: [{ id: 'shulkers', label: '潜影贝', names: ['shulker'] }],
    alternatives: [['rods'], ['shulkers']],
    caveat: '未确认是否有末地船或鞘翅。',
  },
];

export function matchesFeature(name, feature) {
  return feature.names?.includes(name)
    || (feature.suffix && name.endsWith(feature.suffix))
    || feature.suffixes?.some((suffix) => name.endsWith(suffix));
}

export const PERCEPTION_TYPES = [
  { type: 'tree', name: '树木' }, { type: 'river', name: '河流' }, { type: 'water_body', name: '水域' },
  ...STRUCTURE_RULES.map(({ type, name }) => ({ type, name })),
];
