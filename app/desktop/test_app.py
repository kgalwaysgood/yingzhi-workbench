"""Small native UI tests that do not access Douyin or open a browser."""

import time
import tkinter as tk
import unittest
from unittest import mock

from app import LIST_ROW_HEIGHT, LIST_VISIBLE_ROWS, WorkbenchApp


class FakeClient:
    root = __import__("pathlib").Path("D:/YingzhiWorkbench")

    def ensure_started(self):
        works = [{"videoId": str(index), "url": f"https://www.douyin.com/video/{index}",
                  "title": f"示例作品 {index}"} for index in range(100, 180)]
        return {
            "ready": {"cookies": True, "transcription": True, "summaryModel": False},
            "discovery": {"creators": [{"author": "候选作者", "profileUrl": "https://www.douyin.com/user/sample"}]},
            "prepared": {"works": works},
            "batch": {"results": [{"videoId": "123", "status": "completed", "hasTranscript": True,
                                   "jsonPath": "D:/YingzhiWorkbench/data/example.json", "title": "示例作品"}]},
            "knowledgeItems": [{"videoId": "123", "title": "示例知识", "topic": "制造", "reviewStatus": "pending"}],
        }

    def close(self):
        pass

    def get_state(self):
        return self.ensure_started()


class NativeWindowTest(unittest.TestCase):
    def test_close_is_blocked_while_a_background_job_is_running(self):
        app = self._create_app()
        try:
            app.job_id = "running-job"
            with mock.patch.object(app.client, "close") as close_client, mock.patch("app.messagebox.showinfo") as dialog:
                app.close()
            close_client.assert_not_called()
            dialog.assert_called_once()
            self.assertIn("暂时不能退出", dialog.call_args.args[1])
            self.assertTrue(app.winfo_exists())
        finally:
            app.destroy()

    def test_close_is_blocked_while_job_start_request_is_pending(self):
        app = self._create_app()
        try:
            app.busy = True
            app.job_id = None
            with mock.patch.object(app.client, "close") as close_client, mock.patch("app.messagebox.showinfo") as dialog:
                app.close()
            close_client.assert_not_called()
            dialog.assert_called_once()
            self.assertIn("正在启动", dialog.call_args.args[1])
            self.assertTrue(app.winfo_exists())
        finally:
            app.destroy()

    def test_main_window_close_checks_unsaved_editor_and_can_cancel(self):
        app = self._create_app()
        try:
            app._resource_editor()
            popup = next(w for w in app.winfo_children() if isinstance(w, tk.Toplevel))
            editor = next(w for w in popup.winfo_children() if isinstance(w, tk.Text))
            editor.insert("1.0", "尚未保存的中文稿")
            with mock.patch("app.messagebox.askyesno", return_value=False) as confirm:
                app.close()
                confirm.assert_called_once()
            self.assertTrue(app.winfo_exists())
            self.assertEqual(editor.get("1.0", "end-1c"), "尚未保存的中文稿")
        finally:
            app.destroy()

    def _create_app(self):
        def run_now(app, operation, done=None):
            result = operation()
            if done:
                done(result)

        with mock.patch.object(WorkbenchApp, "_async", run_now):
            app = WorkbenchApp(FakeClient())
        app.update()
        return app

    def test_error_dialog_shows_chinese_explanation(self):
        app = self._create_app()
        try:
            deadline = time.monotonic() + 3
            while app.busy and time.monotonic() < deadline:
                app.update()
                time.sleep(0.02)
            with mock.patch("app.messagebox.showerror") as dialog:
                app._failed("EPERM: operation not permitted, open 'D:\\YingzhiWorkbench\\private\\playwright-storage-state.json'")
            self.assertIn("登录信息", dialog.call_args.args[0])
            self.assertIn("你可以这样做", dialog.call_args.args[1])
            self.assertIn("ENV-001", dialog.call_args.args[1])
        finally:
            app.close()

    def test_five_screens_are_independent(self):
        app = self._create_app()
        try:
            deadline = time.monotonic() + 3
            while app.busy and time.monotonic() < deadline:
                app.update()
                time.sleep(0.02)
            self.assertFalse(app.busy)
            self.assertEqual(len(app.step_buttons), 5)
            for index in range(5):
                app.show_step(index)
                app.update()
                self.assertEqual(app.heading.cget("text"), ("学习目标", "选择博主", "挑选作品", "核对文字稿", "审核知识")[index])
                self.assertEqual(len(app.card.winfo_children()), 1)
                if index == 1:
                    self.assertEqual(app.creator_action.cget("state"), "disabled")
                if index == 2:
                    self.assertEqual(app.work_action.cget("state"), "disabled")
            app.show_step(1)
            list_frame = next(child for child in app.content.winfo_children()
                              if isinstance(child, tk.Frame)
                              and any(isinstance(item, tk.Canvas) for item in child.winfo_children()))
            canvas = next(child for child in list_frame.winfo_children() if isinstance(child, tk.Canvas))
            inner = canvas.nametowidget(canvas.find_all()[0] and canvas.itemcget(canvas.find_all()[0], "window"))
            row = next(child for child in inner.winfo_children() if isinstance(child, tk.Frame))
            checkbox = next(child for child in row.winfo_children() if isinstance(child, tk.Checkbutton))
            checkbox.invoke()
            self.assertIn("https://www.douyin.com/user/sample", app.selected_creators)
            self.assertEqual(app.creator_action.cget("state"), "normal")
            self.assertIn("已选择 1 位博主", app.creator_count.cget("text"))
            app.selected_works.add("https://www.douyin.com/video/stale")
            app.selected_transcripts.add("999")
            app._reconcile_selections()
            self.assertFalse(app.selected_works)
            self.assertFalse(app.selected_transcripts)
        finally:
            app.close()

    def test_bulk_select_and_ten_compact_rows_fit(self):
        app = self._create_app()
        try:
            deadline = time.monotonic() + 3
            while app.busy and time.monotonic() < deadline:
                app.update()
                time.sleep(0.02)
            app.show_step(2)
            app.update_idletasks()
            app.work_select_all.invoke()
            app.update_idletasks()
            self.assertEqual(len(app.selected_works), 80)
            self.assertTrue(all(variable.get() for variable in app.work_selection_vars.values()))
            self.assertEqual(app.work_count.cget("text"), "已选择 80 条作品")
            self.assertEqual(app.work_action.cget("state"), "normal")
            self.assertEqual(app.work_clear.cget("state"), "normal")
            self.assertIn("已选择 80 个作品", app.notice.get())
            list_frame = next(child for child in app.content.winfo_children()
                              if isinstance(child, tk.Frame)
                              and any(isinstance(item, tk.Canvas) for item in child.winfo_children()))
            canvas = next(child for child in list_frame.winfo_children() if isinstance(child, tk.Canvas))
            inner = canvas.nametowidget(canvas.itemcget(canvas.find_all()[0], "window"))
            rows = [child for child in inner.winfo_children() if isinstance(child, tk.Frame)]
            self.assertGreaterEqual(int(canvas.cget("height")), LIST_VISIBLE_ROWS * LIST_ROW_HEIGHT)
            self.assertEqual([row.sequence_number for row in rows[:LIST_VISIBLE_ROWS]],
                             list(range(1, LIST_VISIBLE_ROWS + 1)))
            app.work_clear.invoke()
            app.update_idletasks()
            self.assertFalse(app.selected_works)
            self.assertTrue(all(not variable.get() for variable in app.work_selection_vars.values()))
            self.assertEqual(app.work_count.cget("text"), "尚未选择作品")
            self.assertEqual(app.work_action.cget("state"), "disabled")
            self.assertEqual(app.work_clear.cget("state"), "disabled")
            self.assertIn("已取消全部作品选择", app.notice.get())
        finally:
            app.close()

    def test_eighty_selected_works_can_start_download(self):
        app = self._create_app()
        try:
            deadline = time.monotonic() + 3
            while app.busy and time.monotonic() < deadline:
                app.update()
                time.sleep(0.02)
            app.show_step(2)
            app.work_select_all.invoke()
            with mock.patch("app.messagebox.askyesno", return_value=True), mock.patch.object(app, "_start_job") as start:
                app._download()
            payload = start.call_args.args[1]
            self.assertEqual(start.call_args.args[0], "api/download")
            self.assertEqual(len(payload["urls"]), 80)
        finally:
            app.close()

    def test_clear_creator_list_requires_confirmation_and_calls_delete_route(self):
        app = self._create_app()
        try:
            app.show_step(1)
            with mock.patch("app.messagebox.askyesno", return_value=False), mock.patch.object(app, "_start_job") as start:
                app.creator_menu.invoke(2)
                start.assert_not_called()
            with mock.patch("app.messagebox.askyesno", return_value=True), mock.patch.object(app, "_start_job") as start:
                app.creator_menu.invoke(2)
                start.assert_called_once_with("api/clear-discovery", {}, "正在清空候选博主列表", 1)
        finally:
            app.close()


if __name__ == "__main__":
    unittest.main()
