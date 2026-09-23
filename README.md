# 影知工坊

影知工坊是一套面向 Windows 的本地视频知识整理工作台。它把“确定学习目标、筛选博主、挑选作品、转写文字、审核知识”拆成清晰的五步流程，并把账号状态、下载内容、转写稿、模型和知识成果保存在用户自己的 D 盘目录中。

## 项目定位

这是一个开源组件集成与产品化改造作品，不是对上游下载器源码的重新署名。

本项目的原创工作主要包括：

- Windows 原生五步工作台及交互设计；
- 学习主题、博主、作品、文字稿和知识草稿的完整工作流；
- 后台任务、任务锁、隔离桌面浏览器与中文可解释错误；
- 本地资料库的增删改、回收恢复和冲突处理；
- 本地转写与本地/云端总结模型编排；
- 面向关键交互、接口和桌面客户端的自动化回归测试。

下载和解析能力依赖两个 MIT 开源项目，固定版本和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 当前状态

- 2026-09-23 的项目内候选曾完成 432 项集成回归；本公开源码快照重新完成 Node `103/103` 和 Python `36/36` 离线回归。
- 真实只读链路曾完成主题搜索、博主筛选和作品列表冒烟验证。
- 当前公开仓库是源码版，不包含账号凭据、用户视频、转写稿、模型、浏览器运行时或历史知识成果。
- 尚未完成空白电脑的免环境安装与完整下载、转写、总结端到端验收，因此暂不承诺“下载即用”。

公开版验收边界见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 目录结构

```text
app/                  工作台源码与测试
app/desktop/          Windows 原生客户端
app/ui/               本地工作台服务与界面
scripts/bootstrap.ps1 固定版本依赖初始化
scripts/run-desktop.ps1 开发版桌面启动入口
docs/                 架构、验收与发布说明
```

## 开发环境

- Windows 10/11
- Git
- Python 3.10 或兼容版本
- Node.js 22 或兼容版本
- D 盘可写目录

## 初始化

在 PowerShell 中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\bootstrap.ps1 -WithHybrid
```

初始化脚本会把两个上游项目克隆到本仓库的 `vendor/`，校验并切换到声明的固定提交，然后调用应用安装脚本。运行数据默认写入 `D:\YingzhiWorkbench`，可通过 `DOUYIN_TOOL_HOME` 修改，但应用会拒绝把业务数据写入 C 盘。

## 启动开发版

```powershell
.\scripts\run-desktop.ps1
```

也可以双击 `启动影知工坊-开发版.cmd`。

## 运行测试

```powershell
.\scripts\test-source.ps1
```

安装 Playwright Chromium 后，可补充执行浏览器界面回归：

```powershell
.\scripts\test-source.ps1 -WithBrowser
```

测试分为隔离 fixture、桌面交互、服务接口和真实平台冒烟。默认测试不会登录抖音、不会下载真实作品，也不会调用收费模型。

## 隐私和合规

- 不要把 Cookie、登录状态、API Key、下载视频、转写稿、个人知识成果或本地模型提交到 Git。
- 仅处理本人有权访问、下载和整理的内容，并遵守平台规则、著作权和个人信息保护要求。
- 公开仓库只保存程序源码和匿名测试 fixture；运行数据由使用者自行保管。

## 许可证

本项目原创代码使用 [MIT License](LICENSE)。第三方组件保留各自许可证和版权声明。
