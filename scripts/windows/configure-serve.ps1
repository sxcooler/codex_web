[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port = 3000, [switch]$Interactive)
. (Join-Path $PSScriptRoot 'common.ps1')
$serveArgs = @()
if ($PSBoundParameters.ContainsKey('Port')) { $serveArgs += @('--port', "$Port") }
if ($Interactive) { $serveArgs += '--interactive' }
& $nodePath (Join-Path $projectRoot 'scripts/tailscale.ts') @serveArgs
exit $LASTEXITCODE
