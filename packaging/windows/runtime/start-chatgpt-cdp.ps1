[CmdletBinding()]
param(
    [ValidateRange(5, 600)]
    [int]$WaitTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

$installRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA 'QqCodexCompletionNotifier'
$logRoot = Join-Path $dataRoot 'logs'
$launcherLogPath = Join-Path $logRoot 'chatgpt-cdp.launcher.log'
$maxLogBytes = 5MB
$maxLogFiles = 3
$healthScript = Join-Path $runtimeRoot 'chatgpt-cdp-health.ps1'
$cdpPort = 9229

if (-not (Test-Path -LiteralPath $healthScript -PathType Leaf)) {
    throw "ChatGPT CDP health script is missing: $healthScript"
}

. $healthScript -ReadinessLibraryOnly

function Initialize-RuntimeDirectories {
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
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

function Write-LauncherLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    Rotate-Log -Path $launcherLogPath
    Add-Content -LiteralPath $launcherLogPath -Value "$([DateTimeOffset]::Now.ToString('o')) $Message" -Encoding UTF8
}

function Get-CdpBindingStatusSafe {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Listeners)

    if ($Listeners.Count -eq 0) {
        return 'MISSING'
    }
    if (@($Listeners | Where-Object { [string]$_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) {
        return 'NON_LOOPBACK'
    }
    if ($Listeners.Count -ne 1) {
        return 'MULTIPLE'
    }
    return '127.0.0.1:9229'
}

function Write-Status {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$MainProcesses,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Listeners,
        [Parameter(Mandatory = $true)][bool]$Ready,
        [Parameter(Mandatory = $true)][string]$LaunchMode
    )

    Write-Output "CHATGPT_DESKTOP=$(if ($MainProcesses.Count -eq 1) { 'RUNNING' } else { 'FAIL' })"
    Write-Output "CHATGPT_MAIN_COUNT=$($MainProcesses.Count)"
    Write-Output "CDP_LISTENER_COUNT=$($Listeners.Count)"
    Write-Output "CDP_BINDING=$(Get-CdpBindingStatusSafe -Listeners $Listeners)"
    Write-Output "CODEX_CDP=$(if ($Ready) { 'READY' } else { 'FAIL' })"
    Write-Output "CHATGPT_CDP=$(if ($Ready) { 'READY' } else { 'FAIL' })"
    Write-Output "CHATGPT_CDP_LAUNCH=$LaunchMode"
}

function Throw-MultipleMainInstances {
    param([Parameter(Mandatory = $true)][int]$Count)

    Write-Output 'CHATGPT_MULTIPLE_MAIN_INSTANCES'
    throw "MULTIPLE_CHATGPT_MAIN_INSTANCES count=$Count"
}

function Throw-NonLoopbackCdp {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Listeners)

    Write-Output 'NON_LOOPBACK_CDP_LISTENER'
    throw "NON_LOOPBACK_CDP_LISTENER count=$($Listeners.Count)"
}

Initialize-RuntimeDirectories
Write-LauncherLog -Message 'launcher started'

$launchMode = 'REUSED'
$mainProcesses = @(Get-DesktopMainProcesses)
if ($mainProcesses.Count -gt 1) {
    Throw-MultipleMainInstances -Count $mainProcesses.Count
}

$listeners = @(Get-CdpListeners)
if (@($listeners | Where-Object { [string]$_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) {
    Throw-NonLoopbackCdp -Listeners $listeners
}

if ($mainProcesses.Count -eq 0) {
    if ($listeners.Count -gt 0) {
        throw 'CDP listener exists without exactly one audited ChatGPT Desktop main process; refusing to launch.'
    }
    if ([string]::IsNullOrWhiteSpace($desktopExe) -or
        -not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
        throw 'AUDITED_CHATGPT_DESKTOP_EXECUTABLE_MISSING'
    }

    Write-LauncherLog -Message 'launching audited ChatGPT Desktop with loopback CDP'
    $null = Start-Process -FilePath $desktopExe -ArgumentList @(
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=9229'
    ) -WorkingDirectory (Split-Path -Parent $desktopExe) -PassThru
    $launchMode = 'STARTED'
}

$deadline = [DateTimeOffset]::Now.AddSeconds($WaitTimeoutSeconds)
while ([DateTimeOffset]::Now -lt $deadline) {
    $mainProcesses = @(Get-DesktopMainProcesses)
    if ($mainProcesses.Count -gt 1) {
        Throw-MultipleMainInstances -Count $mainProcesses.Count
    }

    $listeners = @(Get-CdpListeners)
    if (@($listeners | Where-Object { [string]$_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) {
        Throw-NonLoopbackCdp -Listeners $listeners
    }

    $ready = $mainProcesses.Count -eq 1 -and (Test-CdpEndpointReady -Listeners $listeners)
    if ($ready) {
        Write-Status -MainProcesses $mainProcesses -Listeners $listeners -Ready $true -LaunchMode $launchMode
        Write-LauncherLog -Message "ready launch_mode=$launchMode"
        Write-Output 'CHATGPT_CDP_READY'
        exit 0
    }

    Start-Sleep -Milliseconds 500
}

Write-Status -MainProcesses $mainProcesses -Listeners $listeners -Ready $false -LaunchMode $launchMode
Write-LauncherLog -Message 'FAIL CDP readiness timeout'
throw "Timed out waiting for ChatGPT Desktop CDP on 127.0.0.1:$cdpPort"

