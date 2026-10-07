# Schedule from the hosting Codex turn, then finish the reply before the printed time.
# -CheckOnly exercises the interactive task without stopping the server.
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$RequireIdle,
    [switch]$Diagnostics,
    [switch]$JsonOutput,
    [ValidateRange(90, 3600)][int]$DelaySeconds = 90,
    [switch]$Worker,
    [string]$RequestFile
)
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location -LiteralPath $projectRoot

function Get-ManagedServer {
    $json = & $nodePath --input-type=module -e "import {managedServer} from './scripts/server-control.ts'; console.log(JSON.stringify(await managedServer()));"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the managed server.' }
    $server = $json | ConvertFrom-Json
    if (-not $server) { throw 'No managed server. In desktop PowerShell, stop the manually launched server and run scripts/windows/start-server.ps1 -Background.' }
    return $server
}

if ($Worker) {
    if (-not $RequestFile) { throw 'Worker requires a request file.' }
    $log = "$RequestFile.log"
    try {
        $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
        if ((Get-Process -Id $PID).SessionId -ne $request.sessionId) { throw 'Worker session differs from the verified desktop session; nothing was stopped.' }
        foreach ($property in $request.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, $property.Value, 'Process') }
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/index.html'))) { throw 'Run npm run build first.' }
        foreach ($path in @('.local/update-lock.json', '.local/updates/pending.json')) {
            if (Test-Path -LiteralPath (Join-Path $projectRoot $path)) { throw 'An update is pending; recover it before restarting.' }
        }
        $old = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$request.oldPid)"
        if (-not $old -or $old.CreationDate.ToUniversalTime().ToString('o') -ne $request.oldStarted) { throw 'Old server identity changed; nothing was stopped.' }
        $server = Get-ManagedServer
        $owners = @(Get-NetTCPConnection -State Listen -LocalPort $request.port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($server.pid -ne $request.oldPid -or $owners.Count -ne 1 -or $owners[0] -ne $server.pid) { throw 'Server or listener identity changed; nothing was stopped.' }
        $status = 'ready'
        $message = "Desktop Session $($request.sessionId) and current server verified."
        $newProcessId = 0
        if (-not $CheckOnly) {
            $stopMode = if ($request.requireIdle) { '--stop-if-idle' } else { '--stop' }
            & $nodePath (Join-Path $projectRoot 'scripts/server-control.ts') $stopMode 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
            if ($LASTEXITCODE -ne 0) { throw 'Managed stop failed; no process was forcibly killed.' }
            for ($attempt = 0; $attempt -lt 100; $attempt++) {
                if (-not (Get-NetTCPConnection -State Listen -LocalPort $request.port -ErrorAction SilentlyContinue)) { break }
                Start-Sleep -Milliseconds 200
            }
            if (Get-NetTCPConnection -State Listen -LocalPort $request.port -ErrorAction SilentlyContinue) { throw 'Web port is still occupied; no other process was stopped.' }
            $diagnosticArgs = @()
            if ($request.diagnosticsEnabled -or $server.diagnosticsEnabled) { $diagnosticArgs = @('--diagnostics') }
            & $nodePath (Join-Path $projectRoot 'scripts/server-control.ts') --background @portableArgs @diagnosticArgs 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
            if ($LASTEXITCODE -ne 0) { throw "Background startup failed; inspect $log" }
            $new = Get-ManagedServer
            if ($diagnosticArgs.Count -and -not $new.diagnosticsEnabled) { throw 'New server did not enable the requested diagnostics.' }
            $owners = @(Get-NetTCPConnection -State Listen -LocalPort $request.port | Select-Object -ExpandProperty OwningProcess -Unique)
            if ($new.pid -eq $request.oldPid -or (Get-Process -Id $new.pid).SessionId -ne $request.sessionId -or $owners.Count -ne 1 -or $owners[0] -ne $new.pid) { throw 'New server PID, session or listener verification failed.' }
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($request.port)/api/auth/session" -Headers @{Host=([uri]$new.origin).Authority} -UseBasicParsing -TimeoutSec 10
            if ($response.StatusCode -ne 200) { throw 'New server HTTP check failed.' }
            $status = 'success'
            $message = "New server is in Session $($request.sessionId); listener and HTTP 200 verified."
            $newProcessId = $new.pid
        }
    } catch {
        $status = 'failed'
        $message = $_.Exception.Message
    }
    [pscustomobject]@{time=(Get-Date -Format o);status=$status;message=$message;newPid=$newProcessId} | ConvertTo-Json | Set-Content -LiteralPath "$RequestFile.result.json" -Encoding UTF8
    "$(Get-Date -Format o) $status $message" | Add-Content -LiteralPath $log -Encoding UTF8
    if (-not $CheckOnly -and $request.taskName) { Unregister-ScheduledTask -TaskName $request.taskName -Confirm:$false -ErrorAction SilentlyContinue }
    if ($status -eq 'failed') { Write-Error $message -ErrorAction Continue; exit 1 }
    exit 0
}

$server = Get-ManagedServer
$old = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$server.pid)"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$desktops = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { $_.SessionId -gt 0 -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $identity.User.Value } | Select-Object -ExpandProperty SessionId -Unique)
if ($desktops.Count -ne 1) { throw 'Cannot identify one desktop session for this user. Run this script from the intended desktop PowerShell.' }
$config = Get-Content -LiteralPath (Join-Path $projectRoot '.local/web/config.json') -Raw | ConvertFrom-Json
$port = if ($env:PORT -and -not $portableArgs) { [int]$env:PORT } elseif ($config.port) { [int]$config.port } else { 3000 }
$taskName = 'CodexWeb-Restart-' + [Guid]::NewGuid().ToString('N')
$RequestFile = Join-Path $projectRoot ".local/web/$taskName.json"
$environment = @{}
foreach ($key in @('PORT', 'WEB_ORIGIN', 'WORK_ROOT', 'CODEX_BIN')) { $environment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
@{oldPid=$old.ProcessId;oldStarted=$old.CreationDate.ToUniversalTime().ToString('o');sessionId=$desktops[0];port=$port;taskName=$taskName;environment=$environment;requireIdle=[bool]$RequireIdle;diagnosticsEnabled=[bool]$Diagnostics} | ConvertTo-Json | Set-Content -LiteralPath $RequestFile -Encoding UTF8
$shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Worker -RequestFile `"$RequestFile`""
$level = if ((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'Highest' } else { 'Limited' }
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel $level
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$scheduled = $false
try {
    $action = New-ScheduledTaskAction -Execute $shell -Argument "$arguments -CheckOnly" -WorkingDirectory $projectRoot
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $taskName
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ((Test-Path -LiteralPath "$RequestFile.result.json") -and (Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { break }
        Start-Sleep -Milliseconds 300
    }
    if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { throw 'Desktop preflight timed out; no restart scheduled.' }
    $result = Get-Content -LiteralPath "$RequestFile.result.json" -Raw | ConvertFrom-Json
    if ($result.status -ne 'ready') { throw $result.message }
    if ($CheckOnly) { Write-Output "Preflight passed. Service unchanged. Result: $RequestFile.result.json" }
    else {
        $when = (Get-Date).AddSeconds($DelaySeconds)
        $action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $projectRoot
        Set-ScheduledTask -TaskName $taskName -Action $action -Trigger (New-ScheduledTaskTrigger -Once -At $when) | Out-Null
        $scheduled = $true
        $receipt = @{scheduledAt=$when.ToUniversalTime().ToString('o');file=[IO.Path]::GetFileName($RequestFile)} | ConvertTo-Json -Compress
        $receipt | Set-Content -LiteralPath (Join-Path $projectRoot '.local/web/restart-latest.json') -Encoding UTF8
        if ($JsonOutput) { Write-Output $receipt }
        else {
            Write-Output "Scheduled for $($when.ToString('yyyy-MM-dd HH:mm:ss zzz')) in Session $($desktops[0]). Finish this reply before then. Do not start new work until refresh."
            Write-Output "Result (ready means preflight only): $RequestFile.result.json"
        }
    }
} finally {
    if (-not $scheduled) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
}
