// Invoked only by native suite with a fresh literal environment and owned root.
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,lstat } from 'node:fs/promises';
import { createLinuxProcessLifecycle,assertLinuxLaunchHost } from './linux-launch-lifecycle.mjs';
import { digest,freshEnvironment } from './lifecycle-core.mjs';
assertLinuxLaunchHost();
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const {caseName,ownedRoot,python,sourceRoot}=config;
const source=path=>({path,sha256:config.sourceHashes[path.split('/').at(-1)]});
const env=freshEnvironment(config.environment);
const cwd=`${ownedRoot}/cwd`;
const fixture=`${sourceRoot}/owned-child-fixture.py`;
const args=mode=>['-I','-B',fixture,mode];
let lifecycle,closure,primaryError=null;const proof={};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const output=`${ownedRoot}/controller-result.json`;
try{
 lifecycle=await createLinuxProcessLifecycle({ownedRoot,python,supervisor:source(`${sourceRoot}/linux-owned-supervisor.py`),identityBase:source(`${sourceRoot}/linux-identity-helper.py`),journalPath:`${ownedRoot}/lifecycle.jsonl`,environment:env,totalMs:30000,cleanupMs:5000});
 proof.helperIdentity=lifecycle.helperIdentity();
 if(caseName==='normal-stop'){
   const root=await lifecycle.launchDriver('driver-1',python,args('leaf'),cwd);
   const exact=await lifecycle.verify('driver-1');assert.equal(exact.pid,root.pid);
   await lifecycle.stopExact('driver-1','TERM');const reaped=await lifecycle.reap('driver-1',2000);assert.equal(reaped.reaped,true);proof.registeredRoot=true;proof.exactRootReaped=true;
 }else if(caseName==='root-crash-adoption'){
   const root=await lifecycle.launchDriver('driver-1',python,args('parent-two'),cwd);let children=[];
   for(let i=0;i<30;i++){children=await lifecycle.children('driver-1');if(children.length===2)break;await pause(20);}assert.equal(children.length,2);
   for(let i=0;i<2;i++)await lifecycle.pinSpecificDescendant(`child-${i+1}`,'driver-1',children[i],python,{args:args('leaf'),cwd});
   await lifecycle.stopExact('driver-1','KILL');assert.equal((await lifecycle.reap('driver-1',2000)).reaped,true);
   for(let i=0;i<2;i++){const adopted=await lifecycle.adopt(`child-${i+1}`);assert.equal(adopted.birthParentPid,root.pid);assert.equal(adopted.adopted,true);await lifecycle.stopExact(`child-${i+1}`,'TERM');assert.equal((await lifecycle.reap(`child-${i+1}`,2000)).reaped,true);}
   proof.controlledRootKilled=true;proof.prePinnedChildren=2;proof.adoptedChildren=2;proof.exactReapedCount=3;
 }else if(caseName==='rejected-target-birth'){
   await assert.rejects(lifecycle.rejectTargetAfterBirth('driver-1',python,args('parent-two'),cwd),e=>e.fixedCode==='target_proof_deliberately_rejected');
   await assert.rejects(lifecycle.launchDriver('driver-1',python,args('leaf'),cwd),e=>e.fixedCode==='role_invalid');
   proof.rejectedAfterPidfdBirth=true;proof.cleanupOnlyRetained=true;proof.attemptedRoleReuseRejected=true;
 }else if(caseName==='eof-emergency-cleanup'){
   await lifecycle.launchDriver('driver-1',python,args('parent-two'),cwd);let children=[];
   for(let i=0;i<30;i++){children=await lifecycle.children('driver-1');if(children.length===2)break;await pause(20);}assert.equal(children.length,2);
   proof.registeredRoot=true;proof.observedChildren=2;closure=await lifecycle.close({eof:true});proof.eofCleanupObserved=true;
 }else if(caseName==='fast-target-exit'){
   for(let i=0;i<5;i++){
     const role=`fast-${i+1}`;
     try{await lifecycle.launchDriver(role,python,args('exit'),cwd);await lifecycle.reap(role,2000);proof.boundBeforeExit=true;}catch(error){assert.equal(error.fixedCode,'target_exited_before_bind');proof.exitedBeforeBind=true;}
   }
   proof.fastExitHandled=true;proof.fastExitRepetitions=5;
 }else if(caseName==='unknown-authority-and-drift'){
   await assert.rejects(lifecycle.stopExact('not-owned','KILL'),e=>e.fixedCode==='role_unregistered');
   const other=`${ownedRoot}/other-cwd`;await mkdir(other,{mode:0o700});
   await lifecycle.launchDriver('driver-1',python,[...args('drift-cwd'),other],cwd);await pause(450);
   await assert.rejects(lifecycle.verify('driver-1'),e=>e.fixedCode==='inherited_cwd_changed');
   await assert.rejects(lifecycle.stopExact('driver-1','KILL'),e=>e.fixedCode==='inherited_cwd_changed');
   proof.unknownSignalRejected=true;proof.cwdDriftRejected=true;proof.driftRequiresCleanupOnly=true;
 }else throw new Error('case_invalid');
}catch(error){primaryError=error.fixedCode??'native_case_failed';}
finally{
 if(lifecycle&&!closure){try{closure=await lifecycle.close();}catch(error){primaryError??=error.fixedCode??'cleanup_failed';}}
}
let journal=[];try{journal=(await readFile(`${ownedRoot}/lifecycle.jsonl`,'utf8')).trim().split('\n').map(x=>JSON.parse(x));}catch{primaryError??='journal_missing';}
if(closure){assert.equal(closure.allReaped,true);assert.equal(closure.noDirectChildren,true);proof.cleanupComplete=true;proof.allReaped=true;proof.helperExitObserved=true;}
for(let i=0;i<journal.length;i++){assert.equal(journal[i].sequence,i+1);if(journal[i].event==='signal_dispatched'){assert.ok(i>0&&journal[i-1].event==='signal_prepared'&&journal[i-1].pid===journal[i].pid&&journal[i-1].signal===journal[i].signal);}}
if(closure){const reaped=journal.filter(row=>row.event==='process_reaped');assert.equal(new Set(reaped.map(row=>row.pid)).size,journal.at(-1).ownedCount);assert.ok(reaped.every(row=>row.waitpidExact===true));proof.exactWaitpidCount=reaped.length;proof.journalSignalsPreparedFirst=true;}
const result={name:caseName,passed:primaryError===null,failureCode:primaryError,...proof,journal};
await writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
process.exitCode=primaryError===null?0:1;
