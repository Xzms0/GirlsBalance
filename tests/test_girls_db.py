#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""girls_dict SQLite 数据层单元测试。

运行：python -m unittest discover -s tests -t . -v
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from girls_db import (  # noqa: E402
    CHAR_MAX,
    CHAR_MIN,
    EXPORT_VERSION,
    STORAGE_VERSION,
    GirlsDB,
    OpError,
    RevisionConflict,
    ValidationError,
    validate_export_document,
    clean_chars,
    new_id,
    normalize_document,
    strip_ids,
)

SAMPLE = ROOT / "data" / "sample.girls_dict.json"


def sample_document():
    # The repository example is not the API fixture: construct a current external document.
    return strip_ids(normalize_document(json.loads(SAMPLE.read_text(encoding="utf-8"))))


class TempDirCase(unittest.TestCase):
    """每个用例一个独立目录（放在项目下的 .tmp-test-run/，用完即删）。"""

    def setUp(self) -> None:
        base = Path(__file__).resolve().parent.parent / ".tmp-test-run"
        self.dir = base / uuid.uuid4().hex[:12]
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "girls_dict.sqlite3"

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def make_db(self, **kwargs) -> GirlsDB:
        database = GirlsDB(self.path, backup_interval=0, **kwargs)
        database.initialize()
        self.addCleanup(database.close)      # 常驻连接用完要关（也能让告警安静）
        return database


class TestCleanChars(TempDirCase):
    def test_dedupes_sorts_and_accepts_strings(self) -> None:
        self.assertEqual(clean_chars([5, 1, "3", 1, 5]), [1, 3, 5])
        self.assertEqual(clean_chars(["07", 8.0, " 9 "]), [7, 8, 9])

    def test_bounds_inclusive(self) -> None:
        self.assertEqual(clean_chars([CHAR_MIN, CHAR_MAX]), [0, 100])

    def test_out_of_range_and_garbage_reported(self) -> None:
        issues = []
        self.assertEqual(clean_chars([-1, 101, 50, "abc", None, True, {}], issues), [50])
        self.assertEqual(len(issues), 6)
        self.assertTrue(all(i["level"] == "error" for i in issues))

    def test_non_list_input(self) -> None:
        self.assertEqual(clean_chars(12), [12])
        self.assertEqual(clean_chars(None), [])


class TestSchema(TempDirCase):
    def test_creates_tables_and_info(self) -> None:
        database = self.make_db()
        connection = database.connect()
        try:
            tables = {row["name"] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','index')")}
        finally:
            connection.close()
        for name in ("info", "chapter", "panel", "panel_char", "char_name", "change_log",
                     "idx_panel_chapter", "idx_panel_char_char"):
            self.assertIn(name, tables)
        connection2 = database.connect()
        try:
            self.assertEqual(int(database._info(connection2, "schema_version")), STORAGE_VERSION)
        finally:
            connection2.close()
        self.assertTrue(database.exists())

    def test_wal_and_foreign_keys_enabled(self) -> None:
        database = self.make_db()
        connection = database.connect()
        try:
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        finally:
            connection.close()

    def test_unique_constraints(self) -> None:
        database = self.make_db()
        connection = database.connect()
        try:
            connection.execute("INSERT INTO chapter(id, no, title, note) VALUES('ch-a', 1, '', '')")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("INSERT INTO chapter(id, no, title, note) VALUES('ch-b', 1, '', '')")
            connection.execute("INSERT INTO panel(id, chapter_id, position) VALUES('pn-a', 'ch-a', 1)")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("INSERT INTO panel_char(panel_id, char) VALUES('pn-a', 200)")
            connection.execute("INSERT INTO panel_char(panel_id, char) VALUES('pn-a', 5)")
            connection.execute("INSERT OR IGNORE INTO panel_char(panel_id, char) VALUES('pn-a', 5)")
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM panel_char").fetchone()[0], 1)
        finally:
            connection.close()


class TestPatch(TempDirCase):
    def test_chapter_and_panel_lifecycle(self) -> None:
        database = self.make_db()
        chapter_id = new_id("ch")
        panel_a, panel_b = new_id("pn"), new_id("pn")
        result = database.apply_patch([{
            "op": "chapter.upsert",
            "chapter": {"id": chapter_id, "title": "相遇", "note": ""},
            "panels": [{"id": panel_a, "chars": [5, 1, 1]}, {"id": panel_b, "chars": []}],
        }], expected_revision=0, label="test")
        self.assertEqual(result["revision"], 1)

        document = database.load_document()
        self.assertEqual(len(document["chapters"]), 1)
        self.assertEqual(document["chapters"][0]["title"], "相遇")
        self.assertEqual(document["chapters"][0]["panels"][0]["chars"], [1, 5], "应去重并升序")

        database.apply_patch([{"op": "panel.chars", "panelId": panel_a, "chars": [7, 7, 3]}],
                             expected_revision=1)
        self.assertEqual(database.load_chapter(chapter_id)["panels"][0]["chars"], [3, 7])

        database.apply_patch([{"op": "panel.delete", "id": panel_b}], expected_revision=2)
        self.assertEqual(len(database.load_chapter(chapter_id)["panels"]), 1)

        database.apply_patch([{"op": "chapter.update", "id": chapter_id, "note": "备注"}],
                             expected_revision=3)
        self.assertEqual(database.load_chapter(chapter_id)["note"], "备注")

        database.apply_patch([{"op": "chapter.delete", "id": chapter_id}], expected_revision=4)
        self.assertEqual(database.load_document()["chapters"], [])

    def test_panel_positions_stay_continuous(self) -> None:
        database = self.make_db()
        chapter_id = new_id("ch")
        database.apply_patch([{"op": "chapter.upsert",
                               "chapter": {"id": chapter_id, "title": "", "note": ""},
                               "panels": [{"chars": [1]}, {"chars": [2]}]}], expected_revision=0)
        chapter = database.load_chapter(chapter_id)
        first_panel = chapter["panels"][0]["id"]
        inserted = new_id("pn")
        database.apply_patch([{"op": "panel.upsert", "chapterId": chapter_id,
                               "panel": {"id": inserted, "chars": [9]}, "position": 2}])
        chapter = database.load_chapter(chapter_id)
        self.assertEqual([p["id"] for p in chapter["panels"]],
                         [first_panel, inserted, chapter["panels"][2]["id"]])
        connection = database.connect()
        try:
            positions = [r["position"] for r in connection.execute(
                "SELECT position FROM panel WHERE chapter_id = ? ORDER BY position", (chapter_id,))]
        finally:
            connection.close()
        self.assertEqual(positions, [1, 2, 3])

    def test_order_move_swap_and_renumber(self) -> None:
        database = self.make_db()
        ids = [new_id("ch") for _ in range(3)]
        database.apply_patch([{
            "op": "chapter.upsert", "chapter": {"id": cid, "title": f"第{i}", "note": ""}, "panels": []
        } for i, cid in enumerate(ids)], expected_revision=0)
        self.assertEqual([c["title"] for c in database.load_document()["chapters"]],
                         ["第0", "第1", "第2"])

        database.apply_patch([{"op": "chapter.swap", "a": ids[0], "b": ids[2]}])
        document = database.load_document()
        self.assertEqual([c["title"] for c in document["chapters"]], ["第2", "第1", "第0"])
        self.assertEqual([c["no"] for c in document["chapters"]], [1, 2, 3], "编号必须重排")

        database.apply_patch([{"op": "chapter.move", "id": ids[0], "to": 1}])
        self.assertEqual([c["title"] for c in database.load_document()["chapters"]],
                         ["第0", "第2", "第1"])

        database.apply_patch([{"op": "chapter.order", "ids": [ids[1], ids[0], ids[2]]}])
        self.assertEqual([c["title"] for c in database.load_document()["chapters"]],
                         ["第1", "第0", "第2"])

        # 删除中间一话后，编号仍然连续
        database.apply_patch([{"op": "chapter.delete", "id": ids[0]}])
        self.assertEqual([c["no"] for c in database.load_document()["chapters"]], [1, 2])

    def test_meta_and_char_names(self) -> None:
        database = self.make_db()
        database.apply_patch([
            {"op": "meta.update", "title": "新的作品名", "author": "我"},
            {"op": "charName.setMany", "names": {"1": "超超", "5": "阿蓝", "abc": "x", "200": "y"}},
        ], expected_revision=0)
        document = database.load_document()
        self.assertEqual(document["meta"]["title"], "新的作品名")
        self.assertEqual(document["meta"]["author"], "我")
        self.assertEqual(document["meta"]["charNames"], {"1": "超超", "5": "阿蓝"})
        self.assertTrue(database.last_issues, "非法键应被记录")
        # 整体替换：给空对象 = 清空角色名
        database.apply_patch([{"op": "charName.setMany", "names": {}}])
        self.assertEqual(database.load_document()["meta"]["charNames"], {})

    def test_clear(self) -> None:
        database = self.make_db()
        database.apply_patch([{"op": "chapter.upsert",
                               "chapter": {"title": "x", "note": ""},
                               "panels": [{"chars": [1, 2]}]},
                              {"op": "charName.setMany", "names": {"1": "甲"}}], expected_revision=0)
        database.clear()
        document = database.load_document()
        self.assertEqual(document["chapters"], [])
        self.assertEqual(document["meta"]["charNames"], {})

    def test_revision_conflict_and_force(self) -> None:
        database = self.make_db()
        database.apply_patch([{"op": "chapter.upsert", "chapter": {"title": "a", "note": ""},
                               "panels": []}], expected_revision=0)
        with self.assertRaises(RevisionConflict):
            database.apply_patch([{"op": "chapter.upsert", "chapter": {"title": "b", "note": ""},
                                   "panels": []}], expected_revision=0)
        result = database.apply_patch([{"op": "chapter.upsert", "chapter": {"title": "b", "note": ""},
                                        "panels": []}], expected_revision=0, force=True)
        self.assertEqual(result["revision"], 2)

    def test_unknown_op_and_bad_payloads_are_rejected(self) -> None:
        database = self.make_db()
        with self.assertRaises(OpError):
            database.apply_patch([{"op": "chapter.explode"}])
        with self.assertRaises(OpError):
            database.apply_patch([{"nope": 1}])
        with self.assertRaises(OpError):
            database.apply_patch([])
        with self.assertRaises(OpError):
            database.apply_patch([{"op": "panel.chars", "panelId": "pn-missing", "chars": [1]}])
        # 失败后不应留下半截写入
        self.assertEqual(database.load_document()["chapters"], [])

    def test_transaction_rolls_back_on_midway_failure(self) -> None:
        database = self.make_db()
        good = {"op": "chapter.upsert", "chapter": {"title": "好的一话", "note": ""}, "panels": []}
        bad = {"op": "panel.chars", "panelId": "pn-nope", "chars": [1]}
        with self.assertRaises(OpError):
            database.apply_patch([good, bad])
        self.assertEqual(database.load_document()["chapters"], [], "整批操作应一起回滚")
        self.assertEqual(database.revision(), 0, "失败不应消耗版本号")

    def test_change_log_tracks_actions(self) -> None:
        database = self.make_db()
        database.apply_patch([{"op": "chapter.upsert", "chapter": {"title": "a", "note": ""},
                               "panels": []}], label="客户端补丁")
        log = database.recent_log(10)
        self.assertEqual(len(log), 1)
        self.assertEqual(log[0]["action"], "客户端补丁")
        self.assertEqual(log[0]["revision"], 1)


class TestReads(TempDirCase):
    def setUp(self) -> None:
        super().setUp()
        self.database = self.make_db()
        self.database.import_json(sample_document())

    def test_index_counts(self) -> None:
        index = self.database.load_index()
        self.assertEqual(index["stats"]["chapters"], 3)
        self.assertEqual(index["stats"]["panels"], 10)
        self.assertEqual(index["stats"]["appearances"], 23)
        self.assertEqual(index["stats"]["distinct_chars"], 6)
        first = index["chapters"][0]
        self.assertEqual(first["title"], "相遇")
        self.assertEqual(first["panels"], 4)
        self.assertEqual(first["chars"], 4)
        self.assertEqual(first["appearances"], 10)
        self.assertNotIn("panelList", first)
        self.assertNotIn("charsList", first)

    def test_load_chapter_and_stats(self) -> None:
        index = self.database.load_index()
        chapter = self.database.load_chapter(index["chapters"][0]["id"])
        self.assertEqual(len(chapter["panels"]), 4)
        self.assertEqual(chapter["panels"][0]["chars"], [1, 5])
        stats = self.database.stats()
        self.assertEqual(stats["characters"][0], {"char": 1, "name": "超超", "panels": 6})

    def test_find_char(self) -> None:
        hits = self.database.find_char(100)
        self.assertEqual(len(hits), 2)
        self.assertEqual([f"{h['chapterNo']}-{h['panelIndex']}" for h in hits], ["3-2", "3-3"])
        self.assertEqual(hits[0]["chapterTitle"], "雨天")

    def test_search(self) -> None:
        result = self.database.search("放学")
        self.assertEqual([c["title"] for c in result["chapters"]], ["放学后"])
        names = self.database.search("会长")["charNames"]
        self.assertEqual(names, [{"char": 12, "name": "会长"}])
        self.assertEqual(self.database.search("")["chapters"], [])

    def test_missing_chapter_returns_none(self) -> None:
        self.assertIsNone(self.database.load_chapter("ch-nope"))


class TestExport(TempDirCase):
    def setUp(self) -> None:
        super().setUp()
        self.database = self.make_db()
        self.database.import_json(sample_document())

    def test_export_json_has_no_ids(self) -> None:
        payload = self.database.export_document()
        text = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn('"id"', text, "导出的 JSON 不应包含任何 id")
        self.assertNotIn("pn-", text)
        self.assertNotIn("ch-", text)
        self.assertEqual(payload["schema"], "girls_dict")
        self.assertEqual(payload["schemaVersion"], EXPORT_VERSION)
        self.assertIn("exportedAt", payload)
        self.assertEqual(len(payload["chapters"]), 3)
        self.assertEqual(payload["chapters"][0]["no"], 1)
        self.assertEqual(payload["chapters"][0]["panels"][0], {"chars": [1, 5]})
        self.assertEqual(set(payload["chapters"][0].keys()), {"no", "title", "note", "panels"})
        self.assertNotIn("revision", payload, "导出文件不带库内部版本号")

    def test_export_roundtrip_into_empty_db(self) -> None:
        exported = self.database.export_document()
        other = GirlsDB(self.dir / "other.sqlite3", backup_interval=0)
        other.initialize()
        self.addCleanup(other.close)
        other.import_json(exported)
        self.assertEqual(other.load_index()["stats"], self.database.load_index()["stats"])
        original = self.database.load_document()["chapters"]
        copy_chapters = other.load_document()["chapters"]
        for a, b in zip(original, copy_chapters):
            self.assertEqual(a["title"], b["title"])
            self.assertEqual([p["chars"] for p in a["panels"]], [p["chars"] for p in b["panels"]])

    def test_empty_title_and_names_survive_import_replace_and_restore(self) -> None:
        payload = sample_document()
        payload["meta"]["title"] = ""
        payload["meta"]["charNames"]["2"] = ""
        self.assertEqual(validate_export_document(payload), [], "空标题/空角色名本身是合法格式")

        database = GirlsDB(self.dir / "empty.sqlite3", backup_interval=0)
        database.initialize()
        self.addCleanup(database.close)
        database.import_json(payload)
        document = database.load_document()
        self.assertEqual(document["meta"]["title"], "", "空标题必须原样保存")
        self.assertEqual(document["meta"]["charNames"]["2"], "", "空角色名必须原样保存")
        self.assertEqual(validate_export_document(strip_ids(document)), [], "读回后仍是合法格式")

        # 整库替换（内部文档）同样保真，不能被默认标题覆盖
        database.replace_all(document)
        document = database.load_document()
        self.assertEqual(document["meta"]["title"], "")
        self.assertEqual(document["meta"]["charNames"]["2"], "")

        # 快照恢复：快照里的空标题也要保持为空
        snapshot = database.create_backup(tag="empty-meta")
        database.apply_patch([{"op": "meta.update", "title": "临时标题"}])
        self.assertEqual(database.load_document()["meta"]["title"], "临时标题")
        database.restore_backup(snapshot.name)
        document = database.load_document()
        self.assertEqual(document["meta"]["title"], "", "恢复快照时空标题不能被默认值替换")
        self.assertEqual(document["meta"]["charNames"]["2"], "")

        # 文件导入路径与对象导入规则一致
        source = self.dir / "empty.json"
        source.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        other = GirlsDB(self.dir / "empty-file.sqlite3", backup_interval=0)
        other.initialize()
        self.addCleanup(other.close)
        other.import_json(source)
        self.assertEqual(other.load_document()["meta"]["title"], "")
        self.assertEqual(other.load_document()["meta"]["charNames"]["2"], "")

    def test_meta_update_can_clear_title(self) -> None:
        database = GirlsDB(self.dir / "title-clear.sqlite3", backup_interval=0)
        database.initialize()
        self.addCleanup(database.close)
        database.import_json(sample_document())
        database.apply_patch([{"op": "meta.update", "title": ""}])
        self.assertEqual(database.load_document()["meta"]["title"], "")
        self.assertEqual(database.load_document()["meta"]["author"], "示例数据")

    def test_csv_matrix(self) -> None:
        csv_text = self.database.export_csv()
        rows = [line for line in csv_text.split("\r\n") if line]
        self.assertEqual(len(rows), 11)  # 表头 + 10 个分镜
        header = rows[0].split(",")
        self.assertEqual(header[0], "话-分镜")
        self.assertEqual(header[1:], [str(char) for char in range(0, 101)])
        self.assertEqual(rows[1].split(",")[0], "1-1")
        first = rows[1].split(",")
        self.assertEqual(first[1 + 1], "1")  # 角色 1
        self.assertEqual(first[1 + 5], "1")  # 角色 5
        self.assertEqual(first[1 + 2], "0")
        self.assertNotIn("相遇", csv_text)

    def test_strip_ids_helper(self) -> None:
        document = self.database.load_document()
        stripped = strip_ids(document)
        self.assertEqual(stripped["chapters"][2]["title"], "雨天")
        self.assertNotIn("id", json.dumps(stripped))


class TestBackups(TempDirCase):
    def test_backup_list_prune_and_restore(self) -> None:
        database = GirlsDB(self.path, backup_interval=0, backup_keep=3)
        database.initialize()
        self.addCleanup(database.close)
        database.import_json(sample_document())
        snapshot = database.create_backup(tag="manual")
        self.assertTrue(snapshot.is_file())
        self.assertEqual(len(database.list_backups()), 1)
        self.assertGreater(snapshot.stat().st_size, 0)

        before = database.load_index()["stats"]
        database.clear()
        self.assertEqual(database.load_index()["stats"]["chapters"], 0)

        result = database.restore_backup(snapshot.name)
        self.assertGreater(result["revision"], 0)
        self.assertEqual(database.load_index()["stats"], before, "回滚后统计应与快照一致")
        self.assertTrue(any("before-restore" in b["name"] for b in database.list_backups()))

    def test_backup_pruning(self) -> None:
        database = GirlsDB(self.path, backup_interval=0, backup_keep=2)
        database.initialize()
        self.addCleanup(database.close)
        for index in range(5):
            database.apply_patch([{"op": "chapter.upsert",
                                   "chapter": {"title": f"第{index}话", "note": ""}, "panels": []}])
            database.create_backup(tag=f"n{index}")
        self.assertLessEqual(len(database.list_backups()), 2)

    def test_restore_rejects_path_traversal(self) -> None:
        database = self.make_db()
        with self.assertRaises(FileNotFoundError):
            database.restore_backup("../../etc/passwd")


class TestStrictBoundary(TempDirCase):
    def test_no_neighbor_json_read_or_archive(self):
        source = self.dir / "girls_dict.json"
        source.write_text("{invalid JSON", encoding="utf-8")
        database = self.make_db()
        self.assertEqual(database.load_document()["chapters"], [])
        self.assertEqual(source.read_text(), "{invalid JSON")
        self.assertFalse(hasattr(database, "migration"))
        source.write_text(json.dumps(sample_document()), encoding="utf-8")
        database.import_json(source)
        self.assertTrue(source.is_file())
        self.assertFalse((self.dir / "legacy").exists())
        with self.assertRaises(TypeError):
            database.import_json(source, archive=True)
        with self.assertRaises(TypeError):
            GirlsDB(self.path, legacy_json=None)
        with self.assertRaises(TypeError):
            database.replace_all(database.load_document(), strict=True)

    def test_existing_storage_never_repaired(self):
        database = self.make_db()
        conn = database.connect()
        try:
            for version in [None, "1", "999"]:
                conn.execute("DELETE FROM info WHERE key='schema_version'")
                if version is not None:
                    database._set_info(conn, "schema_version", version)
                with self.assertRaises(ValidationError):
                    database.initialize()
                self.assertEqual(database._info(conn, "schema_version"), version)
        finally:
            conn.close()

    def test_import_strict_rejections_are_atomic(self):
        database = self.make_db()
        good = sample_document()
        self.assertEqual(validate_export_document(good), [])
        mutations = [
            lambda d: d.update(schemaVersion=1), lambda d: d.pop("schema"),
            lambda d: d.update(document={}), lambda d: d["meta"].pop("author"),
            lambda d: d["meta"]["charNames"].update({"01": "bad"}),
            lambda d: d["chapters"][0].update(id="old"),
            lambda d: d["chapters"][0]["panels"][0].update(id="old"),
            lambda d: d["chapters"][0].update(no=9),
            lambda d: d["chapters"][0].pop("note"),
            lambda d: d.update(revision=True), lambda d: d.update(exportedAt=5),
        ]
        for chars in [[2, 1], [1, 1], ["1"], [True], [-1], [101]]:
            mutations.append(lambda d, chars=chars: d["chapters"][0]["panels"][0].update(chars=chars))
        for mutate in mutations:
            bad = json.loads(json.dumps(good)); mutate(bad)
            with self.assertRaises(ValidationError):
                database.import_json(bad)
            self.assertEqual(database.revision(), 0)
        database.import_json(good)
        document = database.load_document()
        self.assertTrue(document["chapters"][0]["id"])
        database.replace_all(document)
        with self.assertRaises(OpError):
            database.apply_patch([{"op": "replace", "document": document}])
        with self.assertRaises(OpError):
            database.apply_patch([{"op": "replace", "db": document, "document": document}])
        document["schemaVersion"] = 1
        with self.assertRaises(ValidationError):
            database.replace_all(document)

    def test_migration_cli_flags_rejected_before_open(self):
        import subprocess
        for script, flags in [("server/server.py", ["--legacy-json", "x"]),
                              ("server/server.py", ["--migrate-json", "x"]),
                              ("tools/gd.py", ["migrate", "--from", "x"])]:
            result = subprocess.run([sys.executable, str(ROOT / script), "--data", str(self.path), *flags],
                                    capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.path.exists())


class TestIntegrity(TempDirCase):
    def test_integrity_check_clean_database(self) -> None:
        database = self.make_db()
        database.import_json(sample_document())
        self.assertEqual(database.integrity_check(), [])

    def test_integrity_check_detects_bad_rows(self) -> None:
        database = self.make_db()
        database.import_json(sample_document())
        connection = database.connect()
        try:
            connection.execute("PRAGMA foreign_keys = OFF")
            connection.execute("INSERT INTO panel_char(panel_id, char) VALUES('pn-missing', 42)")
            connection.execute("UPDATE chapter SET no = 99 WHERE no = 1")
        finally:
            connection.close()
        issues = database.integrity_check()
        paths = {issue["path"] for issue in issues}
        self.assertIn("chapter.no", paths)

    def test_size_includes_wal(self) -> None:
        database = self.make_db()
        database.import_json(sample_document())
        self.assertGreater(database.db_size(), 0)
        self.assertGreaterEqual(database.db_size(), self.path.stat().st_size)


class TestNormalizeDocument(TempDirCase):
    def test_accepts_export_format_without_ids(self) -> None:
        issues = []
        document = normalize_document({
            "schema": "girls_dict", "schemaVersion": 1,
            "meta": {"title": "T", "charNames": {"2": "小美"}},
            "chapters": [{"no": 5, "title": "甲", "panels": [{"chars": [2, 2]}, {"chars": []}]}],
        }, issues)
        self.assertEqual(issues, [])
        self.assertEqual(document["chapters"][0]["no"], 1)
        self.assertEqual(document["chapters"][0]["panels"][0]["chars"], [2])
        self.assertTrue(document["chapters"][0]["id"].startswith("ch-"))

    def test_rejects_garbage(self) -> None:
        issues = []
        document = normalize_document(["不是", "对象"], issues)
        self.assertEqual(document["chapters"], [])
        self.assertTrue(any(i["level"] == "error" for i in issues))


if __name__ == "__main__":
    unittest.main(verbosity=2)
