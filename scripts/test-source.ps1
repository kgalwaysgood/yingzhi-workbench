[CmdletBinding()]
param(
    [switch]$WithBrowser
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$AppRoot = Join-Path $RepoRoot 'app'

Push-Location $RepoRoot
try {
    $nodeTests = @(
        '--test'
        (Join-Path $AppRoot 'test-build-knowledge-cards.mjs')
        (Join-Path $AppRoot 'test-codex-provider.mjs')
        (Join-Path $AppRoot 'test-discover-topic.mjs')
        (Join-Path $AppRoot 'test-local-model-provider.mjs')
        (Join-Path $AppRoot 'test-model-api-provider.mjs')
        (Join-Path $AppRoot 'test-prepare-links.mjs')
        (Join-Path $AppRoot 'test-summarize-knowledge.mjs')
        (Join-Path $AppRoot 'ui\test-account-session.mjs')
        (Join-Path $AppRoot 'ui\test-library.mjs')
        (Join-Path $AppRoot 'ui\test-workbench.mjs')
        (Join-Path $AppRoot 'desktop\test-smoke-contract.mjs')
    )
    if ($WithBrowser) {
        $nodeTests += (Join-Path $AppRoot 'ui\test-browser.mjs')
    }
    & node @nodeTests
    if ($LASTEXITCODE -ne 0) { throw 'Node regression tests failed.' }

    $pythonTests = @('-m', 'unittest', 'discover', '-s', (Join-Path $AppRoot 'desktop'), '-p', 'test_*.py')
    & python @pythonTests
    if ($LASTEXITCODE -ne 0) { throw 'Python desktop regression tests failed.' }

    $setupSource = Get-Content -LiteralPath (Join-Path $AppRoot 'setup.ps1') -Raw
    foreach ($requiredSetupContract in @('$WithLocalWhisper -or $WithHybrid', 'imageio-ffmpeg', 'Join-Path $BinRoot "ffmpeg.exe"')) {
        if (-not $setupSource.Contains($requiredSetupContract)) {
            throw "Clean-install contract is missing: $requiredSetupContract"
        }
    }
}
finally {
    Pop-Location
}
