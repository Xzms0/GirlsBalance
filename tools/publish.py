#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""导出公开站数据（docs/data），可选提交并推送。

用法：
    python tools/publish.py --export-only       # 只生成 docs/data，不碰 Git
    python tools/publish.py                     # 生成 + commit + push
    python tools/publish.py --no-push           # 生成 + commit，不 push
    python tools/publish.py --message "data: 第 12 话" --no-push
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from girls_db import GirlsDB  # noqa: E402
from site_publish import publish_site  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="导出 docs/data 分片 JSON，并可选提交到 Git")
    parser.add_argument("--data", default=str(ROOT / "data" / "girls_dict.sqlite3"),
                        help="SQLite 数据库路径")
    parser.add_argument("--message", default="", help="Git commit message")
    parser.add_argument("--export-only", action="store_true", help="只导出，不 commit / push")
    parser.add_argument("--no-push", action="store_true", help="commit 但不 push")
    parser.add_argument("--force", action="store_true", help="允许用空数据库覆盖已有公开数据")
    args = parser.parse_args(argv)

    data_file = Path(args.data)
    if not data_file.is_file():
        print(f"找不到数据库：{data_file}", file=sys.stderr)
        return 2

    database = GirlsDB(data_file, backup_interval=0)
    database.initialize()
    result = publish_site(
        database,
        ROOT,
        message=args.message,
        export_only=args.export_only,
        push=not args.no_push,
        force=args.force,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
