import { GOAL_QUOTA_PROTOCOL, GoalQuotaControlError, type GoalQuotaClaim, type GoalQuotaExecution, type GoalQuotaRecord } from "@/core/goal-quota";
import { parseRounds, type GoalRound } from "@/decision/goal";
export interface GoalQuotaPublication extends GoalQuotaClaim, GoalQuotaExecution { readonly mode?:"owned"|"free_completed"; readonly authorityFence?:number }
export interface GoalQuotaProjection {
 readonly protocol:typeof GOAL_QUOTA_PROTOCOL; readonly enrollmentId:string; readonly revision:number;
 readonly limit:number;readonly consumed:number;readonly active:boolean;readonly ownerId:string|null;readonly fence:number;readonly leaseUntil:number;
 readonly pending:number;readonly unknown:number;readonly execution:GoalQuotaPublication|null;
}
export interface GoalQuotaEnvelope { protocol:typeof GOAL_QUOTA_PROTOCOL;goal_id:string;enrollment_id:string;revision:number;rounds:GoalRound[];execution?:{owner_id:string;fence:number;task_id:string;execution_id:string} }
const bad=():never=>{throw new GoalQuotaControlError("quota_protocol_invalid");};
const exact=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.prototype.hasOwnProperty.call(v,k));
const ident=(v:unknown,prefix:string,max=64)=>typeof v==="string"&&new RegExp(`^${prefix}-[a-z0-9][a-z0-9-]{0,${max-1}}$`).test(v);
/** Arrays are explicit legacy only. Any object must be the complete new protocol; no object-to-legacy fallback. */
export function decodeGoalEnvelope(raw:string,goalId:string):GoalQuotaEnvelope|null {
 let v:unknown;try{v=JSON.parse(raw);}catch{return bad();}
 if(Array.isArray(v))return null;
 if(!v||typeof v!=="object")return bad();const o=v as Record<string,unknown>;
 // V1 is an internal compact JSON codec. Reject duplicate keys/noncanonical numbers rather than disagreeing with SQLite JSON typing.
 if(JSON.stringify(o)!==raw)return bad();
 const names=["protocol","goal_id","enrollment_id","revision","rounds",...(Object.prototype.hasOwnProperty.call(o,"execution")?["execution"]:[])];
 if(!exact(o,names)||o.protocol!==GOAL_QUOTA_PROTOCOL||o.goal_id!==goalId||!ident(o.goal_id,"goal",48)||!ident(o.enrollment_id,"enroll")||!Number.isSafeInteger(o.revision)||Number(o.revision)<0||Number(o.revision)>=Number.MAX_SAFE_INTEGER||!Array.isArray(o.rounds))return bad();
 const rounds=parseRounds(JSON.stringify(o.rounds));if(!rounds||rounds.length!==o.rounds.length)return bad();
 const out:GoalQuotaEnvelope={protocol:GOAL_QUOTA_PROTOCOL,goal_id:goalId,enrollment_id:o.enrollment_id as string,revision:o.revision as number,rounds};
 if(Object.prototype.hasOwnProperty.call(o,"execution")){
  if(!o.execution||typeof o.execution!=="object"||Array.isArray(o.execution))return bad();const e=o.execution as Record<string,unknown>;
  if(!exact(e,["owner_id","fence","task_id","execution_id"])||!ident(e.owner_id,"owner")||!Number.isSafeInteger(e.fence)||Number(e.fence)<1||Number(e.fence)>1_000_000_000||!ident(e.task_id,"task",48)||!ident(e.execution_id,"exec"))return bad();
  out.execution={owner_id:e.owner_id as string,fence:e.fence as number,task_id:e.task_id as string,execution_id:e.execution_id as string};
 }
 return out;
}
export function encodeGoalEnvelope(e:GoalQuotaEnvelope):string { const raw=JSON.stringify(e);if(!decodeGoalEnvelope(raw,e.goal_id))return bad();return raw; }
export function quotaProjection(e:GoalQuotaEnvelope,q:GoalQuotaRecord):GoalQuotaProjection {
 if(q.goal_id!==e.goal_id||q.enrollment_id!==e.enrollment_id)return bad();
 const execution=e.execution?Object.freeze({goalId:e.goal_id,enrollmentId:e.enrollment_id,ownerId:e.execution.owner_id,fence:e.execution.fence,taskId:e.execution.task_id,executionId:e.execution.execution_id}):null;
 return Object.freeze({protocol:GOAL_QUOTA_PROTOCOL,enrollmentId:e.enrollment_id,revision:e.revision,limit:q.limit,consumed:q.consumed,active:q.active,ownerId:q.owner,fence:q.fence,leaseUntil:q.lease_until,pending:q.permits.filter(p=>p.state==="pending").length,unknown:q.permits.filter(p=>p.state==="unknown").length,execution});
}
