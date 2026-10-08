// Independent evidence parser. No database, native API, or resume authority.
import { need,digest } from './lifecycle-core.mjs';
const P='inclusive-goal-quota-v1';
const INT=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const id=(v,p,max=64)=>typeof v==='string'&&new RegExp(`^${p}-[a-z0-9][a-z0-9-]{0,${max-1}}$`).test(v);
const obj=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
function shape(v,required,optional=[]){need(obj(v)&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k))&&required.every(k=>Object.hasOwn(v,k)),'physical_semantic_shape');}
const text=(v,max=131072)=>typeof v==='string'&&v.length<=max;
export function canonicalJson(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return `[${v.map(canonicalJson).join(',')}]`;return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;}
export function toolDigest(v){const s=typeof v==='string'?v:canonicalJson(v);let h=0x811c9dc5;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),0x01000193);return (h>>>0).toString(16).padStart(8,'0');}
// Compact persisted protocol rejects duplicate keys, whitespace and lossy numbers.
export function parsePersisted(raw){need(text(raw),'physical_json_limit');let value;try{value=JSON.parse(raw);}catch{need(false,'physical_json_invalid');}need(JSON.stringify(value)===raw,'physical_json_not_canonical');return value;}
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const states=['planned','started','applied','not_applied','unknown','conflict'];
const kinds=['main','cloud_decision','local_decision','goal_verifier'];
const purposes=['plan','revise','answer','args','summary','split','merge','decision','route','choose_tool','gate','replan','check_done','evaluate_result'];
const eventShapes={
  run_start:[['type','runId','goal'],[]],run_end:[['type','status','summary'],[]],memory:[['type','items'],[]],skill:[['type','items'],[]],split:[['type','agents'],['note']],subagent:[['type','agent','event'],[]],
  route:[['type','profileId','reasons','decision','meta'],[]],step_route:[['type','step','profileId','reasons','decision','meta'],['surface','surfaceReason']],plan:[['type','plan','revision'],['continuation']],plan_review:[['type','approved'],[]],
  step_start:[['type','step','attempt'],['surface','surfaceReason','invocationId','idempotencyKey']],probe:[['type','step','state','detail'],['invocationId','idempotencyKey','artifacts']],gate:[['type','step','verdict','risk','reasons','backend'],['invocationId','idempotencyKey','recovery']],
  confirm:[['type','step','approved'],['executionState']],tool_result:[['type','step','ok','content','latencyMs'],['invocationId','idempotencyKey','artifacts','executionState']],reflect:[['type','step','done','score','backend'],['accepted','output']],recover:[['type','step','strategy','error','backend'],[]],
  llm:[['type','purpose','profileId','latencyMs','usage'],['fallbacks','retries','reasoning']],llm_failed:[['type','purpose','attempts'],['retries','partialOutput']],llm_delta:[['type','purpose','profileId','text'],[]],
};
function planStep(s){shape(s,['id','goal','tool'],['args']);need(text(s.id,200)&&s.id.length>0&&text(s.goal,4000)&&(s.tool===null||text(s.tool,200))&&(s.args===undefined||obj(s.args)),'physical_event_step');}
function event(ev,depth=0){
  need(depth<=3&&obj(ev)&&typeof ev.type==='string'&&Object.hasOwn(eventShapes,ev.type),'physical_event_type');const [required,optional]=eventShapes[ev.type];shape(ev,required,[...optional,'recordedAt']);need(ev.recordedAt===undefined||INT(ev.recordedAt),'physical_event_timestamp');
  if(Object.hasOwn(ev,'step')&&ev.step!==null)planStep(ev.step);
  if(ev.type==='run_start')need(/^run-[a-z0-9-]{1,96}$/.test(ev.runId)&&text(ev.goal,4000),'physical_run_start');
  if(ev.type==='run_end')need(['completed','failed','aborted','needs_user','budget_exceeded'].includes(ev.status)&&text(ev.summary,20000),'physical_run_end');
  if(ev.type==='plan'){shape(ev.plan,['steps','source'],['note','more']);need(Array.isArray(ev.plan.steps)&&ev.plan.steps.length<=60&&['llm','fallback','direct','skill'].includes(ev.plan.source)&&INT(ev.revision),'physical_plan');ev.plan.steps.forEach(planStep);}
  if(ev.type==='reflect')need(typeof ev.done==='boolean'&&typeof ev.score==='number'&&Number.isFinite(ev.score)&&ev.score>=0&&ev.score<=1&&['cloud-jev','local-jev','rules'].includes(ev.backend)&&(ev.accepted===undefined||typeof ev.accepted==='boolean')&&(ev.output===undefined||text(ev.output,20000)),'physical_reflect');
  if(['llm','llm_delta','llm_failed'].includes(ev.type))need(['plan','revise','args','answer','summary','split','merge'].includes(ev.purpose),'physical_llm_purpose');
  if(['llm','llm_delta'].includes(ev.type))need(text(ev.profileId,200),'physical_llm_profile');
  if(ev.type==='llm')need(typeof ev.latencyMs==='number'&&Number.isFinite(ev.latencyMs)&&ev.latencyMs>=0&&(ev.usage===null||obj(ev.usage)),'physical_llm_shape');
  if(ev.type==='llm_delta')need(text(ev.text,20000),'physical_llm_delta');
  if(ev.type==='llm_failed')need(Array.isArray(ev.attempts)&&ev.attempts.length<=64,'physical_llm_failure');
  if(ev.type==='tool_result')need(typeof ev.ok==='boolean'&&text(ev.content,20000)&&typeof ev.latencyMs==='number'&&Number.isFinite(ev.latencyMs)&&ev.latencyMs>=0,'physical_tool_result');
  if(ev.type==='step_start')need(INT(ev.attempt,1),'physical_step_attempt');
  if(ev.type==='subagent')event(ev.event,depth+1);
}
export function parsePhysicalTaskProof(result,expectedGoalId,expectedProjection=null){
  need(obj(result)&&result.sourceOpenedNoFollow===true&&result.stableSourceCohortBeforeAfter===true&&result.sqlReadOnly===true&&result.sqliteOpenedSourceDirectly===false&&result.sourceShmRead===false&&result.snapshotCopyRemoved===true&&result.authorizesResume===false&&result.appProfileBindingByCallerRequired===true,'physical_reader_boundary');
  const c=result.canonical;shape(c,['goalId','status','storedRounds','storedAuthority','schemaVersion','leaseIndex','storedLedger']);
  need(c.goalId===expectedGoalId&&id(c.goalId,'goal',48)&&c.schemaVersion==='7'&&c.leaseIndex===1&&['idle','running','paused','completed','failed','abandoned'].includes(c.status),'physical_identity_schema');
  const e=parsePersisted(c.storedRounds);shape(e,['protocol','goal_id','enrollment_id','revision','rounds'],['execution']);
  need(e.protocol===P&&e.goal_id===c.goalId&&id(e.enrollment_id,'enroll')&&INT(e.revision,0,Number.MAX_SAFE_INTEGER-1)&&Array.isArray(e.rounds)&&e.rounds.length<=100,'physical_envelope');
  const q=parsePersisted(c.storedAuthority);shape(q,['protocol','goal_id','enrollment_id','state','limit','consumed','owner','fence','active','lease_until','permits']);
  need(q.protocol===P&&q.goal_id===e.goal_id&&q.enrollment_id===e.enrollment_id&&['prepared','enrolled'].includes(q.state)&&INT(q.limit,1,500)&&INT(q.consumed,0,q.limit)&&INT(q.fence,0,1000000000)&&typeof q.active==='boolean'&&(q.owner===null||id(q.owner,'owner'))&&INT(q.lease_until)&&Array.isArray(q.permits)&&q.permits.length===q.consumed,'physical_authority');
  need(!q.active||q.state==='enrolled'&&q.owner!==null&&q.fence>0,'physical_active_authority');
  need(q.state!=='prepared'||q.consumed===0&&q.fence===0&&!q.active&&q.owner===null&&q.lease_until===0,'physical_prepared_authority');
  const seen=new Set();
  for(const p of q.permits){shape(p,['id','task_id','execution_id','owner','fence','kind','purpose','state','admitted_at','finished_at']);need(id(p.id,'permit')&&!seen.has(p.id)&&id(p.task_id,'task')&&id(p.execution_id,'exec')&&id(p.owner,'owner')&&INT(p.fence,1,q.fence)&&kinds.includes(p.kind)&&purposes.includes(p.purpose)&&['pending','succeeded','failed','unknown'].includes(p.state)&&INT(p.admitted_at)&&(p.state==='pending'?p.finished_at===null:INT(p.finished_at,p.admitted_at)),'physical_permit');seen.add(p.id);}
  let execution=e.execution??null;
  if(execution){shape(execution,['owner_id','fence','task_id','execution_id']);need(id(execution.owner_id,'owner')&&INT(execution.fence,1,q.fence)&&id(execution.task_id,'task',48)&&id(execution.execution_id,'exec'),'physical_execution');}
  need(execution!==null||e.rounds.length===0&&q.consumed===0,'physical_missing_execution');
  need(!q.active||execution&&c.status==='running'&&q.owner===execution.owner_id&&q.fence===execution.fence,'physical_execution_authority');
  for(let i=0;i<e.rounds.length;i++){
    const r=e.rounds[i];shape(r,['index','title','items','status','evidence','verdict','task_id','started_at','finished_at'],['task_checkpoint','llm_settlements','interruption_reason']);
    need(r.index===i+1&&text(r.title,100)&&Array.isArray(r.items)&&r.items.length<=30&&['running','done','not_done','uncertain','failed','interrupted'].includes(r.status)&&INT(r.started_at)&&(r.finished_at===null||INT(r.finished_at))&&(r.task_id===null||id(r.task_id,'task',48))&&obj(r.evidence)&&(r.verdict===null||obj(r.verdict)),'physical_round');
    for(const item of r.items){shape(item,['id','text','status']);need(text(item.id,200)&&text(item.text,300)&&['pending','running','done','failed','skipped'].includes(item.status),'physical_round_item');}
    const ev=r.evidence;shape(ev,['tool_calls','file_changes','command_outputs'],['claim']);need(Array.isArray(ev.tool_calls)&&ev.tool_calls.length<=40&&Array.isArray(ev.file_changes)&&ev.file_changes.length<=100&&Array.isArray(ev.command_outputs)&&ev.command_outputs.length<=15&&(ev.claim===undefined||text(ev.claim,2000)),'physical_evidence');
    for(const call of ev.tool_calls){shape(call,['tool','read_only','ok'],['target','summary']);need(text(call.tool,300)&&typeof call.read_only==='boolean'&&typeof call.ok==='boolean'&&(call.target===undefined||text(call.target,1024))&&(call.summary===undefined||text(call.summary,300)),'physical_tool_evidence');}
    for(const file of ev.file_changes){shape(file,['path','action'],['to']);need(text(file.path,1024)&&['created','modified','deleted','moved'].includes(file.action)&&(file.to===undefined||text(file.to,1024)),'physical_file_evidence');}
    for(const command of ev.command_outputs){shape(command,['command','exit_code','output']);need(text(command.command,300)&&(command.exit_code===null||Number.isSafeInteger(command.exit_code))&&text(command.output,1000),'physical_command_evidence');}
    if(r.verdict){shape(r.verdict,['verdict','reason','by'],['confidence']);need(['done','not_done','uncertain'].includes(r.verdict.verdict)&&text(r.verdict.reason,500)&&['rules','jev','user','runtime'].includes(r.verdict.by)&&(r.verdict.confidence===undefined||typeof r.verdict.confidence==='number'&&r.verdict.confidence>=0&&r.verdict.confidence<=1),'physical_verdict');}
    need(r.interruption_reason===undefined||text(r.interruption_reason,500),'physical_interruption_reason');
    if(r.llm_settlements!==undefined){need(Array.isArray(r.llm_settlements)&&r.llm_settlements.length<=500,'physical_settlements');const runs=new Set();for(const a of r.llm_settlements){shape(a,['run_id','llm_calls']);need(/^run-[a-z0-9-]{1,96}$/.test(a.run_id)&&INT(a.llm_calls,0,500)&&!runs.has(a.run_id),'physical_settlement');runs.add(a.run_id);}}
    const cp=r.task_checkpoint;
    if(cp!==undefined&&cp!==null){
      shape(cp,['id','seq','goal','status','summary','events','lock','permission','files','multi','startedAt','endedAt','goalId','mode','preference','preferenceSource'],['surfaceHint','streamingText','streamingInterrupted','recovery_accounting']);
      need(cp.id===r.task_id&&cp.goalId===c.goalId&&INT(cp.seq)&&text(cp.goal,4000)&&['queued','running','completed','failed','aborted','needs_user','budget_exceeded'].includes(cp.status)&&(cp.summary===null||text(cp.summary))&&Array.isArray(cp.events)&&cp.events.length<=2000&&Array.isArray(cp.files)&&cp.files.every(v=>text(v,4096))&&typeof cp.multi==='boolean'&&INT(cp.startedAt)&&(cp.endedAt===null||INT(cp.endedAt))&&['full','confirm','readonly'].includes(cp.permission)&&['quick','plan','goal'].includes(cp.mode)&&['economy','balanced','best'].includes(cp.preference)&&['task','goal','project','global'].includes(cp.preferenceSource),'physical_checkpoint');cp.events.forEach(ev=>event(ev));
      need((cp.lock===null||text(cp.lock,300))&&(cp.surfaceHint===undefined||cp.surfaceHint===null||['chat','work','codex'].includes(cp.surfaceHint))&&(cp.streamingText===undefined||text(cp.streamingText))&&(cp.streamingInterrupted===undefined||typeof cp.streamingInterrupted==='boolean'),'physical_checkpoint_optional');
      const a=cp.recovery_accounting;if(a!==undefined&&a!==null){shape(a,['version','task_id','run_id','llm_calls','final']);need(a.version===1&&a.task_id===cp.id&&/^run-[a-z0-9-]{1,96}$/.test(a.run_id)&&INT(a.llm_calls,0,500)&&typeof a.final==='boolean','physical_receipt');}
    }
  }
  const last=e.rounds.at(-1)??null;need(!execution||last?.task_id===execution.task_id,'physical_task_binding');
  // SQLite's aggregate formatter is not the persisted compact codec. Ledger
  // strings still reject duplicate keys by parse/re-encode equality.
  const ledger=parsePersisted(c.storedLedger);need(Array.isArray(ledger)&&ledger.length<=512,'physical_ledger');const ledgerKeys=new Set();
  for(const row of ledger){shape(row,['idempotency_key','task_id','step_id','invocation_id','tool','args_digest','attempt','state','artifacts','detail','lease_owner','lease_expires_at','created_at','updated_at']);need(row.task_id===execution?.task_id&&text(row.idempotency_key,200)&&row.idempotency_key.length>0&&!ledgerKeys.has(row.idempotency_key)&&text(row.step_id,200)&&row.step_id.length>0&&text(row.invocation_id,300)&&row.invocation_id.length>0&&text(row.tool,200)&&/^[0-9a-f]{8}$/.test(row.args_digest)&&INT(row.attempt,1)&&states.includes(row.state)&&text(row.detail)&&(row.lease_owner===null||text(row.lease_owner,200))&&(row.lease_expires_at===null||INT(row.lease_expires_at))&&INT(row.created_at)&&INT(row.updated_at),'physical_ledger_row');need(Array.isArray(parsePersisted(row.artifacts)),'physical_artifacts');ledgerKeys.add(row.idempotency_key);}
  let receipt={state:'absent',llmCalls:null,terminalEvidence:false};const cp=last?.task_checkpoint;const a=cp?.recovery_accounting;
  if(a){let start=null,end=null;for(const ev of cp.events){if(ev.type==='run_start'){start=ev;end=null;}else if(ev.type==='run_end'&&start)end=ev;}const terminal=start?.runId===a.run_id&&start.goal===cp.goal&&end!==null&&end.status===cp.status&&end.summary===cp.summary;need(!a.final||terminal,'physical_terminal_receipt');receipt={state:a.final?'final':'incomplete',llmCalls:a.llm_calls,terminalEvidence:terminal};}
  const permits=execution?q.permits.filter(p=>p.task_id===execution.task_id&&p.execution_id===execution.execution_id&&p.owner===execution.owner_id&&p.fence===execution.fence):[];const counts=Object.fromEntries(states.map(s=>[s,ledger.filter(r=>r.state===s).length]));
  const projection={protocol:P,schemaVersion:7,goalId:c.goalId,enrollmentId:e.enrollment_id,revision:e.revision,status:c.status,roundCount:e.rounds.length,currentRound:last?{index:last.index,status:last.status,taskId:last.task_id,checkpointPresent:Boolean(cp)}:null,execution,authority:{state:q.state,limit:q.limit,consumed:q.consumed,active:q.active,ownerId:q.owner,fence:q.fence,leaseUntil:q.lease_until,pending:q.permits.filter(p=>p.state==='pending').length,unknown:q.permits.filter(p=>p.state==='unknown').length,succeeded:q.permits.filter(p=>p.state==='succeeded').length,failed:q.permits.filter(p=>p.state==='failed').length},currentExecutionPermits:{total:permits.length,mainPending:permits.filter(p=>p.kind==='main'&&p.state==='pending').length,mainUnknown:permits.filter(p=>p.kind==='main'&&p.state==='unknown').length,mainTerminal:permits.filter(p=>p.kind==='main'&&['succeeded','failed'].includes(p.state)).length},mainReceipt:receipt,toolLedger:{exactTaskId:execution?.task_id??null,total:ledger.length,states:counts},authorizesResume:false};
  if(expectedProjection!==null)need(same(projection,expectedProjection),'physical_projection_disagrees');
  // Source WAL/DB hashes are auxiliary acquisition evidence, not canonical
  // Task identity; a checkpoint/SHM recreation must not defeat logical equality.
  return Object.freeze({canonical:c,projection,envelope:e,authority:q,ledger,ledgerFingerprintSha256:digest(c.storedLedger),authorizesResume:false});
}
export function assertFreshCanonical(p){need(p?.protocol===P&&p.status==='idle'&&p.roundCount===0&&p.currentRound===null&&p.execution===null&&p.authority.state==='prepared'&&p.authority.consumed===0&&!p.authority.active&&p.authority.ownerId===null&&p.authority.fence===0&&p.authority.pending===0&&p.authority.unknown===0&&p.toolLedger.total===0&&p.mainReceipt.state==='absent'&&p.authorizesResume===false,'canonical_not_fresh');}
export function assertKnownFinalPhysical(p,resumed,{sourceFile,resultFile,fileBody,marker}){
  const r=p.envelope.rounds.at(-1),cp=r?.task_checkpoint,q=p.authority;
  need(p.authorizesResume===false&&p.envelope.rounds.length===1&&cp?.recovery_accounting?.final===true&&p.projection.mainReceipt.terminalEvidence&&cp.recovery_accounting.llm_calls===(resumed?1:3)&&q.consumed===(resumed?4:3)&&q.permits.every(x=>!['unknown','pending'].includes(x.state))&&r.status===(resumed?'uncertain':'failed'),'physical_known_final');
  need(Array.isArray(r.llm_settlements)&&r.llm_settlements.map(x=>x.llm_calls).join(',')===(resumed?'3,1':'3')&&r.llm_settlements.at(-1).run_id===cp.recovery_accounting.run_id,'physical_settlement_proof');
  need(q.permits.map(x=>x.kind).every(x=>x==='main')&&q.permits.map(x=>x.purpose).join(',')===(resumed?'plan,answer,summary,summary':'plan,answer,summary')&&q.permits.map(x=>x.state).join(',')===(resumed?'succeeded,succeeded,failed,succeeded':'succeeded,succeeded,failed'),'physical_permit_sequence');
  need(q.permits.every(x=>x.task_id===p.envelope.execution.task_id)&&q.permits.slice(0,3).every(x=>x.execution_id===q.permits[0].execution_id&&x.owner===q.permits[0].owner&&x.fence===q.permits[0].fence)&&(!resumed||q.permits.at(-1).execution_id===p.envelope.execution.execution_id&&q.permits.at(-1).fence===p.envelope.execution.fence&&q.permits.at(-1).owner===p.envelope.execution.owner_id),'physical_permit_task_execution');
  need(cp.status===(resumed?'completed':'failed')&&cp.permission==='confirm'&&cp.mode==='goal'&&cp.preference==='balanced'&&cp.preferenceSource==='global'&&cp.multi===false&&cp.lock===null,'physical_checkpoint_known_final');
  let latestStart=-1;for(let i=0;i<cp.events.length;i++)if(cp.events[i].type==='run_start')latestStart=i;
  const latest=cp.events.slice(latestStart+1);need(latest.filter(e=>e.type==='llm'||e.type==='llm_failed').length===cp.recovery_accounting.llm_calls,'physical_receipt_event_count');
  const acceptedOutput=`分析项目并给出结论：${marker}。代码修改完成。`;
  const accepted=cp.events.filter(e=>e.type==='reflect'&&e.step!==null&&e.step.tool===null&&e.step.goal==='分析项目并给出结论'&&e.accepted===true&&e.output===acceptedOutput);
  need(accepted.length===1&&p.ledger.length===2,'physical_chat_marker');
  const chat=accepted[0];let chatStart=-1,chatPlan=null;
  for(let i=0;i<cp.events.indexOf(chat);i++){const ev=cp.events[i];if(ev.type==='run_start')chatStart=i;if(ev.type==='plan'&&ev.plan.steps.some(s=>s.id===chat.step.id&&s.tool===null))chatPlan=ev.plan;}
  need(chatStart>=0&&chatPlan?.steps.length===3&&chatPlan.steps[2].id===chat.step.id&&chatPlan.steps[2].tool===null&&cp.events.slice(chatStart+1,cp.events.indexOf(chat)).some(e=>e.type==='llm'&&e.purpose==='answer'&&e.profileId==='custom:qa-b/fixture-model')&&cp.events.slice(chatStart+1,cp.events.indexOf(chat)).some(e=>e.type==='step_start'&&e.step.id===chat.step.id&&e.step.tool===null),'physical_accepted_chat_lineage');
  const expectations=[['mcp__files__read_file',{path:sourceFile},'read',sourceFile],['mcp__files__write_file',{path:resultFile,content:fileBody},'modify',resultFile]];
  for(const [tool,args,action,path] of expectations){const rows=p.ledger.filter(x=>x.tool===tool);need(rows.length===1,'physical_tool_missing_or_duplicate');const x=rows[0];need(x.state==='applied'&&x.attempt===1&&x.lease_owner===null&&x.lease_expires_at===null&&x.args_digest===toolDigest(args)&&x.idempotency_key===`eg-${toolDigest(`${x.task_id}\0${x.step_id}\0${x.tool}\0${x.args_digest}`)}`&&x.invocation_id===`${x.task_id}:${x.step_id}:1`,'physical_tool_args_binding');const artifacts=parsePersisted(x.artifacts);need(artifacts.length===1&&same(artifacts[0],{kind:'file',action,path,ok:true}),'physical_artifact_binding');}
  return true;
}
