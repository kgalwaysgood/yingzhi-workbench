[CmdletBinding()]
param(
    [string]$RuntimeRoot = $(if ($env:DOUYIN_TOOL_HOME) { $env:DOUYIN_TOOL_HOME } else { 'D:\YingzhiWorkbench' })
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

if ([System.IO.Path]::GetPathRoot($RuntimeRoot).TrimEnd('\').ToUpperInvariant() -eq 'C:') {
    throw 'Runtime data cannot be stored on C:.'
}

$env:DOUYIN_TOOL_HOME = $RuntimeRoot
$app = Join-Path $RepoRoot 'app\desktop\app.py'
& python $app
exit $LASTEXITCODE
