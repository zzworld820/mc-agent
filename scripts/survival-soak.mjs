// 在用户现有服务器上执行自然生存验收；不发管理命令、不启动或重启用户服务器。
import mineflayer from 'mineflayer';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {createActionRegistry} from '../src/actions/index.js';
import {config} from '../src/config.js';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {attachDeathLogging} from './survival-deaths.mjs';
import {developmentStatus} from '../src/strategy/development.js';
import {Vec3} from 'vec3';
import {verifyStorageTransfer} from './verify-storage-transfer.mjs';
import {verifyLocalUnstuck} from './verify-local-unstuck.mjs';
import {listHouseProjects,projectShellPlan} from '../src/building/projects.js';
import {startWebService} from '../src/web/server.js';
import {inspectConstructionAccess,verifyIndoorWorkRoute} from './verify-construction-access.mjs';
import {updateRunStatus,reconcileRunDeaths} from './survival-run-state.mjs';
const loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();
const reportDirectory = process.env.SURVIVAL_RUN ? new URL(`../reports/runs/${encodeURIComponent(process.env.SURVIVAL_RUN)}/`, import.meta.url) : new URL('../reports/', import.meta.url);
await mkdir(reportDirectory, { recursive: true });
const statusFile = new URL('survival-status.json', reportDirectory);
const eventsFile = new URL('survival-events.jsonl', reportDirectory);
let status;
try {status=JSON.parse(await readFile(statusFile,'utf8'));} catch {status={startedAt:new Date().toISOString(),username:process.env.SURVIVAL_USERNAME || 'QA_Agent',host:'127.0.0.1',port:25565,targetDays:100,observedCalendarTicks:0,activeTicks:0,deaths:0,connections:0,phase:'running'};}
await reconcileRunDeaths(status,eventsFile);
let bot,heartbeat,reconnect,lastSample,deathLogging,lastShelterInspection,stopping=false,sampling=false;
const actions=createActionRegistry({allowDig:true,allowCombat:true,allowAutonomy:true});
let storageCheckPending=process.env.SURVIVAL_VERIFY_STORAGE==='1';
let unstuckCheckPending=process.env.SURVIVAL_VERIFY_UNSTUCK==='1';
let constructionCheckPending=process.env.SURVIVAL_VERIFY_CONSTRUCTION_ACCESS==='1';
let indoorCheckPending=process.env.SURVIVAL_VERIFY_INDOOR==='1';
let web;
async function event(type,data={}){await appendFile(eventsFile,JSON.stringify({time:new Date().toISOString(),type,...data})+'\n');}
async function sample(){
 if(sampling||!bot?.entity||stopping)return;
 sampling=true;
 try{
 const time=bot.time.time,age=bot.time.age;
 if(lastSample&&age>=lastSample.age){status.activeTicks+=age-lastSample.age;const delta=time-lastSample.time;if(delta>=0)status.observedCalendarTicks+=delta;else await event('CLOCK_BACKWARD',{previous:lastSample.time,current:time});}
 lastSample={time,age};
 const inventory=bot.inventory.items().map(i=>({name:i.name,count:i.count}));
 const state=bot.strategySupervisor?.state;
 const projectId=state?.house?.projectId||state?.activeHouseProjectId;
 const project=projectId?(await listHouseProjects(bot)).find(entry=>entry.id===projectId):null;
 if(project){
  const plan=projectShellPlan(project);
  const blocks=plan.map(entry=>({entry,block:bot.blockAt(new Vec3(project.origin.x,project.origin.y,project.origin.z).offset(...entry.offset))}));
  status.houseConstruction={projectId,status:project.status,model:project.model.name,origin:project.origin,
   matched:blocks.filter(({entry,block})=>entry.acceptedItems.includes(block?.name)).length,total:plan.length,
   unknown:blocks.filter(({block})=>!block).length,observedAt:Date.now(),
   finishingPending:project.construction?.finishingPending||false,palette:project.construction?.palette||{}};
  const facilities={beds:0,chests:0,furnaces:0,craftingTables:0};
  for(let x=1;x<project.model.size.width-1;x++)for(let z=1;z<project.model.size.depth-1;z++){
   const block=bot.blockAt(new Vec3(project.origin.x+x,project.origin.y+1,project.origin.z+z));
   if(block?.name==='furnace')facilities.furnaces++;
   if(block?.name==='chest')facilities.chests++;
   if(block?.name==='crafting_table')facilities.craftingTables++;
   if(block?.name.endsWith('_bed')&&block.getProperties().part==='foot')facilities.beds++;
  }
  status.houseConstruction.facilities=facilities;
 }else status.houseConstruction=null;
 const inspectionKey=JSON.stringify([state?.failures?.night?.attempts,state?.failures?.shelter?.attempts,state?.home]);
 if(state?.home && inspectionKey!==lastShelterInspection){
  const blocks=[];const feet=bot.entity.position.floored();
  for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)for(let y=-1;y<=3;y++){
   const p=feet.offset(x,y,z);const block=bot.blockAt(p);
   if(block && !['air','cave_air'].includes(block.name))blocks.push({position:p,name:block.name,properties:block.getProperties()});
  }
  const entryBlocks=[];
  if(state.home.door){
   const door=new Vec3(state.home.door.x,state.home.door.y,state.home.door.z);
   const delta=door.minus(new Vec3(state.home.x,state.home.y,state.home.z));
   const outward=Math.abs(delta.x)>Math.abs(delta.z)?new Vec3(Math.sign(delta.x),0,0):new Vec3(0,0,Math.sign(delta.z));
   for(let distance=0;distance<=4;distance++)for(let y=-1;y<=3;y++){
    const p=door.plus(outward.scaled(distance)).offset(0,y,0);const block=bot.blockAt(p);
    entryBlocks.push({position:p,name:block?.name??'unloaded'});
   }
  }
  await event('SHELTER_INSPECTION',{position:bot.entity.position,home:state.home,emergencyShelter:state.emergencyShelter,blocks,entryBlocks});
  lastShelterInspection=inspectionKey;
 }
 status.development=state?.development??null;
 status.developmentCheck=state?developmentStatus(bot,state):null;
 status.chestContents=state?[state.storage,...(state.archivedStorage||[])].filter(Boolean).flatMap((storage)=>
  (storage.chests||[]).map((chest)=>({id:chest.id,position:chest.position,dimension:storage.dimension,containerKey:chest.containerKey,
   archived:storage!==state.storage,missing:chest.missing||false,observedAt:chest.observedAt||null,freeSlots:chest.freeSlots,
   verificationError:chest.verificationError||null,items:chest.snapshot??null}))):[];
 const homePoint=state?.home;
 status.homeVerified=!!homePoint && homePoint.status!=='building' && bot.blockAt(new Vec3(homePoint.x,homePoint.y-1,homePoint.z))?.boundingBox==='block'
  && bot.blockAt(new Vec3(homePoint.x,homePoint.y,homePoint.z))?.boundingBox==='empty'
  && bot.blockAt(new Vec3(homePoint.x,homePoint.y+1,homePoint.z))?.boundingBox==='empty'
  && !!homePoint.door && !!bot.blockAt(new Vec3(homePoint.door.x,homePoint.door.y,homePoint.door.z))?.name.endsWith('_door');
 status.base=state?.base??null;
 status.nightShelter=state?.nightShelter??null;
 status.treeHarvest=state?.wholeTree?{base:state.wholeTree.base,logs:state.wholeTree.logs.length,started:state.wholeTree.started}:null;
 status.localRecovery=state?.localRecovery??null;
 status.eventLoopDelayMaxMs=Math.round(loopDelay.max/1e6);loopDelay.reset();
 status.equipment=[5,6,7,8,45].map(slot=>({slot,name:bot.inventory.slots[slot]?.name??null}));
 updateRunStatus(status,{lastObservedAt:new Date().toISOString(),elapsedGameDays:Math.floor(status.observedCalendarTicks/24000),activeGameDays:status.activeTicks/24000,worldDay:bot.time.day,worldTime:time,worldAge:age,health:bot.health,food:bot.food,position:bot.entity.position,inventory,task:actions.tasks.describe(),home:state?.home,house:state?.house,farm:state?.farm?{width:state.farm.width,depth:state.farm.depth,status:state.farm.status,lastInspection:state.farm.lastInspection,harvestCycles:state.farm.harvestCycles}:null,storage:state?.storage?{mode:state.storage.mode,capacity:state.storage.capacity,chests:state.storage.chests.length,status:state.storage.status}:null,pastures:state?.pastures?.map(p=>({species:p.species,status:p.status,animals:p.animals?.length})),failures:state?.failures,plannedShelter:state?.plannedShelter,danger:bot.strategySupervisor?.danger,lastFailure:state?.lastGoal});
 await writeFile(statusFile,JSON.stringify(status,null,2)+'\n');await event('HEARTBEAT',status);
 }finally{sampling=false;}
}
function connect(){
 if(stopping)return;
 bot=mineflayer.createBot({host:'127.0.0.1',port:25565,username:status.username,auth:'offline',version:'1.21.6'});
 bot.on('error',e=>event('ERROR',{message:e.message}));
 bot.on('agentProgress',progress=>event('PROGRESS',progress));
 bot.on('agentNavigationFailure',details=>event('NAVIGATION_FAILURE',details));
 bot.on('kicked',reason=>event('KICK',{reason}));
 bot.on('messagestr',message=>{if(message.includes(status.username))event('OWN_SERVER_MESSAGE',{message});});
 deathLogging=attachDeathLogging({bot,status,event,describeTask:()=>actions.tasks.describe(),directory:reportDirectory});
 bot.once('spawn',async()=>{
  status.phase='running';status.connections++;lastSample=null;bot.buildingServer='fabric-regression-25565';bot.farmOptions={...config.farm,maxWidth:15,maxDepth:15,autoExpand:true};bot.supplyOptions=config.supplies;bot.autonomyHouseModel='starter';actions.attach(bot);
  await event('CONNECTED',{position:bot.entity.position,worldTime:bot.time.time,age:bot.time.age});
  await new Promise(r=>setTimeout(r,2000));if(stopping)return;
  if(constructionCheckPending){
   constructionCheckPending=false;
   try{
    const result=inspectConstructionAccess(bot);
    await writeFile(new URL('施工站位诊断.json',reportDirectory),JSON.stringify(result,null,2)+'\n');
    await event('CONSTRUCTION_ACCESS_INSPECTION',{target:result.target,above:result.above,miningRoute:result.miningRoute,
     accessibleStandCount:result.candidates.filter(entry=>entry.walking.status==='success').length,
     usableMiningStandCount:result.candidates.filter(entry=>entry.walking.status==='success'&&entry.satisfiesMiningGoal).length});
   }catch(error){await event('CONSTRUCTION_ACCESS_INSPECTION_ERROR',{message:error.message});}
  }
  if(indoorCheckPending){
   indoorCheckPending=false;
   const result=await verifyIndoorWorkRoute(bot);
   await event('INDOOR_ROUTE_VERIFICATION',result);
   await writeFile(new URL('室内通道实测.json',reportDirectory),JSON.stringify(result,null,2)+'\n');
   console.log('[室内通道实服验证]',JSON.stringify({result:result.result,reason:result.reason,before:result.before,after:result.after}));
  }
  if(config.web.enabled){
   if(!web){
    web=await startWebService({actions,llm:config.llm,npc:{...config.npc,autonomy:'auto',manualControl:false},
     options:{...config.web,getRunStatus:()=>status}});
    console.log(`Web 监控与对话 ${web.url}`);
   }
   await web.attach(bot);
  }
  if(unstuckCheckPending){
   unstuckCheckPending=false;
   let result;
   try{result=await verifyLocalUnstuck(bot,(message)=>console.log(message));}
   catch(error){result={result:'FAIL',reason:error.message};}
   console.log('[局部脱困实服验证]',JSON.stringify(result));
   await event('LOCAL_UNSTUCK_VERIFICATION',result);
   await appendFile(new URL('阶段记录.md',reportDirectory),`\n## 局部脱困实服验证\n\n${result.result} ${result.reason}\n\n${JSON.stringify(result)}\n`);
  }
  if(storageCheckPending){
   storageCheckPending=false;
   let result;
   try{result=await verifyStorageTransfer(bot,(message)=>console.log(message));}
   catch(error){result={result:'FAIL',reason:error.message};}
   console.log('[存取实服验证]',JSON.stringify(result));
   await event('STORAGE_VERIFICATION',result);
   await appendFile(new URL('阶段记录.md',reportDirectory),`\n## 存取实服验证\n\n${result.result} ${result.reason}\n`);
  }
  if(!bot.autonomyStartupCancelled)await actions.run('start_autonomy',{}, {player:'zz',isWhisper:true});await sample();heartbeat=setInterval(()=>sample().catch(e=>event('SAMPLE_ERROR',{message:e.message})),10000);
 });
 bot.once('end',async(reason)=>{clearInterval(heartbeat);actions.interrupt();lastSample=null;await event('DISCONNECTED',{reason});if(!stopping)reconnect=setTimeout(connect,15000);});
}
async function stop(){if(stopping)return;await sample();stopping=true;clearInterval(heartbeat);clearTimeout(reconnect);const task=actions?.tasks.current;actions?.interrupt();await task?.settled;await web?.close();bot?.quit();await deathLogging?.flush();status.phase='stopped';status.stoppedAt=new Date().toISOString();await writeFile(statusFile,JSON.stringify(status,null,2)+'\n');await event('RUNNER_STOPPED');process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
await event('RUNNER_STARTED',{targetDays:status.targetDays});connect();
