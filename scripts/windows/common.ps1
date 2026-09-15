$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$nodePath = Join-Path $projectRoot 'runtime/node.exe'
$portableArgs = @()
if (Test-Path -LiteralPath $nodePath) { $portableArgs = @('--portable') }
else {
    $nodePath = Join-Path $projectRoot '.local/node24/node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
}
