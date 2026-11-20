import test from 'node:test';
import assert from 'node:assert/strict';
import {Vec3} from 'vec3';
import {assessSupplies,foodReservations} from '../src/supplies/assessment.js';
import {carriedFood,chooseFood,readSupplyInventory} from '../src/supplies/inventory.js';
import {taskBudget,validateSupplySettings} from '../src/supplies/profiles.js';
import {validateFarmSettings} from '../src/farming/settings.js';
import {inspectFarm,CROPS} from '../src/farming/system.js';
import {getHouseModel,deriveHouseModel,validateHouseModel,planHouseShell,shellMaterials} from '../src/building/models.js';
import {isSafeHouseSite} from '../src/autonomy/skills/build.js';
import {createTaskManager} from '../src/actions/taskManager.js';
const state=()=>({farm:null,pastures:[],supplies:{},home:null});
test('STRATEGY-04 night shelter waiting tolerates low reserves but responds to hunger', async () => {
  const { shouldPauseForSupplies } = await import('../src/supplies/assessment.js');
  assert.equal(shouldPauseForSupplies(bot(), state(), 'night'), false);
  assert.equal(shouldPauseForSupplies(bot([], 5), state(), 'night'), true);
  assert.equal(shouldPauseForSupplies(bot([['bread', 1]], 10), state(), 'night'), true);
});
function bot(items=[],food=20,health=20){
 const foodsByName={bread:{foodPoints:5},rotten_flesh:{foodPoints:4},carrot:{foodPoints:3},potato:{foodPoints:1},spider_eye:{foodPoints:2},pufferfish:{foodPoints:1}};
 return {food,health,game:{dimension:'overworld'},entity:{position:new Vec3(0,65,0)},registry:{foodsByName,itemsByName:{}},inventory:{items:()=>items.map(([name,count])=>({name,count})),slots:[]}};
}
test('SUP-01 full hunger but no carried food requests supplies',()=>assert.equal(assessSupplies(bot(),state()).level,'insufficient'));
test('SUP-02 normal carried food is measured in points',()=>assert.equal(carriedFood(bot([['bread',4]])).regular,20));
test('SUP-03 rotten flesh is not expedition food',()=>assert.deepEqual(carriedFood(bot([['rotten_flesh',4]])),{regular:0,emergency:16}));
test('SUP-04 emergency allows rotten flesh',()=>assert.equal(chooseFood(bot([['rotten_flesh',4]],5)).name,'rotten_flesh'));
test('SUP-05 normal hunger does not use rotten flesh',()=>assert.equal(chooseFood(bot([['rotten_flesh',4]],17)),null));
test('SUP-06 harmful foods are rejected even in emergency',()=>assert.equal(chooseFood(bot([['spider_eye',4],['pufferfish',2]],1)),null));
test('SUP-07 propagules reserved normally',()=>assert.equal(chooseFood(bot([['carrot',2]],15),state()),null));
test('SUP-08 propagules available in emergency',()=>assert.equal(chooseFood(bot([['carrot',2]],4),state()).name,'carrot'));
test('SUP-09 hunger interrupts active work',()=>assert.equal(assessSupplies(bot([['bread',5]],10),state()).interrupt,true));
test('SUP-10 eating at hunger 18 is not required when healthy',()=>assert.equal(assessSupplies(bot([['bread',4]],18),state()).ready,true));
test('SUP-11 injured agent eats to recover',()=>assert.equal(assessSupplies(bot([['bread',4]],18,8),state()).needsMeal,true));
test('SUP-12 mining requires light and tool',()=>assert.deepEqual(assessSupplies(bot([['bread',20]]),state(),{profile:'mining'}).missing,['torches','tool']));
test('SUP-13 high risk requires weapon and armor',()=>assert.deepEqual(assessSupplies(bot([['bread',20]]),state(),{risk:'high'}).missing,['weapon','armor']));
test('SUP-14 expedition budget exceeds local budget',()=>assert.ok(taskBudget(bot(),{profile:'expedition'}).foodTarget>taskBudget(bot()).foodTarget));
test('SUP-15 food reserves are shared across food types',()=>assert.equal(foodReservations(bot([['bread',64]]),state()).bread,4));
test('SUP-16 stale warehouse is not carried food',()=>{const s=state();s.storage={dimension:'overworld',mode:'shed',chests:[{id:'c',position:{x:1,y:65,z:0},observedAt:1,snapshot:[{name:'bread',count:64}]}]};const r=readSupplyInventory(bot(),s);assert.equal(r.carried.regular,0);assert.equal(r.stores[0].stale,true);});
test('SUP-17 configuration rejects inverted thresholds',()=>assert.throws(()=>validateSupplySettings({eatBelow:5})));
test('FARM-01 configurable small and large dimensions',()=>{assert.equal(validateFarmSettings({width:1,depth:1}).width,1);assert.equal(validateFarmSettings({width:32,depth:32,maxWidth:32,maxDepth:32}).width,32);});
test('FARM-02 shrinking maximum is rejected',()=>assert.throws(()=>validateFarmSettings({width:20})));
for(const crop of CROPS)test(`FARM-age-${crop.block}`,()=>{const b=bot();b.blockAt=p=>p.y===64?{name:'farmland',getProperties:()=>({moisture:7})}:{name:crop.block,getProperties:()=>({age:crop.age})};const f={origin:{x:0,y:64,z:0},dimension:'overworld',width:1,depth:1,plots:[{position:{x:0,y:64,z:0}}],waters:[],lamps:[]};assert.equal(inspectFarm(b,f).matureRatio,1);});
test('FARM-03 unloaded crops remain unknown',()=>{const b=bot();b.blockAt=()=>null;assert.equal(inspectFarm(b,{origin:{x:0,y:64,z:0},width:1,depth:1,plots:[{position:{x:0,y:64,z:0}}],dimension:'overworld',waters:[],lamps:[]}).unknown,1);});
test('BUILD-01 builtin models and all expansion directions validate',async()=>{for(const id of ['starter','warehouse']){const m=await getHouseModel(id);validateHouseModel(m);assert.deepEqual(new Set(m.expansions.map(e=>e.direction)),new Set(['back','up','down']));}});
test('BUILD-02 derived model remains draft with lineage',async()=>{const m=deriveHouseModel(await getHouseModel(),{id:'qa-derived'});assert.equal(m.status,'draft');assert.equal(m.provenance.parents[0].id,'starter');});
test('BUILD-03 material counts use the actual blueprint',async()=>{const m=await getHouseModel();const blocks=planHouseShell(m,m.size);const count=shellMaterials(m,m.size);for(const name of new Set(blocks.map(b=>b.item)))assert.equal(count[name],blocks.filter(b=>b.item===name).length);});
for(const hazard of ['lava','water','air'])test(`BUILD-foundation-${hazard}`,async()=>{const m=await getHouseModel();const b=bot();b.blockAt=p=>({name:p.y===63?hazard:p.y<65?'stone':'air',boundingBox:p.y<65&&hazard!=='air'?'block':'empty'});assert.equal(isSafeHouseSite(b,new Vec3(0,65,0),m.size,m),false);});
test('BUILD-04 complete dry supported site is accepted',async()=>{const m=await getHouseModel();const b=bot();b.blockAt=p=>({name:p.y<65?'stone':'air',boundingBox:p.y<65?'block':'empty'});assert.equal(isSafeHouseSite(b,new Vec3(0,65,0),m.size,m),true);});
test('TASK-01 old task exits before new task starts',async()=>{const events=[];const tasks=createTaskManager();const first=tasks.start({label:'first',report:'never'},async({signal})=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await new Promise(r=>setTimeout(r,15));events.push('old-exit');});await new Promise(r=>setTimeout(r,5));const second=tasks.start({label:'second',report:'never'},async()=>events.push('new-start'));await second.settled;assert.deepEqual(events,['old-exit','new-start']);await first.settled;});
test('SUP-18 emergency policy can explicitly disable rotten flesh',()=>{const b=bot([['rotten_flesh',4]],4);b.supplyOptions={allowRottenFlesh:false};assert.equal(chooseFood(b),null);});
test('SUP-19 duplicate double-chest snapshots not counted twice',()=>{const s=state();s.storage={dimension:'overworld',mode:'home',chests:[1,2].map(id=>({id:String(id),position:{x:id,y:65,z:0},containerKey:'paired',snapshot:[{name:'bread',count:10}]}))};assert.equal(readSupplyInventory(bot(),s).stores.reduce((n,c)=>n+c.regularPoints,0),50);});
test('SUP-20 other dimension containers ignored',()=>{const s=state();s.storage={dimension:'the_nether',mode:'home',chests:[{id:'c',position:{x:0,y:65,z:0},snapshot:[]}]};assert.equal(readSupplyInventory(bot(),s).stores.length,0);});
test('FARM-04 90 percent maturity computed against planted crops',()=>{const b=bot();b.blockAt=p=>p.y===64?{name:'farmland',getProperties:()=>({moisture:7})}:{name:'wheat',getProperties:()=>({age:p.x<9?7:6})};const f={origin:{x:0,y:64,z:0},dimension:'overworld',width:10,depth:1,plots:Array.from({length:10},(_,x)=>({position:{x,y:64,z:0}})),waters:[],lamps:[]};assert.equal(inspectFarm(b,f).matureRatio,.9);});
test('FARM-05 missing soil reported as damaged',()=>{const b=bot();b.blockAt=()=>({name:'air',getProperties:()=>({})});const f={origin:{x:0,y:64,z:0},dimension:'overworld',width:1,depth:1,plots:[{position:{x:0,y:64,z:0}}],waters:[],lamps:[]};assert.equal(inspectFarm(b,f).damaged,1);});
test('BUILD-05 unrelated occupied structures rejected',async()=>{const m=await getHouseModel();const b=bot();b.blockAt=p=>({name:p.y<65?'stone':p.x===2&&p.z===2&&p.y===66?'diamond_block':'air',boundingBox:p.y<65?'block':'empty'});assert.equal(isSafeHouseSite(b,new Vec3(0,65,0),m.size,m),false);});
test('BUILD-06 model characteristics required',async()=>{const m=await getHouseModel();m.description='';assert.throws(()=>validateHouseModel(m));});
test('BUILD-07 vertical model footprint must match',async()=>{const m=await getHouseModel();m.expansions[1].size.depth=9;assert.throws(()=>validateHouseModel(m));});
test('TASK-02 cancellation before queued task prevents work',async()=>{const tasks=createTaskManager();let ran=false;const t=tasks.start({label:'queued',report:'never'},async()=>{ran=true});tasks.cancel('stop');await t.settled;assert.equal(ran,false);});
test('BUILD-08 basement accepts air outside the existing ground floor',async()=>{const {validateRoom}=await import('../src/building/vertical.js');const m=await getHouseModel();const project={model:m};const extension={origin:{x:0,y:61,z:0},module:m.expansions.find(e=>e.direction==='down'),started:false};const b=bot();b.blockAt=p=>({name:p.y>=65?'air':'stone',boundingBox:p.y>=65?'empty':'block'});for(let x=0;x<7;x++)for(let z=0;z<7;z++){}const get=b.blockAt;b.blockAt=p=>p.y===65&&p.x>=0&&p.x<7&&p.z>=0&&p.z<7?{name:'cobblestone',boundingBox:'block'}:get(p);assert.doesNotThrow(()=>validateRoom(b,project,extension,{x:2,z:1}));});
test('BUILD-09 basement rejects true underground void',async()=>{const {validateRoom}=await import('../src/building/vertical.js');const m=await getHouseModel();const b=bot();b.blockAt=p=>({name:p.x===-1&&p.y===62?'air':'stone',boundingBox:p.x===-1&&p.y===62?'empty':'block'});assert.throws(()=>validateRoom(b,{model:m},{origin:{x:0,y:61,z:0},module:m.expansions.find(e=>e.direction==='down')},{x:2,z:1}));});
test('BUILD-10 basement rejects nearby lava',async()=>{const {validateRoom}=await import('../src/building/vertical.js');const m=await getHouseModel();const b=bot();b.blockAt=p=>({name:p.x===-1&&p.y===62?'lava':'stone',boundingBox:'block'});assert.throws(()=>validateRoom(b,{model:m},{origin:{x:0,y:61,z:0},module:m.expansions.find(e=>e.direction==='down')},{x:2,z:1}));});
function dangerBot(){const b=bot();b.entity.velocity=new Vec3(0,0,0);b.entity.onGround=true;b.entity.metadata={};b.entities={};b.ownOxygen=20;b.blockAt=p=>({name:p.y<65?'stone':'air',boundingBox:p.y<65?'block':'empty'});return b;}
test('DANGER-01 healthy safe terrain does not retreat',async()=>{const {readDanger}=await import('../src/strategy/danger.js');assert.equal(readDanger(dangerBot()).retreat,false);});
test('DANGER-02 unarmored agent avoids approaching hostile',async()=>{const {readDanger}=await import('../src/strategy/danger.js');const b=dangerBot();b.entities[1]={id:1,type:'hostile',name:'zombie',position:new Vec3(2,65,0),height:1.8};assert.equal(readDanger(b).retreat,true);});
test('DANGER-03 nearby passive animal is not a hostile',async()=>{const {readDanger}=await import('../src/strategy/danger.js');const b=dangerBot();b.entities[1]={id:1,type:'animal',name:'cow',position:new Vec3(2,65,0),height:1.4};assert.equal(readDanger(b).retreat,false);});
test('DANGER-04 lava forces retreat',async()=>{const {readDanger}=await import('../src/strategy/danger.js');const b=dangerBot();b.blockAt=()=>({name:'lava',boundingBox:'empty'});assert.equal(readDanger(b).retreat,true);});
test('DANGER-05 own oxygen drives escape from water',async()=>{const {readDanger}=await import('../src/strategy/danger.js');const b=dangerBot();b.ownOxygen=3;b.blockAt=()=>({name:'water',boundingBox:'empty'});assert.equal(readDanger(b).retreat,true);});
test('DANGER-06 incoming projectile is recognized',async()=>{const {readDanger}=await import('../src/strategy/danger.js');const b=dangerBot();b.entities[1]={id:1,name:'arrow',position:new Vec3(2,65,0),velocity:new Vec3(-1,0,0)};assert.equal(readDanger(b).projectiles.length,1);});
const {STRUCTURE_RULES}=await import('../src/perception/structures.js');
const {scanEnvironment}=await import('../src/perception/environment.js');
function structureFixture(rule,complete=true){
 const b=bot();b.inventory.emptySlotCount=()=>36;b.game.dimension=rule.dimensions[0];b.entities={};b.registry.blocksByName={};const blocks=new Map();let index=0;
 function add(name,properties={},spread=false){if(!b.registry.blocksByName[name])b.registry.blocksByName[name]={name,id:Object.keys(b.registry.blocksByName).length+1};let p;do{p=new Vec3(index%11-5,65,Math.floor(index/11)-5);index++;}while(blocks.has(p.toString()));if(spread){p=new Vec3(1,65,-5);while(blocks.has(p.toString()))p=p.offset(1,0,0);}blocks.set(p.toString(),{name,type:b.registry.blocksByName[name].id,position:p,boundingBox:'block',getProperties:()=>properties});}
 for(const group of rule.groups){const suffix=group.suffix||group.suffixes?.[0];const name=group.names?.[0]||(suffix==='_door'?'oak_door':suffix==='_bed'?'white_bed':`oak${suffix}`);const count=complete?Math.max(group.min||0,group.threshold||1):1;for(let i=0;i<count;i++)add(name,group.properties||{},rule.type==='village'&&group.id==='doors'&&i===1);if(!complete)break;}
 if(complete)for(const group of rule.entities||[])for(let i=0;i<(group.threshold||1);i++)b.entities[`${group.id}-${i}`]={name:group.names[0],position:new Vec3(0,65,0)};
 b.blockAt=p=>blocks.get(p.toString())||{name:'air',position:p,boundingBox:'empty',getProperties:()=>({})};
 b.findBlocks=({point,matching,maxDistance,count,useExtraInfo})=>[...blocks.values()].filter(block=>matching.includes(block.type)&&block.position.distanceTo(point)<=maxDistance&&(!useExtraInfo||useExtraInfo(block))).slice(0,count).map(block=>block.position);
 return b;
}
for(const rule of STRUCTURE_RULES){
 test(`SENSE-${rule.type}-evidence`,async()=>{const result=await scanEnvironment(structureFixture(rule),{radius:32,target:rule.type});assert.ok(result.objects.some(object=>object.type===rule.type),rule.type);assert.ok(result.objects.every(object=>object.classification==='inferred'));});
 test(`SENSE-${rule.type}-single-block`,async()=>{const result=await scanEnvironment(structureFixture(rule,false),{radius:32,target:rule.type});assert.equal(result.objects.length,0);});
}
test('NAV-01 only already-open doors become passable',async()=>{const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);const registry=require('prismarine-registry')('1.21.6');const {useMovementProfile}=await import('../src/actions/helpers.js');let open=false;const b=bot();b.registry=registry;b.pathfinder={setMovements(m){this.movements=m}};b.blockAt=p=>({position:p,name:'oak_door',type:registry.blocksByName.oak_door.id,boundingBox:'block',shapes:[[0,0,0,0.1875,1,1]],getProperties:()=>({open})});useMovementProfile(b,'safe');assert.equal(b.pathfinder.movements.getBlock(new Vec3(0,65,0),0,0,0).safe,false);open=true;assert.equal(b.pathfinder.movements.getBlock(new Vec3(0,65,0),0,0,0).safe,true);assert.equal(b.pathfinder.movements.canDig,false);});
test('STRATEGY-01 necessary survival work does not starvation-lock on reserve target',async()=>{const {shouldPauseForSupplies}=await import('../src/supplies/assessment.js');assert.equal(shouldPauseForSupplies(bot(),state(),'farm',true),false);});
test('STRATEGY-02 essential work still pauses for actual hunger',async()=>{const {shouldPauseForSupplies}=await import('../src/supplies/assessment.js');assert.equal(shouldPauseForSupplies(bot([],5),state(),'farm',true),true);});
test('STRATEGY-03 optional construction still respects reserve threshold',async()=>{const {shouldPauseForSupplies}=await import('../src/supplies/assessment.js');assert.equal(shouldPauseForSupplies(bot(),state(),'house',false),true);});
test('DANGER-07 opened door is not reported as head suffocation',async()=>{const {readDanger}=await import('../src/strategy/danger.js');const b=dangerBot();const original=b.blockAt;b.blockAt=p=>p.y===66?{name:'oak_door',boundingBox:'block',getProperties:()=>({open:true})}:original(p);assert.equal(readDanger(b).retreat,false);});
test('DANGER-08 real full head obstruction still triggers retreat',async()=>{const {readDanger}=await import('../src/strategy/danger.js');const b=dangerBot();const original=b.blockAt;b.blockAt=p=>p.y===66?{name:'stone',boundingBox:'block'}:original(p);assert.equal(readDanger(b).retreat,true);});
test('STRATEGY-04 respawn with empty inventory stays in known shelter at night',async()=>{const {nextGoal}=await import('../src/strategy/index.js');const b=dangerBot();b.time={timeOfDay:15000};const s=state();s.home={x:0,y:65,z:0,dimension:'overworld',kind:'cave'};assert.equal(nextGoal(b,s),'night');});
test('STRATEGY-05 reserve shortage alone does not force nocturnal foraging',async()=>{const {nextGoal}=await import('../src/strategy/index.js');const b=dangerBot();b.time={timeOfDay:15000};b.inventory.items=()=>[{name:'wooden_pickaxe',count:1}];const s=state();s.home={x:0,y:65,z:0,dimension:'overworld',kind:'cave'};assert.equal(nextGoal(b,s),'night');});

for (const obstruction of ['stone', 'birch_leaves', 'lava', 'unloaded']) {
  test(`RECOVERY rejects ${obstruction} above a water landing`, async () => {
    const { waterLanding } = await import('../src/strategy/recovery.js');
    const b = bot();
    b.game.minY = -64;
    b.blockAt = (position) => {
      if (position.y === 80) return obstruction === 'unloaded' ? null : { name: obstruction };
      return { name: position.y <= 55 ? 'water' : 'air' };
    };
    assert.equal(waterLanding(b, new Vec3(0, 301, 0), 301), null);
  });
}
test('RECOVERY accepts a loaded clear column with deep water', async () => {
  const { waterLanding } = await import('../src/strategy/recovery.js');
  const b = bot();
  b.game.minY = -64;
  b.blockAt = (position) => ({ name: position.y <= 55 ? 'water' : 'air' });
  assert.deepEqual(waterLanding(b, new Vec3(0, 301, 0), 301), new Vec3(0.5, 55, 0.5));
});
test('RECOVERY rejects shallow water', async () => {
  const { waterLanding } = await import('../src/strategy/recovery.js');
  const b = bot();
  b.game.minY = -64;
  b.blockAt = (position) => ({ name: position.y === 55 ? 'water' : position.y < 55 ? 'stone' : 'air' });
  assert.equal(waterLanding(b, new Vec3(0, 301, 0), 301), null);
});
test('RECOVERY prioritizes high respawn escape over night and reserves', async () => {
  const { nextGoal } = await import('../src/strategy/index.js');
  const b = dangerBot();
  b.entity.position.y = 301;
  b.blockAt = (position) => ({ name: position.y < 301 ? 'stone' : 'air', boundingBox: position.y < 301 ? 'block' : 'empty' });
  b.time = { timeOfDay: 15000 };
  const s = state();
  s.home = { x: -2, y: 80, z: -8, dimension: 'overworld' };
  assert.equal(nextGoal(b, s), 'escape');
});
test('DANGER unarmored witch is avoided before close combat range', async () => {
  const { readDanger } = await import('../src/strategy/danger.js');
  const b = dangerBot();
  b.entities[1] = { id: 1, type: 'hostile', name: 'witch', position: new Vec3(10, 65, 0), height: 1.8 };
  assert.equal(readDanger(b).retreat, true);
});
test('DANGER uses collision shapes to see through an open doorway', async () => {
  const { readDanger } = await import('../src/strategy/danger.js');
  const b = dangerBot();
  b.entities[1] = { id: 1, type: 'hostile', name: 'creeper', position: new Vec3(3, 65, 0), height: 1.8 };
  b.world = { raycast: () => null };
  assert.equal(readDanger(b).threats.length, 1);
  b.world.raycast = () => ({ name: 'stone' });
  assert.equal(readDanger(b).threats.length, 1);
});
test('STRATEGY equips the early camp before inspecting an unfinished farm', async () => {
  const { nextGoal } = await import('../src/strategy/index.js');
  const b = dangerBot();
  b.time = { timeOfDay: 1000 };
  b.inventory.items = () => [{ name: 'bread', count: 4 }, { name: 'wooden_pickaxe', count: 1 }];
  const s = state();
  s.home = { x: 0, y: 65, z: 0, dimension: 'overworld' };
  s.farm = { status: 'building' };
  assert.equal(nextGoal(b, s), 'camp');
});
test('NAV safe walking uses supported cardinal routes through corners', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const registry = require('prismarine-registry')('1.21.6');
  const { useMovementProfile } = await import('../src/actions/helpers.js');
  const b = bot();
  b.registry = registry;
  b.pathfinder = { setMovements(movements) { this.movements = movements; } };
  let flat = false;
  b.blockAt = (position) => {
    const solid = position.y < 65 && (flat || position.x === position.z);
    return { position, name: solid ? 'stone' : 'air', type: registry.blocksByName[solid ? 'stone' : 'air'].id,
      boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({}) };
  };
  useMovementProfile(b, 'safe');
  const movements = b.pathfinder.movements;
  const neighbors = [];
  movements.getMoveDiagonal({ x: 0, y: 65, z: 0, remainingBlocks: 0 }, { x: 1, z: 1 }, neighbors);
  assert.equal(neighbors.length, 0);
  flat = true;
  movements.getMoveDiagonal({ x: 0, y: 65, z: 0, remainingBlocks: 0 }, { x: 1, z: 1 }, neighbors);
  assert.equal(neighbors.length, 0);
  assert.equal(movements.allowParkour, false);
  assert.equal(movements.maxDropDown, 3);
});
test('NAV retries a blocked waypoint and cleans up its temporary exclusion', async () => {
  const { EventEmitter } = await import('node:events');
  const { goTo } = await import('../src/actions/helpers.js');
  const b = new EventEmitter();
  b.entity = { position: new Vec3(0, 65, 0), isInWater: false };
  let attempts = 0;
  b.pathfinder = {
    movements: { exclusionAreasStep: [] },
    goto(goal) {
      return new Promise((resolve) => {
        b.once('goal_reached', resolve);
        this.setGoal(goal);
      });
    },
    setGoal(goal) {
      if (!goal) return;
      attempts++;
      if (attempts === 1) {
        b.emit('path_update', { path: [{ x: 1, y: 65, z: 0 }] });
      } else {
        assert.equal(this.movements.exclusionAreasStep[0]({ position: new Vec3(1, 65, 0) }), 1000);
        b.entity.position = new Vec3(2, 65, 0);
        queueMicrotask(() => b.emit('goal_reached'));
      }
    },
  };
  await goTo(b, { isEnd: (position) => position.x === 2 }, { timeoutMs: 10000, stuckMs: 6000 });
  assert.equal(attempts, 2);
  assert.equal(b.listenerCount('path_update'), 0);
  assert.equal(b.pathfinder.movements.exclusionAreasStep.length, 0);
});
test('DANGER remembers a recently visible enemy behind cover', async () => {
  const { readDanger } = await import('../src/strategy/danger.js');
  const b = dangerBot();
  b.entities[1] = { id: 1, type: 'hostile', name: 'skeleton', position: new Vec3(10, 65, 0), height: 1.8 };
  b.world = { raycast: () => null };
  assert.equal(readDanger(b).retreat, true);
  b.world.raycast = () => ({ name: 'birch_leaves' });
  assert.equal(readDanger(b).threats[0].visible, false);
  assert.equal(readDanger(b).retreat, true);
});
test('DANGER checks a nearby creeper even without direct sight', async () => {
  const { readDanger } = await import('../src/strategy/danger.js');
  const b = dangerBot();
  b.entities[1] = { id: 1, type: 'hostile', name: 'creeper', position: new Vec3(4, 65, 0), height: 1.8 };
  b.world = { raycast: () => ({ name: 'birch_leaves' }) };
  assert.equal(readDanger(b).retreat, true);
});
test('STRATEGY prepares the camp before iron protection', async () => {
  const { nextGoal } = await import('../src/strategy/index.js');
  const b = dangerBot();
  b.time = { timeOfDay: 1000 };
  b.inventory.items = () => [{ name: 'bread', count: 4 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_axe', count: 1 }];
  const s = state();
  s.home = { x: 0, y: 65, z: 0, dimension: 'overworld' };
  s.workshop = { x: 0, y: 65, z: 0 };
  assert.equal(nextGoal(b, s), 'camp');
});
test('STRATEGY stays sheltered at night even with underground lighting', async () => {
  const { nextGoal } = await import('../src/strategy/index.js');
  const b = dangerBot();
  b.entity.position.y = 45;
  b.time = { timeOfDay: 15000 };
  b.blockAt = (position) => ({ name: position.y < 45 ? 'stone' : 'air', boundingBox: position.y < 45 ? 'block' : 'empty', skyLight: 0, light: 12 });
  b.inventory.items = () => [{ name: 'bread', count: 4 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_axe', count: 1 }];
  const s = state();
  s.home = { x: 0, y: 80, z: 0, dimension: 'overworld' };
  s.workshop = { x: 0, y: 80, z: 0 };
  assert.equal(nextGoal(b, s), 'night');
});
test('BUILD searches verified ground surfaces at different elevations', async () => {
  const { findHouseSite } = await import('../src/autonomy/skills/build.js');
  const b = bot();
  b.entity.position.y = 80;
  b.registry.blocksByName = { grass_block: { id: 1 } };
  b.findBlocks = () => [new Vec3(8, 63, 0)];
  b.blockAt = (position) => ({ name: position.y === 63 ? 'grass_block' : position.y < 63 ? 'stone' : 'air', boundingBox: position.y < 64 ? 'block' : 'empty' });
  assert.equal(findHouseSite(b, { width: 9, depth: 9, wallHeight: 3 }, { emptyOnly: true }).origin.y, 64);
  const original = b.blockAt;
  b.blockAt = (position) => position.y === 62 ? { name: 'water', boundingBox: 'empty' } : original(position);
  assert.equal(findHouseSite(b, { width: 9, depth: 9, wallHeight: 3 }, { emptyOnly: true }), null);
});
test('BUILD records base and expansion footprints before collecting materials', async () => {
  const { rememberProjectRooms } = await import('../src/autonomy/skills/build.js');
  const s = state();
  const project = { id: 'qa-project', origin: { x: 0, y: 65, z: 0 }, model: { size: { width: 9, depth: 9, wallHeight: 3 } },
    extensions: [{ origin: { x: 0, y: 70, z: 0 }, module: { size: { width: 9, depth: 9, wallHeight: 3 } } }] };
  rememberProjectRooms({ state: s }, project);
  assert.equal(s.buildingRooms[project.id].length, 2);
  assert.equal(s.buildingRooms[project.id][1].origin.y, 70);
});
test('NAV surface goal requires open sky, solid footing and clear headroom', async () => {
  const { GoalSurface } = await import('../src/strategy/navigation.js');
  const b = bot();
  let skyLight = 15;
  let name = 'air';
  b.blockAt = (position) => ({ name: position.y < 65 ? 'stone' : name, skyLight, boundingBox: position.y < 65 ? 'block' : 'empty' });
  const goal = new GoalSurface(b, 80);
  assert.equal(goal.isEnd(new Vec3(0, 65, 0)), true);
  skyLight = 0;
  assert.equal(goal.isEnd(new Vec3(0, 65, 0)), false);
  skyLight = 15;
  name = 'water';
  assert.equal(goal.isEnd(new Vec3(0, 65, 0)), false);
});
test('DANGER armed armored agent can defend against one close zombie', async () => {
  const { readDanger } = await import('../src/strategy/danger.js');
  const b = dangerBot();
  b.inventory.slots[5] = { name: 'iron_helmet' };
  b.inventory.slots[6] = { name: 'iron_chestplate' };
  b.inventory.items = () => [{ name: 'stone_sword', count: 1 }];
  b.entities[1] = { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(2, 65, 0), height: 1.8 };
  assert.equal(readDanger(b).defend, true);
  b.health = 15;
  assert.equal(readDanger(b).retreat, false);
  b.entities[1].name = 'creeper';
  assert.equal(readDanger(b).defend, false);
  assert.equal(readDanger(b).retreat, true);
});
for (const name of ['crafting_table', 'furnace']) {
  test(`CRAFT replaces an unreachable ${name} with a local workstation`, async () => {
    const { EventEmitter } = await import('node:events');
    const { ensureWorkstation } = await import('../src/autonomy/skills/workstation.js');
    const b = Object.assign(new EventEmitter(), bot());
    const items = [];
    const placed = new Map();
    b.registry.blocksByName = { [name]: { id: 1 } };
    b.findBlock = () => ({ name, position: new Vec3(10, 65, 0) });
    b.inventory.items = () => items;
    b.pathfinder = { movements: { canDig: true, exclusionAreasStep: [] }, goto: async () => { throw new Error('unreachable'); }, setGoal() {} };
    b.blockAt = (position) => ({ position, name: placed.get(position.toString()) || (position.y < 65 ? 'stone' : 'air'), boundingBox: position.y < 65 ? 'block' : 'empty' });
    b.equip = async () => {};
    b.lookAt = async () => {};
    b.controlState = {};
    b.setControlState = (name, value) => { b.controlState[name] = value; };
    b.placeBlock = async (reference, face) => { placed.set(reference.position.plus(face).toString(), name); items.length = 0; };
    const s = state();
    s.unreachable = new Map();
    const result = await ensureWorkstation({ bot: b, state: s, signal: new AbortController().signal, log() {},
      obtain: async (item) => items.push({ name: item, count: 1 }) }, name);
    assert.equal(result.name, name);
    assert.equal(s.unreachable.size, 1);
    assert.equal(placed.size, 1);
  });
}
test('BUILD async site scanning promptly observes cancellation', async () => {
  const { findHouseSiteAsync } = await import('../src/autonomy/skills/build.js');
  const b = bot();
  const controller = new AbortController();
  let reads = 0;
  b.blockAt = () => {
    if (++reads === 100) controller.abort('unit cancellation');
    return { name: 'air', boundingBox: 'empty' };
  };
  await assert.rejects(findHouseSiteAsync(b, { width: 9, depth: 9, wallHeight: 3 }, { emptyOnly: true }, controller.signal), { name: 'AbortError' });
  assert.ok(reads <= 200);
});


test('STRATEGY night emergency hunger with empty inventory stays sheltered', async () => {
  const { nextGoal } = await import('../src/strategy/index.js');
  const b = dangerBot();
  b.time = { timeOfDay: 15000 };
  b.food = 5;
  assert.equal(nextGoal(b, state()), 'night');
});

test('STRATEGY dusk interrupts ordinary development before sunset', async () => {
  const { nextGoal } = await import('../src/strategy/index.js');
  const b = dangerBot();
  b.time = { timeOfDay: 10500 };
  assert.equal(nextGoal(b, state()), 'night');
});

test('STRATEGY a placed chest does not skip unfinished camp admission', async () => {
  const { nextGoal } = await import('../src/strategy/index.js');
  const b = dangerBot();
  b.time = { timeOfDay: 1000 };
  b.inventory.items = () => [{ name: 'bread', count: 4 }, { name: 'wooden_pickaxe', count: 1 }];
  const s = state();
  s.home = { x: 0, y: 65, z: 0, dimension: 'overworld', kind: 'cave' };
  s.storage = { earlyCamp: true, status: 'ready' };
  assert.equal(nextGoal(b, s), 'camp');
  s.home.campReady = true;
  assert.equal(nextGoal(b, s), 'tools');
});
