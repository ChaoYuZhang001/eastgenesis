// Inert import. The Windows factory rejects the host before configuration getters.
// C# methods are executable control primitives; this wrapper runs QA six cases.
import {spawn} from 'node:child_process';
import {lstat,open,realpath,writeFile,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,isAbsolute,resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const need=(condition,code)=>{if(!condition)throw Object.assign(new Error(code),{fixedCode:code});};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assertWindowsRuntimeHost(){need(process.platform==='win32','platform_unsupported');}
export function windowsOperationEnd(nowNs,globalEndNs,capMs){
  need(typeof nowNs==='bigint'&&typeof globalEndNs==='bigint'&&Number.isSafeInteger(capMs)&&capMs>0&&capMs<=240000,'window_invalid');
  need(nowNs<globalEndNs,'deadline_exceeded');const local=nowNs+BigInt(capMs)*1000000n;return local<globalEndNs?local:globalEndNs;
}
export function acceptWindowsAcknowledgement(atNs,endNs){need(typeof atNs==='bigint'&&typeof endNs==='bigint'&&atNs<endNs,'acknowledgement_late');}
export function quoteWindowsArgument(value){
  need(typeof value==='string'&&value.length<=16384&&!/[\0\r\n]/.test(value),'argument_invalid');let out='"',slashes=0;
  for(const c of value){if(c==='\\'){slashes++;continue;}if(c==='"')out+='\\'.repeat(slashes*2+1)+'"';else out+='\\'.repeat(slashes)+c;slashes=0;}
  return out+'\\'.repeat(slashes*2)+'"';
}
async function readCheckedRuntimeBytes(inputPath){
  need(typeof inputPath==='string'&&isAbsolute(inputPath)&&resolve(inputPath)===inputPath,'input_spec_invalid');
  // Name rejection precedes any lookup or bytes, including on non-Windows.
  need(!inputPath.split(/[\\/]/).some(part=>part.toLowerCase()==='memory.md'),'input_forbidden');
  let path=inputPath;
  while(true){const st=await lstat(path);need(!st.isSymbolicLink(),'input_link');const parent=dirname(path);if(parent===path)break;path=parent;}
  need(await realpath(inputPath)===inputPath,'input_link');
  const handle=await open(inputPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const before=await handle.stat({bigint:true});need(before.isFile()&&before.nlink===1n&&before.size<=268435456n,'input_not_regular');
    const bytes=await handle.readFile();const after=await handle.stat({bigint:true});
    need(['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key=>before[key]===after[key]),'input_drift');
    const named=await lstat(inputPath,{bigint:true});need(!named.isSymbolicLink()&&['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key=>after[key]===named[key]),'input_name_drift');return bytes;
  }finally{await handle.close();}
}
export async function fingerprintRuntimeInput(inputPath){const bytes=await readCheckedRuntimeBytes(inputPath);return Object.freeze({path:inputPath,sha256:hash(bytes)});}
export async function readPinnedRuntimeInput(spec){
  need(spec&&typeof spec.path==='string'&&/^[a-f0-9]{64}$/.test(spec.sha256),'input_spec_invalid');const bytes=await readCheckedRuntimeBytes(spec.path);need(hash(bytes)===spec.sha256,'input_drift');return bytes;
}
export function verifyWindowsJournalRows(rows,{processProofs=null,expectedImageSha256=null}={}){
  need(Array.isArray(rows)&&rows.length>=3&&rows.length<=4096,'journal_rows_invalid');
  const readyRows=rows.filter(r=>r?.event==='ready'),arms=rows.filter(r=>r?.event==='job_close_cleanup_prepared');
  need(readyRows.length===1&&arms.length===1&&rows[0]===arms[0]&&rows[1]===readyRows[0],'journal_ready_lineage_missing');
  const ready=readyRows[0],guid=/^[a-f0-9]{32}$/,sha=/^[a-f0-9]{64}$/,integer=/^[0-9]+$/;
  need(ready.native===true&&ready.handleAuthority===true&&integer.test(ready.originTicks)&&integer.test(ready.activeEndTicks)&&integer.test(ready.hardEndTicks)&&/^[1-9][0-9]*$/.test(ready.frequency)&&guid.test(ready.jobInstanceId)&&/^S-1-[0-9-]+$/.test(ready.ownerSid)&&/^[0-9a-f]{8}:[0-9a-f]{16}$/.test(ready.ownedDirectoryFileId),'journal_ready_invalid');
  const origin=BigInt(ready.originTicks),active=BigInt(ready.activeEndTicks),hard=BigInt(ready.hardEndTicks);need(origin<active&&active<hard&&arms[0].jobInstanceId===ready.jobInstanceId&&arms[0].killOnJobClose===true&&arms[0].exactWaitClaim===false,'journal_deadline_or_arm_invalid');
  let last=origin;const creates=new Map(),lineages=new Map(),roles=new Set();
  const identity=p=>`${p.role}:${p.pid}:${p.creationTime}`;
  const canonical=p=>({role:p.role,pid:p.pid,creationTime:p.creationTime,imageSha256:p.imageSha256,ownerSid:p.ownerSid,jobInstanceId:p.jobInstanceId,provenance:p.provenance,creationOperationId:p.creationOperationId,originalOperationIds:p.originalOperationIds});
  const expectedRole=/^[a-zA-Z0-9_-]{1,64}$/;
  function proof(row){
    need(expectedRole.test(row.role)&&Number.isSafeInteger(row.pid)&&row.pid>0&&/^[1-9][0-9]*$/.test(row.creationTime)&&sha.test(row.imageSha256)&&row.ownerSid===ready.ownerSid&&row.jobInstanceId===ready.jobInstanceId&&Array.isArray(row.originalOperationIds)&&row.originalOperationIds.length>0&&row.originalOperationIds.every(id=>guid.test(id))&&new Set(row.originalOperationIds).size===row.originalOperationIds.length,'journal_process_proof_invalid');
    need(expectedImageSha256===null||row.imageSha256===expectedImageSha256,'journal_image_unbound');return canonical(row);
  }
  function existing(row){const p=proof(row),entry=lineages.get(identity(row));need(entry&&JSON.stringify(p)===JSON.stringify(entry.proof),'journal_process_identity_unbound');return entry;}
  const control=new Set(['terminate_prepared','terminate_dispatched','terminate_not_dispatched_already_exited','already_exited','exact_handle_wait']);
  for(let i=0;i<rows.length;i++){
    const row=rows[i];need(row&&Object.getPrototypeOf(row)===Object.prototype&&row.sequence===i+1&&typeof row.event==='string'&&/^[a-z_]+$/.test(row.event)&&integer.test(row.atTicks)&&row.frequency===ready.frequency,'journal_row_invalid');
    const at=BigInt(row.atTicks);need(at>=last&&at>=origin&&at<hard,'journal_clock_or_deadline_invalid');last=at;
    if(control.has(row.event)){need(typeof row.cleanupScope==='boolean'&&(row.cleanupScope||at<active),'journal_operation_deadline_invalid');}
    else if(!['cleanup_complete','job_close_cleanup_prepared','ready'].includes(row.event))need(at<active,'journal_operation_deadline_invalid');
    switch(row.event){
      case 'job_close_cleanup_prepared':case 'ready':break;
      case 'create_prepared':{
        need(expectedRole.test(row.role)&&guid.test(row.creationOperationId)&&!creates.has(row.creationOperationId)&&!roles.has(row.role)&&row.jobInstanceId===ready.jobInstanceId&&sha.test(row.imageSha256)&&sha.test(row.argumentsUtf16Sha256)&&sha.test(row.environmentUtf16Sha256)&&row.cwdFileId===ready.ownedDirectoryFileId&&row.creationInputsBound===true&&row.remoteParametersRead===false&&row.emergencyOriginalHandleCleanupArmed===true&&row.emergencyWaitScopeMs===3000&&row.emergencyPastDeadlineIsRed===true&&typeof row.stdinPipeBound==='boolean','journal_create_preparation_invalid');
        creates.set(row.creationOperationId,{row,stage:'prepared'});roles.add(row.role);break;
      }
      case 'process_created':{
        const p=proof(row),create=creates.get(row.creationOperationId);need(create&&create.stage==='prepared'&&row.provenance==='original-createprocess-handle'&&row.originalHandleRetained===true&&row.role===create.row.role&&row.imageSha256===create.row.imageSha256&&row.originalOperationIds.length===1&&row.originalOperationIds[0]===row.creationOperationId&&!lineages.has(identity(row)),'journal_original_create_lineage_missing');
        create.stage='created';const entry={proof:p,stage:'created',create,resumed:false,rejected:false,waited:false,terminatePending:false,eofPending:false};lineages.set(identity(row),entry);create.entry=entry;break;
      }
      case 'job_assign_prepared':{const e=existing(row);need(e.stage==='created'&&e.proof.provenance==='original-createprocess-handle','journal_assignment_lineage_missing');e.stage='assign_prepared';break;}
      case 'job_assigned':{const e=existing(row);need(e.stage==='assign_prepared','journal_assignment_lineage_missing');e.stage='assigned';break;}
      case 'birth_proved':{const e=existing(row);need(e.stage==='assigned','journal_birth_lineage_missing');e.stage='born';break;}
      case 'target_rejected':{const e=existing(row);need(e.stage==='born','journal_reject_lineage_invalid');e.stage='rejected';e.rejected=true;break;}
      case 'resume_prepared':{const e=existing(row);need(e.stage==='born'&&!e.rejected,'journal_resume_lineage_missing');e.stage='resume_prepared';break;}
      case 'resumed':{const e=existing(row);need(e.stage==='resume_prepared'&&!e.rejected,'journal_resume_lineage_missing');e.stage='resumed';e.resumed=true;break;}
      case 'descendant_retained':{
        const p=proof(row);need(row.provenance==='retained-job-member'&&row.creationOperationId===null&&row.jobMemberVerified===true&&!roles.has(row.role)&&!lineages.has(identity(row))&&row.originalOperationIds.every(id=>{const ancestor=creates.get(id)?.entry;return ancestor?.resumed===true&&BigInt(ancestor.proof.creationTime)<=BigInt(row.creationTime);}), 'journal_descendant_lineage_missing');
        roles.add(row.role);lineages.set(identity(row),{proof:p,stage:'descendant',resumed:true,rejected:false,waited:false,terminatePending:false,eofPending:false});break;
      }
      case 'verified':{const e=existing(row);need(e.resumed&&!e.waited,'journal_verify_lineage_invalid');break;}
      case 'terminate_prepared':{const e=existing(row);need((e.resumed||e.rejected)&&!e.waited&&!e.terminatePending,'journal_terminate_lineage_invalid');e.terminatePending=true;break;}
      case 'terminate_dispatched':case 'terminate_not_dispatched_already_exited':{const e=existing(row);need(e.terminatePending&&!e.waited,'journal_dispatch_without_prepared');e.terminatePending=false;break;}
      case 'already_exited':{const e=existing(row);need((e.resumed||e.rejected)&&!e.waited,'journal_exit_lineage_invalid');break;}
      case 'stdin_eof_prepared':{const e=existing(row);need(e.resumed&&!e.waited&&!e.eofPending&&e.create?.row.stdinPipeBound===true,'journal_eof_lineage_invalid');e.eofPending=true;break;}
      case 'stdin_eof_dispatched':{const e=existing(row);need(e.eofPending&&!e.waited,'journal_dispatch_without_prepared');e.eofPending=false;break;}
      case 'exact_handle_wait':{
        const e=existing(row);need((e.resumed||e.rejected)&&!e.waited&&!e.terminatePending&&!e.eofPending,'wait_identity_or_duplicate');need(Number.isSafeInteger(row.exitCode)&&row.exitCode>=0&&row.exitCode<=0xffffffff&&row.exitCode!==259,'journal_exit_code_invalid');e.waited=true;e.exitCode=row.exitCode;break;
      }
      case 'cleanup_complete':need(i===rows.length-1&&row.allExactHandlesWaited===true&&row.unknownCount===0&&row.red===false&&row.jobInstanceId===ready.jobInstanceId&&row.retainedCount===lineages.size&&row.jobActiveCount===0&&row.jobTotalCount===lineages.size,'cleanup_unverified');break;
      default:need(false,'journal_unknown_or_red_event');
    }
  }
  need(rows.at(-1).event==='cleanup_complete'&&lineages.size>0&&[...creates.values()].every(c=>c.entry&&(c.entry.resumed||c.entry.rejected)&&c.entry.waited)&&[...lineages.values()].every(e=>e.waited),'journal_complete_lineage_missing');
  const proven=[...lineages.values()].map(e=>e.proof).sort((a,b)=>identity(a).localeCompare(identity(b)));
  if(processProofs!==null){need(Array.isArray(processProofs)&&processProofs.length===proven.length,'journal_report_proofs_unbound');const expected=processProofs.map(canonical).sort((a,b)=>identity(a).localeCompare(identity(b)));need(JSON.stringify(expected)===JSON.stringify(proven),'journal_report_proofs_unbound');}
  return Object.freeze({monotonic:true,preparedActionsVerified:true,fullLineageVerified:true,exactWaitCount:proven.length,nativeAuthorityGranted:false,processProofs:proven});
}
const CASE_NAMES=['normal-stop','root-crash-retained-children','rejected-target-after-birth','stdin-eof-exact-wait','fast-exit-five-generations','unknown-authority-and-input-drift'];
export function validateWindowsNativeReport(row){
  need(row?.schemaVersion===1&&row.platform==='win32'&&row.nativeRun===true&&row.passed===true&&Array.isArray(row.cases)&&row.cases.length===6,'native_report_invalid');
  const expectedCounts=[1,3,1,1,5,1];
  need(row.cases.every((c,i)=>c.name===CASE_NAMES[i]&&c.passed===true&&c.skipped===false&&c.nativeRun===true&&c.ownedProfileRemoved===true&&c.exactWaits===expectedCounts[i]&&c.exactWaits===c.retainedHandles&&Array.isArray(c.processProofs)&&c.processProofs.length===c.retainedHandles&&c.processProofs.every(p=>typeof p.role==='string'&&/^[a-z0-9_-]+$/.test(p.role)&&Number.isSafeInteger(p.pid)&&p.pid>0&&/^[1-9][0-9]*$/.test(p.creationTime)&&typeof p.image==='string'&&/^[a-f0-9]{64}$/.test(p.imageSha256)&&p.ownerSid===row.ownerSid&&['original-createprocess-handle','retained-job-member'].includes(p.provenance))&&c.appStarted===false&&c.webDriverSession===false),'native_cases_invalid');
  need(typeof row.ownerSid==='string'&&/^S-1-[0-9-]+$/.test(row.ownerSid)&&typeof row.outputFileId==='string'&&/^[0-9a-f]{8}:[0-9a-f]{16}$/.test(row.outputFileId),'native_output_identity_invalid');
  need(Array.isArray(row.retainedFailureProfiles)&&row.retainedFailureProfiles.length===0&&row.boundary?.fullGoal===false&&row.boundary.appSessionImplemented===false&&row.boundary.appStarted===false&&row.boundary.webDriverSession===false&&row.boundary.databaseOpened===false&&row.boundary.providerRequests===0&&row.boundary.userKnownFoldersRead===false&&row.boundary.remoteProcessParametersRead===false&&row.boundary.creationInputsKernelBound===true&&row.boundary.fixtureActualProfileEnvironmentCwdVerified===true&&row.boundary.unknownDescendantsAreRed===true&&row.boundary.controllerEofCleanupTested===false&&row.boundary.helperDeathBeforeJobAssignmentNotProven===true,'native_boundary_invalid');
  return Object.freeze({passed:true,nativeRun:true,exactWaitCount:row.cases.reduce((n,c)=>n+c.exactWaits,0),fullGoal:false,appSession:false});
}

// Resource orchestration is independently fault-testable with an original
// mock ChildProcess. Pure/mock tests never grant Windows handle authority.
export async function withOwnedChildControl({intentPath,spawnOriginal,perform,activeEndNs,hardEndNs,cleanupCapMs=3000}){
  need(typeof intentPath==='string'&&isAbsolute(intentPath)&&!intentPath.split(/[\\/]/).some(p=>p.toLowerCase()==='memory.md')&&typeof spawnOriginal==='function'&&typeof perform==='function'&&typeof activeEndNs==='bigint'&&typeof hardEndNs==='bigint'&&activeEndNs<hardEndNs&&Number.isSafeInteger(cleanupCapMs)&&cleanupCapMs>0&&cleanupCapMs<=5000,'child_scope_invalid');
  const armed=await open(intentPath,'wx',0o600);
  try{await armed.writeFile(`${JSON.stringify({event:'original_helper_cleanup_prepared',atNs:process.hrtime.bigint().toString(),activeEndNs:activeEndNs.toString(),hardEndNs:hardEndNs.toString(),authority:'original-child-object-only',emergencyCapMs:cleanupCapMs,postDeadlineCleanupIsRed:true,allDescendantWaitClaim:false})}\n`);await armed.sync();}finally{await armed.close();}
  let child=null,result,primary=null,exit=null,closed=null,spawnError=false,outputExceeded=false;const pipes=[];
  let exitResolve,closeResolve,outputReject;const exitPromise=new Promise(r=>exitResolve=r),closePromise=new Promise(r=>closeResolve=r);
  const outputFailure=new Promise((_,reject)=>outputReject=reject);outputFailure.catch(()=>{});const stdout=[],stderr=[];let outputBytes=0;
  const capture=(array,chunk)=>{outputBytes+=chunk.length;if(outputBytes>1048576){outputExceeded=true;outputReject(Object.assign(new Error('helper_output_limit'),{fixedCode:'helper_output_limit'}));}else array.push(chunk);};
  async function bounded(promise,end,code){const now=process.hrtime.bigint();need(now<end,code);let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(code),{fixedCode:code})),Math.max(1,Number((end-now)/1000000n)));})]);}finally{clearTimeout(timer);}}
  const outcome={originalObjectControlled:false,helperExitObserved:false,helperCloseObserved:false,pipesClosedObserved:false,cleanupVerified:false,allDescendantWaitClaim:false};
  try{
    // The pre-spawn journal is the emergency authority. No later journal write
    // or deadline/parse/output exception can bypass this retained object finally.
    child=spawnOriginal();outcome.originalObjectControlled=true;
    child.once('exit',(code,signal)=>{exit={code,signal};exitResolve(exit);});
    child.once('close',(code,signal)=>{closed={code,signal};closeResolve(closed);});
    child.once('error',()=>{spawnError=!child.pid;if(spawnError)exitResolve(null);});
    for(const pipe of [child.stdin,child.stdout,child.stderr])if(pipe){const item={pipe,closed:pipe.closed===true};item.promise=item.closed?Promise.resolve():new Promise(resolve=>pipe.once('close',()=>{item.closed=true;resolve();}));pipes.push(item);}
    child.stdout?.on('data',chunk=>capture(stdout,chunk));child.stderr?.on('data',chunk=>capture(stderr,chunk));
    result=await perform({child,stdout,stderr,waitForExitAndClose:async()=>{
      await bounded(Promise.race([Promise.all([exitPromise,closePromise]),outputFailure]),activeEndNs,'helper_operation_deadline');
      acceptWindowsAcknowledgement(process.hrtime.bigint(),activeEndNs);need(!spawnError&&!outputExceeded&&exit?.code===0,'native_runner_failed');return {exit,closed};
    }});
    acceptWindowsAcknowledgement(process.hrtime.bigint(),activeEndNs);need(!outputExceeded,'helper_output_limit');
  }catch(error){primary=error;}
  finally{
    if(child!==null){
      const cleanupOrigin=process.hrtime.bigint();const ordinary=cleanupOrigin<hardEndNs;const capEnd=cleanupOrigin+BigInt(cleanupCapMs)*1000000n;
      const cleanupEnd=ordinary&&hardEndNs<capEnd?hardEndNs:capEnd;
      // Expired normal deadlines never suppress resource cleanup. This bounded
      // emergency grace is always RED and was disclosed before spawn.
      if(!ordinary&&!primary)primary=Object.assign(new Error('helper_cleanup_after_deadline'),{fixedCode:'helper_cleanup_after_deadline'});
      try{if(!exit&&!spawnError)child.kill();}catch(error){if(!primary)primary=Object.assign(new Error('helper_terminate_failed'),{fixedCode:'helper_terminate_failed'});}
      try{await bounded(Promise.all([exitPromise,closePromise]),cleanupEnd,'helper_cleanup_unverified');}catch(error){if(!primary)primary=error;}
      finally{
        // Every owned pipe is closed independently even when kill/wait fails.
        // A forced pipe close alone is never accepted as a child exit.
        for(const pipe of [child.stdin,child.stdout,child.stderr])try{if(pipe&&!pipe.destroyed)pipe.destroy();}catch(error){if(!primary)primary=Object.assign(new Error('helper_pipe_close_failed'),{fixedCode:'helper_pipe_close_failed'});}
        try{await bounded(Promise.all(pipes.map(item=>item.promise)),cleanupEnd,'helper_pipe_close_unverified');}catch(error){if(!primary)primary=error;}
        outcome.helperExitObserved=exit!==null;outcome.helperCloseObserved=closed!==null;
        outcome.pipesClosedObserved=pipes.every(item=>item.closed);
        outcome.cleanupVerified=(exit!==null||spawnError)&&closed!==null&&outcome.pipesClosedObserved;
      }
      if(!outcome.cleanupVerified&&!primary)primary=Object.assign(new Error('helper_cleanup_unverified'),{fixedCode:'helper_cleanup_unverified'});
    }
  }
  if(primary){Object.assign(primary,{cleanupEvidence:outcome});throw primary;}
  need(outcome.cleanupVerified,'helper_cleanup_unverified');return Object.freeze({value:result,...outcome});
}

export async function runWindowsNativeSixCases(config){
  assertWindowsRuntimeHost(); // before config getters, lookup, file IO or spawn.
  const {pwsh,kernel,runner,fixture,controllerRoot,ownedOutput,systemRoot,systemDrive,totalMs=210000}=config;
  need(Number.isSafeInteger(totalMs)&&totalMs>=60000&&totalMs<=240000,'budget_invalid');
  const origin=process.hrtime.bigint(),end=origin+BigInt(totalMs)*1000000n;
  need(typeof controllerRoot==='string'&&isAbsolute(controllerRoot)&&resolve(controllerRoot)===controllerRoot&&!controllerRoot.split(/[\\/]/).some(p=>p.toLowerCase()==='memory.md'),'controller_root_invalid');
  const parent=await lstat(controllerRoot);need(parent.isDirectory()&&!parent.isSymbolicLink(),'controller_root_invalid');
  need(ownedOutput===join(controllerRoot,'native-result'),'output_outside_owned_input');
  for(const spec of [pwsh,kernel,runner,fixture])await readPinnedRuntimeInput(spec);
  const home=join(controllerRoot,'helper-home');await mkdir(home,{mode:0o700});
  const settings={schemaVersion:1,sourcePath:kernel.path,sourceSha256:kernel.sha256,fixturePath:fixture.path,fixtureSha256:fixture.sha256,pwshPath:pwsh.path,pwshSha256:pwsh.sha256,ownedOutput,systemRoot,systemDrive};
  const configPath=join(controllerRoot,'native-input.json');await writeFile(configPath,JSON.stringify(settings),{flag:'wx',mode:0o600});
  const env={HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,TEMP:home,TMP:home,SystemRoot:systemRoot,SystemDrive:systemDrive,PATH:dirname(pwsh.path)};
  const operationEnd=windowsOperationEnd(process.hrtime.bigint(),end,totalMs-5000);
  const controlled=await withOwnedChildControl({intentPath:join(controllerRoot,'outer-helper-cleanup-intent.jsonl'),activeEndNs:operationEnd,hardEndNs:end,
    spawnOriginal:()=>spawn(pwsh.path,['-NoLogo','-NoProfile','-NonInteractive','-File',runner.path,'-ConfigPath',configPath],{cwd:controllerRoot,env,stdio:['ignore','pipe','pipe'],windowsHide:true}),
    perform:async scope=>{
      await scope.waitForExitAndClose();
      await writeFile(join(controllerRoot,'native-helper.stdout'),Buffer.concat(scope.stdout),{flag:'wx',mode:0o600});await writeFile(join(controllerRoot,'native-helper.stderr'),Buffer.concat(scope.stderr),{flag:'wx',mode:0o600});
  acceptWindowsAcknowledgement(process.hrtime.bigint(),operationEnd);
  for(const spec of [pwsh,kernel,runner,fixture])await readPinnedRuntimeInput(spec);
  const reportPath=join(ownedOutput,'result.json');const reportInfo=await lstat(reportPath);need(reportInfo.isFile()&&!reportInfo.isSymbolicLink()&&reportInfo.size<=131072,'native_report_file_invalid');
  const reportHandle=await open(reportPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let row;
  try{row=JSON.parse(await reportHandle.readFile({encoding:'utf8'}));}finally{await reportHandle.close();}
  const proof=validateWindowsNativeReport(row);let exactWaitCount=0;
  need(Array.isArray(row.journalPaths)&&row.journalPaths.length===6,'native_journal_paths_invalid');
  for(let i=0;i<6;i++){
    const expected=join(ownedOutput,`${CASE_NAMES[i]}.jsonl`);need(row.journalPaths[i]===expected,'native_journal_path_unbound');
    const info=await lstat(expected);need(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=4194304,'native_journal_file_invalid');
    const h=await open(expected,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let text;try{text=await h.readFile({encoding:'utf8'});}finally{await h.close();}
    need(text.endsWith('\n'),'journal_incomplete');const rows=text.slice(0,-1).split('\n').map(JSON.parse);const verified=verifyWindowsJournalRows(rows,{processProofs:row.cases[i].processProofs,expectedImageSha256:pwsh.sha256});need(verified.exactWaitCount===row.cases[i].exactWaits,'native_journal_count_unbound');
    const identity=p=>`${p.role}:${p.pid}:${p.creationTime}`;const actualWaits=rows.filter(r=>r.event==='exact_handle_wait').map(identity).sort();const expectedWaits=row.cases[i].processProofs.map(identity).sort();
    need(JSON.stringify(actualWaits)===JSON.stringify(expectedWaits)&&row.cases[i].processProofs.every(p=>p.image.toLowerCase()===pwsh.path.toLowerCase()&&p.imageSha256===pwsh.sha256),'native_process_waits_unbound');exactWaitCount+=verified.exactWaitCount;
  }
  need(exactWaitCount===proof.exactWaitCount,'native_total_waits_unbound');return {reportPath,proof};
    },
  });
  return Object.freeze({...controlled.value,helperExitObserved:controlled.helperExitObserved,helperCloseObserved:controlled.helperCloseObserved,pipesClosedObserved:controlled.pipesClosedObserved,cleanupVerified:controlled.cleanupVerified,allDescendantWaitClaim:false,helperDeathBeforeJobAssignmentNotProven:true,outerBootstrapAclVerified:false,fullGoal:false,appSession:false});
}
