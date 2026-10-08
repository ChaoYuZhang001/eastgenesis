param([Parameter(Mandatory=$true)][string]$ConfigPath)
if (-not $IsWindows) { throw 'platform_unsupported' }
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if([IO.Path]::GetFileName($ConfigPath) -ieq 'MEMORY.md') { throw 'input_forbidden' }
$configuration=[IO.File]::ReadAllText($ConfigPath)|ConvertFrom-Json
$expected=@('schemaVersion','sourcePath','sourceSha256','fixturePath','fixtureSha256','pwshPath','pwshSha256','ownedOutput','systemRoot','systemDrive')
if(@($configuration.PSObject.Properties.Name).Count -ne $expected.Count -or (@($configuration.PSObject.Properties.Name)|Where-Object{$_ -cnotin $expected}).Count -ne 0 -or $configuration.schemaVersion -ne 1) { throw 'config_schema_invalid' }
foreach($pair in @(@('sourcePath','sourceSha256'),@('fixturePath','fixtureSha256'),@('pwshPath','pwshSha256'))) {
  $path=$configuration.($pair[0]);$hash=$configuration.($pair[1])
  if([IO.Path]::GetFileName($path) -ieq 'MEMORY.md' -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash) { throw 'source_unbound' }
}
Add-Type -Path $configuration.sourcePath
$outer=[EastGenesisOwnedWindows.OwnedDirectory]::Create($configuration.ownedOutput)
$overall=[Diagnostics.Stopwatch]::StartNew()
$results=[Collections.Generic.List[object]]::new()
$journalCopies=[Collections.Generic.List[string]]::new()
$nativePassed=$false
$retainedFailures=[Collections.Generic.List[string]]::new()

function Fixed-Code($ErrorRecord) {
  $e=$ErrorRecord.Exception
  for($i=0;$i -lt 5 -and $null -ne $e.InnerException -and $e -isnot [EastGenesisOwnedWindows.ProofFailure];$i++) {$e=$e.InnerException}
  if($e -is [EastGenesisOwnedWindows.ProofFailure]) {return $e.Code}
  return 'native_case_failed'
}
function Need([bool]$Condition,[string]$Code) {if(-not $Condition){throw $Code}}
function Wait-Ready($Directory,$Proof,[string]$Token) {
  $name="ready-$($Proof.Pid).json";$path=$Directory.Leaf($name)
  $watch=[Diagnostics.Stopwatch]::StartNew()
  while($watch.ElapsedMilliseconds -lt 12000) {
    if([IO.File]::Exists($path)) {
      try {$Directory.AssertOwnedFile($name)}catch{if((Fixed-Code $_) -ceq 'file_handle_open'){Start-Sleep -Milliseconds 20;continue}else{throw}}
      Need ((Get-Item -LiteralPath $path).Length -le 8192) 'fixture_output_limit'
      $row=[IO.File]::ReadAllText($path)|ConvertFrom-Json
      Need ($row.schemaVersion -eq 1 -and $row.pid -eq $Proof.Pid -and $row.creationTime -ceq $Proof.CreationTime.ToString() -and $row.token -ceq $Token -and $row.cwd -ceq $Directory.PathName -and $row.image -ieq $Proof.ImagePath -and $row.profileEnvironmentBound -eq $true -and $row.remoteProcessParametersRead -eq $false) 'fixture_birth_or_inputs_unbound'
      return $row
    }
    Start-Sleep -Milliseconds 20
  }
  throw 'fixture_ready_timeout'
}
function Read-Journal([string]$Path) {
  $text=[IO.File]::ReadAllText($Path)
  Need ($text.EndsWith("`n") -and [Text.Encoding]::UTF8.GetByteCount($text) -le 4194304) 'journal_incomplete'
  $rows=@($text.TrimEnd("`n").Split("`n")|ForEach-Object{$_|ConvertFrom-Json})
  $previous=[long]0;$seq=0;$prepared=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach($row in $rows) {
    $seq++;Need ($row.sequence -eq $seq -and [long]$row.atTicks -ge $previous -and [long]$row.frequency -eq [Diagnostics.Stopwatch]::Frequency) 'journal_sequence_or_clock'
    $previous=[long]$row.atTicks
    $identity="$($row.role):$($row.pid):$($row.creationTime)"
    if($row.event -eq 'terminate_prepared'){[void]$prepared.Add($identity)}
    if($row.event -eq 'terminate_dispatched'){Need ($prepared.Contains($identity)) 'journal_dispatch_without_prepared'}
  }
  Need ($rows[-1].event -eq 'cleanup_complete' -and $rows[-1].allExactHandlesWaited -eq $true -and $rows[-1].unknownCount -eq 0 -and $rows[-1].red -eq $false) 'cleanup_journal_red'
  return ,$rows
}

$names=@('normal-stop','root-crash-retained-children','rejected-target-after-birth','stdin-eof-exact-wait','fast-exit-five-generations','unknown-authority-and-input-drift')
try {
  foreach($name in $names) {
    Need ($overall.ElapsedMilliseconds -lt 180000) 'overall_deadline_exceeded'
    $rootPath=Join-Path ([IO.Path]::GetDirectoryName($configuration.ownedOutput)) ("eg-win-owned-"+[Guid]::NewGuid().ToString('N'))
    $directory=[EastGenesisOwnedWindows.OwnedDirectory]::Create($rootPath)
    $lifecycle=$null;$casePassed=$false;$caseCode=$null;$proofs=@();$rows=@();$removed=$false
    $token=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
    $fixtureCopy=$directory.Leaf('owned-fixture.ps1')
    [IO.File]::WriteAllBytes($fixtureCopy,[IO.File]::ReadAllBytes($configuration.fixturePath))
    $directory.AssertOwnedFile('owned-fixture.ps1')
    Need ((Get-FileHash -LiteralPath $fixtureCopy -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $configuration.fixtureSha256) 'fixture_copy_unbound'
    $environment=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    foreach($key in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','EG_OWNED_ROOT')) {$environment.Add($key,$directory.PathName)}
    $environment.Add('EG_FIXTURE_TOKEN',$token);$environment.Add('SystemRoot',$configuration.systemRoot);$environment.Add('SystemDrive',$configuration.systemDrive)
    $environment.Add('PATH',[IO.Path]::GetDirectoryName($configuration.pwshPath))
    function Start-Fixture([string]$Role,[string]$Mode,[bool]$Reject=$false,[bool]$Pipe=$false) {
      $launchArgs=@('-NoLogo','-NoProfile','-NonInteractive','-File',$fixtureCopy,'-Mode',$Mode,'-Root',$directory.PathName,'-Token',$token,'-Executable',$configuration.pwshPath,'-Script',$fixtureCopy)
      return $lifecycle.Launch($Role,$configuration.pwshPath,$configuration.pwshSha256,$launchArgs,$environment,$fixtureCopy,$configuration.fixtureSha256,$Reject,$Pipe)
    }
    try {
      $lifecycle=[EastGenesisOwnedWindows.Lifecycle]::new($directory,'lifecycle.jsonl',45000,8000)
      if($name -eq 'normal-stop') {
        $p=Start-Fixture 'root' 'leaf';$proofs+=,$p;[void](Wait-Ready $directory $p $token)
        $lifecycle.Verify($p.Role,$p.CreationTime,$p.ImageSha256);$lifecycle.StopExact($p.Role,$p.CreationTime);$lifecycle.WaitExact($p.Role,3000)
      } elseif($name -eq 'root-crash-retained-children') {
        $p=Start-Fixture 'root' 'parent';$proofs+=,$p;$ready=Wait-Ready $directory $p $token
        $children=@($lifecycle.RetainDescendants($configuration.pwshPath,$configuration.pwshSha256));Need ($children.Count -eq 2 -and (@($children.Pid|Sort-Object)-join ',') -ceq (@($ready.childPids|Sort-Object)-join ',')) 'fixture_descendants_unbound'
        foreach($child in $children){$proofs+=,$child;[void](Wait-Ready $directory $child $token)}
        $lifecycle.StopExact($p.Role,$p.CreationTime);$lifecycle.WaitExact($p.Role,3000)
        Need ($lifecycle.ActiveCount() -eq 2) 'children_not_retained_after_root_exit'
        foreach($child in $children){$lifecycle.StopExact($child.Role,$child.CreationTime);$lifecycle.WaitExact($child.Role,3000)}
      } elseif($name -eq 'rejected-target-after-birth') {
        $p=Start-Fixture 'root' 'leaf' $true;$proofs+=,$p
        Need (-not [IO.File]::Exists($directory.Leaf("ready-$($p.Pid).json")) -and $lifecycle.AllWaited) 'rejected_target_executed_or_not_waited'
      } elseif($name -eq 'stdin-eof-exact-wait') {
        $p=Start-Fixture 'root' 'eof' $false $true;$proofs+=,$p;[void](Wait-Ready $directory $p $token)
        $lifecycle.SendEof($p.Role,$p.CreationTime);$lifecycle.WaitExact($p.Role,3000)
      } elseif($name -eq 'fast-exit-five-generations') {
        for($generation=1;$generation -le 5;$generation++) {
          $p=Start-Fixture "fast_$generation" 'fast';$proofs+=,$p;$lifecycle.WaitExact($p.Role,12000)
        }
      } else {
        $p=Start-Fixture 'root' 'leaf';$proofs+=,$p;[void](Wait-Ready $directory $p $token)
        $rejected=0
        foreach($probe in @('unknown','wrong_birth','wrong_hash')) {
          try {
            if($probe -eq 'unknown'){$lifecycle.StopExact('absent',$p.CreationTime)}
            elseif($probe -eq 'wrong_birth'){$lifecycle.StopExact($p.Role,$p.CreationTime+1)}
            else{$lifecycle.Verify($p.Role,$p.CreationTime,('0'*64))}
            throw 'authority_probe_unexpectedly_accepted'
          }catch{if((Fixed-Code $_) -cin @('authority_unknown','supplied_birth_mismatch','supplied_birth_or_image_mismatch')){$rejected++}else{throw}}
        }
        Need ($rejected -eq 3) 'authority_rejection_missing'
        [IO.File]::AppendAllText($fixtureCopy,"`n# owned QA auxiliary drift`n")
        try {$lifecycle.Verify($p.Role,$p.CreationTime,$p.ImageSha256);throw 'drift_probe_unexpectedly_accepted'}catch{Need ((Fixed-Code $_) -ceq 'launch_input_drift') 'input_drift_not_rejected'}
      }
      $lifecycle.Close();$rows=Read-Journal $lifecycle.JournalPath
      $waitCount=@($rows|Where-Object{$_.event -ceq 'exact_handle_wait'}).Count
      Need ($waitCount -eq $proofs.Count -and $lifecycle.AllWaited) 'precise_wait_count_mismatch'
      $target=$outer.Leaf("$name.jsonl");[IO.File]::WriteAllBytes($target,[IO.File]::ReadAllBytes($lifecycle.JournalPath));$outer.AssertOwnedFile("$name.jsonl");$journalCopies.Add($target)
      $casePassed=$true
    }catch{$caseCode=Fixed-Code $_}
    finally {
      if($null -ne $lifecycle){try{$lifecycle.Close()}catch{$casePassed=$false;$caseCode=Fixed-Code $_}}
      if($casePassed){try{
        $expectedEntries=@('owned-fixture.ps1','lifecycle.jsonl')
        if($name -cnotin @('rejected-target-after-birth','fast-exit-five-generations')){foreach($proof in $proofs){$expectedEntries+="ready-$($proof.Pid).json"}}
        $directory.DeleteFilesAndDirectory([string[]]$expectedEntries);$removed=$true
      }catch{$casePassed=$false;$caseCode=Fixed-Code $_}}
      if(-not $casePassed){$retainedFailures.Add($directory.PathName)}
      $directory.Dispose()
    }
    $processProofs=@($proofs|ForEach-Object{[ordered]@{role=$_.Role;pid=$_.Pid;creationTime=$_.CreationTime.ToString();image=$_.ImagePath;imageSha256=$_.ImageSha256;ownerSid=$_.OwnerSid;provenance=$_.Provenance;creationOperationId=$_.CreationOperationId;jobInstanceId=$_.JobInstanceId;originalOperationIds=@($_.OriginalOperationIds)}})
    $results.Add([ordered]@{name=$name;passed=$casePassed;skipped=$false;failureCode=$caseCode;retainedHandles=$proofs.Count;processProofs=$processProofs;exactWaits=@($rows|Where-Object{$_.event -ceq 'exact_handle_wait'}).Count;journalRows=$rows.Count;ownedProfileRemoved=$removed;nativeRun=$true;appStarted=$false;webDriverSession=$false})
  }
  $nativePassed=@($results|Where-Object{-not $_.passed}).Count -eq 0
} finally {
  foreach($pair in @(@('sourcePath','sourceSha256'),@('fixturePath','fixtureSha256'),@('pwshPath','pwshSha256'))) {
    if((Get-FileHash -LiteralPath $configuration.($pair[0]) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configuration.($pair[1])){$nativePassed=$false}
  }
  $report=[ordered]@{
    schemaVersion=1;platform='win32';nativeRun=$true;passed=$nativePassed;cases=@($results);journalPaths=@($journalCopies);retainedFailureProfiles=@($retainedFailures)
    ownerSid=$outer.OwnerSid;outputFileId=$outer.FileId;elapsedMs=$overall.ElapsedMilliseconds
    boundary=[ordered]@{fullGoal=$false;appSessionImplemented=$false;appStarted=$false;webDriverSession=$false;databaseOpened=$false;providerRequests=0;userKnownFoldersRead=$false;remoteProcessParametersRead=$false;creationInputsKernelBound=$true;fixtureActualProfileEnvironmentCwdVerified=$true;unknownDescendantsAreRed=$true;controllerEofCleanupTested=$false;helperDeathBeforeJobAssignmentNotProven=$true}
  }
  $reportPath=$outer.Leaf('result.json');[IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));$outer.AssertOwnedFile('result.json');$outer.Dispose()
}
if(-not $nativePassed){exit 1}
