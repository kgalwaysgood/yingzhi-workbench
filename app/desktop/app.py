"""Native Windows workbench for the existing local Douyin processing engine."""

import argparse
from datetime import datetime
import json
from pathlib import Path
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from urllib.parse import quote, urlencode

from client import LocalWorkbench
from errors import explain_error, job_failure_message
from presentation import progress_caption, work_caption


STEPS = ("学习目标", "选择博主", "挑选作品", "核对文字稿", "审核知识")
BG = "#f0f3ef"
INK = "#173b35"
MUTED = "#64746d"
ACCENT = "#246454"
WHITE = "#ffffff"
STEP_HINTS = ("从一个学习目标开始", "找到值得关注的讲解者", "只处理真正需要的内容", "先校对，再提炼", "把经验沉淀为自己的知识")


class WorkbenchApp(tk.Tk):
    def __init__(self, client=None):
        super().__init__()
        self.client = client or LocalWorkbench()
        self.title("影知工坊 | 本地知识工作台")
        self.geometry("1280x900")
        self.minsize(900, 620)
        self.configure(bg=BG)
        self.protocol("WM_DELETE_WINDOW", self.close)
        self.step = 0
        self.state_data = {}
        self.selected_creators = set()
        self.selected_works = set()
        self.selected_transcripts = set()
        self.busy = True
        self.job_id = None
        self.latest_job = {}
        self.retry_request = None
        self.needs_verification = False
        self.results = queue.Queue()
        self.notice = tk.StringVar(value="正在连接本地处理引擎…")
        self.task_title = tk.StringVar(value="准备中")
        self.task_meta = tk.StringVar(value="正在启动本地处理引擎")
        self.profile_input = tk.StringVar()
        self.topic_input = tk.StringVar()
        self.source_mode = tk.StringVar(value="topic")
        self.limit_input = tk.StringVar(value="20")
        self._layout()
        self.bind("<MouseWheel>", self._scroll_work_list)
        self._maximize_after_id = self.after(0, self._maximize_window)
        self._drain_after_id = self.after(50, self._drain_results)
        self._async(self.client.ensure_started, self._initial_state)

    def _maximize_window(self):
        self._maximize_after_id = None
        try:
            self.state("zoomed")
        except tk.TclError:
            pass

    def _layout(self):
        shell = tk.Frame(self, bg=BG)
        shell.pack(fill="both", expand=True, padx=16, pady=14)
        self.sidebar = tk.Frame(shell, bg=INK, width=192)
        self.sidebar.pack(side="left", fill="y")
        self.sidebar.pack_propagate(False)
        tk.Label(self.sidebar, text="影知工坊", font=("Microsoft YaHei UI", 21, "bold"),
                 bg=INK, fg=WHITE).pack(anchor="w", padx=24, pady=(30, 4))
        tk.Label(self.sidebar, text="从内容到可审核的知识", font=("Microsoft YaHei UI", 9),
                 bg=INK, fg="#b9d1c6").pack(anchor="w", padx=25, pady=(0, 30))
        self.step_buttons = []
        for index, name in enumerate(STEPS):
            button = tk.Button(self.sidebar, text=f"{index + 1:02d}   {name}",
                               font=("Microsoft YaHei UI", 11), anchor="w", relief="flat",
                               bd=0, padx=22, pady=13, command=lambda n=index: self.show_step(n))
            button.pack(fill="x", padx=10, pady=3)
            self.step_buttons.append(button)
        tk.Label(self.sidebar, text="处理数据仅保存在 D 盘", bg=INK, fg="#b9d1c6",
                 font=("Microsoft YaHei UI", 9)).pack(side="bottom", anchor="w", padx=20, pady=26)

        right = tk.Frame(shell, bg=BG)
        right.pack(side="left", fill="both", expand=True, padx=(18, 0))
        self.header = tk.Frame(right, bg=BG)
        self.header.pack(fill="x", pady=(4, 12))
        self.heading = tk.Label(self.header, text="", bg=BG, fg=INK,
                                font=("Microsoft YaHei UI", 23, "bold"))
        self.heading.pack(side="left")
        self.reset_button = tk.Button(self.header, text="新任务", command=self._new_task,
                                      bg="#e7ede8", fg=INK, relief="flat", padx=12, pady=6)
        self.reset_button.pack(side="right", padx=12)
        self.library_button = tk.Button(self.header, text="资料库 / 回收站", command=self._open_library,
                                        bg="#e7ede8", fg=INK, relief="flat", padx=12, pady=6)
        self.library_button.pack(side="right")
        subheader = tk.Frame(right, bg=BG)
        subheader.pack(fill="x", pady=(0, 12))
        self.step_hint = tk.Label(subheader, bg=BG, fg=MUTED, font=("Microsoft YaHei UI", 10))
        self.step_hint.pack(side="left")
        self.readiness = tk.Label(subheader, bg=BG, fg=MUTED, font=("Microsoft YaHei UI", 9))
        self.readiness.pack(side="right")
        self.account_button = tk.Button(self.header, text="账号与验证", command=self._open_account,
                                        bg=BG, fg=INK, relief="flat", padx=12, pady=6)
        self.account_button.pack(side="right", padx=8)
        self.card = tk.Frame(right, bg=WHITE, highlightbackground="#deded3", highlightthickness=1)
        self.card.pack(fill="both", expand=True)
        footer = tk.Frame(right, bg="#e9eee7", highlightbackground="#d5ddd4", highlightthickness=1)
        footer.pack(fill="x", pady=(12, 0))
        task_head = tk.Frame(footer, bg="#e9eee7")
        task_head.pack(fill="x", padx=14, pady=(10, 2))
        tk.Button(task_head, text="任务详情", command=self._show_task_details, relief="flat", bg="#e9eee7", fg=INK).pack(side="right", padx=(12, 0))
        tk.Label(task_head, textvariable=self.task_title, bg="#e9eee7", fg=INK,
                 font=("Microsoft YaHei UI", 10, "bold")).pack(side="left")
        tk.Label(task_head, textvariable=self.task_meta, bg="#e9eee7", fg=MUTED,
                 font=("Microsoft YaHei UI", 9)).pack(side="right")
        tk.Label(footer, textvariable=self.notice, bg="#e9eee7", fg=INK,
                 font=("Microsoft YaHei UI", 10), wraplength=940, justify="left", anchor="w").pack(fill="x", padx=14, pady=3)
        self.auth_actions = tk.Frame(footer, bg="#e9eee7")
        self.verify_button = tk.Button(self.auth_actions, text="打开验证窗口并重试", command=self._verify_retry,
                                       bg=ACCENT, fg=WHITE, relief="flat", padx=12, pady=5)
        self.login_save_button = tk.Button(self.auth_actions, text="已完成，保存登录", command=lambda: self._confirm_account("save"),
                                           bg=ACCENT, fg=WHITE, relief="flat", padx=12, pady=5)
        self.login_cancel_button = tk.Button(self.auth_actions, text="取消验证", command=lambda: self._confirm_account("cancel"),
                                             bg="#e7ede8", fg=INK, relief="flat", padx=12, pady=5)
        self.progress = ttk.Progressbar(footer, mode="determinate", maximum=100)
        self.progress.pack(fill="x", padx=14, pady=(7, 11))
        self.progress["value"] = 0
        self.show_step(0)

    def _async(self, operation, done=None):
        def worker():
            try:
                result = operation()
            except Exception as error:
                self.results.put((self._failed, str(error)))
            else:
                if done:
                    self.results.put((done, result))
        threading.Thread(target=worker, daemon=True).start()

    def _drain_results(self):
        while True:
            try:
                callback, value = self.results.get_nowait()
            except queue.Empty:
                break
            callback(value)
        self._drain_after_id = self.after(50, self._drain_results)

    def destroy(self):
        maximize_after_id = getattr(self, "_maximize_after_id", None)
        if maximize_after_id:
            try:
                self.after_cancel(maximize_after_id)
            except tk.TclError:
                pass
            self._maximize_after_id = None
        after_id = getattr(self, "_drain_after_id", None)
        if after_id:
            try:
                self.after_cancel(after_id)
            except tk.TclError:
                pass
            self._drain_after_id = None
        super().destroy()

    def _initial_state(self, data):
        self.busy = False
        self.state_data = data
        self._reconcile_selections()
        creators = (data.get("discovery") or {}).get("creators") or []
        self.task_title.set("工作台已就绪")
        self.task_meta.set("可开始操作")
        self.progress["value"] = 0
        self.notice.set(f"已保留 {len(creators)} 位候选博主，可直接进入第二步继续。" if creators else
                        "本地处理引擎已连接。请选择学习主题或粘贴博主主页。")
        self.show_step(self.step)
        if data.get("activeJob"):
            self.job_id = data["activeJob"]
            self.busy = True
            self._poll_job()

    def _failed(self, message):
        self.busy = False
        issue = explain_error(message)
        self.progress["value"] = 0
        self.task_title.set("本步骤未完成")
        self.task_meta.set(issue.code)
        self.notice.set(f"{issue.title}（{issue.code}）：{issue.action}")
        self.needs_verification = issue.code in ("DOUYIN-001", "DOUYIN-002", "DOUYIN-003", "DOUYIN-004", "AUTH-001")
        if issue.code == "AUTH-001":
            self.retry_request = None
        if not self.needs_verification:
            messagebox.showerror(issue.title, issue.format(), parent=self)
        self.show_step(self.step)

    def _new_task(self):
        if self.busy:
            return
        if not messagebox.askyesno("开始新任务", "清空本次操作区并返回第一步。已保存的视频和知识文件继续保留。", parent=self):
            return
        self.topic_input.set("")
        self.profile_input.set("")
        self._start_job("api/reset", {}, "正在开始新任务", 0)

    def _open_account(self):
        if self.busy:
            return
        if messagebox.askyesno("登录与安全验证", "仅本次打开抖音登录窗口。完成后回到这里点击“已完成，保存登录”。平时搜索在后台进行。", parent=self):
            self._start_job("api/login", {}, "等待你完成登录", self.step)

    def _verify_retry(self):
        if self.busy:
            return
        if not self.retry_request:
            return self._open_account()
        if not messagebox.askyesno("打开验证窗口", "本次操作需要人工登录或验证码。是否打开抖音验证窗口并重试？后续搜索仍默认后台运行。", parent=self):
            return
        route, payload, title, next_step = self.retry_request
        self._start_job(route, {**payload, "interactive": True}, title, next_step)

    def _confirm_account(self, action):
        if not self.busy or self.latest_job.get("kind") != "login" or not self.job_id:
            return
        self.login_save_button.configure(state="disabled")
        self.login_cancel_button.configure(state="disabled")
        origin_job = self.job_id
        def send():
            try:
                return self.client.post_json("api/login/confirm", {"action": action})
            except Exception as error:
                return {"confirmationError": str(error)}
        def done(result):
            if self.job_id != origin_job or not self.busy or self.latest_job.get("status") != "running":
                return
            if result.get("confirmationError"):
                self.notice.set("登录尚未保存：" + result["confirmationError"])
            else:
                self.notice.set("正在保存登录信息…" if action == "save" else "正在取消验证，保留原有登录信息…")
            self._auth_controls()
        self._async(send, done)

    def _auth_controls(self):
        for button in (self.verify_button, self.login_save_button, self.login_cancel_button):
            button.pack_forget()
        login_pending = self.busy and self.job_id and self.latest_job.get("kind") == "login" and self.latest_job.get("status") == "running" and self.latest_job.get("awaitingConfirmation")
        if login_pending:
            for button in (self.login_save_button, self.login_cancel_button):
                button.configure(state="normal")
                button.pack(side="left", padx=(0, 8))
        elif self.needs_verification and not self.busy:
            self.verify_button.pack(side="left")
        else:
            self.auth_actions.pack_forget()
            return
        self.auth_actions.pack(fill="x", padx=14, pady=5, before=self.progress)

    def _show_task_details(self):
        popup = tk.Toplevel(self)
        popup.title("任务详情 · 诊断日志")
        popup.geometry("850x500")
        tk.Label(popup, text="以下为本次任务的技术日志，日常操作无需阅读。", anchor="w").pack(fill="x", padx=16, pady=10)
        logs = tk.Text(popup, wrap="word", font=("Consolas", 10))
        logs.pack(fill="both", expand=True, padx=16, pady=(0, 16))
        entries = self.latest_job.get("logs") or []
        logs.insert("1.0", "\n".join(str(line) for line in entries) or "暂无任务日志。")
        logs.configure(state="disabled")

    def _refresh(self, next_step=None):
        def done(data):
            self.state_data = data
            self._reconcile_selections()
            self.busy = False
            self.progress["value"] = 100
            self.task_title.set("本步骤已完成")
            self.task_meta.set("结果已刷新")
            self.show_step(self.step if next_step is None else next_step)
        self._async(self.client.get_state, done)

    def _reconcile_selections(self):
        creators = (self.state_data.get("discovery") or {}).get("creators") or []
        works = (self.state_data.get("prepared") or {}).get("works") or []
        results = (self.state_data.get("batch") or {}).get("results") or []
        self.selected_creators.intersection_update(item.get("profileUrl") for item in creators)
        self.selected_works.intersection_update(item.get("url") for item in works)
        self.selected_transcripts.intersection_update(
            str(item.get("videoId")) for item in results
            if item.get("status") == "completed" and item.get("hasTranscript")
        )

    def _sync_state(self, data):
        self.state_data = data
        self._reconcile_selections()
        self.show_step(self.step)

    def _start_job(self, route, payload, title, next_step=None):
        if self.busy:
            return
        self.busy = True
        if route in ("api/discover", "api/prepare", "api/download"):
            self.retry_request = (route, {k: v for k, v in payload.items() if k != "interactive"}, title, next_step)
        self.needs_verification = False
        self.latest_job = {"kind": route.split("/")[-1], "status": "running", "logs": []}
        self.job_started_at = datetime.now()
        self.task_title.set(title)
        self.task_meta.set("启动中")
        self.notice.set(progress_caption(self.latest_job))
        self.progress["value"] = 2
        self.show_step(self.step)
        self._async(lambda: self.client.start_job(route, payload),
                    lambda job_id: self._job_started(job_id, next_step))

    def _job_started(self, job_id, next_step):
        self.job_id = job_id
        self.job_next_step = next_step
        self._poll_job()

    def _poll_job(self):
        if not self.job_id:
            return
        origin_job = self.job_id
        def read():
            try:
                return {"job": self.client.get_json("api/jobs/" + origin_job)}
            except Exception as error:
                return {"pollError": str(error)}
        def done(result):
            if self.job_id != origin_job:
                return
            if "pollError" in result:
                self.notice.set("暂时无法读取任务进度，正在重新连接；任务未取消，请勿重复提交。")
                self.task_meta.set("连接恢复中")
                self.after(1500, self._poll_job)
                return
            self._job_update(result["job"])
        self._async(read, done)

    def _job_update(self, job):
        self.latest_job = job
        self._auth_controls()
        if job.get("status") == "running":
            self.notice.set(progress_caption(job))
            self.progress["value"] = int(job.get("progress") or 2)
            started = getattr(self, "job_started_at", datetime.now())
            elapsed = max(0, int((datetime.now() - started).total_seconds()))
            phase = f"阶段 {job.get('phase')}/{job.get('phaseTotal')} · " if job.get("phaseTotal") else ""
            self.task_meta.set(f"{phase}已用时 {elapsed // 60:02d}:{elapsed % 60:02d}")
            self.after(500, self._poll_job)
            return
        self.job_id = None
        if job.get("kind") == "login" and job.get("status") == "completed":
            result = job.get("result") or {}
            saved = result.get("loggedIn") is True
            titles = {"cancel": "已取消登录", "closed": "验证窗口已关闭", "timeout": "验证已超时", "save-failed": "登录未保存"}
            self.busy = False
            self.progress["value"] = 100 if saved else 0
            self.task_title.set("登录信息已保存" if saved else titles.get(result.get("reason"), "登录未保存"))
            self.task_meta.set("可继续搜索" if saved else "原登录信息保留")
            self.notice.set("下次搜索默认在后台运行。" if saved else "本次未更新登录信息，需要时可再次点击“账号与验证”。")
            self.show_step(self.step)
            self._async(self.client.get_state, self._sync_state)
            return
        if job.get("status") == "failed":
            self._failed(job_failure_message(job))
            def refreshed(data):
                self.state_data = data
                self._reconcile_selections()
                self.show_step(self.step)
            self._async(self.client.get_state, refreshed)
            return
        self.notice.set("本步骤已完成。请核对结果后继续。")
        self.progress["value"] = 100
        self.task_title.set("本步骤已完成")
        self.task_meta.set("结果已保存")
        self._refresh(getattr(self, "job_next_step", None))

    def show_step(self, index):
        self.step = index
        if hasattr(self, "reset_button"):
            self.reset_button.configure(state="disabled" if self.busy else "normal")
        self.heading.configure(text=STEPS[index])
        self.step_hint.configure(text=f"步骤 {index + 1} / 5   ·   {STEP_HINTS[index]}")
        ready = self.state_data.get("ready", {})
        self.readiness.configure(text=("登录信息已保存" if ready.get("cookies") else "尚未登录") + "   ·   " +
                                 ("本地模型已安装" if ready.get("summaryModel") else "总结模型待安装"))
        self.account_button.configure(state="disabled" if self.busy else "normal")
        self._auth_controls()
        for number, button in enumerate(self.step_buttons):
            button.configure(bg="#315950" if number == index else INK,
                             fg=WHITE if number == index else "#b9d1c6",
                             activebackground="#315950", activeforeground=WHITE)
        for child in self.card.winfo_children():
            child.destroy()
        self.content = tk.Frame(self.card, bg=WHITE)
        self.content.pack(fill="both", expand=True, padx=22, pady=14)
        (self._source, self._creators, self._works, self._transcripts, self._knowledge)[index]()

    def _label(self, text, size=10, color=INK, weight="normal"):
        label = tk.Label(self.content, text=text, font=("Microsoft YaHei UI", size, weight),
                         bg=WHITE, fg=color, justify="left", anchor="w", wraplength=750)
        label.pack(fill="x", pady=(0, 12))
        return label

    def _button(self, text, command, primary=False, enabled=True):
        button = tk.Button(self.content, text=text, command=command, state="normal" if enabled else "disabled",
                           font=("Microsoft YaHei UI", 10, "bold"),
                           bg=ACCENT if primary else "#e7ede8", fg=WHITE if primary else INK,
                           activebackground="#1c5145" if primary else "#d2dfd5", relief="flat",
                           padx=17, pady=10, cursor="hand2" if enabled else "arrow")
        button.pack(anchor="w", pady=(2, 12))
        return button

    def _toolbar_button(self, parent, text, command, primary=False, enabled=True):
        button = tk.Button(parent, text=text, command=command, state="normal" if enabled else "disabled",
                           font=("Microsoft YaHei UI", 10 if primary else 9, "bold"),
                           bg=ACCENT if primary else "#e7ede8", fg=WHITE if primary else INK,
                           activebackground="#1c5145" if primary else "#d2dfd5", relief="flat",
                           padx=13, pady=7, cursor="hand2" if enabled else "arrow")
        button.pack(side="left", padx=(0, 8))
        return button

    def _entry(self, variable, width=76):
        entry = tk.Entry(self.content, textvariable=variable, font=("Microsoft YaHei UI", 11),
                         bg="#f8f9f5", fg=INK, relief="solid", bd=1, width=width)
        entry.pack(fill="x", ipady=9, pady=(0, 13))
        return entry

    def _more_menu(self, parent, actions):
        button = tk.Menubutton(parent, text="更多操作 ▾", font=("Microsoft YaHei UI", 9),
                               bg=WHITE, fg=INK, relief="flat", padx=10, pady=7,
                               state="disabled" if self.busy else "normal")
        menu = tk.Menu(button, tearoff=False, font=("Microsoft YaHei UI", 10))
        for label, action, enabled in actions:
            menu.add_command(label=label, command=action, state="normal" if enabled and not self.busy else "disabled")
        button.configure(menu=menu)
        button.pack(side="left")
        return menu

    def _list(self):
        outer = tk.Frame(self.content, bg=WHITE)
        outer.pack(fill="both", expand=True, pady=(2, 6))
        canvas = tk.Canvas(outer, bg=WHITE, highlightthickness=0)
        self.list_canvas = canvas
        scrollbar = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        body = tk.Frame(canvas, bg=WHITE)
        body.bind("<Configure>", lambda _: canvas.configure(scrollregion=canvas.bbox("all")))
        window = canvas.create_window((0, 0), window=body, anchor="nw")
        canvas.bind("<Configure>", lambda event: canvas.itemconfigure(window, width=event.width))
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        return body

    def _scroll_work_list(self, event):
        canvas = getattr(self, "list_canvas", None)
        if not canvas or not canvas.winfo_exists() or not event.delta:
            return
        hovered = self.winfo_containing(event.x_root, event.y_root)
        while hovered is not None:
            if hovered == canvas:
                canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")
                return "break"
            hovered = getattr(hovered, "master", None)

    def _row(self, body, title, note, value=None, selected=None, enabled=True, open_action=None,
             on_change=None, open_label="编辑名称", number=None):
        card = tk.Frame(body, bg="#f8f9f5", highlightbackground="#e0e7de", highlightthickness=1)
        card.pack(fill="x", pady=(0, 4), padx=(0, 7))
        card.sequence_number = number
        number_label = None
        if number is not None:
            number_label = tk.Label(card, text=f"{number:02d}", width=3, bg="#eef2ed", fg="#36564a",
                                    font=("Microsoft YaHei UI", 10, "bold"), anchor="center")
            number_label.pack(side="left", fill="y", padx=(0, 4))
        variable = None
        if value is not None and selected is not None:
            variable = tk.BooleanVar(value=value in selected)
            card.selection_var = variable
            def toggle():
                if variable.get():
                    selected.add(value)
                else:
                    selected.discard(value)
                if on_change:
                    on_change()
            selector = tk.Checkbutton(card, variable=variable, command=toggle, bg="#f8f9f5", fg=INK,
                                      font=("Microsoft YaHei UI", 9, "bold"), selectcolor="#dcebdd",
                                      activebackground="#f8f9f5", state="normal" if enabled and not self.busy else "disabled")
            selector.pack(side="left", padx=(8, 5), pady=2)
        if open_action:
            tk.Button(card, text=open_label, command=open_action, bg="#e7ede8", fg=INK,
                      font=("Microsoft YaHei UI", 9), relief="flat", padx=10).pack(side="right", padx=10)
        middle = tk.Frame(card, bg="#f8f9f5")
        middle.pack(side="left", fill="x", expand=True, padx=6, pady=3)
        title_label = tk.Label(middle, text=title, bg="#f8f9f5", fg=INK,
                               font=("Microsoft YaHei UI", 11, "bold"), anchor="w")
        title_label.pack(fill="x")
        note_label = tk.Label(middle, text=note, bg="#f8f9f5", fg=MUTED,
                              font=("Microsoft YaHei UI", 9), anchor="w")
        note_label.pack(fill="x")
        from tkinter import font as tkfont
        def fit(label, full_text, width):
            font = tkfont.Font(font=label.cget("font"))
            if font.measure(full_text) <= width:
                label.configure(text=full_text)
                return
            low, high = 0, len(full_text)
            while low < high:
                mid = (low + high + 1) // 2
                if font.measure(full_text[:mid] + "…") <= width:
                    low = mid
                else:
                    high = mid - 1
            label.configure(text=full_text[:low] + "…")
        middle.bind("<Configure>", lambda event: (fit(title_label, title, max(20, event.width)), fit(note_label, note, max(20, event.width))))
        if variable is not None:
            def paint(*_):
                color = "#e7f0ea" if variable.get() else "#f8f9f5"
                for widget in (card, selector, middle, title_label, note_label):
                    widget.configure(bg=color)
                if number_label is not None:
                    number_label.configure(bg="#d5e6da" if variable.get() else "#eef2ed")
                card.configure(highlightbackground="#72a28c" if variable.get() else "#e0e7de")
            trace_id = variable.trace_add("write", paint)
            def remove_trace(event):
                if event.widget == card:
                    variable.trace_remove("write", trace_id)
            card.bind("<Destroy>", remove_trace)
            def click(_):
                if enabled and not self.busy:
                    variable.set(not variable.get())
                    toggle()
            for widget in (card, number_label, middle, title_label, note_label):
                if widget is None:
                    continue
                widget.bind("<Button-1>", click)
                widget.configure(cursor="hand2" if enabled and not self.busy else "arrow")
            paint()
        return variable

    def _source(self):
        self._label("今天想学什么？", 18, weight="bold")
        self._label("先找到内容，再由你决定下载哪些作品。搜索默认后台运行，不打断当前窗口。", 11, MUTED)
        modes = tk.Frame(self.content, bg=WHITE)
        modes.pack(fill="x", pady=(4, 22))
        for value, label in (("topic", "按学习目标发现"), ("link", "我已有博主链接")):
            tk.Radiobutton(modes, text=label, variable=self.source_mode, value=value, indicatoron=False,
                           font=("Microsoft YaHei UI", 11), bg="#f0f3ef", fg=INK, selectcolor="#d7e9dd",
                           relief="flat", bd=0, padx=20, pady=10, state="disabled" if self.busy else "normal",
                           command=lambda: self.show_step(0)).pack(side="left", padx=(0, 8))
        if self.source_mode.get() == "topic":
            self._label("描述你想理解的业务或问题", 11, weight="bold")
            self._entry(self.topic_input)
            self._label("例如：ERP 订单如何流转到 MES 工单，再到完工入库与客户交付", 10, MUTED)
        else:
            self._label("粘贴博主主页链接或抖音分享文字", 11, weight="bold")
            self._entry(self.profile_input)
            self._label("保留完整分享文字即可，工具会提取其中的主页链接。", 10, MUTED)
        options = tk.Frame(self.content, bg=WHITE)
        options.pack(fill="x", pady=(4, 20))
        tk.Label(options, text="每位博主最多列出", font=("Microsoft YaHei UI", 10), bg=WHITE, fg=MUTED).pack(side="left")
        tk.Spinbox(options, from_=1, to=100, textvariable=self.limit_input, width=5, font=("Microsoft YaHei UI", 11),
                   state="disabled" if self.busy else "normal").pack(side="left", padx=10)
        tk.Label(options, text="条作品 · 后续仍可挑选，不会自动下载", font=("Microsoft YaHei UI", 10), bg=WHITE, fg=MUTED).pack(side="left")
        if self.source_mode.get() == "topic":
            self._button("发现相关博主", self._discover, primary=True, enabled=not self.busy)
        else:
            self._button("获取作品列表", self._prepare_manual, primary=True, enabled=not self.busy)
        creators = (self.state_data.get("discovery") or {}).get("creators") or []
        if creators:
            self._button(f"查看已有结果（{len(creators)} 位博主）", lambda: self.show_step(1), enabled=not self.busy)
        if not self.state_data.get("ready", {}).get("cookies"):
            self._label("未检测到抖音登录信息。登录时可打开抖音验证窗口，但本工具界面始终是桌面窗口。", 9, MUTED)
            self._button("登录抖音", self._open_account, enabled=not self.busy)

    def _discover(self):
        topic = self.topic_input.get().strip()
        if not 4 <= len(topic) <= 160:
            return self._failed("学习主题请输入 4 到 160 字")
        self._start_job("api/discover", {"topic": topic}, "正在筛选博主", 1)

    def _prepare_manual(self):
        profile = self.profile_input.get().strip()
        if not profile:
            return self._failed("请先粘贴博主主页链接")
        self._prepare([profile], 2)

    def _prepare(self, profiles, next_step):
        try:
            limit = int(self.limit_input.get())
        except ValueError:
            return self._failed("作品数量须为 1 到 100 的整数")
        if not 1 <= limit <= 100:
            return self._failed("作品数量须为 1 到 100 的整数")
        self._start_job("api/prepare", {"profileUrls": profiles, "limit": limit}, "正在列出作品", next_step)

    def _creators(self):
        self._label("根据主页及代表作品核对候选博主；发现结果不是自动背书。", 11)
        creators = (self.state_data.get("discovery") or {}).get("creators") or []
        available = [item.get("profileUrl") for item in creators if item.get("profileUrl")]
        self.creator_selection_vars = {}
        toolbar = tk.Frame(self.content, bg=WHITE)
        toolbar.pack(fill="x", pady=(0, 8))
        self.creator_count = tk.Label(self.content, text="尚未选择博主", bg=WHITE, fg=MUTED,
                                      font=("Microsoft YaHei UI", 9))
        self.creator_count.pack(anchor="w", pady=(0, 6))
        def selection_changed():
            count = len(self.selected_creators)
            self.creator_count.configure(text=f"已选择 {count} 位博主" if count else "尚未选择博主")
            active = bool(count) and not self.busy
            self.creator_action.configure(state="normal" if active else "disabled",
                                          cursor="hand2" if active else "arrow")
            self.creator_clear.configure(state="normal" if active else "disabled",
                                         cursor="hand2" if active else "arrow")
        self.creator_action = self._toolbar_button(toolbar, "列出作品",
                                                   lambda: self._prepare(list(self.selected_creators), 2),
                                                   primary=True, enabled=not self.busy and bool(self.selected_creators))
        self.creator_select_all = self._toolbar_button(
            toolbar, f"全选（{len(available)}）",
            lambda: self._set_selection(self.selected_creators, available, self.creator_selection_vars,
                                        selection_changed, "博主"),
            enabled=not self.busy and bool(available))
        self.creator_clear = self._toolbar_button(
            toolbar, "取消全选",
            lambda: self._set_selection(self.selected_creators, [], self.creator_selection_vars,
                                        selection_changed, "博主"),
            enabled=not self.busy and bool(self.selected_creators))
        self.creator_menu = self._more_menu(toolbar, [
            ("新增博主", lambda: self._list_editor("creators"), True),
            ("移出所选", lambda: self._remove_items("creators", self.selected_creators), bool(creators)),
            ("清空列表", self._clear_creator_list, bool(creators)),
        ])
        body = self._list()
        for number, item in enumerate(creators, start=1):
            url = item.get("profileUrl")
            variable = self._row(body, item.get("author") or "作者待核对", item.get("reason") or url or "无主页链接",
                                  url, self.selected_creators, enabled=bool(url), on_change=selection_changed,
                                  open_action=lambda row=item: self._list_editor("creators", row), number=number)
            if url and variable is not None:
                self.creator_selection_vars[url] = variable
        selection_changed()
        if not creators:
            self._label("尚无候选博主。返回第一步输入学习主题，或直接粘贴博主链接。", 9, MUTED)

    def _clear_creator_list(self):
        if self.busy:
            return
        if not messagebox.askyesno(
                "确认清空候选博主",
                "将清空本次全部步骤的操作区，并删除本地候选报告。\n\n"
                "不会删除已下载视频、文字稿、知识总结或本地模型。是否继续？",
                parent=self):
            return
        self._start_job("api/clear-discovery", {}, "正在清空候选博主列表", 1)

    def _works(self):
        self._label("只下载你勾选的作品；下载后会在本机逐条转写。", 11)
        works = (self.state_data.get("prepared") or {}).get("works") or []
        available = [item.get("url") for item in works if item.get("url")]
        self.work_selection_vars = {}
        toolbar = tk.Frame(self.content, bg=WHITE)
        toolbar.pack(fill="x", pady=(0, 8))
        self.work_count = tk.Label(self.content, text="尚未选择作品", bg=WHITE, fg=MUTED,
                                   font=("Microsoft YaHei UI", 9))
        self.work_count.pack(anchor="w", pady=(0, 6))
        def selection_changed():
            count = len(self.selected_works)
            self.work_count.configure(text=f"已选择 {count} 条作品" if count else "尚未选择作品")
            active = bool(count) and not self.busy
            self.work_action.configure(state="normal" if active else "disabled",
                                       cursor="hand2" if active else "arrow")
            self.work_clear.configure(state="normal" if active else "disabled",
                                      cursor="hand2" if active else "arrow")
        self.work_action = self._toolbar_button(toolbar, "下载并转写", self._download, primary=True,
                                                enabled=not self.busy and bool(self.selected_works))
        self.work_select_all = self._toolbar_button(
            toolbar, f"全选（{len(available)}）",
            lambda: self._set_selection(self.selected_works, available, self.work_selection_vars,
                                        selection_changed, "作品"),
            enabled=not self.busy and bool(available))
        self.work_clear = self._toolbar_button(
            toolbar, "取消全选",
            lambda: self._set_selection(self.selected_works, [], self.work_selection_vars,
                                        selection_changed, "作品"),
            enabled=not self.busy and bool(self.selected_works))
        self.work_menu = self._more_menu(toolbar, [
            ("新增作品链接", lambda: self._list_editor("works"), True),
            ("移出所选", lambda: self._remove_items("works", self.selected_works), bool(works)),
            ("清空列表", lambda: self._remove_items("works", available), bool(works)),
        ])
        body = self._list()
        for number, item in enumerate(works, start=1):
            url = item.get("url")
            title, note = work_caption(item.get("title"), item.get("videoId", ""))
            variable = self._row(body, title, note if url else "链接缺失", url, self.selected_works,
                                  enabled=bool(url), on_change=selection_changed,
                                  open_action=lambda row=item: self._list_editor("works", row), number=number)
            if url and variable is not None:
                self.work_selection_vars[url] = variable
        selection_changed()
        if not works:
            self._label("尚无作品。请先选择博主或输入主页链接。", 9, MUTED)

    def _download(self):
        if not self.selected_works:
            return self._failed("至少选择一条作品")
        if not messagebox.askyesno("确认下载", f"将下载并在本地转写 {len(self.selected_works)} 条作品。继续吗？", parent=self):
            return
        self._start_job("api/download", {"urls": list(self.selected_works)}, "下载与本地转写", 3)

    def _transcripts(self):
        self._label("先阅读机器文字稿，核对专有名词和遗漏，再决定哪些值得提炼。", 11)
        ready = self.state_data.get("ready", {}).get("summaryModel")
        rows = (self.state_data.get("batch") or {}).get("results") or []
        available = [str(row.get("videoId")) for row in rows
                     if row.get("status") == "completed" and row.get("hasTranscript")]
        self.transcript_selection_vars = {}
        toolbar = tk.Frame(self.content, bg=WHITE)
        toolbar.pack(fill="x", pady=(0, 8))
        self.transcript_count = tk.Label(self.content, text="尚未选择文字稿", bg=WHITE, fg=MUTED,
                                         font=("Microsoft YaHei UI", 9))
        self.transcript_count.pack(anchor="w", pady=(0, 6))
        def selection_changed():
            count = len(self.selected_transcripts)
            self.transcript_count.configure(text=f"已选择 {count} 份文字稿" if count else "尚未选择文字稿")
            active = bool(count) and not self.busy and ready
            self.transcript_action.configure(state="normal" if active else "disabled",
                                             cursor="hand2" if active else "arrow")
            can_clear = bool(count) and not self.busy
            self.transcript_clear.configure(state="normal" if can_clear else "disabled",
                                            cursor="hand2" if can_clear else "arrow")
        self.transcript_action = self._toolbar_button(toolbar, "生成知识草稿", self._summarize,
                                                      primary=True,
                                                      enabled=not self.busy and bool(self.selected_transcripts) and bool(ready))
        self.transcript_select_all = self._toolbar_button(
            toolbar, f"全选（{len(available)}）",
            lambda: self._set_selection(self.selected_transcripts, available, self.transcript_selection_vars,
                                        selection_changed, "文字稿"),
            enabled=not self.busy and bool(available))
        self.transcript_clear = self._toolbar_button(
            toolbar, "取消全选",
            lambda: self._set_selection(self.selected_transcripts, [], self.transcript_selection_vars,
                                        selection_changed, "文字稿"),
            enabled=not self.busy and bool(self.selected_transcripts))
        self._more_menu(toolbar, [("移出所选", lambda: self._remove_items("transcripts", self.selected_transcripts), bool(rows))])
        if not ready:
            self._label("本地总结模型未就绪，请先完成模型安装。当前仍可查看文字稿。", 9, MUTED)
        body = self._list()
        for number, row in enumerate(rows, start=1):
            video_id = str(row.get("videoId") or "")
            allowed = row.get("status") == "completed" and row.get("hasTranscript")
            variable = self._row(
                body, work_caption(row.get("title"), video_id)[0],
                ("已转写" if allowed else row.get("lastUserMessage") or row.get("status") or "未完成") + " · " + video_id,
                video_id, self.selected_transcripts, enabled=bool(allowed),
                open_action=(lambda n=video_id: self._edit_resource("transcript:" + n)) if allowed and row.get("jsonPath") else None,
                on_change=selection_changed, open_label="校对文字", number=number)
            if allowed and variable is not None:
                self.transcript_selection_vars[video_id] = variable
        selection_changed()
        if not rows:
            self._label("尚无下载和转写结果。", 9, MUTED)

    def _summarize(self):
        if not self.selected_transcripts:
            return self._failed("至少选择一份已完成的文字稿")
        self._start_job("api/summarize", {"videoIds": list(self.selected_transcripts)}, "本地知识提炼", 4)

    def _set_selection(self, target, values, variables, on_change, noun):
        target.clear()
        target.update(value for value in values if value)
        for value, variable in variables.items():
            variable.set(value in target)
        on_change()
        count = len(target)
        self.notice.set(f"已选择 {count} 个{noun}。" if count else f"已取消全部{noun}选择。")
        self.update_idletasks()

    def _knowledge(self):
        self._label("模型输出是草稿，不等于事实已核验；请对照原视频及文字稿人工审核。", 11)
        items = self.state_data.get("knowledgeItems") or []
        self._button("清空本次结果", lambda: self._remove_items("knowledge", [str(item.get("videoId")) for item in items]),
                     enabled=not self.busy and bool(items))
        body = self._list()
        for number, item in enumerate(items, start=1):
            video_id = str(item.get("videoId"))
            self._row(body, item.get("title") or video_id,
                      (item.get("topic") or "未分类") + " · " + item.get("reviewStatus", "待审核"),
                      open_action=lambda n=video_id: self._edit_resource("knowledge:" + n),
                      open_label="审核编辑", number=number)
        if not items:
            self._label("尚无可审核知识草稿；请先完成转写与本地总结。", 9, MUTED)

    def _remove_items(self, kind, ids):
        if self.busy:
            return
        values = list(ids)
        if not values:
            return self._failed("请先选择需要移出的条目")
        if messagebox.askyesno("移出本次列表", f"从本次列表移出 {len(values)} 项？已保存的资料不删除，可在资料库中管理。", parent=self):
            self._start_job("api/list/remove", {"kind": kind, "ids": values}, "正在移出列表", self.step)

    def _list_editor(self, kind, row=None):
        if self.busy:
            return
        row = row or {}
        popup = tk.Toplevel(self)
        popup.title("新增 / 修改显示名称")
        popup.geometry("680x250")
        title = tk.StringVar(value=row.get("author") or row.get("title") or "")
        link = tk.StringVar(value=row.get("profileUrl") or row.get("url") or "")
        tk.Label(popup, text="显示名称（仅个人备注，不改变平台作者或作品）").pack(anchor="w", padx=16, pady=8)
        tk.Entry(popup, textvariable=title).pack(fill="x", padx=16)
        tk.Label(popup, text="抖音主页链接" if kind == "creators" else "抖音作品链接").pack(anchor="w", padx=16, pady=8)
        tk.Entry(popup, textvariable=link, state="readonly" if row else "normal").pack(fill="x", padx=16)
        def save():
            if self.busy:
                return
            if not title.get().strip() or not link.get().strip():
                messagebox.showerror("信息不完整", "名称和链接不能为空。", parent=popup)
                return
            self._start_job("api/list/upsert", {"kind": kind, "title": title.get(), "url": link.get()}, "正在保存列表", self.step)
        tk.Button(popup, text="保存", command=save).pack(pady=16)

    def _edit_resource(self, resource_id, on_saved=None):
        self._async(lambda: self.client.get_json("api/library/" + quote(resource_id, safe="")),
                    lambda record: self._resource_editor(record, on_saved))

    def _resource_editor(self, record=None, on_saved=None):
        record = dict(record or {})
        popup = tk.Toplevel(self)
        popup.title("编辑资料" if record else "新增知识笔记")
        popup.geometry("850x710")
        popup.configure(bg=BG)
        title = tk.StringVar(value=record.get("title", ""))
        review = tk.StringVar(value="已人工审核" if record.get("reviewStatus") == "reviewed" else "待审核")
        tk.Label(popup, text="标题", bg=BG, fg=INK).pack(anchor="w", padx=16, pady=(12, 4))
        tk.Entry(popup, textvariable=title, font=("Microsoft YaHei UI", 12)).pack(fill="x", padx=16)
        tk.Label(popup, text="来源（不可修改）：" + (record.get("sourceUrl") or record.get("sourceId") or "个人新增笔记"),
                 bg=BG, fg=MUTED, wraplength=790, anchor="w").pack(fill="x", padx=16, pady=8)
        tk.Label(popup, text="修改保存为管理副本，原始机器文件保留；再次生成不会覆盖本副本。文字稿修改用于后续总结。",
                 bg=BG, fg=MUTED, wraplength=790, anchor="w").pack(fill="x", padx=16)
        if record.get("sourceChanged"):
            tk.Label(popup, text="注意：来源文字稿已修改，本知识稿需要重新对照核查。", fg="#a94223", bg=BG).pack(fill="x")
        text = tk.Text(popup, wrap="word", font=("Microsoft YaHei UI", 11), undo=True, bg=WHITE, fg=INK)
        text.pack(fill="both", expand=True, padx=16, pady=10)
        text.insert("1.0", record.get("content", ""))
        controls = tk.Frame(popup, bg=BG)
        controls.pack(fill="x", padx=16, pady=(0, 12))
        review_box = ttk.Combobox(controls, textvariable=review, values=("待审核", "已人工审核"), state="readonly", width=13)
        review_box.pack(side="left")
        baseline = [title.get(), text.get("1.0", "end-1c"), review.get()]
        submitted = baseline.copy()
        saving = [False]
        popup.has_unsaved = lambda: baseline != [title.get(), text.get("1.0", "end-1c"), review.get()]
        popup.is_saving = lambda: saving[0]

        def close():
            if saving[0]:
                return
            changed = baseline != [title.get(), text.get("1.0", "end-1c"), review.get()]
            if not changed or messagebox.askyesno("尚未保存", "放弃本次未保存的修改？", parent=popup):
                popup.destroy()

        def saved(result):
            saving[0] = False
            if not popup.winfo_exists():
                return
            record.update(result)
            baseline[:] = submitted
            save_button.configure(state="normal")
            self.notice.set("资料已保存；原文件未改动，修改历史已保留。")
            if not self.busy:
                self._async(self.client.get_state, self._sync_state)
            if on_saved:
                on_saved()

        def save():
            if saving[0] or self.busy:
                return
            content = text.get("1.0", "end-1c")
            if not title.get().strip() or not content.strip():
                messagebox.showerror("内容不完整", "标题和正文不能为空。", parent=popup)
                return
            payload = {"title": title.get(), "content": content,
                       "reviewStatus": "reviewed" if review.get() == "已人工审核" else "pending"}
            route = "api/library/add"
            if record.get("id"):
                route = "api/library/change"
                payload.update(id=record["id"], revision=record["revision"], action="edit")
            saving[0] = True
            submitted[:] = [title.get(), content, review.get()]
            save_button.configure(state="disabled")
            def operation():
                try:
                    return {"record": self.client.post_json(route, payload)}
                except Exception as error:
                    return {"error": str(error)}
            def done(result):
                if not popup.winfo_exists():
                    return
                if result.get("error"):
                    saving[0] = False
                    save_button.configure(state="normal")
                    messagebox.showerror("未保存，修改仍在窗口中", result["error"], parent=popup)
                else:
                    saved(result["record"])
            self._async(operation, done)

        def export():
            target = filedialog.asksaveasfilename(parent=popup, initialdir=str(self.client.root / "data"),
                                                  defaultextension=".md", filetypes=[("Markdown", "*.md")])
            if not target:
                return
            if Path(target).drive.upper() != "D:":
                messagebox.showerror("保存位置不允许", "请选择 D 盘目录。", parent=popup)
                return
            try:
                Path(target).write_text(f"# {title.get()}\n\n管理状态：{review.get()}\n来源：{record.get('sourceUrl', '')}\n\n" + text.get("1.0", "end-1c"), encoding="utf-8")
            except OSError as error:
                messagebox.showerror("导出失败", str(error), parent=popup)

        save_button = tk.Button(controls, text="保存修改" if record else "保存笔记", command=save, bg=ACCENT, fg=WHITE)
        save_button.pack(side="left", padx=12)
        tk.Button(controls, text="导出当前内容 Markdown", command=export).pack(side="left")
        if record.get("latestGenerated"):
            def use_latest():
                if messagebox.askyesno("载入新生成稿", "用最新生成稿替换编辑框内容？点击保存后才会覆盖管理副本，旧版本仍保留。", parent=popup):
                    title.set(record["latestGenerated"]["title"])
                    text.delete("1.0", "end")
                    text.insert("1.0", record["latestGenerated"]["content"])
                    review.set("待审核")
            tk.Button(controls, text="载入最新生成稿", command=use_latest).pack(side="left", padx=8)
        tk.Button(controls, text="关闭", command=close).pack(side="right")
        if record.get("deletedAt"):
            save_button.configure(state="disabled")
            text.configure(state="disabled")
        popup.protocol("WM_DELETE_WINDOW", close)

    def _open_library(self):
        popup = tk.Toplevel(self)
        popup.title("资料库 / 回收站（历史资料不自动进入新任务）")
        popup.geometry("1050x720")
        query = tk.StringVar()
        deleted = tk.BooleanVar(value=False)
        bar = tk.Frame(popup)
        bar.pack(fill="x", padx=12, pady=12)
        tk.Entry(bar, textvariable=query, width=35).pack(side="left")
        tree = ttk.Treeview(popup, columns=("number", "kind", "title", "status", "time"),
                            show="headings", height=18, selectmode="browse")
        for name, label, width in (("number", "序号", 60), ("kind", "类型", 90), ("title", "标题", 430),
                                   ("status", "审核", 110), ("time", "修改时间", 190)):
            tree.heading(name, text=label)
            tree.column(name, width=width, anchor="center" if name == "number" else "w")
        tree.pack(fill="both", expand=True, padx=12)
        footer = tk.Frame(popup)
        footer.pack(fill="x", padx=12, pady=12)
        status = tk.StringVar(value="正在读取…")
        tk.Label(popup, textvariable=status).pack(anchor="w", padx=12, pady=(0, 8))
        rows = {}
        generation = [0]
        locked = [False]

        def refresh():
            generation[0] += 1
            version = generation[0]
            route = "api/library?" + urlencode({"q": query.get(), "deleted": "1" if deleted.get() else "0"})
            def done(data):
                if not popup.winfo_exists() or version != generation[0]:
                    return
                tree.delete(*tree.get_children())
                rows.clear()
                for number, row in enumerate(data.get("items", []), start=1):
                    rows[row["id"]] = row
                    tree.insert("", "end", iid=row["id"], values=(
                        number,
                        {"note": "个人笔记", "transcript": "文字稿", "knowledge": "知识稿"}.get(row["kind"], row["kind"]),
                        row["title"], "已人工审核" if row["reviewStatus"] == "reviewed" else "待审核", row["updatedAt"]))
                status.set(f"共 {len(rows)} 项。移入回收站不删除原始视频，可恢复；本版本不提供永久销毁。")
            self._async(lambda: self.client.get_json(route), done)

        def selected():
            ids = tree.selection()
            if not ids:
                messagebox.showinfo("尚未选择", "请先选择一条资料。", parent=popup)
                return None
            return rows.get(ids[0])

        def edit():
            row = selected()
            if row:
                self._edit_resource(row["id"], refresh)

        def change(action):
            if locked[0] or self.busy:
                return
            row = selected()
            if not row:
                return
            if not messagebox.askyesno("确认操作", f"{'恢复' if action == 'restore' else '移入回收站'}：{row['title']}？\n不会删除原始视频、模型或登录信息。", parent=popup):
                return
            locked[0] = True
            def operation():
                try:
                    self.client.post_json("api/library/change", {"id": row["id"], "revision": row["revision"], "action": action})
                    return None
                except Exception as error:
                    return str(error)
            def done(error):
                locked[0] = False
                if not popup.winfo_exists():
                    return
                if error:
                    messagebox.showerror("操作未完成", error, parent=popup)
                elif not self.busy:
                    self._async(self.client.get_state, self._sync_state)
                refresh()
            self._async(operation, done)

        def import_history():
            if self.busy or locked[0]:
                return
            locked[0] = True
            status.set("正在登记已有文字稿与知识索引，不重新下载或调用模型…")
            def operation():
                try:
                    job = self.client.start_job("api/library/import-history", {})
                    return self.client.wait_job(job, timeout=120)
                except Exception as error:
                    return {"status": "failed", "error": str(error)}
            def done(job):
                locked[0] = False
                if not popup.winfo_exists():
                    return
                if job.get("status") == "failed":
                    messagebox.showerror("导入未全部完成", job.get("error", "请查看日志"), parent=popup)
                refresh()
            self._async(operation, done)

        tk.Button(bar, text="搜索 / 刷新", command=refresh).pack(side="left", padx=8)
        tk.Checkbutton(bar, text="回收站", variable=deleted, command=refresh).pack(side="left")
        for label, command in (("新增笔记", lambda: self._resource_editor(on_saved=refresh)), ("查看 / 编辑", edit),
                               ("移入回收站", lambda: change("delete")), ("恢复", lambda: change("restore")),
                               ("导入已有成果", import_history)):
            tk.Button(footer, text=label, command=command).pack(side="left", padx=(0, 8))
        tree.bind("<Double-1>", lambda _: edit())
        refresh()

    def _show_record(self, route, title, markdown=False):
        fetch = self.client.get_text if markdown else self.client.get_json
        def done(value):
            if not markdown:
                value = json.dumps(value, ensure_ascii=False, indent=2)
            popup = tk.Toplevel(self)
            popup.title(title)
            popup.geometry("800x650")
            popup.configure(bg=BG)
            text = tk.Text(popup, wrap="word", font=("Consolas", 10), bg=WHITE, fg=INK)
            text.pack(fill="both", expand=True, padx=16, pady=16)
            text.insert("1.0", value)
            text.configure(state="disabled")
            if markdown:
                def save():
                    target = filedialog.asksaveasfilename(parent=popup, initialdir=str(self.client.root / "data"),
                                                          defaultextension=".md", filetypes=[("Markdown", "*.md")])
                    if target:
                        if Path(target).drive.upper() == "C:":
                            messagebox.showerror("保存位置不允许", "知识文件请保存到 D 盘，不写入 C 盘。", parent=popup)
                            return
                        Path(target).write_text(value, encoding="utf-8")
                tk.Button(popup, text="另存为 Markdown", command=save, bg=ACCENT, fg=WHITE,
                          relief="flat", padx=15, pady=8).pack(pady=(0, 12))
        self._async(lambda: fetch(route), done)

    def close(self):
        editors = [window for window in self.winfo_children()
                   if isinstance(window, tk.Toplevel) and hasattr(window, "has_unsaved")]
        if any(window.is_saving() for window in editors):
            messagebox.showinfo("正在保存", "请等待资料保存结束后再退出，避免中断写入。", parent=self)
            return
        if any(window.has_unsaved() for window in editors) and not messagebox.askyesno(
                "尚有未保存的资料", "退出将放弃编辑窗口中尚未保存的修改，确定退出？", parent=self):
            return
        if self.busy or self.job_id:
            messagebox.showinfo(
                "任务仍在处理",
                "当前任务正在启动或尚未结束，为避免后台浏览器、任务锁或资料文件残留，暂时不能退出。\n\n"
                "请等待任务完成；若正在账号验证，请先点击“取消验证”。",
                parent=self,
            )
            return
        self.client.close()
        self.destroy()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true", help="Verify engine connectivity without opening a window")
    args = parser.parse_args()
    if args.smoke:
        client = LocalWorkbench()
        try:
            state = client.ensure_started()
            print(json.dumps({"ready": state.get("ready"), "runtimeRoot": state.get("runtimeRoot")}, ensure_ascii=False))
        finally:
            client.close()
    else:
        WorkbenchApp().mainloop()
