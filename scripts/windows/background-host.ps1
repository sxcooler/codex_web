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
$parentPid = $null
$parentName = $null
try {
    $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop).ParentProcessId
    $parentName = (Get-Process -Id $parentPid -ErrorAction Stop).ProcessName
} catch { }
function Write-HostRecord([string]$Event, [string]$Reason, $ExitCode) {
    try {
        if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -ge 1048576) { Move-Item -LiteralPath $log -Destination "$log.1" -Force }
        @{time=(Get-Date -Format o);event=$Event;reason=$Reason;pid=$PID;parentPid=$parentPid;parentName=$parentName;exitCode=$ExitCode} | ConvertTo-Json -Compress | Add-Content -LiteralPath $log -Encoding UTF8 -ErrorAction Stop
    } catch { }
}
$workerArgs = @((Join-Path $projectRoot 'scripts/server-control.ts'), '--worker')
if ($Portable) { $workerArgs += '--portable' }
if ($DiagnosticsEnabled) { $workerArgs += '--diagnostics' }
Set-Location -LiteralPath $projectRoot
Write-HostRecord 'host_start' 'worker_launch' $null
$ErrorActionPreference = 'Continue'
& $NodePath @workerArgs 2>&1 | ForEach-Object {
    try {
        if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -ge 1048576) { Move-Item -LiteralPath $log -Destination "$log.1" -Force -ErrorAction Stop }
        "$(Get-Date -Format o) $_" | Add-Content -LiteralPath $log -Encoding UTF8 -ErrorAction Stop
    } catch { }
}
$nodeExitCode = $LASTEXITCODE
if ($null -eq $nodeExitCode) {
    Write-HostRecord 'host_error' 'worker_launch_failed' $null
} else {
    Write-HostRecord 'host_end' 'node_exit' $nodeExitCode
}
exit $nodeExitCode
