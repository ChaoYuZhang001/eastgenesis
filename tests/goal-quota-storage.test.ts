import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Db } from "@/lib/db";
import { GOAL_QUOTA_SQL, createGoalQuotaAuthority, encodeNewGoalEnvelope } from "@/lib/db-goal-quota";
import { GoalQuotaControlError, type GoalQuotaCall, type GoalQuotaRecord } from "@/core/goal-quota";
import { asDb, loadSqlite, placeholdersAscend, readMigrations, type RawDb, type SqliteModule } from "./sqlite-helper";
let sqlite: SqliteModule;
const owned:{dir:string;raws:RawDb[]}[]=[];
beforeAll(async()=>{const mod=await loadSqlite();expect(mod,"Actual SQLite runtime required; no skipped storage proof").not.toBeNull();sqlite=mod!;});
afterEach(()=>{for(const f of owned.splice(0)){for(const raw of f.raws)(raw as RawDb & {close():void}).close();rmSync(f.dir,{recursive:true,force:true});}});
const ident={goalId:"goal-alpha",enrollmentId:"enroll-alpha"};
const call=(n:number, kind:GoalQuotaCall["kind"]="main",purpose:GoalQuotaCall["purpose"]="answer"):GoalQuotaCall=>({permitId:`permit-${n}`,kind,purpose});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"eg-quota-synthetic-"));const resource={dir,raws:[] as RawDb[]};owned.push(resource);const path=join(dir,"synthetic.sqlite");
 const raw=new sqlite.DatabaseSync(path);resource.raws.push(raw);raw.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");for(const m of readMigrations())raw.exec(m.sql);
 const raw2=new sqlite.DatabaseSync(path);resource.raws.push(raw2);raw2.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
 const db=asDb(()=>raw),db2=asDb(()=>raw2);let now=1000;const clock=()=>now;
 const authority=createGoalQuotaAuthority(db,clock),second=createGoalQuotaAuthority(db2,clock);
 const boundEnvelope=()=>JSON.stringify({...JSON.parse(encodeNewGoalEnvelope(ident,[])),revision:0,execution:{owner_id:"owner-alpha",fence:1,task_id:"task-alpha",execution_id:"exec-alpha"}});
 const row=(rounds=boundEnvelope(),deleted:null|string=null,status="running")=>db.execute("INSERT INTO goals (id,description,max_llm_calls,used_llm_calls,status,rounds,created_at,updated_at,deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",[ident.goalId,"synthetic quota",5,0,status,rounds,1000,1000,deleted]);
 const enroll=async(limit=3)=>{await authority.prepareNew({...ident,limit});await row();return authority.claim({...ident,ownerId:"owner-alpha",expectedFence:0,leaseMs:1000});};
 const record=async()=>authority.snapshot(ident);
 const overwrite=async(v:unknown)=>db.execute("UPDATE app_meta SET value=$1 WHERE key=$2",[typeof v==="string"?v:JSON.stringify(v),`goal-quota:v1:${ident.goalId}`]);
 return {path,raw,raw2,db,db2,authority,second,row,enroll,record,overwrite,clock,setNow:(n:number)=>{now=n;}};
}
async function denied(p:Promise<unknown>,code="quota_denied"){await expect(p).rejects.toMatchObject({name:"GoalQuotaControlError",code,message:code});}
const execution={taskId:"task-alpha",executionId:"exec-alpha"};
const gate=()=>{let resolve!:(v:string)=>void;const promise=new Promise<string>(r=>{resolve=r;});return{promise,resolve};};

describe("actual SQLite inclusive Goal authority foundation",()=>{
 test("SQL placeholders follow the production plugin positional binding contract",()=>{for(const sql of Object.values(GOAL_QUOTA_SQL))expect(placeholdersAscend(sql)).toBe(true);});
 test("normal known outcomes occupy inclusive cap, settle and permit successive steps",async()=>{
  const f=fixture(),claim=await f.enroll(2),m=f.authority.meter(claim,execution);let dispatched=0;
  expect(await m.invoke(call(1),async()=>{dispatched++;return"main";})).toBe("main");
  expect(await m.invoke(call(2,"cloud_decision","decision"),async()=>{dispatched++;return"jev";})).toBe("jev");
  await denied(m.invoke(call(3),async()=>{dispatched++;return"forbidden";}));
  expect(dispatched).toBe(2);const record=await f.record();expect(record.consumed).toBe(2);expect(record.permits.map(p=>p.state)).toEqual(["succeeded","succeeded"]);expect(record.active).toBe(true);
 });
 test("two independent SQLite connections competing for final slot dispatch only one callback",async()=>{
  const f=fixture(),claim=await f.enroll(1);let dispatched=0;const run=(n:number,a=f.authority)=>a.meter(claim,execution).invoke(call(n),async()=>{dispatched++;return n;});
  const out=await Promise.allSettled([run(1),run(2,f.second)]);expect(out.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(dispatched).toBe(1);expect((await f.record()).consumed).toBe(1);
 });
 test("prepare does not replace or enroll existing legacy Goal, including deleted rows",async()=>{
  for(const deleted of [null,"2026-10-07"]){const f=fixture();await f.row("[]",deleted);await denied(f.authority.prepareNew({...ident,limit:3}));expect(await f.db.select("SELECT * FROM app_meta WHERE key=$1",[`goal-quota:v1:${ident.goalId}`])).toEqual([]);}
 });
 test("orphan prepared quota cannot claim; repeated prepare does not recreate balance",async()=>{
  const f=fixture();await f.authority.prepareNew({...ident,limit:2});await denied(f.authority.prepareNew({...ident,limit:5}));await denied(f.authority.claim({...ident,ownerId:"owner-alpha",expectedFence:0,leaseMs:1000}));expect((await f.record()).limit).toBe(2);
 });
 test("missing canonical quota never creates an unmetered scope on dispatch",async()=>{
  const f=fixture();await f.row();const m=f.authority.meter({...ident,ownerId:"owner-alpha",fence:1},execution);let count=0;await denied(m.invoke(call(1),async()=>++count));expect(count).toBe(0);
 });
 test("repeat permit ID and changed purpose cannot authorize replay",async()=>{
  const f=fixture(),m=f.authority.meter(await f.enroll(3),execution);let n=0;await m.invoke(call(1),async()=>++n);await denied(m.invoke(call(1,"cloud_decision","route"),async()=>++n));expect(n).toBe(1);expect((await f.record()).consumed).toBe(1);
 });
 test("two pending calls under current owner are allowed, takeover is blocked until terminal",async()=>{
  const f=fixture(),claim=await f.enroll(3),m=f.authority.meter(claim,execution),a=gate(),b=gate();
  const p=m.invoke(call(1),()=>a.promise),q=m.invoke(call(2,"goal_verifier","check_done"),()=>b.promise);await Promise.resolve();await Promise.resolve();expect((await f.record()).permits.map(p=>p.state)).toEqual(["pending","pending"]);
  f.setNow(2100);await denied(f.second.claim({...ident,ownerId:"owner-beta",expectedFence:1,leaseMs:1000}));a.resolve("one");b.resolve("two");await Promise.all([p,q]);
  const takeover=await f.second.claim({...ident,ownerId:"owner-beta",expectedFence:1,leaseMs:1000});expect(takeover.fence).toBe(2);expect((await f.record()).consumed).toBe(2);await denied(m.invoke(call(3),async()=>"stale"));
 });
 test("remote unknown pauses authority and blocks takeover without refund or automatic replay",async()=>{
  const f=fixture(),claim=await f.enroll(3),m=f.authority.meter(claim,execution);let count=0;
  await denied(m.invoke(call(1),async()=>{count++;throw Error("synthetic remote timeout");}),"quota_outcome_unknown");
  const r=await f.record();expect(r.consumed).toBe(1);expect(r.permits[0].state).toBe("unknown");expect(r.active).toBe(false);expect(r.fence).toBe(2);
  f.setNow(4000);await denied(f.second.claim({...ident,ownerId:"owner-beta",expectedFence:2,leaseMs:1000}));await denied(m.invoke(call(2),async()=>++count),"quota_storage_unknown");expect(count).toBe(1);
 });
 test("positively classified terminal failure settles failed, retains spent slot, permits next step",async()=>{
  const f=fixture(),m=f.authority.meter(await f.enroll(2),execution),failure=Error("synthetic terminal rejection");
  await expect(m.invoke(call(1),async()=>{throw failure;},{classifyFailure:()=>"failed"})).rejects.toBe(failure);
  expect(await m.invoke(call(2,"local_decision","decision"),async()=>"local")).toBe("local");const r=await f.record();expect(r.consumed).toBe(2);expect(r.permits.map(p=>p.state)).toEqual(["failed","succeeded"]);
 });
 test("throwing failure classifier conservatively becomes unknown",async()=>{
  const f=fixture(),m=f.authority.meter(await f.enroll(2),execution);await denied(m.invoke(call(1),async()=>{throw Error("synthetic");},{classifyFailure:()=>{throw Error("classifier");}}),"quota_outcome_unknown");expect((await f.record()).permits[0].state).toBe("unknown");
 });
 test("committed admission with lost ACK does not dispatch or refund; reopening cannot reuse permit",async()=>{
  const f=fixture(),claim=await f.enroll(2);let lost=false;const faulty:Db={select:f.db.select,execute:async(sql,args)=>{const r=await f.db.execute(sql,args);if(sql===GOAL_QUOTA_SQL.admit&&!lost){lost=true;throw Error("synthetic ACK path secret ignored");}return r;}};
  let n=0;const m=createGoalQuotaAuthority(faulty,f.clock).meter(claim,execution);await denied(m.invoke(call(1),async()=>++n),"quota_storage_unknown");expect(n).toBe(0);const r=await f.second.snapshot(ident);expect(r.consumed).toBe(1);expect(r.permits[0].state).toBe("pending");expect(r.active).toBe(false);
  await denied(f.second.claim({...ident,ownerId:"owner-beta",expectedFence:r.fence,leaseMs:1000}));await denied(f.second.meter(claim,execution).invoke(call(1),async()=>++n));expect(n).toBe(0);
 });
 test.each([undefined,null,"1",true,1n,2,NaN,{rowsAffected:"1"},{rowsAffected:true},{rowsAffected:1n},{rowsAffected:2},[]])("non-numeric-one ACK cannot authorize dispatch (%s)",async bad=>{
  const f=fixture(),claim=await f.enroll(2);const faulty:Db={select:f.db.select,execute:async(sql,args)=>{const r=await f.db.execute(sql,args);return sql===GOAL_QUOTA_SQL.admit?bad:r;}};let n=0;await denied(createGoalQuotaAuthority(faulty,f.clock).meter(claim,execution).invoke(call(1),async()=>++n),"quota_storage_unknown");expect(n).toBe(0);expect((await f.record()).consumed).toBe(1);
 });
 test("settlement committed but ACK lost preserves observed result and conservatively pauses",async()=>{
  const f=fixture(),claim=await f.enroll(2);const faulty:Db={select:f.db.select,execute:async(sql,args)=>{const r=await f.db.execute(sql,args);if(sql===GOAL_QUOTA_SQL.settle)throw Error("synthetic settle ACK lost");return r;}};let n=0;
  await denied(createGoalQuotaAuthority(faulty,f.clock).meter(claim,execution).invoke(call(1),async()=>++n),"quota_storage_unknown");const r=await f.record();expect(n).toBe(1);expect(r.permits[0].state).toBe("succeeded");expect(r.active).toBe(false);expect(r.consumed).toBe(1);
 });
 test("pause fences admission; late terminal only settles own pending result without reenabling",async()=>{
  const f=fixture(),claim=await f.enroll(3),m=f.authority.meter(claim,execution),g=gate();const p=m.invoke(call(1),()=>g.promise);await Promise.resolve();await Promise.resolve();await f.authority.pause(claim);await denied(m.invoke(call(2),async()=>"blocked"));g.resolve("late");expect(await p).toBe("late");const r=await f.record();expect(r.active).toBe(false);expect(r.consumed).toBe(1);expect(r.permits[0].state).toBe("succeeded");
 });
 test("deleted, paused, foreign protocol and missing envelope refuse admission through Goal predicate",async()=>{
  const mutators=["UPDATE goals SET deleted_at='synthetic-deleted'", "UPDATE goals SET status='paused'", "UPDATE goals SET rounds='[]'",`UPDATE goals SET rounds='{"protocol":"foreign","goal_id":"goal-alpha","enrollment_id":"enroll-alpha","rounds":[]}'`];
  for(const sql of mutators){const f=fixture(),claim=await f.enroll(2);await f.db.execute(sql);let n=0;await denied(f.authority.meter(claim,execution).invoke(call(1),async()=>++n));expect(n).toBe(0);expect((await f.record()).consumed).toBe(0);}
 });
 test("renew requires current owner and live lease; takeover retains prior quota",async()=>{
  const f=fixture(),c=await f.enroll(2);await f.authority.meter(c,execution).invoke(call(1),async()=>"ok");await f.authority.renew(c,500);f.setNow(1600);await denied(f.authority.renew(c,1000));const next=await f.second.claim({...ident,ownerId:"owner-beta",expectedFence:1,leaseMs:1000});expect(next.fence).toBe(2);expect((await f.record()).consumed).toBe(1);await denied(f.authority.renew(c,1000));
 });
 test("malformed JSON and non-integer/corrupt canonical state fail closed without dispatch",async()=>{
  const corrupt:((r:GoalQuotaRecord)=>unknown)[]=[()=>"{bad",r=>({...r,consumed:"0"}),r=>({...r,consumed:0.5}),r=>({...r,limit:501}),r=>({...r,fence:1.5}),r=>({...r,lease_until:Number.MAX_SAFE_INTEGER+1}),r=>({...r,permits:[null],consumed:1}),r=>({...r,permits:["not-json"],consumed:1}),r=>({...r,extra:"unapproved"}),r=>({...r,enrollment_id:"enroll-foreign"}),r=>({...r,consumed:1})];
  for(const mutation of corrupt){const f=fixture(),claim=await f.enroll(2),r=await f.record();await f.overwrite(mutation(r));let n=0;await denied(f.authority.meter(claim,execution).invoke(call(1),async()=>++n));expect(n).toBe(0);}
 });
 test("immutable execution identities and enum purpose validated before any SQL mutation",async()=>{
  const f=fixture(),claim=await f.enroll(2);expect(()=>f.authority.meter(claim,{...execution,executionId:"secret/path"})).toThrow(GoalQuotaControlError);
  const m=f.authority.meter(claim,execution);await denied(m.invoke({...call(1),purpose:"foreign" as GoalQuotaCall["purpose"]},async()=>"no"),"quota_invalid_request");expect((await f.record()).consumed).toBe(0);
 });
 test("actual storage failure remains fixed control error and no callback",async()=>{
  const f=fixture(),claim=await f.enroll(2);f.raw.exec("DROP TABLE app_meta");let n=0;await denied(f.authority.meter(claim,execution).invoke(call(1),async()=>++n),"quota_storage_unknown");expect(n).toBe(0);
 });
 test("snapshot is read-only evidence and cannot authorize pending replay after process boundary",async()=>{
  const f=fixture(),claim=await f.enroll(2);await f.db.execute(GOAL_QUOTA_SQL.admit,[`goal-quota:v1:${ident.goalId}`,ident.goalId,ident.enrollmentId,claim.ownerId,claim.fence,1000,"permit-1",execution.taskId,execution.executionId,"main","answer"]);
  const loaded=await f.second.snapshot(ident);expect(loaded.permits[0].state).toBe("pending");f.setNow(4000);await denied(f.second.claim({...ident,ownerId:"owner-beta",expectedFence:1,leaseMs:1000}));let n=0;await denied(f.second.meter(claim,execution).invoke(call(1),async()=>++n));expect(n).toBe(0);expect((await f.record()).consumed).toBe(1);
 });
 test.each([false,true])("fresh child exit %s before settlement preserves pending and denies new process takeover",async observed=>{
  const f=fixture(),claim=await f.enroll(2);
  const child=`const{DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));const db=new DatabaseSync(x.path);const bind=Object.fromEntries(x.args.map((v,i)=>['$'+(i+1),v]));const r=db.prepare(x.sql).run(bind);if(x.observed&&r.changes===1)process.stdout.write('synthetic_callback_observed');process.exit(0);`;
  const args=[`goal-quota:v1:${ident.goalId}`,ident.goalId,ident.enrollmentId,claim.ownerId,claim.fence,1000,"permit-1",execution.taskId,execution.executionId,"main","answer"];
  const exit=spawnSync(process.execPath,["-e",child],{input:JSON.stringify({path:f.path,sql:GOAL_QUOTA_SQL.admit,args,observed}),encoding:"utf8",timeout:5000,maxBuffer:16384});expect(exit.status).toBe(0);expect(exit.stdout).toBe(observed?"synthetic_callback_observed":"");
  const reopened=await f.second.snapshot(ident);expect(reopened.consumed).toBe(1);expect(reopened.permits[0].state).toBe("pending");
  const takeover=[`goal-quota:v1:${ident.goalId}`,ident.goalId,ident.enrollmentId,"owner-beta",1,4000,5000];
  const next=spawnSync(process.execPath,["-e",`const{DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));const db=new DatabaseSync(x.path);process.stdout.write(String(db.prepare(x.sql).run(Object.fromEntries(x.args.map((v,i)=>['$'+(i+1),v]))).changes));`],{input:JSON.stringify({path:f.path,sql:GOAL_QUOTA_SQL.claim,args:takeover}),encoding:"utf8",timeout:5000,maxBuffer:16384});expect(next.status).toBe(0);expect(next.stdout).toBe("0");expect((await f.record()).consumed).toBe(1);
 });

 test("caller mutation cannot settle another concurrent permit identity",async()=>{
  const f=fixture(),claim=await f.enroll(3),m=f.authority.meter(claim,execution);
  await f.db.execute(GOAL_QUOTA_SQL.admit,[`goal-quota:v1:${ident.goalId}`,ident.goalId,ident.enrollmentId,claim.ownerId,claim.fence,1000,"permit-2",execution.taskId,execution.executionId,"main","answer"]);
  const input={...call(1)};expect(await m.invoke(input,async()=>{input.permitId="permit-2";input.kind="local_decision";input.purpose="decision";return"original-result";})).toBe("original-result");
  const r=await f.record();expect(r.consumed).toBe(2);expect(r.permits.find(p=>p.id==="permit-1")?.state).toBe("succeeded");expect(r.permits.find(p=>p.id==="permit-2")?.state).toBe("pending");expect(r.permits.find(p=>p.id==="permit-1")?.kind).toBe("main");expect(r.permits.find(p=>p.id==="permit-1")?.purpose).toBe("answer");
 });

});
