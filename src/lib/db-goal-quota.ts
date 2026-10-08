import type { Db } from "./db";
import { GOAL_QUOTA_PROTOCOL as P, GOAL_QUOTA_MAX_LIMIT as MAX, GOAL_QUOTA_MAX_FENCE as FMAX, GOAL_QUOTA_KINDS, GOAL_QUOTA_PURPOSES, GoalQuotaControlError, type GoalQuotaIdentity, type GoalQuotaClaim, type GoalQuotaExecution, type GoalQuotaCall, type GoalQuotaRecord, type GoalMeterScope, type GoalQuotaFailurePolicy } from "../core/goal-quota";

const SAFE = Number.MAX_SAFE_INTEGER;
const key = (goal: string) => `goal-quota:v1:${goal}`;
const err = (code: ConstructorParameters<typeof GoalQuotaControlError>[0]): never => { throw new GoalQuotaControlError(code); };
const id = (v: string, prefix: string) => typeof v === "string" && new RegExp(`^${prefix}-[a-z0-9][a-z0-9-]{0,63}$`).test(v);
function identity(v: GoalQuotaIdentity) { if (!id(v.goalId, "goal") || !id(v.enrollmentId, "enroll")) err("quota_invalid_request"); }
function integer(v: number, min = 0, max = SAFE) { if (!Number.isSafeInteger(v) || v < min || v > max) err("quota_invalid_request"); }
function claimValid(v: GoalQuotaClaim) { identity(v); if (!id(v.ownerId, "owner")) err("quota_invalid_request"); integer(v.fence, 1, FMAX); }
function executionValid(v: GoalQuotaExecution) { if (!id(v.taskId, "task") || !id(v.executionId, "exec")) err("quota_invalid_request"); }
function callValid(v: GoalQuotaCall) { if (!id(v.permitId, "permit") || !GOAL_QUOTA_KINDS.includes(v.kind) || !GOAL_QUOTA_PURPOSES.includes(v.purpose)) err("quota_invalid_request"); }
function ack(v: unknown): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) err("quota_storage_unknown");
  let n: unknown; try { n = (v as { rowsAffected?: unknown }).rowsAffected; } catch { err("quota_storage_unknown"); }
  if (n === 0) err("quota_denied");
  if (typeof n !== "number" || n !== 1) err("quota_storage_unknown");
}
const quoted = (v: readonly string[]) => v.map(x => `'${x}'`).join(",");
const j = (v: string, k: string) => `json_extract(${v}, '$.${k}')`;
const t = (v: string, k: string) => `json_type(${v}, '$.${k}')`;
const sid = (v: string, prefix: string) => `typeof(${v})='text' AND length(${v}) BETWEEN ${prefix.length + 2} AND ${prefix.length + 65} AND ${v} GLOB '${prefix}-[a-z0-9]*' AND ${v} NOT GLOB '*[^a-z0-9-]*'`;
const num = (v: string, k: string, min: number, max: number) => `${t(v,k)}='integer' AND ${j(v,k)} BETWEEN ${min} AND ${max}`;
const keys = (v: string, names: readonly string[]) => `(SELECT count(*)=${names.length} AND count(DISTINCT key)=${names.length} AND min(key IN (${quoted(names)}))=1 FROM json_each(${v}))`;
const pfields = ["id","task_id","execution_id","owner","fence","kind","purpose","state","admitted_at","finished_at"];
const rfields = ["protocol","goal_id","enrollment_id","state","limit","consumed","owner","fence","active","lease_until","permits"];
const pv = "p.value", rv = "app_meta.value";
// CASE guards malformed JSON and non-object entries before any JSON-path access.
const valid = `CASE WHEN json_valid(${rv})=1 THEN CASE WHEN json_type(${rv})='object' THEN CASE WHEN
 ${keys(rv,rfields)} AND ${j(rv,"protocol")}='${P}'
 AND ${sid(j(rv,"goal_id"),"goal")} AND ${sid(j(rv,"enrollment_id"),"enroll")}
 AND ${j(rv,"state")} IN ('prepared','enrolled') AND ${num(rv,"limit",1,MAX)} AND ${num(rv,"consumed",0,MAX)}
 AND ${j(rv,"consumed")}<=${j(rv,"limit")} AND ${num(rv,"fence",0,FMAX)} AND ${num(rv,"lease_until",0,SAFE)}
 AND ${t(rv,"active")} IN ('true','false') AND (${t(rv,"owner")}='null' OR (${sid(j(rv,"owner"),"owner")}))
 AND (${j(rv,"active")}=0 OR (${j(rv,"state")}='enrolled' AND ${t(rv,"owner")}='text' AND ${j(rv,"fence")}>0))
 AND ${t(rv,"permits")}='array' AND json_array_length(${rv},'$.permits')=${j(rv,"consumed")}
 AND (${j(rv,"state")}='enrolled' OR (${j(rv,"consumed")}=0 AND ${j(rv,"fence")}=0 AND ${j(rv,"active")}=0 AND ${t(rv,"owner")}='null' AND ${j(rv,"lease_until")}=0))
 AND NOT EXISTS (SELECT 1 FROM json_each(${rv},'$.permits') p WHERE CASE WHEN p.type='object' THEN CASE WHEN
 ${keys(pv,pfields)} AND ${sid(j(pv,"id"),"permit")} AND ${sid(j(pv,"task_id"),"task")} AND ${sid(j(pv,"execution_id"),"exec")} AND ${sid(j(pv,"owner"),"owner")}
 AND ${num(pv,"fence",1,FMAX)} AND ${j(pv,"fence")}<=${j(rv,"fence")}
 AND ${j(pv,"kind")} IN (${quoted(GOAL_QUOTA_KINDS)}) AND ${j(pv,"purpose")} IN (${quoted(GOAL_QUOTA_PURPOSES)})
 AND ${j(pv,"state")} IN ('pending','succeeded','failed','unknown') AND ${num(pv,"admitted_at",0,SAFE)}
 AND ((${j(pv,"state")}='pending' AND ${t(pv,"finished_at")}='null') OR (${j(pv,"state")}!='pending' AND ${num(pv,"finished_at",0,SAFE)}))
 THEN 1 ELSE 0 END ELSE 0 END=0)
 AND (SELECT count(*)=count(DISTINCT CASE WHEN type='object' THEN json_extract(value,'$.id') ELSE NULL END) FROM json_each(${rv},'$.permits'))
 THEN 1 ELSE 0 END ELSE 0 END ELSE 0 END=1`;
const same = `${j(rv,"goal_id")}=(SELECT goal_id FROM input) AND ${j(rv,"enrollment_id")}=(SELECT enrollment_id FROM input)`;
const goal = `EXISTS (SELECT 1 FROM goals g WHERE g.id=(SELECT goal_id FROM input) AND g.deleted_at IS NULL AND g.status='running' AND CASE WHEN json_valid(g.rounds)=1 THEN CASE WHEN json_type(g.rounds)='object' THEN CASE WHEN json_extract(g.rounds,'$.protocol')='${P}' AND json_extract(g.rounds,'$.goal_id')=g.id AND json_extract(g.rounds,'$.enrollment_id')=(SELECT enrollment_id FROM input) AND json_type(g.rounds,'$.rounds')='array' THEN 1 ELSE 0 END ELSE 0 END ELSE 0 END=1)`;
// Admission binds the current persisted Goal execution, including its exact versioned shape.
const currentExecution = `CASE WHEN json_type(g.rounds,'$.execution')='object' THEN CASE WHEN
 ${keys("json_extract(g.rounds,'$.execution')",['owner_id','fence','task_id','execution_id'])} AND json_type(g.rounds,'$.execution.fence')='integer'
 AND json_extract(g.rounds,'$.execution.owner_id')=(SELECT owner FROM input)
 AND json_extract(g.rounds,'$.execution.fence')=(SELECT fence FROM input)
 AND json_extract(g.rounds,'$.execution.task_id')=(SELECT task_id FROM input)
 AND json_extract(g.rounds,'$.execution.execution_id')=(SELECT execution_id FROM input)
 THEN 1 ELSE 0 END ELSE 0 END=1`;
const executionGoal = `${goal} AND EXISTS (SELECT 1 FROM goals g WHERE g.id=(SELECT goal_id FROM input) AND CASE WHEN json_valid(g.rounds)=1 THEN CASE WHEN json_type(g.rounds)='object' THEN CASE WHEN
 ${keys('g.rounds',['protocol','goal_id','enrollment_id','revision','rounds','execution'])} AND ${num('g.rounds','revision',0,SAFE)} AND (${currentExecution})
 THEN 1 ELSE 0 END ELSE 0 END ELSE 0 END=1)`;
const owned = `${j(rv,"state")}='enrolled' AND ${j(rv,"active")}=1 AND ${j(rv,"owner")}=(SELECT owner FROM input) AND ${j(rv,"fence")}=(SELECT fence FROM input)`;
const pending = `(SELECT 1 FROM json_each(${rv},'$.permits') WHERE json_extract(value,'$.state') IN ('pending','unknown'))`;
const unknown = `(SELECT 1 FROM json_each(${rv},'$.permits') WHERE json_extract(value,'$.state')='unknown')`;
const cte = (fields: string[]) => `WITH input AS (SELECT ${fields.map((f,i)=>`$${i+1} AS ${f}`).join(",")})`;
const base = ["key","goal_id","enrollment_id","owner","fence","now"];
const where = `app_meta.key=(SELECT key FROM input) AND CASE WHEN (${valid}) THEN (${same})`;
const permit = `(SELECT p.key FROM json_each(${rv},'$.permits') p WHERE json_extract(p.value,'$.id')=(SELECT permit_id FROM input) AND json_extract(p.value,'$.task_id')=(SELECT task_id FROM input) AND json_extract(p.value,'$.execution_id')=(SELECT execution_id FROM input) AND json_extract(p.value,'$.owner')=(SELECT owner FROM input) AND json_extract(p.value,'$.fence')=(SELECT fence FROM input) AND json_extract(p.value,'$.state')='pending')`;
const path = (field: string) => `'$.permits[' || ${permit} || '].${field}'`;
export const GOAL_QUOTA_SQL = Object.freeze({
 prepare: `${cte(["key","record","goal_id"])} INSERT INTO app_meta(key,value) SELECT key,record FROM input WHERE NOT EXISTS (SELECT 1 FROM goals WHERE id=input.goal_id) ON CONFLICT(key) DO NOTHING`,
 claim: `${cte([...base,"lease_until"])} UPDATE app_meta SET value=json_set(value,'$.state','enrolled','$.owner',(SELECT owner FROM input),'$.fence',json_extract(value,'$.fence')+1,'$.active',json('true'),'$.lease_until',CAST((SELECT lease_until FROM input) AS INTEGER)) WHERE ${where} AND ${goal} AND json_extract(value,'$.fence')=(SELECT fence FROM input) AND json_extract(value,'$.fence')<${FMAX} AND (json_extract(value,'$.active')=0 OR json_extract(value,'$.lease_until')<=(SELECT now FROM input)) AND NOT EXISTS ${pending} ELSE 0 END=1`,
 renew: `${cte([...base,"lease_until"])} UPDATE app_meta SET value=json_set(value,'$.lease_until',CAST((SELECT lease_until FROM input) AS INTEGER)) WHERE ${where} AND ${goal} AND ${owned} AND json_extract(value,'$.lease_until')>(SELECT now FROM input) ELSE 0 END=1`,
 pause: `${cte(base)} UPDATE app_meta SET value=json_set(value,'$.active',json('false'),'$.owner',NULL,'$.lease_until',0,'$.fence',json_extract(value,'$.fence')+1) WHERE ${where} AND ${owned} AND json_extract(value,'$.fence')<${FMAX} ELSE 0 END=1`,
 admit: `${cte([...base,"permit_id","task_id","execution_id","kind","purpose"])} UPDATE app_meta SET value=json_set(value,'$.consumed',json_extract(value,'$.consumed')+1,'$.permits[#]',json_object('id',(SELECT permit_id FROM input),'task_id',(SELECT task_id FROM input),'execution_id',(SELECT execution_id FROM input),'owner',(SELECT owner FROM input),'fence',CAST((SELECT fence FROM input) AS INTEGER),'kind',(SELECT kind FROM input),'purpose',(SELECT purpose FROM input),'state','pending','admitted_at',CAST((SELECT now FROM input) AS INTEGER),'finished_at',NULL)) WHERE ${where} AND ${executionGoal} AND ${owned} AND json_extract(value,'$.lease_until')>(SELECT now FROM input) AND json_extract(value,'$.consumed')<json_extract(value,'$.limit') AND NOT EXISTS ${unknown} AND NOT EXISTS (SELECT 1 FROM json_each(app_meta.value,'$.permits') duplicate WHERE json_extract(duplicate.value,'$.id')=(SELECT permit_id FROM input)) ELSE 0 END=1`,
 settle: `${cte([...base,"permit_id","task_id","execution_id","outcome"])} UPDATE app_meta SET value=json_set(value,${path("state")},(SELECT outcome FROM input),${path("finished_at")},CAST((SELECT now FROM input) AS INTEGER)) WHERE ${where} AND (SELECT outcome FROM input) IN ('succeeded','failed') AND ${permit} IS NOT NULL ELSE 0 END=1`,
 unknown: `${cte([...base,"permit_id","task_id","execution_id"])} UPDATE app_meta SET value=json_set(value,${path("state")},'unknown',${path("finished_at")},CAST((SELECT now FROM input) AS INTEGER),'$.active',json('false'),'$.owner',NULL,'$.lease_until',0,'$.fence',CASE WHEN ${owned} AND json_extract(value,'$.fence')<${FMAX} THEN json_extract(value,'$.fence')+1 ELSE json_extract(value,'$.fence') END) WHERE ${where} AND ${permit} IS NOT NULL ELSE 0 END=1`,
 snapshot: `${cte(["key","goal_id","enrollment_id"])} SELECT value FROM app_meta WHERE ${where} ELSE 0 END=1`,
});

export function encodeNewGoalEnvelope(v: GoalQuotaIdentity, rounds: readonly unknown[]): string {
 identity(v); if (!Array.isArray(rounds)) err("quota_invalid_request");
 return JSON.stringify({ protocol:P, goal_id:v.goalId, enrollment_id:v.enrollmentId, rounds });
}
export function createGoalQuotaAuthority(db: Db, clock: () => number = Date.now) {
 const time = () => { const n=clock(); integer(n); return n; };
 const bind = (v: GoalQuotaClaim) => [key(v.goalId),v.goalId,v.enrollmentId,v.ownerId,v.fence,time()];
 const execute = async (sql: string, args: unknown[]) => { let result: unknown; try { result=await db.execute(sql,args); } catch { err("quota_storage_unknown"); } ack(result); };
 const pause = async (v: GoalQuotaClaim) => { claimValid(v); await execute(GOAL_QUOTA_SQL.pause,bind(v)); };
 const stopBestEffort = async (v: GoalQuotaClaim) => { try { await pause(v); } catch { /* Ambiguity remains occupied; never restore or refund. */ } };
 return Object.freeze({
  async prepareNew(v: GoalQuotaIdentity & {limit:number}) {
   identity(v); integer(v.limit,1,MAX);
   const record: GoalQuotaRecord={protocol:P,goal_id:v.goalId,enrollment_id:v.enrollmentId,state:"prepared",limit:v.limit,consumed:0,owner:null,fence:0,active:false,lease_until:0,permits:[]};
   await execute(GOAL_QUOTA_SQL.prepare,[key(v.goalId),JSON.stringify(record),v.goalId]);
  },
  async claim(v: GoalQuotaIdentity & {ownerId:string;expectedFence:number;leaseMs:number}, checkpoint?: {rounds:string;record:string}): Promise<GoalQuotaClaim> {
   identity(v); if(!id(v.ownerId,"owner")) err("quota_invalid_request"); integer(v.expectedFence,0,FMAX-1); integer(v.leaseMs,1,300_000);
   const now=time(); integer(now+v.leaseMs);
   if(checkpoint&&(typeof checkpoint.rounds!=="string"||typeof checkpoint.record!=="string"))err("quota_invalid_request");
   const sql=checkpoint?`${GOAL_QUOTA_SQL.claim} AND value=$8 AND EXISTS (SELECT 1 FROM goals g WHERE g.id=$2 AND g.deleted_at IS NULL AND g.status='running' AND g.rounds=$9)`:GOAL_QUOTA_SQL.claim;
   await execute(sql,[key(v.goalId),v.goalId,v.enrollmentId,v.ownerId,v.expectedFence,now,now+v.leaseMs,...(checkpoint?[checkpoint.record,checkpoint.rounds]:[])]);
   return Object.freeze({goalId:v.goalId,enrollmentId:v.enrollmentId,ownerId:v.ownerId,fence:v.expectedFence+1});
  },
  async renew(v: GoalQuotaClaim, leaseMs:number) { claimValid(v); integer(leaseMs,1,300_000);const args=bind(v);const until=(args[5] as number)+leaseMs;integer(until);await execute(GOAL_QUOTA_SQL.renew,[...args,until]); },
  pause,
  async snapshot(v: GoalQuotaIdentity): Promise<GoalQuotaRecord> {
   identity(v);let rows: {value:string}[];try { rows=await db.select<{value:string}[]>(GOAL_QUOTA_SQL.snapshot,[key(v.goalId),v.goalId,v.enrollmentId]); } catch { return err("quota_storage_unknown"); }
   if(!Array.isArray(rows)||rows.length!==1||typeof rows[0]?.value!=="string") err("quota_protocol_invalid");
   try {return JSON.parse(rows[0].value) as GoalQuotaRecord;} catch {return err("quota_protocol_invalid");}
  },
  meter(v: GoalQuotaClaim, e: GoalQuotaExecution): GoalMeterScope {
   claimValid(v);executionValid(e);const scope=Object.freeze({...v,...e});let poisoned=false;
   const uncertain = async (code:"quota_storage_unknown"|"quota_outcome_unknown"): Promise<never> => {poisoned=true;await stopBestEffort(scope);return err(code);};
   return Object.freeze({...scope, async invoke<T>(call:GoalQuotaCall, callback:()=>Promise<T>, policy?:GoalQuotaFailurePolicy):Promise<T> {
    // Capture once before awaiting: caller mutation must never redirect another permit settlement.
    const request=Object.freeze({permitId:call.permitId,kind:call.kind,purpose:call.purpose});
    callValid(request); if(poisoned) err("quota_storage_unknown");
    const args=()=>[...bind(scope),request.permitId,scope.taskId,scope.executionId];
    try {await execute(GOAL_QUOTA_SQL.admit,[...args(),request.kind,request.purpose]);} catch(error) {
     if(error instanceof GoalQuotaControlError && error.code==="quota_denied") throw error;
     return uncertain("quota_storage_unknown");
    }
    let result:T;
    try {result=await callback();} catch(error) {
     let outcome:"failed"|"unknown"="unknown"; try {if(policy?.classifyFailure(error)==="failed")outcome="failed";}catch{/* Untrusted classifier failure stays unknown. */}
     try {await execute(outcome==="failed"?GOAL_QUOTA_SQL.settle:GOAL_QUOTA_SQL.unknown,outcome==="failed"?[...args(),"failed"]:args());}catch{return uncertain("quota_storage_unknown");}
     if(outcome==="unknown")return uncertain("quota_outcome_unknown");
     throw error;
    }
    try {await execute(GOAL_QUOTA_SQL.settle,[...args(),"succeeded"]);}catch{return uncertain("quota_storage_unknown");}
    return result;
   }});
  },
 });
}
export type GoalQuotaAuthority = ReturnType<typeof createGoalQuotaAuthority>;
