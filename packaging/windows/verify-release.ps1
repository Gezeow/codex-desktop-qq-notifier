[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$StageRoot,
    [switch]$RequireSignature
)

$ErrorActionPreference = 'Stop'
$installer = [IO.Path]::GetFullPath($InstallerPath)
$stage = [IO.Path]::GetFullPath($StageRoot)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Installer is missing.' }
if ((Get-Item -LiteralPath $installer).Length -lt 20MB) { throw 'Installer is unexpectedly small.' }

$sidecarPath = "$installer.sha256"
if (-not (Test-Path -LiteralPath $sidecarPath -PathType Leaf)) { throw 'SHA-256 sidecar is missing.' }
$expectedHash = ((Get-Content -LiteralPath $sidecarPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -cne $expectedHash) { throw 'Installer SHA-256 sidecar mismatch.' }

foreach ($required in @('LICENSE','NOTICE.md','THIRD_PARTY_NOTICES.md','SBOM.cdx.json','node\node.exe','runtime\start-chatgpt-with-qq.vbs','runtime\bridge-health.ps1','runtime\stop-bridge.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) {
        throw "Required staged release file is missing: $required"
    }
}

$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($RequireSignature -and $signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
    throw 'Release policy requires a valid Authenticode signature.'
}

$json = Get-Content -LiteralPath (Join-Path $stage 'SBOM.cdx.json') -Raw | ConvertFrom-Json
if ($json.bomFormat -ne 'CycloneDX' -or @($json.components).Count -eq 0) {
    throw 'CycloneDX SBOM is invalid or empty.'
}

Write-Output "ARTIFACT_SHA256=$actualHash"
Write-Output "AUTHENTICODE_STATUS=$($signature.Status)"
Write-Output 'RELEASE_ARTIFACT=VERIFIED'

