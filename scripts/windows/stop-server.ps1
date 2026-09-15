. (Join-Path $PSScriptRoot 'common.ps1')
& $nodePath (Join-Path $projectRoot 'scripts/server-control.ts') --stop
exit $LASTEXITCODE
