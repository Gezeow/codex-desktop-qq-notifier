[CmdletBinding()]
param(
    [string]$PendingFile,
    [switch]$InitializeOnly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$dataRoot = Join-Path $env:LOCALAPPDATA 'QqCodexCompletionNotifier'
$configRoot = Join-Path $dataRoot 'config'
$credentialsPath = Join-Path $configRoot 'credentials.json'
$expectedPendingPath = [IO.Path]::GetFullPath((Join-Path $configRoot 'credentials.pending.json'))

New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$security = New-Object Security.AccessControl.DirectorySecurity
$security.SetOwner($userSid)
$security.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
foreach ($sid in @($userSid, $systemSid)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        $propagation,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($configRoot, $security)

if ($InitializeOnly) {
    Write-Output 'CONFIGURATION_DIRECTORY=READY'
    exit 0
}
if ([string]::IsNullOrWhiteSpace($PendingFile)) {
    throw 'Pending credential path is required.'
}
$pendingPath = [IO.Path]::GetFullPath($PendingFile)
if ($pendingPath -ine $expectedPendingPath) {
    throw 'Pending credential path is outside the private configuration directory.'
}

if (-not (Test-Path -LiteralPath $pendingPath -PathType Leaf)) {
    throw 'Credential input is missing.'
}

try {
    $pending = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
    $appId = [string]$pending.appId
    $appSecret = [string]$pending.appSecret
    if ([string]::IsNullOrWhiteSpace($appId) -or [string]::IsNullOrWhiteSpace($appSecret)) {
        throw 'QQ Bot AppID and AppSecret are required.'
    }
    if ($appId.Length -gt 256 -or $appSecret.Length -gt 2048) {
        throw 'QQ Bot credential input exceeds the supported length.'
    }

    $entropy = [Text.Encoding]::UTF8.GetBytes('qq-codex-completion-notifier/v1')
    $secretBytes = [Text.Encoding]::UTF8.GetBytes($appSecret)
    try {
        $protected = [System.Security.Cryptography.ProtectedData]::Protect(
            $secretBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $payload = [ordered]@{
            schemaVersion = 1
            appId = $appId
            appSecretDpapi = [Convert]::ToBase64String($protected)
        }
        $temporaryPath = Join-Path $configRoot 'credentials.json.new'
        $payload | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
        Move-Item -LiteralPath $temporaryPath -Destination $credentialsPath -Force
    }
    finally {
        if ($null -ne $secretBytes) {
            [Array]::Clear($secretBytes, 0, $secretBytes.Length)
        }
    }
}
finally {
    Remove-Item -LiteralPath $pendingPath -Force -ErrorAction SilentlyContinue
}

Write-Output 'CONFIGURATION=READY'
