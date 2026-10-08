// Actual Linux worker-thread subprocess fixture suite, never App/Provider/DB proof.
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,readFile,writeFile,copyFile,chmod,realpath,rm,lstat } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest,freshEnvironment } from './lifecycle-core.mjs';
const exec=promisify(execFile);
const options={};for(let i=2;i<process.argv.length;i+=2){if(!['--output','--python'].includes(process.argv[i])||!process.argv[i+1])throw new Error('arguments_invalid');options[process.argv[i]]=process.argv[i+1];}
if(process.platform!=='linux'){process.stdout.write(JSON.stringify({schemaVersion:1,platform:process.platform,nativeRun:false,passed:false,failed:1,skipped:0,fullGoal:false,failureCode:'platform_unsupported'})+'\n');process.exitCode=2;}
else{
 const sourceRoot=dirname(fileURLToPath(import.meta.url));const output=resolve(options['--output']??'linux-native-result.json');
 const cases=['worker-thread-child'];
 let python=options['--python'];if(!python){const resolved=await exec('/usr/bin/env',['-i','PATH=/usr/bin:/bin','/bin/sh','-c','command -v python3'],{timeout:2000,maxBuffer:4096});python=resolved.stdout.trim();}
 python=await realpath(python);const pythonSpec={path:python,sha256:digest(await readFile(python))};const node=await realpath(process.execPath);
 const files=['lifecycle-core.mjs','linux-identity-helper.py','linux-owned-supervisor.py','linux-launch-lifecycle.mjs','linux-native-threaded-controller.mjs','linux-native-threaded-fixture.py'];
 const commonFiles=files.slice(0,4),commonSourceSha256={};for(const name of commonFiles)commonSourceSha256[name]=digest(await readFile(`${sourceRoot}/${name}`));
 const results=[];let root;
 try{
  root=await mkdtemp('/tmp/eastgenesis-linux-native-');await chmod(root,0o700);
  for(const caseName of cases){
   const ownedRoot=`${root}/${caseName}`;await mkdir(ownedRoot,{mode:0o700});const copied=`${ownedRoot}/source`;await mkdir(copied,{mode:0o700});const hashes={};
   for(const name of files){await copyFile(`${sourceRoot}/${name}`,`${copied}/${name}`);await chmod(`${copied}/${name}`,0o600);hashes[name]=digest(await readFile(`${copied}/${name}`));}
   const paths={};for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR']){paths[key]=`${ownedRoot}/${key.toLowerCase()}`;await mkdir(paths[key],{mode:0o700});}
   await mkdir(`${ownedRoot}/cwd`,{mode:0o700});const env=freshEnvironment(paths);
   const input=`${ownedRoot}/case.json`;await writeFile(input,JSON.stringify({caseName,ownedRoot,python:pythonSpec,sourceRoot:copied,sourceHashes:hashes,environment:env}),{mode:0o600});
   let code=null;try{await exec(node,[`${copied}/linux-native-threaded-controller.mjs`,input],{env,cwd:copied,timeout:35000,killSignal:'SIGTERM',maxBuffer:65536});code=0;}catch(error){code=typeof error.code==='number'?error.code:1;}
   let result;try{result=JSON.parse(await readFile(`${ownedRoot}/controller-result.json`,'utf8'));}catch{result={name:caseName,passed:false,failureCode:'controller_result_missing',cleanupComplete:false,allReaped:false};}
   let sourceBindingsUnchanged=true;for(const name of files){try{const row=await lstat(`${copied}/${name}`);if(!row.isFile()||row.isSymbolicLink()||row.nlink!==1||row.uid!==process.getuid()||digest(await readFile(`${copied}/${name}`))!==hashes[name])sourceBindingsUnchanged=false;}catch{sourceBindingsUnchanged=false;}}
   result.sourceBindingsUnchanged=sourceBindingsUnchanged;result.passed=result.passed&&sourceBindingsUnchanged;if(!sourceBindingsUnchanged)result.failureCode='source_binding_changed';
   result.controllerExitCode=code;result.controllerExitObserved=code===0;result.passed=result.passed&&code===0;
   results.push(result);if(!result.cleanupComplete)break;
  }
 }catch{results.push({name:'suite-preparation',passed:false,failureCode:'native_suite_failed',cleanupComplete:false,allReaped:false});}
 // Preserve redacted records before deleting owned profiles. Never raw env,
 // arguments, secret values, unscoped process lists, stderr or source contents.
 let commonSourceUnchanged=true;for(const name of commonFiles)if(digest(await readFile(`${sourceRoot}/${name}`))!==commonSourceSha256[name])commonSourceUnchanged=false;
 const report={schemaVersion:1,platform:'linux',nativeRun:true,passed:commonSourceUnchanged&&results.length===cases.length&&results.every(x=>x.passed),failed:results.filter(x=>!x.passed).length,skipped:0,fullGoal:false,appSessionImplemented:false,providerRequests:0,databaseOpened:false,commonSourceSha256,commonSourceUnchanged,caseCount:results.length,cases:results,journals:results.map(x=>({caseName:x.name,rows:x.journal??[]}))};
 for(const item of report.cases)delete item.journal;
 await mkdir(dirname(output),{recursive:true});
 const casesPassed=report.passed;report.passed=false;report.ownedProfilesRemoved=false;
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 if(root&&results.every(x=>x.cleanupComplete)){
  try{await rm(root,{recursive:true,force:true});try{await lstat(root);}catch(error){if(error.code==='ENOENT')report.ownedProfilesRemoved=true;else throw error;}}
  catch{report.profileRemovalFailureCode='owned_profile_removal_unverified';}
 }
 report.passed=casesPassed&&report.ownedProfilesRemoved;
 if(!report.passed)report.failed=Math.max(1,report.failed);
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 process.stdout.write(JSON.stringify({nativeRun:true,passed:report.passed,failed:report.failed,caseCount:report.caseCount,fullGoal:false})+'\n');process.exitCode=report.passed?0:1;
}
