# Separate expected-RED fault candidate. Never added to the positive six counts.
param([Parameter(Mandatory=$true)][string]$ConfigPath)
if(-not $IsWindows){throw 'platform_unsupported'}
$ErrorActionPreference='Stop'
if([IO.Path]::GetFileName($ConfigPath) -ieq 'MEMORY.md'){throw 'input_forbidden'}
$configuration=[IO.File]::ReadAllText($ConfigPath)|ConvertFrom-Json
foreach($pair in @(@('sourcePath','sourceSha256'),@('fixturePath','fixtureSha256'),@('pwshPath','pwshSha256'))){
  $path=$configuration.($pair[0])
  if([IO.Path]::GetFileName($path) -ieq 'MEMORY.md' -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configuration.($pair[1])){throw 'source_unbound'}
}
if($null -eq ('EastGenesisOwnedWindows.Lifecycle' -as [type])){Add-Type -Path $configuration.sourcePath}
function Fault-Code($Record){$e=$Record.Exception;for($i=0;$i -lt 5 -and $null -ne $e.InnerException -and $e -isnot [EastGenesisOwnedWindows.ProofFailure];$i++){$e=$e.InnerException};if($e -is [EastGenesisOwnedWindows.ProofFailure]){return $e.Code};return 'unexpected_fault_failure'}
function Require([bool]$Condition,[string]$Code){if(-not $Condition){throw $Code}}
$output=[EastGenesisOwnedWindows.OwnedDirectory]::Create($configuration.ownedOutput+'-expected-red')
$cases=[Collections.Generic.List[object]]::new()
$faultNames=@('after_create_before_proof','registered_before_job','constructor_after_job','constructor_journal_flush','close_flush','unknown_descendant_history')
foreach($faultName in $faultNames){
  $profile=Join-Path ([IO.Path]::GetDirectoryName($configuration.ownedOutput)) ('eg-win-expected-red-'+[Guid]::NewGuid().ToString('N'))
  $root=[EastGenesisOwnedWindows.OwnedDirectory]::Create($profile);$lifecycle=$null;$observed=$null;$asserted=$false;$originalExitObserved=$false;$rollback=$false
  $fixture=$root.Leaf('owned-fixture.ps1');[IO.File]::WriteAllBytes($fixture,[IO.File]::ReadAllBytes($configuration.fixturePath));$root.AssertOwnedFile('owned-fixture.ps1')
  $token=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
  $environment=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  foreach($key in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','EG_OWNED_ROOT')){$environment.Add($key,$root.PathName)}
  $environment.Add('EG_FIXTURE_TOKEN',$token);$environment.Add('SystemRoot',$configuration.systemRoot);$environment.Add('SystemDrive',$configuration.systemDrive);$environment.Add('PATH',[IO.Path]::GetDirectoryName($configuration.pwshPath))
  try{
    $nativeFault=if($faultName -eq 'unknown_descendant_history'){$null}else{$faultName}
    $lifecycle=[EastGenesisOwnedWindows.Lifecycle]::new($root,'lifecycle.jsonl',45000,8000,$nativeFault)
    if($faultName -notlike 'constructor_*'){
      $mode=if($faultName -eq 'unknown_descendant_history'){'parent'}else{'leaf'}
      $launchArguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',$fixture,'-Mode',$mode,'-Root',$root.PathName,'-Token',$token,'-Executable',$configuration.pwshPath,'-Script',$fixture)
      $proof=$lifecycle.Launch('root',$configuration.pwshPath,$configuration.pwshSha256,$launchArguments,$environment,$fixture,$configuration.fixtureSha256,$false,$false)
      if($faultName -eq 'unknown_descendant_history'){
        $ready=$root.Leaf("ready-$($proof.Pid).json");$watch=[Diagnostics.Stopwatch]::StartNew()
        while(-not [IO.File]::Exists($ready) -and $watch.ElapsedMilliseconds -lt 12000){Start-Sleep -Milliseconds 20}
        Require ([IO.File]::Exists($ready)) 'unknown_children_fixture_not_ready'
        # Deliberately do not pin the two live children. This must stay RED.
      }
      $lifecycle.Close()
    }
    throw 'fault_was_not_observed'
  }catch{
    $observed=Fault-Code $_
  }finally{
    if($null -ne $lifecycle){try{$lifecycle.Close()}catch{if($null -eq $observed){$observed=Fault-Code $_}};$originalExitObserved=$lifecycle.EmergencyOriginalExitsObserved}
    $root.Dispose()
  }
  $expected=if($faultName -eq 'unknown_descendant_history'){'unknown_job_history'}else{'qa_injected_'+$faultName}
  if($faultName -like 'constructor_*'){
    $rollback=[EastGenesisOwnedWindows.QaRollbackStatus]::Executed -and [EastGenesisOwnedWindows.QaRollbackStatus]::JobCloseReturned -and [EastGenesisOwnedWindows.QaRollbackStatus]::JournalDisposeReturned -and [EastGenesisOwnedWindows.QaRollbackStatus]::FirstFailureCode -ceq $expected
    $asserted=$observed -ceq $expected -and $rollback
  }else{$asserted=$observed -ceq $expected -and $originalExitObserved}
  $cases.Add([ordered]@{name=$faultName;expectedRedCode=$expected;observedCode=$observed;expectedRedAssertionsPassed=$asserted;originalHandleExitObserved=$originalExitObserved;constructorRollbackReturned=$rollback;profilePreserved=[IO.Directory]::Exists($profile);profile=$profile;positivePassClaim=$false;unknownDescendantExactWaitClaim=$false})
}
$allPassed=@($cases|Where-Object{-not $_.expectedRedAssertionsPassed -or -not $_.profilePreserved}).Count -eq 0
$report=[ordered]@{schemaVersion=1;kind='windows-owned-expected-red-faults';platform='win32';nativeRun=$true;expectedRedAssertionsPassed=$allPassed;positiveSixCaseCount=0;positivePassClaim=$false;cases=@($cases);boundary=[ordered]@{fullGoal=$false;appStarted=$false;webDriverSession=$false;databaseOpened=$false;providerRequests=0;controllerEofCleanupTested=$false;helperDeathBeforeJobAssignmentNotProven=$true;unknownDescendantExactWaitClaim=$false;constructorObservationsAreApiReturnsOnly=$true}}
[IO.File]::WriteAllText($output.Leaf('expected-red-result.json'),($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));$output.AssertOwnedFile('expected-red-result.json');$output.Dispose()
if(-not $allPassed){exit 1}
