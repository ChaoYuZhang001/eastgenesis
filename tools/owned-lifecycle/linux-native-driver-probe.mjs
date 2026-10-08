// Runs a real owned Linux tauri-driver + WebKitWebDriver status-only probe.
// The platform guard runs before CLI paths, environment values or filesystem.
import { spawn } from 'node:child_process';
import { lstat,open,realpath,mkdtemp,mkdir,chmod,rm,writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{fixedCode:code});
const need=(value,code)=>{if(!value)throw fail(code);};
export function assertProbeHost(){need(process.platform==='linux','platform_unsupported');}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileBytes(path,{owner=false,executable=false,limit=268435456}={}){
  need(typeof path==='string'&&path.startsWith('/')&&await realpath(path)===path,'probe_path_not_canonical');
  let partPath='';for(const part of path.split('/').slice(1)){need(part&&part!=='.'&&part!=='..','probe_path_invalid');partPath+=`/${part}`;need(!(await lstat(partPath)).isSymbolicLink(),'probe_path_link');}
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const a=await fd.stat({bigint:true});need(a.isFile()&&a.nlink===1n&&a.size<=BigInt(limit)&&(!owner||a.uid===BigInt(process.getuid()))&&(!executable||(a.mode&0o111n)!==0n),'probe_file_invalid');const data=await fd.readFile();const b=await fd.stat({bigint:true});need(['dev','ino','size','mode','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]),'probe_file_changed');return{data,sha256:sha(data)};}finally{await fd.close();}
}
async function outputParent(path){
  need(typeof path==='string'&&path.startsWith('/')&&resolve(path)===path,'probe_output_invalid');
  const parent=dirname(path);let found;
  try{found=await lstat(parent);}catch(error){need(error.code==='ENOENT','probe_output_parent_invalid');await mkdir(parent,{mode:0o700});found=await lstat(parent);}
  need(await realpath(parent)===parent&&found.isDirectory()&&found.uid===process.getuid()&&(found.mode&0o777)===0o700,'probe_output_parent_not_owned');
  try{await lstat(path);throw fail('probe_output_already_exists');}catch(error){need(error.code==='ENOENT','probe_output_already_exists');}
}
function cli(){const argv=process.argv.slice(2);need(argv.length===8,'probe_arguments_invalid');const named={};for(let i=0;i<argv.length;i+=2){const key=argv[i];need(['--python','--tauri-driver','--native-driver','--output'].includes(key)&&!Object.hasOwn(named,key)&&argv[i+1],'probe_arguments_invalid');named[key]=argv[i+1];}return named;}
async function runChild(binary,args,env,cwd,overallEnd){
  const child=spawn(binary,args,{env,cwd,stdio:['ignore','pipe','pipe']});child.stderr.resume();let length=0,chunks=[],over=false;
  child.stdout.on('data',chunk=>{length+=chunk.length;if(length>2097152){over=true;chunks=[];}else if(!over)chunks.push(chunk);});
  const exitPromise=new Promise((resolve,reject)=>{child.once('error',()=>reject(fail('probe_controller_spawn_failed')));child.once('exit',(code,signal)=>resolve({code,signal}));});
  let observationTimer,timeoutStop=false;
  const remaining=()=>{const ms=Number((overallEnd-process.hrtime.bigint())/1000000n);need(ms>0,'probe_overall_deadline_exceeded');return ms;};
  let exit;
  try{
    exit=await Promise.race([exitPromise,new Promise((_,reject)=>{observationTimer=setTimeout(()=>reject(fail('probe_controller_observation_timeout')),Math.max(1,remaining()-20000));})]);
  }catch(error){
    clearTimeout(observationTimer);timeoutStop=true;
    // Only the original ChildProcess birth handle, never caller PID/name/group.
    // This outer observer is not the driver pidfd signal authority.
    child.kill('SIGTERM');
    let forceTimer,exitTimer;
    try{
      forceTimer=setTimeout(()=>child.kill('SIGKILL'),Math.max(1,remaining()-1000));
      await Promise.race([exitPromise,new Promise((_,reject)=>{exitTimer=setTimeout(()=>reject(fail('probe_controller_exit_unverified')),Math.max(1,remaining()));})]);
    }finally{clearTimeout(forceTimer);clearTimeout(exitTimer);}
    throw error;
  }finally{clearTimeout(observationTimer);}
  need(!timeoutStop&&process.hrtime.bigint()<overallEnd,'probe_controller_observation_timeout');
  need(!over,'probe_controller_output_too_large');let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('probe_controller_result_invalid');}
  return{exit,result};
}
export async function runNativeDriverProbe(options){
  assertProbeHost();
  const started=process.hrtime.bigint(),overallEnd=started+120000000000n;const checkOverall=()=>need(process.hrtime.bigint()<overallEnd,'probe_overall_deadline_exceeded');let ownedRoot=null,result=null,runtimeRemoved=false,output=null,controllerStarted=false;
  try{
    checkOverall();const args=options??cli();output=resolve(args['--output']);await outputParent(output);
    const pythonPath=await realpath(args['--python']),tauriPath=await realpath(args['--tauri-driver']),nativePath=await realpath(args['--native-driver']),nodePath=await realpath(process.execPath);
    const specs={};for(const[name,path]of Object.entries({python:pythonPath,tauri:tauriPath,native:nativePath,node:nodePath})){checkOverall();const entry=await fileBytes(path,{executable:true});checkOverall();specs[name]={path,sha256:entry.sha256};}
    ownedRoot=await mkdtemp('/tmp/eastgenesis-linux-owned-driver-');await chmod(ownedRoot,0o700);
    for(const name of['home','tmp','config','data','cache','runtime','cwd','inputs'])await mkdir(join(ownedRoot,name),{mode:0o700});
    const sourceRoot=dirname(fileURLToPath(import.meta.url));const sourceFiles=['lifecycle-core.mjs','linux-launch-lifecycle.mjs','linux-owned-supervisor.py','linux-identity-helper.py','linux-native-driver-probe-controller.mjs'];const copied=[];
    for(const name of sourceFiles){checkOverall();const source=join(sourceRoot,name);const bytes=await fileBytes(source);const destination=join(ownedRoot,'inputs',name);await writeFile(destination,bytes.data,{flag:'wx',mode:0o400});copied.push({name,source,copy:destination,sha256:bytes.sha256});}
    const env={PATH:'/usr/bin:/bin',HOME:join(ownedRoot,'home'),TMPDIR:join(ownedRoot,'tmp'),XDG_CONFIG_HOME:join(ownedRoot,'config'),XDG_DATA_HOME:join(ownedRoot,'data'),XDG_CACHE_HOME:join(ownedRoot,'cache'),XDG_RUNTIME_DIR:join(ownedRoot,'runtime'),LANG:'C.UTF-8',LC_ALL:'C.UTF-8',WEBKIT_DISABLE_COMPOSITING_MODE:'1',EASTGENESIS_QA_ISOLATED_PROFILE:'1'};
    const display=process.env.DISPLAY;need(typeof display==='string'&&/^:[0-9]{1,5}(?:\.0)?$/.test(display),'probe_display_not_ci_xvfb');env.DISPLAY=display;
    const sourceAuth=process.env.XAUTHORITY;need(typeof sourceAuth==='string'&&/^\/tmp\/xvfb-run\.[A-Za-z0-9]+\/Xauthority$/.test(sourceAuth),'probe_xauthority_not_ci_xvfb');
    const auth=await fileBytes(sourceAuth,{owner:true,limit:65536});const ownedAuth=join(ownedRoot,'xauthority');await writeFile(ownedAuth,auth.data,{flag:'wx',mode:0o600});env.XAUTHORITY=ownedAuth;
    const proxyPort=45871,nativePort=45872;const cwd=join(ownedRoot,'cwd');
    const config={ownedRoot,python:specs.python,tauri:specs.tauri,native:specs.native,supervisor:{path:join(ownedRoot,'inputs','linux-owned-supervisor.py'),sha256:copied.find(x=>x.name==='linux-owned-supervisor.py').sha256},identityBase:{path:join(ownedRoot,'inputs','linux-identity-helper.py'),sha256:copied.find(x=>x.name==='linux-identity-helper.py').sha256},journalPath:join(ownedRoot,'process-journal.jsonl'),httpJournalPath:join(ownedRoot,'http-journal.jsonl'),environment:env,totalMs:60000,cleanupMs:10000,cwd,proxyPort,nativePort,driverArgs:['--port',String(proxyPort),'--native-port',String(nativePort),'--native-host','127.0.0.1','--native-driver',nativePath],nativeArgs:[`--port=${nativePort}`,'--host=127.0.0.1']};
    need(overallEnd-process.hrtime.bigint()>=80000000000n,'probe_preparation_exhausted');controllerStarted=true;const launched=await runChild(nodePath,[join(ownedRoot,'inputs','linux-native-driver-probe-controller.mjs'),JSON.stringify(config)],env,cwd,overallEnd);checkOverall();result=launched.result;
    need(result.kind==='linux-native-owned-driver-probe'&&result.platform==='linux'&&result.nativeRun===true&&result.fullGoal===false&&result.appSession===false&&result.providerRequests===0&&result.databaseOpened===false,'probe_evidence_scope_invalid');
    need(result.observations?.controllerStatusGets===2&&result.observations?.controllerPosts===0&&result.observations?.controllerOtherRequests===0&&result.observations?.statusChecks?.length===2&&result.aggregateAllProcessHttpCountMeasured===false,'probe_controller_counts_invalid');
    result.controllerExitObserved=launched.exit.code!==null&&launched.exit.signal===null;result.controllerExitCode=launched.exit.code;
    result.inputSourcesBoundAtEnd=true;for(const entry of copied){checkOverall();need((await fileBytes(entry.source)).sha256===entry.sha256&&(await fileBytes(entry.copy,{owner:true})).sha256===entry.sha256,'probe_source_changed');}
    for(const spec of Object.values(specs)){checkOverall();need((await fileBytes(spec.path,{executable:true})).sha256===spec.sha256,'probe_binary_changed');}
    checkOverall();result.inputs={tauriBinarySha256:specs.tauri.sha256,nativeBinarySha256:specs.native.sha256,pythonBinarySha256:specs.python.sha256,nodeBinarySha256:specs.node.sha256,sourceCopies:copied.map(x=>({name:x.name,sha256:x.sha256})),actualXvfbAuthCopied:true,restrictedEnvironmentActualChecked:result.observations?.driverBound===true&&result.observations?.nativeBound===true};
    need(result.cleanupComplete===true&&result.helperExitObserved===true&&result.controllerExitObserved===true,'probe_cleanup_unverified');
    const beforeRemove=await lstat(ownedRoot);need(beforeRemove.isDirectory()&&beforeRemove.uid===process.getuid()&&(beforeRemove.mode&0o777)===0o700&&await realpath(ownedRoot)===ownedRoot,'probe_cleanup_root_changed');
    checkOverall();await rm(ownedRoot,{recursive:true});checkOverall();try{await lstat(ownedRoot);}catch(error){need(error.code==='ENOENT','probe_runtime_removal_unverified');runtimeRemoved=true;}
    need(runtimeRemoved,'probe_runtime_removal_unverified');result.runtimeRemoved=true;result.passed=result.passed===true&&launched.exit.code===0;
  }catch(error){
    const code=/^[a-z][a-z0-9_]{0,100}$/.test(error?.fixedCode??'')?error.fixedCode:'probe_preparation_failed';
    result={...(result??{}),schemaVersion:1,kind:'linux-native-owned-driver-probe',platform:'linux',passed:false,nativeRun:result?.nativeRun===true,fullGoal:false,appSession:false,providerRequests:0,databaseOpened:false,runtimeRemoved,errorCode:code};
    // Do not erase an unverified running process profile to make failure look clean.
    if(ownedRoot&&!controllerStarted){try{await rm(ownedRoot,{recursive:true});runtimeRemoved=true;result.runtimeRemoved=true;}catch{}}
  }
  result.elapsedMs=Number(process.hrtime.bigint()-started)/1000000;result.outerControllerSignalBoundary='original_childprocess_birth_handle_not_pidfd';result.driverSignalBoundary='supervisor_retained_pidfds';result.overallDeadlineMs=120000;
  if(output){const parent=dirname(output);const processRows=result.journalRows??[],httpRows=result.httpJournalRows??[];delete result.journalRows;delete result.httpJournalRows;
    await writeFile(join(parent,'driver-process-journal.jsonl'),processRows.map(row=>JSON.stringify(row)).join('\n')+(processRows.length?'\n':''),{flag:'wx',mode:0o400});
    await writeFile(join(parent,'driver-http-journal.jsonl'),httpRows.map(row=>JSON.stringify(row)).join('\n')+(httpRows.length?'\n':''),{flag:'wx',mode:0o400});
    await writeFile(output,`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o400});
  }
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.platform!=='linux'){process.stdout.write('{"kind":"linux-native-owned-driver-probe","platformRejected":true,"nativeRun":false,"errorCode":"platform_unsupported"}\n');process.exitCode=2;}
  else{try{const result=await runNativeDriverProbe();process.stdout.write(`${JSON.stringify({kind:result.kind,passed:result.passed,nativeRun:result.nativeRun,fullGoal:false})}\n`);process.exitCode=result.passed?0:1;}catch{process.stdout.write('{"kind":"linux-native-owned-driver-probe","passed":false,"errorCode":"probe_report_failed"}\n');process.exitCode=1;}}
}
