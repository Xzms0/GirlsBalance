#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端验收脚本：把服务端当成黑盒跑一遍（不参与 unittest discover）。

    python tests/verify_server.py                    # 只查正在运行的服务（默认 8777）
    python tests/verify_server.py --spawn            # 自己拉起临时服务（Python + Node）再验，结束后清理

检查内容：静态托管、health/index/chapters/db/patch/import/export/stats/find/search/log/backups
以及 409 冲突、400 非法补丁、CORS、导出 JSON 不含 id、快照回滚、完整性。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

NODE_CANDIDATES = [
    shutil.which("node"),
    str(Path.home() / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies" / "node" / "bin" / "node.exe"),
]

PASSED: list = []
FAILED: list = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    (PASSED if condition else FAILED).append(label)
    print(("  ok   " if condition else "  FAIL ") + label + (f"   {detail}" if detail else ""))
    return bool(condition)


def request(url: str, method: str = "GET", payload=None, timeout: float = 15.0):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def get_json(url: str, method: str = "GET", payload=None):
    status, headers, body = request(url, method, payload)
    try:
        return status, json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return status, {"__raw__": body[:200].decode("utf-8", "replace")}


def start(command: list, log_path: Path):
    log = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(command, cwd=str(ROOT), stdout=log, stderr=subprocess.STDOUT)
    time.sleep(2.5)
    return process, log


def exercise_readonly(base: str, label: str) -> None:
    """只读检查：不会改动任何数据，可以安全地对正在使用的服务跑。"""
    print(f"\n== {label}（只读检查）==")
    status, health = get_json(f"{base}/api/health")
    check(f"{label}: GET /api/health", status == 200 and health.get("storage") == "sqlite",
          f"storage={health.get('storage')} v{health.get('storageVersion')}")
    check(f"{label}: 报告编号范围 [0,100]", health.get("charMin") == 0 and health.get("charMax") == 100)

    status, index = get_json(f"{base}/api/index")
    check(f"{label}: GET /api/index 是轻量目录",
          status == 200 and "chapters" in index and "stats" in index, str(index.get("stats")))
    if index.get("chapters"):
        first = index["chapters"][0]
        check(f"{label}: 目录项带计数（不含内容）",
              {"panels", "chars", "appearances"} <= set(first), str({k: first[k] for k in ("no", "panels", "chars")}))
        status, chapter = get_json(f"{base}/api/chapters/{first['id']}")
        check(f"{label}: GET /api/chapters/{{id}}", status == 200 and len(chapter["chapter"]["panels"]) == first["panels"])

    status, document = get_json(f"{base}/api/db")
    check(f"{label}: GET /api/db", status == 200 and "db" in document, f"revision={document.get('revision')}")

    status, found = get_json(f"{base}/api/find?char=2")
    check(f"{label}: GET /api/find", status == 200 and found["count"] >= 0, f"{found.get('count')} 处")
    status, stats = get_json(f"{base}/api/stats")
    check(f"{label}: GET /api/stats", status == 200 and "characters" in stats["stats"])
    status, log = get_json(f"{base}/api/log?limit=5")
    check(f"{label}: GET /api/log", status == 200 and isinstance(log.get("log"), list))
    status, listing = get_json(f"{base}/api/backups")
    check(f"{label}: GET /api/backups", status == 200 and isinstance(listing.get("backups"), list),
          f"{len(listing.get('backups', []))} 份")

    status, headers, body = request(f"{base}/api/db/export?format=json")
    text = body.decode("utf-8")
    exported = json.loads(text)
    check(f"{label}: 导出 JSON 不含任何 id", '"id"' not in text and "pn-" not in text and "ch-" not in text)
    check(f"{label}: 导出 JSON 结构正确",
          exported["schema"] == "girls_dict"
          and (not exported["chapters"] or set(exported["chapters"][0]) == {"no", "title", "note", "panels"}))
    for fmt, needle in (("csv", b"chapter_no"), ("md", b"#"), ("sqlite", b"SQLite format 3")):
        status, headers, body = request(f"{base}/api/db/export?format={fmt}")
        check(f"{label}: 导出 {fmt}", status == 200 and body[:64].find(needle) >= 0 or needle in body[:64])

    for path, needle in [("/", b"girls_dict"), ("/index.html", b"js/model.js"), ("/js/model.js", b"buildPatch"),
                         ("/js/adapters.js", b"createIndexedDbAdapter"), ("/js/store.js", b"buildPatch"),
                         ("/js/ui.js", b"renderKeypad"), ("/js/app.js", b"export-sqlite"),
                         ("/css/styles.css", b"--accent")]:
        status, headers, body = request(f"{base}{path}")
        check(f"{label}: 静态 {path}", status == 200 and needle in body, f"{len(body)} bytes")

    req = urllib.request.Request(f"{base}/api/db", method="OPTIONS",
                                 headers={"Origin": "null", "Access-Control-Request-Method": "POST"})
    with urllib.request.urlopen(req, timeout=10) as response:
        check(f"{label}: file:// 页面可跨域访问", response.headers.get("Access-Control-Allow-Origin") == "null")

    # 危险操作必须被挡住：不带 revision / force 的整库替换。
    # 用「当前文档」当探测载荷：万一防线失效，写进去的也和现在一模一样，不会破坏数据。
    if index.get("chapters") and document.get("db"):
        status, guarded = get_json(f"{base}/api/db", "PUT", {"db": document["db"]})
        check(f"{label}: 无 revision 的整库替换被拒绝（非空库）", status == 400, f"HTTP {status}")
        still = get_json(f"{base}/api/index")[1]["stats"]["chapters"]
        check(f"{label}: 被拒绝后数据没变", still == index["stats"]["chapters"], f"{still} 话")
    else:
        print("       （库是空的，跳过整库替换防线探测：空库允许写入）")


def exercise_writes(base: str, label: str, sample: dict) -> None:
    """会写入数据的完整检查：只对临时服务使用。

    每一步都先问服务端「现在 revision 是多少」，不做任何硬编码假设，
    这样无论前面的检查有没有动过数据，这里都能跑。
    """
    print(f"\n== {label}（写入检查）==")

    status, health = get_json(f"{base}/api/health")
    check(f"{label}: 目标库是空的（可以安全写入）", health.get("chapters") == 0, f"{health.get('chapters')} 话")

    # 用 import 灌样例：这个端点本身就是「整库替换」，不需要 revision
    status, imported = get_json(f"{base}/api/db/import", "POST", {"db": sample})
    check(f"{label}: POST /api/db/import", status == 200 and imported["chapters"] == 3,
          f"{imported.get('chapters')} 话 / {imported.get('panels')} 槽位")

    status, payload = get_json(f"{base}/api/db")
    revision = payload["revision"]
    document = payload["db"]
    check(f"{label}: GET /api/db", status == 200 and len(document["chapters"]) == 3, f"revision={revision}")

    # 整库替换的意图防线（此时库是非空的）
    status, guarded = get_json(f"{base}/api/db", "PUT", {"db": document})
    check(f"{label}: 无 revision/force 的整库替换被拒绝", status == 400, f"HTTP {status}")
    status, forced = get_json(f"{base}/api/db", "PUT", {"revision": revision, "db": document})
    check(f"{label}: 带 revision 的整库替换成功且回传整库",
          status == 200 and forced["revision"] == revision + 1 and "db" in forced,
          f"revision={forced.get('revision')}")
    revision = forced["revision"]

    chapter = document["chapters"][0]
    panel_id = chapter["panels"][0]["id"]

    status, patch = get_json(f"{base}/api/db/patch", "POST",
                             {"revision": revision,
                              "ops": [{"op": "panel.chars", "panelId": panel_id, "chars": [7, 3, 3]}]})
    check(f"{label}: POST /api/db/patch 增量写入", status == 200 and patch["applied"] == ["panel.chars"],
          f"revision={patch.get('revision')} issues={len(patch.get('issues', []))}")
    check(f"{label}: 补丁不回传整库（保持 O(改动量)）", "db" not in patch)
    revision = patch["revision"]

    status, chapter_payload = get_json(f"{base}/api/chapters/{chapter['id']}")
    check(f"{label}: 编号被去重并升序", chapter_payload["chapter"]["panels"][0]["chars"] == [3, 7])

    status, one = get_json(f"{base}/api/chapters/{chapter['id']}/panels/{panel_id}")
    check(f"{label}: GET 单个槽位", status == 200 and one["panel"]["chars"] == [3, 7])

    status, conflict = get_json(f"{base}/api/db/patch", "POST",
                                {"revision": revision - 1,
                                 "ops": [{"op": "panel.chars", "panelId": panel_id, "chars": [1]}]})
    check(f"{label}: 旧 revision 返回 409", status == 409 and "db" in conflict, f"HTTP {status}")
    status, bad = get_json(f"{base}/api/db/patch", "POST", {"ops": [{"op": "panel.explode"}]})
    check(f"{label}: 非法 op 返回 400", status == 400 and bad.get("opIndex") == 0, bad.get("error", "")[:60])
    status, bad = get_json(f"{base}/api/db/patch", "POST",
                           {"ops": [{"op": "panel.chars", "panelId": "pn-x", "chars": [1]}]})
    check(f"{label}: 不存在的槽位被拒绝且回滚", status == 400)
    still = get_json(f"{base}/api/db")[1]
    check(f"{label}: 失败的补丁没有消耗 revision", still["revision"] == revision, f"{still['revision']} vs {revision}")

    ids = [c["id"] for c in still["db"]["chapters"]]
    status, moved = get_json(f"{base}/api/db/patch", "POST",
                             {"revision": revision, "ops": [{"op": "chapter.swap", "a": ids[0], "b": ids[2]}]})
    check(f"{label}: chapter.swap 成功", status == 200)
    after = get_json(f"{base}/api/db")[1]["db"]
    check(f"{label}: 交换后编号仍是 1..N", [c["no"] for c in after["chapters"]] == [1, 2, 3])
    check(f"{label}: 交换后顺序确实变了", after["chapters"][2]["id"] == ids[0])

    status, found = get_json(f"{base}/api/find?char=100")
    check(f"{label}: GET /api/find 找到 2 处", status == 200 and found["count"] == 2, f"{found.get('count')} 处")
    status, searched = get_json(f"{base}/api/search?q={urllib.parse.quote('放学')}")
    check(f"{label}: GET /api/search", status == 200 and searched["chapters"][0]["title"] == "放学后")
    status, stats = get_json(f"{base}/api/stats")
    check(f"{label}: GET /api/stats", status == 200 and stats["stats"]["distinct_chars"] >= 6
          and stats["stats"]["panels"] > 0, str(stats.get("stats")))

    status, validated = get_json(f"{base}/api/db/validate", "POST",
                                 {"db": {"chapters": [{"panels": [{"chars": [1, 999, "x"]}]}]}})
    check(f"{label}: POST /api/db/validate 能发现问题", status == 200 and validated["valid"] is False,
          f"{len(validated['issues'])} 处")

    status, backup = get_json(f"{base}/api/backups", "POST", {"tag": "verify"})
    check(f"{label}: POST /api/backups", status == 200 and backup.get("backup", "").endswith(".sqlite3"),
          backup.get("backup"))
    status, listing = get_json(f"{base}/api/backups")
    check(f"{label}: GET /api/backups", status == 200 and len(listing["backups"]) >= 1,
          f"{len(listing.get('backups', []))} 份")
    status, cleared = get_json(f"{base}/api/db/clear", "POST", {})
    check(f"{label}: POST /api/db/clear", status == 200 and get_json(f"{base}/api/stats")[1]["stats"]["chapters"] == 0)
    status, restored = get_json(f"{base}/api/backups/restore", "POST", {"name": backup["backup"]})
    check(f"{label}: 回滚快照", status == 200 and restored["db"] and len(restored["db"]["chapters"]) == 3,
          f"revision={restored.get('revision')}")

    status, imported_again = get_json(f"{base}/api/db/import", "POST", {"db": sample})
    check(f"{label}: 再次导入样例成功", status == 200 and imported_again["chapters"] == 3)


def main() -> int:
    parser = argparse.ArgumentParser(description="girls_dict 服务端端到端验收")
    parser.add_argument("--base", default="http://127.0.0.1:8777",
                        help="已在运行的服务地址（默认只做只读检查）")
    parser.add_argument("--spawn", action="store_true",
                        help="自己拉起临时服务（Python + Node）做完整检查，包括写入，结束后清理")
    parser.add_argument("--allow-write", action="store_true",
                        help="对 --base 指向的服务也做写入检查（危险：会覆盖那里的数据）")
    args = parser.parse_args()

    sample = json.loads((ROOT / "data" / "sample.girls_dict.json").read_text(encoding="utf-8"))

    if not args.spawn:
        try:
            exercise_readonly(args.base, "已运行的服务")
        except Exception as exc:
            check(f"连上 {args.base}", False, f"{type(exc).__name__}: {exc}")
            print("      （服务没起来？双击 start.bat，或用 --spawn 让脚本自己拉一个临时服务）")
        if args.allow_write:
            exercise_writes(args.base, "已运行的服务", sample)
        elif not FAILED:
            print("\n（只做了只读检查；要对正在运行的服务做写入检查，请加 --allow-write，"
                  "或直接 --spawn 用临时数据库验证）")
    else:
        tmp = ROOT / ".tmp-tests" / "verify"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True, exist_ok=True)
        servers = []
        try:
            process, log = start([sys.executable, "server/server.py", "--port", "8791", "--quiet",
                                  "--data", str(tmp / "python.sqlite3")], tmp / "python.log")
            servers.append((process, log))
            try:
                exercise_readonly("http://127.0.0.1:8791", "Python 服务端")
                exercise_writes("http://127.0.0.1:8791", "Python 服务端", sample)
            except Exception as exc:  # 服务没起来也不能让整个脚本挂掉
                check("Python 服务端: 整体可用", False, f"{type(exc).__name__}: {exc}")

            node = next((path for path in NODE_CANDIDATES if path and Path(path).is_file()), None)
            if node:
                process, log = start([node, "server/server.js", "--port", "8792", "--quiet",
                                      "--data", str(tmp / "node.sqlite3")], tmp / "node.log")
                servers.append((process, log))
                try:
                    exercise_readonly("http://127.0.0.1:8792", "Node 服务端")
                    exercise_writes("http://127.0.0.1:8792", "Node 服务端", sample)
                except Exception as exc:
                    check("Node 服务端: 整体可用", False, f"{type(exc).__name__}: {exc}")
                    if (tmp / "node.log").is_file():
                        print("      （Node 服务端日志尾部）" +
                              (tmp / "node.log").read_text(encoding="utf-8", errors="replace")[-400:])
            else:
                print("\n（没有找到 Node.js，跳过 Node 服务端）")
        finally:
            for process, log in servers:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                log.close()
            shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        print("失败项：\n  " + "\n  ".join(FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
