[CmdletBinding()]
param(
    [ValidateRange(5, 600)]
    [int]$DesktopReadyTimeoutSeconds = 120,
    [ValidateRange(5, 600)]
    [int]$BridgeReadyTimeoutSeconds = 120,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

$installRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA 'QqCodexCompletionNotifier'
$logRoot = Join-Path $dataRoot 'logs'
$stateRoot = Join-Path $dataRoot 'state'
$launcherLogPath = Join-Path $logRoot 'on-demand.launcher.log'
$watchdogStatePath = Join-Path $stateRoot 'desktop-bridge-watchdog.json'
$watchdogScript = Join-Path $runtimeRoot 'watch-chatgpt-and-stop-bridge.ps1'
$watchdogReadyTimeoutSeconds = 15
$nodePath = Join-Path $installRoot 'node\node.exe'
$expectedNodeVersion = 'v22.22.0'
$powershellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$chatgptLauncher = Join-Path $runtimeRoot 'start-chatgpt-cdp.ps1'
$chatgptHealth = Join-Path $runtimeRoot 'chatgpt-cdp-health.ps1'
$bridgeLauncher = Join-Path $runtimeRoot 'start-bridge.ps1'
$bridgeStopper = Join-Path $runtimeRoot 'stop-bridge.ps1'
$bridgeHealth = Join-Path $runtimeRoot 'bridge-health.ps1'

function Write-LauncherLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    Add-Content -LiteralPath $launcherLogPath -Value "$([DateTimeOffset]::Now.ToString('o')) $Message" -Encoding UTF8
}

function Assert-Dependencies {
    foreach ($path in @($nodePath, $powershellPath, $chatgptLauncher, $chatgptHealth, $bridgeLauncher, $bridgeStopper, $bridgeHealth, $watchdogScript)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "On-demand launcher dependency is missing: $path"
        }
    }
    $actualVersion = (& $nodePath '--version' 2>$null | Out-String).Trim()
    if ($actualVersion -ne $expectedNodeVersion) {
        throw "Stable Node runtime version mismatch: expected $expectedNodeVersion"
    }
}

function Get-AuditedDesktopMainProcesses {
    $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)
    if ($packages.Count -ne 1) {
        throw "Expected one audited OpenAI.Codex package, found $($packages.Count)."
    }
    $desktopExe = [IO.Path]::GetFullPath((Join-Path ([string]$packages[0].InstallLocation) 'app\ChatGPT.exe'))
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            [string]$_.ExecutablePath -ieq $desktopExe -and
            [string]$_.CommandLine -notmatch '(^|\s)--type='
        })
}

function Prepare-DesktopForCdpLaunch {
    $health = Invoke-RuntimeScript -Path $chatgptHealth
    if ($health.ExitCode -eq 0) {
        return
    }

    $mainProcesses = @(Get-AuditedDesktopMainProcesses)
    if ($mainProcesses.Count -eq 0) {
        return
    }
    if ($mainProcesses.Count -ne 1) {
        throw "Refusing to replace multiple ChatGPT Desktop main processes: $($mainProcesses.Count)."
    }

    Write-LauncherLog -Message "audited Desktop exists without ready loopback CDP; replacing pid=$($mainProcesses[0].ProcessId)"
    $desktopProcess = Get-Process -Id ([int]$mainProcesses[0].ProcessId) -ErrorAction Stop
    $null = $desktopProcess.CloseMainWindow()
    $graceDeadline = [DateTimeOffset]::Now.AddSeconds(10)
    while ([DateTimeOffset]::Now -lt $graceDeadline -and
        $null -ne (Get-Process -Id $desktopProcess.Id -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 500
    }

    if ($null -ne (Get-Process -Id $desktopProcess.Id -ErrorAction SilentlyContinue)) {
        Write-LauncherLog -Message "audited Desktop did not exit after close request; terminating pid=$($desktopProcess.Id)"
        Stop-Process -Id $desktopProcess.Id -ErrorAction Stop
    }

    $deadline = [DateTimeOffset]::Now.AddSeconds(30)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (@(Get-AuditedDesktopMainProcesses).Count -eq 0 -and
            @(Get-NetTCPConnection -State Listen -LocalPort 9229 -ErrorAction SilentlyContinue).Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Audited ChatGPT Desktop or CDP listener remained after the user-initiated replacement.'
}

function Invoke-RuntimeScript {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Arguments = @()
    )

    $output = @(& $powershellPath -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $Path @Arguments 2>&1 |
        ForEach-Object { [string]$_ })
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = $output
    }
}

function Test-Status {
    param(
        [Parameter(Mandatory = $true)][object]$Result,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$ExpectedValue
    )

    @($Result.Output | Where-Object { [string]$_ -eq "$Name=$ExpectedValue" }).Count -eq 1
}

function Get-ExistingWatchdog {
    if (-not (Test-Path -LiteralPath $watchdogStatePath -PathType Leaf)) {
        return $null
    }
    try {
        $state = Get-Content -LiteralPath $watchdogStatePath -Raw | ConvertFrom-Json
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$state.pid)" -ErrorAction SilentlyContinue
        if ($null -ne $process -and
            [string]$process.CommandLine -match [regex]::Escape($watchdogScript)) {
            return $process
        }
    }
    catch {}
    Remove-Item -LiteralPath $watchdogStatePath -Force -ErrorAction SilentlyContinue
    $null
}

function Start-OrReuseWatchdog {
    param([Parameter(Mandatory = $true)][int]$DesktopMainPid)

    $existing = Get-ExistingWatchdog
    if ($null -ne $existing) {
        $existingState = Get-Content -LiteralPath $watchdogStatePath -Raw | ConvertFrom-Json
        if ([int]$existingState.desktopMainPid -eq $DesktopMainPid) {
            Write-Output 'DESKTOP_BRIDGE_WATCHDOG=REUSED'
            return
        }

        Write-LauncherLog -Message "replacing watchdog bound to old Desktop pid=$($existingState.desktopMainPid)"
        Stop-Process -Id ([int]$existing.ProcessId) -ErrorAction Stop
        $deadline = [DateTimeOffset]::Now.AddSeconds(10)
        while ([DateTimeOffset]::Now -lt $deadline -and
            $null -ne (Get-Process -Id ([int]$existing.ProcessId) -ErrorAction SilentlyContinue)) {
            Start-Sleep -Milliseconds 250
        }
        if ($null -ne (Get-Process -Id ([int]$existing.ProcessId) -ErrorAction SilentlyContinue)) {
            throw 'Old verified Desktop bridge watchdog did not exit.'
        }
        Remove-Item -LiteralPath $watchdogStatePath -Force -ErrorAction SilentlyContinue
    }

    $spawned = Start-Process -FilePath $powershellPath `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $watchdogScript, '-DesktopMainPid', [string]$DesktopMainPid) `
        -WindowStyle Hidden `
        -PassThru

    $deadline = [DateTimeOffset]::Now.AddSeconds($watchdogReadyTimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
        $existing = Get-ExistingWatchdog
        if ($null -ne $existing) {
            Write-Output 'DESKTOP_BRIDGE_WATCHDOG=STARTED'
            return
        }
        if ($null -eq (Get-Process -Id $spawned.Id -ErrorAction SilentlyContinue)) {
            throw 'Desktop bridge watchdog exited before publishing its state.'
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'Timed out waiting for Desktop bridge watchdog readiness.'
}

New-Item -ItemType Directory -Path $logRoot,$stateRoot -Force | Out-Null
Assert-Dependencies
if ($ValidateOnly) {
    Write-Output 'ON_DEMAND_LAUNCHER_VALID=YES'
    exit 0
}

$launcherMutex = New-Object System.Threading.Mutex($false, 'Local\CodexQqOnDemandLauncher')
$hasLauncherMutex = $false
try {
    $hasLauncherMutex = $launcherMutex.WaitOne([TimeSpan]::FromSeconds(300))
    if (-not $hasLauncherMutex) {
        throw 'Timed out waiting for another on-demand launcher invocation to finish.'
    }

    Write-LauncherLog -Message 'on-demand launcher started'
    Set-Location -LiteralPath $installRoot
    Prepare-DesktopForCdpLaunch

    $desktopResult = Invoke-RuntimeScript -Path $chatgptLauncher -Arguments @(
        '-WaitTimeoutSeconds', [string]$DesktopReadyTimeoutSeconds
    )
    $desktopResult.Output | ForEach-Object { Write-Output $_ }
    if ($desktopResult.ExitCode -ne 0 -or
        -not (Test-Status -Result $desktopResult -Name 'CHATGPT_DESKTOP' -ExpectedValue 'RUNNING') -or
        -not (Test-Status -Result $desktopResult -Name 'CODEX_CDP' -ExpectedValue 'READY')) {
        Write-LauncherLog -Message "FAIL Desktop/CDP readiness exit_code=$($desktopResult.ExitCode)"
        throw 'ON_DEMAND_CHATGPT_CDP_NOT_READY'
    }
    $desktopMainProcesses = @(Get-AuditedDesktopMainProcesses)
    if ($desktopMainProcesses.Count -ne 1) {
        throw "ON_DEMAND_CHATGPT_MAIN_PROCESS_AMBIGUOUS count=$($desktopMainProcesses.Count)"
    }
    $desktopMainPid = [int]$desktopMainProcesses[0].ProcessId

    $preBridgeHealth = Invoke-RuntimeScript -Path $bridgeHealth
    $bridgeAlreadyRunning = (Test-Status -Result $preBridgeHealth -Name 'BRIDGE_PROCESS' -ExpectedValue 'RUNNING') -and
        (Test-Status -Result $preBridgeHealth -Name 'INSTANCE_COUNT' -ExpectedValue '1')
    if ($bridgeAlreadyRunning -and $preBridgeHealth.ExitCode -ne 0) {
        Write-LauncherLog -Message 'existing single bridge is recovering after Desktop/CDP replacement'
        $recoveryDeadline = [DateTimeOffset]::Now.AddSeconds(30)
        while ([DateTimeOffset]::Now -lt $recoveryDeadline -and $preBridgeHealth.ExitCode -ne 0) {
            Start-Sleep -Seconds 2
            $preBridgeHealth = Invoke-RuntimeScript -Path $bridgeHealth
        }
        if ($preBridgeHealth.ExitCode -ne 0) {
            Write-LauncherLog -Message 'existing bridge did not recover; performing verified stop before replacement'
            $stopResult = Invoke-RuntimeScript -Path $bridgeStopper
            $stopResult.Output | ForEach-Object { Write-Output $_ }
            if ($stopResult.ExitCode -ne 0) {
                throw 'ON_DEMAND_EXISTING_BRIDGE_STOP_FAILED'
            }
            $bridgeAlreadyRunning = $false
        }
    }

    if (-not $bridgeAlreadyRunning) {
        $bridgeResult = Invoke-RuntimeScript -Path $bridgeLauncher
        $bridgeResult.Output | ForEach-Object { Write-Output $_ }
        if ($bridgeResult.ExitCode -ne 0) {
            Write-LauncherLog -Message "FAIL bridge launcher exit_code=$($bridgeResult.ExitCode)"
            throw 'ON_DEMAND_BRIDGE_START_FAILED'
        }
    }
    else {
        Write-Output 'BRIDGE_START=ALREADY_HEALTHY'
    }

    $healthResult = $null
    $bridgeReady = $false
    $targetReady = $false
    $deadline = [DateTimeOffset]::Now.AddSeconds($BridgeReadyTimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
        $healthResult = Invoke-RuntimeScript -Path $bridgeHealth
        if ((Test-Status -Result $healthResult -Name 'BRIDGE_PROCESS' -ExpectedValue 'RUNNING') -and
            (Test-Status -Result $healthResult -Name 'BRIDGE_LISTENER' -ExpectedValue 'READY') -and
            (Test-Status -Result $healthResult -Name 'QQ_GATEWAY' -ExpectedValue 'CONNECTED') -and
            (Test-Status -Result $healthResult -Name 'CODEX_CDP' -ExpectedValue 'READY') -and
            (Test-Status -Result $healthResult -Name 'COMPLETION_MONITOR' -ExpectedValue 'HEALTHY') -and
            (Test-Status -Result $healthResult -Name 'INSTANCE_COUNT' -ExpectedValue '1') -and
            (Test-Status -Result $healthResult -Name 'CODEX_CLI_SPAWN_COUNT' -ExpectedValue '0')) {
            $bridgeReady = $true
            $targetReady = Test-Status -Result $healthResult -Name 'TARGET_CONFIGURED' -ExpectedValue 'YES'
            break
        }
        Start-Sleep -Seconds 2
    }

    if (-not $bridgeReady) {
        if ($null -ne $healthResult) {
            $healthResult.Output | ForEach-Object { Write-Output $_ }
        }
        Write-LauncherLog -Message 'FAIL bridge readiness timeout'
        throw 'ON_DEMAND_BRIDGE_NOT_READY'
    }

    $healthResult.Output | ForEach-Object { Write-Output $_ }
    Start-OrReuseWatchdog -DesktopMainPid $desktopMainPid
    Write-LauncherLog -Message 'ON_DEMAND_READY; Desktop and bridge detached from launcher'
    if ($targetReady) {
        Write-Output 'ON_DEMAND_CHATGPT_QQ_NOTIFICATION=READY'
    }
    else {
        Write-LauncherLog -Message 'TARGET_PENDING; send one QQ private message to bind completion notifications'
        Write-Output 'ON_DEMAND_CHATGPT_QQ_NOTIFICATION=READY_TARGET_PENDING'
    }
    exit 0
}
finally {
    if ($hasLauncherMutex) {
        $launcherMutex.ReleaseMutex()
    }
    $launcherMutex.Dispose()
}
