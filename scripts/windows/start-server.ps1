$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$dataDir = Join-Path $projectRoot '.local\web'
$nodePath = Join-Path $projectRoot '.local\node24\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath (Join-Path $dataDir 'auth.json'))) { throw 'Run npm run auth:setup first.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) { throw 'Run npm run build first.' }
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))
$mutex = [Threading.Mutex]::new($false, "Local\CodexRemoteWeb-$hash")
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit 0 }
    Set-Location -LiteralPath $projectRoot
    $logPath = Join-Path $dataDir 'server.log'
    & $nodePath (Join-Path $projectRoot 'src\server\main.ts') 2>&1 | ForEach-Object {
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -ge 1048576) {
            Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
        }
        "$(Get-Date -Format o) $_" | Add-Content -LiteralPath $logPath
    }
    exit $LASTEXITCODE
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
