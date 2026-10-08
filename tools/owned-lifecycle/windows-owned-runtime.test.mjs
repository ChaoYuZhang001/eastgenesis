import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,writeFile,symlink,link,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile,mkdir,realpath} from 'node:fs/promises';
import {assertWindowsRuntimeHost,windowsOperationEnd,acceptWindowsAcknowledgement,quoteWindowsArgument,readPinnedRuntimeInput,verifyWindowsJournalRows,validateWindowsNativeReport,runWindowsNativeSixCases,withOwnedChildControl} from './windows-owned-runtime.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fresh(action){const root=await mkdtemp(join(await realpath(tmpdir()),'eg-win-primitive-fs-'));await chmod(root,0o700);try{await action(root);}finally{await rm(root,{recursive:true,force:true});}}
const fixed=code=>error=>error?.fixedCode===code;

test('pure deadline chooses remaining global time without extension',()=>{
  assert.equal(windowsOperationEnd(100n,900n,1),900n);
  assert.equal(windowsOperationEnd(100n,9000000n,1),1000100n);
  assert.throws(()=>windowsOperationEnd(900n,900n,1),fixed('deadline_exceeded'));
});
test('pure acknowledgement rejects equality and late timer delivery',()=>{
  acceptWindowsAcknowledgement(899n,900n);
  assert.throws(()=>acceptWindowsAcknowledgement(900n,900n),fixed('acknowledgement_late'));
  assert.throws(()=>acceptWindowsAcknowledgement(901n,900n),fixed('acknowledgement_late'));
});
test('pure argument quoting binds spaces, quotes and trailing backslashes',()=>{
  assert.equal(quoteWindowsArgument(''),'""');
  assert.equal(quoteWindowsArgument('plain'),'"plain"');
  assert.equal(quoteWindowsArgument('a b'),'"a b"');
  assert.equal(quoteWindowsArgument('a"b'),'"a\\"b"');
  assert.equal(quoteWindowsArgument('C:\\x\\'),'"C:\\x\\\\"');
  assert.equal(quoteWindowsArgument('x\\"y'),'"x\\\\\\"y"');
  assert.throws(()=>quoteWindowsArgument('x\0y'),fixed('argument_invalid'));
});
test('actual fresh regular file reads are pinned and source bytes remain unchanged',async()=>fresh(async root=>{
  const path=join(root,'input.cs');const bytes=Buffer.from('synthetic owned source\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});const before=await lstat(path,{bigint:true});
  assert.deepEqual(await readPinnedRuntimeInput({path,sha256:digest(bytes)}),bytes);
  const after=await lstat(path,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs'])assert.equal(before[key],after[key]);
}));
test('forbidden basename rejects before any nonexistent leaf lookup',async()=>fresh(async root=>{
  await assert.rejects(readPinnedRuntimeInput({path:join(root,'MEMORY.md'),sha256:'0'.repeat(64)}),fixed('input_forbidden'));
}));
test('actual fresh symlink input rejected before target bytes',async()=>fresh(async root=>{
  const bytes=Buffer.from('synthetic target');const target=join(root,'target.cs'),path=join(root,'linked.cs');await writeFile(target,bytes);await symlink(target,path);
  await assert.rejects(readPinnedRuntimeInput({path,sha256:digest(bytes)}),fixed('input_link'));
}));
test('actual fresh hardlink input rejected by retained file nlink',async()=>fresh(async root=>{
  const bytes=Buffer.from('synthetic target');const target=join(root,'target.cs'),path=join(root,'linked.cs');await writeFile(target,bytes);await link(target,path);
  await assert.rejects(readPinnedRuntimeInput({path,sha256:digest(bytes)}),fixed('input_not_regular'));
}));
test('actual fresh input hash mismatch rejected',async()=>fresh(async root=>{
  const path=join(root,'input.cs');await writeFile(path,'synthetic changed source');
  await assert.rejects(readPinnedRuntimeInput({path,sha256:'0'.repeat(64)}),fixed('input_drift'));
}));
const jobId='a'.repeat(32),operationId='b'.repeat(32),imageSha='c'.repeat(64),ownerSid='S-1-5-21-1';
function originalProof(){return {role:'root',pid:12,creationTime:'999',imageSha256:imageSha,ownerSid,jobInstanceId:jobId,provenance:'original-createprocess-handle',creationOperationId:operationId,originalOperationIds:[operationId]};}
function normalize(rows){return rows.map((row,i)=>({...row,sequence:i+1,frequency:'10000000'}));}
function journal(){const p=originalProof();return normalize([
  {event:'job_close_cleanup_prepared',atTicks:'100',jobInstanceId:jobId,killOnJobClose:true,exactWaitClaim:false},
  {event:'ready',atTicks:'101',native:true,handleAuthority:true,originTicks:'100',activeEndTicks:'900',hardEndTicks:'1000',jobInstanceId:jobId,ownerSid,ownedDirectoryFileId:'12345678:0000000000000001'},
  {event:'create_prepared',atTicks:'102',role:'root',creationOperationId:operationId,jobInstanceId:jobId,imageSha256:imageSha,argumentsUtf16Sha256:'d'.repeat(64),environmentUtf16Sha256:'e'.repeat(64),cwdFileId:'12345678:0000000000000001',creationInputsBound:true,remoteParametersRead:false,emergencyOriginalHandleCleanupArmed:true,emergencyWaitScopeMs:3000,emergencyPastDeadlineIsRed:true,stdinPipeBound:false},
  {event:'process_created',atTicks:'103',...p,originalHandleRetained:true},
  {event:'job_assign_prepared',atTicks:'104',...p},
  {event:'job_assigned',atTicks:'105',...p},
  {event:'birth_proved',atTicks:'106',...p},
  {event:'resume_prepared',atTicks:'107',...p},
  {event:'resumed',atTicks:'108',...p},
  {event:'terminate_prepared',atTicks:'109',...p,cleanupScope:false},
  {event:'terminate_dispatched',atTicks:'110',...p,cleanupScope:false},
  {event:'exact_handle_wait',atTicks:'111',...p,cleanupScope:false,exitCode:1},
  {event:'cleanup_complete',atTicks:'112',allExactHandlesWaited:true,unknownCount:0,red:false,retainedCount:1,jobActiveCount:0,jobTotalCount:1,jobInstanceId:jobId},
]);}
test('pure full lineage verifier requires create/assign/birth/resume and matching report provenance',()=>{
  const proof=verifyWindowsJournalRows(journal(),{processProofs:[originalProof()],expectedImageSha256:imageSha});
  assert.equal(proof.fullLineageVerified,true);assert.equal(proof.exactWaitCount,1);assert.equal(proof.nativeAuthorityGranted,false);
});
test('pure verifier accepts explicit rejected-before-resume lineage',()=>{
  const rows=journal().filter(r=>!['resume_prepared','resumed'].includes(r.event));rows.splice(7,0,{event:'target_rejected',atTicks:'107',...originalProof()});
  assert.equal(verifyWindowsJournalRows(normalize(rows)).exactWaitCount,1);
});
test('pure verifier accepts distinct retained descendant with executed original Job ancestry',()=>{
  const rows=journal(),child={...originalProof(),role:'descendant_13',pid:13,creationTime:'1000',provenance:'retained-job-member',creationOperationId:null};
  rows.splice(9,0,{event:'descendant_retained',atTicks:'108',...child,jobMemberVerified:true});rows.splice(rows.length-1,0,{event:'exact_handle_wait',atTicks:'111',...child,cleanupScope:false,exitCode:0});rows.at(-1).retainedCount=2;rows.at(-1).jobTotalCount=2;
  assert.equal(verifyWindowsJournalRows(normalize(rows),{processProofs:[originalProof(),child]}).exactWaitCount,2);
});
const unsafeMutations=[
  ['missing_create_assign_birth_resume',rows=>rows.filter(r=>!['create_prepared','process_created','job_assign_prepared','job_assigned','birth_proved','resume_prepared','resumed'].includes(r.event))],
  ['still_active_exit_code',rows=>{rows.find(r=>r.event==='exact_handle_wait').exitCode=259;return rows;}],
  ['missing_exit_code',rows=>{delete rows.find(r=>r.event==='exact_handle_wait').exitCode;return rows;}],
  ['wait_at_expired_hard_deadline',rows=>{rows.find(r=>r.event==='exact_handle_wait').atTicks='1000';rows.at(-1).atTicks='1001';return rows;}],
  ['wrong_birth_dispatch',rows=>{rows.find(r=>r.event==='terminate_dispatched').creationTime='1000';return rows;}],
  ['unknown_cleanup',rows=>{rows.at(-1).unknownCount=1;return rows;}],
  ['backwards_clock',rows=>{rows.find(r=>r.event==='terminate_dispatched').atTicks='100';return rows;}],
  ['duplicate_wait',rows=>{rows.splice(rows.length-1,0,{...rows.find(r=>r.event==='exact_handle_wait')});return rows;}],
];
for(const [name,mutate] of unsafeMutations)test(`review negative: ${name} is rejected`,()=>{assert.throws(()=>verifyWindowsJournalRows(normalize(mutate(journal()))));});
test('pure lineage verifier rejects descendant whose original was never created/resumed',()=>{
  const rows=journal();rows.splice(9,0,{event:'descendant_retained',atTicks:'108',...originalProof(),role:'descendant_13',pid:13,creationTime:'1000',creationOperationId:null,provenance:'retained-job-member',jobMemberVerified:true,originalOperationIds:['f'.repeat(32)]});assert.throws(()=>verifyWindowsJournalRows(normalize(rows)));
});
test('pure lineage verifier rejects report provenance not backed by journal',()=>{
  assert.throws(()=>verifyWindowsJournalRows(journal(),{processProofs:[{...originalProof(),provenance:'retained-job-member',creationOperationId:null}]}));
});
class MockOriginalChild extends EventEmitter{
  constructor({killFails=false}={}){super();this.pid=123;this.stdin=null;this.stdout=new PassThrough();this.stderr=new PassThrough();this.killCount=0;this.killFails=killFails;}
  kill(){this.killCount++;if(this.killFails)throw new Error('synthetic_kill_failure');queueMicrotask(()=>{this.emit('exit',1,null);this.stdout.destroy();this.stderr.destroy();this.emit('close',1,null);});return true;}
}
function scopeArgs(root,child,perform){const now=process.hrtime.bigint();return {intentPath:join(root,'cleanup-intent.jsonl'),spawnOriginal:()=>child,perform,activeEndNs:now+1000000000n,hardEndNs:now+2000000000n,cleanupCapMs:100};}
test('actual fresh-FS pre-arm write failure prevents spawn',async()=>fresh(async root=>{
  const path=join(root,'cleanup-intent.jsonl');await mkdir(path);let spawned=0;const args=scopeArgs(root,new MockOriginalChild(),async()=>{});args.spawnOriginal=()=>{spawned++;throw new Error('must_not_spawn');};
  await assert.rejects(withOwnedChildControl(args));assert.equal(spawned,0);
}));
test('actual fresh-FS output write failure after mock spawn always controls original and observes exit close pipes',async()=>fresh(async root=>{
  const child=new MockOriginalChild(),output=join(root,'output');await mkdir(output);
  let armSeen=false;const args=scopeArgs(root,child,async()=>writeFile(output,'synthetic output'));args.spawnOriginal=()=>{armSeen=true;return child;};
  await assert.rejects(withOwnedChildControl(args),error=>{assert.equal(error.code,'EISDIR');assert.equal(error.cleanupEvidence.cleanupVerified,true);assert.equal(error.cleanupEvidence.helperExitObserved,true);assert.equal(error.cleanupEvidence.helperCloseObserved,true);assert.equal(error.cleanupEvidence.pipesClosedObserved,true);assert.equal(error.cleanupEvidence.allDescendantWaitClaim,false);return true;});
  assert.equal(armSeen,true);assert.equal(child.killCount,1);const row=JSON.parse((await readFile(args.intentPath,'utf8')).trim());assert.equal(row.authority,'original-child-object-only');
}));
test('actual fresh-FS invalid JSON after mock spawn cannot bypass original cleanup',async()=>fresh(async root=>{
  const path=join(root,'invalid.json');await writeFile(path,'{ owned synthetic invalid JSON');const child=new MockOriginalChild();
  await assert.rejects(withOwnedChildControl(scopeArgs(root,child,async()=>JSON.parse(await readFile(path,'utf8')))),error=>{assert.equal(error instanceof SyntaxError,true);assert.equal(error.cleanupEvidence.cleanupVerified,true);return true;});assert.equal(child.killCount,1);
}));
test('pure late operation deadline still controls mock original and retains RED',async()=>fresh(async root=>{
  const child=new MockOriginalChild(),args=scopeArgs(root,child,async scope=>scope.waitForExitAndClose());args.activeEndNs=process.hrtime.bigint()+10000000n;
  await assert.rejects(withOwnedChildControl(args),error=>{assert.equal(error.fixedCode,'helper_operation_deadline');assert.equal(error.cleanupEvidence.cleanupVerified,true);return true;});assert.equal(child.killCount,1);
}));
test('pure failed original termination never claims observed exit cleanup',async()=>fresh(async root=>{
  const child=new MockOriginalChild({killFails:true}),args=scopeArgs(root,child,async()=>{throw Object.assign(new Error('synthetic write failure'),{fixedCode:'synthetic_failure'});});args.cleanupCapMs=20;
  await assert.rejects(withOwnedChildControl(args),error=>{assert.equal(error.fixedCode,'synthetic_failure');assert.equal(error.cleanupEvidence.cleanupVerified,false);assert.equal(error.cleanupEvidence.helperExitObserved,false);assert.equal(error.cleanupEvidence.allDescendantWaitClaim,false);return true;});assert.equal(child.killCount,1);
}));
test('pure report parser refuses incomplete App boundary',()=>{
  assert.throws(()=>validateWindowsNativeReport({schemaVersion:1,platform:'win32',nativeRun:true,passed:true,cases:[]}),fixed('native_report_invalid'));
});
test('actual non-Windows host rejects before poisoned configuration getters',async()=>{
  if(process.platform==='win32')throw new Error('This rejection suite requires a non-Windows host; native sixcases is separate.');
  let getterCount=0;const config=new Proxy({},{get(){getterCount++;throw new Error('getter_must_not_run');}});
  assert.throws(assertWindowsRuntimeHost,fixed('platform_unsupported'));
  await assert.rejects(runWindowsNativeSixCases(config),fixed('platform_unsupported'));
  assert.equal(getterCount,0);
});
