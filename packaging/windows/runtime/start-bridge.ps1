[CmdletBinding()]
param(
    [switch]$DetachedWorker
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$installRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA 'QqCodexCompletionNotifier'
$logRoot = Join-Path $dataRoot 'logs'
$stateRoot = Join-Path $dataRoot 'state'
$databaseRoot = Join-Path $dataRoot 'data'
$configRoot = Join-Path $dataRoot 'config'
$credentialsPath = Join-Path $configRoot 'credentials.json'
$statePath = Join-Path $stateRoot 'bridge-process.json'
$workerReadyPath = Join-Path $stateRoot 'worker-ready.json'
$productionEntry = Join-Path $installRoot 'dist\apps\bridge-daemon\src\production.js'
$stdoutPath = Join-Path $logRoot 'bridge.stdout.log'
$stderrPath = Join-Path $logRoot 'bridge.stderr.log'
$launcherLogPath = Join-Path $logRoot 'bridge.launcher.log'
$healthScript = Join-Path $runtimeRoot 'bridge-health.ps1'
$nodePath = Join-Path $installRoot 'node\node.exe'
$expectedNodeVersion = 'v22.22.0'
$maxLogBytes = 5MB
$maxLogFiles = 3
$powershellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

function Initialize-RuntimeDirectories {
    New-Item -ItemType Directory -Path $logRoot,$stateRoot,$databaseRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
}

function Assert-StableNodeRuntime {
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        Write-Output 'STABLE_NODE_RUNTIME_MISSING'
        throw "Stable Node runtime is missing: $nodePath"
    }

    try {
        $actualVersion = (& $nodePath '--version' 2>$null | Out-String).Trim()
    }
    catch {
        Write-Output 'STABLE_NODE_RUNTIME_MISSING'
        throw "Stable Node runtime could not be executed: $nodePath"
    }

    if ($actualVersion -ne $expectedNodeVersion) {
        Write-Output 'STABLE_NODE_RUNTIME_MISSING'
        throw "Stable Node runtime version mismatch: expected $expectedNodeVersion"
    }

}

function Rotate-Log {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -lt $maxLogBytes) {
        return
    }

    $oldest = "$Path.$maxLogFiles"
    if (Test-Path -LiteralPath $oldest -PathType Leaf) {
        Remove-Item -LiteralPath $oldest -Force
    }
    for ($index = $maxLogFiles - 1; $index -ge 1; $index--) {
        $source = "$Path.$index"
        $destination = "$Path.$($index + 1)"
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Move-Item -LiteralPath $source -Destination $destination -Force
        }
    }
    Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
}

function Get-ProductionBridgeProcesses {
    $entryPattern = [regex]::Escape($productionEntry)
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.CommandLine -match $entryPattern })
}

function Read-ProcessState {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return $null
    }

    try {
        Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    }
    catch {
        $null
    }
}

function Remove-StaleState {
    $state = Read-ProcessState
    if ($null -eq $state) {
        if (Test-Path -LiteralPath $statePath) {
            Remove-Item -LiteralPath $statePath -Force
        }
        return
    }

    $daemon = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$state.daemonPid)" -ErrorAction SilentlyContinue
    if ($null -eq $daemon -or [string]$daemon.CommandLine -notmatch [regex]::Escape($productionEntry)) {
        Remove-Item -LiteralPath $statePath -Force
    }
}

function Get-ProtectedCredentials {
    if (-not (Test-Path -LiteralPath $credentialsPath -PathType Leaf)) {
        throw 'QQ Bot credentials are not configured. Re-run Setup or Repair.'
    }
    $config = Get-Content -LiteralPath $credentialsPath -Raw | ConvertFrom-Json
    $entropy = [Text.Encoding]::UTF8.GetBytes('qq-codex-completion-notifier/v1')
    try {
        $secretBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            [Convert]::FromBase64String([string]$config.appSecretDpapi),
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $secret = [Text.Encoding]::UTF8.GetString($secretBytes)
    }
    catch {
        throw 'QQ Bot credentials cannot be decrypted for the current Windows user. Re-run Repair.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$config.appId) -or [string]::IsNullOrWhiteSpace($secret)) {
        throw 'QQ Bot credentials are incomplete. Re-run Repair.'
    }
    [pscustomobject]@{ appId = [string]$config.appId; appSecret = $secret }
}

function Test-CdpReady {
    try {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 9229 -ErrorAction Stop)
        if ($listeners.Count -eq 0 -or
            @($listeners | Where-Object { [string]$_.LocalAddress -ne '127.0.0.1' }).Count -gt 0 -or
            @($listeners | Where-Object { [string]$_.LocalAddress -eq '127.0.0.1' }).Count -eq 0) {
            return $false
        }
        $version = Invoke-RestMethod -Uri 'http://127.0.0.1:9229/json/version' -Method Get -TimeoutSec 5
        $webSocketUri = [Uri]$version.webSocketDebuggerUrl
        $webSocketUri.Scheme -in @('ws', 'wss') -and
            $webSocketUri.Host -eq '127.0.0.1' -and
            $webSocketUri.Port -eq 9229
    }
    catch {
        $false
    }
}

function Write-DaemonExitLog {
    param(
        [Parameter(Mandatory = $true)][int]$ExitCode,
        [string[]]$SecretValues = @()
    )

    $stderrTail = @()
    if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
        $stderrTail = @(Get-Content -LiteralPath $stderrPath -Tail 80 -ErrorAction SilentlyContinue)
    }
    foreach ($secret in $SecretValues) {
        if (-not [string]::IsNullOrWhiteSpace($secret)) {
            $stderrTail = @($stderrTail | ForEach-Object { ([string]$_).Replace($secret, '[REDACTED]') })
        }
    }

    $errorClass = 'NONE'
    $fatalLine = @($stderrTail | Where-Object { $_ -match '\[qq-codex-bridge\] fatal:\s*(.+)$' } | Select-Object -First 1)
    if ($fatalLine.Count -eq 1 -and $fatalLine[0] -match '\[qq-codex-bridge\] fatal:\s*(.+)$') {
        $errorClass = [string]$Matches[1]
    }
    elseif ($ExitCode -ne 0) {
        $errorClass = 'UNCLASSIFIED_DAEMON_EXIT'
    }

    $sourceLocations = @($stderrTail |
        Where-Object { $_ -match '\s+at\s+.*\.(?:js|ts):\d+:\d+' } |
        Select-Object -First 8 |
        ForEach-Object { ([string]$_).Trim() })
    $record = [ordered]@{
        timestamp = [DateTimeOffset]::UtcNow.ToString('o')
        event = 'daemon-exit'
        exitCode = $ExitCode
        errorClass = $errorClass
        sourceLocations = $sourceLocations
    }
    Add-Content -LiteralPath $launcherLogPath -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}

function Start-DetachedWorker {
    Initialize-RuntimeDirectories

    foreach ($path in @($stdoutPath, $stderrPath, $launcherLogPath)) {
        Rotate-Log -Path $path
    }

    $credentials = Get-ProtectedCredentials
    $appId = $credentials.appId
    $appSecret = $credentials.appSecret
    if (-not (Test-Path -LiteralPath $productionEntry -PathType Leaf)) {
        throw "Production bridge entry is missing: $productionEntry"
    }
    Set-Location -LiteralPath $installRoot
    $env:QQBOT_APPID = $appId
    $env:QQBOT_APPSECRET = $appSecret
    $env:QQ_CODEX_DATABASE_PATH = Join-Path $databaseRoot 'qq-codex-bridge.sqlite'
    $env:QQ_CODEX_LISTEN_HOST = '127.0.0.1'
    $env:CODEX_REMOTE_DEBUGGING_PORT = '9229'
    $env:CODEX_REMOTE_DEBUGGING_ADDRESS = '127.0.0.1'
    $env:CODEX_DESKTOP_MODE = 'attach-only'

    $daemon = Start-Process -FilePath $nodePath `
        -ArgumentList @($productionEntry) `
        -WorkingDirectory $installRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru

    $daemonCim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($daemon.Id)"
    $launcherCim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID"
    $identity = [ordered]@{
        schemaVersion = 1
        launcherPid = $PID
        launcherParentPid = [int]$launcherCim.ParentProcessId
        launcherType = 'detached-hidden-powershell'
        daemonPid = $daemon.Id
        daemonParentPid = [int]$daemonCim.ParentProcessId
        daemonExecutable = $nodePath
        daemonEntry = $productionEntry
        workingDirectory = $installRoot
        startTime = $daemon.StartTime.ToUniversalTime().ToString('o')
        stdoutLog = $stdoutPath
        stderrLog = $stderrPath
    }
    $identity | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    $identity | ConvertTo-Json | Set-Content -LiteralPath $workerReadyPath -Encoding UTF8

    $daemon.WaitForExit()
    Write-DaemonExitLog -ExitCode $daemon.ExitCode -SecretValues @($appId, $appSecret)
    exit $daemon.ExitCode
}

Initialize-RuntimeDirectories
Assert-StableNodeRuntime

if ($DetachedWorker) {
    Start-DetachedWorker
    exit 0
}

$startMutex = New-Object System.Threading.Mutex($false, 'Local\CodexQqProductionBridgeStart')
$hasStartMutex = $false
try {
    $hasStartMutex = $startMutex.WaitOne([TimeSpan]::FromSeconds(30))
    if (-not $hasStartMutex) {
        throw 'Timed out waiting for the production bridge start lock.'
    }

    Remove-StaleState
    $existing = @(Get-ProductionBridgeProcesses)
    if ($existing.Count -gt 1) {
        throw "Multiple production bridge instances already exist: $($existing.ProcessId -join ', ')"
    }
    if ($existing.Count -eq 1) {
        $healthOutput = @(& $healthScript 2>&1)
        $healthExitCode = $LASTEXITCODE
        $healthOutput | ForEach-Object { Write-Output $_ }
        if ($healthExitCode -eq 0) {
            Write-Output 'BRIDGE_START=ALREADY_HEALTHY'
            exit 0
        }
        throw "A bridge instance is already running but is not healthy (PID=$($existing[0].ProcessId)). Stop or diagnose it before starting another."
    }

    if (-not (Test-Path -LiteralPath $productionEntry -PathType Leaf)) {
        throw "Production bridge entry is missing. Build the production entry first: $productionEntry"
    }
    if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
        throw "Windows PowerShell is missing: $powershellPath"
    }
    if (-not (Test-CdpReady)) {
        throw 'Codex CDP is not ready on loopback 127.0.0.1:9229. Desktop was not restarted and the bridge was not started.'
    }

    $credentials = Get-ProtectedCredentials
    $appId = $credentials.appId
    $appSecret = $credentials.appSecret

    Remove-Item -LiteralPath $workerReadyPath -Force -ErrorAction SilentlyContinue
    $worker = Start-Process -FilePath $powershellPath `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-DetachedWorker') `
        -WindowStyle Hidden `
        -PassThru

    $deadline = [DateTimeOffset]::Now.AddSeconds(20)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (Test-Path -LiteralPath $workerReadyPath -PathType Leaf) {
            $identity = Get-Content -LiteralPath $workerReadyPath -Raw | ConvertFrom-Json
            Remove-Item -LiteralPath $workerReadyPath -Force
            Write-Output "LAUNCHER_PID=$($identity.launcherPid)"
            Write-Output "DAEMON_PID=$($identity.daemonPid)"
            Write-Output "DAEMON_PARENT_PID=$($identity.daemonParentPid)"
            Write-Output "DAEMON_START_TIME=$($identity.startTime)"
            Write-Output "LOG_PATH=$($identity.stdoutLog)"
            Write-Output 'BRIDGE_START=RETURNED'
            exit 0
        }

        if ($null -eq (Get-Process -Id $worker.Id -ErrorAction SilentlyContinue)) {
            throw 'Detached bridge worker exited before publishing process identity. Check runtime logs.'
        }
        Start-Sleep -Milliseconds 250
    }

    throw 'Timed out waiting for the detached bridge worker to publish process identity.'
}
finally {
    if ($hasStartMutex) {
        $startMutex.ReleaseMutex()
    }
    $startMutex.Dispose()
}
