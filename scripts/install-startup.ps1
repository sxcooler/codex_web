[CmdletBinding()]
param([switch]$Start)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskName = 'Codex Remote Web'
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
# Store updates remove versioned executables; the per-user app execution alias survives them.
$storePattern = Join-Path $env:ProgramFiles 'WindowsApps\Microsoft.PowerShell_*\pwsh.exe'
$storeAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
if ($pwshPath -like $storePattern -and (Test-Path -LiteralPath $storeAlias)) { $pwshPath = $storeAlias }
$scriptPath = Join-Path $PSScriptRoot 'start-server.ps1'
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$scriptPath`""
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and (($existing.Actions.Arguments -ne $arguments) -or
    ($existing.Actions.Execute -ne $pwshPath -and -not ($pwshPath -eq $storeAlias -and $existing.Actions.Execute -like $storePattern)))) {
    throw 'A different task already uses this name. It was not overwritten.'
}
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $pwshPath -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if ($Start) { Start-ScheduledTask -TaskName $taskName }
Write-Output "Installed '$taskName' for the current user's interactive logon."
