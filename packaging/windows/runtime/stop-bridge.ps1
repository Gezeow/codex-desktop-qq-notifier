[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$installRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA 'QqCodexCompletionNotifier'
$statePath = Join-Path $dataRoot 'state\bridge-process.json'
$productionEntry = Join-Path $installRoot 'dist\apps\bridge-daemon\src\production.js'

if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    Write-Output 'BRIDGE_STOP=NOT_RUNNING'
    exit 0
}

try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
}
catch {
    throw 'Bridge state file is invalid. Refusing to stop an unidentified process.'
}

$daemon = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$state.daemonPid)" -ErrorAction SilentlyContinue
if ($null -eq $daemon) {
    Remove-Item -LiteralPath $statePath -Force
    Write-Output 'BRIDGE_STOP=STALE_STATE_REMOVED'
    exit 0
}
if ([string]$daemon.CommandLine -notmatch [regex]::Escape($productionEntry)) {
    throw "PID $($state.daemonPid) no longer matches the recorded bridge identity. Refusing to stop it."
}

Stop-Process -Id ([int]$state.daemonPid)
$deadline = [DateTimeOffset]::Now.AddSeconds(15)
while ([DateTimeOffset]::Now -lt $deadline) {
    if ($null -eq (Get-Process -Id ([int]$state.daemonPid) -ErrorAction SilentlyContinue)) {
        break
    }
    Start-Sleep -Milliseconds 250
}

if ($null -ne (Get-Process -Id ([int]$state.daemonPid) -ErrorAction SilentlyContinue)) {
    throw "Bridge PID $($state.daemonPid) did not stop within 15 seconds. No forced kill was attempted."
}

$launcher = Get-Process -Id ([int]$state.launcherPid) -ErrorAction SilentlyContinue
if ($null -ne $launcher) {
    $launcher | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $statePath -Force
Write-Output 'BRIDGE_STOP=STOPPED'

