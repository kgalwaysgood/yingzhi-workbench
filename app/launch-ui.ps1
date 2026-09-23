[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ToolRoot = $PSScriptRoot
$ServerPath = Join-Path $ToolRoot 'ui\server.mjs'
$Port = 8765
$Url = "http://127.0.0.1:$Port"
$BundledNode = Join-Path $ToolRoot 'runtime\node.exe'
$Node = if (Test-Path -LiteralPath $BundledNode) { $BundledNode } else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $Node) { throw 'Node runtime is missing. The portable package is not ready yet.' }

function Get-WorkbenchResponse {
    try { return Invoke-WebRequest -Uri "$Url/api/state" -UseBasicParsing -TimeoutSec 2 }
    catch { return $null }
}

$existing = Get-WorkbenchResponse
if ($existing -and $existing.StatusCode -eq 200 -and $existing.Headers['X-Douyin-Tool'] -eq 'workbench') {
    Start-Process -FilePath $Url
    return
}
if ($existing) { throw "Port $Port is occupied by another service. Refusing to open an unknown page." }

$argument = '"{0}" --port {1}' -f $ServerPath, $Port
$process = Start-Process -FilePath $Node -ArgumentList $argument -WorkingDirectory $ToolRoot -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($process.HasExited) { throw "Workbench failed to start. Exit code: $($process.ExitCode)" }
    $response = Get-WorkbenchResponse
    if ($response -and $response.StatusCode -eq 200 -and $response.Headers['X-Douyin-Tool'] -eq 'workbench') {
        Start-Process -FilePath $Url
        return
    }
}
throw 'Workbench startup timed out. Check whether port 8765 is available.'
