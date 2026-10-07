import {beforeAll,describe,expect,test} from "vitest";
import {createGoalQuotaAuthority,encodeNewGoalEnvelope} from "@/lib/db-goal-quota";
import {asDb,loadSqlite,migratedDb,type SqliteModule} from "./sqlite-helper";
let sqlite:SqliteModule;beforeAll(async()=>{const s=await loadSqlite();expect(s).not.toBeNull();sqlite=s!;});
async function fixture(){const raw=migratedDb(sqlite),db=asDb(()=>raw),authority=createGoalQuotaAuthority(db,()=>1000),identity={goalId:"goal-alpha",enrollmentId:"enroll-alpha"};await authority.prepareNew({...identity,limit:3});const envelope={...JSON.parse(encodeNewGoalEnvelope(identity,[])),revision:0,execution:{owner_id:"owner-alpha",fence:1,task_id:"task-alpha",execution_id:"exec-alpha"}};await db.execute("INSERT INTO goals(id,description,status,rounds,max_llm_calls,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7)",[identity.goalId,"synthetic","running",JSON.stringify(envelope),3,1000,1000]);const claim=await authority.claim({...identity,ownerId:"owner-alpha",expectedFence:0,leaseMs:1000});return{db,authority,envelope,claim,identity};}
describe("actual SQLite current Goal execution admission policy",()=>{
 test("current exact task/execution callback remains usable",async()=>{const f=await fixture();let n=0;await f.authority.meter(f.claim,{taskId:"task-alpha",executionId:"exec-alpha"}).invoke({permitId:"permit-a",kind:"main",purpose:"answer"},async()=>++n);expect(n).toBe(1);});
 test("old execution A cannot dispatch after current Goal envelope is B even under retained owner/fence",async()=>{
  const f=await fixture(),old=f.authority.meter(f.claim,{taskId:"task-alpha",executionId:"exec-alpha"});f.envelope.execution.task_id="task-beta";f.envelope.execution.execution_id="exec-beta";f.envelope.revision=1;await f.db.execute("UPDATE goals SET rounds=$1 WHERE id=$2",[JSON.stringify(f.envelope),f.identity.goalId]);let n=0;const result=await old.invoke({permitId:"permit-old",kind:"main",purpose:"answer"},async()=>++n).then(()=>"dispatched",e=>e.code);expect(n).toBe(0);expect(result).toBe("quota_denied");expect((await f.authority.snapshot(f.identity)).consumed).toBe(0);
 });
 test.each(["missing_execution","extra_execution_key","float_fence","wrong_owner","wrong_fence","wrong_task","wrong_exec","missing_revision","float_revision","negative_revision","extra_root_key","scalar_execution"])("invalid current Goal binding %s does not consume or dispatch",async mode=>{
  const f=await fixture();const body:Record<string,unknown>={...f.envelope,execution:{...f.envelope.execution}};const execution=body.execution as Record<string,unknown>;
  if(mode==="missing_execution")delete body.execution;
  if(mode==="extra_execution_key")execution.extra="foreign";
  if(mode==="wrong_owner")execution.owner_id="owner-beta";
  if(mode==="wrong_fence")execution.fence=2;
  if(mode==="wrong_task")execution.task_id="task-beta";
  if(mode==="wrong_exec")execution.execution_id="exec-beta";
  if(mode==="missing_revision")delete body.revision;
  if(mode==="negative_revision")body.revision=-1;
  if(mode==="extra_root_key")body.extra="foreign";
  if(mode==="scalar_execution")body.execution="invalid";
  let encoded=JSON.stringify(body);if(mode==="float_fence")encoded=encoded.replace('"fence":1','"fence":1.0');if(mode==="float_revision")encoded=encoded.replace('"revision":0','"revision":0.0');
  await f.db.execute("UPDATE goals SET rounds=$1 WHERE id=$2",[encoded,f.identity.goalId]);let n=0;await expect(f.authority.meter(f.claim,{taskId:"task-alpha",executionId:"exec-alpha"}).invoke({permitId:"permit-shape",kind:"main",purpose:"answer"},async()=>++n)).rejects.toMatchObject({code:"quota_denied"});expect(n).toBe(0);expect((await f.authority.snapshot(f.identity)).consumed).toBe(0);
 });

});
