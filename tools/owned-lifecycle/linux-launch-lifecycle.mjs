// Actual Linux process birth/adoption/reaping capability; import is inert.
// This does not implement WebDriver sessions, compiled App isolation or Goal.
import { spawn } from 'node:child_process';
import { lstat,open,realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname,basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digest,need,fault,freshEnvironment,assertControllerEnvironment } from './lifecycle-core.mjs';

export function assertLinuxLaunchHost(){need(process.platform==='linux','platform_unsupported');}
// Pure deadline policy is exported for negative tests. It grants no OS authority.
export function nativeOperationWindow(nowNs,globalEndNs,capMs){
  need(typeof nowNs==='bigint'&&typeof globalEndNs==='bigint'&&Number.isSafeInteger(capMs)&&capMs>0&&capMs<=300000,'operation_window_invalid');
  need(nowNs<globalEndNs,'global_deadline_exceeded');
  const localEnd=nowNs+BigInt(capMs)*1000000n;
  return localEnd<globalEndNs?localEnd:globalEndNs;
}
export function acceptNativeAcknowledgement(endNs,atNs){
  need(typeof endNs==='bigint'&&typeof atNs==='bigint'&&atNs<endNs,'supervisor_reply_late');
}
function validateJournalIdentity(row){
  need(row&&typeof row.dev==='string'&&/^(0|[1-9][0-9]*)$/.test(row.dev)&&typeof row.ino==='string'&&/^[1-9][0-9]*$/.test(row.ino)&&row.uid===process.getuid()&&Number.isSafeInteger(row.mode)&&(row.mode&0o777)===0o600&&row.nlink===1,'journal_anchor_invalid');
  return Object.freeze({...row});
}
async function noLinkPath(path){
  need(typeof path==='string'&&path.startsWith('/')&&basename(path).toLowerCase()!=='memory.md','input_path_invalid');
  let partPath='';
  for(const part of path.split('/').slice(1)){
    need(part!==''&&part!=='.'&&part!=='..','input_path_invalid');
    partPath+=`/${part}`;need(!(await lstat(partPath)).isSymbolicLink(),'input_path_link');
  }
}
// Actual filesystem readback is testable independently. The native factory
// alone obtains the anchor from its pinned supervisor; a fixture anchor never
// authorizes signals or supplies a native cleanup capability.
export async function readOwnedLifecycleJournal(path,identity,{originNs=0n,hardEndNs=(1n<<63n)-1n}={}){
  identity=validateJournalIdentity(identity);await noLinkPath(path);
  const parent=await lstat(dirname(path));need(parent.isDirectory()&&parent.uid===process.getuid()&&(parent.mode&0o777)===0o700,'journal_parent_not_owned');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const cap=4194304n;
  try{
    const a=await fd.stat({bigint:true});
    need(a.isFile()&&a.nlink===1n&&a.uid===BigInt(identity.uid)&&(a.mode&0o777n)===0o600n&&a.dev.toString()===identity.dev&&a.ino.toString()===identity.ino&&a.size>0n&&a.size<=cap,'journal_identity_changed');
    const length=Number(a.size);const bytes=Buffer.alloc(length+1);let offset=0;
    while(offset<bytes.length){const read=await fd.read(bytes,offset,bytes.length-offset,null);if(read.bytesRead===0)break;offset+=read.bytesRead;}
    const b=await fd.stat({bigint:true});
    need(offset===length&&['dev','ino','uid','nlink','mode','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]),'journal_changed_during_read');
    await noLinkPath(path);const named=await lstat(path,{bigint:true});
    need(['dev','ino','uid','nlink','mode','size','mtimeNs','ctimeNs'].every(k=>b[k]===named[k]),'journal_path_replaced');
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));
    need(raw.endsWith('\n'),'journal_incomplete_line');const lines=raw.slice(0,-1).split('\n');
    need(lines.length>0&&lines.length<=4096&&lines.every(line=>Buffer.byteLength(line)>0&&Buffer.byteLength(line)<=8192),'journal_rows_invalid');
    const rows=lines.map(line=>JSON.parse(line));let lastAt=originNs;
    for(let i=0;i<rows.length;i++){
      const row=rows[i];need(row&&Object.getPrototypeOf(row)===Object.prototype&&row.sequence===i+1&&typeof row.event==='string'&&/^[a-z_]{1,64}$/.test(row.event)&&typeof row.atNs==='string'&&/^[0-9]+$/.test(row.atNs),'journal_rows_invalid');
      const at=BigInt(row.atNs);need(at>=lastAt&&at>=originNs&&at<hardEndNs,'journal_clock_invalid');lastAt=at;
    }
    const last=rows.at(-1);
    need(last.event==='cleanup_complete'&&last.allReaped===true&&last.unknownCount===0&&Array.isArray(last.failureCodes)&&last.failureCodes.length===0,'cleanup_journal_unverified');
    return rows;
  }finally{await fd.close();}
}
async function checkedFile(spec,{owner=false,executable=false}={}) {
  need(spec&&typeof spec.path==='string'&&spec.path.startsWith('/')&&/^[a-f0-9]{64}$/.test(spec.sha256),'input_spec_invalid');
  need(basename(spec.path).toLowerCase()!=='memory.md','input_path_forbidden');
  need(await realpath(spec.path)===spec.path,'input_path_link');
  await noLinkPath(spec.path);
  const fd=await open(spec.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=await fd.stat({bigint:true});need(before.isFile()&&before.nlink===1n&&(!owner||before.uid===BigInt(process.getuid()))&&(!executable||(before.mode&0o111n)!==0n)&&before.size<=268435456n,'input_not_regular');const bytes=await fd.readFile();const after=await fd.stat({bigint:true});need(['dev','ino','mode','size','mtimeNs','ctimeNs'].every(k=>before[k]===after[k])&&digest(bytes)===spec.sha256,'input_changed');}finally{await fd.close();}
}

export async function createLinuxProcessLifecycle(config){
  assertLinuxLaunchHost(); // before config getters, filesystem, proc, spawn, network.
  const {ownedRoot,python,supervisor,identityBase,journalPath,totalMs=30000,cleanupMs=5000}=config;
  need(Number.isSafeInteger(totalMs)&&totalMs>=10000&&totalMs<=300000&&Number.isSafeInteger(cleanupMs)&&cleanupMs>=2000&&cleanupMs<=10000&&cleanupMs<totalMs,'budget_invalid');
  const origin=process.hrtime.bigint();const hardEnd=origin+BigInt(totalMs)*1000000n;const activeEnd=hardEnd-BigInt(cleanupMs)*1000000n;
  const env=freshEnvironment(config.environment);assertControllerEnvironment(process.env,env);
  need(await realpath(ownedRoot)===ownedRoot,'owned_root_link');const root=await lstat(ownedRoot);need(root.isDirectory()&&root.uid===process.getuid()&&(root.mode&0o777)===0o700,'owned_root_invalid');
  need(supervisor.path.startsWith(`${ownedRoot}/`)&&identityBase.path===`${dirname(supervisor.path)}/linux-identity-helper.py`&&journalPath.startsWith(`${ownedRoot}/`),'source_outside_owned_root');
  await checkedFile(python,{executable:true});await checkedFile(supervisor,{owner:true});await checkedFile(identityBase,{owner:true});
  need(process.hrtime.bigint()<activeEnd,'global_deadline_exceeded');const channel=randomBytes(32).toString('hex');
  const child=spawn(python.path,['-I','-B','-u',supervisor.path,JSON.stringify({ownerPid:process.pid,originNs:origin.toString(),hardEndNs:hardEnd.toString(),cleanupMs,ownedRoot,journalPath,python,channel})],{env,cwd:dirname(supervisor.path),stdio:['pipe','pipe','pipe']});
  child.stderr.resume();let pending=null,seq=0,ready=null,failed=false,closing=false,exitResult=null,journalIdentity=null;let readyResolve,readyReject;
  const readyPromise=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const exitPromise=new Promise(resolve=>{child.once('exit',(code,signal)=>{exitResult={code,signal};resolve(exitResult);});child.once('error',()=>{exitResult={code:null,signal:null};resolve(exitResult);});});
  let buffer=Buffer.alloc(0);let receivedBytes=0;
  function rejectAll(code='supervisor_channel_failed'){failed=true;readyReject(fault(code));if(pending){clearTimeout(pending.timer);pending.reject(fault(code));pending=null;}if(!child.stdin.destroyed)child.stdin.end();}
  child.once('error',()=>rejectAll());child.once('exit',()=>{if(!ready||pending)rejectAll();});
  function consumeLine(bytes){
    need(bytes.length>0&&bytes.length<=65536,'supervisor_reply_too_large');const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    need(row&&row.channel===channel,'supervisor_channel_mismatch');
    if(!ready){
      need(row.status==='ready'&&row.helper?.pid===child.pid&&row.helper.parentPid===process.pid&&row.sourceSha256===supervisor.sha256&&row.subreaper===true&&row.originNs===origin.toString()&&row.hardEndNs===hardEnd.toString(),'supervisor_ready_unbound');
      acceptNativeAcknowledgement(readyEnd,process.hrtime.bigint());journalIdentity=validateJournalIdentity(row.journalIdentity);ready=row;readyResolve(row);return;
    }
    need(pending&&row.seq===pending.seq,'supervisor_reply_unexpected');
    need(row.status==='ok'||row.status==='rejected','supervisor_reply_invalid');
    const p=pending;pending=null;clearTimeout(p.timer);
    // The local deadline applies to both success and rejected acknowledgements.
    // A delayed timer callback cannot turn a late reply into accepted evidence.
    try{acceptNativeAcknowledgement(p.endNs,process.hrtime.bigint());}
    catch(error){failed=true;child.stdin.end();p.reject(error);return;}
    if(row.status==='ok')p.resolve(row.value);
    else p.reject(fault(typeof row.code==='string'&&/^[a-z_]{1,96}$/.test(row.code)?row.code:'supervisor_operation_rejected'));
  }
  function onData(chunk){
    if(failed)return;
    try{
      receivedBytes+=chunk.length;need(receivedBytes<=8388608,'supervisor_output_limit');
      buffer=Buffer.concat([buffer,chunk]);let newline;
      while((newline=buffer.indexOf(10))!==-1){const line=buffer.subarray(0,newline);buffer=buffer.subarray(newline+1);consumeLine(line);if(failed)return;}
      need(buffer.length<=65536,'supervisor_reply_too_large');
    }catch{rejectAll();}
  }
  child.stdout.on('data',onData);child.stdout.once('end',()=>{if(buffer.length||(!exitResult&&pending))rejectAll();});
  const msUntil=end=>{const remaining=end-process.hrtime.bigint();need(remaining>0n,'global_deadline_exceeded');return Number(remaining/1000000n);};
  async function observeExit(){let timer;try{const result=exitResult??await Promise.race([exitPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('supervisor_exit_unverified')),Math.max(1,msUntil(hardEnd)));})]);need(result.code===0,'supervisor_cleanup_unverified');return result;}finally{clearTimeout(timer);child.stdout.removeListener('data',onData);child.stdout.resume();}}
  let timer;
  const readyEnd=nativeOperationWindow(process.hrtime.bigint(),activeEnd,5000);
  try{await Promise.race([readyPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('supervisor_ready_timeout')),Math.max(1,msUntil(readyEnd)));})]);}catch(error){rejectAll();await observeExit().catch(()=>{});throw error;}finally{clearTimeout(timer);}
  async function request(operation,data={}){
    need(!failed&&!closing&&!pending&&!exitResult,'supervisor_channel_unavailable');const globalEnd=operation==='close'?hardEnd:activeEnd;const cap=operation==='launch'||operation==='launch_reject_proof'?8000:operation==='close'?cleanupMs:5000;
    const end=nativeOperationWindow(process.hrtime.bigint(),globalEnd,cap);const timeoutMs=Math.max(1,msUntil(end));const id=seq+1;
    const bytes=Buffer.from(`${JSON.stringify({channel,seq:id,operation,...data})}\n`);need(bytes.length<=65536,'supervisor_request_too_large');
    seq=id;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending=null;failed=true;child.stdin.end();reject(fault('supervisor_reply_late_or_missing'));},timeoutMs);pending={seq:id,timer,endNs:end,resolve,reject};child.stdin.write(bytes,error=>{if(error)rejectAll();});});
  }
  async function close({eof=false}={}){
    let result,originalError;
    try{if(!eof)result=await request('close');}
    catch(error){originalError=error;}
    finally{closing=true;if(pending){clearTimeout(pending.timer);pending.reject(fault('supervisor_closed'));pending=null;}if(!child.stdin.destroyed)child.stdin.end();}
    // A close-request error never skips actual terminal observation. Successful
    // EOF cleanup is useful evidence, while the original failed request stays RED.
    let cleanupError,rows;
    try{
      await observeExit();await checkedFile(supervisor,{owner:true});await checkedFile(identityBase,{owner:true});
      if(result?.journalIdentity){const finalAnchor=validateJournalIdentity(result.journalIdentity);need(['dev','ino','uid','mode','nlink'].every(key=>finalAnchor[key]===journalIdentity[key]),'journal_anchor_changed');}
      rows=await readOwnedLifecycleJournal(journalPath,journalIdentity,{originNs:origin,hardEndNs:hardEnd});
    }catch(error){cleanupError=error;}
    if(originalError){originalError.cleanupVerified=!cleanupError;if(cleanupError)originalError.cleanupFailureCode=cleanupError.fixedCode??'cleanup_verification_failed';throw originalError;}
    if(cleanupError)throw cleanupError;
    need(process.hrtime.bigint()<hardEnd,'cleanup_deadline_exceeded');
    return Object.freeze({...(result??{}),helperExitObserved:true,journalRows:rows,allReaped:true,noDirectChildren:true,fullGoal:false,appSessionImplemented:false});
  }
  return Object.freeze({
    launchDriver:(role,executable,args,cwd)=>request('launch',{role,executable,args,env,cwd}),
    rejectTargetAfterBirth:(role,executable,args,cwd)=>request('launch_reject_proof',{role,executable,args,env,cwd}),
    children:role=>request('children',{role}),
    pinSpecificDescendant:(role,parentRole,pid,executable,proof)=>request('pin',{role,parentRole,pid,executable,proof}),
    pinUniqueDescendant:(role,parentRole,executable,proof)=>request('pin_unique',{role,parentRole,executable,proof}),
    verify:role=>request('verify',{role}),
    provePort:(role,port)=>request('port',{role,port}),
    stopExact:(role,signal='TERM')=>request('signal',{role,signal}),
    adopt:role=>request('adopt',{role}),
    reap:(role,maxMs=1000)=>request('reap',{role,maxMs}),
    snapshot:()=>request('snapshot'),
    helperIdentity:()=>structuredClone(ready.helper),
    remainingActiveMs:()=>Math.max(0,Number(activeEnd-process.hrtime.bigint())/1000000),
    close,
    boundary:Object.freeze({genericLauncherImplemented:true,linuxNativeExecuted:false,fullGoalImplemented:false,appSessionImplemented:false,providerRequests:0,databaseOpened:false}),
  });
}
