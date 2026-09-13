$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$startScript = Join-Path $PSScriptRoot 'start-server.ps1'
$mainScript = Join-Path $projectRoot 'src\server\main.ts'
$task = Get-ScheduledTask -TaskName 'Codex Remote Web' -ErrorAction SilentlyContinue
if ($task) {
    if ($task.Actions.Arguments -notlike "*`"$startScript`"*") { throw 'The scheduled task belongs to another command; nothing was stopped.' }
    Stop-ScheduledTask -TaskName 'Codex Remote Web'
}
# Task Scheduler can leave the pipeline's Node child running. Match only this project's entry point.
$entryPattern = '^(?:"[^"\r\n]*\\node\.exe"|[^\s"]*\\node\.exe)\s+"?' + [regex]::Escape($mainScript) + '"?$'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $entryPattern } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -ErrorAction Stop
}
Write-Output "Stopped this project's Web server. The logon task remains installed."
