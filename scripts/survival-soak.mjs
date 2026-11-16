// 在用户现有服务器上执行自然生存验收；不发管理命令、不启动或重启用户服务器。
import mineflayer from 'mineflayer';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createActionRegistry} from '../src/actions/index.js';
import {config} from '../src/config.js';
const statusFile=new URL('../reports/survival-status.json',import.meta.url);
const eventsFile=new URL('../reports/survival-events.jsonl',import.meta.url);
let status;
try {status=JSON.parse(await readFile(statusFile,'utf8'));} catch {status={startedAt:new Date().toISOString(),username:'QA_Agent',host:'127.0.0.1',port:25565,targetDays:100,observedCalendarTicks:0,activeTicks:0,deaths:0,connections:0,phase:'running'};}
let bot,actions,heartbeat,reconnect,lastSample,stopping=false,sampling=false;
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
 status={...status,lastObservedAt:new Date().toISOString(),elapsedGameDays:Math.floor(status.observedCalendarTicks/24000),activeGameDays:status.activeTicks/24000,worldDay:bot.time.day,worldTime:time,worldAge:age,health:bot.health,food:bot.food,position:bot.entity.position,inventory,task:actions.tasks.describe(),home:state?.home,house:state?.house,farm:state?.farm?{width:state.farm.width,depth:state.farm.depth,status:state.farm.status,lastInspection:state.farm.lastInspection,harvestCycles:state.farm.harvestCycles}:null,storage:state?.storage?{mode:state.storage.mode,capacity:state.storage.capacity,chests:state.storage.chests.length,status:state.storage.status}:null,pastures:state?.pastures?.map(p=>({species:p.species,status:p.status,animals:p.animals?.length})),failures:state?.failures,plannedShelter:state?.plannedShelter,danger:bot.strategySupervisor?.danger,lastFailure:state?.lastGoal};
 await writeFile(statusFile,JSON.stringify(status,null,2)+'\n');await event('HEARTBEAT',status);
 }finally{sampling=false;}
}
function connect(){
 if(stopping)return;
 bot=mineflayer.createBot({host:'127.0.0.1',port:25565,username:status.username,auth:'offline',version:'1.21.6'});
 actions=createActionRegistry({allowDig:true,allowCombat:true,allowAutonomy:true});
 bot.on('error',e=>event('ERROR',{message:e.message}));
 bot.on('agentProgress',progress=>event('PROGRESS',progress));
 bot.on('kicked',reason=>event('KICK',{reason}));
 bot.on('messagestr',message=>{if(message.includes(status.username))event('OWN_SERVER_MESSAGE',{message});});
 bot.on('death',()=>{status.deaths++;event('DEATH',{position:bot.entity?.position,task:actions.tasks.describe()});});
 bot.once('spawn',async()=>{
  status.connections++;lastSample=null;bot.buildingServer='fabric-regression-25565';bot.farmOptions={...config.farm,maxWidth:15,maxDepth:15,autoExpand:true};bot.supplyOptions=config.supplies;bot.autonomyHouseModel='warehouse';actions.attach(bot);
  await event('CONNECTED',{position:bot.entity.position,time:bot.time.time,age:bot.time.age});
  await new Promise(r=>setTimeout(r,2000));if(stopping)return;
  await actions.run('start_autonomy',{}, {player:'zz',isWhisper:true});await sample();heartbeat=setInterval(()=>sample().catch(e=>event('SAMPLE_ERROR',{message:e.message})),10000);
 });
 bot.once('end',async(reason)=>{clearInterval(heartbeat);actions.interrupt();lastSample=null;await event('DISCONNECTED',{reason});if(!stopping)reconnect=setTimeout(connect,15000);});
}
async function stop(){if(stopping)return;await sample();stopping=true;clearInterval(heartbeat);clearTimeout(reconnect);const task=actions?.tasks.current;actions?.interrupt();await task?.settled;bot?.quit();await event('RUNNER_STOPPED');process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
await event('RUNNER_STARTED',{targetDays:status.targetDays});connect();
