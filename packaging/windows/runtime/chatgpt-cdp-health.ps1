[CmdletBinding()]
param(
    [switch]$ReadinessLibraryOnly
)

$ErrorActionPreference = 'Stop'

$desktopExe = $null
$cdpPort = 9229
$cdpVersionUri = 'http://127.0.0.1:9229/json/version'

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

function Get-DesktopMainProcesses {
    if ([string]::IsNullOrWhiteSpace($desktopExe)) {
        return @()
    }
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue
    @($processes | Where-Object {
        [string]$_.ExecutablePath -ieq $desktopExe -and
        [string]$_.CommandLine -notmatch '(^|\s)--type='
    })
}

function Get-CdpListeners {
    @(Get-NetTCPConnection -State Listen -LocalPort $cdpPort -ErrorAction SilentlyContinue)
}

function Test-CdpEndpointReady {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Listeners
    )

    if ($Listeners.Count -ne 1 -or [string]$Listeners[0].LocalAddress -ne '127.0.0.1') {
        return $false
    }

    try {
        $version = Invoke-RestMethod -Uri $cdpVersionUri -Method Get -TimeoutSec 5
        $webSocketUri = [Uri]$version.webSocketDebuggerUrl
        return $webSocketUri.Scheme -in @('ws', 'wss') -and
            $webSocketUri.Host -eq '127.0.0.1' -and
            $webSocketUri.Port -eq $cdpPort
    }
    catch {
        return $false
    }
}

function Get-CdpBindingStatus {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Listeners
    )

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

if ($ReadinessLibraryOnly) {
    $desktopExe = Resolve-DesktopExecutable
    return
}

$desktopExe = Resolve-DesktopExecutable
$mainProcesses = @(Get-DesktopMainProcesses)
$listeners = @(Get-CdpListeners)
$mainCount = $mainProcesses.Count
$bindingStatus = Get-CdpBindingStatus -Listeners $listeners
$cdpReady = $mainCount -eq 1 -and (Test-CdpEndpointReady -Listeners $listeners)

Write-Output "CHATGPT_EXECUTABLE=$(if ([string]::IsNullOrWhiteSpace($desktopExe)) { 'FAIL' } else { 'READY' })"
Write-Output "CHATGPT_DESKTOP=$(if ($mainCount -eq 1) { 'RUNNING' } else { 'FAIL' })"
Write-Output "CHATGPT_MAIN_COUNT=$mainCount"
Write-Output "CDP_LISTENER_COUNT=$($listeners.Count)"
Write-Output "CDP_BINDING=$bindingStatus"
Write-Output "CODEX_CDP=$(if ($cdpReady) { 'READY' } else { 'FAIL' })"
Write-Output "CHATGPT_CDP=$(if ($cdpReady) { 'READY' } else { 'FAIL' })"

if ($cdpReady) {
    Write-Output 'CHATGPT_CDP_READY'
    exit 0
}

exit 1

