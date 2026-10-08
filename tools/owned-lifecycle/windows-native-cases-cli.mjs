import {runWindowsNativeSixCases,assertWindowsRuntimeHost,fingerprintRuntimeInput,persistWindowsFailureDiagnostics,windowsFailureMetadata,assertWindowsDiagnosticDirectory} from './windows-owned-runtime.mjs';
import {mkdtemp,chmod} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
assertWindowsRuntimeHost(); // before argument access, filesystem or spawn.
const here=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--pwsh'||args[2]!=='--output-parent')throw new Error('usage_invalid');
const outputParent=args[3];await assertWindowsDiagnosticDirectory(outputParent);
const makeSpec=async path=>fingerprintRuntimeInput(resolve(path));
const kernel=await makeSpec(join(here,'windows-owned-kernel.cs'));
const runner=await makeSpec(join(here,'windows-native-sixcases.ps1'));
const fixture=await makeSpec(join(here,'windows-owned-fixture.ps1'));
const pwsh=await makeSpec(args[1]);
const controllerRoot=await mkdtemp(join(outputParent,'eastgenesis-windows-native-sixcases-'));await chmod(controllerRoot,0o700);
const ownedOutput=join(controllerRoot,'native-result');
try {
  const result=await runWindowsNativeSixCases({pwsh,kernel,runner,fixture,controllerRoot,ownedOutput,systemRoot:process.env.SystemRoot,systemDrive:process.env.SystemDrive});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}catch(error){
  const primary=windowsFailureMetadata(error);let diagnostics;
  try{diagnostics=await persistWindowsFailureDiagnostics(controllerRoot,error);}catch{diagnostics={...primary,diagnosticWrites:{stdout:'failed',stderr:'failed',outerFailure:'failed'}};}
  process.stderr.write(`${JSON.stringify({...primary,retainedOwnedControllerRoot:controllerRoot,diagnosticWrites:diagnostics.diagnosticWrites})}\n`);process.exitCode=1;
}
