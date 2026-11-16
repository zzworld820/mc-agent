import mineflayer from 'mineflayer';
import {createInterface} from 'node:readline';
import {appendFile,writeFile} from 'node:fs/promises';
import {createActionRegistry} from '../src/actions/index.js';
import {scanEnvironment} from '../src/perception/environment.js';
import {config} from '../src/config.js';
const report = new URL('../reports/fabric-regression.jsonl',import.meta.url);
const log=async(type,data)=>{const record={time:new Date().toISOString(),type,...data};await appendFile(report,JSON.stringify(record)+'\n'); console.log(JSON.stringify(record));};
const bot=mineflayer.createBot({host:'127.0.0.1',port:25565,username:'QA_Agent',auth:'offline',version:'1.21.6'});
const actions=createActionRegistry({allowDig:true,allowCombat:true,allowAutonomy:true});
bot.on('error',e=>log('ERROR',{message:e.message}));
bot.on('kicked',r=>log('KICK',{reason:r}));
bot.on('messagestr',message=>log('CHAT',{message}));
bot.once('spawn',async()=>{bot.buildingServer='fabric-regression-25565';bot.farmOptions=config.farm;bot.supplyOptions=config.supplies;actions.attach(bot);await new Promise(r=>setTimeout(r,1500));await log('READY',{position:bot.entity.position,players:Object.keys(bot.players),dimension:bot.game.dimension});});
const readline=createInterface({input:process.stdin});
for await(const line of readline){try{const input=JSON.parse(line);if(input.op==='quit'){actions.interrupt();await actions.tasks.current?.settled;bot.quit();readline.close();break;}if(input.op==='status'){await log('STATUS',{position:bot.entity.position,food:bot.food,health:bot.health,items:bot.inventory.items().map(i=>({name:i.name,count:i.count})),task:actions.tasks.describe()});}if(input.op==='eval'){const fn=new Function('bot','actions','scanEnvironment','input',`return (async()=>{${input.code}\n})()`);await log('RESULT',{id:input.id,result:await fn(bot,actions,scanEnvironment,input)});}if(input.op==='action'){const result=await actions.run(input.name,input.args||{},{player:'zz',isWhisper:true});const task=actions.tasks.current;await log('ACTION',{id:input.id,name:input.name,result});if(task){await task.settled;await log('SETTLED',{id:input.id,progress:task.progress});}}}catch(e){await log('FAIL',{message:e.stack});}}
