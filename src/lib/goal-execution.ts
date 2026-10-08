import { withDb } from "./db";
import { getGoalForQuota, envelopeForGoal } from "./db-goal";
import { createGoalQuotaAuthority } from "./db-goal-quota";
import { GOAL_PUBLICATION_SQL, publicationArgs, strictGoalExecute } from "./db-goal-publication";
import { GoalQuotaControlError, type GoalMeterScope } from "@/core/goal-quota";
import type { Goal } from "@/decision/goal";
import type { GoalQuotaPublication } from "./goal-quota-storage";
import { goalContinuationGuard, type GoalContinuation } from "./goal-continuation";
import { rethrowGoalControl } from "./goal-quota-error";
export { rethrowGoalControl } from "./goal-quota-error";
export interface GoalExecutionContext { readonly goalId:string;readonly enrollmentId:string;readonly taskId:string;readonly executionId:string }
export interface GoalExecutionSession {
 readonly context:GoalExecutionContext;readonly publication:GoalQuotaPublication;readonly meter:GoalMeterScope;
 renew():Promise<void>;release():Promise<void>;
}
const sessions=new Map<string,GoalExecutionSession>();
export const goalExecutionForTask=(taskId:string)=>sessions.get(taskId)??null;
export async function readExecutionGoal(goalId:string):Promise<Goal>{return withDb(db=>getGoalForQuota(db,goalId)).catch(rethrowGoalControl);}
/** Every round gets a new claim/fence. No API rebinds a different execution under an existing live claim. */
export async function acquireGoalExecution(goalId:string,taskId:string,clock:()=>number=Date.now,continuation?:GoalContinuation):Promise<GoalExecutionSession|null>{
 if(!/^task-[a-z0-9-]{1,48}$/.test(taskId))throw new GoalQuotaControlError("quota_invalid_request");
 return withDb(async db=>{
  const g=await getGoalForQuota(db,goalId);if(!g.quota){if(continuation)throw new GoalQuotaControlError("quota_denied");return null;}
  const guard=continuation?goalContinuationGuard(continuation,g,clock()):null;
  if(continuation&&(!guard||continuation.taskId!==taskId))throw new GoalQuotaControlError("quota_denied");
  if(g.status!=="running")throw new GoalQuotaControlError("quota_denied");
  const round=g.rounds.at(-1);if(round&&(round.status==="running"||round.status==="interrupted")&&round.task_id!==taskId)throw new GoalQuotaControlError("quota_denied");
  if(round&&(round.status==="running"||round.status==="interrupted")&&!round.task_checkpoint?.recovery_accounting?.final&&!continuation)throw new GoalQuotaControlError("quota_denied");
  if(round&&(round.status==="running"||round.status==="interrupted")&&round.task_checkpoint?.status!=="completed"&&!continuation)throw new GoalQuotaControlError("quota_denied");
  if(round?.status==="interrupted"&&(!round.task_checkpoint||round.task_checkpoint.id!==taskId||round.task_checkpoint.goalId!==g.id))throw new GoalQuotaControlError("quota_protocol_invalid");
  const ownerId=`owner-${crypto.randomUUID()}`,executionId=`exec-${crypto.randomUUID()}`,q=g.quota;
  const authority=createGoalQuotaAuthority(db,clock);const requested={goalId:g.id,enrollmentId:q.enrollmentId,ownerId,fence:q.fence+1};let claim=requested;
  try{
   claim=await authority.claim({goalId:g.id,enrollmentId:q.enrollmentId,ownerId,expectedFence:q.fence,leaseMs:300_000},guard??undefined);
   const publication=Object.freeze({...claim,taskId,executionId});const envelope=envelopeForGoal(g);envelope.revision++;envelope.execution={owner_id:ownerId,fence:claim.fence,task_id:taskId,execution_id:executionId};
   await strictGoalExecute(db,guard?`${GOAL_PUBLICATION_SQL.bind} AND rounds=$19`:GOAL_PUBLICATION_SQL.bind,[...publicationArgs(g,{...g,updated_at:clock()},envelope,publication,"owned",claim.fence),...(guard?[guard.rounds]:[])]);
   const context=Object.freeze({goalId:g.id,enrollmentId:q.enrollmentId,taskId,executionId});const meter=authority.meter(claim,{taskId,executionId});let released=false;
   const session:GoalExecutionSession=Object.freeze({context,publication,meter,
    async renew(){if(released)throw new GoalQuotaControlError("quota_denied");await withDb(async next=>{const current=await getGoalForQuota(next,g.id);if(current.quota?.execution?.executionId!==executionId||current.quota.execution.taskId!==taskId)throw new GoalQuotaControlError("quota_denied");await createGoalQuotaAuthority(next,clock).renew(claim,300_000);}).catch(rethrowGoalControl);},
    async release(){if(released)return;await withDb(async next=>{const a=createGoalQuotaAuthority(next,clock),record=await a.snapshot({goalId:g.id,enrollmentId:q.enrollmentId});if(record.active&&record.owner===claim.ownerId&&record.fence===claim.fence)await a.pause(claim);}).catch(rethrowGoalControl);released=true;if(sessions.get(taskId)===session)sessions.delete(taskId);},
   });sessions.set(taskId,session);return session;
  }catch(error){try{await authority.pause(claim);}catch{/* Keep unknown owner/pending conservative; never refund/rebuild. */}throw error;}
 }).catch(rethrowGoalControl);
}
export async function requireGoalSession(goalId:string,taskId:string,session:GoalExecutionSession|null):Promise<GoalExecutionSession|null>{
 const g=await readExecutionGoal(goalId);if(!g.quota){if(session)throw new GoalQuotaControlError("quota_protocol_invalid");return null;}
 const e=g.quota.execution;if(!session||!g.quota.active||g.quota.ownerId!==session.publication.ownerId||g.quota.fence!==session.publication.fence||g.quota.leaseUntil<=Date.now()||session.meter.taskId!==taskId||session.meter.executionId!==session.context.executionId||session.context.goalId!==g.id||session.context.enrollmentId!==g.quota.enrollmentId||session.context.taskId!==taskId||e?.executionId!==session.context.executionId||e.taskId!==taskId||g.status!=="running")throw new GoalQuotaControlError("quota_invalid_request");return session;
}
/** Completed persisted artifacts may be judged by rules with no fresh model owner or permit. */
export function freeCompletedPublication(g:Goal,taskId:string):GoalQuotaPublication|null {
 const q=g.quota,e=q?.execution,r=g.rounds.at(-1);if(!q||q.active||!e||e.taskId!==taskId||r?.task_id!==taskId||r.task_checkpoint?.id!==taskId||r.task_checkpoint.goalId!==g.id||r.task_checkpoint.status!=="completed")return null;
 return Object.freeze({...e,mode:"free_completed",authorityFence:q.fence});
}

/** Event counts cannot prove a main request terminal when its canonical permit is pending/unknown. */
export async function hasUnsettledGoalMain(session:GoalExecutionSession):Promise<boolean>{
 return withDb(async db=>{const q=await createGoalQuotaAuthority(db).snapshot(session.context);return q.permits.some(p=>p.task_id===session.context.taskId&&p.execution_id===session.context.executionId&&p.kind==="main"&&(p.state==="pending"||p.state==="unknown"));}).catch(rethrowGoalControl);
}
