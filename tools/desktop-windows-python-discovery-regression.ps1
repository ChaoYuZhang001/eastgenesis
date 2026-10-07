# Windows PowerShell 5.1 only. This invokes the production suspended/job-owned
# process and physical SQLite probe, but never the installer main section.
# Only fixed labels, booleans, counts and hashes leave the disposable fixture.
param(
  [Parameter(Mandatory = $true)][string]$PythonExecutable,
  [Parameter(Mandatory = $true)][string]$OutputFile,
  [string]$ProductionHelper = (Join-Path $PSScriptRoot 'desktop-windows-install-smoke.ps1')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$phase = 'platform_guard'
$firstFailurePhase = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
$workBudgetMs = 120000
$root = $null
$nativeReady = $false
$environmentSnapshot = @{}
$jobHandles = [System.Collections.Generic.List[System.IntPtr]]::new()
$managedProcesses = [System.Collections.Generic.List[Diagnostics.Process]]::new()
$configuration = $null
$startupTraceRunId = $null
$lastProbeFailureStage = $null
$lastProcessJobFailure = $null
$lastProcessStartInputFacts = $null
$stage = 'unknown'
$sourceStartSha = $null
$selfStartSha = $null
$checks = [ordered]@{
  windowsPowerShell51 = $false; parsedProductionSource = $false
  extractedOnlyAllowlistedFunctions = $false; originalNativeCompiled = $false
  copiedOneCompleteRuntime = $false; runtimeCopiesMatchExecutable = $false
  actualDefaultDiscoveryIsMultiple = $false; discoveryObjectsAreApplications = $false
  legacyExpressionIsCollection = $false; legacyNativeProcessCreateRejected = $false
  singleApplicationSelected = $false; interiorSpacesPreserved = $false
  invalidExecutableInputsRejected = $false; controlledPythonVersion = $false
  physicalSchema7 = $false; physicalSeed = $false; physicalSentinel = $false
  controlledDescendantObserved = $false; controlledDescendantCleanup = $false; bindingsUnchanged = $false
}
$observed = [ordered]@{
  powerShellMajor = $null; powerShellMinor = $null; discoveryCount = $null
  legacyApplicationCharLength = $null; legacyWin32Error = $null
  legacyFailureStage = $null; legacyHresult = $null; legacySuspendCount = $null; legacyApplicationExists = $null
  legacyFullPathComparison = $null; observedPythonVersion = $null
  rejectedInputCount = 0; successfulControlledProcessCount = 0
}
$binding = [ordered]@{ productionSha256 = $null; nativeSourceSha256 = $null; probeSourceSha256 = $null; harnessStartSha256 = $null; harnessEndSha256 = $null; productionEndSha256 = $null }
$cleanup = [ordered]@{ attempted = $false; jobCount = 0; allJobsEmpty = $false; allHandlesClosed = $false; retainedProcessesDisposed = $false; environmentRestored = $false; ownedRootRemoved = $false }
$nativeAttempted = $false

function Assert-WorkBudget {
  if ($clock.ElapsedMilliseconds -gt $workBudgetMs) { throw 'work_budget_exceeded' }
}
function Get-TextSha([string]$Text) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Reject-InvalidExecutable([object]$Value) {
  $rejected = $false
  try { [void](Assert-PythonExecutable $Value) } catch { $rejected = $true }
  if (-not $rejected) { throw 'invalid_executable_accepted' }
  $observed.rejectedInputCount++
}

try {
  $observed.powerShellMajor = $PSVersionTable.PSVersion.Major
  $observed.powerShellMinor = $PSVersionTable.PSVersion.Minor
  if ($PSVersionTable.PSEdition -cne 'Desktop' -or $observed.powerShellMajor -ne 5 -or $observed.powerShellMinor -ne 1 -or
      [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'platform_guard' }
  $checks.windowsPowerShell51 = $true
  $sourceStartSha = (Get-FileHash -LiteralPath $ProductionHelper -Algorithm SHA256).Hash.ToLowerInvariant()
  $selfStartSha = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $binding.productionSha256 = $sourceStartSha
  $binding.harnessStartSha256 = $selfStartSha

  $phase = 'production_ast_extract'
  Assert-WorkBudget
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($ProductionHelper, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -ne 0 -or $null -eq $ast.EndBlock) { throw 'production_ast_extract' }
  $checks.parsedProductionSource = $true
  # Load definitions only. Never execute/dot-source the entire production file,
  # its EndBlock, or its installation/registry/GUI main section.
  $allowlist = @('Assert-NotReparse', 'Assert-Within', 'Assert-PythonExecutable', 'Resolve-PythonApplication',
    'Get-ControlledEnvironment', 'Start-Controlled', 'Wait-Command', 'Read-ProbeFailureStage', 'Sqlite-Probe')
  $topFunctions = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] })
  foreach ($name in $allowlist) {
    $definitions = @($topFunctions | Where-Object { $_.Name -ceq $name })
    $allDefinitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
    if ($definitions.Count -ne 1 -or $allDefinitions.Count -ne 1) { throw 'production_ast_extract' }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
  }
  $checks.extractedOnlyAllowlistedFunctions = $true
  $addTypes = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Add-Type' }, $true))
  if ($addTypes.Count -ne 1 -or $addTypes[0].CommandElements.Count -ne 3 -or
      $addTypes[0].CommandElements[1] -isnot [System.Management.Automation.Language.CommandParameterAst] -or
      $addTypes[0].CommandElements[1].ParameterName -cne 'TypeDefinition' -or
      $addTypes[0].CommandElements[2] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
      $addTypes[0].CommandElements[2].StringConstantType -ne [System.Management.Automation.Language.StringConstantType]::SingleQuotedHereString) { throw 'production_ast_extract' }
  $nativeText = $addTypes[0].CommandElements[2].Value
  $probeNodes = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
    $node.StringConstantType -eq [System.Management.Automation.Language.StringConstantType]::SingleQuotedHereString -and
    $node.Value.StartsWith('import json, sqlite3, sys', [StringComparison]::Ordinal) -and
    $node.Value.Contains('path, mode, output_path = sys.argv[1:]')
  }, $true))
  if ($probeNodes.Count -ne 1 -or -not $nativeText.Contains('namespace EastGenesisInstall') -or
      -not $nativeText.Contains('public static Process Start(')) { throw 'production_ast_extract' }
  $probeText = $probeNodes[0].Value
  $binding.nativeSourceSha256 = Get-TextSha $nativeText
  $binding.probeSourceSha256 = Get-TextSha $probeText

  $phase = 'production_native_compile'
  Assert-WorkBudget
  Add-Type -TypeDefinition $nativeText | Out-Null
  $nativeReady = $true
  $checks.originalNativeCompiled = $true

  $phase = 'runtime_copy'
  Assert-WorkBudget
  $approved = Assert-PythonExecutable $PythonExecutable
  if ([IO.Path]::GetFileName($approved) -ine 'python.exe') { throw 'runtime_copy' }
  $runtimeSource = [IO.Path]::GetDirectoryName($approved)
  $root = Join-Path ([IO.Path]::GetTempPath()) ('eg-python-discovery-' + [Guid]::NewGuid().ToString('N'))
  if (Test-Path -LiteralPath $root) { throw 'runtime_copy' }
  [void][IO.Directory]::CreateDirectory($root)
  Assert-NotReparse $root
  $runtimeFirst = Join-Path $root 'python runtime first'
  $runtimeSecond = Join-Path $root 'python discovery second'
  # The first copy carries DLLs/stdlib for real execution. The second holds a
  # genuine identical PE only for discovery; it is never executed separately.
  Copy-Item -LiteralPath $runtimeSource -Destination $runtimeFirst -Recurse -Force
  [void][IO.Directory]::CreateDirectory($runtimeSecond)
  $firstExecutable = Join-Path $runtimeFirst 'python.exe'
  $secondExecutable = Join-Path $runtimeSecond 'python.exe'
  Copy-Item -LiteralPath $approved -Destination $secondExecutable
  [void](Assert-PythonExecutable $firstExecutable)
  [void](Assert-PythonExecutable $secondExecutable)
  $approvedSha = (Get-FileHash -LiteralPath $approved -Algorithm SHA256).Hash
  if ((Get-FileHash -LiteralPath $firstExecutable -Algorithm SHA256).Hash -cne $approvedSha -or
      (Get-FileHash -LiteralPath $secondExecutable -Algorithm SHA256).Hash -cne $approvedSha) { throw 'runtime_copy' }
  $checks.copiedOneCompleteRuntime = $true
  $checks.runtimeCopiesMatchExecutable = $true
  $fixtureProfile = Join-Path $root 'isolated profile'
  $install = Join-Path $root 'isolated install'
  foreach ($folder in @($fixtureProfile, $install, (Join-Path $fixtureProfile 'temp'), (Join-Path $fixtureProfile 'roaming'), (Join-Path $fixtureProfile 'local'))) { [void][IO.Directory]::CreateDirectory($folder) }
  $configuration = [pscustomobject]@{ profileDirectory = $fixtureProfile; installDirectory = $install }
  $database = Join-Path $install 'caogen.db'
  $pythonScript = Join-Path $fixtureProfile 'sqlite-probe.py'
  $probeText | Set-Content -LiteralPath $pythonScript -Encoding UTF8
  foreach ($name in @('PATH', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP')) {
    $environmentSnapshot[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  [Environment]::SetEnvironmentVariable('PATH', ($runtimeFirst + ';' + $runtimeSecond), 'Process')
  foreach ($entry in @(@('APPDATA', (Join-Path $fixtureProfile 'roaming')), @('LOCALAPPDATA', (Join-Path $fixtureProfile 'local')),
      @('USERPROFILE', $fixtureProfile), @('HOME', $fixtureProfile), @('HOMEDRIVE', [IO.Path]::GetPathRoot($fixtureProfile).TrimEnd('\')),
      @('HOMEPATH', $fixtureProfile.Substring([IO.Path]::GetPathRoot($fixtureProfile).Length - 1)), @('TEMP', (Join-Path $fixtureProfile 'temp')), @('TMP', (Join-Path $fixtureProfile 'temp')))) {
    [Environment]::SetEnvironmentVariable($entry[0], $entry[1], 'Process')
  }

  $phase = 'actual_default_discovery'
  Assert-WorkBudget
  # This is the exact old command, with no -All, fake objects or mock.
  $applications = @(Get-Command 'python' -CommandType Application -ErrorAction Stop)
  $observed.discoveryCount = $applications.Count
  if ($applications.Count -ne 2) { throw 'actual_default_discovery' }
  $checks.actualDefaultDiscoveryIsMultiple = $true
  if ($applications[0] -isnot [System.Management.Automation.ApplicationInfo] -or $applications[1] -isnot [System.Management.Automation.ApplicationInfo] -or
      $applications[0].Path -cne $firstExecutable -or $applications[1].Path -cne $secondExecutable) { throw 'actual_default_discovery' }
  $checks.discoveryObjectsAreApplications = $true
  $legacySources = (Get-Command 'python' -CommandType Application -ErrorAction Stop).Source
  if ($legacySources -isnot [Array] -or $legacySources.Count -ne 2 -or $legacySources[0] -cne $firstExecutable -or $legacySources[1] -cne $secondExecutable) { throw 'actual_default_discovery' }
  $checks.legacyExpressionIsCollection = $true

  $phase = 'legacy_native_rejection'
  Assert-WorkBudget
  $nativeAttempted = $true
  $legacyRejected = $false
  try {
    # Use the unchanged production [string] Binary binding and actual Win32
    # suspended/job-owned launcher. Do not pre-cast, join or change arguments.
    $legacy = Start-Controlled $legacySources '' 'sqlite_schema_probe'
    $managedProcesses.Add($legacy.process)
  } catch {
    if ($null -ne $lastProcessJobFailure) {
      if ($lastProcessJobFailure.stage -cin @('job_create', 'job_limit', 'stdio_create', 'environment_block', 'process_create', 'job_assign', 'process_lookup', 'process_handle', 'process_resume', 'unknown')) { $observed.legacyFailureStage = $lastProcessJobFailure.stage }
      if ($lastProcessJobFailure.win32Error -is [int] -or $lastProcessJobFailure.win32Error -is [uint32]) { $observed.legacyWin32Error = $lastProcessJobFailure.win32Error }
      if ($lastProcessJobFailure.hresult -is [int]) { $observed.legacyHresult = $lastProcessJobFailure.hresult }
      if ($lastProcessJobFailure.suspendCount -is [uint32]) { $observed.legacySuspendCount = $lastProcessJobFailure.suspendCount }
    }
    if ($null -ne $lastProcessStartInputFacts) {
      $actualApplicationFacts = $lastProcessStartInputFacts.application
      if ($actualApplicationFacts.exists -is [bool]) { $observed.legacyApplicationExists = $actualApplicationFacts.exists }
      if ($actualApplicationFacts.fullPathComparison -cin @('same', 'different', 'failed', 'unknown')) { $observed.legacyFullPathComparison = $actualApplicationFacts.fullPathComparison }
      if ($actualApplicationFacts.charLength -is [int]) { $observed.legacyApplicationCharLength = $actualApplicationFacts.charLength }
    }
    if ($null -ne $lastProcessJobFailure -and $lastProcessJobFailure.stage -ceq 'process_create' -and
        $lastProcessJobFailure.win32Error -eq 123 -and $null -ne $lastProcessStartInputFacts -and
        $lastProcessStartInputFacts.launchRole -ceq 'sqlite_schema_probe') {
      $applicationFacts = $lastProcessStartInputFacts.application
      if ($applicationFacts.exists -eq $false -and $applicationFacts.fullPathComparison -ceq 'failed' -and
          $applicationFacts.charLength -eq ([string]$legacySources).Length) {
        $legacyRejected = $true
        $observed.legacyFailureStage = 'process_create'
        $observed.legacyWin32Error = 123
        $observed.legacyApplicationExists = $false
        $observed.legacyFullPathComparison = 'failed'
        $observed.legacyApplicationCharLength = $applicationFacts.charLength
      }
    }
  }
  if (-not $legacyRejected) { throw 'legacy_native_rejection' }
  $checks.legacyNativeProcessCreateRejected = $true

  $phase = 'scalar_selection_and_negative_inputs'
  Assert-WorkBudget
  $python = Resolve-PythonApplication
  if ($python -isnot [string] -or $python -cne $firstExecutable) { throw 'scalar_selection_and_negative_inputs' }
  $checks.singleApplicationSelected = $true
  if (-not $python.Contains('python runtime first')) { throw 'scalar_selection_and_negative_inputs' }
  $checks.interiorSpacesPreserved = $true
  Reject-InvalidExecutable ([object]@($firstExecutable, $secondExecutable))
  Reject-InvalidExecutable $null
  Reject-InvalidExecutable ''
  Reject-InvalidExecutable 'python.exe'
  Reject-InvalidExecutable (Join-Path $root 'missing.exe')
  Reject-InvalidExecutable $runtimeFirst
  $invalidPe = Join-Path $root 'not-pe.exe'
  [IO.File]::WriteAllBytes($invalidPe, [byte[]]@(1, 2, 3))
  Reject-InvalidExecutable $invalidPe
  $dllPe = Join-Path $root 'dll-pe.exe'
  $dllBytes = [byte[]]::new(88)
  $dllBytes[0] = 0x4d; $dllBytes[1] = 0x5a; $dllBytes[60] = 64
  $dllBytes[64] = 0x50; $dllBytes[65] = 0x45; $dllBytes[86] = 0x02; $dllBytes[87] = 0x20
  [IO.File]::WriteAllBytes($dllPe, $dllBytes)
  Reject-InvalidExecutable $dllPe
  if ($observed.rejectedInputCount -ne 8) { throw 'scalar_selection_and_negative_inputs' }
  $checks.invalidExecutableInputsRejected = $true

  $phase = 'controlled_sqlite_fixture_create'
  Assert-WorkBudget
  $createScript = Join-Path $fixtureProfile 'create-sqlite-fixture.py'
  $versionOutput = Join-Path $fixtureProfile 'python-version.json'
  @'
import json, sqlite3, sys
from pathlib import Path
path, version_output = sys.argv[1:]
assert sys.version_info[:3] == (3, 12, 10)
db = sqlite3.connect(path)
db.executescript("CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO app_meta VALUES ('schema_version','7'); CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,turns TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER); CREATE TABLE tool_invocations(id TEXT); CREATE INDEX tool_invocations_lease ON tool_invocations(id);")
db.close()
Path(version_output).write_text(json.dumps({'version': '3.12.10'}), encoding='utf-8')
'@ | Set-Content -LiteralPath $createScript -Encoding UTF8
  $creator = Start-Controlled $python "`"$createScript`" `"$database`" `"$versionOutput`"" 'unknown'
  $managedProcesses.Add($creator.process)
  $observed.successfulControlledProcessCount++
  Wait-Command $creator 10000
  if ((Get-Item -LiteralPath $versionOutput).Length -gt 128) { throw 'controlled_sqlite_fixture_create' }
  $version = Get-Content -LiteralPath $versionOutput -Raw | ConvertFrom-Json
  $versionFields = @($version.PSObject.Properties.Name)
  if ($versionFields.Count -ne 1 -or $versionFields[0] -cne 'version' -or $version.version -cne '3.12.10') { throw 'controlled_sqlite_fixture_create' }
  $observed.observedPythonVersion = '3.12.10'
  $checks.controlledPythonVersion = $true

  $phase = 'production_physical_schema'
  Assert-WorkBudget
  $schema = Sqlite-Probe 'schema'
  $observed.successfulControlledProcessCount++
  if ($schema.schemaVersion -ne 7 -or -not $schema.sessions -or -not $schema.toolInvocations -or -not $schema.leaseIndex) { throw 'production_physical_schema' }
  $checks.physicalSchema7 = $true
  $phase = 'production_physical_seed'
  Assert-WorkBudget
  $seed = Sqlite-Probe 'seed'
  $observed.successfulControlledProcessCount++
  if (-not $seed.seeded) { throw 'production_physical_seed' }
  $checks.physicalSeed = $true
  $phase = 'production_physical_sentinel'
  Assert-WorkBudget
  $sentinel = Sqlite-Probe 'sentinel'
  $observed.successfulControlledProcessCount++
  if (-not $sentinel.present) { throw 'production_physical_sentinel' }
  $checks.physicalSentinel = $true

  $phase = 'controlled_descendant_cleanup'
  Assert-WorkBudget
  $childScript = Join-Path $fixtureProfile 'owned-descendant.py'
  @'
import subprocess, sys
subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
'@ | Set-Content -LiteralPath $childScript -Encoding UTF8
  $parent = Start-Controlled $python "`"$childScript`"" 'unknown'
  $managedProcesses.Add($parent.process)
  $observed.successfulControlledProcessCount++
  if (-not $parent.process.WaitForExit(10000)) { throw 'controlled_descendant_cleanup' }
  $descendantDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([EastGenesisInstall.Native]::Active($parent.job) -gt 1 -and [DateTime]::UtcNow -lt $descendantDeadline) { Start-Sleep -Milliseconds 100 }
  if ([EastGenesisInstall.Native]::Active($parent.job) -ne 1) { throw 'controlled_descendant_cleanup' }
  $checks.controlledDescendantObserved = $true
  Wait-Command $parent 10000
  if ([EastGenesisInstall.Native]::Active($parent.job) -ne 0) { throw 'controlled_descendant_cleanup' }
  $checks.controlledDescendantCleanup = $true
  $phase = 'source_end_binding'
  Assert-WorkBudget
} catch {
  # Preserve the first fixed phase. Cleanup failures are recorded separately;
  # never serialize ErrorRecord/Exception/Message/StackTrace or input strings.
  $firstFailurePhase = $phase
} finally {
  $cleanup.attempted = $true
  $cleanup.jobCount = $jobHandles.Count
  $allEmpty = $true
  $allClosed = $true
  if ($nativeReady) {
    foreach ($job in $jobHandles) {
      try {
        [EastGenesisInstall.Native]::Terminate($job)
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([EastGenesisInstall.Native]::Active($job) -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
        if ([EastGenesisInstall.Native]::Active($job) -ne 0) { $allEmpty = $false }
      } catch { $allEmpty = $false }
      try { if (-not [EastGenesisInstall.Native]::CloseHandle($job)) { $allClosed = $false } } catch { $allClosed = $false }
    }
  } elseif ($jobHandles.Count -ne 0) { $allEmpty = $false; $allClosed = $false }
  $cleanup.allJobsEmpty = $allEmpty
  $cleanup.allHandlesClosed = $allClosed
  if (-not $allEmpty -or -not $allClosed) { $cleanupFailures.Add('job_cleanup') }
  $allDisposed = $true
  foreach ($process in $managedProcesses) { try { $process.Dispose() } catch { $allDisposed = $false } }
  $cleanup.retainedProcessesDisposed = $allDisposed
  if (-not $allDisposed) { $cleanupFailures.Add('managed_handle_cleanup') }
  $restored = $true
  foreach ($name in $environmentSnapshot.Keys) {
    try {
      [Environment]::SetEnvironmentVariable($name, $environmentSnapshot[$name], 'Process')
      if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $environmentSnapshot[$name]) { $restored = $false }
    } catch { $restored = $false }
  }
  $cleanup.environmentRestored = $restored
  if (-not $restored) { $cleanupFailures.Add('environment_restore') }
  $removed = $null -eq $root
  if ($null -ne $root -and $allEmpty -and $allClosed) {
    try {
      Assert-NotReparse $root
      if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
      $removed = -not (Test-Path -LiteralPath $root)
    } catch { $removed = $false }
  }
  $cleanup.ownedRootRemoved = $removed
  if (-not $removed) { $cleanupFailures.Add('owned_root_cleanup') }
  try {
    $binding.productionEndSha256 = (Get-FileHash -LiteralPath $ProductionHelper -Algorithm SHA256).Hash.ToLowerInvariant()
    $binding.harnessEndSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $checks.bindingsUnchanged = $null -ne $sourceStartSha -and $null -ne $selfStartSha -and
      $binding.productionEndSha256 -ceq $sourceStartSha -and $binding.harnessEndSha256 -ceq $selfStartSha
  } catch { $checks.bindingsUnchanged = $false }
  if (-not $checks.bindingsUnchanged) { $cleanupFailures.Add('source_binding') }
}
$passed = $null -eq $firstFailurePhase -and $cleanupFailures.Count -eq 0 -and @($checks.Values | Where-Object { $_ -ne $true }).Count -eq 0
$report = [ordered]@{
  schemaVersion = 1; kind = 'desktop-windows-python-discovery-regression'; passed = $passed
  nativeAttempted = $nativeAttempted; nativePassed = $passed; realProviderAttempted = $false
  workBudgetMs = $workBudgetMs; processTimeoutMs = 10000; perJobCleanupTimeoutMs = 5000
  workflowTimeoutMinutes = 5; elapsedMs = $clock.ElapsedMilliseconds
  # Copy/AST/compilation/filesystem calls are synchronous; the workflow bounds
  # total runtime. Work-budget checks do not claim preemption of those calls.
  firstFailurePhase = $firstFailurePhase; cleanupFailures = $cleanupFailures.ToArray()
  checks = $checks; observed = $observed; binding = $binding; cleanup = $cleanup
}
$text = $report | ConvertTo-Json -Depth 6
# CreateNew protects an earlier actual attempt. The parent directory is the CI
# workspace; only this fixed-schema small JSON is persisted/uploaded.
try {
  $reportStream = [IO.File]::Open($OutputFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $writer = [IO.StreamWriter]::new($reportStream, [Text.UTF8Encoding]::new($false))
    try { $writer.WriteLine($text) } finally { $writer.Dispose() }
  } finally { $reportStream.Dispose() }
} catch {
  $report.passed = $false
  $report.nativePassed = $false
  if ($null -eq $report.firstFailurePhase) { $report.firstFailurePhase = 'report_persist' }
  Write-Output ($report | ConvertTo-Json -Depth 6)
  exit 1
}
Write-Output $text
if (-not $passed) { exit 1 }
# A managed Win32 launch does not set LASTEXITCODE. Return a deterministic
# success code to the caller as well as the fixed-schema passed report.
exit 0
