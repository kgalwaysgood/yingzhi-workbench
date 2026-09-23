"""Connection guards for the native client."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest
from unittest import mock

from client import LocalWorkbench


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = json.dumps({"runtimeRoot": "D:/another-vault", "ready": {}}).encode()
        self.send_response(200)
        self.send_header("X-Douyin-Tool", "workbench")
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


class ClientTest(unittest.TestCase):
    def test_default_uses_a_fresh_loopback_port(self):
        with mock.patch.dict("os.environ", {"DOUYIN_TOOL_PORT": ""}):
            client = LocalWorkbench(tool_root=Path(__file__).resolve().parents[1],
                                    root=Path("D:/YingzhiWorkbench"))
            port = client.port
        self.assertGreater(port, 0)
        self.assertLessEqual(port, 65535)
        self.assertEqual(client.base_url, "http://127.0.0.1:{}/".format(port))

    def test_write_access_failure_has_actionable_message(self):
        client = LocalWorkbench(tool_root=Path(__file__).resolve().parents[1],
                                root=Path("D:/YingzhiWorkbench"), port=8765)
        with mock.patch.object(Path, "exists", return_value=True), mock.patch("client.os.open", side_effect=PermissionError("blocked")):
            with self.assertRaisesRegex(RuntimeError, "无法写入 D 盘登录目录"):
                client._check_runtime_write_access()

    def test_rejects_engine_for_different_data_directory(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = LocalWorkbench(tool_root=Path(__file__).resolve().parents[1],
                                    root=Path("D:/YingzhiWorkbench"), port=server.server_port)
            with self.assertRaisesRegex(RuntimeError, "different data directory"):
                client._online()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
