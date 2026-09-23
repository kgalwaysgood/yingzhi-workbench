"""Real Tk widgets -> Python HTTP client -> Node server -> files.

Only the external platform and model are offline fixtures, not live E2E evidence.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import tkinter as tk
import unittest
from unittest import mock

from app import WorkbenchApp
from client import LocalWorkbench, choose_loopback_port, runtime_environment


def descendants(widget):
    for child in widget.winfo_children():
        yield child
        yield from descendants(child)


class ConnectedDesktopTest(unittest.TestCase):
    def test_five_step_workflow_edit_save_library_recycle_restore_reset(self):
        tool = Path(__file__).resolve().parents[1]
        test_parent = tool / "runtime"
        test_parent.mkdir(exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="desktop-connected-", dir=str(test_parent)))
        port = choose_loopback_port()
        client = LocalWorkbench(tool_root=tool, root=root, port=port)
        env = runtime_environment(root, tool)
        process = subprocess.Popen([shutil.which("node"), str(Path(__file__).with_name("smoke-server.mjs")), str(root), str(port)],
                                   env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        app = None
        try:
            deadline = time.monotonic() + 12
            while not client._online():
                if process.poll() is not None:
                    self.fail(process.stderr.read().decode("utf-8", errors="replace"))
                if time.monotonic() > deadline:
                    self.fail("isolated Node fixture did not start")
                time.sleep(.05)
            with mock.patch("app.messagebox.showerror") as errors, mock.patch("app.messagebox.askyesno", return_value=True):
                app = WorkbenchApp(client)

                def pump(condition):
                    end = time.monotonic() + 15
                    while time.monotonic() < end:
                        app.update()
                        if condition():
                            return
                        time.sleep(.02)
                    self.fail("native UI did not reach expected state: " + str(errors.call_args_list))

                def button(window, title):
                    return next(w for w in descendants(window) if isinstance(w, tk.Button) and w.cget("text") == title)

                pump(lambda: not app.busy)
                app.topic_input.set("订单交付学习")
                app._discover()
                pump(lambda: not app.busy and app.step == 1)
                app.creator_select_all.invoke()
                app.creator_action.invoke()
                pump(lambda: not app.busy and app.step == 2)
                self.assertEqual(len(app.state_data["prepared"]["works"]), 12)
                app.work_select_all.invoke()
                app.work_action.invoke()
                pump(lambda: not app.busy and app.step == 3)
                self.assertEqual(len(app.state_data["batch"]["results"]), 12)
                app._edit_resource("transcript:100")
                pump(lambda: any(isinstance(w, tk.Toplevel) for w in app.winfo_children()))
                editor = next(w for w in app.winfo_children() if isinstance(w, tk.Toplevel))
                text = next(w for w in descendants(editor) if isinstance(w, tk.Text))
                text.insert("end", "人工校正：要记录客户订单号。")
                button(editor, "保存修改").invoke()
                pump(lambda: client.get_json("api/library/transcript%3A100")["revision"] == 2)
                pump(lambda: str(button(editor, "保存修改").cget("state")) == "normal")
                button(editor, "关闭").invoke()
                app.selected_transcripts = {"100"}
                app._summarize()
                pump(lambda: not app.busy and app.step == 4)
                self.assertIn("人工校正", client.get_json("api/library/knowledge%3A100")["content"])
                source = json.loads((root / "data" / "100.json").read_text(encoding="utf-8"))
                self.assertNotIn("人工校正", source["transcript"])

                app._open_library()
                library = next(w for w in app.winfo_children() if isinstance(w, tk.Toplevel))
                tree = next(w for w in descendants(library) if w.winfo_class() == "Treeview")
                pump(lambda: len(tree.get_children()) == 13)
                button(library, "新增笔记").invoke()
                note = next(w for w in app.winfo_children() if isinstance(w, tk.Toplevel) and w != library)
                entry = next(w for w in descendants(note) if isinstance(w, tk.Entry))
                entry.insert(0, "我自己的学习记录")
                next(w for w in descendants(note) if isinstance(w, tk.Text)).insert("1.0", "需要核对 ERP 与 MES 的订单关联。")
                button(note, "保存笔记").invoke()
                pump(lambda: len(tree.get_children()) == 14)
                button(note, "关闭").invoke()
                note_id = next(i for i in tree.get_children() if i.startswith("note:"))
                tree.selection_set(note_id)
                button(library, "移入回收站").invoke()
                pump(lambda: len(tree.get_children()) == 13)
                recycle = next(w for w in descendants(library) if isinstance(w, tk.Checkbutton))
                recycle.invoke()
                pump(lambda: list(tree.get_children()) == [note_id])
                tree.selection_set(note_id)
                button(library, "恢复").invoke()
                pump(lambda: len(tree.get_children()) == 0)
                recycle.invoke()
                pump(lambda: len(tree.get_children()) == 14)
                errors.assert_not_called()
                # Two editors retain a stale revision: the second save must fail without losing typed text.
                record = client.get_json("api/library/" + note_id)
                app._resource_editor(record)
                editor1 = next(w for w in app.winfo_children() if isinstance(w, tk.Toplevel) and w != library)
                app._resource_editor(record)
                editor2 = next(w for w in app.winfo_children() if isinstance(w, tk.Toplevel) and w not in (library, editor1))
                text1 = next(w for w in descendants(editor1) if isinstance(w, tk.Text))
                text2 = next(w for w in descendants(editor2) if isinstance(w, tk.Text))
                text1.insert("end", "第一窗口修改。")
                button(editor1, "保存修改").invoke()
                pump(lambda: client.get_json("api/library/" + note_id)["revision"] == record["revision"] + 1)
                text2.insert("end", "第二窗口未保存内容。")
                button(editor2, "保存修改").invoke()
                pump(lambda: errors.called)
                self.assertIn("重新打开", errors.call_args.args[1])
                self.assertIn("第二窗口未保存内容", text2.get("1.0", "end-1c"))
                self.assertNotIn("第二窗口未保存内容", client.get_json("api/library/" + note_id)["content"])
                with mock.patch("app.messagebox.askyesno", return_value=False):
                    button(editor2, "关闭").invoke()
                self.assertTrue(editor2.winfo_exists())
                button(editor2, "关闭").invoke()
                button(editor1, "关闭").invoke()
                library.destroy()
                app._new_task()
                pump(lambda: not app.busy and app.step == 0)
                self.assertFalse(app.selected_creators | app.selected_works | app.selected_transcripts)
                self.assertEqual(app.state_data["knowledgeItems"], [])
                self.assertEqual(len(client.get_json("api/library")["items"]), 14)
                self.assertEqual(errors.call_count, 1)
        finally:
            if app:
                app.update()
                app.destroy()
            process.terminate()
            process.communicate(timeout=10)
            self.assertTrue(root.resolve().is_relative_to(test_parent.resolve()))
            shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
