#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""girls_dict（超超你的字典）本地服务端 —— SQLite 版本。

只用 Python 标准库（http.server + sqlite3），零依赖。它做三件事：

1. 把 ``public/``（本机管理端）当静态网站托管；
2. 暴露读写 ``data/girls_dict.sqlite3`` 的 REST 接口（补丁式增量写入 + 只读查询）；
3. 首次启动时，如果发现旁边还有旧版的 ``data/girls_dict.json``，自动迁移进
   SQLite 并把旧文件归档到 ``data/legacy/``（绝不删除）。

运行：
    python server/server.py                 # http://127.0.0.1:8777
    python server/server.py --port 9000 --open
    python server/server.py --data D:/xiachao/girls_dict.sqlite3
    python server/server.py --migrate-json D:/old/girls_dict.json   # 手工迁移后退出
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import socket
import sys
import threading
import urllib.parse
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from girls_db import (  # noqa: E402  (需要先插入 sys.path)
    CHAR_MAX,
    CHAR_MIN,
    EXPORT_VERSION,
    OP_DOCS,
    STORAGE_VERSION,
    GirlsDB,
    OpError,
    RevisionConflict,
    ValidationError,
    normalize_document,
)
from site_publish import SITE_FORMAT_VERSION, publish_site, publish_status  # noqa: E402

APP_NAME = "girls_dict"
APP_TITLE = "超超你的字典"
APP_VERSION = "2.0.0"
MAX_BODY = 64 * 1024 * 1024

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PUBLIC = ROOT / "public"
DEFAULT_DATA = ROOT / "data" / "girls_dict.sqlite3"
DEFAULT_LEGACY = ROOT / "data" / "girls_dict.json"


def harden_stdio() -> None:
    """控制台编码不支持中文时不至于抛 UnicodeEncodeError（宁可显示成 ? ）。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


def origin_allowed(origin: Optional[str], extra: List[str]) -> bool:
    """只放行本机页面（含 file:// 打开时的 null）与命令行显式允许的来源。"""
    if not origin:
        return True
    if origin == "null":
        return True
    if origin in extra:
        return True
    return bool(re.match(r"^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", origin))


class Handler(BaseHTTPRequestHandler):
    server_version = f"{APP_NAME}/{APP_VERSION}"
    protocol_version = "HTTP/1.1"

    database: GirlsDB
    public_dir: Path
    allowed_origins: List[str] = []
    quiet: bool = False

    # ------------------------------------------------------------------ #
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D102
        if not self.quiet:
            sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    # ------------------------------------------------------------------ #
    # 基础响应
    # ------------------------------------------------------------------ #
    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin_allowed(origin, self.allowed_origins):
            self.send_header("Access-Control-Allow-Origin", origin)
        elif not origin:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Vary", "Origin")

    def _send(self, status: int, body: bytes, content_type: str,
              extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _error(self, status: int, message: str, **extra: Any) -> None:
        self._json(status, {"ok": False, "error": message, **extra})

    def _read_json(self) -> Any:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Content-Length 不合法")
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError(f"请求体不是合法 JSON：{exc}")

    # ------------------------------------------------------------------ #
    # 路由
    # ------------------------------------------------------------------ #
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                return self._api_get(parsed.path, urllib.parse.parse_qs(parsed.query))
            return self._serve_static(parsed.path)
        except Exception as exc:  # pragma: no cover - 兜底
            self._error(500, f"服务端异常：{exc}")

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/db":
                payload = self._read_json()
                if "db" in payload and payload["db"] is None:
                    return self._error(400, "db 字段不能为 null")
                document = payload.get("db", payload)
                revision = payload.get("revision")
                explicit_force = bool(payload.get("force"))
                # 整库替换是「覆盖一切」的操作，必须表明意图：
                # 要么带上 revision（过期就 409），要么显式 force；空库才可以直接写。
                if revision is None and not explicit_force:
                    if self.database.load_index()["stats"]["chapters"] > 0:
                        return self._error(
                            400,
                            "整库替换会覆盖现有数据：请带上 revision（并处理 409），或显式传 force: true")
                result = self.database.replace_all(
                    document, expected_revision=revision,
                    force=explicit_force or revision is None,
                    strict=bool(payload.get("strict")))
                return self._json(200, {"ok": True, **result})
            return self._error(404, f"没有这个接口：PUT {parsed.path}")
        except RevisionConflict as conflict:
            return self._conflict(conflict)
        except ValidationError as invalid:
            return self._json(422, {"ok": False, "error": str(invalid), "issues": invalid.issues})
        except OpError as bad:
            return self._json(400, {"ok": False, "error": str(bad), "opIndex": bad.index})
        except ValueError as bad:
            return self._error(400, str(bad))
        except Exception as exc:  # pragma: no cover
            self._error(500, f"服务端异常：{exc}")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        try:
            payload = self._read_json()
        except ValueError as bad:
            return self._error(400, str(bad))
        try:
            if parsed.path == "/api/db/patch":
                result = self.database.apply_patch(
                    payload.get("ops"), expected_revision=payload.get("revision"),
                    force=bool(payload.get("force")), label=str(payload.get("label") or "patch"))
                return self._json(200, {"ok": True, **result})
            if parsed.path == "/api/db/import":
                if "db" in payload and payload["db"] is None:
                    return self._error(400, "db 字段不能为 null")
                if isinstance(payload.get("path"), str):
                    result = self.database.import_json(payload["path"],
                                                       archive=bool(payload.get("archive")))
                else:
                    result = self.database.import_json(payload.get("db", payload), archive=False)
                return self._json(200, {"ok": True, **result})
            if parsed.path == "/api/db/validate":
                issues: List[Dict[str, str]] = []
                normalize_document(payload.get("db", payload), issues)
                errors = [i for i in issues if i["level"] == "error"]
                return self._json(200, {"ok": True, "valid": not errors, "issues": issues})
            if parsed.path == "/api/db/clear":
                return self._json(200, {"ok": True, **self.database.clear()})
            if parsed.path == "/api/backups":
                target = self.database.create_backup(tag=str(payload.get("tag") or ""))
                return self._json(200, {"ok": True, "backup": target.name})
            if parsed.path == "/api/backups/restore":
                name = str(payload.get("name") or "")
                if not name:
                    return self._error(400, "缺少快照文件名 name")
                return self._json(200, {"ok": True, **self.database.restore_backup(name)})
            if parsed.path == "/api/publish":
                if not origin_allowed(self.headers.get("Origin"), self.allowed_origins):
                    return self._error(403, "只允许本机页面调用发布接口")
                return self._json(200, publish_site(
                    self.database, ROOT,
                    message=str(payload.get("message") or ""),
                    export_only=bool(payload.get("exportOnly")),
                    push=bool(payload.get("push", True)),
                    force=bool(payload.get("force")),
                ))
            return self._error(404, f"没有这个接口：POST {parsed.path}")
        except RevisionConflict as conflict:
            return self._conflict(conflict)
        except ValidationError as invalid:
            return self._json(422, {"ok": False, "error": str(invalid), "issues": invalid.issues})
        except OpError as bad:
            return self._json(400, {"ok": False, "error": str(bad), "opIndex": bad.index})
        except FileNotFoundError as missing:
            return self._error(404, str(missing))
        except ValueError as bad:
            return self._error(400, str(bad))
        except Exception as exc:  # pragma: no cover
            self._error(500, f"服务端异常：{exc}")

    def _conflict(self, conflict: RevisionConflict) -> None:
        self._json(409, {
            "ok": False,
            "error": "版本冲突：数据库已被其它程序修改",
            "revision": conflict.current_revision,
            "db": conflict.current_document,
        })

    # ------------------------------------------------------------------ #
    # API: GET
    # ------------------------------------------------------------------ #
    def _api_get(self, path: str, query: Dict[str, List[str]]) -> None:
        database = self.database
        if path == "/api/health":
            index = database.load_index()
            return self._json(200, {
                "ok": True, "app": APP_NAME, "title": APP_TITLE, "version": APP_VERSION,
                "storage": "sqlite", "storageVersion": STORAGE_VERSION, "exportVersion": EXPORT_VERSION,
                "siteFormatVersion": SITE_FORMAT_VERSION,
                "charMin": CHAR_MIN, "charMax": CHAR_MAX,
                "dataFile": str(database.path), "dataFileExists": database.exists(),
                "dataFileSize": database.db_size() if database.exists() else 0,
                "backupDir": str(database.backup_dir),
                "revision": index["revision"], "updatedAt": index["updatedAt"],
                "chapters": index["stats"]["chapters"], "panels": index["stats"]["panels"],
                "migration": database.migration or database.migration_info(),
                "time": datetime.now().isoformat(timespec="seconds"),
            })
        if path == "/api/index":
            return self._json(200, {"ok": True, **database.load_index()})
        if path == "/api/db":
            document = database.load_document()
            return self._json(200, {"ok": True, "revision": document["revision"], "db": document})
        if path == "/api/db/raw":
            # 数据库本体现在是 SQLite；这里给的是「交换格式」JSON 文本（不含 id）
            return self._send(200, database.export_json().encode("utf-8"), "application/json; charset=utf-8")
        if path == "/api/db/export":
            fmt = (query.get("format") or ["json"])[0].lower()
            if fmt == "csv":
                return self._download(database.export_csv().encode("utf-8-sig"), "girls_dict.csv",
                                      "text/csv; charset=utf-8")
            if fmt in ("md", "markdown"):
                return self._download(database.export_markdown().encode("utf-8"), "girls_dict.md",
                                      "text/markdown; charset=utf-8")
            if fmt in ("sqlite", "sqlite3", "db"):
                blob = database.path.read_bytes() if database.exists() else b""
                return self._download(blob, "girls_dict.sqlite3", "application/vnd.sqlite3")
            return self._download(database.export_json().encode("utf-8"), "girls_dict.json",
                                  "application/json; charset=utf-8")
        if path == "/api/stats":
            return self._json(200, {"ok": True, "stats": database.stats()})
        if path == "/api/find":
            raw = (query.get("char") or [""])[0]
            if not raw.lstrip("+-").isdigit():
                return self._error(400, "char 必须是 0–100 的整数")
            char = int(raw)
            hits = database.find_char(char)
            return self._json(200, {"ok": True, "char": char, "count": len(hits), "hits": hits})
        if path == "/api/search":
            return self._json(200, {"ok": True, **database.search((query.get("q") or [""])[0])})
        if path == "/api/log":
            try:
                limit = int((query.get("limit") or ["50"])[0])
            except ValueError:
                limit = 50
            return self._json(200, {"ok": True, "log": database.recent_log(limit)})
        if path == "/api/backups":
            return self._json(200, {"ok": True, "backups": database.list_backups()})
        if path == "/api/publish/status":
            return self._json(200, publish_status(ROOT))
        if path == "/api/help":
            return self._json(200, {"ok": True, "endpoints": ENDPOINTS, "ops": OP_DOCS})

        parts = [segment for segment in path.split("/") if segment]
        if len(parts) >= 3 and parts[0] == "api" and parts[1] == "chapters":
            chapter_id = urllib.parse.unquote(parts[2])
            if len(parts) == 3:
                chapter = database.load_chapter(chapter_id)
                if chapter is None:
                    return self._error(404, f"没有这一话：{chapter_id}")
                return self._json(200, {"ok": True, "chapter": chapter})
            if len(parts) == 5 and parts[3] == "panels":
                chapter = database.load_chapter(chapter_id)
                if chapter is None:
                    return self._error(404, f"没有这一话：{chapter_id}")
                panel_id = urllib.parse.unquote(parts[4])
                for index, panel in enumerate(chapter["panels"], start=1):
                    if panel["id"] == panel_id:
                        return self._json(200, {"ok": True, "chapterId": chapter_id,
                                                "panelIndex": index, "panel": panel})
                return self._error(404, f"找不到这个槽位：{panel_id}")
        return self._error(404, f"没有这个接口：GET {path}")

    def _download(self, body: bytes, filename: str, content_type: str) -> None:
        return self._send(200, body, content_type,
                          {"Content-Disposition": f'attachment; filename="{filename}"'})

    # ------------------------------------------------------------------ #
    # 静态文件
    # ------------------------------------------------------------------ #
    def _serve_static(self, path: str) -> None:
        relative = urllib.parse.unquote(path).lstrip("/") or "index.html"
        target = (self.public_dir / relative).resolve()
        try:
            target.relative_to(self.public_dir)
        except ValueError:
            return self._error(403, "越权访问")
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            if "." not in Path(relative).name:
                target = self.public_dir / "index.html"
            else:
                return self._error(404, f"找不到文件：{relative}")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        return self._send(200, target.read_bytes(), ctype)


ENDPOINTS = [
    {"method": "GET", "path": "/api/health", "desc": "服务信息、数据库文件、版本号、迁移情况"},
    {"method": "GET", "path": "/api/index", "desc": "轻量目录：每话的计数与元信息，不含槽位内容"},
    {"method": "GET", "path": "/api/chapters/{id}", "desc": "读取一话（含槽位与角色编号）"},
    {"method": "GET", "path": "/api/chapters/{id}/panels/{pid}", "desc": "读取单个槽位"},
    {"method": "GET", "path": "/api/db", "desc": "读取完整文档（带内部 id，界面用它做镜像）"},
    {"method": "POST", "path": "/api/db/patch", "desc": "★ 增量写入：body={revision, ops:[...], force?, label?}"},
    {"method": "PUT", "path": "/api/db", "desc": "整库替换；body={revision, db, force?}"},
    {"method": "POST", "path": "/api/db/import", "desc": "从 JSON 文件或对象导入；body={path} 或 {db}"},
    {"method": "POST", "path": "/api/db/clear", "desc": "清空所有数据"},
    {"method": "POST", "path": "/api/db/validate", "desc": "只校验不写入"},
    {"method": "GET", "path": "/api/db/export?format=json|csv|md|sqlite", "desc": "导出（JSON 不含 id）"},
    {"method": "GET", "path": "/api/db/raw", "desc": "交换格式 JSON 文本"},
    {"method": "GET", "path": "/api/stats", "desc": "角色出场次数等派生统计"},
    {"method": "GET", "path": "/api/find?char=12", "desc": "某个角色出现在哪些话/槽位"},
    {"method": "GET", "path": "/api/search?q=文字", "desc": "按标题/备注/角色名搜索"},
    {"method": "GET", "path": "/api/log?limit=50", "desc": "最近改动记录"},
    {"method": "GET", "path": "/api/backups", "desc": "快照列表"},
    {"method": "POST", "path": "/api/backups", "desc": "立即创建快照；body={tag}"},
    {"method": "POST", "path": "/api/backups/restore", "desc": "回滚到某个快照；body={name}"},
    {"method": "GET", "path": "/api/publish/status", "desc": "公开站数据的已发布版本与 Git 状态"},
    {"method": "POST", "path": "/api/publish", "desc": "导出 docs/data 并 commit / push（仅本机）"},
    {"method": "GET", "path": "/api/help", "desc": "接口与补丁操作清单"},
]


def pick_port(host: str, port: int) -> int:
    for candidate in range(port, port + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, candidate))
                return candidate
            except OSError:
                continue
    raise SystemExit(f"从 {port} 起连续 20 个端口都被占用了，换一个 --port 吧")


def run_server(data_file: Path, public_dir: Path, host: str = "127.0.0.1", port: int = 8777,
               open_browser: bool = False, quiet: bool = False,
               allowed_origins: Optional[List[str]] = None,
               legacy_json: Optional[Path] = None,
               backup_interval: float = 600.0) -> ThreadingHTTPServer:
    database = GirlsDB(data_file, backup_interval=backup_interval, legacy_json=legacy_json)
    database.initialize()
    handler = type("BoundHandler", (Handler,), {
        "database": database,
        "public_dir": public_dir.resolve(),
        "allowed_origins": allowed_origins or [],
        "quiet": quiet,
    })
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{httpd.server_address[1]}/"
    if not quiet:
        print(f"┌─ {APP_TITLE} ({APP_NAME}) v{APP_VERSION}　存储：SQLite")
        print(f"│  前端页面 : {url}")
        print(f"│  数据库   : {database.path}")
        print(f"│  备份目录 : {database.backup_dir}")
        if database.migration and database.migration.get("ok"):
            print(f"│  已迁移   : {database.migration['source']} → "
                  f"{database.migration['chapters']} 话 / {database.migration['panels']} 槽位")
            if database.migration.get("archived"):
                print(f"│  （旧 JSON 已归档到 {database.migration['archived']}）")
        print("└─ Ctrl+C 停止服务")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    return httpd


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=f"{APP_TITLE} 本地服务端（SQLite 存储）")
    parser.add_argument("--data", default=str(DEFAULT_DATA), help="SQLite 数据库文件路径")
    parser.add_argument("--public", default=str(DEFAULT_PUBLIC), help="管理端静态目录（默认 public/）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址")
    parser.add_argument("--port", type=int, default=8777, help="监听端口（占用会顺延）")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    parser.add_argument("--quiet", action="store_true", help="不打印访问日志")
    parser.add_argument("--allow-origin", action="append", default=[], help="额外允许的跨域来源")
    parser.add_argument("--backup-interval", type=float, default=600.0,
                        help="两次自动快照的最小间隔（秒），0 表示关闭")
    parser.add_argument("--legacy-json", default=str(DEFAULT_LEGACY),
                        help="旧版单文件 JSON 的位置，仅用于首次自动迁移")
    parser.add_argument("--migrate-json", default="",
                        help="手工迁移指定的 JSON 文件后退出（不启动服务）")
    parser.add_argument("--check", action="store_true", help="自检并打印概览后退出")
    args = parser.parse_args(argv)

    data_file = Path(args.data)
    public_dir = Path(args.public)
    legacy = Path(args.legacy_json) if args.legacy_json else None

    if args.migrate_json:
        source = Path(args.migrate_json).resolve()
        if not source.is_file():
            print(f"找不到要迁移的 JSON：{source}", file=sys.stderr)
            return 2
        database = GirlsDB(data_file, backup_interval=0, legacy_json=None)
        database.initialize()
        result = database.import_json(source, archive=True)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if not public_dir.is_dir():
        print(f"找不到前端目录：{public_dir}", file=sys.stderr)
        return 2

    database = GirlsDB(data_file, backup_interval=args.backup_interval, legacy_json=legacy)
    database.initialize()
    if args.check:
        index = database.load_index()
        print(json.dumps({
            "ok": True, "storage": "sqlite", "dataFile": str(database.path),
            "size": database.db_size(), "revision": index["revision"],
            "stats": index["stats"], "migration": database.migration,
            "issues": database.integrity_check(),
        }, ensure_ascii=False, indent=2))
        return 0

    port = pick_port(args.host, args.port)
    httpd = run_server(data_file, public_dir, host=args.host, port=port, open_browser=args.open,
                       quiet=args.quiet, allowed_origins=args.allow_origin, legacy_json=legacy,
                       backup_interval=args.backup_interval)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    harden_stdio()
    raise SystemExit(main())
