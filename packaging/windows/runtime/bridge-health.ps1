[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$installRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA 'QqCodexCompletionNotifier'
$statePath = Join-Path $dataRoot 'state\bridge-process.json'
$productionEntry = Join-Path $installRoot 'dist\apps\bridge-daemon\src\production.js'
$stdoutPath = Join-Path $dataRoot 'logs\bridge.stdout.log'
$stderrPath = Join-Path $dataRoot 'logs\bridge.stderr.log'
$bridgeHealthUri = 'http://127.0.0.1:3100/health'
$cdpVersionUri = 'http://127.0.0.1:9229/json/version'

function Get-ProductionBridgeProcesses {
    $entryPattern = [regex]::Escape($productionEntry)
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.CommandLine -match $entryPattern })
}

function Test-CdpReady {
    try {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 9229 -ErrorAction Stop)
        if ($listeners.Count -eq 0) {
            return $false
        }
        if (@($listeners | Where-Object { @('127.0.0.1', '::1') -notcontains [string]$_.LocalAddress }).Count -gt 0) {
            return $false
        }
        if (@($listeners | Where-Object { [string]$_.LocalAddress -eq '127.0.0.1' }).Count -eq 0) {
            return $false
        }

        $version = Invoke-RestMethod -Uri $cdpVersionUri -Method Get -TimeoutSec 5
        -not [string]::IsNullOrWhiteSpace([string]$version.webSocketDebuggerUrl)
    }
    catch {
        $false
    }
}

$state = $null
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    }
    catch {
        $state = $null
    }
}

$instances = @(Get-ProductionBridgeProcesses)
$instanceCount = $instances.Count
$processRunning = $false
$lifecycleDetached = $false
if ($null -ne $state) {
    $daemon = @($instances | Where-Object { $_.ProcessId -eq [int]$state.daemonPid })
    $processRunning = $daemon.Count -eq 1
    if ($processRunning) {
        $daemonParent = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$daemon[0].ParentProcessId)" -ErrorAction SilentlyContinue
        $launcher = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$state.launcherPid)" -ErrorAction SilentlyContinue
        $lifecycleDetached = $null -ne $launcher -and
            [int]$daemon[0].ParentProcessId -eq [int]$state.daemonParentPid -and
            [string]$state.launcherType -eq 'detached-hidden-powershell' -and
            $null -ne $daemonParent
    }
}

$listenerReady = $false
$gatewayConnected = $false
$gatewayAuthenticated = $false
$bridgeHealthOk = $false
$completionMonitorHealthy = $false
$completionTargetConfigured = $false
try {
    $bridgeListeners = @(Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction Stop)
    $listenerReady = @(
        $bridgeListeners | Where-Object { [string]$_.LocalAddress -eq '127.0.0.1' }
    ).Count -gt 0

    if ($listenerReady) {
        $bridgeHealth = Invoke-RestMethod -Uri $bridgeHealthUri -Method Get -TimeoutSec 5 -ErrorAction Stop
        $bridgeHealthOk = $bridgeHealth.ok -eq $true
        if ($bridgeHealthOk) {
            $gatewayConnected = $bridgeHealth.qqGateway.connected -eq $true
            $gatewayAuthenticated = $bridgeHealth.qqGateway.authenticated -eq $true
            $completionMonitorHealthy = $bridgeHealth.completionMonitor.running -eq $true -and
                $bridgeHealth.completionMonitor.initialized -eq $true -and
                $bridgeHealth.completionMonitor.healthy -eq $true
            $completionTargetConfigured = $bridgeHealth.completionMonitor.targetConfigured -eq $true
        }
    }
}
catch {
    $bridgeHealthOk = $false
    $gatewayConnected = $false
    $gatewayAuthenticated = $false
    $completionMonitorHealthy = $false
    $completionTargetConfigured = $false
}

$cdpReady = Test-CdpReady
$codexCliSpawnCount = 0
foreach ($logPath in @($stdoutPath, $stderrPath)) {
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        $codexCliSpawnCount += @(
            Select-String -LiteralPath $logPath -Pattern 'spawn codex|codex app-server starting' -AllMatches -ErrorAction SilentlyContinue
        ).Count
    }
}

Write-Output "BRIDGE_PROCESS=$(if ($processRunning) { 'RUNNING' } else { 'FAIL' })"
Write-Output "BRIDGE_LISTENER=$(if ($listenerReady) { 'READY' } else { 'FAIL' })"
Write-Output "QQ_GATEWAY=$(if ($gatewayConnected -and $gatewayAuthenticated) { 'CONNECTED' } else { 'FAIL' })"
Write-Output "CODEX_CDP=$(if ($cdpReady) { 'READY' } else { 'FAIL' })"
Write-Output "COMPLETION_MONITOR=$(if ($completionMonitorHealthy) { 'HEALTHY' } else { 'FAIL' })"
Write-Output "TARGET_CONFIGURED=$(if ($completionTargetConfigured) { 'YES' } else { 'NO' })"
Write-Output "INSTANCE_COUNT=$instanceCount"
Write-Output "CODEX_CLI_SPAWN_COUNT=$codexCliSpawnCount"
Write-Output "BRIDGE_LIFECYCLE=$(if ($lifecycleDetached) { 'DETACHED' } else { 'FAIL' })"

if ($processRunning -and $listenerReady -and $bridgeHealthOk -and $gatewayConnected -and $gatewayAuthenticated -and $cdpReady -and
    $completionMonitorHealthy -and $completionTargetConfigured -and $instanceCount -eq 1 -and
    $codexCliSpawnCount -eq 0 -and $lifecycleDetached) {
    exit 0
}

exit 1

