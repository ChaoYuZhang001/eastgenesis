// Actual Linux entry. Do not run this on a user's desktop or private profile.
import { open,lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createLinuxGoalRuntime,assertLinuxGoalHost } from './linux-goal-runtime.mjs';
import { runJourney } from './full-goal-webdriver-journey-v3.mjs';
import { need } from './lifecycle-core.mjs';

export async function executeOwnedFullGoal(config){
  assertLinuxGoalHost();let runtime=null,result=null,error=null,cleanupError=null;
  try{runtime=await createLinuxGoalRuntime(config);result=await runJourney(runtime,runtime.input);}
  catch(e){error=e.fixedCode??'full_goal_runtime_failed';}
  finally{if(runtime){try{await runtime.cleanup();}catch(e){cleanupError=e.fixedCode??'full_goal_cleanup_failed';}}}
  const evidence=runtime?.evidence()??{linuxNativeExecuted:false,appSessionsBound:0,realProviderRequests:0,cleanupComplete:false,authorizesResume:false};
  return {kind:'linux-owned-full-goal-known-final-v1',passed:error===null&&cleanupError===null&&result!==null&&evidence.cleanupComplete===true,code:error,cleanupCode:cleanupError,evidence,
    journey:result?{goalId:result.goalId,taskId:result.failed.currentRound.taskId,failed:result.failed,restarted:result.restarted,resumed:result.resumed,final:result.final,artifact:result.fileBefore,ledgerBeforeSha256:result.before.ledgerFingerprintSha256,ledgerAfterSha256:result.after.ledgerFingerprintSha256}:null,
    syntheticOnly:true,realProviderRequests:0,releaseProof:false,userConfirmationByHarness:true,authorizesResume:false};
}
if(process.argv[1]?.endsWith('/linux-full-goal-entry.mjs')){
  let output=null,rootFd=null;
  try{
    assertLinuxGoalHost();need(process.argv.length===5,'entry_arguments');const [ownedRuntimeRoot,configPath,outputPath]=process.argv.slice(2);need(ownedRuntimeRoot.startsWith('/')&&ownedRuntimeRoot.split('/').slice(1).every(x=>x!==''&&x!=='.'&&x!=='..'&&x.toLowerCase()!=='memory.md')&&configPath===`${ownedRuntimeRoot}/runtime-config.json`&&outputPath===`${ownedRuntimeRoot}/full-goal-result.json`,'entry_path_forbidden');
    let parent='';for(const part of ownedRuntimeRoot.split('/').slice(1)){parent+=`/${part}`;need(!(await lstat(parent)).isSymbolicLink(),'entry_parent_link');}
    rootFd=await open(ownedRuntimeRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const anchor=await rootFd.stat({bigint:true});need(anchor.isDirectory()&&anchor.uid===BigInt(process.getuid())&&(anchor.mode&0o777n)===0o700n,'entry_root_not_owned');
    const rootUnchanged=async()=>{const a=await rootFd.stat({bigint:true}),b=await lstat(ownedRuntimeRoot,{bigint:true});need(['dev','ino','uid','mode'].every(k=>a[k]===anchor[k]&&b[k]===anchor[k]),'entry_root_replaced');};await rootUnchanged();
    // The held directory, not a re-resolved user pathname, selects both leafs.
    const held=`/proc/self/fd/${rootFd.fd}`;
    const fd=await open(`${held}/runtime-config.json`,constants.O_RDONLY|constants.O_NOFOLLOW);let config;try{const a=await fd.stat({bigint:true});need(a.isFile()&&a.uid===BigInt(process.getuid())&&a.nlink===1n&&(a.mode&0o777n)===0o400n&&a.size<=65536n,'entry_config_not_owned');const bytes=await fd.readFile();const b=await fd.stat({bigint:true});need(['dev','ino','uid','mode','nlink','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k])&&bytes.length===Number(a.size),'entry_config_changed');await rootUnchanged();config=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));need(config.ownedRoot===ownedRuntimeRoot,'entry_config_wrong_root');}finally{await fd.close();}
    output=await executeOwnedFullGoal(config);await rootUnchanged();const out=await open(`${held}/full-goal-result.json`,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await out.writeFile(`${JSON.stringify(output,null,2)}\n`);await out.sync();await out.chmod(0o400);await rootUnchanged();}finally{await out.close();}
    process.stdout.write(JSON.stringify({kind:output.kind,passed:output.passed,code:output.code,cleanupCode:output.cleanupCode,appSessionsBound:output.evidence.appSessionsBound,realProviderRequests:0})+'\n');process.exitCode=output.passed?0:1;
  }catch(e){process.stdout.write(JSON.stringify({passed:false,code:e.fixedCode??'full_goal_entry_rejected',linuxNativeExecuted:output?.evidence?.linuxNativeExecuted??false,appSessionsBound:output?.evidence?.appSessionsBound??0,cleanupComplete:output?.evidence?.cleanupComplete??false,realProviderRequests:0})+'\n');process.exitCode=2;}
  finally{if(rootFd)await rootFd.close();}
}
