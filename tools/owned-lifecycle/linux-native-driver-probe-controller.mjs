// Real Linux drivers only. No WebDriver session, App, database or Provider call.
import { createLinuxProcessLifecycle } from './linux-launch-lifecycle.mjs';
import { need,digest } from './lifecycle-core.mjs';
import { open,lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';

let lifecycle=null,closed=null,errorCode=null,closeErrorEvidence=null;
const observations={controllerStatusGets:0,controllerPosts:0,controllerOtherRequests:0,statusChecks:[],signalRecords:[],driverBound:false,nativeBound:false,ownedBirthRecords:[],portsReboundAndReleased:false,helperBirthIdentity:null};
let httpJournal=null,httpSequence=0;
const config=JSON.parse(process.argv[2]);
const journalRows=[];
async function journal(event,fields={}) {
  const row={sequence:++httpSequence,atNs:process.hrtime.bigint().toString(),event,...fields};
  const data=Buffer.from(`${JSON.stringify(row)}\n`);need(data.length<=8192,'probe_journal_row_invalid');
  let offset=0;while(offset<data.length){const row=await httpJournal.write(data,offset,data.length-offset,null);need(row.bytesWritten>0,'probe_journal_write_incomplete');offset+=row.bytesWritten;}await httpJournal.sync();journalRows.push(row);
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function portProofs() {
  const first=await lifecycle.provePort('tauri_driver',config.proxyPort);
  const second=await lifecycle.provePort('native_driver',config.nativePort);
  need(first.address==='127.0.0.1'&&second.address==='127.0.0.1','driver_port_address_invalid');
  return {proxy:first,native:second};
}
async function observePorts() {
  while(true){
    need(lifecycle.remainingActiveMs()>2500,'driver_ports_not_ready');
    try{return await portProofs();}catch(error){
      need(['control_port_not_owned'].includes(error.fixedCode),'driver_port_proof_rejected');
      await sleep(50);
    }
  }
}
async function status(role,port) {
  const before=await portProofs();
  need(observations.controllerStatusGets<2,'driver_status_budget_exceeded');
  const timeout=Math.floor(Math.min(1500,lifecycle.remainingActiveMs()-1000));need(timeout>0,'driver_status_deadline_exhausted');const operationEnd=process.hrtime.bigint()+BigInt(timeout)*1000000n;const assertAckTime=()=>need(process.hrtime.bigint()<operationEnd&&lifecycle.remainingActiveMs()>0,'driver_status_late_ack');
  await journal('http_dispatch_prepared',{requestId:observations.controllerStatusGets+1,method:'GET',route:'status',targetRole:role,port,socketInode:role==='tauri_driver'?before.proxy.inode:before.native.inode});
  observations.controllerStatusGets++;
  const received=await new Promise((resolve,reject)=>{
    let bytes=0,chunks=[],settled=false;const rejectOnce=code=>{if(!settled){settled=true;reject(Object.assign(new Error(code),{fixedCode:code}));}};
    const req=httpRequest({host:'127.0.0.1',port,path:'/status',method:'GET',agent:false,headers:{Connection:'close'}},res=>{
      if(res.statusCode!==200){res.resume();req.destroy(Object.assign(new Error('driver_status_http_not_200'),{fixedCode:'driver_status_http_not_200'}));return;}
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){req.destroy(new Error('driver_status_body_too_large'));return;}chunks.push(chunk);});
      res.on('end',()=>{if(!settled){settled=true;resolve({body:Buffer.concat(chunks),statusCode:res.statusCode});}});
      res.once('error',()=>rejectOnce('driver_status_read_failed'));res.once('aborted',()=>rejectOnce('driver_status_aborted'));res.once('close',()=>{if(!res.complete)rejectOnce('driver_status_truncated');});
    });
    const timer=setTimeout(()=>req.destroy(Object.assign(new Error('driver_status_timeout'),{fixedCode:'driver_status_timeout'})),timeout);
    req.once('error',()=>{if(!settled){settled=true;clearTimeout(timer);reject(Object.assign(new Error('driver_status_transport_failed'),{fixedCode:'driver_status_transport_failed'}));}});
    req.once('close',()=>{clearTimeout(timer);if(!settled)rejectOnce('driver_status_closed_before_complete');});req.end();
  });
  assertAckTime();const value=JSON.parse(received.body.toString('utf8'));need(value&&typeof value==='object'&&!Array.isArray(value)&&value.value&&value.value.ready===true,'driver_status_not_ready');
  const after=await portProofs();assertAckTime();
  need(digest(before)===digest(after),'driver_port_owner_changed_at_ack');
  const row={role,ready:true,httpStatus:received.statusCode,bodyBytes:received.body.length,bodySha256:digest(received.body),portOwnerBeforeAndAfter:true,portProofBefore:before,portProofAfter:after};
  observations.statusChecks.push(row);assertAckTime();await journal('http_ack_bound',{requestId:observations.controllerStatusGets,targetRole:role,ready:true,bodySha256:row.bodySha256});assertAckTime();
}
try {
  need(process.platform==='linux','platform_unsupported');
  const parent=await lstat(config.ownedRoot);need(parent.isDirectory()&&(parent.mode&0o777)===0o700&&parent.uid===process.getuid(),'probe_root_not_owned');
  httpJournal=await open(config.httpJournalPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
  lifecycle=await createLinuxProcessLifecycle(config);const helper=lifecycle.helperIdentity();observations.helperBirthIdentity={pid:helper.pid,parentPid:helper.parentPid,startTicks:helper.startTicks,uid:helper.uid,executableHash:helper.exe.sha256};
  const root=await lifecycle.launchDriver('tauri_driver',config.tauri,config.driverArgs,config.cwd);
  observations.driverBound=true;observations.ownedBirthRecords.push(root);
  while(!observations.nativeBound){
    need(lifecycle.remainingActiveMs()>5000,'native_driver_bind_timeout');
    const children=await lifecycle.children('tauri_driver');
    need(children.length<=8,'native_driver_children_invalid');
    if(children.length===0){await sleep(25);continue;}
    // Exact kernel direct-child list plus unique executable/argv/env/CWD match.
    // Siblings never authorize selection by first PID or a process-name scan.
    const native=await lifecycle.pinUniqueDescendant('native_driver','tauri_driver',config.native,{args:config.nativeArgs,cwd:config.cwd,environmentAdditions:{TAURI_AUTOMATION:'true',TAURI_WEBVIEW_AUTOMATION:'true'}});
    need(native.parentPid===root.pid,'native_driver_parent_unbound');observations.nativeBound=true;observations.ownedBirthRecords.push(native);
  }
  await observePorts();
  await status('native_driver',config.nativePort);await status('tauri_driver',config.proxyPort);
  observations.signalRecords.push(await lifecycle.stopExact('tauri_driver','KILL'));
  await lifecycle.reap('tauri_driver',1500);
  await lifecycle.adopt('native_driver');
  observations.signalRecords.push(await lifecycle.stopExact('native_driver','TERM'));
  await lifecycle.reap('native_driver',1500);
} catch(error) {errorCode=/^[a-z][a-z0-9_]{0,100}$/.test(error?.fixedCode??'')?error.fixedCode:'driver_probe_failed';}
finally {
  if(lifecycle){try{closed=await lifecycle.close();}catch(error){closeErrorEvidence={cleanupVerified:error?.cleanupVerified===true,code:/^[a-z][a-z0-9_]{0,100}$/.test(error?.fixedCode??'')?error.fixedCode:'driver_probe_cleanup_unverified'};errorCode??=closeErrorEvidence.code;}}
  if(httpJournal)await httpJournal.close().catch(()=>{});
}
if(closed?.allReaped===true&&closed?.helperExitObserved===true){
  try{
    for(const port of[config.proxyPort,config.nativePort]){
      const server=createServer(),abort=new AbortController();let closed=false;
      const closing=new Promise(resolve=>server.once('close',()=>{closed=true;resolve();}));
      let timer;
      try{
        await new Promise((resolve,reject)=>{
          server.once('error',()=>reject(Object.assign(new Error('port_release_unverified'),{fixedCode:'port_release_unverified'})));
          timer=setTimeout(()=>{abort.abort();reject(Object.assign(new Error('port_release_unverified'),{fixedCode:'port_release_unverified'}));},1000);
          server.listen({host:'127.0.0.1',port,exclusive:true,signal:abort.signal},resolve);
        });
      }finally{
        clearTimeout(timer);abort.abort();
        if(!closed)await Promise.race([closing,new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error('port_release_close_unverified'),{fixedCode:'port_release_close_unverified'})),1000))]);
      }
    }
    observations.portsReboundAndReleased=true;
  }catch{errorCode??='port_release_unverified';}
}
const result={schemaVersion:1,kind:'linux-native-owned-driver-probe',platform:'linux',nativeRun:true,passed:errorCode===null&&closed?.allReaped===true&&closed?.helperExitObserved===true&&observations.statusChecks.length===2&&observations.controllerStatusGets===2&&observations.controllerPosts===0&&observations.controllerOtherRequests===0&&observations.portsReboundAndReleased===true,fullGoal:false,appSession:false,providerRequests:0,databaseOpened:false,aggregateAllProcessHttpCountMeasured:false,proxyNativeForwardingAdditionalGet:true,globalProcessScanning:false,groupKill:false,observations,cleanupComplete:closed?.allReaped===true&&closed?.noDirectChildren===true,helperExitObserved:closed?.helperExitObserved===true,terminalRecords:closed?.records??[],closeErrorEvidence,journalRows:closed?.journalRows??[],httpJournalRows:journalRows,...(errorCode?{errorCode}:{})};
process.stdout.write(`${JSON.stringify(result)}\n`);process.exitCode=result.passed?0:1;
