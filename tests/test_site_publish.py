#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公开站分片 JSON 的单元测试（不依赖 Git）。"""
from __future__ import annotations

import json
import shutil
import sys
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from girls_db import ValidationError, normalize_document, strip_ids  # noqa: E402
from site_publish import build_payload, publish_site, write_payload  # noqa: E402

SAMPLE = ROOT / "data" / "sample.girls_dict.json"


class SitePublishTest(unittest.TestCase):
    def setUp(self) -> None:
        raw = json.loads(SAMPLE.read_text(encoding="utf-8"))
        self.document = strip_ids(normalize_document(raw))
        self.payload = build_payload(self.document, revision=7)
        self.stats = json.loads(self.payload["stats.json"])
        self.manifest = json.loads(self.payload["manifest.json"])
        self.index = json.loads(self.payload["chapters/index.json"])

    def test_manifest_and_stats(self) -> None:
        self.assertEqual(self.manifest["revision"], 7)
        self.assertEqual(self.manifest["counts"], {
            "chapters": 3, "panels": 10, "appearances": 23,
            "characters": 6, "charMin": 0, "charMax": 100,
        })
        self.assertEqual(self.stats["totalPanels"], 10)
        self.assertEqual(self.stats["totalAppearances"], 23)
        self.assertEqual(self.stats["characterCount"], 6)
        self.assertEqual(self.stats["lastChapter"], 3)
        self.assertEqual(self.stats["maxCount"], 6)
        self.assertEqual(self.stats["maxPoints"], 1.9)
        self.assertEqual(self.stats["maxWeighted"], 1.1)
        self.assertNotIn("maxPanels", self.stats)
        for item in self.stats["characters"]:
            self.assertNotIn("panels", item)
        for payload in self.payload.values():
            data = json.loads(payload)
            self.assertEqual(data["schema"], "girls_dict")
            self.assertEqual(data["schemaVersion"], 2)
            self.assertEqual(data["formatVersion"], 3)
        self.assertEqual(len(self.stats["characters"]), 101)
        self.assertEqual(self.stats["characters"][0]["char"], 0)
        self.assertEqual(self.stats["characters"][0]["count"], 0)
        self.assertIsNone(self.stats["characters"][0]["firstChapter"])
        self.assertEqual(self.stats["characters"][100]["char"], 100)

        by_char = {item["char"]: item for item in self.stats["characters"]}
        self.assertEqual(
            (by_char[1]["count"], by_char[1]["points"], by_char[1]["weighted"], by_char[1]["firstChapter"]),
            (6, 1.9, 1.1, 1),
        )
        self.assertEqual(
            (by_char[2]["count"], by_char[2]["points"], by_char[2]["weighted"], by_char[2]["firstChapter"]),
            (4, 1.5, 0.8, 1),
        )
        self.assertEqual(
            (by_char[5]["count"], by_char[5]["points"], by_char[5]["weighted"], by_char[5]["firstChapter"]),
            (4, 1.3, 0.7, 1),
        )
        self.assertEqual(
            (by_char[12]["count"], by_char[12]["points"], by_char[12]["weighted"], by_char[12]["firstChapter"]),
            (3, 1.0, 0.6, 2),
        )
        self.assertEqual(
            (by_char[23]["count"], by_char[23]["points"], by_char[23]["weighted"], by_char[23]["firstChapter"]),
            (4, 1.2, 0.8, 1),
        )
        self.assertEqual(
            (by_char[100]["count"], by_char[100]["points"], by_char[100]["weighted"], by_char[100]["firstChapter"]),
            (2, 1.2, 0.9, 3),
        )

    def test_chapter_index_and_files(self) -> None:
        self.assertEqual(len(self.index["chapters"]), 3)
        first = self.index["chapters"][0]
        self.assertEqual((first["no"], first["panelCount"], first["appearances"]), (1, 4, 10))
        self.assertEqual(first["weight"], 4)
        self.assertEqual(first["file"], "0001.json")
        self.assertEqual(first["metrics"]["1"], {
            "count": 3, "points": 0.866667, "weighted": 0.433333,
        })
        self.assertEqual(self.index["chapters"][1]["weight"], 5)
        self.assertEqual(self.index["chapters"][2]["weight"], 6)

        chapter = json.loads(self.payload["chapters/0001.json"])
        self.assertEqual(len(chapter["panels"]), 4)
        self.assertEqual(chapter["panels"][1]["chars"], [1, 2, 5])
        self.assertEqual(len(self.payload), 6)  # manifest + stats + index + 3 话

    def test_index_metrics_match_stats(self) -> None:
        totals = {}
        for chapter in self.index["chapters"]:
            for key, metric in chapter["metrics"].items():
                char = int(key)
                current = totals.setdefault(char, {"count": 0, "points": 0.0, "weighted": 0.0})
                current["count"] += metric["count"]
                current["points"] += metric["points"]
                current["weighted"] += metric["weighted"]
        by_char = {item["char"]: item for item in self.stats["characters"]}
        for char, total in totals.items():
            self.assertEqual(by_char[char]["count"], total["count"])
            self.assertAlmostEqual(by_char[char]["points"], round(total["points"], 1), places=1)
            self.assertAlmostEqual(by_char[char]["weighted"], round(total["weighted"], 1), places=1)

    def test_payload_is_compact(self) -> None:
        chapter = self.payload["chapters/0001.json"]
        self.assertIn('"chars": [1, 2, 5]', chapter)
        self.assertNotIn('"chars": [\n', chapter)
        self.assertLess(len(chapter.splitlines()), 20)

    def test_build_rejects_noncurrent_export(self) -> None:
        for mutate in (
            lambda data: data.update(schemaVersion=1),
            lambda data: data.pop("schemaVersion"),
            lambda data: data["chapters"][0].update(id="ch-old"),
            lambda data: data["chapters"][0]["panels"][0].update(id="pn-old"),
        ):
            data = json.loads(json.dumps(self.document))
            mutate(data)
            with self.assertRaises(ValidationError):
                build_payload(data, revision=7)

    def test_same_revision_wrong_format_does_not_skip_export(self) -> None:
        work = ROOT / ".tmp-test-run" / uuid.uuid4().hex
        work.mkdir(parents=True)
        class Database:
            def revision(inner):
                return 7
            def load_document(inner):
                return normalize_document(self.document)
        try:
            old_payload = dict(self.payload)
            manifest = json.loads(old_payload["manifest.json"])
            manifest["formatVersion"] = 2
            old_payload["manifest.json"] = json.dumps(manifest)
            write_payload(work, old_payload)
            result = publish_site(Database(), work, export_only=True)
            self.assertTrue(result["ok"], result)
            self.assertTrue(result["changed"])
            current = json.loads((work / "docs/data/manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(current["formatVersion"], 3)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_write_payload_cleans_stale_chapters(self) -> None:
        work = ROOT / ".tmp-test-run" / uuid.uuid4().hex
        work.mkdir(parents=True)
        try:
            chapters = work / "docs" / "data" / "chapters"
            chapters.mkdir(parents=True)
            stale = chapters / "9999.json"
            stale.write_text("{}", encoding="utf-8")
            written = write_payload(work, self.payload)
            self.assertFalse(stale.exists(), "旧的章节文件应被清掉")
            self.assertTrue((work / "docs" / "data" / "manifest.json").is_file())
            self.assertTrue((work / "docs" / "data" / "chapters" / "0001.json").is_file())
            self.assertEqual(len(written), 6)
            self.assertFalse(any(path.suffix == ".tmp" for path in (work / "docs").rglob("*")))
        finally:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
