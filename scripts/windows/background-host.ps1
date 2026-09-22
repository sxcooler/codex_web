[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NodePath, [switch]$Worker, [switch]$Portable, [switch]$DiagnosticsEnabled)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $Worker) {
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -NodePath `"$NodePath`" -Worker"
    if ($Portable) { $arguments += ' -Portable' }
    if ($DiagnosticsEnabled) { $arguments += ' -DiagnosticsEnabled' }
    Start-Process -FilePath $shell -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden
    exit 0
}
# Keep redirection in the hidden host; the launching console can exit independently.
$log = Join-Path $projectRoot '.local/web/server.log'
$workerArgs = @((Join-Path $projectRoot 'scripts/server-control.ts'), '--worker')
if ($Portable) { $workerArgs += '--portable' }
if ($DiagnosticsEnabled) { $workerArgs += '--diagnostics' }
Set-Location -LiteralPath $projectRoot
$ErrorActionPreference = 'Continue'
& $NodePath @workerArgs 2>&1 | ForEach-Object {
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -ge 1048576) { Move-Item -LiteralPath $log -Destination "$log.1" -Force }
    "$(Get-Date -Format o) $_" | Add-Content -LiteralPath $log -Encoding UTF8
}
exit $LASTEXITCODE
