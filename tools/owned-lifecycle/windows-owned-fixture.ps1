param(
  [Parameter(Mandatory=$true)][ValidateSet('leaf','parent','eof','fast')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Token,
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Script
)
if (-not $IsWindows) { throw 'platform_unsupported' }
$ErrorActionPreference='Stop'
if ([IO.Path]::GetFileName($Script) -ieq 'MEMORY.md') { throw 'input_forbidden' }
if ($Mode -eq 'fast') { exit 0 }
if ($env:EG_FIXTURE_TOKEN -cne $Token -or $env:EG_OWNED_ROOT -cne $Root) { throw 'fixture_nonce_unbound' }
$profileKeys=@('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP')
foreach($key in $profileKeys) {
  if ([Environment]::GetEnvironmentVariable($key,'Process') -cne $Root) { throw 'fixture_environment_unbound' }
}
if ([Environment]::CurrentDirectory -cne $Root -or $PWD.Path -cne $Root) { throw 'fixture_cwd_unbound' }
$self=[Diagnostics.Process]::GetCurrentProcess()
$children=@()
if ($Mode -eq 'parent') {
  for($i=0;$i -lt 2;$i++) {
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$Executable
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.WorkingDirectory=$Root
    foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-File',$Script,'-Mode','leaf','-Root',$Root,'-Token',$Token,'-Executable',$Executable,'-Script',$Script)) { $info.ArgumentList.Add($arg) }
    $child=[Diagnostics.Process]::new();$child.StartInfo=$info
    if (-not $child.Start()) { throw 'fixture_child_start' }
    $children+=,$child
  }
  $watch=[Diagnostics.Stopwatch]::StartNew()
  while($watch.ElapsedMilliseconds -lt 10000) {
    $ready=0
    foreach($child in $children) { if([IO.File]::Exists((Join-Path $Root "ready-$($child.Id).json"))) {$ready++} }
    if($ready -eq 2){break}
    Start-Sleep -Milliseconds 20
  }
  if($ready -ne 2) { throw 'fixture_children_not_ready' }
}
$record=[ordered]@{
  schemaVersion=1; pid=$PID; creationTime=$self.StartTime.ToFileTimeUtc().ToString()
  token=$Token; cwd=[Environment]::CurrentDirectory
  image=$self.MainModule.FileName
  profileEnvironmentBound=$true
  actualProfileKeys=$profileKeys
  childPids=@($children|ForEach-Object{$_.Id})
  restrictedCreateProcessInputVerifiedByFixture=$true
  remoteProcessParametersRead=$false
}
$readyPath=Join-Path $Root "ready-$PID.json"
# CreateNew rejects collision. File content is only owned paths and a QA nonce.
$stream=[IO.FileStream]::new($readyPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try {
  $bytes=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Compress -Depth 5))
  $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
} finally { $stream.Dispose() }
if($Mode -eq 'eof') {
  if ($null -ne [Console]::ReadLine()) { throw 'fixture_eof_expected' }
  exit 0
}
while($true) { Start-Sleep -Milliseconds 50 }
