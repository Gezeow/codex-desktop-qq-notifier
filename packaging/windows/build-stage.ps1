[CmdletBinding()]
param(
    [string]$NodeArchivePath,
    [string]$StageRoot
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($StageRoot)) {
    $StageRoot = Join-Path $PSScriptRoot 'stage'
}
$nodeVersion = 'v22.22.0'
$nodeArchiveName = 'node-v22.22.0-win-x64.zip'
$nodeArchiveSha256 = 'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a'
$nodeSignerThumbprint = '8FDE473B4E037DBCD4BFC8C8042B0246E46E560A'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$packagingRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$stagePath = [IO.Path]::GetFullPath($StageRoot)

function Assert-ChildPath {
    param([Parameter(Mandatory = $true)][string]$Parent, [Parameter(Mandatory = $true)][string]$Child)
    $prefix = $Parent.TrimEnd('\') + '\'
    if (-not $Child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing filesystem operation outside $Parent"
    }
}

Assert-ChildPath -Parent $packagingRoot -Child $stagePath
if (Test-Path -LiteralPath $stagePath) {
    Remove-Item -LiteralPath $stagePath -Recurse -Force
}

$currentNode = (& node --version | Out-String).Trim()
if ($currentNode -ne $nodeVersion) {
    throw "Release staging requires Node $nodeVersion; current runtime is $currentNode"
}

Push-Location $repoRoot
try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Frozen dependency install failed.' }
    pnpm run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    New-Item -ItemType Directory -Path $stagePath | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot 'bin') -Destination (Join-Path $stagePath 'bin') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $stagePath 'dist') | Out-Null
    foreach ($directory in @('apps','packages')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot "dist\$directory") -Destination (Join-Path $stagePath "dist\$directory") -Recurse
    }
    foreach ($file in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','README.md','LICENSE','NOTICE.md')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $stagePath $file)
    }
    Push-Location $stagePath
    try {
        pnpm install --prod --frozen-lockfile --config.node-linker=hoisted
        if ($LASTEXITCODE -ne 0) { throw 'Hoisted production dependency install failed.' }
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}

$buildCacheRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.cache\build-stage'))
if (-not (Test-Path -LiteralPath $buildCacheRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $buildCacheRoot | Out-Null
}
if ([string]::IsNullOrWhiteSpace($NodeArchivePath)) {
    $downloadRoot = [IO.Path]::GetFullPath((Join-Path $buildCacheRoot ("download-" + [guid]::NewGuid().ToString('N'))))
    Assert-ChildPath -Parent $buildCacheRoot -Child $downloadRoot
    New-Item -ItemType Directory -Path $downloadRoot | Out-Null
    $NodeArchivePath = Join-Path $downloadRoot $nodeArchiveName
    $checksumsPath = Join-Path $downloadRoot 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$nodeVersion/$nodeArchiveName" -OutFile $NodeArchivePath
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt" -OutFile $checksumsPath
    $expectedLine = "$nodeArchiveSha256  $nodeArchiveName"
    if (-not (Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -ceq $expectedLine })) {
        throw 'Official Node checksum manifest does not contain the pinned Windows x64 artifact.'
    }
}

$archivePath = [IO.Path]::GetFullPath($NodeArchivePath)
$actualArchiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualArchiveHash -cne $nodeArchiveSha256) {
    throw "Node archive SHA-256 mismatch: $actualArchiveHash"
}

$extractRoot = [IO.Path]::GetFullPath((Join-Path $buildCacheRoot ("extract-" + [guid]::NewGuid().ToString('N'))))
Assert-ChildPath -Parent $buildCacheRoot -Child $extractRoot
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
$nodeSource = Join-Path $extractRoot 'node-v22.22.0-win-x64'
$nodeDestination = Join-Path $stagePath 'node'
New-Item -ItemType Directory -Path $nodeDestination | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeSource 'node.exe') -Destination (Join-Path $nodeDestination 'node.exe')
Copy-Item -LiteralPath (Join-Path $nodeSource 'LICENSE') -Destination (Join-Path $nodeDestination 'LICENSE')
Copy-Item -LiteralPath (Join-Path $nodeSource 'README.md') -Destination (Join-Path $nodeDestination 'README.md')

$nodeExe = Join-Path $nodeDestination 'node.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $nodeExe
if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
    $signature.SignerCertificate.Thumbprint -ine $nodeSignerThumbprint -or
    $signature.SignerCertificate.Subject -notmatch 'O=OpenJS Foundation') {
    throw 'Bundled Node executable does not match the pinned valid OpenJS Foundation signature.'
}
if ((& $nodeExe --version | Out-String).Trim() -ne $nodeVersion) {
    throw 'Bundled Node executable version mismatch.'
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime') -Destination (Join-Path $stagePath 'runtime') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses') -Destination (Join-Path $stagePath 'licenses') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'DISCLAIMER.txt') -Destination (Join-Path $stagePath 'DISCLAIMER.txt')
Remove-Item -LiteralPath (Join-Path $stagePath '.env.example') -Force -ErrorAction SilentlyContinue

# pnpm creates install-time command shims with absolute build-machine paths.
# The runtime has no CLI dependency on these shims, so remove only contained
# .bin directories before privacy scanning and packaging.
$binDirectories = @(Get-ChildItem -LiteralPath $stagePath -Recurse -Directory -Filter '.bin') |
    Sort-Object { $_.FullName.Length } -Descending
foreach ($directory in $binDirectories) {
    $resolvedDirectory = [IO.Path]::GetFullPath($directory.FullName)
    Assert-ChildPath -Parent $stagePath -Child $resolvedDirectory
    Remove-Item -LiteralPath $resolvedDirectory -Recurse -Force
}

& $nodeExe (Join-Path $repoRoot 'scripts\generate-release-metadata.mjs') $stagePath
if ($LASTEXITCODE -ne 0) { throw 'Release metadata generation failed.' }

Push-Location $stagePath
try {
    & $nodeExe -e "require('better-sqlite3')(':memory:').close(); console.log('BETTER_SQLITE3_ABI=READY')"
    if ($LASTEXITCODE -ne 0) { throw 'Bundled better-sqlite3 ABI check failed.' }
}
finally {
    Pop-Location
}

$forbiddenNames = Get-ChildItem -LiteralPath $stagePath -Recurse -File | Where-Object {
    $_.Name -match '^(?:\.env|.*\.(?:sqlite|sqlite-shm|sqlite-wal|log))$' -or
    $_.FullName -match '[\\/](?:state|runtime-probes)[\\/]'
}
if ($forbiddenNames) {
    throw "Forbidden runtime state entered staging: $($forbiddenNames.FullName -join ', ')"
}
$sensitiveHits = Get-ChildItem -LiteralPath $stagePath -Recurse -File |
    Where-Object { $_.Length -lt 10MB } |
    Select-String -Pattern '[A-Za-z]:\\AI\\qq-codex-bridge','[A-Za-z]:\\Users\\[^\\]+','QQBOT_APPSECRET=' -ErrorAction SilentlyContinue
if ($sensitiveHits) {
    throw "Personal path or credential assignment entered staging: $($sensitiveHits.Path -join ', ')"
}

Write-Output "STAGE_ROOT=$stagePath"
Write-Output "NODE_ARCHIVE_SHA256=$actualArchiveHash"
Write-Output 'WINDOWS_STAGE=READY'
