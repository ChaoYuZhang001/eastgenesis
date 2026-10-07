// @vitest-environment node
import {afterEach,beforeAll,beforeEach,describe,expect,test,vi} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {Db} from "@/lib/db";
import {asDb,loadSqlite,migratedDb,type RawDb,type SqliteModule} from "./sqlite-helper";
const host=vi.hoisted(()=>({db:null as Db|null}));
vi.mock("@/lib/db",()=>({withDb:async<T>(fn:(db:Db)=>Promise<T>)=>{try{return await fn(host.db!);}catch(e){if(e&&typeof e==='object'&&'code'in e){const a=e as {code:string;message?:string};throw{code:a.code,message:a.message};}throw e;}}}));
import {saveGoal,updateGoal,listGoals} from "@/lib/db-goal";
import {getToolInvocation,saveToolInvocation,claimToolInvocation,renewToolInvocation,releaseToolInvocation} from "@/lib/db-invocation";
import {goalRunner} from "@/lib/goal-run";
import {createMockBackend,setBackend,type ProxyRequest,type ProxyResponse} from "@/platform";
import {useGoals} from "@/stores/goals";
import {useTasks} from "@/stores/tasks";
import {useSettings} from "@/stores/settings";
import {useMcp} from "@/stores/mcp";
import {hydrateGoalCheckpoints} from "@/stores/history";
let sqlite:SqliteModule,raw:RawDb,dir:string;let wire:ProxyRequest[],tools=0;let unknown=false,verifierUnknown=false,expireBeforeTool=false;let at:number;let goalId:string|null;let jevRequestCount=0;
beforeAll(async()=>{sqlite=(await loadSqlite())!;expect(sqlite).not.toBeNull();});
function chat(text:string):ProxyResponse{return{status:200,body:JSON.stringify({model:"synthetic",choices:[{index:0,message:{role:"assistant",content:text},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1}})};}
function jev(r:ProxyRequest,p=.05):ProxyResponse{const body=JSON.parse(r.body!),answers=Object.fromEntries(Object.entries(body.questions).map(([k,q])=>{const v=q as {type:string;criteria?:Record<string,string>};return[k,v.type==='noul'?{type:'noul',noul:p}:v.type==='choice'?{type:'choice',choice:Object.keys(v.criteria!)[0],confidence:.95,probabilities:Object.fromEntries(Object.keys(v.criteria!).map((c,i)=>[c,i===0?1:0]))}:{type:'score',score:0,confidence:.95,legend:{0:'low',1:'medium',2:'high'},probabilities:{0:1,1:0,2:0}}];}));return{status:200,body:JSON.stringify({model:'jev-synthetic',answers,usage:{input_tokens:1,output_tokens:1}})};}
beforeEach(async()=>{raw=migratedDb(sqlite);host.db=asDb(()=>raw);dir=mkdtempSync(join(tmpdir(),'eg-combined-host-synthetic-'));wire=[];tools=0;unknown=false;verifierUnknown=false;expireBeforeTool=false;at=Date.now();goalId=null;jevRequestCount=0;
 const b=createMockBackend({jevConfigured:true});
 setBackend({...b,kind:'tauri',saveGoal,updateGoal,listGoals,getToolInvocation,saveToolInvocation,claimToolInvocation,renewToolInvocation,releaseToolInvocation,
  providerRequest:async r=>{wire.push(r);if(r.target==='jev'){jevRequestCount++;
    const rows=await host.db!.select<{value:string}[]>('SELECT value FROM app_meta WHERE key=$1',[`goal-quota:v1:${goalId}`]);const permit=rows[0]?JSON.parse(rows[0].value).permits.at(-1):null;
    if(verifierUnknown&&permit?.kind==='goal_verifier')throw Error('synthetic independent verifier lost ACK');
    return jev(r,permit?.kind==='goal_verifier'?.95:.05);
   }
   if(unknown)throw Error('synthetic model network outcome unknown');
   const body=JSON.parse(r.body!),system=body.messages?.[0]?.content??'';
   if(system.includes('任务规划器')){if(expireBeforeTool)at+=300001;return chat(JSON.stringify({steps:[{goal:'整理文件',tool:'mcp__files__move_file',args:{path:'/synthetic/a.pdf',to:'/synthetic/PDF/a.pdf'}}]}));}
   if(body.stream)return{status:200,body:`data: ${JSON.stringify({id:'synthetic',model:'synthetic',choices:[{index:0,delta:{role:'assistant',content:'synthetic file sorted'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'synthetic',model:'synthetic',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})}\n\ndata: [DONE]\n\n`};
   return chat('synthetic file sorted');
  }});
 vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('network forbidden in synthetic combined host');});
 useSettings.setState({statuses:await b.providerStatus(),jev:await b.jevStatus(),defaultPermission:'full',timeoutS:1,providerPrefs:{regions:{},ollama:false,localJev:null}});
 useMcp.setState({conns:{files:{status:'running',config:null,infos:[],skipped:[],serverInfo:null,error:null,tools:[{name:'mcp__files__move_file',description:'synthetic move',sideEffect:'local_write',run:async()=>{tools++;writeFileSync(join(dir,'artifact.txt'),'synthetic artifact');return{ok:true,content:'moved synthetic file',data:{}};}}]}}});
 useGoals.setState({items:[],loaded:true,error:null});useTasks.setState({tasks:[],activeId:null});});
afterEach(()=>{for(const g of useGoals.getState().items)goalRunner.stop(g.id);vi.restoreAllMocks();setBackend(null);useMcp.setState({conns:{}});(raw as unknown as {close():void}).close();rmSync(dir,{recursive:true,force:true});});
async function create(cap=30){const g=await useGoals.getState().save({description:'把下载文件夹按类型整理好',max_llm_calls:cap});if(typeof g==='string')throw Error(g);goalId=g.id;expect(await useGoals.getState().start(g.id)).toBeNull();return g.id;}
describe('real Tasks.lazy → GoalRunner → createEngine/SDK/Jev/Agent → canonical SQLite and physical synthetic tool ledger',()=>{
 test('routine Jev, main and independent completion verifier all occupy one Goal cap and preserve true main receipt',async()=>{const id=await create();await goalRunner.run(id);const g=(await listGoals())[0];expect(g.status,JSON.stringify({error:useGoals.getState().error,card:useTasks.getState().tasks.map(t=>({status:t.status,summary:t.summary,events:t.events.map(e=>e.type)})),targets:wire.map(r=>r.target),systems:wire.map(r=>JSON.parse(r.body!).messages?.[0]?.content?.slice?.(0,100))})).toBe('completed');expect(tools).toBe(1);expect(readFileSync(join(dir,'artifact.txt'),'utf8')).toBe('synthetic artifact');const rows=await host.db!.select<{value:string}[]>('SELECT value FROM app_meta WHERE key=$1',[`goal-quota:v1:${id}`]);const q=JSON.parse(rows[0].value);expect(q.consumed).toBe(wire.length);expect(q.permits.every((p:{state:string})=>p.state==='succeeded')).toBe(true);expect(new Set(q.permits.map((p:{kind:string})=>p.kind))).toEqual(new Set(['main','cloud_decision','goal_verifier']));const main=q.permits.filter((p:{kind:string})=>p.kind==='main').length;expect(g.rounds[0].llm_settlements?.[0].llm_calls).toBe(main);expect(g.used_llm_calls).toBe(q.consumed);const ledger=await host.db!.select<{state:string;task_id:string}[]>('SELECT state,task_id FROM tool_invocations');expect(ledger).toEqual([{state:'applied',task_id:g.rounds[0].task_id}]);expect(jevRequestCount).toBeGreaterThan(0);});
 test('bounded cap refusal stops SDK and actual beforeSideEffect tool after three admitted calls without budget reset',async()=>{const id=await create(3);await goalRunner.run(id);const g=(await listGoals())[0];expect(g.status).toBe('paused');expect(g.quota).toMatchObject({consumed:3,pending:0,unknown:0,active:false});expect(wire).toHaveLength(3);expect(tools).toBe(0);expect(useTasks.getState().tasks[0].quotaControl?.code).toBe('quota_denied');expect(g.rounds).toHaveLength(1);});
 test('unknown main transport retains occupied permit, pauses original round and never reaches synthetic tool',async()=>{unknown=true;const id=await create();await goalRunner.run(id);const g=(await listGoals())[0];expect(g.status).toBe('paused');expect(g.quota).toMatchObject({active:false,unknown:1});expect(g.used_llm_calls).toBe(wire.length);expect(tools).toBe(0);expect(useTasks.getState().tasks[0].quotaControl?.code).toBe('quota_outcome_unknown');expect(g.rounds[0].task_checkpoint?.recovery_accounting?.final).toBe(false);expect(g.rounds[0].llm_settlements??[]).toEqual([]);const old=wire.length;expect(await useGoals.getState().start(id)).toBe('quota_outcome_unknown');await goalRunner.run(id);expect(wire).toHaveLength(old);});
 test('verifier unknown after applied tool preserves completed Task; reload free rule/user assessment consumes no new permit and does not replay tool',async()=>{verifierUnknown=true;const id=await create();await goalRunner.run(id);const before=(await listGoals())[0];expect(before.status).toBe('paused');expect(before.rounds[0].task_checkpoint?.status).toBe('completed');expect(tools).toBe(1);expect(before.quota?.unknown).toBe(1);const beforeWire=wire.length,taskId=before.rounds[0].task_id,consumed=before.quota!.consumed;useTasks.setState({tasks:[]});await useGoals.getState().load();hydrateGoalCheckpoints();expect(await useGoals.getState().start(id)).toBeNull();await goalRunner.run(id);const after=(await listGoals())[0];expect(wire).toHaveLength(beforeWire);expect(tools).toBe(1);expect(after.rounds[0].task_id).toBe(taskId);expect(after.quota).toMatchObject({consumed,unknown:1,active:false});expect(after.rounds[0].verdict?.by).toBe('rules');const ledger=await host.db!.select<{state:string}[]>('SELECT state FROM tool_invocations');expect(ledger).toEqual([{state:'applied'}]);});
 test('expired owned checkpoint prevents actual Agent beforeSideEffect tool dispatch even before another owner claims',async()=>{vi.spyOn(Date,'now').mockImplementation(()=>at);expireBeforeTool=true;const id=await create();await goalRunner.run(id);expect(tools).toBe(0);const g=(await listGoals())[0];expect(g.status).toBe('paused');expect(g.quota?.active).toBe(false);expect(useGoals.getState().error).toContain('quota_denied');const ledger=await host.db!.select<{state:string}[]>('SELECT state FROM tool_invocations');expect(ledger.every(x=>x.state!=='applied')).toBe(true);});
});
