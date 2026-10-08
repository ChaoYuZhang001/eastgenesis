import {runWindowsNativeSixCases,assertWindowsRuntimeHost,fingerprintRuntimeInput} from './windows-owned-runtime.mjs';
import {mkdtemp,chmod,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
assertWindowsRuntimeHost(); // before argument access, filesystem or spawn.
const here=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--pwsh')throw new Error('usage_invalid');
const makeSpec=async path=>fingerprintRuntimeInput(resolve(path));
const kernel=await makeSpec(join(here,'windows-owned-kernel.cs'));
const runner=await makeSpec(join(here,'windows-native-sixcases.ps1'));
const fixture=await makeSpec(join(here,'windows-owned-fixture.ps1'));
const pwsh=await makeSpec(args[1]);
const controllerRoot=await mkdtemp(join(tmpdir(),'eastgenesis-windows-native-sixcases-'));await chmod(controllerRoot,0o700);
const ownedOutput=join(controllerRoot,'native-result');
try {
  const result=await runWindowsNativeSixCases({pwsh,kernel,runner,fixture,controllerRoot,ownedOutput,systemRoot:process.env.SystemRoot,systemDrive:process.env.SystemDrive});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}catch(error){
  await writeFile(join(controllerRoot,'outer-failure.json'),JSON.stringify({code:error.fixedCode??'windows_native_failed',nativeSucceeded:false,fullGoal:false,appSession:false,providerRequests:0}),{flag:'wx',mode:0o600});
  process.stderr.write(`${JSON.stringify({code:error.fixedCode??'windows_native_failed',retainedOwnedControllerRoot:controllerRoot,nativeSucceeded:false,fullGoal:false})}\n`);process.exitCode=1;
}
