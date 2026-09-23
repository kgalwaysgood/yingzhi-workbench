"""Plain-language diagnostics for the native workbench."""

from dataclasses import dataclass
import re


@dataclass(frozen=True)
class UserFacingError:
    code: str
    title: str
    cause: str
    action: str

    def format(self):
        return (
            f"发生了什么：{self.title}\n\n"
            f"可能原因：{self.cause}\n\n"
            f"你可以这样做：{self.action}\n\n"
            f"错误编号：{self.code}"
        )


def explain_error(message):
    raw = str(message or "").strip()
    value = raw.lower()

    if ("eperm" in value or "eacces" in value or "operation not permitted" in value) and (
        "playwright-storage-state" in value or "登录目录" in raw
    ):
        return UserFacingError(
            "ENV-001", "抖音登录信息文件暂时无法写入",
            "当前本地处理引擎可能运行在受限环境，或者登录文件被其他程序占用；这不表示你的链接填错。",
            "关闭旧工作台，从 Windows 资源管理器双击最新的“启动抖音知识工作台.cmd”；不需要删除登录信息。",
        )
    if "eperm" in value or "eacces" in value or "operation not permitted" in value or "拒绝访问" in raw:
        return UserFacingError(
            "ENV-002", "本地文件暂时无法访问",
            "运行目录可能受权限限制，或文件正被其他程序占用。",
            "关闭占用该文件的程序，从资源管理器重新打开桌面工具；如仍失败，请把错误编号交给维护者。",
        )
    if "分享短链接跳转到了抖音首页" in raw or (
        "链接跳转后不是博主主页" in raw and "https://www.douyin.com/" in raw
    ):
        return UserFacingError(
            "LINK-001", "分享链接没有定位到博主主页",
            "抖音把短链接带回了首页，可能是链接过期、登录验证或平台重定向。不能据此猜测博主身份。",
            "在抖音打开该博主的主页，重新复制完整的 www.douyin.com/user/... 链接，再粘贴到这里。",
        )
    if "不是博主主页" in raw or "不是有效的抖音链接" in raw or "没有找到博主主页链接" in raw:
        return UserFacingError(
            "LINK-002", "输入的链接不是可识别的博主主页",
            "输入内容可能是搜索页、单条视频或不完整的分享文字。",
            "请从博主主页复制链接，或者先用第一步的学习主题搜索候选博主。",
        )
    if "验证码" in raw:
        return UserFacingError(
            "DOUYIN-003", "抖音需要你完成人工验证",
            "搜索窗口停在抖音安全验证页，限定时间内没有取得作品结果；工具不会绕过平台验证。",
            "点击工作台的“打开验证窗口并重试”后完成验证码；普通搜索不会自动打开窗口，工具不会绕过验证。",
        )
    if "未取得可核对的抖音作品" in raw or "没有取得可验证的博主主页" in raw:
        return UserFacingError(
            "DOUYIN-004", "后台搜索没有取得可用结果",
            "可能是搜索结果为空、页面内容未加载或平台访问受限；目前不能确定原因，也不会编造博主推荐。",
            "可更换关键词或粘贴博主主页；如需核对登录，可主动打开验证窗口。工具不会自行弹出浏览器。",
        )
    if "未枚举到任何作品" in raw or "登录信息可能过期" in raw:
        return UserFacingError(
            "DOUYIN-001", "暂时没有取得博主作品",
            "抖音可能要求重新登录或完成人工验证，也可能没有可见的公开作品。",
            "在抖音完成登录或验证码后，确认主页能看到作品，再返回工具重试；不要连续快速重复请求。",
        )
    if any(token in raw for token in ("登录信息为空", "登录信息已失效", "未检测到非空且未过期的抖音会话")):
        return UserFacingError(
            "AUTH-001", "需要更新抖音登录信息",
            "当前没有可用的抖音登录会话，后台搜索已停止。",
            "点击“账号与验证”，本人完成登录后返回应用保存，再继续搜索。不会自动打开浏览器。",
        )
    if "请求校验失败" in raw or "401" in value or "session token" in value:
        return UserFacingError(
            "SESSION-001", "本地会话需要重新建立",
            "桌面窗口和本地处理引擎的会话可能已经过期，或旧版本仍在运行。",
            "关闭旧工作台，从最新桌面入口重新打开；已有下载和文字稿不会因此删除。",
        )
    if "403" in value or "429" in value or "rate limit" in value:
        return UserFacingError(
            "DOUYIN-002", "平台暂时拒绝这次访问",
            "抖音可能触发了访问限制，或当前登录信息已经失效。",
            "先在抖音人工确认账号和主页可访问，稍后再试；工具不会绕过平台验证。",
        )
    if "executable doesn't exist" in value or "browsertype.launch" in value or "chromium" in value:
        return UserFacingError(
            "ENV-003", "本地浏览器处理组件未就绪",
            "用于读取博主主页的组件可能缺失，或安装路径已经变化。",
            "请使用完整工具目录运行，并联系维护者检查 D 盘的 Playwright 组件。",
        )
    if "node runtime is missing" in value or "application engine is missing" in value:
        return UserFacingError(
            "ENV-004", "桌面工具缺少本地处理引擎",
            "当前电脑可能只复制了 EXE，没有复制完整工具目录或安装所需运行组件。",
            "请使用完整工具目录；此版本尚未通过空白电脑免环境安装验收。",
        )
    if "different data directory" in value or "unknown service" in value or "session token" in value:
        return UserFacingError(
            "ENV-005", "连接到了其他本地程序或旧会话",
            "本地端口可能已被旧工作台或别的程序占用。",
            "关闭旧工作台后重新打开最新版桌面入口，不要同时运行多个版本。",
        )
    if "enoent" in value or "no such file" in value:
        return UserFacingError(
            "ENV-006", "处理所需的本地文件不存在",
            "工具目录、浏览器组件、视频文件或模型文件可能不完整。",
            "不要手动创建空文件；请保留截图并让维护者根据错误编号检查缺失项。",
        )
    if "模型" in raw and ("未就绪" in raw or "不存在" in raw or "未安装" in raw):
        return UserFacingError(
            "MODEL-001", "本地知识总结模型未就绪",
            "文字稿可以查看，但当前无法生成新的知识总结。",
            "等待模型文件完成安装和校验后，再选择文字稿执行总结；无需重新下载视频。",
        )
    if any(token in value for token in ("timeout", "timed out", "etimedout", "econnreset", "fetch failed")) or "超时" in raw:
        return UserFacingError(
            "NET-001", "连接或处理等待超时",
            "网络连接可能不稳定，或平台响应较慢；这不代表任务已经成功。",
            "先检查本地任务状态与已有结果，确认没有进行中的任务后再重试，避免重复下载。",
        )
    if "处理程序退出码" in raw:
        return UserFacingError(
            "TASK-001", "后台处理程序提前结束",
            "某一步没有得到成功结果，不能把已启动当作已完成。",
            "保留当前截图和任务日志，先检查已完成的作品或文字稿，再由维护者定位具体失败阶段。",
        )
    if "terminated" in value:
        return UserFacingError(
            "TASK-002", "旧的高耗时任务已停止",
            "维护过程中主动终止了旧版的本地模型排序任务，因此没有生成候选结果，也没有写入伪数据。",
            "请使用当前最新窗口重新搜索；新版已取消第二次高耗时模型排序。",
        )
    if any(token in raw for token in ("请先", "请输入", "请选择", "不能为空", "至少", "须为")):
        return UserFacingError(
            "INPUT-001", "本页输入尚未满足要求",
            raw[:120],
            "按本页提示补充或修改输入后再继续；未启动下载或总结任务。",
        )

    detail = re.sub(r"\s+", " ", raw)[:120] or "后台没有返回明确原因"
    return UserFacingError(
        "TASK-999", "本步骤未完成",
        f"系统返回了尚未归类的提示：{detail}",
        "请先核对本页输入和已有结果；若再次出现，请把错误编号和截图发给维护者，不要反复提交。",
    )


def job_failure_message(job):
    error = str(job.get("error") or "")
    if "处理程序退出码" not in error:
        return error or "任务失败，但后台未返回原因"
    for chunk in reversed(job.get("logs") or []):
        lines = re.sub(r"\x1b\[[0-9;]*m", "", str(chunk)).splitlines()
        for line in reversed(lines):
            if any(token in line.lower() for token in ("失败", "错误", "error", "eperm", "timeout", "403")):
                return line.strip()[:250]
    return error
