[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$DesktopMainPid,
    [ValidateRange(3, 120)]
    [int]$MissingPollThreshold = 12,
    [ValidateRange(2, 60)]
    [int]$PollIntervalSeconds = 5
)

$ErrorActionPreference = 'Stop'

$installRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA 'QqCodexCompletionNotifier'
$statePath = Join-Path $dataRoot 'state\desktop-bridge-watchdog.json'
$healthScript = Join-Path $runtimeRoot 'chatgpt-cdp-health.ps1'
$stopBridgeScript = Join-Path $runtimeRoot 'stop-bridge.ps1'
$productionEntry = Join-Path $installRoot 'dist\apps\bridge-daemon\src\production.js'
$logPath = Join-Path $dataRoot 'logs\desktop-bridge-watchdog.log'
$powershellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$desktopExe = $null

function Write-WatchdogLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    Add-Content -LiteralPath $logPath -Value "$([DateTimeOffset]::Now.ToString('o')) $Message" -Encoding UTF8
}

function Get-ProductionBridgeProcesses {
    $pattern = [regex]::Escape($productionEntry)
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.CommandLine -match $pattern })
}

function Resolve-DesktopExecutable {
    $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)
    if ($packages.Count -ne 1) {
        return $null
    }
    $candidate = Join-Path ([string]$packages[0].InstallLocation) 'app\ChatGPT.exe'
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        return $null
    }
    [IO.Path]::GetFullPath($candidate)
}

function Test-WatchedDesktopMainProcess {
    if ([string]::IsNullOrWhiteSpace($desktopExe)) {
        return $false
    }
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $DesktopMainPid" -ErrorAction SilentlyContinue
    $null -ne $process -and
        [string]$process.Name -ieq 'ChatGPT.exe' -and
        [string]$process.ExecutablePath -ieq $desktopExe -and
        [string]$process.CommandLine -notmatch '(^|\s)--type='
}

function Test-DesktopCdpReady {
    $output = @(& $powershellPath -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $healthScript 2>&1 |
        ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
    $exitCode -eq 0 -and
        $output -contains 'CHATGPT_DESKTOP=RUNNING' -and
        $output -contains 'CODEX_CDP=READY'
}

New-Item -ItemType Directory -Path (Split-Path -Parent $statePath),(Split-Path -Parent $logPath) -Force | Out-Null
$mutex = New-Object System.Threading.Mutex($false, 'Local\CodexQqDesktopBridgeWatchdog')
$hasMutex = $false
try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) {
        exit 0
    }

    [ordered]@{
        schemaVersion = 1
        pid = $PID
        scriptPath = $PSCommandPath
        desktopMainPid = $DesktopMainPid
        startedAt = [DateTimeOffset]::Now.ToString('o')
        missingPollThreshold = $MissingPollThreshold
        pollIntervalSeconds = $PollIntervalSeconds
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-WatchdogLog -Message "watchdog started pid=$PID"

    $desktopExe = Resolve-DesktopExecutable
    if ([string]::IsNullOrWhiteSpace($desktopExe)) {
        throw 'Audited ChatGPT Desktop executable could not be resolved.'
    }

    $missingPolls = 0
    while ($true) {
        if (@(Get-ProductionBridgeProcesses).Count -eq 0) {
            Write-WatchdogLog -Message 'bridge no longer running; watchdog exiting'
            exit 0
        }

        if (-not (Test-WatchedDesktopMainProcess)) {
            Write-WatchdogLog -Message "watched Desktop main process exited pid=$DesktopMainPid; stopping verified bridge"
            $stopOutput = @(& $powershellPath -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $stopBridgeScript 2>&1 |
                ForEach-Object { [string]$_ })
            $stopExitCode = $LASTEXITCODE
            foreach ($line in $stopOutput) {
                Write-WatchdogLog -Message "stop-bridge $line"
            }
            if ($stopExitCode -ne 0) {
                throw "stop-bridge.ps1 failed with exit code $stopExitCode"
            }
            Write-WatchdogLog -Message 'verified bridge stopped after watched Desktop exit; watchdog complete'
            exit 0
        }

        if (Test-DesktopCdpReady) {
            $missingPolls = 0
        }
        else {
            $missingPolls++
            Write-WatchdogLog -Message "Desktop/CDP unavailable poll=$missingPolls threshold=$MissingPollThreshold"
            if ($missingPolls -ge $MissingPollThreshold) {
                Write-WatchdogLog -Message 'Desktop/CDP absence threshold reached; stopping verified bridge without restarting Desktop'
                $stopOutput = @(& $powershellPath -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $stopBridgeScript 2>&1 |
                    ForEach-Object { [string]$_ })
                $stopExitCode = $LASTEXITCODE
                foreach ($line in $stopOutput) {
                    Write-WatchdogLog -Message "stop-bridge $line"
                }
                if ($stopExitCode -ne 0) {
                    throw "stop-bridge.ps1 failed with exit code $stopExitCode"
                }
                Write-WatchdogLog -Message 'verified bridge stopped; watchdog complete'
                exit 0
            }
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    }
}
catch {
    Write-WatchdogLog -Message "FAIL $($_.Exception.GetType().FullName): $($_.Exception.Message)"
    exit 1
}
finally {
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try {
            $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            if ([int]$state.pid -eq $PID) {
                Remove-Item -LiteralPath $statePath -Force
            }
        }
        catch {}
    }
    if ($hasMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}

