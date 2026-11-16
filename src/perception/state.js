// 只读取客户端已获得的状态，不移动、不改变采集或生存策略。
const DIMENSION_NAMES = { overworld: '主世界', the_nether: '下界', nether: '下界', the_end: '末地', end: '末地' };
const BIOME_NAMES = {
  plains: '平原', sunflower_plains: '向日葵平原', desert: '沙漠', forest: '森林', flower_forest: '繁花森林',
  birch_forest: '桦木森林', dark_forest: '黑森林', taiga: '针叶林', snowy_taiga: '积雪针叶林',
  jungle: '丛林', sparse_jungle: '稀疏丛林', bamboo_jungle: '竹林', savanna: '热带草原',
  swamp: '沼泽', mangrove_swamp: '红树林沼泽', badlands: '恶地', snowy_plains: '雪原',
  river: '河流', frozen_river: '冻河', ocean: '海洋', deep_ocean: '深海', beach: '沙滩',
  cherry_grove: '樱花树林', meadow: '草甸', lush_caves: '繁茂洞穴', dripstone_caves: '溶洞', deep_dark: '深暗之域',
  nether_wastes: '下界荒地', crimson_forest: '绯红森林', warped_forest: '诡异森林',
  soul_sand_valley: '灵魂沙峡谷', basalt_deltas: '玄武岩三角洲',
  the_end: '末地', end_highlands: '末地高地', end_midlands: '末地内陆', small_end_islands: '末地小型岛屿', end_barrens: '末地荒地',
};

export function readWorldState(bot) {
  const position = bot.entity?.position;
  const block = position ? bot.blockAt(position.floored()) : null;
  const dimension = String(bot.game?.dimension ?? 'unknown').replace('minecraft:', '');
  const items = bot.inventory?.items() ?? [];
  const counts = {};
  for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return {
    observedAt: new Date().toISOString(),
    position: position ? { x: position.x, y: position.y, z: position.z } : null,
    dimension: { id: dimension, name: DIMENSION_NAMES[dimension] ?? dimension },
    biome: block?.biome?.name ? { id: block.biome.id, name: block.biome.name, label: BIOME_NAMES[block.biome.name] ?? block.biome.name, source: 'current_block' } : null,
    timeOfDay: bot.time?.timeOfDay ?? null,
    raining: bot.isRaining ?? null,
    vitals: {
      health: bot.health ?? null, food: bot.food ?? null,
      saturation: bot.foodSaturation ?? null, oxygen: bot.ownOxygen ?? bot.oxygenLevel ?? null,
      onGround: bot.entity?.onGround ?? null,
    },
    inventory: { counts, emptySlots: bot.inventory?.emptySlotCount() ?? null, heldItem: bot.heldItem?.name ?? null },
  };
}

export function describeLocation(bot) {
  const position = bot.entity?.position;
  const dimension = String(bot.game?.dimension ?? 'unknown').replace('minecraft:', '');
  const biome = position ? bot.blockAt(position.floored())?.biome?.name : null;
  return `维度：${DIMENSION_NAMES[dimension] ?? dimension}；当前位置群系：${BIOME_NAMES[biome] ?? biome ?? '未知（当前数据不足）'}`;
}
