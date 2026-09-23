[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$ToolRoot = $PSScriptRoot
$VendorRoot = (Resolve-Path (Join-Path $ToolRoot "..\vendor\douyin-downloader-1")).Path
$HybridRoot = (Resolve-Path (Join-Path $ToolRoot "..\vendor\video-batch-download")).Path
$RuntimeRoot = if ($env:DOUYIN_TOOL_HOME) { $env:DOUYIN_TOOL_HOME } else { "D:\YingzhiWorkbench" }
$CacheRoot = Join-Path $RuntimeRoot "cache"
$TempRoot = Join-Path $RuntimeRoot "tmp"
$Python = Join-Path $VendorRoot ".venv\Scripts\python.exe"
$ExpectedCommit = "b51225e695a9b8fff6eeb8b8178a53306f304f3a"
$ExpectedHybridCommit = "be5e41cf7e95b3c3388790bcce91b8becb942ef1"

foreach ($path in @($RuntimeRoot, $CacheRoot, $TempRoot)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:PYTHONPYCACHEPREFIX = Join-Path $CacheRoot "pycache"
$env:PYTHONPATH = $VendorRoot
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:npm_config_cache = Join-Path $CacheRoot "npm"
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $CacheRoot "playwright-node"
$env:HF_HOME = Join-Path $CacheRoot "huggingface"
$env:TORCH_HOME = Join-Path $CacheRoot "torch"
$env:XDG_CACHE_HOME = $CacheRoot

if (-not (Test-Path -LiteralPath $Python)) { throw "缺少 D 盘虚拟环境，请先运行 setup.ps1。" }

$ActualCommit = (& git -C $VendorRoot rev-parse HEAD).Trim()
if ($ActualCommit -ne $ExpectedCommit) {
    throw "上游版本漂移：期望 $ExpectedCommit，实际 $ActualCommit。"
}

$ActualHybridCommit = (& git -C $HybridRoot rev-parse HEAD).Trim()
if ($ActualHybridCommit -ne $ExpectedHybridCommit) {
    throw "混合下载引擎版本漂移：期望 $ExpectedHybridCommit，实际 $ActualHybridCommit。"
}

Push-Location $VendorRoot
try {
    # One upstream cookie-loader test scans its parent temp directory and can
    # read a sibling test's cookie fixture. Run it in a separate temp root.
    & $Python -m pytest -q -k "not test_config_loader_warns_for_non_object_auto_cookie_file"
    if ($LASTEXITCODE -ne 0) { throw "旧上游主测试集失败。" }
    $IsolatedPytestRoot = Join-Path $TempRoot ("pytest-cookie-isolated-" + [guid]::NewGuid().ToString("N"))
    $IsolatedCwd = Join-Path $IsolatedPytestRoot "cwd"
    New-Item -ItemType Directory -Path $IsolatedCwd -Force | Out-Null
    Push-Location $IsolatedCwd
    try {
        $env:PYTHONPATH = $VendorRoot
        & $Python -m pytest -q "$VendorRoot\tests\test_config_loader.py::test_config_loader_warns_for_non_object_auto_cookie_file" --basetemp (Join-Path $IsolatedPytestRoot "base")
        if ($LASTEXITCODE -ne 0) { throw "旧上游Cookie隔离测试失败。" }
    }
    finally {
        Pop-Location
    }

    & $Python -m ruff check --select E9,F63,F7,F82 --per-file-ignores "utils/abogus.py:F821" .
    if ($LASTEXITCODE -ne 0) { throw "Ruff 严重静态错误检查失败。" }

    & $Python -c "import yaml, pathlib; yaml.safe_load(pathlib.Path(r'$ToolRoot\config.template.yml').read_text(encoding='utf-8')); print('config template: PASS')"
    if ($LASTEXITCODE -ne 0) { throw "配置模板解析失败。" }

    & $Python -m cli.main --version
    if ($LASTEXITCODE -ne 0) { throw "CLI 入口验证失败。" }
}
finally {
    Pop-Location
}

& node --test (Join-Path $ToolRoot "test-prepare-links.mjs")
if ($LASTEXITCODE -ne 0) { throw "链接准备器测试失败。" }
& node --test (Join-Path $ToolRoot "test-build-knowledge-cards.mjs")
if ($LASTEXITCODE -ne 0) { throw "知识卡片测试失败。" }
& node --test (Join-Path $ToolRoot "test-summarize-knowledge.mjs")
if ($LASTEXITCODE -ne 0) { throw "AI总结引用与续跑测试失败。" }
& node --test (Join-Path $ToolRoot "test-local-model-provider.mjs")
if ($LASTEXITCODE -ne 0) { throw "本地模型接口测试失败。" }
& node --test (Join-Path $ToolRoot "test-codex-provider.mjs")
if ($LASTEXITCODE -ne 0) { throw "Codex executable resolver tests failed." }
& node --test (Join-Path $ToolRoot "test-model-api-provider.mjs")
if ($LASTEXITCODE -ne 0) { throw "模型 API Key 调用器测试失败。" }
& node --test (Join-Path $ToolRoot "test-discover-topic.mjs")
if ($LASTEXITCODE -ne 0) { throw "主题发现与候选报告测试失败。" }
& node (Join-Path $ToolRoot "ui\test-workbench.mjs")
if ($LASTEXITCODE -ne 0) { throw "本地工作台与博主链接入口测试失败。" }
& node (Join-Path $ToolRoot "ui\test-library.mjs")
if ($LASTEXITCODE -ne 0) { throw "Library CRUD regression failed." }
& node (Join-Path $ToolRoot "ui\test-account-session.mjs")
if ($LASTEXITCODE -ne 0) { throw "Background browser and explicit login regression failed." }
& node --test (Join-Path $ToolRoot "desktop\test-smoke-contract.mjs")
if ($LASTEXITCODE -ne 0) { throw "Real workbench smoke integrity contract failed." }
& $Python -m unittest discover -s (Join-Path $ToolRoot "desktop") -p "test_*.py"
if ($LASTEXITCODE -ne 0) { throw "Native desktop connected regression failed." }

Push-Location $HybridRoot
try {
    & npm test
    if ($LASTEXITCODE -ne 0) { throw "混合下载引擎测试失败。" }
}
finally {
    Pop-Location
}

& $Python -c "import importlib.metadata, faster_whisper, opencc; assert importlib.metadata.version('OpenCC') == '1.4.2'; opencc.OpenCC('t2s.json'); print('hybrid python dependencies: PASS')"
if ($LASTEXITCODE -ne 0) { throw "混合转写依赖缺失，请运行 setup.ps1 -WithHybrid。" }

& node -e "const fs=require('fs');const path=require('path');const req=require('module').createRequire(path.join(process.argv[1],'package.json'));const p=req('playwright').chromium.executablePath();if(!fs.existsSync(p))throw new Error('Chromium missing: '+p);console.log('chromium: PASS')" $HybridRoot
if ($LASTEXITCODE -ne 0) { throw "混合链路 Chromium 缺失，请运行 setup.ps1 -WithHybrid。" }

foreach ($script in @("run.ps1", "run-hybrid.ps1", "launcher.ps1", "launch-ui.ps1", "setup.ps1", "install-local-knowledge-model.ps1", "verify.ps1")) {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $ToolRoot $script), [ref]$null, [ref]$errors)
    if ($errors.Count -gt 0) { throw "$script PowerShell 语法检查失败：$($errors[0].Message)" }
}

foreach ($script in @("run-hidden-desktop.ps1", "verify-hidden-desktop.ps1", "build-native.ps1")) {
    $errors = $null
    $target = Join-Path $ToolRoot ("desktop\" + $script)
    [void][System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$null, [ref]$errors)
    if ($errors.Count -gt 0) { throw "$script PowerShell 语法检查失败：$($errors[0].Message)" }
}

$WindowsPowerShellEntry = Join-Path $ToolRoot "desktop\run-hidden-desktop.ps1"
if ([System.IO.File]::ReadAllText($WindowsPowerShellEntry) -match '[^\x00-\x7F]') {
    throw "run-hidden-desktop.ps1 必须保持纯 ASCII，避免 Windows PowerShell 5 将无 BOM UTF-8 误读后解析失败。"
}

$ModelPath = Join-Path $RuntimeRoot 'models\knowledge\Qwen3-4B-Q4_K_M.gguf'
$EnginePath = Join-Path $RuntimeRoot 'bin\llama-cpp\llama-server.exe'
if (-not (Test-Path -LiteralPath $ModelPath) -or -not (Test-Path -LiteralPath $EnginePath)) {
    throw '代码测试通过，但本地总结模型或运行器未安装；运行 install-local-knowledge-model.ps1 后再做真实总结验收。'
}
Write-Host "验证通过：双上游固定提交、两套上游测试、本地模型接口、主题发现、转写依赖、Chromium、PowerShell语法及本地总结资产均存在。"
Write-Warning "上游全量 Ruff 仍有 81 项既有格式/旧代码债务；未自动修改第三方源码。"
