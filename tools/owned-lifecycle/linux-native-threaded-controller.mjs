// Invoked only by native suite with a fresh literal environment and owned root.
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,lstat,open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createLinuxProcessLifecycle,assertLinuxLaunchHost } from './linux-launch-lifecycle.mjs';
import { digest,freshEnvironment } from './lifecycle-core.mjs';
assertLinuxLaunchHost();
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const {caseName,ownedRoot,python,sourceRoot}=config;
const source=path=>({path,sha256:config.sourceHashes[path.split('/').at(-1)]});
const env=freshEnvironment(config.environment);
const cwd=`${ownedRoot}/cwd`;
const fixture=`${sourceRoot}/linux-native-threaded-fixture.py`;
const args=mode=>['-I','-B',fixture,mode];
let lifecycle,closure,primaryError=null;const proof={};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const output=`${ownedRoot}/controller-result.json`;
try{
 lifecycle=await createLinuxProcessLifecycle({ownedRoot,python,supervisor:source(`${sourceRoot}/linux-owned-supervisor.py`),identityBase:source(`${sourceRoot}/linux-identity-helper.py`),journalPath:`${ownedRoot}/lifecycle.jsonl`,environment:env,totalMs:30000,cleanupMs:5000});
 proof.helperIdentity=lifecycle.helperIdentity();
 if(caseName!=='worker-thread-child')throw new Error('case_invalid');

   const readyPath=`${ownedRoot}/thread-child.json`;
   const root=await lifecycle.launchDriver('driver-1',python,[...args('worker-thread-two'),readyPath],cwd);
   let ready;
   for(let i=0;i<60;i++){
     try{const fd=await open(readyPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{const a=await fd.stat({bigint:true});assert.ok(a.isFile()&&a.uid===BigInt(process.getuid())&&a.nlink===1n&&a.size<=2048n);if((a.mode&0o777n)!==0o400n){assert.equal(a.mode&0o777n,0o600n);await pause(20);continue;}ready=JSON.parse(await fd.readFile('utf8'));const b=await fd.stat({bigint:true});assert.ok(['dev','ino','size','mode','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]));}finally{await fd.close();}break;}catch(e){if(e.code!=='ENOENT')throw e;await pause(20);}
   }
   assert.equal(ready?.parentPid,root.pid);assert.ok(Number.isSafeInteger(ready.workerTid)&&ready.workerTid!==root.pid);assert.deepEqual(ready.mainThreadChildren,[]);
   const children=await lifecycle.children('driver-1');assert.deepEqual(children,[...ready.children].sort((a,b)=>a-b));assert.equal(children.length,2);
   const bound=await lifecycle.pinSpecificDescendant('worker-child-1','driver-1',children[0],python,{args:args('leaf'),cwd});
   assert.equal(bound.executionAuthority,true);assert.equal(bound.cleanupAuthority,true);assert.equal(bound.birthParentPid,root.pid);
   // Leave child2 unregistered. close() must independently discover and retain
   // its worker-thread birth as cleanup-only, without execution authority.
   closure=await lifecycle.close();const child2=closure.records.find(x=>x.pid===children[1]);
   assert.equal(child2?.proof,'cleanup_only');assert.equal(child2.executionAuthority,false);assert.equal(child2.cleanupAuthority,true);assert.equal(child2.reaped,true);
   assert.ok(closure.records.every(x=>x.executionAuthority===false));
   proof.workerTid=ready.workerTid;proof.workerThreadObserved=true;proof.mainThreadChildrenEmpty=true;proof.threadedChildren=2;proof.prePinnedChildren=1;proof.cleanupOnlyChildren=1;proof.executionAndCleanupAuthoritySeparated=true;

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
