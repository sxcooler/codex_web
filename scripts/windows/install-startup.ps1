[CmdletBinding()]
param([switch]$Start, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script = Join-Path $PSScriptRoot 'start-server.ps1'
$legacyCommand = "`"$shell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Background"
$launcherDir = Join-Path $projectRoot '.local/startup'
$launcher = Join-Path $launcherDir 'codex_web.exe'
$command = "`"$launcher`""
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '').Substring(0,12) } finally { $sha.Dispose() }
$name = "CodexWeb-$hash"
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$existing = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).$name
if ($existing -and $existing -ne $command -and $existing -ne $legacyCommand) { throw 'A different startup command uses this name; nothing was changed.' }
$task = Get-ScheduledTask -TaskName 'Codex Remote Web' -ErrorAction SilentlyContinue
if ($task) {
    $legacyScript = Join-Path $projectRoot 'scripts\start-server.ps1'
    if (@($task.Actions).Count -ne 1 -or ($task.Actions.Arguments -notlike "*-File `"$script`"" -and $task.Actions.Arguments -notlike "*-File `"$legacyScript`"")) { throw 'Legacy task belongs to another command; nothing was changed.' }
}
if ($Remove) {
    if ($task) { Unregister-ScheduledTask -TaskName 'Codex Remote Web' -Confirm:$false }
    if ($existing) { Remove-ItemProperty -LiteralPath $key -Name $name }
    Write-Output 'Removed this workspace logon startup. Running servers were not stopped.'
} else {
    [IO.Directory]::CreateDirectory($launcherDir) | Out-Null
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
    $temporary = Join-Path $launcherDir ('codex_web-' + [Guid]::NewGuid().ToString('N') + '.exe')
    try {
        & $compiler /nologo /target:winexe "/out:$temporary" "/win32icon:$(Join-Path $PSScriptRoot 'codex-web.ico')" (Join-Path $PSScriptRoot 'startup-launcher.cs')
        if ($LASTEXITCODE -ne 0) { throw 'Could not build the startup launcher; existing startup entry was preserved.' }
        Move-Item -LiteralPath $temporary -Destination $launcher -Force
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key | Out-Null }
    New-ItemProperty -LiteralPath $key -Name $name -Value $command -PropertyType String -Force | Out-Null
    if ($task) { Unregister-ScheduledTask -TaskName 'Codex Remote Web' -Confirm:$false }
    Write-Output 'Installed logon startup for the current user. No scheduled task or service is required.'
    if ($Start) { & $script -Background }
}
