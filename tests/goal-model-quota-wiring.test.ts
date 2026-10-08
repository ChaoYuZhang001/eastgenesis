// @vitest-environment node
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "@/lib/engine";
import { createMockBackend, type Backend, type ProxyRequest, type ProxyResponse } from "@/platform";
import { createGoalQuotaAuthority, encodeNewGoalEnvelope, GOAL_QUOTA_SQL } from "@/lib/db-goal-quota";
import { JevClient, LocalJevBackend, HealthTracker } from "@/decision";
import { proxiedFetch } from "@/platform";
import { providerFactory } from "@/lib/engine";
import type { Db } from "@/lib/db";
import { DecisionLayer } from "@/decision/decision-layer";
import { getToolInvocation, saveToolInvocation, claimToolInvocation, renewToolInvocation, releaseToolInvocation } from "@/lib/db-invocation";
import { COORDINATOR_MARK } from "@/agent/split";
import { APIError } from "@typesafe-ai/sdk";
import { asDb, loadSqlite, readMigrations, type RawDb, type SqliteModule } from "./sqlite-helper";
const sqlHost = vi.hoisted(() => ({ current: null as import("@/lib/db").Db | null }));
vi.mock("@/lib/db", async importOriginal => ({
 ...await importOriginal<typeof import("@/lib/db")>(),
 withDb: async <T>(fn:(db:Db)=>Promise<T>) => { if (!sqlHost.current) throw Error("synthetic SQL binding absent"); return fn(sqlHost.current); },
}));
let sqlite: SqliteModule;
const owned: { dir: string; raws: RawDb[] }[] = [];
beforeAll(async () => { const mod = await loadSqlite(); expect(mod, "actual SQLite required").not.toBeNull(); sqlite = mod!; });
afterEach(() => { for (const f of owned.splice(0)) { for (const raw of f.raws) (raw as RawDb & { close():void }).close(); rmSync(f.dir, { recursive:true, force:true }); } });
const identity = { goalId:"goal-alpha", enrollmentId:"enroll-alpha" };
const execution = { taskId:"task-alpha", executionId:"exec-alpha" };
const context = { ...identity, ...execution };
async function fixture(limit=3) {
 const dir=mkdtempSync(join(tmpdir(), "eg-all-call-synthetic-")), path=join(dir,"quota.sqlite");
 const raw=new sqlite.DatabaseSync(path); owned.push({ dir, raws:[raw] });
 raw.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;"); for (const m of readMigrations()) raw.exec(m.sql);
 const db=asDb(()=>raw);sqlHost.current=db;const authority=createGoalQuotaAuthority(db,()=>1000);
 await authority.prepareNew({ ...identity, limit });
 await db.execute("INSERT INTO goals (id,description,max_llm_calls,used_llm_calls,status,rounds,created_at,updated_at,deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",[identity.goalId,"synthetic quota",limit,0,"running",JSON.stringify({ ...JSON.parse(encodeNewGoalEnvelope(identity,[])), revision:0, execution:{ owner_id:"owner-alpha", fence:1, task_id:execution.taskId, execution_id:execution.executionId } }),1000,1000,null]);
 const claim=await authority.claim({ ...identity, ownerId:"owner-alpha", expectedFence:0, leaseMs:300000 });
 const meter=authority.meter(claim,execution);
 return { raw, db, path, authority, claim, meter, record:()=>authority.snapshot(identity) };
}
function chatReply(text:string):ProxyResponse { return {status:200,body:JSON.stringify({model:"synthetic",choices:[{index:0,message:{role:"assistant",content:text},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1}})}; }
function jevReply(req:ProxyRequest,p=.1):ProxyResponse {
 const body=JSON.parse(req.body!); const answers=Object.fromEntries(Object.entries(body.questions).map(([k,q]:[string,any])=>[k,q.type==="noul"?{type:"noul",noul:p}:q.type==="choice"?{type:"choice",choice:Object.keys(q.criteria)[0],confidence:.95,probabilities:Object.fromEntries(Object.keys(q.criteria).map((c,i)=>[c,i===0?1:0]))}:{type:"score",score:0,confidence:.95,legend:{0:"low",1:"mid",2:"high"},probabilities:{0:1,1:0,2:0}}]));
 return {status:200,body:JSON.stringify({model:"jev-synthetic",answers,usage:{input_tokens:1,output_tokens:1}})};
}
async function backend(jev=true, intercept?:(r:ProxyRequest)=>Promise<ProxyResponse|null>|ProxyResponse|null) {
 const base=createMockBackend({jevConfigured:jev}), wire:ProxyRequest[]=[];
 const b:Backend={...base,providerRequest:async r=>{wire.push(r);const response=await intercept?.(r);return response??(r.target==="jev"?jevReply(r):r.target==="ollama"?chatReply(JSON.stringify({code:.1,reasoning:.1,tool_use:.1})):base.providerRequest(r));}};
 return {backend:b,statuses:await b.providerStatus(),jev:await b.jevStatus(),wire};
}
const lock={lock:"openai/gpt-5.6-luna"};
const run=(engine:ReturnType<typeof createEngine>)=>engine.runtime.run("你好",{taskId:execution.taskId,route:lock});
describe("actual engine / SDK / physical SQLite all-call quota",()=>{
 test("two main plus one Jev consume cap3; a fourth main has no Provider dispatch",async()=>{
  const f=await fixture(3), b=await backend();
  const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context} as Parameters<typeof createEngine>[0]);
  expect((await run(engine)).status).toBe("completed"); expect((await run(engine)).status).toBe("completed");
  await engine.decision.routeTask({text:"解释一个简单概念"});
  expect((await f.record()).consumed).toBe(3);
  const posts=b.wire.length, denied=await run(engine);
  expect(denied).toMatchObject({status:"needs_user",quotaControl:{code:"quota_denied"}});
  expect(b.wire).toHaveLength(posts); expect((await f.record()).permits.map(p=>p.kind)).toEqual(["main","main","cloud_decision"]);
 });
 test("actual SDK choice / score / noul share three canonical admissions",async()=>{
  const f=await fixture(3), b=await backend();
  const client=new JevClient({apiKey:"synthetic-key",fetch:proxiedFetch(b.backend,"jev"),goalMeter:f.meter,goalExecution:context,maxRetries:9});
  await client.choice("synthetic state","choose",{a:"A",b:"B"});await client.score("synthetic state","score",["low","medium","high"]);await client.noul("synthetic state","done?");
  await expect(client.noul("synthetic state","another?")).rejects.toMatchObject({code:"quota_denied"});
  expect(b.wire).toHaveLength(3);expect((await f.record()).permits.map(p=>p.kind)).toEqual(["cloud_decision","cloud_decision","cloud_decision"]);
 });
 test("independent completion verifier shares cap with main and refuses wrong task",async()=>{
  const f=await fixture(1), b=await backend(), engine=createEngine({...b,goalMeter:f.meter,goalExecution:context});
  const evidence={tool_calls:[],file_changes:[{path:"/synthetic/a.pdf",action:"moved" as const,to:"/synthetic/PDF/a.pdf"}],command_outputs:[],claim:"already sorted"};
  await expect(engine.decision.checkDoneWithEvidence("把下载文件夹按类型整理好",evidence,{taskId:"task-other"})).rejects.toMatchObject({code:"quota_invalid_request"});expect(b.wire).toHaveLength(0);
  await engine.decision.checkDoneWithEvidence("把下载文件夹按类型整理好",evidence,{taskId:execution.taskId});
  expect((await f.record()).permits).toMatchObject([{kind:"goal_verifier",purpose:"check_done",state:"succeeded"}]);
  expect(await run(engine)).toMatchObject({status:"needs_user",quotaControl:{code:"quota_denied"}});expect(b.wire).toHaveLength(1);
 });
 test("local classification before provider.chat consumes shared cap",async()=>{
  const f=await fixture(1),b=await backend(false),engine=createEngine({...b,goalMeter:f.meter,goalExecution:context,providerPrefs:{regions:{},ollama:true,localJev:"ollama/qwen3:8b"}});
  const result=await engine.decision.routeTask({text:"解释一个简单概念"});expect(result.meta.backend).toBe("local-jev");
  expect((await f.record()).permits).toMatchObject([{kind:"local_decision",state:"succeeded"}]);
  expect(await run(engine)).toMatchObject({status:"needs_user",quotaControl:{code:"quota_denied"}});expect(b.wire.map(r=>r.target)).toEqual(["ollama"]);
 });
 test("rule-only decisions are free and issue no model request",async()=>{
  const f=await fixture(1),b=await backend(false),engine=createEngine({...b,goalMeter:f.meter,goalExecution:context});
  await engine.decision.routeTask({text:"解释一个简单概念"});await engine.decision.chooseTool("explain");await engine.decision.checkDone("explain","explain done");await engine.decision.evaluateResult("explain","explain done");
  expect((await f.record()).consumed).toBe(0);expect(b.wire).toEqual([]);
 });
 test("cloud low-confidence followed by local refusal does not escape to rules",async()=>{
  const f=await fixture(1),b=await backend(true,r=>r.target==="jev"?jevReply(r,.5):null),health=new HealthTracker();const penalty=vi.spyOn(health,"recordFailure");
  const engine=createEngine({...b,health,goalMeter:f.meter,goalExecution:context,providerPrefs:{regions:{},ollama:true,localJev:"ollama/qwen3:8b"}});
  await expect(engine.decision.routeTask({text:"解释一个简单概念"})).rejects.toMatchObject({code:"quota_denied"});expect(b.wire.map(r=>r.target)).toEqual(["jev"]);expect(penalty).not.toHaveBeenCalled();expect((await f.record()).consumed).toBe(1);
 });
 test("actual SDK terminal HTTP503 permits local fallback with spent cloud slot, no SDK retry",async()=>{
  const f=await fixture(2),b=await backend(true,r=>r.target==="jev"?{status:503,body:"{}"}:null);const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context,providerPrefs:{regions:{},ollama:true,localJev:"ollama/qwen3:8b"}});
  expect((await engine.decision.routeTask({text:"解释一个简单概念"})).meta.backend).toBe("local-jev");expect(b.wire.map(r=>r.target)).toEqual(["jev","ollama"]);
  expect((await f.record()).permits.map(p=>[p.kind,p.state])).toEqual([["cloud_decision","failed"],["local_decision","succeeded"]]);expect(await run(engine)).toMatchObject({status:"needs_user",quotaControl:{code:"quota_denied"}});expect(b.wire).toHaveLength(2);
 });
 test("SDK unknown transport failure stops before internal retry / local / rules",async()=>{
  const f=await fixture(3),b=await backend(true,r=>{if(r.target==="jev")throw Error("synthetic connection lost");return null;});const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context,providerPrefs:{regions:{},ollama:true,localJev:"ollama/qwen3:8b"}});
  await expect(engine.decision.routeTask({text:"解释一个简单概念"})).rejects.toMatchObject({code:"quota_outcome_unknown"});expect(b.wire.map(r=>r.target)).toEqual(["jev"]);expect(await f.record()).toMatchObject({consumed:1,active:false,permits:[{state:"unknown"}]});
 });
 test("next override is inside one main permit; refusal does not consume or read override",async()=>{
  const f=await fixture(1),b=await backend(false),read=vi.fn(()=>({mode:"next" as const,profileId:"anthropic/claude-sonnet-5-5"})),consume=vi.fn();const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context,override:read,consumeNext:consume});
  expect((await run(engine)).status).toBe("completed");expect(b.wire.map(r=>r.target)).toEqual(["anthropic"]);expect((await f.record()).consumed).toBe(1);
  expect(await run(engine)).toMatchObject({quotaControl:{code:"quota_denied"}});expect(read).toHaveBeenCalledTimes(1);expect(consume).toHaveBeenCalledTimes(1);expect(b.wire).toHaveLength(1);
 });
 test("main confirmed HTTP rejection then other Provider success costs one logical permit, two wire attempts",async()=>{
  const f=await fixture(1),b=await backend(false,r=>r.target==="anthropic"?{status:503,body:"{}"}:null);const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context,override:()=>({mode:"next",profileId:"anthropic/claude-sonnet-5-5"})});
  expect((await run(engine)).status).toBe("completed");expect(b.wire.map(r=>r.target)).toEqual(["anthropic","openai"]);expect((await f.record()).permits).toMatchObject([{kind:"main",state:"succeeded"}]);expect((await f.record()).consumed).toBe(1);
 });
 test("main unknown transport outcome stops before fallback and does not punish health",async()=>{
  const f=await fixture(3),b=await backend(false,r=>{if(r.target==="anthropic")throw Error("synthetic ACK lost");return null;}),health=new HealthTracker(),penalty=vi.spyOn(health,"recordFailure");const engine=createEngine({...b,health,goalMeter:f.meter,goalExecution:context,override:()=>({mode:"next",profileId:"anthropic/claude-sonnet-5-5"})});
  expect(await run(engine)).toMatchObject({status:"needs_user",quotaControl:{code:"quota_outcome_unknown"}});expect(b.wire.map(r=>r.target)).toEqual(["anthropic"]);expect(penalty).not.toHaveBeenCalled();expect(await f.record()).toMatchObject({consumed:1,active:false,permits:[{state:"unknown"}]});
 });
 test("hand-constructed APIError status does not grant terminal provenance",async()=>{
  const f=await fixture(2);let calls=0;const client=new JevClient({apiKey:"synthetic-key",goalMeter:f.meter,goalExecution:context,fetch:async()=>{calls++;throw new APIError(503,{},new Headers());}});
  await expect(client.noul("synthetic","done?")).rejects.toMatchObject({code:"quota_outcome_unknown"});expect(calls).toBe(1);expect((await f.record()).permits[0].state).toBe("unknown");
 });
 test("two actual engines on independent SQLite connections race for one final slot",async()=>{
  const f=await fixture(1),b=await backend(false),raw=new sqlite.DatabaseSync(f.path);owned.at(-1)!.raws.push(raw);raw.exec("PRAGMA busy_timeout=1000;");const second=createGoalQuotaAuthority(asDb(()=>raw),()=>1000);const a=createEngine({...b,goalMeter:f.meter,goalExecution:context}),c=createEngine({...b,goalMeter:second.meter(f.claim,execution),goalExecution:context});
  const out=await Promise.all([run(a),run(c)]);expect(out.map(r=>r.status).sort()).toEqual(["completed","needs_user"]);expect(b.wire).toHaveLength(1);expect((await f.record()).consumed).toBe(1);
 });
 test("explicit Goal missing / mismatched scopes fail closed; ordinary Chat remains available",async()=>{
  const f=await fixture(3),b=await backend(false);
  expect(()=>createEngine({...b,goalExecution:context})).toThrow("quota_invalid_request");expect(()=>createEngine({...b,goalMeter:f.meter})).toThrow("quota_invalid_request");
  for(const key of ["goalId","enrollmentId","taskId","executionId"] as const) expect(()=>createEngine({...b,goalExecution:{...context,[key]:"foreign-identity"},goalMeter:f.meter})).toThrow("quota_invalid_request");
  expect(b.wire).toHaveLength(0);const engine=createEngine({...b,goalExecution:context,goalMeter:f.meter});expect(await engine.runtime.run("你好",{route:lock,goalExecution:{...context,executionId:"exec-other"}})).toMatchObject({quotaControl:{code:"quota_invalid_request"}});expect(b.wire).toHaveLength(0);
  expect((await run(createEngine(b))).status).toBe("completed");expect(b.wire).toHaveLength(1);expect((await f.record()).consumed).toBe(0);
 });
 test("main partial stream is retained while unknown outcome blocks fallback",async()=>{
  const f=await fixture(3),b=await backend(false,r=>r.target==="anthropic"?{status:200,body:'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"synthetic","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"kept partial"}}\n\n'}:null);
  const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context,override:()=>({mode:"next",profileId:"anthropic/claude-sonnet-5-5"})});const result=await run(engine);
  expect(result).toMatchObject({status:"needs_user",quotaControl:{code:"quota_outcome_unknown"}});expect(result.events.some(e=>e.type==="llm_delta"&&e.text==="kept partial")).toBe(true);expect(b.wire.map(r=>r.target)).toEqual(["anthropic"]);expect((await f.record()).consumed).toBe(1);
 });
 test("Coordinator children share cap and control stop prevents merge / further workers",async()=>{
  const f=await fixture(1),b=await backend(false),engine=createEngine({...b,goalMeter:f.meter,goalExecution:context});const result=await engine.coordinator.run("解释概念",{taskId:execution.taskId,route:lock});
  expect(result).toMatchObject({status:"needs_user",quotaControl:{code:"quota_denied"}});expect((await f.record()).permits).toMatchObject([{kind:"main",purpose:"split",state:"succeeded"}]);expect(b.wire).toHaveLength(1);expect(result.events.some(e=>e.type==="split")).toBe(true);expect(result.events.some(e=>e.type==="llm"&&e.purpose==="merge")).toBe(false);
 });
 test("committed SQLite admission with lost ACK never starts SDK or alternate Provider",async()=>{
  const f=await fixture(3),b=await backend(false),faulty:Db={select:f.db.select,execute:async(sql,args)=>{const result=await f.db.execute(sql,args);if(sql===GOAL_QUOTA_SQL.admit)throw Error("synthetic SQL ACK lost");return result;}};const meter=createGoalQuotaAuthority(faulty,()=>1000).meter(f.claim,execution),engine=createEngine({...b,goalMeter:meter,goalExecution:context});
  expect(await run(engine)).toMatchObject({status:"needs_user",quotaControl:{code:"quota_storage_unknown"}});expect(b.wire).toHaveLength(0);expect(await f.record()).toMatchObject({consumed:1,active:false,permits:[{state:"pending"}]});
 });
 test("local timeout includes cancellation race within admitted call, no refund or late fallback",async()=>{
  let late!:(response:ProxyResponse)=>void;const delivery=new Promise<ProxyResponse>(resolve=>{late=resolve;});
  const f=await fixture(3),b=await backend(false,()=>delivery),factory=providerFactory(b.backend,[],{},1000);const provider=await factory({provider:"ollama"});const model=new LocalJevBackend({id:"ollama/qwen3:8b",ask:async(system,user,signal)=>(await provider.chat({model:"qwen3:8b",messages:[{role:"system",content:system},{role:"user",content:user}],signal})).text},undefined,20,f.meter);
  await expect(model.classifyTask({text:"解释概念"})).rejects.toMatchObject({code:"quota_outcome_unknown"});expect(b.wire).toHaveLength(1);expect(await f.record()).toMatchObject({consumed:1,active:false,permits:[{state:"unknown"}]});
  late(chatReply(JSON.stringify({code:.1,reasoning:.1,tool_use:.1})));for(let i=0;i<8;i++)await Promise.resolve();
  expect(await f.record()).toMatchObject({consumed:1,active:false,permits:[{state:"unknown"}]});
  await expect(model.classifyTask({text:"解释概念"})).rejects.toMatchObject({code:"quota_storage_unknown"});expect(b.wire).toHaveLength(1);
 });
 test("fromEnv validates Goal even without Jev Key and local shares authority",async()=>{
  const f=await fixture(1),b=await backend(false),engine=createEngine({...b,goalMeter:f.meter,goalExecution:context});await run(engine);
  const provider=await providerFactory(b.backend,[],{},1000)({provider:"ollama"});const local={id:"ollama/qwen3:8b",ask:async(system:string,user:string,signal:AbortSignal)=>(await provider.chat({model:"qwen3:8b",messages:[{role:"system",content:system},{role:"user",content:user}],signal})).text};
  expect(()=>DecisionLayer.fromEnv({OPENAI_API_KEY:"synthetic"},{local,jev:{goalExecution:context}})).toThrow("quota_invalid_request");
  expect(()=>DecisionLayer.fromEnv({OPENAI_API_KEY:"synthetic"},{local,jev:{goalExecution:{...context,taskId:"task-other"},goalMeter:f.meter}})).toThrow("quota_invalid_request");
  const decision=DecisionLayer.fromEnv({OPENAI_API_KEY:"synthetic"},{local,jev:{goalExecution:context,goalMeter:f.meter}});
  await expect(decision.routeTask({text:"解释概念"})).rejects.toMatchObject({code:"quota_denied"});expect(b.wire.map(r=>r.target)).toEqual(["openai"]);expect((await f.record()).consumed).toBe(1);
 });
 test("Goal runtime defaults to captured task; foreign task stops before model or tool",async()=>{
  const f=await fixture(3),b=await backend(false);let invocationTask:string|undefined;
  const tool={name:"synthetic_read",description:"read synthetic",sideEffect:"none" as const,run:async(_args:unknown,ctx:any)=>{invocationTask=ctx.invocation.taskId;return{ok:true,content:"synthetic output"};}};
  const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context,tools:[tool]});
  const resumed={plan:{source:"llm" as const,steps:[{id:"s1",goal:"read",tool:tool.name,args:{}}]},records:[],nextStepIndex:0};
  // An accepted prior read reaches the real invocation ledger namespace before the next reflection/summary.
  await engine.runtime.run("解释概念",{route:lock,resume:resumed});expect(invocationTask).toBe(execution.taskId);
  const posts=b.wire.length;expect(await engine.runtime.run("你好",{taskId:"task-other",route:lock})).toMatchObject({quotaControl:{code:"quota_invalid_request"}});expect(b.wire).toHaveLength(posts);
  expect(await engine.runtime.run("你好",{taskId:"",route:lock})).toMatchObject({quotaControl:{code:"quota_invalid_request"}});expect(b.wire).toHaveLength(posts);
 });
 test("Coordinator retains accepted pure child summary after another child admission is refused",async()=>{
  const f=await fixture(2),b=await backend(false,r=>{const body=JSON.parse(r.body!);return body.messages?.[0]?.content?.includes(COORDINATOR_MARK)?chatReply(JSON.stringify({agents:[{role:"first",goal:"你好"},{role:"second",goal:"你好"},{role:"queued",goal:"你好"}]})):null;});const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context});
  const result=await engine.coordinator.run("解释概念",{taskId:execution.taskId,route:lock});expect(result).toMatchObject({status:"needs_user",quotaControl:{code:"quota_denied"}});
  const accepted=result.events.flatMap(e=>e.type==="subagent"&&e.event.type==="run_end"&&e.event.status==="completed"?[e.event.summary]:[]);expect(accepted).toHaveLength(1);expect(result.events.filter(e=>e.type==="subagent"&&e.event.type==="run_start").map(e=>e.type==="subagent"&&e.agent)).not.toContain("a3");expect(result.summary).toContain(accepted[0]);expect(b.wire).toHaveLength(2);expect((await f.record()).consumed).toBe(2);expect(result.events.some(e=>e.type==="llm"&&e.purpose==="merge")).toBe(false);
 });
 test("same owner/fence with stale execution binding is opaque denied before Provider dispatch",async()=>{
  const f=await fixture(3),b=await backend(false),engine=createEngine({...b,goalMeter:f.meter,goalExecution:context});
  const rows=await f.db.select<{rounds:string}[]>("SELECT rounds FROM goals WHERE id=$1",[identity.goalId]);const envelope=JSON.parse(rows[0].rounds);envelope.revision++;envelope.execution.execution_id="exec-next";await f.db.execute("UPDATE goals SET rounds=$1 WHERE id=$2",[JSON.stringify(envelope),identity.goalId]);
  const result=await run(engine);expect(result).toMatchObject({status:"needs_user",quotaControl:{code:"quota_denied"}});expect(result.summary).not.toMatch(/耗尽|超出预算/);expect((await f.record()).consumed).toBe(0);expect(b.wire).toHaveLength(0);
 });
 test("parallel Goal children have distinct persistent tool identities; same captured children resume without replay",async()=>{
  const f=await fixture(20),b=await backend(false,r=>{const body=JSON.parse(r.body!);const system=body.messages?.[0]?.content??"";return system.includes(COORDINATOR_MARK)?chatReply(JSON.stringify({agents:[{role:"first",goal:"执行相同写入"},{role:"second",goal:"执行相同写入"}]})):system.includes("任务规划器")?chatReply(JSON.stringify({steps:[{goal:"write synthetic output",tool:"synthetic_write",args:{tag:"fixed"}}]})):null;});
  Object.assign(b.backend,{getToolInvocation,saveToolInvocation,claimToolInvocation,renewToolInvocation,releaseToolInvocation});
  const identities:{taskId:string;key:string}[]=[];const tool={name:"synthetic_write",description:"write synthetic output",sideEffect:"local_write" as const,run:async(_args:unknown,ctx:any)=>{identities.push({taskId:ctx.invocation.taskId,key:ctx.invocation.idempotencyKey});return{ok:true,content:"write synthetic output completed"};}};
  const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context,tools:[tool],confirm:async()=>true});const first=await engine.coordinator.run("执行两个相同写入",{taskId:execution.taskId,route:lock});
  expect(identities).toHaveLength(2);expect(new Set(identities.map(i=>i.key)).size).toBe(2);expect(new Set(identities.map(i=>i.taskId))).toEqual(new Set(["task-alpha:child:a1","task-alpha:child:a2"]));expect(first.status).toBe("completed");expect(new Set(first.steps.map(s=>s.idempotencyKey)).size).toBe(2);
  const rows=await f.db.select<{task_id:string;invocation_id:string;state:string}[]>("SELECT task_id,invocation_id,state FROM tool_invocations ORDER BY task_id");expect(rows).toHaveLength(2);expect(rows.every(r=>r.task_id.length<=200&&r.invocation_id.length<=300&&r.state==="applied")).toBe(true);
  const second=await engine.coordinator.run("执行两个相同写入",{taskId:execution.taskId,route:lock});expect(second.status).toBe("completed");expect(identities).toHaveLength(2);expect(second.events.filter(e=>e.type==="subagent"&&e.event.type==="probe"&&e.event.state==="applied")).toHaveLength(2);expect((await f.record()).permits.every(p=>p.task_id===execution.taskId&&p.execution_id===execution.executionId)).toBe(true);
 });
 test("merge admission refusal retains both accepted child summaries without merge dispatch",async()=>{
  const f=await fixture(3),b=await backend(false,r=>{const body=JSON.parse(r.body!);return body.messages?.[0]?.content?.includes(COORDINATOR_MARK)?chatReply(JSON.stringify({agents:[{role:"first",goal:"你好"},{role:"second",goal:"你好"}]})):null;});const engine=createEngine({...b,goalMeter:f.meter,goalExecution:context});
  const result=await engine.coordinator.run("解释概念",{taskId:execution.taskId,route:lock});expect(result).toMatchObject({status:"needs_user",quotaControl:{code:"quota_denied"}});
  const accepted=result.events.flatMap(e=>e.type==="subagent"&&e.event.type==="run_end"&&e.event.status==="completed"?[e.event.summary]:[]);expect(accepted).toHaveLength(2);for(const text of accepted)expect(result.summary).toContain(text);expect(result.summary).toContain("【first】");expect(result.summary).toContain("【second】");expect(b.wire).toHaveLength(3);expect((await f.record()).consumed).toBe(3);expect((await f.record()).permits.map(p=>p.purpose)).toEqual(["split","answer","answer"]);
 });
});
