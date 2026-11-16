// 管理层合同回归：内存适配器替代Mongo，不冒充真实数据库持久化验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryManager} from '../src/memory/manager.js';
import {prepareMemoryOptions,resolveWorldOptions} from '../src/memory/bootstrap.js';
import {createHash,randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
function matches(record,filter){return Object.entries(filter).every(([key,value])=>{
 if(key==='$and')return value.every(part=>matches(record,part));
 if(key==='$or')return value.some(part=>matches(record,part));
 const actual=key.split('.').reduce((object,key)=>object?.[key],record);
 if(value&&typeof value==='object'){
  if('$nin'in value)return !value.$nin.includes(actual);
  if('$exists'in value)return (actual!==undefined)===value.$exists;
  if('$regex'in value)return new RegExp(value.$regex,value.$options).test(actual);
 }
 return actual===value;
});}
class Collection{
 records=new Map();
 async updateOne(filter,update,{upsert=false}={}){let record=[...this.records.values()].find(record=>matches(record,filter));const fresh=!record;if(!record&&!upsert)return;if(!record)record={...filter,...structuredClone(update.$setOnInsert)};Object.assign(record,structuredClone(update.$set||{}));if(fresh&&update.$setOnInsert)Object.assign(record,structuredClone(update.$setOnInsert));this.records.set(record._id,record);}
 async findOne(filter){return structuredClone([...this.records.values()].find(record=>matches(record,filter))||null);}
 find(filter){let records=[...this.records.values()].filter(record=>matches(record,filter));const cursor={sort(sort){const [field,direction]=Object.entries(sort)[0];records.sort((a,b)=>(a[field]>b[field]?1:a[field]<b[field]?-1:0)*direction);return cursor;},limit(count){records=records.slice(0,count);return cursor;},async toArray(){return structuredClone(records);}};return cursor;}
}
function fixture(t){const collections=new Map();const store={async collection(name){if(!collections.has(name))collections.set(name,new Collection());return collections.get(name);}};const create=(agent='a',world='world',team='team',epoch='initial')=>{const manager=new MemoryManager({enabled:true,agentId:agent,worldId:world,teamId:team,worldEpoch:epoch,mongoUri:'mongodb://127.0.0.1:27018',database:'qa_contract'},agent);const original=manager.store;t.after(()=>original.close());manager.store=store;return manager;};return{create,collections};}
const pos={x:1,y:64,z:2};
test('MEM-01 identity persists across concurrent initialization',async()=>{const profile=`qa-${randomUUID()}`;const options={enabled:true,profile};const values=await Promise.all(Array.from({length:8},()=>prepareMemoryOptions(options,profile)));assert.equal(new Set(values.map(value=>value.agentId)).size,1);await unlink(new URL(`../data/memory/profiles/${createHash('sha256').update(profile).digest('hex')}.json`,import.meta.url));});
test('MEM-02 explicit world identity is retained',async()=>{const options=await resolveWorldOptions({enabled:true,worldId:'stable-world'},{});assert.equal(options.worldId,'stable-world');assert.equal(options.identitySource,'configuration');});
test('MEM-03 own home is remembered without claiming respawn confirmed',async(t)=>{const {create}=fixture(t);const m=create();await m.setHome(m.context('overworld'),{position:pos});const records=await m.recall(m.context('overworld'),{kind:'home'});assert.deepEqual(records[0].data.position,pos);assert.equal(records[0].data.respawnConfirmed,false);});
test('MEM-04 private memories hidden from other agents',async(t)=>{const {create}=fixture(t);const a=create(),b=create('b');await a.setHome(a.context('overworld'),{position:pos});assert.equal((await b.recall(b.context('overworld'),{kind:'home'})).length,0);});
test('MEM-05 team sharing is scoped to that team',async(t)=>{const {create}=fixture(t);const a=create(),b=create('b'),c=create('c','world','other');const home=await a.setHome(a.context('overworld'),{position:pos});await a.shareMemory(a.context('overworld'),{id:home.id,scope:'team'});assert.equal((await b.recall(b.context('overworld'),{kind:'home'})).length,1);assert.equal((await c.recall(c.context('overworld'),{kind:'home'})).length,0);});
test('MEM-06 worlds do not share spatial memories',async(t)=>{const {create}=fixture(t);const a=create(),b=create('a','other');await a.setHome(a.context('overworld'),{position:pos});assert.equal((await b.recall(b.context('overworld'),{kind:'home'})).length,0);});
test('MEM-07 dimensions remain separated',async(t)=>{const {create}=fixture(t);const m=create();await m.setHome(m.context('overworld'),{position:pos});assert.equal((await m.recall(m.context('nether'),{kind:'home'})).length,0);});
test('MEM-08 rollback epoch marks prior observations stale',async(t)=>{const {create}=fixture(t);const a=create(),b=create('a','world','team','rollback');await a.setHome(a.context('overworld'),{position:pos});assert.equal((await b.recall(b.context('overworld'),{kind:'home'}))[0].needsRevalidation,true);});
test('MEM-09 pets use persistent UUID not transient entity id',async(t)=>{const {create}=fixture(t);const m=create();await m.rememberPet(m.context('overworld'),{entityUuid:'pet-uuid',name:'小狼',species:'wolf',position:pos});const [pet]=await m.recall(m.context('overworld'),{kind:'pet'});assert.equal(pet.key,'pet-uuid');assert.equal(pet.data.owner,null);});
test('MEM-10 placed asset records builder without inferring ownership',async(t)=>{const {create}=fixture(t);const m=create();await m.rememberAsset(m.context('overworld'),{position:pos,block:'chest'});const [asset]=await m.recall(m.context('overworld'),{kind:'asset'});assert.equal(asset.data.placedBy,'a');assert.equal(asset.data.owner,null);});
test('MEM-11 container change is observed, not attributed to a person',async(t)=>{const {create}=fixture(t);const m=create();const context=m.context('overworld');await m.recordContainerSnapshot(context,{containerId:'c',position:pos,items:[{slot:0,name:'bread',count:4}]});await m.recordContainerSnapshot(context,{containerId:'c',position:pos,items:[{slot:0,name:'bread',count:3}]});const [container]=await m.recall(context,{kind:'container'});assert.equal(container.data.changeStatus,'unexplained_change');assert.equal(container.data.changedBy,null);});
test('MEM-12 verified own transfer is distinct from unexplained changes',async(t)=>{const {create}=fixture(t);const m=create();const context=m.context('overworld');await m.recordContainerSnapshot(context,{containerId:'c',position:pos,items:[]});await m.recordContainerSnapshot(context,{containerId:'c',position:pos,items:[{slot:0,name:'bread',count:2}],operation:'agent_transfer'});assert.equal((await m.recall(context,{kind:'container'}))[0].data.changeStatus,'change_during_agent_operation');});
test('MEM-13 exploration is a sample, not a whole explored chunk',async(t)=>{const {create}=fixture(t);const m=create();await m.recordExploration(m.context('overworld'),{position:pos});assert.equal((await m.recall(m.context('overworld'),{kind:'exploration'}))[0].data.coverage,'point_sample_not_entire_cell');});
test('MEM-14 literal search escapes regex metacharacters',async(t)=>{const {create}=fixture(t);const m=create();const context=m.context('overworld');await m.remember(context,{kind:'note',key:'one',title:'a.b',data:{}});await m.remember(context,{kind:'note',key:'two',title:'axb',data:{}});assert.equal((await m.recall(context,{text:'a.b'})).length,1);});
test('MEM-15 published knowledge versions cannot silently overwrite',async(t)=>{const {create}=fixture(t);const m=create();await m.publishKnowledge({key:'farm',title:'种田',content:'one'});await assert.rejects(m.publishKnowledge({key:'farm',title:'种田',content:'two'}));});
test('MEM-16 malformed coordinates are rejected',async(t)=>{const {create}=fixture(t);const m=create();await assert.rejects(m.setHome(m.context('overworld'),{position:{x:NaN,y:64,z:0}}));});
