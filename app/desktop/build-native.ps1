param(
    [string]$Python = "python",
    [switch]$Activate
)

$ErrorActionPreference = "Stop"
$ToolRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$BuildRoot = Join-Path $ToolRoot "runtime\native-build"
$EnvRoot = Join-Path $BuildRoot "env"
$DistRoot = Join-Path $PSScriptRoot "dist"
$PackageName = "DouyinKnowledgeDesk-" + (Get-Date -Format "yyyyMMdd-HHmmss-fff")
foreach ($path in @($BuildRoot, $EnvRoot, $DistRoot)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}
$env:TEMP = $EnvRoot
$env:TMP = $EnvRoot
$env:PYTHONPYCACHEPREFIX = Join-Path $EnvRoot "pycache"
$env:PYINSTALLER_CONFIG_DIR = Join-Path $EnvRoot "pyinstaller"
$env:DOUYIN_TOOL_HOME = "D:\YingzhiWorkbench"

& $Python -m PyInstaller --noconfirm --clean --onedir --windowed `
    --name $PackageName `
    --distpath $DistRoot `
    --workpath (Join-Path $BuildRoot "work") `
    --specpath $BuildRoot `
    (Join-Path $PSScriptRoot "app.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }
if ($Activate) {
    Set-Content -LiteralPath (Join-Path $PSScriptRoot "current-build.txt") -Value $PackageName -Encoding ASCII
}
Write-Host (Join-Path (Join-Path $DistRoot $PackageName) ($PackageName + ".exe"))
