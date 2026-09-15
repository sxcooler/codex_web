[CmdletBinding()]
param([switch]$Start, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script = Join-Path $PSScriptRoot 'start-server.ps1'
$command = "`"$shell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Background"
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '').Substring(0,12) } finally { $sha.Dispose() }
$name = "CodexWeb-$hash"
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$existing = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).$name
if ($existing -and $existing -ne $command) { throw 'A different startup command uses this name; nothing was changed.' }
$task = Get-ScheduledTask -TaskName 'Codex Remote Web' -ErrorAction SilentlyContinue
if ($task) {
    $legacyScript = Join-Path $projectRoot 'scripts\start-server.ps1'
    if (@($task.Actions).Count -ne 1 -or ($task.Actions.Arguments -notlike "*-File `"$script`"" -and $task.Actions.Arguments -notlike "*-File `"$legacyScript`"")) { throw 'Legacy task belongs to another command; nothing was changed.' }
    Unregister-ScheduledTask -TaskName 'Codex Remote Web' -Confirm:$false
}
if ($Remove) {
    if ($existing) { Remove-ItemProperty -LiteralPath $key -Name $name }
    Write-Output 'Removed this workspace logon startup. Running servers were not stopped.'
} else {
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key | Out-Null }
    New-ItemProperty -LiteralPath $key -Name $name -Value $command -PropertyType String -Force | Out-Null
    Write-Output 'Installed logon startup for the current user. No scheduled task or service is required.'
    if ($Start) { & $script -Background }
}
