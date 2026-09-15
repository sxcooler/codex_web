[CmdletBinding()]
param([switch]$Background)
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.local/web/auth.json'))) { throw 'Run authentication setup first.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/index.html'))) { throw 'Run npm run build first.' }
$mode = if ($Background) { '--background' } else { '--foreground' }
& $nodePath (Join-Path $projectRoot 'scripts/server-control.ts') $mode @portableArgs
exit $LASTEXITCODE
