import type { Db } from "./db";
import { SCHEMA_VERSION } from "./db";
import { GOAL_QUOTA_SQL } from "./db-goal-quota";
import { decodeGoalEnvelope, type GoalQuotaEnvelope } from "./goal-quota-storage";
import { GOAL_QUOTA_PROTOCOL, GoalQuotaControlError, type GoalQuotaRecord } from "@/core/goal-quota";
import { isGoalStatus, type GoalStatus } from "@/decision/goal";
import { normalizeRecoveryAccounting, type RecoveryAccounting } from "@/decision/session";
import type { RunStatus } from "@/agent/types";
import type { InvocationLedgerState } from "@/agent/tool-contract";

/** Evidence only. A snapshot is never a permit, a lease, or a resume authorization. */
export interface CanonicalGoalToolLedgerRow {
 readonly idempotency_key:string; readonly task_id:string; readonly step_id:string; readonly invocation_id:string;
 readonly tool:string; readonly args_digest:string; readonly attempt:number; readonly state:InvocationLedgerState;
 readonly artifacts:string; readonly detail:string; readonly lease_owner:string|null; readonly lease_expires_at:number|null;
 readonly created_at:number; readonly updated_at:number;
}
export interface CanonicalGoalSnapshot {
 readonly schemaVersion:number; readonly goalId:string; readonly status:GoalStatus;
 readonly envelope:GoalQuotaEnvelope; readonly authority:GoalQuotaRecord;
 /** Exact current execution task only. Child namespaces and other executions' tasks are excluded. */
 readonly toolLedger:readonly CanonicalGoalToolLedgerRow[];
 /** Last persisted checkpoint/run receipt; it need not belong to the current execution binding. */
 readonly mainReceipt:{readonly state:"absent"|"incomplete"|"final";readonly accounting:RecoveryAccounting|null;readonly terminalEvidence:boolean};
}
export interface PublicCanonicalGoalSnapshot {
 readonly protocol:typeof GOAL_QUOTA_PROTOCOL;readonly schemaVersion:number;readonly goalId:string;readonly enrollmentId:string;
 readonly revision:number;readonly status:GoalStatus;readonly roundCount:number;
 readonly currentRound:{readonly index:number;readonly status:string;readonly taskId:string|null;readonly checkpointPresent:boolean}|null;
 readonly execution:GoalQuotaEnvelope["execution"]|null;
 readonly authority:{readonly state:GoalQuotaRecord["state"];readonly limit:number;readonly consumed:number;readonly active:boolean;readonly ownerId:string|null;readonly fence:number;readonly leaseUntil:number;readonly pending:number;readonly unknown:number;readonly succeeded:number;readonly failed:number};
 readonly currentExecutionPermits:{readonly total:number;readonly mainPending:number;readonly mainUnknown:number;readonly mainTerminal:number};
 readonly mainReceipt:{readonly state:"absent"|"incomplete"|"final";readonly llmCalls:number|null;readonly terminalEvidence:boolean};
 readonly toolLedger:{readonly exactTaskId:string|null;readonly total:number;readonly states:Readonly<Record<InvocationLedgerState,number>>};
 readonly authorizesResume:false;
}
const invalid=():never=>{throw new GoalQuotaControlError("quota_protocol_invalid");};
const storage=():never=>{throw new GoalQuotaControlError("quota_storage_unknown");};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
const integer=(x:unknown,min=0):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=min;
function deepFreeze<T>(value:T):T { if(value&&typeof value==="object"){for(const child of Object.values(value as Record<string,unknown>))deepFreeze(child);Object.freeze(value);}return value; }
const sameData=(a:unknown,b:unknown):boolean=>{
 if(Object.is(a,b))return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>sameData(v,b[i]));
 if(!object(a)||!object(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&sameData(a[k],b[k]));
};

// Reuse the authority's entire final SELECT byte for byte. Fail closed if its CTE contract changes.
// The outer input derives enrollment from this same explicit Goal row, never from an earlier read.
const prefix="WITH input AS (SELECT $1 AS key,$2 AS goal_id,$3 AS enrollment_id) ";
function snapshotSql():string {
 if(!GOAL_QUOTA_SQL.snapshot.startsWith(prefix))return invalid();
 const canonicalSelect=GOAL_QUOTA_SQL.snapshot.slice(prefix.length);
 if(!canonicalSelect.startsWith("SELECT value FROM app_meta WHERE ")||canonicalSelect.includes(";"))return invalid();
 return `WITH goal_row AS (SELECT id,status,rounds FROM goals WHERE id=$1 AND deleted_at IS NULL),
 input AS (SELECT 'goal-quota:v1:' || $1 AS key,$1 AS goal_id,
  CASE WHEN json_valid(rounds)=1 THEN json_extract(rounds,'$.enrollment_id') ELSE NULL END AS enrollment_id FROM goal_row),
 canonical_authority AS (${canonicalSelect}),
 execution AS (SELECT CASE WHEN json_valid(rounds)=1 THEN json_extract(rounds,'$.execution.task_id') ELSE NULL END AS task_id FROM goal_row),
 ledger AS (SELECT t.* FROM tool_invocations t WHERE t.task_id=(SELECT task_id FROM execution) ORDER BY t.idempotency_key)
 SELECT g.id,g.status,g.rounds,
  (SELECT value FROM canonical_authority) AS authority,
  (SELECT value FROM app_meta WHERE key='schema_version') AS schema_version,
  (SELECT count(*) FROM sqlite_master WHERE type='index' AND name='tool_invocations_lease' AND tbl_name='tool_invocations') AS lease_index,
  (SELECT json_group_array(json_object('idempotency_key',idempotency_key,'task_id',task_id,'step_id',step_id,'invocation_id',invocation_id,
   'tool',tool,'args_digest',args_digest,'attempt',attempt,'state',state,'artifacts',artifacts,'detail',detail,
   'lease_owner',lease_owner,'lease_expires_at',lease_expires_at,'created_at',created_at,'updated_at',updated_at)) FROM ledger) AS tool_ledger
 FROM goal_row g`;
}
export const CANONICAL_GOAL_SNAPSHOT_SQL=snapshotSql();

/** decodeGoalEnvelope's soft round reader must not repair a malformed V1 evidence record. */
function strictEnvelope(raw:string,goalId:string):GoalQuotaEnvelope {
 const envelope=decodeGoalEnvelope(raw,goalId);if(!envelope)return invalid();
 const stored=JSON.parse(raw) as Record<string,unknown>;const rounds=stored.rounds as unknown[];
 for(let i=0;i<rounds.length;i++){
  const r=rounds[i];if(!object(r)||r.index!==i+1||!integer(r.started_at)||!(r.finished_at===null||integer(r.finished_at)))return invalid();
  if(!(r.task_id===null||typeof r.task_id==="string"&&/^task-[a-z0-9-]{1,48}$/.test(r.task_id)))return invalid();
  const cp=r.task_checkpoint;
  if(cp!==undefined&&cp!==null){
   if(!object(cp)||r.task_id===null||cp.id!==r.task_id||cp.goalId!==goalId||!Array.isArray(cp.events))return invalid();
   if(cp.recovery_accounting!==undefined&&cp.recovery_accounting!==null){
    const a=normalizeRecoveryAccounting(cp.recovery_accounting,r.task_id as string);
    if(!a||!sameData(a,cp.recovery_accounting))return invalid();
   }
  }
  // Optional null checkpoint is declared by GoalRound; otherwise accept only lossless decoding.
  const decoded={...envelope.rounds[i],...(cp===null?{task_checkpoint:null}:{})};
  if(!sameData(r,decoded))return invalid();
 }
 const e=envelope.execution,last=envelope.rounds.at(-1);
 if(e&&last&&last.task_id!==e.task_id)return invalid();
 if(!e&&envelope.rounds.length!==0)return invalid();
 return envelope;
}
const ledgerStates:readonly InvocationLedgerState[]=["planned","started","applied","not_applied","unknown","conflict"];
function toolRows(raw:string,taskId:string|null):CanonicalGoalToolLedgerRow[] {
 let list:unknown;try{list=JSON.parse(raw);}catch{return invalid();}
 if(!Array.isArray(list))return invalid();const seen=new Set<string>();
 for(const v of list){
  if(!object(v)||v.task_id!==taskId||typeof v.idempotency_key!=="string"||!v.idempotency_key||seen.has(v.idempotency_key)||typeof v.step_id!=="string"||!v.step_id||typeof v.invocation_id!=="string"||!v.invocation_id||typeof v.tool!=="string"||typeof v.args_digest!=="string"||typeof v.artifacts!=="string"||typeof v.detail!=="string"||!integer(v.attempt,1)||!ledgerStates.includes(v.state as InvocationLedgerState)||!integer(v.created_at)||!integer(v.updated_at)||!(v.lease_owner===null||typeof v.lease_owner==="string")||!(v.lease_expires_at===null||integer(v.lease_expires_at)))return invalid();
  let artifacts:unknown;try{artifacts=JSON.parse(v.artifacts);}catch{return invalid();}if(!Array.isArray(artifacts))return invalid();
  seen.add(v.idempotency_key);
 }
 return list as CanonicalGoalToolLedgerRow[];
}
function receipt(envelope:GoalQuotaEnvelope):CanonicalGoalSnapshot["mainReceipt"] {
 const cp=envelope.rounds.at(-1)?.task_checkpoint;
 if(!cp?.recovery_accounting)return Object.freeze({state:"absent",accounting:null,terminalEvidence:false});
 const a=cp.recovery_accounting;let latestStart:Record<string,unknown>|null=null,end:Record<string,unknown>|null=null;
 for(const event of cp.events){if(!object(event))continue;if(event.type==="run_start"){latestStart=event;end=null;}else if(event.type==="run_end")end=event;}
 const statuses:readonly RunStatus[]=["completed","failed","aborted","needs_user","budget_exceeded"];
 // Actual Runtime.run_end has status/summary, not runId or llmCalls. Accounting remains independent.
 const terminal=latestStart?.runId===a.run_id&&end!==null&&statuses.includes(end.status as RunStatus)&&typeof end.summary==="string";
 if(a.final&&!terminal)return invalid();
 return Object.freeze({state:a.final?"final":"incomplete",accounting:a,terminalEvidence:terminal});
}
/** One SELECT is a coherent read snapshot even though plugin BEGIN/execute calls may use separate connections. */
export async function readCanonicalGoalSnapshot(db:Readonly<Pick<Db,"select">>,explicitGoalId:string):Promise<CanonicalGoalSnapshot> {
 if(typeof explicitGoalId!=="string"||!/^goal-[a-z0-9][a-z0-9-]{0,47}$/.test(explicitGoalId))throw new GoalQuotaControlError("quota_invalid_request");
 let rows:unknown;try{rows=await db.select<unknown>(CANONICAL_GOAL_SNAPSHOT_SQL,[explicitGoalId]);}catch{return storage();}
 if(!Array.isArray(rows)||rows.length!==1||!object(rows[0]))return invalid();const row=rows[0];
 if(row.id!==explicitGoalId||!isGoalStatus(row.status)||row.status==="deleted"||typeof row.rounds!=="string"||typeof row.authority!=="string"||row.schema_version!==String(SCHEMA_VERSION)||row.lease_index!==1||typeof row.tool_ledger!=="string")return invalid();
 const envelope=strictEnvelope(row.rounds,explicitGoalId);
 // SQL, not a second JS authority validator, established the canonical record's complete shape and types.
 let authority:GoalQuotaRecord;try{authority=JSON.parse(row.authority) as GoalQuotaRecord;}catch{return invalid();}
 if(authority.active&&(!envelope.execution||row.status!=="running"||authority.owner!==envelope.execution.owner_id||authority.fence!==envelope.execution.fence))return invalid();
 if(envelope.execution&&envelope.execution.fence>authority.fence||!envelope.execution&&authority.consumed!==0)return invalid();
 return deepFreeze({schemaVersion:SCHEMA_VERSION,goalId:explicitGoalId,status:row.status,envelope,authority,
  toolLedger:toolRows(row.tool_ledger,envelope.execution?.task_id??null),mainReceipt:receipt(envelope)});
}
/** The only projection intended for logs/evidence: fixed states, counts and validated opaque identities. */
export function projectCanonicalGoalSnapshot(s:CanonicalGoalSnapshot):PublicCanonicalGoalSnapshot {
 const q=s.authority,e=s.envelope.execution,r=s.envelope.rounds.at(-1),permits=q.permits;
 const current=e?permits.filter(p=>p.task_id===e.task_id&&p.execution_id===e.execution_id&&p.owner===e.owner_id&&p.fence===e.fence):[];
 const states:Record<InvocationLedgerState,number>={planned:0,started:0,applied:0,not_applied:0,unknown:0,conflict:0};for(const row of s.toolLedger)states[row.state]++;
 return deepFreeze({protocol:GOAL_QUOTA_PROTOCOL,schemaVersion:s.schemaVersion,goalId:s.goalId,enrollmentId:s.envelope.enrollment_id,revision:s.envelope.revision,status:s.status,roundCount:s.envelope.rounds.length,
  currentRound:r?{index:r.index,status:r.status,taskId:r.task_id,checkpointPresent:Boolean(r.task_checkpoint)}:null,execution:e?{...e}:null,
  authority:{state:q.state,limit:q.limit,consumed:q.consumed,active:q.active,ownerId:q.owner,fence:q.fence,leaseUntil:q.lease_until,pending:permits.filter(p=>p.state==="pending").length,unknown:permits.filter(p=>p.state==="unknown").length,succeeded:permits.filter(p=>p.state==="succeeded").length,failed:permits.filter(p=>p.state==="failed").length},
  currentExecutionPermits:{total:current.length,mainPending:current.filter(p=>p.kind==="main"&&p.state==="pending").length,mainUnknown:current.filter(p=>p.kind==="main"&&p.state==="unknown").length,mainTerminal:current.filter(p=>p.kind==="main"&&(p.state==="succeeded"||p.state==="failed")).length},
  mainReceipt:{state:s.mainReceipt.state,llmCalls:s.mainReceipt.accounting?.llm_calls??null,terminalEvidence:s.mainReceipt.terminalEvidence},toolLedger:{exactTaskId:e?.task_id??null,total:s.toolLedger.length,states},authorizesResume:false});
}
