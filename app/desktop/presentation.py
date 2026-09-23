"""Presentation rules only; never infer processing success from a log line."""
import re


def work_caption(title, video_id=""):
    title = str(title or "").strip()
    main = title.split("#", 1)[0].strip()
    tags = re.findall(r"#([^#\s]+)", title)
    caption = main or title or "未命名作品"
    note = " · ".join(tags[:3]) or ("抖音作品 · " + str(video_id))
    return caption, note


def progress_caption(job):
    kind = job.get("kind", "")
    raw = str(job.get("message") or ((job.get("logs") or [""])[-1]))
    counts = re.search(r"(?:\[知识总结\s*|\[)(\d+)\s*/\s*(\d+)", raw)
    prefix = f"第 {counts[1]} / {counts[2]} 项 · " if counts else ""
    if kind == "login":
        return "请在验证窗口完成登录，然后点击“已完成，保存登录”；不想继续可取消。"
    if kind == "download":
        if any(word in raw.lower() for word in ("transcrib", "转写", "whisper")):
            return prefix + "正在本机将语音转成文字，耗时取决于视频长度和电脑性能。"
        return prefix + "正在后台获取所选视频。可查看其他页面，无需操作浏览器。"
    if kind == "summarize":
        return prefix + "正在本机提炼知识并核对原文引用，请稍候。"
    return {
        "discover": "正在后台搜索相关内容并核对博主信息，完成后显示候选列表。",
        "prepare": "正在后台整理博主作品，完成后由你决定下载哪些。",
        "reset": "正在整理本次工作区，已保存的资料会保留。",
        "import-history": "正在登记已有资料，不会重新下载或调用模型。",
    }.get(kind, "正在保存处理结果，请稍候。")
