[CmdletBinding()]
param(
    [ValidateSet("", "cookies", "url", "local", "results", "verify", "summarize", "knowledge", "discover")]
    [string]$Action = "",
    [string]$InputValue = "",
    [ValidateRange(1, 200)]
    [int]$MaxItems = 20
)

$ErrorActionPreference = "Stop"
$ToolRoot = $PSScriptRoot
$RuntimeRoot = if ($env:DOUYIN_TOOL_HOME) { $env:DOUYIN_TOOL_HOME } else { "D:\YingzhiWorkbench" }
$ResultRoot = Join-Path $RuntimeRoot "data"
$RunScript = Join-Path $ToolRoot "run.ps1"
$VerifyScript = Join-Path $ToolRoot "verify.ps1"

function Wait-ForUser {
    if (-not $Action) {
        Write-Host ""
        Read-Host "按 Enter 键返回菜单" | Out-Null
    }
}

function Get-DouyinUrlFromInput {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $match = [regex]::Match($Value, 'https?://[^\s]+', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
        throw "输入内容中没有找到以 http:// 或 https:// 开头的链接。"
    }

    return $match.Value.TrimEnd([char[]]"`"'.,;:!?)]}，。；：！？")
}

function Invoke-ToolAction {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SelectedAction,
        [string]$Value
    )

    switch ($SelectedAction) {
        "cookies" {
            Write-Host "即将打开抖音登录窗口。登录完成后请按浏览器页面提示继续。" -ForegroundColor Cyan
            & $RunScript -CaptureCookies
        }
        "url" {
            if (-not $Value) {
                $Value = Read-Host "请粘贴抖音博主主页或单条视频链接"
            }
            if ([string]::IsNullOrWhiteSpace($Value)) {
                throw "未输入抖音链接。"
            }
            $Value = Get-DouyinUrlFromInput -Value $Value
            Write-Host "已识别链接：$Value" -ForegroundColor Cyan
            $RequestedItems = $MaxItems
            if (-not $Action -and $Value -match '/user/' ) {
                $rawCount = Read-Host "按主页展示顺序处理多少条作品（含置顶；直接回车默认 20，最大 200）"
                if (-not [string]::IsNullOrWhiteSpace($rawCount)) {
                    $parsedCount = 0
                    if (-not [int]::TryParse($rawCount, [ref]$parsedCount) -or $parsedCount -lt 1 -or $parsedCount -gt 200) {
                        throw "作品数量必须是 1 到 200 的整数。"
                    }
                    $RequestedItems = $parsedCount
                }
            }
            & $RunScript -Url $Value -MaxItems $RequestedItems -VerboseLogs
        }
        "local" {
            if (-not $Value) {
                $Value = Read-Host "请输入本地视频或音频的完整路径"
            }
            $resolved = (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path
            & $RunScript -Url $resolved
        }
        "results" {
            New-Item -ItemType Directory -Path $ResultRoot -Force | Out-Null
            Start-Process explorer.exe -ArgumentList $ResultRoot
        }
        "verify" {
            & $VerifyScript
        }
        "summarize" {
            $SummaryArgs = @((Join-Path $ToolRoot 'summarize-knowledge.mjs'), '--summary', (Join-Path $ResultRoot 'download-summary.json'), '--resume-pending')
            if (-not $Action) {
                $ids = Read-Host "输入要总结的视频ID（多个用英文逗号分隔；留空处理全部）"
                if (-not [string]::IsNullOrWhiteSpace($ids)) { $SummaryArgs += @('--video-ids', $ids) }
            }
            & node @SummaryArgs
        }
        "discover" {
            if (-not $Value) { $Value = Read-Host "请描述想学习的业务主题" }
            if ([string]::IsNullOrWhiteSpace($Value)) { throw "业务主题不能为空。" }
            $candidateRoot = (Resolve-Path (Join-Path $ToolRoot '..\vendor\video-batch-download')).Path
            $env:TEMP = Join-Path $RuntimeRoot 'tmp'
            $env:TMP = Join-Path $RuntimeRoot 'tmp'
            $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $RuntimeRoot 'cache\playwright-node'
            Write-Host "将打开抖音浏览器；若出现验证码，请由你本人完成验证。" -ForegroundColor Cyan
            & node (Join-Path $ToolRoot 'discover-topic.mjs') --topic $Value `
                --cookie-source (Join-Path $RuntimeRoot 'config\cookies.json') `
                --candidate-root $candidateRoot --output-root $ResultRoot --limit 10 --headed
        }
        "knowledge" {
            $KnowledgePage = Join-Path $ResultRoot 'knowledge\index.html'
            if (-not (Test-Path -LiteralPath $KnowledgePage)) { throw '尚未生成知识总结，请先使用菜单6。' }
            Start-Process -FilePath $KnowledgePage
        }
        default {
            throw "未知操作：$SelectedAction"
        }
    }

    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "操作未完成，退出码：$LASTEXITCODE"
    }
}

if ($Action) {
    Invoke-ToolAction -SelectedAction $Action -Value $InputValue
    exit 0
}

while ($true) {
    Clear-Host
    Write-Host "========================================" -ForegroundColor DarkCyan
    Write-Host "        抖音视频知识整理工具" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor DarkCyan
    Write-Host "运行数据：$RuntimeRoot"
    Write-Host ""
    Write-Host "1. 首次登录或更新抖音登录信息"
    Write-Host "2. 下载并本地转写博主主页或单条视频"
    Write-Host "3. 本地视频或音频转写（暂不自动总结）"
    Write-Host "4. 打开输出结果目录"
    Write-Host "5. 运行环境自检"
    Write-Host "6. 确认文字稿后，用本地模型生成知识总结"
    Write-Host "7. 打开知识总结阅读页面"
    Write-Host "8. 按学习主题发现候选博主（本地模型）"
    Write-Host "0. 退出"
    Write-Host ""

    $choice = Read-Host "请选择"
    try {
        switch ($choice) {
            "1" { Invoke-ToolAction -SelectedAction "cookies" }
            "2" { Invoke-ToolAction -SelectedAction "url" }
            "3" { Invoke-ToolAction -SelectedAction "local" }
            "4" { Invoke-ToolAction -SelectedAction "results" }
            "5" { Invoke-ToolAction -SelectedAction "verify" }
            "6" { Invoke-ToolAction -SelectedAction "summarize" }
            "7" { Invoke-ToolAction -SelectedAction "knowledge" }
            "8" { Invoke-ToolAction -SelectedAction "discover" }
            "0" { exit 0 }
            default { Write-Host "请输入 0 到 8。" -ForegroundColor Yellow }
        }
    }
    catch {
        Write-Host "操作失败：$($_.Exception.Message)" -ForegroundColor Red
    }
    Wait-ForUser
}
