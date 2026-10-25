#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""girls_dict 命令行工具（SQLite 存储）—— 证明「数据库可以脱离前端单独使用」。

例子：
    python tools/gd.py info                          # 概览：多少话、多少槽位、库多大
    python tools/gd.py stats                         # 角色出场次数排行
    python tools/gd.py index                         # 轻量目录（每话的计数）
    python tools/gd.py validate                      # 完整性 + 内容检查
    python tools/gd.py sql "SELECT no, title FROM chapter ORDER BY no LIMIT 5"
    python tools/gd.py find 12                       # 角色 12 出现在哪
    python tools/gd.py export --format csv -o out.csv
    python tools/gd.py export --format json          # 导出 JSON
    python tools/gd.py add-chapter --title "番外" --panels 3
    python tools/gd.py set 1 2 3 7 9                 # 第 1 话第 2 个槽位 = 角色 3/7/9
    python tools/gd.py swap 1 3                      # 对换第 1、3 话并修正编号
    python tools/gd.py log --limit 20                # 最近的改动
    python tools/gd.py backup --tag before-edit
    python tools/gd.py backups
    python tools/gd.py restore girls_dict-20260214-101500.sqlite3
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from girls_db import (  # noqa: E402
    GirlsDB,
    OpError,
    RevisionConflict,
    ValidationError,
    clean_chars,
    new_id,
    validate_export_document,
)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "data" / "girls_dict.sqlite3"
# `set` 允许自动补空槽位，但必须挡住手滑输入的超大下标（例如把 10 打成 100000000）。
MAX_PANEL_INDEX = 10000


def harden_stdio() -> None:
    """控制台编码不支持中文时不至于抛 UnicodeEncodeError（宁可显示成 ? ）。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="超超你的字典 · 命令行工具（SQLite）")
    parser.add_argument("--data", default=str(DEFAULT_DATA), help="SQLite 数据库文件路径")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出（便于脚本调用）")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="数据库文件、规模与版本概览")
    sub.add_parser("index", help="轻量目录：每话的槽位/角色计数")
    sub.add_parser("stats", help="角色出现次数（按分镜计）")
    sub.add_parser("validate", help="完整性检查 + 数据检查")
    sub.add_parser("log", help="最近的改动记录").add_argument("--limit", type=int, default=20)

    p_sql = sub.add_parser("sql", help="执行只读 SQL（SELECT / PRAGMA / WITH）")
    p_sql.add_argument("query")
    p_sql.add_argument("--limit", type=int, default=200)

    p_export = sub.add_parser("export", help="导出 json / csv")
    p_export.add_argument("--format", default="json", choices=["json", "csv"])
    p_export.add_argument("-o", "--out", default="", help="输出文件；不填则打印到标准输出")

    p_find = sub.add_parser("find", help="查找某个角色出现在哪些话/槽位")
    p_find.add_argument("char", type=int)

    p_add = sub.add_parser("add-chapter", help="新增一话")
    p_add.add_argument("--title", default="")
    p_add.add_argument("--panels", type=int, default=0, help="同时创建几个空槽位")

    p_set = sub.add_parser("set", help="设置某话某槽位的角色编号（整体覆盖该槽位）")
    p_set.add_argument("chapter", type=int)
    p_set.add_argument("panel", type=int)
    p_set.add_argument("chars", type=int, nargs="*")

    p_swap = sub.add_parser("swap", help="交换两话的顺序并修正编号")
    p_swap.add_argument("a", type=int)
    p_swap.add_argument("b", type=int)

    sub.add_parser("renumber", help="按当前顺序重排话编号")

    p_backup = sub.add_parser("backup", help="立即创建快照")
    p_backup.add_argument("--tag", default="")
    sub.add_parser("backups", help="列出快照")

    p_restore = sub.add_parser("restore", help="回滚到某个快照")
    p_restore.add_argument("name")

    p_import = sub.add_parser("import", help="导入严格 v2 JSON（整库替换，保留源文件）")
    p_import.add_argument("source")

    return parser


def emit(args: argparse.Namespace, payload: Any, text: str) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2) if args.json else text)


def chapter_by_no(database: GirlsDB, no: int) -> Optional[Dict[str, Any]]:
    for chapter in database.load_index()["chapters"]:
        if chapter["no"] == no:
            return database.load_chapter(chapter["id"])
    return None


def run_import(args: argparse.Namespace) -> int:
    """先校验文件、再初始化数据库；避免无效输入留下一个新建的空库。"""
    source = Path(args.source)
    if not source.is_file():
        print(f"找不到文件：{source}", file=sys.stderr)
        return 1
    try:
        # utf-8-sig 顺带接受 Windows 编辑器常见的 UTF-8 BOM。
        payload = json.loads(source.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        print(f"导入失败：{source} 不是合法的 UTF-8 JSON（{error}）", file=sys.stderr)
        return 1
    issues = validate_export_document(payload)
    if issues:
        print(f"导入失败：{source} 不符合当前格式（需要 schemaVersion=2，且不含内部 id）", file=sys.stderr)
        for item in issues[:10]:
            print(f"  - {item['path']}: {item['message']}", file=sys.stderr)
        if len(issues) > 10:
            print(f"  ……另有 {len(issues) - 10} 处问题", file=sys.stderr)
        return 1
    database = GirlsDB(args.data, backup_interval=0)
    try:
        database.initialize()
        result = database.import_json(payload)
    finally:
        database.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    command = args.command

    # 导入走独立入口：文件校验失败时不应创建/改动数据库。
    if command == "import":
        return run_import(args)

    database = GirlsDB(args.data, backup_interval=0)
    database.initialize()

    if command == "info":
        index = database.load_index()
        payload = {
            "dataFile": str(database.path), "size": database.db_size(),
            "revision": index["revision"], "updatedAt": index["updatedAt"],
            "stats": index["stats"], "issues": database.integrity_check(),
        }
        emit(args, payload, "\n".join([
            f"数据库文件 : {database.path}",
            f"文件大小   : {payload['size'] / 1024:.1f} KB（含 WAL）",
            f"版本号     : {index['revision']}    最后写入 : {index['updatedAt']}",
            f"话数       : {index['stats']['chapters']}",
            f"槽位总数   : {index['stats']['panels']}",
            f"出现角色   : {index['stats']['distinct_chars']} 位，共 {index['stats']['appearances']} 次出场",
            f"完整性检查 : {'通过 ✅' if not payload['issues'] else str(len(payload['issues'])) + ' 处问题'}",
        ]))
        return 0

    if command == "index":
        index = database.load_index()
        lines = [f"{'话':>4} {'槽位':>4} {'角色':>4} {'人次':>5}  标题"]
        for chapter in index["chapters"]:
            lines.append(f"{chapter['no']:>4} {chapter['panels']:>4} {chapter['chars']:>4} "
                         f"{chapter['appearances']:>5}  {chapter['title']}")
        emit(args, index, "\n".join(lines) if len(lines) > 1 else "（还没有任何数据）")
        return 0

    if command == "stats":
        stats = database.stats()
        lines = [f"{'编号':>4} {'角色名':<12} 出场分镜数"]
        for row in stats["characters"]:
            lines.append(f"{row['char']:>4} {row['name'] or '—':<12} {row['panels']}")
        emit(args, stats, "\n".join(lines) if len(lines) > 1 else "（还没有任何数据）")
        return 0

    if command == "validate":
        issues = database.integrity_check()
        errors = [i for i in issues if i["level"] == "error"]
        text = "数据库检查通过 ✅" if not issues else "\n".join(
            f"[{i['level']}] {i['path']}: {i['message']}" for i in issues)
        emit(args, {"valid": not errors, "issues": issues}, text)
        return 0 if not errors else 1

    if command == "log":
        rows = database.recent_log(args.limit)
        lines = [f"{r['at']}  rev{r['revision']:<6} {r['action']:<28} {r['detail']}" for r in rows]
        emit(args, rows, "\n".join(lines) if rows else "（暂无记录）")
        return 0

    if command == "sql":
        query = args.query.strip()
        head = query.split(None, 1)[0].lower() if query else ""
        if head not in ("select", "pragma", "with", "explain"):
            print("只允许只读查询（SELECT / PRAGMA / WITH / EXPLAIN）", file=sys.stderr)
            return 2
        connection = database.connect()
        try:
            # SQLite 的 query_only 会拒绝一切写入，也包括 PRAGMA xxx=yyy 这类
            # 看着像查询、实际会改库的语句，保证这里的“只读”名副其实。
            connection.execute("PRAGMA query_only = ON")
            cursor = connection.execute(query)
            rows = [dict(row) for row in cursor.fetchmany(max(1, args.limit))]
            columns = [d[0] for d in cursor.description or []]
        except sqlite3.Error as exc:
            print(f"SQL 执行失败：{exc}", file=sys.stderr)
            return 1
        finally:
            connection.close()
        if args.json:
            print(json.dumps(rows, ensure_ascii=False, indent=2))
        else:
            if not columns:
                print("（没有返回结果）")
            else:
                print("  ".join(columns))
                for row in rows:
                    print("  ".join("" if row[c] is None else str(row[c]) for c in columns))
                print(f"（{len(rows)} 行）")
        return 0

    if command == "export":
        if args.format == "csv":
            text = database.export_csv()
        else:
            text = database.export_json()
        if args.out:
            Path(args.out).write_text(text, encoding="utf-8")
            print(f"已写入 {args.out}")
        else:
            sys.stdout.write(text)
        return 0

    if command == "find":
        hits = database.find_char(args.char)
        lines = [f"角色 {args.char} 出现在 {len(hits)} 个槽位：" if hits else f"角色 {args.char} 没有出现记录。"]
        for hit in hits:
            title = f" {hit['chapterTitle']}" if hit["chapterTitle"] else ""
            lines.append(f"  第 {hit['chapterNo']} 话{title} · 槽位 {hit['panelIndex']}")
        emit(args, {"char": args.char, "count": len(hits), "hits": hits}, "\n".join(lines))
        return 0

    if command == "add-chapter":
        panels = [{"id": new_id("pn"), "chars": []} for _ in range(max(0, args.panels))]
        database.apply_patch([{
            "op": "chapter.upsert",
            "chapter": {"id": new_id("ch"), "title": args.title, "note": ""},
            "panels": panels,
        }], label="cli:add-chapter")
        total = len(database.load_index()["chapters"])
        print(f"已新增第 {total} 话（{len(panels)} 个槽位），当前共 {total} 话")
        return 0

    if command == "set":
        chapter = chapter_by_no(database, args.chapter)
        if chapter is None:
            print(f"没有第 {args.chapter} 话", file=sys.stderr)
            return 1
        panels: List[Dict[str, Any]] = chapter["panels"]
        if args.panel < 1:
            print("槽位编号从 1 开始", file=sys.stderr)
            return 1
        if args.panel > MAX_PANEL_INDEX:
            print(f"槽位编号过大：上限为 {MAX_PANEL_INDEX}", file=sys.stderr)
            return 1
        chars_issues: List[Dict[str, str]] = []
        ops: List[Dict[str, Any]] = []
        for index in range(len(panels), args.panel):
            panels.append({"id": new_id("pn"), "chars": []})
            ops.append({"op": "panel.upsert", "chapterId": chapter["id"],
                        "panel": {"id": panels[index]["id"], "chars": []}, "position": index + 1})
        target = panels[args.panel - 1]
        chars = clean_chars(args.chars, chars_issues)
        for item in chars_issues:
            print(f"警告：{item['message']}", file=sys.stderr)
        ops.append({"op": "panel.chars", "panelId": target["id"], "chars": chars})
        database.apply_patch(ops, label="cli:set")
        updated = chapter_by_no(database, args.chapter)
        print(f"第 {args.chapter} 话 · 槽位 {args.panel} = {updated['panels'][args.panel - 1]['chars']}")
        return 0

    if command == "swap":
        index = database.load_index()["chapters"]
        ids = {chapter["no"]: chapter["id"] for chapter in index}
        if args.a not in ids or args.b not in ids:
            print("话编号超出范围", file=sys.stderr)
            return 1
        if args.a == args.b:
            print("两话编号相同，无需交换", file=sys.stderr)
            return 1
        database.apply_patch([{"op": "chapter.swap", "a": ids[args.a], "b": ids[args.b]}],
                             label="cli:swap")
        order = [f"{c['no']}. {c['title'] or '（未命名）'}" for c in database.load_index()["chapters"]]
        print("已交换第 %d 话与第 %d 话，编号已修正：\n  %s" % (args.a, args.b, "\n  ".join(order)))
        return 0

    if command == "renumber":
        ids = [chapter["id"] for chapter in database.load_index()["chapters"]]
        database.apply_patch([{"op": "chapter.order", "ids": ids}], label="cli:renumber")
        print(f"已按顺序重排 {len(ids)} 话的编号")
        return 0

    if command == "backup":
        target = database.create_backup(tag=args.tag)
        print(f"已创建快照 {target}")
        return 0

    if command == "backups":
        items = database.list_backups()
        if args.json:
            print(json.dumps(items, ensure_ascii=False, indent=2))
        else:
            for item in items:
                print(f"{item['mtime']}  {item['size']:>9} B  {item['name']}")
            if not items:
                print("（暂无快照）")
        return 0

    if command == "restore":
        result = database.restore_backup(args.name)
        print(f"已回滚到 {args.name}，当前 revision={result['revision']}")
        return 0

    print(f"未知命令：{command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    harden_stdio()
    try:
        raise SystemExit(main())
    except (RevisionConflict, OpError, ValidationError) as error:
        print(f"执行失败：{error}", file=sys.stderr)
        raise SystemExit(1)
    except FileNotFoundError as error:
        print(f"执行失败：{error}", file=sys.stderr)
        raise SystemExit(1)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        print(f"执行失败：不是合法的 UTF-8 JSON（{error}）", file=sys.stderr)
        raise SystemExit(1)
    except OSError as error:
        print(f"执行失败：{error}", file=sys.stderr)
        raise SystemExit(1)
