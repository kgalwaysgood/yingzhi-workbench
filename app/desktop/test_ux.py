"""Native interaction regression; platform/browser actions are intercepted."""

import tkinter as tk
import unittest
from tkinter import ttk
from unittest import mock

import test_app
from presentation import progress_caption, work_caption


class DesktopExperienceTest(unittest.TestCase):
    def setUp(self):
        self.app = test_app.NativeWindowTest()._create_app()

    def tearDown(self):
        self.app.destroy()

    def _visible_rows(self):
        canvas = self.app.list_canvas
        body = canvas.nametowidget(canvas.itemcget(canvas.find_all()[0], "window"))
        return [child for child in body.winfo_children() if isinstance(child, tk.Frame)]

    def test_verification_failure_is_inline_without_automatic_browser(self):
        with mock.patch.object(self.app, "_start_job") as start, mock.patch("app.messagebox.showerror") as dialog:
            self.app._failed("抖音需要验证码")
            self.app.update()
            start.assert_not_called()
            dialog.assert_not_called()
            self.assertEqual(self.app.verify_button.winfo_manager(), "pack")
            self.assertIn("不会自动", self.app.notice.get())

    def test_interactive_retry_requires_confirmation_and_does_not_change_normal_payload(self):
        payload = {"topic": "MES 订单流转"}
        self.app.retry_request = ("api/discover", payload, "搜索", 1)
        with mock.patch.object(self.app, "_start_job") as start:
            with mock.patch("app.messagebox.askyesno", return_value=False):
                self.app._verify_retry()
            start.assert_not_called()
            with mock.patch("app.messagebox.askyesno", return_value=True):
                self.app._verify_retry()
            self.assertTrue(start.call_args.args[1]["interactive"])
        self.assertNotIn("interactive", payload)
        self.app.topic_input.set("MES 订单流转")
        with mock.patch.object(self.app, "_start_job") as start:
            self.app._discover()
            self.assertNotIn("interactive", start.call_args.args[1])

    def test_account_login_requires_user_confirmation(self):
        with mock.patch.object(self.app, "_start_job") as start:
            with mock.patch("app.messagebox.askyesno", return_value=False):
                self.app.account_button.invoke()
            start.assert_not_called()
            with mock.patch("app.messagebox.askyesno", return_value=True):
                self.app.account_button.invoke()
            self.assertEqual(start.call_args.args[0], "api/login")

    def test_login_confirmation_error_preserves_active_job_and_retry_controls(self):
        app = self.app
        app.busy = True
        app.job_id = "test-login"
        app.latest_job = {"kind": "login", "status": "running", "awaitingConfirmation": True}
        def immediate(operation, done):
            done(operation())
        with mock.patch.object(app, "_async", immediate), mock.patch.object(app.client, "post_json", create=True, side_effect=RuntimeError("尚未完成登录")) as post:
            app._confirm_account("save")
            post.assert_called_once_with("api/login/confirm", {"action": "save"})
        self.assertTrue(app.busy)
        self.assertEqual(app.job_id, "test-login")
        self.assertIn("尚未保存", app.notice.get())
        self.assertEqual(app.login_cancel_button.cget("state"), "normal")

    def test_login_cancel_does_not_claim_saved_or_step_completed(self):
        app = self.app
        app.busy = True
        app.job_id = "test-login"
        with mock.patch.object(app, "_async"):
            app._job_update({"kind": "login", "status": "completed", "result": {"loggedIn": False, "reason": "cancel"}})
        self.assertFalse(app.busy)
        self.assertEqual(app.task_title.get(), "已取消登录")
        self.assertEqual(app.progress["value"], 0)
        self.assertIn("未更新", app.notice.get())

    def test_login_save_controls_only_after_browser_ready(self):
        app = self.app
        app.busy = True
        app.job_id = "test-login"
        app.latest_job = {"kind": "login", "status": "running", "awaitingConfirmation": False}
        app._auth_controls()
        app.update()
        self.assertEqual(app.login_save_button.winfo_manager(), "")
        app.latest_job["awaitingConfirmation"] = True
        app._auth_controls()
        app.update()
        self.assertEqual(app.login_save_button.winfo_manager(), "pack")

    def test_poll_failure_keeps_job_busy_and_schedules_recovery(self):
        app = self.app
        app.busy = True
        app.job_id = "still-active"
        app.latest_job = {"kind": "login", "status": "running", "awaitingConfirmation": True}
        def immediate(operation, done):
            done(operation())
        with mock.patch.object(app, "_async", immediate), mock.patch.object(app.client, "get_json", create=True, side_effect=RuntimeError("timeout")), mock.patch.object(app, "after") as later:
            app._poll_job()
        self.assertTrue(app.busy)
        self.assertEqual(app.job_id, "still-active")
        later.assert_called_once_with(1500, app._poll_job)
        self.assertIn("任务未取消", app.notice.get())

    def test_late_login_confirmation_does_not_overwrite_terminal_result(self):
        app = self.app
        app.busy = True
        app.job_id = "old-login"
        app.latest_job = {"kind": "login", "status": "running", "awaitingConfirmation": True}
        with mock.patch.object(app, "_async") as queued:
            app._confirm_account("save")
            callback = queued.call_args.args[1]
            app._job_update({"kind": "login", "status": "completed", "result": {"loggedIn": True, "reason": "saved"}})
            notice = app.notice.get()
            callback({"accepted": True})
        self.assertEqual(app.notice.get(), notice)
        self.assertEqual(app.task_title.get(), "登录信息已保存")

    def test_bulk_selection_has_visible_row_feedback_and_whole_row_click(self):
        app = self.app
        app.show_step(2)
        app.update()
        canvas = app.list_canvas
        body = canvas.nametowidget(canvas.itemcget(canvas.find_all()[0], "window"))
        row = body.winfo_children()[0]
        unselected = row.cget("bg")
        row.event_generate("<Button-1>")
        self.assertEqual(len(app.selected_works), 1)
        self.assertNotEqual(row.cget("bg"), unselected)
        app.work_clear.invoke()
        self.assertEqual(row.cget("bg"), unselected)
        app.work_select_all.invoke()
        self.assertNotEqual(row.cget("bg"), unselected)

    def test_all_business_detail_lists_show_continuous_sequence_numbers(self):
        for step in (1, 2, 3, 4):
            with self.subTest(step=step):
                self.app.show_step(step)
                self.app.update()
                rows = self._visible_rows()
                self.assertTrue(rows)
                self.assertEqual(
                    [row.sequence_number for row in rows[:12]],
                    list(range(1, min(len(rows), 12) + 1)),
                )
                number_labels = [child for child in rows[0].winfo_children()
                                 if isinstance(child, tk.Label) and child.cget("text") == "01"]
                self.assertEqual(len(number_labels), 1)

    def test_library_table_has_sequence_column_and_numbered_rows(self):
        items = [
            {"id": "note:1", "kind": "note", "title": "订单流转", "reviewStatus": "pending",
             "updatedAt": "2026-09-23 12:00", "revision": 1},
            {"id": "knowledge:2", "kind": "knowledge", "title": "交付闭环", "reviewStatus": "reviewed",
             "updatedAt": "2026-09-23 12:10", "revision": 1},
        ]
        def run_now(operation, done):
            done(operation())

        with mock.patch.object(self.app, "_async", run_now), \
                mock.patch.object(self.app.client, "get_json", create=True, return_value={"items": items}):
            self.app._open_library()
            self.app.update()
        popup = next(w for w in self.app.winfo_children() if isinstance(w, tk.Toplevel))
        tree = next(w for w in popup.winfo_children() if isinstance(w, ttk.Treeview))
        self.assertEqual(tree.cget("columns")[0], "number")
        self.assertEqual([tree.item(item, "values")[0] for item in tree.get_children()], ["1", "2"])
        popup.destroy()

    def test_titles_preserve_source_but_hide_hashtag_wall_and_url(self):
        original = "ERP订单如何交付？ #MES #ERP #工厂 #系统"
        caption, note = work_caption(original, "123")
        self.assertEqual(caption, "ERP订单如何交付？")
        self.assertEqual(note, "MES · ERP · 工厂")
        self.assertIn("#系统", original)

    def test_progress_is_readable_and_raw_logs_only_in_details(self):
        job = {"kind": "download", "status": "running", "logs": ["[browser] using Playwright Chromium", "[4/20] parse attempt"]}
        caption = progress_caption(job)
        self.assertNotIn("Playwright", caption)
        self.assertNotIn("parse", caption)
        self.assertIn("4 / 20", caption)
        self.app.latest_job = job
        self.app._show_task_details()
        popup = next(w for w in self.app.winfo_children() if isinstance(w, tk.Toplevel))
        text = next(w for w in popup.winfo_children() if isinstance(w, tk.Text))
        self.assertIn("Playwright", text.get("1.0", "end"))

    def test_small_window_primary_controls_fit_without_overlap(self):
        app = self.app
        app.state("normal")
        app.geometry("900x700")
        for step in (1, 2, 3):
            app.show_step(step)
            app.update()
            prefix = ("creator", "work", "transcript")[step - 1]
            button = getattr(app, prefix + "_action")
            self.assertGreaterEqual(button.winfo_width(), button.winfo_reqwidth())
            toolbar = button.master
            for child in toolbar.winfo_children():
                self.assertEqual(child.winfo_manager(), "pack")
                self.assertLessEqual(child.winfo_x() + child.winfo_width(), toolbar.winfo_width())

    def test_source_modes_preserve_inputs_and_show_one_entry_path(self):
        app = self.app
        app.topic_input.set("订单到交付")
        app.profile_input.set("https://www.douyin.com/user/sample")
        for mode, expected in (("link", app.profile_input), ("topic", app.topic_input)):
            app.source_mode.set(mode)
            app.show_step(0)
            entries = [w for w in app.content.winfo_children() if isinstance(w, tk.Entry)]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0].cget("textvariable"), str(expected))
        self.assertEqual(app.profile_input.get(), "https://www.douyin.com/user/sample")


if __name__ == "__main__":
    unittest.main()
