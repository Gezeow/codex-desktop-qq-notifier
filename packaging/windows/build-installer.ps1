[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$IsccPath,
    [string]$StageRoot,
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($StageRoot)) {
    $StageRoot = Join-Path $PSScriptRoot 'stage'
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $PSScriptRoot 'output'
}
$stagePath = [IO.Path]::GetFullPath($StageRoot)
$outputPath = [IO.Path]::GetFullPath($OutputRoot)
$iscc = [IO.Path]::GetFullPath($IsccPath)
if (-not (Test-Path -LiteralPath $iscc -PathType Leaf)) {
    throw "Inno Setup compiler is missing: $iscc"
}
if (-not (Test-Path -LiteralPath (Join-Path $stagePath 'SBOM.cdx.json') -PathType Leaf)) {
    throw 'Windows staging has not passed metadata generation.'
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

& $iscc "/DMyAppVersion=$Version" "/DSourceRoot=$stagePath" "/DOutputRoot=$outputPath" (Join-Path $PSScriptRoot 'installer.iss')
if ($LASTEXITCODE -ne 0) {
    throw 'Inno Setup compilation failed.'
}

$installerName = "qq-codex-completion-notifier-$Version-windows-x64-setup.exe"
$installerPath = Join-Path $outputPath $installerName
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Expected installer was not created: $installerPath"
}
$hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$installerPath.sha256" -Value "$hash  $installerName" -Encoding ASCII
$manifest = [ordered]@{
    schemaVersion = 1
    version = $Version
    artifact = $installerName
    size = (Get-Item -LiteralPath $installerPath).Length
    sha256 = $hash
    node = [ordered]@{
        version = 'v22.22.0'
        archiveSha256 = 'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a'
    }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputPath 'release-manifest.json') -Encoding UTF8

& (Join-Path $PSScriptRoot 'verify-release.ps1') -InstallerPath $installerPath -StageRoot $stagePath
if ($LASTEXITCODE -ne 0) { throw 'Release verification failed.' }

Write-Output "INSTALLER_PATH=$installerPath"
Write-Output "INSTALLER_SHA256=$hash"
Write-Output 'WINDOWS_INSTALLER=READY'
