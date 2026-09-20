[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port = 3000)
$ErrorActionPreference = 'Stop'
$tailscalePath = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$statusJson = & $tailscalePath status --json
if ($LASTEXITCODE -ne 0) { throw 'Cannot read Tailscale status.' }
$status = $statusJson | ConvertFrom-Json
if ($status.BackendState -ne 'Running') { throw 'Tailscale is not running.' }
$dnsName = $status.Self.DNSName.TrimEnd('.')
if ($dnsName -notmatch '^[a-zA-Z0-9.-]+\.ts\.net$') { throw 'No valid Tailscale DNS name.' }
$serveJson = & $tailscalePath serve status --json
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing Serve mappings.' }
$serve = $serveJson | ConvertFrom-Json
if (@($serve.PSObject.Properties).Count -gt 0) { throw 'Serve already has configuration; inspect it before making changes. Nothing was overwritten.' }
$dataDir = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))) '.local\web'
$configPath = Join-Path $dataDir 'config.json'
$config = @{}
if (Test-Path -LiteralPath $configPath) {
    $saved = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $config[$property.Name] = $property.Value }
}
if ($config.ContainsKey('allowedOrigins') -and $config.allowedOrigins -isnot [Array]) { throw 'allowedOrigins must be an array.' }
$previousOrigin = if ($config.origin) { $config.origin } else { "http://localhost:$Port" }
$config.allowedOrigins = @(@($previousOrigin) + @($config.allowedOrigins) | Where-Object { $_ -and $_ -ne "https://$dnsName" } | Select-Object -Unique)
$config.origin = "https://$dnsName"
$config.port = $Port
& $tailscalePath serve --bg --https=443 "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) { throw 'Serve was not configured. Follow the Tailscale HTTPS enablement instructions if shown.' }
$temporary = "$configPath.tmp"
[IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $configPath -Force
Write-Output "Configured private HTTPS at https://$dnsName. Restart the Web server to use this origin."
