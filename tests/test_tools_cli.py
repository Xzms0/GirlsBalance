#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/gd.py 与 tools/publish.py 的命令行行为测试（子进程，独立临时库）。

覆盖：只读 SQL 的写入防线、导入失败不建库且无 traceback、
restore 缺快照的可读报错、超大槽位下标、发布时打开坏库的报错。
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "data" / "sample.girls_dict.json"
GD = ROOT / "tools" / "gd.py"
PUBLISH = ROOT / "tools" / "publish.py"

sys.path.insert(0, str(ROOT / "server"))

from girls_db import GirlsDB  # noqa: E402


def run(script: Path, *args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )


class ToolsCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = ROOT / ".tmp-test-run" / f"cli-{uuid.uuid4().hex[:12]}"
        self.dir.mkdir(parents=True)
        self.db = self.dir / "girls.sqlite3"

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def seed(self) -> None:
        result = run(GD, "--data", str(self.db), "import", str(SAMPLE))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_sql_really_rejects_writes(self) -> None:
        self.seed()
        result = run(GD, "--data", str(self.db), "sql", "PRAGMA user_version=7")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 0)

    def test_import_bad_json_is_clean_and_creates_no_database(self) -> None:
        bad = self.dir / "bad.json"
        bad.write_text("{oops", encoding="utf-8")
        result = run(GD, "--data", str(self.db), "import", str(bad))
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("不是合法的 UTF-8 JSON", result.stderr)
        self.assertFalse(self.db.exists(), "校验失败不应创建空数据库")

    def test_import_wrong_version_is_clean_and_creates_no_database(self) -> None:
        payload = json.loads(SAMPLE.read_text(encoding="utf-8"))
        payload["schemaVersion"] = 1
        bad = self.dir / "old.json"
        bad.write_text(json.dumps(payload), encoding="utf-8")
        result = run(GD, "--data", str(self.db), "import", str(bad))
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("不符合当前格式", result.stderr)
        self.assertFalse(self.db.exists())

    def test_import_accepts_utf8_bom(self) -> None:
        bom = self.dir / "bom.json"
        bom.write_bytes(b"\xef\xbb\xbf" + SAMPLE.read_bytes())
        result = run(GD, "--data", str(self.db), "import", str(bom))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.db.is_file())
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM chapter").fetchone()[0], 3)

    def test_restore_missing_snapshot_is_a_clean_error(self) -> None:
        self.seed()
        result = run(GD, "--data", str(self.db), "restore", "missing.sqlite3")
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("找不到快照", result.stderr)

    def test_set_rejects_absurd_panel_index(self) -> None:
        self.seed()
        result = run(GD, "--data", str(self.db), "set", "1", "100000001", "1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("槽位编号过大", result.stderr)

    def test_publish_reports_bad_storage_version(self) -> None:
        bad_db = self.dir / "old.sqlite3"
        database = GirlsDB(bad_db, backup_interval=0)
        database.initialize()
        conn = database.connect()
        try:
            conn.execute("UPDATE info SET value='1' WHERE key='schema_version'")
            conn.commit()
        finally:
            conn.close()
            database.close()
        result = run(PUBLISH, "--data", str(bad_db), "--export-only")
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("无法打开数据库", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
