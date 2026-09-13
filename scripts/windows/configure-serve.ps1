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
& $tailscalePath serve --bg --https=443 "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) { throw 'Serve was not configured. Follow the Tailscale HTTPS enablement instructions if shown.' }
$dataDir = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))) '.local\web'
$configPath = Join-Path $dataDir 'config.json'
$config = @{}
if (Test-Path -LiteralPath $configPath) { $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable }
$config.origin = "https://$dnsName"
$config.port = $Port
$temporary = "$configPath.tmp"
$config | ConvertTo-Json | Set-Content -LiteralPath $temporary
Move-Item -LiteralPath $temporary -Destination $configPath -Force
Write-Output "Configured private HTTPS at https://$dnsName. Restart the Web server to use this origin."
