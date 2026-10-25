#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨语言契约测试：把「浏览器端算出来的补丁」喂给真正的 SQLite 数据层。

流程：
    tests/dump_patch.js（用 public/js/model.js 造出 before / ops / after）
        → 本测试把 before 导入临时 SQLite 库
        → 应用 ops
        → 断言结果与浏览器端预期的 after 完全一致

需要 Node.js；没有 Node 时自动跳过（不会让测试失败）。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from girls_db import GirlsDB  # noqa: E402

NODE_CANDIDATES = [
    shutil.which("node"),
    str(Path.home() / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies" / "node" / "bin" / "node.exe"),
]


def find_node() -> str | None:
    for candidate in NODE_CANDIDATES:
        if candidate and Path(candidate).is_file():
            return candidate
    return None


class TestPatchContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = find_node()
        cls.scenario = None
        if not cls.node:
            return
        result = subprocess.run([cls.node, str(ROOT / "tests" / "dump_patch.js")],
                                cwd=str(ROOT), capture_output=True, encoding="utf-8", errors="replace")
        if result.returncode != 0:
            raise AssertionError(f"dump_patch.js 执行失败：{result.stderr}")
        cls.scenario = json.loads(result.stdout)

    def setUp(self) -> None:
        if not self.node:
            self.skipTest("没有找到 Node.js，跳过跨语言补丁契约测试")
        base = ROOT / ".tmp-tests"
        self.dir = base / uuid.uuid4().hex[:12]
        self.dir.mkdir(parents=True, exist_ok=True)
        self.database = GirlsDB(self.dir / "contract.sqlite3", backup_interval=0)
        self.database.initialize()
        self.addCleanup(self.database.close)

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_client_patch_reproduces_expected_document(self) -> None:
        scenario = self.scenario
        ops = scenario["ops"]
        self.assertTrue(ops, "补丁不应为空")
        self.assertTrue(all("op" in op for op in ops))

        # 1) 把改动前的文档写进 SQLite（id 会被原样保留）
        self.database.replace_all(scenario["before"])
        stored = self.database.load_document()
        self.assertEqual([c["id"] for c in stored["chapters"]],
                         [c["id"] for c in scenario["before"]["chapters"]])

        # 2) 应用浏览器端生成的补丁
        result = self.database.apply_patch(ops, expected_revision=stored["revision"])
        self.assertEqual(result["applied"], [op["op"] for op in ops])

        # 3) 结果必须与浏览器端预期的文档完全一致
        actual = self.database.load_document()
        expected = scenario["after"]
        self.assertEqual([c["id"] for c in actual["chapters"]], [c["id"] for c in expected["chapters"]],
                         "话的顺序/身份不一致")
        self.assertEqual([c["title"] for c in actual["chapters"]], [c["title"] for c in expected["chapters"]])
        self.assertEqual([c["note"] for c in actual["chapters"]], [c["note"] for c in expected["chapters"]])
        for real, want in zip(actual["chapters"], expected["chapters"]):
            self.assertEqual([p["id"] for p in real["panels"]], [p["id"] for p in want["panels"]],
                             f"第 {real['no']} 话的槽位不一致")
            self.assertEqual([p["chars"] for p in real["panels"]], [p["chars"] for p in want["panels"]],
                             f"第 {real['no']} 话的编号不一致")
        self.assertEqual(actual["meta"]["charNames"], expected["meta"]["charNames"])
        self.assertEqual(actual["meta"]["author"], expected["meta"]["author"])

    def test_patch_ops_are_all_known_to_the_database(self) -> None:
        """补丁里用到的 op 名字必须都在服务端认识（避免客户端单方面加新操作）。"""
        from girls_db import OP_DOCS
        known = {item["op"] for item in OP_DOCS}
        used = {op["op"] for op in self.scenario["ops"]}
        self.assertTrue(used <= known, f"服务端不认识这些操作：{sorted(used - known)}")

    def test_export_strips_ids_after_patch(self) -> None:
        self.database.replace_all(self.scenario["before"])
        self.database.apply_patch(self.scenario["ops"])
        exported = json.dumps(self.database.export_document(), ensure_ascii=False)
        self.assertNotIn('"id"', exported)
        self.assertNotIn("pn-", exported)
        self.assertNotIn("ch-", exported)
        self.assertEqual(self.database.integrity_check(), [])

    def test_strict_document_validators_match_node(self) -> None:
        import copy
        from girls_db import strip_ids, validate_export_document, validate_internal_document
        good = strip_ids(self.scenario["before"])
        documents = [good, None, [], {}, {"schemaVersion": 1}]
        for key in good:
            bad = copy.deepcopy(good); del bad[key]
            documents.append(bad)
        changes = [
            (["schema"], "other"), (["schemaVersion"], 1), (["schemaVersion"], True),
            (["exportedAt"], 1), (["revision"], -1), (["revision"], True),
            (["revision"], 1.5), (["revision"], 9007199254740992),
            (["meta", "charMin"], False), (["meta", "charMax"], True),
            (["meta", "title"], None), (["meta", "charNames"], {"01": "bad"}),
            (["meta", "charNames"], {"101": "bad"}), (["meta", "charNames"], {"1": 3}),
            (["chapters", 0, "no"], True), (["chapters", 0, "no"], 2),
            (["chapters", 0, "id"], "old"), (["chapters", 0, "panels", 0, "id"], "old"),
            (["chapters", 0, "panels", 0, "chars"], [1, 1]),
            (["chapters", 0, "panels", 0, "chars"], [2, 1]),
            (["chapters", 0, "panels", 0, "chars"], [False]),
            (["chapters", 0, "panels", 0, "chars"], ["1"]),
            (["chapters", 0, "panels", 0, "chars"], [-1, 101]),
        ]
        for keys, value in changes:
            bad = copy.deepcopy(good); target = bad
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            documents.append(bad)
        for keys in [[], ["meta"], ["chapters", 0], ["chapters", 0, "panels", 0]]:
            bad = copy.deepcopy(good); target = bad
            for key in keys:
                target = target[key]
            target["unknown"] = True
            documents.append(bad)
        internal = copy.deepcopy(self.scenario["before"])
        no_ids = copy.deepcopy(internal)
        for chapter in no_ids["chapters"]:
            chapter.pop("id", None)
            for panel in chapter["panels"]:
                panel.pop("id", None)
        duplicate = copy.deepcopy(internal)
        duplicate["chapters"][0]["panels"][0]["id"] = duplicate["chapters"][0]["id"]
        internals = [internal, no_ids, duplicate, good]
        script = "const fs=require('fs'),d=require('./server/db.js'),x=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify([x[0].map(d.validateExportDocument),x[1].map(d.validateInternalDocument)]));"
        result = subprocess.run([self.node, "-e", script], cwd=ROOT,
                                input=json.dumps([documents, internals]), capture_output=True,
                                encoding="utf-8", check=True)
        node_external, node_internal = json.loads(result.stdout)
        for raw, actual in zip(documents, node_external):
            self.assertCountEqual(validate_export_document(raw), actual, repr(raw))
        for raw, actual in zip(internals, node_internal):
            self.assertCountEqual(validate_internal_document(raw), actual, repr(raw))
        self.assertEqual(validate_internal_document(no_ids), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
