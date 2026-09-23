"""Local workbench client used by the native desktop UI."""

import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener



def choose_loopback_port():
    configured = os.environ.get("DOUYIN_TOOL_PORT")
    if configured:
        port = int(configured)
        if not 1 <= port <= 65535:
            raise RuntimeError("DOUYIN_TOOL_PORT must be between 1 and 65535")
        return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def find_tool_root():
    import sys

    for origin in (Path(__file__).resolve(), Path(sys.executable).resolve()):
        for directory in (origin.parent, *origin.parents):
            if (directory / "ui" / "server.mjs").is_file():
                return directory
    raise RuntimeError("Application engine is missing: ui/server.mjs")


def runtime_root():
    root = Path(os.environ.get("DOUYIN_TOOL_HOME", "D:\\YingzhiWorkbench")).resolve()
    if root.drive.upper() == "C:":
        raise RuntimeError("Application data must not be stored on C:")
    return root


def runtime_environment(root, tool_root):
    env = os.environ.copy()
    for directory in ("tmp", "cache", "data", "queue", "private"):
        (root / directory).mkdir(parents=True, exist_ok=True)
    env.update({
        "DOUYIN_TOOL_HOME": str(root),
        "TEMP": str(root / "tmp"),
        "TMP": str(root / "tmp"),
        "HF_HOME": str(root / "cache" / "huggingface"),
        "TORCH_HOME": str(root / "cache" / "torch"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "PLAYWRIGHT_BROWSERS_PATH": str(root / "cache" / "playwright-node"),
        "PYTHONPYCACHEPREFIX": str(root / "cache" / "pycache"),
        "PYTHONPATH": str(tool_root.parent / "vendor" / "douyin-downloader-1"),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    })
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GIT_HTTP_PROXY", "GIT_HTTPS_PROXY"):
        if env.get(name) == "http://127.0.0.1:9":
            env.pop(name)
    return env


def find_node(tool_root, root):
    for candidate in (tool_root / "runtime" / "node.exe", root / "bin" / "node.exe"):
        if candidate.is_file():
            return str(candidate)
    return shutil.which("node.exe")


class LocalWorkbench:
    def __init__(self, tool_root=None, root=None, port=None):
        self.tool_root = Path(tool_root) if tool_root else find_tool_root()
        self.root = Path(root) if root else runtime_root()
        self.port = port if port is not None else choose_loopback_port()
        self.base_url = "http://127.0.0.1:{}/".format(self.port)
        self.opener = build_opener(ProxyHandler({}))
        self.token = None
        self.process = None

    def _request(self, route, payload=None, timeout=10):
        url = self.base_url + route.lstrip("/")
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json"}
        if payload is not None:
            headers.update({"Content-Type": "application/json", "X-Workbench-Token": self.token or ""})
        request = Request(url, data=data, headers=headers, method="GET" if data is None else "POST")
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return response.read().decode("utf-8-sig"), response.headers
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            try:
                message = json.loads(body).get("error", body)
            except ValueError:
                message = body
            raise RuntimeError(message or "HTTP {}".format(error.code)) from error

    def _online(self):
        try:
            body, headers = self._request("api/state", timeout=2)
            if headers.get("X-Douyin-Tool") != "workbench":
                raise RuntimeError("Port {} belongs to an unknown service".format(self.port))
            active_root = Path(json.loads(body).get("runtimeRoot", "")).resolve()
            if active_root != self.root.resolve():
                raise RuntimeError("Port {} is already serving a different data directory: {}".format(self.port, active_root))
            return True
        except (URLError, TimeoutError):
            return False

    def _check_runtime_write_access(self):
        private = self.root / "private"
        try:
            private.mkdir(parents=True, exist_ok=True)
            state_file = private / "playwright-storage-state.json"
            if state_file.exists():
                # Normal startup only consumes the saved login. Requiring write access here
                # made a harmless browser read lock block the entire desktop workbench.
                descriptor = os.open(str(state_file), os.O_RDONLY)
                os.close(descriptor)
            else:
                with tempfile.NamedTemporaryFile(dir=str(private), prefix="write-check-", delete=True):
                    pass
        except OSError as error:
            raise RuntimeError(
                "无法写入 D 盘登录目录。请关闭旧工作台，从 Windows 资源管理器双击桌面 EXE 启动；"
                "登录数据未被修改。"
            ) from error

    def ensure_started(self):
        self._check_runtime_write_access()
        if not self._online():
            node = find_node(self.tool_root, self.root)
            if not node:
                raise RuntimeError("Node runtime is missing from the application package")
            env = runtime_environment(self.root, self.tool_root)
            log_path = self.root / "private" / "desktop-engine.log"
            log = log_path.open("ab")
            try:
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                self.process = subprocess.Popen(
                    [node, str(self.tool_root / "ui" / "server.mjs"), "--port", str(self.port)],
                    cwd=str(self.tool_root), env=env, stdin=subprocess.DEVNULL,
                    stdout=log, stderr=subprocess.STDOUT, creationflags=flags,
                )
            finally:
                log.close()
            for _ in range(50):
                if self._online():
                    break
                if self.process.poll() is not None:
                    raise RuntimeError("Local engine exited; see {}".format(log_path))
                time.sleep(0.2)
            else:
                raise RuntimeError("Local engine did not start; see {}".format(log_path))
        html, headers = self._request("", timeout=5)
        if headers.get("X-Douyin-Tool") != "workbench":
            raise RuntimeError("Port {} belongs to an unknown service".format(self.port))
        match = re.search(r'name="workbench-token" content="([a-f0-9]+)"', html)
        if not match:
            raise RuntimeError("Local engine did not provide a session token")
        self.token = match.group(1)
        return self.get_state()

    def get_state(self):
        body, _ = self._request("api/state")
        return json.loads(body)

    def get_json(self, route):
        body, _ = self._request(route)
        return json.loads(body)

    def get_text(self, route):
        body, _ = self._request(route)
        return body

    def post_json(self, route, payload):
        body, _ = self._request(route, payload)
        return json.loads(body)

    def start_job(self, route, payload):
        body, _ = self._request(route, payload)
        return json.loads(body)["jobId"]

    def wait_job(self, job_id, on_update=None, timeout=3600):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.get_json("api/jobs/{}".format(job_id))
            if on_update:
                on_update(result)
            if result.get("status") != "running":
                return result
            time.sleep(1)
        raise RuntimeError("Task timed out; inspect local engine log before retrying")

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
