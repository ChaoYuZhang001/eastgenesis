# This helper performs real NSIS operations only on disposable hosted runners.
# It never redirects system Known Folders or prints paths/native exception text.
# The QA binary must embed appDirectoriesOverride = ./eg-qa-appdata. Ordinary
# production storage/migration, signing and cross-version upgrades are excluded.
param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$checks = [ordered]@{}
$stages = [System.Collections.Generic.List[string]]::new()
$errors = [System.Collections.Generic.List[string]]::new()
$launches = [System.Collections.Generic.List[object]]::new()
$startupDiagnostics = [System.Collections.Generic.List[object]]::new()
$lastProbeFailureStage = $null
$lastProcessJobFailure = $null
$lastProcessStartInputFacts = $null
$stage = 'unknown'
$app = $null
$installed = $false
$environmentSnapshot = @{}
$jobHandles = [System.Collections.Generic.List[System.IntPtr]]::new()
$stableStarts = @{}
$nativeReady = $false
$configuration = $null
$attempts = [ordered]@{ install = $false; reinstall = $false; uninstall = $false }
$payloadBinding = $null
$startupTraceRunId = $null

function Record-Check([string]$Name) {
  $checks[$Name] = $true
  $stages.Add($Name)
}

function Get-ByteSha256([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

function Get-NsisPayloadBinding([byte[]]$SourceBytes) {
  # Tauri CLI 2.12.0 patches the unique UNK token before makensis, then restores
  # the loose source executable. Keep a whole-file SHA gate after that exact
  # same-length transformation. No installed bytes are normalized or ignored.
  # https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle.rs#L90-L96
  $unknownToken = '__TAURI_BUNDLE_TYPE_VAR_UNK'
  $nsisToken = '__TAURI_BUNDLE_TYPE_VAR_NSS'
  if ($SourceBytes.Length -lt 2 -or $SourceBytes[0] -ne 0x4d -or $SourceBytes[1] -ne 0x5a -or $unknownToken.Length -ne $nsisToken.Length) { throw 'payload_binding_invalid' }
  $sourceText = [Text.Encoding]::ASCII.GetString($SourceBytes)
  $offset = $sourceText.IndexOf($unknownToken, [StringComparison]::Ordinal)
  if ($offset -lt 0 -or $sourceText.IndexOf($unknownToken, $offset + 1, [StringComparison]::Ordinal) -ge 0) { throw 'payload_binding_invalid' }
  $expectedBytes = [byte[]]$SourceBytes.Clone()
  [Array]::Copy([Text.Encoding]::ASCII.GetBytes($nsisToken), 0, $expectedBytes, $offset, $nsisToken.Length)
  $binding = [ordered]@{
    strategy = 'tauri_cli_2_12_0_nsis_bundle_type_patch'; cliVersion = '2.12.0'
    sourceSha256 = (Get-ByteSha256 $SourceBytes); expectedNsisSha256 = (Get-ByteSha256 $expectedBytes)
    installedSha256 = $null; repairedSha256 = $null
  }
  $inputBinding = $configuration.payloadBinding
  $fields = @($inputBinding.PSObject.Properties.Name)
  if ($fields.Count -ne $binding.Count -or @($fields | Where-Object { $_ -notin $binding.Keys }).Count -ne 0) { throw 'payload_binding_invalid' }
  foreach ($field in $binding.Keys) {
    if ($inputBinding.$field -cne $binding[$field]) { throw 'payload_binding_invalid' }
  }
  return $binding
}

function Assert-NotReparse([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $entry = Get-Item -LiteralPath $current -Force
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $script:stage = 'reparse_point'
        throw 'reparse_point'
      }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
  }
}

function Assert-Within([string]$Path, [string]$Root) {
  $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not [IO.Path]::GetFullPath($Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    $script:stage = 'isolated_root'
    throw 'isolated_root'
  }
  Assert-NotReparse $Path
}

function Assert-PythonExecutable([object]$Path) {
  # Reject a collection before any [string] parameter conversion. Preserve
  # valid interior spaces; a discovery result is never split or concatenated.
  if ($Path -isnot [string] -or [string]::IsNullOrWhiteSpace($Path) -or
      $Path.IndexOf([char]0) -ge 0 -or $Path.Contains("`r") -or $Path.Contains("`n") -or
      $Path.Contains('"') -or $Path -cne $Path.Trim() -or -not [IO.Path]::IsPathRooted($Path)) { throw 'runtime_missing' }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -cne $Path -or [IO.Path]::GetExtension($full) -ine '.exe') { throw 'runtime_missing' }
  $entry = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  if ($entry -isnot [IO.FileInfo]) { throw 'runtime_missing' }
  Assert-NotReparse $full
  $stream = [IO.File]::OpenRead($full)
  try {
    $reader = [IO.BinaryReader]::new($stream)
    try {
      $header = $reader.ReadBytes(64)
      if ($header.Length -ne 64 -or $header[0] -ne 0x4d -or $header[1] -ne 0x5a) { throw 'runtime_missing' }
      $offset = [BitConverter]::ToInt32($header, 60)
      if ($offset -lt 64 -or $offset -gt $stream.Length - 24) { throw 'runtime_missing' }
      [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
      $pe = $reader.ReadBytes(24)
      if ($pe.Length -ne 24 -or $pe[0] -ne 0x50 -or $pe[1] -ne 0x45 -or $pe[2] -ne 0 -or $pe[3] -ne 0) { throw 'runtime_missing' }
      $characteristics = [BitConverter]::ToUInt16($pe, 22)
      if (($characteristics -band 0x0002) -eq 0 -or ($characteristics -band 0x2000) -ne 0) { throw 'runtime_missing' }
    } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
  return $full
}

function Resolve-PythonApplication {
  # Explicit CommandType discovery can yield several ApplicationInfo objects
  # in Windows PowerShell 5.1. Select one object in discovery precedence first.
  $applications = @(Get-Command 'python' -CommandType Application -ErrorAction Stop)
  if ($applications.Count -lt 1 -or $applications[0] -isnot [System.Management.Automation.ApplicationInfo]) { throw 'runtime_missing' }
  return Assert-PythonExecutable $applications[0].Path
}

function Find-Registrations {
  $found = [System.Collections.Generic.List[object]]::new()
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      try {
        $uninstall = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($null -eq $uninstall) { continue }
        try {
          foreach ($name in $uninstall.GetSubKeyNames()) {
            $key = $uninstall.OpenSubKey($name)
            if ($null -eq $key) { continue }
            try {
              if ($name -eq 'EastGenesis Desktop' -or $key.GetValue('DisplayName') -eq 'EastGenesis Desktop') {
                $found.Add([pscustomobject]@{
                  hive = $hive.ToString(); version = [string]$key.GetValue('DisplayVersion')
                  location = [string]$key.GetValue('InstallLocation')
                  uninstall = [string]$key.GetValue('UninstallString')
                })
              }
            } finally { $key.Dispose() }
          }
        } finally { $uninstall.Dispose() }
      } finally { $base.Dispose() }
    }
  }
  return $found.ToArray()
}

function Has-WebViewRuntime {
  foreach ($path in @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  )) {
    if (Test-Path -LiteralPath $path) {
      $version = Get-ItemPropertyValue -LiteralPath $path -Name 'pv' -ErrorAction SilentlyContinue
      if ($version -and $version -ne '0.0.0.0') { return $true }
    }
  }
  return $false
}

function Get-ControlledEnvironment {
  # Do not inherit API keys/provider environment from the runner. Keep only
  # Windows runtime variables and the explicit isolated profile variables.
  $allowed = @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
    'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles',
    'CommonProgramFiles(x86)', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH')
  $childEnvironment = @{}
  foreach ($name in $allowed) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $value) { $childEnvironment[$name] = $value }
  }
  $childEnvironment['EASTGENESIS_QA_PROVIDER_BASE_URL'] = 'http://127.0.0.1:1'
  $childEnvironment['EASTGENESIS_QA_PROVIDER_MODEL'] = 'fixture-model'
  $childEnvironment['EASTGENESIS_QA_PROVIDER_PROTOCOL'] = 'openai'
  $childEnvironment['EASTGENESIS_QA_ISOLATED_PROFILE'] = '1'
  # The executable refuses GUI startup before Tauri/storage initialization if
  # the exact QA override is absent, even after the pre-install probe succeeds.
  $childEnvironment['EASTGENESIS_QA_INSTALL_ISOLATION_REQUIRED'] = '1'
  if ($null -ne $script:startupTraceRunId) {
    $childEnvironment['EASTGENESIS_QA_STARTUP_DIAGNOSTICS'] = '1'
    $childEnvironment['EASTGENESIS_QA_STARTUP_RUN_ID'] = $script:startupTraceRunId
  }
  return $childEnvironment
}

function Invoke-IsolationProbe {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $configuration.sourceBinary
  $info.Arguments = '--qa-install-isolation-probe'
  $info.WorkingDirectory = $configuration.profileDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables.Clear()
  foreach ($entry in (Get-ControlledEnvironment).GetEnumerator()) {
    $info.EnvironmentVariables[$entry.Key] = $entry.Value
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  $started = $false
  try {
    if (-not $process.Start()) { throw 'qa_probe_failed' }
    $started = $true
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) {
      $process.Kill()
      [void]$process.WaitForExit(5000)
      throw 'qa_probe_failed'
    }
    $text = $stdout.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { $script:stage = 'qa_isolation_missing'; throw 'qa_isolation_missing' }
    if ($text.Length -gt 4096 -or $stderr.GetAwaiter().GetResult().Length -ne 0) { throw 'qa_probe_failed' }
    $probe = $text | ConvertFrom-Json
    $expectedFields = @('schemaVersion', 'kind', 'passed', 'qaFaultsEnabled', 'isolatedAppDirectories', 'appDirectoriesOverride', 'errors')
    $fields = @($probe.PSObject.Properties.Name)
    if ($fields.Count -ne $expectedFields.Count -or @($fields | Where-Object { $_ -notin $expectedFields }).Count -ne 0 -or
        $probe.schemaVersion -ne 1 -or $probe.kind -ne 'desktop-qa-install-isolation' -or
        $probe.passed -isnot [bool] -or -not $probe.passed -or
        $probe.qaFaultsEnabled -isnot [bool] -or -not $probe.qaFaultsEnabled -or
        $probe.isolatedAppDirectories -isnot [bool] -or -not $probe.isolatedAppDirectories -or
        $probe.appDirectoriesOverride -cne './eg-qa-appdata' -or $probe.errors -isnot [Array] -or $probe.errors.Count -ne 0) { throw 'qa_probe_failed' }
    # Bind the probe to the pristine source used to derive the expected payload.
    if ((Get-FileHash -LiteralPath $configuration.sourceBinary -Algorithm SHA256).Hash -ne $sourceHash) { throw 'qa_probe_failed' }
    Record-Check 'sourceBinaryIsolationProbe'
  } finally {
    if ($started -and -not $process.HasExited) {
      $process.Kill()
      [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
  }
}

function Start-Controlled([string]$Binary, [string]$Arguments, [string]$LaunchRole = 'unknown') {
  $script:lastProcessJobFailure = $null
  $script:lastProcessStartInputFacts = $null
  try {
    $childEnvironment = Get-ControlledEnvironment
    $job = [EastGenesisInstall.Native]::CreateControlledJob()
    $jobHandles.Add($job)
    # Native Start binds a CREATE_SUSPENDED process to this job before its
    # primary thread can execute. No child can race ahead of AssignJob.
    $process = [EastGenesisInstall.Native]::Start($job, $Binary, $Arguments, $configuration.profileDirectory, $childEnvironment, $LaunchRole)
  } catch {
    # PowerShell wraps Add-Type exceptions. Unwrap only a bounded chain and
    # project fixed fields; never retain Message, StackTrace or path text.
    $failure = $_.Exception
    for ($depth = 0; $depth -lt 4 -and $failure -isnot [EastGenesisInstall.LaunchFailure] -and $null -ne $failure.InnerException; $depth++) { $failure = $failure.InnerException }
    if ($failure -is [EastGenesisInstall.LaunchFailure]) {
      $script:lastProcessJobFailure = [ordered]@{
        stage = $failure.FailureStage; win32Error = $failure.Win32Error
        hresult = $failure.ManagedHResult; suspendCount = $failure.SuspendCount
      }
      $script:lastProcessStartInputFacts = $failure.ProcessStartInputFacts
    } else {
      $script:lastProcessJobFailure = [ordered]@{ stage = 'unknown'; win32Error = $null; hresult = $_.Exception.HResult; suspendCount = $null }
    }
    $script:stage = 'process_job'
    throw 'process_job'
  }
  return [pscustomobject]@{ process = $process; job = $job }
}

function Wait-Command($Handle, [int]$Timeout = 60000) {
  if (-not $Handle.process.WaitForExit($Timeout)) {
    [EastGenesisInstall.Native]::Terminate($Handle.job)
    [void]$Handle.process.WaitForExit(5000)
    throw 'command_timeout'
  }
  $code = $Handle.process.ExitCode
  [EastGenesisInstall.Native]::Terminate($Handle.job)
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([EastGenesisInstall.Native]::Active($Handle.job) -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if ([EastGenesisInstall.Native]::Active($Handle.job) -ne 0 -or $code -ne 0) { throw 'command_failed' }
}

function Stop-App($Handle, [int]$Cycle) {
  $graceful = $false
  if (-not $Handle.process.HasExited) {
    $Handle.process.Refresh()
    $requested = $Handle.process.CloseMainWindow()
    if ($requested) { $graceful = $Handle.process.WaitForExit(5000) }
  }
  if ($graceful) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([EastGenesisInstall.Native]::Active($Handle.job) -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  }
  $forced = -not ($graceful -and [EastGenesisInstall.Native]::Active($Handle.job) -eq 0)
  if ($forced) {
    [EastGenesisInstall.Native]::Terminate($Handle.job)
    [void]$Handle.process.WaitForExit(5000)
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([EastGenesisInstall.Native]::Active($Handle.job) -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not $Handle.process.HasExited -or [EastGenesisInstall.Native]::Active($Handle.job) -ne 0) {
    $script:stage = 'process_termination'
    throw 'process_termination'
  }
  if (-not $stableStarts.ContainsKey($Cycle)) { $script:stage = 'process_start'; throw 'process_start' }
  $launches.Add([pscustomobject]@{
    cycle = $Cycle; graceful = -not $forced; forced = $forced; processTreeGone = $true
    stableWindowMs = $stableStarts[$Cycle]; survivedStableWindow = $true
    jobAssignedBeforeExecution = $true
  })
}

function Read-ProbeFailureStage([string]$Path) {
  # The probe writes only a fixed label on failure. Never retain Python stderr
  # or forward a malformed result, even when the process failed to exit cleanly.
  try {
    Assert-Within $Path $configuration.profileDirectory
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Item -LiteralPath $Path).Length -gt 4096) { return $null }
    $failure = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $fields = @($failure.PSObject.Properties.Name)
    if ($fields.Count -eq 1 -and $fields[0] -ceq 'probeFailureStage' -and
        $failure.probeFailureStage -cin @('sqlite_open', 'schema_query', 'schema_result', 'seed_write', 'sentinel_query', 'sqlite_close', 'output_write', 'mode_invalid')) {
      return $failure.probeFailureStage
    }
  } catch { }
  return $null
}

function Sqlite-Probe([string]$Mode) {
  $script:lastProbeFailureStage = 'path_guard'
  $probeOutput = Join-Path $configuration.profileDirectory 'sqlite-probe-result.json'
  try {
    Assert-Within $database $configuration.installDirectory
    Assert-Within $probeOutput $configuration.profileDirectory
    if (Test-Path -LiteralPath $probeOutput) { Remove-Item -LiteralPath $probeOutput -Force }
    $script:lastProbeFailureStage = 'process_job'
    $probeRole = switch ($Mode) { 'schema' { 'sqlite_schema_probe' } 'seed' { 'sqlite_seed' } 'sentinel' { 'sqlite_sentinel' } default { 'unknown' } }
    $handle = Start-Controlled $python "`"$pythonScript`" `"$database`" $Mode `"$probeOutput`"" $probeRole
    $script:lastProbeFailureStage = 'command_wait'
    try { Wait-Command $handle 10000 }
    catch {
      if ($_.Exception.Message -ceq 'command_failed') { $script:lastProbeFailureStage = 'command_exit' }
      $pythonFailure = Read-ProbeFailureStage $probeOutput
      if ($null -ne $pythonFailure) { $script:lastProbeFailureStage = $pythonFailure }
      throw
    }
    $script:lastProbeFailureStage = 'path_guard'
    Assert-Within $probeOutput $configuration.profileDirectory
    $script:lastProbeFailureStage = 'output_read'
    if ((Get-Item -LiteralPath $probeOutput).Length -gt 4096) { throw 'probe_output_invalid' }
    $text = Get-Content -LiteralPath $probeOutput -Raw
    $script:lastProbeFailureStage = 'output_parse'
    $result = $text | ConvertFrom-Json
    $script:lastProbeFailureStage = 'output_shape'
    $fields = @($result.PSObject.Properties.Name)
    if ($Mode -ceq 'schema') {
      $expected = @('schemaVersion', 'sessions', 'toolInvocations', 'leaseIndex')
      if ($fields.Count -ne 4 -or @($fields | Where-Object { $_ -cnotin $expected }).Count -ne 0 -or
          ($result.schemaVersion -isnot [int] -and $result.schemaVersion -isnot [long]) -or $result.schemaVersion -lt 0 -or
          $result.sessions -isnot [bool] -or $result.toolInvocations -isnot [bool] -or $result.leaseIndex -isnot [bool]) { throw 'probe_output_invalid' }
    } elseif ($Mode -ceq 'seed') {
      if ($fields.Count -ne 1 -or $fields[0] -cne 'seeded' -or $result.seeded -isnot [bool]) { throw 'probe_output_invalid' }
    } elseif ($Mode -ceq 'sentinel') {
      if ($fields.Count -ne 1 -or $fields[0] -cne 'present' -or $result.present -isnot [bool]) { throw 'probe_output_invalid' }
    } else { throw 'probe_output_invalid' }
    $script:lastProbeFailureStage = $null
    return $result
  } catch { throw }
}

function Capture-StartupState($Diagnostic) {
  # Observe the app job before cleanup. Counts/booleans are sufficient; do not
  # enumerate processes, record their IDs/names, inspect arguments, or start UI.
  try { $Diagnostic.databaseExists = [bool](Test-Path -LiteralPath $database -PathType Leaf) } catch { $Diagnostic.databaseExists = $null }
  if ($null -eq $script:app) { return }
  try {
    $script:app.process.Refresh()
    $Diagnostic.rootProcessAlive = -not $script:app.process.HasExited
  } catch { $Diagnostic.rootProcessAlive = $null }
  try {
    if ($Diagnostic.rootProcessAlive -eq $false) { $Diagnostic.rootWindowPresent = $false }
    else { $Diagnostic.rootWindowPresent = ($script:app.process.MainWindowHandle -ne [IntPtr]::Zero) }
  } catch { $Diagnostic.rootWindowPresent = $null }
  try { $Diagnostic.jobActiveProcessCount = [long][EastGenesisInstall.Native]::Active($script:app.job) }
  catch { $Diagnostic.jobActiveProcessCount = $null }
}

function Capture-StartupTrace([string]$RunId) {
  # The diagnostic lives beside the installed binary, never in appdata. Reading
  # it must not create a database directory or change the startup failure stage.
  $savedStage = $script:stage
  $trace = [ordered]@{ status = 'unobserved'; reason = 'capture_failed'; runId = $RunId; records = @() }
  try {
    if ($RunId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { return $trace }
    $tracePath = Join-Path $configuration.installDirectory "eg-qa-startup-$RunId.jsonl"
    $traceOutput = Join-Path $configuration.profileDirectory "startup-trace-$RunId.json"
    Assert-Within $tracePath $configuration.installDirectory
    Assert-Within $traceOutput $configuration.profileDirectory
    Assert-NotReparse $configuration.nodeBinary
    Assert-NotReparse $configuration.startupTraceReader
    if (Test-Path -LiteralPath $traceOutput) { return $trace }
    $reader = Start-Controlled $configuration.nodeBinary "`"$($configuration.startupTraceReader)`" --trace `"$tracePath`" --run-id $RunId --output `"$traceOutput`"" 'startup_trace_reader'
    # This is a bounded read after the existing startup wait, not additional
    # time for a missing database to become ready. Read before process cleanup.
    Wait-Command $reader 3000
    Assert-Within $traceOutput $configuration.profileDirectory
    if (-not (Test-Path -LiteralPath $traceOutput -PathType Leaf) -or (Get-Item -LiteralPath $traceOutput).Length -gt 32768) { return $trace }
    $result = Get-Content -LiteralPath $traceOutput -Raw | ConvertFrom-Json
    $fields = @($result.PSObject.Properties.Name)
    if ($fields.Count -ne 4 -or @($fields | Where-Object { $_ -cnotin @('status', 'reason', 'runId', 'records') }).Count -ne 0 -or
        $result.runId -cne $RunId -or $result.status -cnotin @('observed', 'unobserved') -or
        $result.reason -cnotin @('complete', 'record_limit', 'missing', 'invalid', 'read_failed', 'capture_failed') -or
        $result.records -isnot [Array] -or $result.records.Count -gt 64) { return $trace }
    if (($result.status -ceq 'observed' -and ($result.records.Count -lt 1 -or $result.reason -cnotin @('complete', 'record_limit'))) -or
        ($result.status -ceq 'unobserved' -and ($result.records.Count -ne 0 -or $result.reason -cin @('complete', 'record_limit')))) { return $trace }
    # The reader validates every JSONL field, stage/source combination, UUID,
    # sequence and size before writing this fixed projection. The JS public
    # report consumer validates these records again before any publication.
    return [ordered]@{ status = $result.status; reason = $result.reason; runId = $RunId; records = @($result.records) }
  } catch {
    return $trace
  } finally {
    $script:stage = $savedStage
  }
}

function Start-App([int]$Cycle) {
  $script:startupTraceRunId = [Guid]::NewGuid().ToString('D').ToLowerInvariant()
  $runId = $script:startupTraceRunId
  $diagnostic = [ordered]@{
    cycle = $Cycle; outcome = 'failed'; failureStage = 'unknown'; elapsedMs = 0; stableWindowPassed = $false
    databaseExists = $null; schemaProbeAttempts = 0; schemaProbeFailures = 0; schemaProbeState = 'not_attempted'; lastProbeFailureStage = $null
    rootProcessAlive = $null; rootWindowPresent = $null; jobActiveProcessCount = $null
    processJobFailure = $null
    startupTrace = [ordered]@{ status = 'unobserved'; reason = 'capture_failed'; runId = $runId; records = @() }
  }
  $startupDiagnostics.Add($diagnostic)
  $startupClock = [Diagnostics.Stopwatch]::StartNew()
  try {
    Assert-Within $binary $configuration.installDirectory
    Assert-Within $dataRoot $configuration.installDirectory
    $script:app = Start-Controlled $binary '' 'installed_app'
    # Cycle 2 already has schema 7 from cycle 1. A database read alone cannot
    # prove the repaired executable keeps running. Require every new process to
    # survive a full stable window before considering its database evidence.
    $stableClock = [Diagnostics.Stopwatch]::StartNew()
    while ($stableClock.ElapsedMilliseconds -lt 4000) {
      if ($app.process.HasExited) { $script:stage = 'process_start'; throw 'process_start' }
      Start-Sleep -Milliseconds 100
    }
    if ($app.process.HasExited) { $script:stage = 'process_start'; throw 'process_start' }
    $stableStarts[$Cycle] = [long]$stableClock.ElapsedMilliseconds
    $diagnostic.stableWindowPassed = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($app.process.HasExited) { $script:stage = 'process_start'; throw 'process_start' }
      if (Test-Path -LiteralPath $database -PathType Leaf) {
        $diagnostic.schemaProbeAttempts++
        $diagnostic.schemaProbeState = 'pending'
        try {
          $probe = Sqlite-Probe 'schema'
          if ($app.process.HasExited) { $script:stage = 'process_start'; throw 'process_start' }
          if ($probe.schemaVersion -eq 7 -and $probe.sessions -and $probe.toolInvocations -and $probe.leaseIndex) {
            $diagnostic.schemaProbeState = 'ready'
            $diagnostic.outcome = 'database_ready'; $diagnostic.failureStage = $null
            return
          }
        } catch {
          if ($null -ne $script:lastProbeFailureStage) {
            $diagnostic.schemaProbeFailures++
            $diagnostic.schemaProbeState = 'failed'
            $diagnostic.lastProbeFailureStage = $script:lastProbeFailureStage
          }
          if ($script:lastProbeFailureStage -eq 'process_job') { $script:stage = 'process_job'; throw }
          if ($script:stage -eq 'reparse_point' -or $app.process.HasExited) { throw }
          # Database file creation precedes migration completion. Fixed probe
          # failure stages distinguish that wait from an absent database.
        }
      }
      Start-Sleep -Milliseconds 200
    }
    $script:stage = 'database_timeout'
    throw 'database_timeout'
  } catch {
    if ($script:stage -cin @('process_start', 'process_job', 'database_timeout', 'reparse_point', 'isolated_root')) { $diagnostic.failureStage = $script:stage }
    else { $diagnostic.failureStage = 'unknown' }
    if ($diagnostic.failureStage -eq 'process_job') {
      $diagnostic.processJobFailure = $script:lastProcessJobFailure
      if ($null -ne $script:lastProcessStartInputFacts) { $diagnostic.processStartInputFacts = $script:lastProcessStartInputFacts }
    }
    throw
  } finally {
    $diagnostic.startupTrace = Capture-StartupTrace $runId
    $script:startupTraceRunId = $null
    $diagnostic.elapsedMs = [long]$startupClock.ElapsedMilliseconds
    Capture-StartupState $diagnostic
  }
}

function Check-Registration {
  $registrations = @(Find-Registrations)
  if ($registrations.Count -eq 0) { throw 'installed_registry' }
  foreach ($registration in $registrations) {
    if ($registration.hive -ne 'CurrentUser' -or $registration.version -ne $packageVersion -or
        $registration.location.Trim('"') -ne $configuration.installDirectory -or
        $registration.uninstall.Trim('"') -ne $uninstaller) { throw 'installed_registry' }
  }
}

function Invoke-Uninstall {
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { $script:stage = 'uninstall_missing'; throw 'uninstall_missing' }
  Assert-Within $uninstaller $configuration.installDirectory
  # Execute a copy so NSIS can delete the installed uninstall.exe while _?=
  # keeps it in-process, allowing WaitForExit to cover the real uninstall.
  $copy = Join-Path $configuration.profileDirectory 'qa-uninstall.exe'
  Copy-Item -LiteralPath $uninstaller -Destination $copy -Force
  $script:stage = 'nsis_uninstall'
  $handle = Start-Controlled $copy "/S _?=$($configuration.installDirectory)" 'nsis_uninstall'
  $attempts.uninstall = $true
  Wait-Command $handle
  Record-Check 'nsisUninstall'
  $script:stage = 'uninstall_payload'
  if (Test-Path -LiteralPath $binary) { throw 'uninstall_payload' }
  Record-Check 'installedBinaryRemoved'
  $script:stage = 'uninstall_registry'
  if (@(Find-Registrations).Count -ne 0) { throw 'uninstall_registry' }
  Record-Check 'uninstallRegistryRemoved'
  $script:installed = $false
}

try {
  $stage = 'runner_unsupported'
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'runner_unsupported' }
  Record-Check 'hostedRunner'
  $stage = 'isolated_root'
  $configuration = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
  if ($configuration.dataDirectory -ne 'eg-qa-appdata') { throw 'isolated_root' }
  $root = Split-Path -Parent $InputFile
  Assert-Within $configuration.installDirectory $root
  Assert-Within $configuration.profileDirectory $root
  $binary = Join-Path $configuration.installDirectory 'eastgenesis-desktop.exe'
  $uninstaller = Join-Path $configuration.installDirectory 'uninstall.exe'
  $dataRoot = Join-Path $configuration.installDirectory $configuration.dataDirectory
  $database = Join-Path $dataRoot 'eastgenesis.db'
  if (Test-Path -LiteralPath $configuration.installDirectory) { throw 'isolated_root' }
  $stage = 'existing_installation'
  if (@(Find-Registrations).Count -ne 0) { throw 'existing_installation' }
  $stage = 'existing_configuration'
  foreach ($folder in @([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData'))) {
    if (-not $folder -or (Test-Path -LiteralPath (Join-Path $folder 'com.eastgenesis.desktop'))) { throw 'existing_configuration' }
  }
  $stage = 'existing_process'
  if (@(Get-Process -Name 'eastgenesis-desktop' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'existing_process' }
  Record-Check 'noExistingInstallation'
  $stage = 'webview2_missing'
  if (-not (Has-WebViewRuntime)) { throw 'webview2_missing' }
  Record-Check 'webView2Present'
  $stage = 'package_metadata'
  Assert-NotReparse $configuration.packagePath
  Assert-NotReparse $configuration.sourceBinary
  $sourceBytes = [IO.File]::ReadAllBytes($configuration.sourceBinary)
  # Only executables explicitly supporting this protocol may be invoked with
  # its flag. Older binaries could treat an unknown flag as ordinary GUI start.
  # The raw ASCII marker proves support, never the embedded isolation setting.
  $stage = 'qa_probe_unsupported'
  $marker = 'EASTGENESIS_QA_INSTALL_ISOLATION_PROBE_SUPPORTED_V1_6F725CB3'
  if (-not [Text.Encoding]::ASCII.GetString($sourceBytes).Contains($marker)) { throw 'qa_probe_unsupported' }
  $stage = 'payload_binding_invalid'
  $payloadBinding = Get-NsisPayloadBinding $sourceBytes
  $sourceHash = $payloadBinding.sourceSha256
  if ((Get-FileHash -LiteralPath $configuration.sourceBinary -Algorithm SHA256).Hash -ne $sourceHash) { throw 'payload_binding_invalid' }
  $stage = 'package_metadata'
  $packageVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($configuration.packagePath).ProductVersion
  $binaryVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($configuration.sourceBinary).ProductVersion
  if (-not $packageVersion -or $packageVersion -ne $binaryVersion) { throw 'package_metadata' }
  $stage = 'runtime_missing'
  $python = Resolve-PythonApplication
  $pythonScript = Join-Path $configuration.profileDirectory 'sqlite-probe.py'
  @'
import json, sqlite3, sys
from pathlib import Path
path, mode, output_path = sys.argv[1:]
failure_stage = 'sqlite_open'
db = None
exit_code = 0
try:
    if mode == 'seed':
        db = sqlite3.connect(path, timeout=3)
        failure_stage = 'seed_write'
        db.execute("INSERT OR REPLACE INTO sessions (id,title,turns,created_at,updated_at) VALUES ('qa-nsis-session-sentinel','QA install sentinel','[]',1,1)")
        db.commit()
        result = {'seeded': True}
    else:
        db = sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True, timeout=3)
        if mode == 'schema':
            failure_stage = 'schema_query'
            row = db.execute("SELECT (SELECT value FROM app_meta WHERE key='schema_version'), EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'), EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_invocations'), EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='tool_invocations_lease')").fetchone()
            failure_stage = 'schema_result'
            result = {'schemaVersion': int(row[0] or 0), 'sessions': bool(row[1]), 'toolInvocations': bool(row[2]), 'leaseIndex': bool(row[3])}
        elif mode == 'sentinel':
            failure_stage = 'sentinel_query'
            row = db.execute("SELECT COUNT(*) FROM sessions WHERE id='qa-nsis-session-sentinel' AND title='QA install sentinel' AND turns='[]' AND deleted_at IS NULL").fetchone()
            result = {'present': row[0] == 1}
        else:
            failure_stage = 'mode_invalid'
            raise RuntimeError()
    failure_stage = 'sqlite_close'
    db.close()
    db = None
except Exception:
    result = {'probeFailureStage': failure_stage}
    exit_code = 1
finally:
    if db is not None:
        try:
            db.close()
        except Exception:
            pass
try:
    Path(output_path).write_text(json.dumps(result), encoding='utf-8')
except Exception:
    sys.exit(2)
sys.exit(exit_code)
'@ | Set-Content -LiteralPath $pythonScript -Encoding UTF8
  $stage = 'process_job'
  Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
namespace EastGenesisInstall {
  public sealed class LaunchFailure : Exception {
    public string FailureStage { get; private set; }
    public uint? Win32Error { get; private set; }
    public int? ManagedHResult { get; private set; }
    public uint? SuspendCount { get; private set; }
    public IDictionary ProcessStartInputFacts { get; private set; }
    public LaunchFailure(string stage, uint? win32Error, int? hresult, uint? suspendCount, IDictionary inputFacts = null) : base("process_job") {
      FailureStage = stage; Win32Error = win32Error; ManagedHResult = hresult; SuspendCount = suspendCount; ProcessStartInputFacts = inputFacts;
    }
    public static LaunchFailure Win32(string stage, uint? suspendCount = null, IDictionary inputFacts = null) {
      int code = Marshal.GetLastWin32Error();
      return new LaunchFailure(stage, unchecked((uint)code), null, suspendCount, inputFacts);
    }
  }
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Extended { public BasicLimit Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public uint Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
      public uint Size; public string Reserved, Desktop, Title;
      public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
      public ushort ShowWindow, ReservedSize; public IntPtr ReservedPointer, StdIn, StdOut, StdErr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes security, uint disposition, uint attributes, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr CreateControlledJob() {
      IntPtr job = IntPtr.Zero, memory = IntPtr.Zero;
      string stage = "job_create";
      try {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LaunchFailure.Win32(stage);
        stage = "job_limit";
        Extended info = new Extended(); info.Basic.Flags = 0x2000;
        int size = Marshal.SizeOf(info); memory = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(info, memory, false);
        if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw LaunchFailure.Win32(stage);
        return job;
      } catch (LaunchFailure) { if (job != IntPtr.Zero) CloseHandle(job); throw; }
      catch (Exception error) { var failure = new LaunchFailure(stage, null, error.HResult, null); if (job != IntPtr.Zero) CloseHandle(job); throw failure; }
      finally { if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory); }
    }
    // Facts inspect the exact launch inputs but never alter or print them.
    // Length is the actual UTF-16 length, or null when outside this schema bound.
    static object FactLength(string value) { return value != null && value.Length <= 65535 ? (object)value.Length : null; }
    static IDictionary PathInputFacts(string value, bool application) {
      IDictionary facts = new Hashtable {
        { "charLength", null }, { "containsNul", null }, { "containsCrLf", null }, { "containsQuote", null },
        { "edgeWhitespace", null }, { "rooted", null }, { "pathForm", "unknown" },
        { "exists", null }, { "fullPathComparison", "unknown" }
      };
      if (value == null) return facts;
      facts["charLength"] = FactLength(value);
      facts["containsNul"] = value.IndexOf('\0') >= 0;
      facts["containsCrLf"] = value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0;
      facts["containsQuote"] = value.IndexOf('"') >= 0;
      facts["edgeWhitespace"] = value.Length > 0 && (Char.IsWhiteSpace(value[0]) || Char.IsWhiteSpace(value[value.Length - 1]));
      try { facts["rooted"] = System.IO.Path.IsPathRooted(value); } catch { }
      try {
        bool drive = value.Length >= 2 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':';
        bool driveAbsolute = drive && value.Length >= 3 && (value[2] == '\\' || value[2] == '/');
        facts["pathForm"] = value.StartsWith(@"\\?\", StringComparison.Ordinal) || value.StartsWith(@"\\.\", StringComparison.Ordinal) ? "device"
          : value.StartsWith(@"\\", StringComparison.Ordinal) ? "unc"
          : driveAbsolute ? "drive_absolute" : drive ? "drive_relative"
          : value.StartsWith(@"\", StringComparison.Ordinal) || value.StartsWith("/", StringComparison.Ordinal) ? "root_relative" : "relative";
      } catch { }
      // Exists is a best-effort observation, file for application and directory for cwd.
      try { facts["exists"] = application ? System.IO.File.Exists(value) : System.IO.Directory.Exists(value); } catch { }
      try { facts["fullPathComparison"] = String.Equals(System.IO.Path.GetFullPath(value), value, StringComparison.Ordinal) ? "same" : "different"; }
      catch { facts["fullPathComparison"] = "failed"; }
      return facts;
    }
    static IDictionary CaptureStartInputFacts(string role, string binary, string directory, StringBuilder command) {
      try {
        string[] roles = { "installed_app", "sqlite_schema_probe", "sqlite_seed", "sqlite_sentinel", "startup_trace_reader", "nsis_install", "nsis_uninstall", "unknown" };
        string text = command == null ? null : command.ToString();
        return new Hashtable {
          { "launchRole", Array.IndexOf(roles, role) >= 0 ? role : "unknown" },
          { "application", PathInputFacts(binary, true) }, { "cwd", PathInputFacts(directory, false) },
          { "command", new Hashtable {
            { "charLength", FactLength(text) }, { "containsNul", text == null ? null : (object)(text.IndexOf('\0') >= 0) },
            { "containsCrLf", text == null ? null : (object)(text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0) },
            { "quotedApplicationPrefix", text == null || binary == null ? null : (object)text.StartsWith("\"" + binary + "\" ", StringComparison.Ordinal) }
          } }
        };
      } catch { return null; }
    }
    public static Process Start(IntPtr job, string binary, string arguments, string directory, IDictionary environment, string launchRole) {
      // Suspend before executing any application code. Binding after an
      // ordinary Process.Start would allow early children to escape the job.
      string stage = "stdio_create";
      IntPtr nul = IntPtr.Zero;
      IntPtr block = IntPtr.Zero;
      ProcessInformation info = new ProcessInformation();
      bool created = false, resumed = false;
      Process managed = null;
      IDictionary inputFacts = null;
      try {
        SecurityAttributes security = new SecurityAttributes();
        security.Length = (uint)Marshal.SizeOf(security); security.Inherit = 1;
        nul = CreateFile("NUL", 0xc0000000, 3, ref security, 3, 0x80, IntPtr.Zero);
        if (nul == new IntPtr(-1)) throw LaunchFailure.Win32(stage);
        stage = "environment_block";
        SortedDictionary<string, string> sorted = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry item in environment) sorted.Add((string)item.Key, (string)item.Value);
        StringBuilder variables = new StringBuilder();
        foreach (KeyValuePair<string, string> item in sorted) variables.Append(item.Key).Append('=').Append(item.Value).Append('\0');
        variables.Append('\0');
        block = Marshal.StringToHGlobalUni(variables.ToString());
        StartupInfo startup = new StartupInfo();
        startup.Size = (uint)Marshal.SizeOf(startup); startup.Flags = 0x100;
        startup.StdIn = nul; startup.StdOut = nul; startup.StdErr = nul;
        StringBuilder command = new StringBuilder("\"" + binary + "\" " + arguments);
        inputFacts = CaptureStartInputFacts(launchRole, binary, directory, command);
        // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT. The job enables only
        // KILL_ON_JOB_CLOSE, never BREAKAWAY_OK or SILENT_BREAKAWAY_OK.
        stage = "process_create";
        if (!CreateProcess(binary, command, IntPtr.Zero, IntPtr.Zero, true, 0x404, block, directory, ref startup, out info)) throw LaunchFailure.Win32(stage, null, inputFacts);
        created = true;
        stage = "job_assign";
        if (!AssignProcessToJobObject(job, info.Process)) throw LaunchFailure.Win32(stage, null, inputFacts);
        stage = "process_lookup";
        managed = Process.GetProcessById((int)info.ProcessId);
        stage = "process_handle";
        IntPtr retainedHandle = managed.Handle;
        stage = "process_resume";
        uint suspendCount = ResumeThread(info.Thread);
        if (suspendCount == uint.MaxValue) throw LaunchFailure.Win32(stage, suspendCount, inputFacts);
        if (suspendCount != 1) throw new LaunchFailure(stage, null, null, suspendCount, inputFacts);
        resumed = true;
        return managed;
      } catch (LaunchFailure) { throw; }
      catch (Exception error) { throw new LaunchFailure(stage, null, error.HResult, null, inputFacts); }
      finally {
        if (created && !resumed) { TerminateProcess(info.Process, 1); if (managed != null) managed.Dispose(); }
        if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
        if (info.Process != IntPtr.Zero) CloseHandle(info.Process);
        if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
        if (nul != IntPtr.Zero && nul != new IntPtr(-1)) CloseHandle(nul);
      }
    }
    public static uint Active(IntPtr job) { Accounting info; if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Exception("job_query"); return info.ActiveProcesses; }
    public static void Terminate(IntPtr job) { if (!TerminateJobObject(job, 1)) throw new Exception("job_terminate"); }
  }
}
'@ | Out-Null
  $nativeReady = $true
  foreach ($name in @('APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP')) {
    $environmentSnapshot[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $roaming = Join-Path $configuration.profileDirectory 'roaming'
  $local = Join-Path $configuration.profileDirectory 'local'
  $temp = Join-Path $configuration.profileDirectory 'temp'
  foreach ($folder in @($roaming, $local, $temp)) { [void][IO.Directory]::CreateDirectory($folder) }
  foreach ($entry in @(@('APPDATA', $roaming), @('LOCALAPPDATA', $local), @('USERPROFILE', $configuration.profileDirectory),
      @('HOME', $configuration.profileDirectory), @('HOMEDRIVE', [IO.Path]::GetPathRoot($configuration.profileDirectory).TrimEnd('\')),
      @('HOMEPATH', $configuration.profileDirectory.Substring([IO.Path]::GetPathRoot($configuration.profileDirectory).Length - 1)), @('TEMP', $temp), @('TMP', $temp))) {
    [Environment]::SetEnvironmentVariable($entry[0], $entry[1], 'Process')
  }
  $stage = 'qa_probe_failed'
  Invoke-IsolationProbe
  $stage = 'nsis_install'
  # NSIS requires /D last and unquoted even when the path contains spaces.
  $handle = Start-Controlled $configuration.packagePath "/S /NS /D=$($configuration.installDirectory)" 'nsis_install'
  $attempts.install = $true
  $installed = $true
  Wait-Command $handle
  Record-Check 'nsisInstall'
  $stage = 'payload_missing'
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'payload_missing' }
  Assert-Within $binary $configuration.installDirectory
  $stage = 'payload_mismatch'
  $payloadBinding.installedSha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($payloadBinding.installedSha256 -cne $payloadBinding.expectedNsisSha256) { throw 'payload_mismatch' }
  Record-Check 'installedPayload'
  $stage = 'installed_registry'
  Check-Registration
  Record-Check 'installedRegistry'
  $stage = 'process_start'
  Start-App 1
  Record-Check 'installedBinaryStable'
  Record-Check 'installedBinaryStart'
  Record-Check 'qaDataIsolation'
  Record-Check 'sqliteSchema'
  Stop-App $app 1
  $app = $null
  Record-Check 'controlledTermination'
  $stage = 'session_sentinel'
  if (-not (Sqlite-Probe 'seed').seeded -or -not (Sqlite-Probe 'sentinel').present) { throw 'session_sentinel' }
  Record-Check 'sessionSentinelSeeded'
  # A missing payload makes this a repair proof rather than a no-op same-version
  # installer invocation. No app data or original source binary is removed.
  Assert-Within $binary $configuration.installDirectory
  Remove-Item -LiteralPath $binary -Force
  $stage = 'same_package_reinstall'
  $handle = Start-Controlled $configuration.packagePath "/S /NS /D=$($configuration.installDirectory)" 'nsis_install'
  $attempts.reinstall = $true
  Wait-Command $handle
  Record-Check 'samePackageReinstall'
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'same_package_reinstall' }
  Assert-Within $binary $configuration.installDirectory
  $payloadBinding.repairedSha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($payloadBinding.repairedSha256 -cne $payloadBinding.expectedNsisSha256) { throw 'same_package_reinstall' }
  Check-Registration
  Record-Check 'repairedPayload'
  $stage = 'process_start'
  Start-App 2
  Stop-App $app 2
  $app = $null
  $stage = 'session_sentinel'
  if (-not (Sqlite-Probe 'sentinel').present) { throw 'session_sentinel' }
  Record-Check 'sessionSentinelPreserved'
  Invoke-Uninstall
} catch {
  # Use only a fixed stage label. Original errors can contain local paths.
  $errors.Add($stage)
} finally {
  if ($nativeReady) {
    foreach ($job in $jobHandles) {
      try { [EastGenesisInstall.Native]::Terminate($job) } catch { $errors.Add('cleanup_failed') }
    }
    if ($installed) {
      try { Invoke-Uninstall } catch { $errors.Add('cleanup_failed') }
    }
    foreach ($job in $jobHandles) {
      try { if (-not [EastGenesisInstall.Native]::CloseHandle($job)) { $errors.Add('cleanup_failed') } } catch { $errors.Add('cleanup_failed') }
    }
  }
  foreach ($name in $environmentSnapshot.Keys) {
    [Environment]::SetEnvironmentVariable($name, $environmentSnapshot[$name], 'Process')
  }
  if ($errors.Count -eq 0) { Record-Check 'cleanup' }
  $report = [ordered]@{
    schemaVersion = 1; passed = ($errors.Count -eq 0); checks = $checks
    stages = $stages.ToArray(); errors = $errors.ToArray(); launches = $launches.ToArray(); attempts = $attempts; payloadBinding = $payloadBinding
    startupDiagnostics = $startupDiagnostics.ToArray()
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputFile -Encoding UTF8
}
