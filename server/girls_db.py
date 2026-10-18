#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""girls_dict（超超你的字典）数据层 —— SQLite 版本。

为什么不用单个 JSON 文件了
-------------------------
每录一个编号就把整份文档序列化、整文件重写一次，数据一多就会：
写入放大（录 1 格 = 重写全书）、内存与 CPU 随数据量线性增长、
单文件损坏即全丢。换成 SQLite 之后：

* 一次录入 = 一条 UPDATE / 几行 INSERT，写入量与「改了多少」成正比；
* 章节、槽位、角色编号、角色名都是独立的表，还带索引，可以只查一部分；
* 事务 + WAL，断电不会写坏；快照用 ``VACUUM INTO``，秒级且一致；
* 仍然是**一个本地文件**，零依赖（Python 自带 sqlite3），拷走就能用；
* JSON 没有被抛弃 —— 它用于导入/导出，导出的 JSON 不含内部 id。

存储结构（也见 schema/girls_dict.sql）：

    info(key, value)                   schema_version / title / author / revision / updated_at
    chapter(id, no, title, note, updated_at)          no = 顺序位置，1..N，UNIQUE
    panel(id, chapter_id, position, updated_at)       position = 该话内顺序，1..M
    panel_char(panel_id, char)                        主键 (panel_id, char) 天然去重
    char_name(char, name)                             编号 -> 角色名（仅用于显示）
    change_log(id, at, revision, action, detail)      最近改动（自动裁到 2000 条）

对外仍然只暴露「文档 + 补丁」两种写入口：

    db.apply_patch([{"op": "panel.chars", "panelId": "...", "chars": [1, 5]}], revision)
    db.replace_all(document, force=True)

补丁的 op 列表见 OP_DOCS。所有写入都在一个事务里完成，revision 是乐观锁。
"""

from __future__ import annotations

import copy
import csv
import io
import json
import os
import random
import shutil
import sqlite3
import string
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

from json_pretty import dumps as pretty_json

SCHEMA_NAME = "girls_dict"
STORAGE_VERSION = 2          # SQLite 存储结构版本
EXPORT_VERSION = 1           # 导出/导入用 JSON 的版本
CHAR_MIN = 0
CHAR_MAX = 100

_UNSET = object()            # 区分「没传 legacy_json」和「显式传 None」

DEFAULT_BACKUP_INTERVAL = 600.0
DEFAULT_BACKUP_KEEP = 20
LOG_KEEP = 2000

OP_DOCS = [
    {"op": "chapter.upsert", "args": "{chapter:{id?,title,note}, panels:[{id?,chars}], position?}",
     "desc": "新增或覆盖一话（连同它的槽位）；position 是 1 起的插入位置，默认追加到末尾"},
    {"op": "chapter.update", "args": "{id, title?, note?}", "desc": "只改标题/备注"},
    {"op": "chapter.delete", "args": "{id}", "desc": "删除一话（槽位级联删除）"},
    {"op": "chapter.order", "args": "{ids:[...]}", "desc": "按给定顺序重排所有话并修正编号"},
    {"op": "chapter.move", "args": "{id, to}", "desc": "把某一话移动到第 to 位"},
    {"op": "chapter.swap", "args": "{a, b}", "desc": "对换两话并修正编号"},
    {"op": "panel.upsert", "args": "{chapterId, panel:{id?,chars}, position?}", "desc": "新增或覆盖一个槽位"},
    {"op": "panel.delete", "args": "{id}", "desc": "删除一个槽位"},
    {"op": "panel.chars", "args": "{panelId, chars:[...]}", "desc": "整体覆盖某个槽位的角色编号（最常用）"},
    {"op": "meta.update", "args": "{title?, author?}", "desc": "更新作品名/录入者"},
    {"op": "charName.setMany", "args": "{names:{'1':'超超',...}}", "desc": "整体替换角色名表"},
    {"op": "clear", "args": "{}", "desc": "清空所有话、槽位与角色名（保留 schema 信息）"},
    {"op": "replace", "args": "{db:{...}}", "desc": "整库替换（导入外部 JSON 时用）"},
]


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def now_iso() -> str:
    """当前时间（UTC，秒精度，ISO-8601）。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    suffix = "".join(random.choice(string.hexdigits.lower()[:16]) for _ in range(8))
    return f"{prefix}-{suffix}"


def _issue(bucket: Optional[List[Dict[str, str]]], level: str, path: str, message: str) -> None:
    if bucket is not None:
        bucket.append({"level": level, "path": path, "message": message})


def clean_chars(raw: Any, on_issue: Optional[List[Dict[str, str]]] = None, where: str = "") -> List[int]:
    """整理成 [0,100] 去重升序的整数列表；非法项丢弃并记录。"""
    out: List[int] = []
    seen = set()
    if raw is None:
        return out
    if not isinstance(raw, (list, tuple, set)):
        raw = [raw]
    for item in raw:
        value: Optional[int] = None
        if isinstance(item, bool):
            value = None
        elif isinstance(item, int):
            value = item
        elif isinstance(item, float) and float(item).is_integer():
            value = int(item)
        elif isinstance(item, str) and item.strip().lstrip("+-").isdigit():
            value = int(item.strip())
        if value is None:
            _issue(on_issue, "error", where, f"无法识别的角色编号：{item!r}")
            continue
        if value < CHAR_MIN or value > CHAR_MAX:
            _issue(on_issue, "error", where, f"角色编号超出 [{CHAR_MIN},{CHAR_MAX}]：{value}")
            continue
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    out.sort()
    return out


def normalize_chapter(raw: Any, index: int, issues: Optional[List[Dict[str, str]]] = None,
                      seen_ids: Optional[set] = None) -> Optional[Dict[str, Any]]:
    """把外部（可能是人手改过的）一话整理成规范结构；无法识别返回 None。"""
    where = f"chapters[{index}]"
    if not isinstance(raw, dict):
        _issue(issues, "error", where, "话记录不是对象，已丢弃")
        return None
    seen = seen_ids if seen_ids is not None else set()
    chapter_id = raw.get("id")
    if not isinstance(chapter_id, str) or not chapter_id or chapter_id in seen:
        chapter_id = new_id("ch")
    seen.add(chapter_id)

    panels_in = raw.get("panels")
    if panels_in is None:
        panels_in = []
    if not isinstance(panels_in, list):
        _issue(issues, "error", f"{where}.panels", "panels 不是数组，已重置为空")
        panels_in = []
    panels: List[Dict[str, Any]] = []
    for pindex, raw_panel in enumerate(panels_in):
        pwhere = f"{where}.panels[{pindex}]"
        if not isinstance(raw_panel, dict):
            _issue(issues, "error", pwhere, "槽位不是对象，已丢弃")
            continue
        panel_id = raw_panel.get("id")
        if not isinstance(panel_id, str) or not panel_id or panel_id in seen:
            panel_id = new_id("pn")
        seen.add(panel_id)
        panels.append({"id": panel_id, "chars": clean_chars(raw_panel.get("chars"), issues, f"{pwhere}.chars")})

    return {
        "id": chapter_id,
        "no": index + 1,
        "title": raw.get("title") if isinstance(raw.get("title"), str) else "",
        "note": raw.get("note") if isinstance(raw.get("note"), str) else "",
        "panels": panels,
    }


def normalize_document(raw: Any, issues: Optional[List[Dict[str, str]]] = None,
                       title: str = "超超你的字典") -> Dict[str, Any]:
    """把任意对象整理成规范文档（内部结构，带 id）。用于导入/整库替换。"""
    if issues is None:
        issues = []
    if not isinstance(raw, dict):
        _issue(issues, "error", "$", "顶层不是 JSON 对象，已重置为空文档")
        raw = {}
    seen: set = set()
    chapters_in = raw.get("chapters")
    if chapters_in is None:
        chapters_in = []
    if not isinstance(chapters_in, list):
        _issue(issues, "error", "chapters", "chapters 不是数组，已重置为空")
        chapters_in = []
    chapters = [c for c in (normalize_chapter(item, i, issues, seen) for i, item in enumerate(chapters_in)) if c]

    names: Dict[str, str] = {}
    meta_in = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
    names_in = meta_in.get("charNames") if isinstance(meta_in.get("charNames"), dict) else {}
    for key, value in names_in.items():
        try:
            number = int(str(key).strip())
        except (TypeError, ValueError):
            _issue(issues, "warn", "meta.charNames", f"忽略非法角色编号键：{key!r}")
            continue
        if CHAR_MIN <= number <= CHAR_MAX and isinstance(value, str):
            names[str(number)] = value

    revision = raw.get("revision")
    return {
        "schema": SCHEMA_NAME,
        "schemaVersion": EXPORT_VERSION,
        "revision": revision if isinstance(revision, int) and revision >= 0 else 0,
        "updatedAt": raw.get("updatedAt") if isinstance(raw.get("updatedAt"), str) else None,
        "meta": {
            "title": meta_in.get("title") if isinstance(meta_in.get("title"), str) else title,
            "author": meta_in.get("author") if isinstance(meta_in.get("author"), str) else "",
            "charMin": CHAR_MIN,
            "charMax": CHAR_MAX,
            "charNames": names,
        },
        "chapters": chapters,
    }


def strip_ids(document: Dict[str, Any]) -> Dict[str, Any]:
    """去掉内部 id，得到可长期保存 / 交给别的程序的导出格式。"""
    return {
        "schema": SCHEMA_NAME,
        "schemaVersion": EXPORT_VERSION,
        "exportedAt": now_iso(),
        "meta": copy.deepcopy(document.get("meta", {})),
        "chapters": [
            {
                "no": index + 1,
                "title": chapter.get("title", ""),
                "note": chapter.get("note", ""),
                "panels": [{"chars": list(panel.get("chars", []))} for panel in chapter.get("panels", [])],
            }
            for index, chapter in enumerate(document.get("chapters", []))
        ],
    }


# --------------------------------------------------------------------------- #
# 异常
# --------------------------------------------------------------------------- #
class RevisionConflict(Exception):
    """写入时发现库里的 revision 与调用方持有的不一致。"""

    def __init__(self, current_revision: int, current_document: Optional[Dict[str, Any]] = None):
        super().__init__(f"版本冲突：数据库里的 revision={current_revision}")
        self.current_revision = current_revision
        self.current_document = current_document


class ValidationError(Exception):
    def __init__(self, issues: List[Dict[str, str]]):
        self.issues = issues
        message = "；".join(f"{i['path']}: {i['message']}" for i in issues[:5]) or "数据不合法"
        super().__init__(message)


class OpError(Exception):
    """补丁里的某个操作不合法。"""

    def __init__(self, index: int, message: str):
        super().__init__(f"第 {index + 1} 个操作不合法：{message}")
        self.index = index


class _SharedConnection:
    """常驻连接的薄包装：``close()`` 故意什么都不做（见 GirlsDB.connection 的说明）。"""

    __slots__ = ("_raw",)

    def __init__(self, raw: sqlite3.Connection):
        self._raw = raw

    def __getattr__(self, name: str) -> Any:
        return getattr(self._raw, name)

    def close(self) -> None:      # noqa: D102  - 有意为空
        return None


# --------------------------------------------------------------------------- #
# 数据库
# --------------------------------------------------------------------------- #
class GirlsDB:
    """SQLite 数据库。线程安全（写入串行化 + WAL）。"""

    def __init__(
        self,
        path: Union[str, os.PathLike],
        backup_dir: Optional[Union[str, os.PathLike]] = None,
        backup_interval: float = DEFAULT_BACKUP_INTERVAL,
        backup_keep: int = DEFAULT_BACKUP_KEEP,
        title: str = "超超你的字典",
        legacy_json: Any = _UNSET,
    ):
        self.path = Path(path).resolve()
        self.backup_dir = Path(backup_dir).resolve() if backup_dir else self.path.parent / "backups"
        self.backup_interval = float(backup_interval)
        self.backup_keep = int(backup_keep)
        self.title = title
        # 旧版单文件 JSON：只在数据库文件还不存在时用来做一次性迁移。
        # 不传 = 用同名同目录的 girls_dict.json；显式传 None = 关闭自动迁移。
        if legacy_json is _UNSET:
            candidate = self.path.parent / "girls_dict.json"
            self.legacy_json = candidate if (self.path.suffix != ".json" and candidate != self.path) else None
        elif legacy_json is None:
            self.legacy_json = None
        else:
            self.legacy_json = Path(legacy_json).resolve()
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None
        self._shared: Any = None
        self.last_issues: List[Dict[str, str]] = []
        self.migration: Optional[Dict[str, Any]] = None

    # ------------------------------------------------------------------ #
    # 连接与建表
    # ------------------------------------------------------------------ #
    def connect(self) -> sqlite3.Connection:
        """开一个**独立的**连接（调用方自己负责 close）。适合外部工具/测试。

        程序内部请用 :meth:`connection`：WAL 数据库在**最后一个连接关闭**时会把整个
        预写日志写回主库，如果每次保存都开关连接，就等于「改一个编号 = 等一次整库检查点」，
        实测单次写入从 0.1 ms 变成 ~7 ms。所以内部保持一条常驻连接。
        """
        return self._open_connection()

    def _open_connection(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), timeout=15.0, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 15000")
        # 注意：不要设 journal_size_limit。一旦设了，SQLite 会在每次检查点后截断 -wal，
        # 而检查点按 1000 页自动触发，结果就变成「每写一次就检查点+截断」，写入从 0.1ms 变成 7ms。
        return conn

    def connection(self) -> Any:
        """内部共享的常驻连接。所有用法都在 ``self._lock`` 下串行化，因此是安全的。

        返回的是一个薄包装：``.close()`` 是空操作，这样既有的「用完就关」写法不用改，
        又不会真的把连接关掉（也就不会触发整库检查点）。
        """
        if self._conn is None:
            self._conn = self._open_connection()
            self._shared = _SharedConnection(self._conn)
        return self._shared

    def close(self) -> None:
        """关闭常驻连接（正常退出时可以调一下，让 SQLite 做最后一次检查点）。"""
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                except sqlite3.Error:
                    pass
                try:
                    self._conn.close()
                finally:
                    self._conn = None
                    self._shared = None

    def exists(self) -> bool:
        return self.path.is_file() and self.path.stat().st_size > 0

    def initialize(self) -> Dict[str, Any]:
        """建表；如果这是首次创建，顺便尝试从旧版 JSON 迁移。"""
        with self._lock:
            fresh = not self.exists()
            conn = self.connection()
            try:
                conn.executescript(SCHEMA_SQL)
                if fresh or self._info(conn, "schema_version") is None:
                    self._set_info(conn, "schema_version", str(STORAGE_VERSION))
                    self._set_info(conn, "title", self.title)
                    self._set_info(conn, "author", "")
                    if self._info(conn, "revision") is None:
                        self._set_info(conn, "revision", "0")
                        self._set_info(conn, "updated_at", "")
                if fresh:
                    self.migration = self._auto_migrate(conn)
            finally:
                conn.close()
            return {"fresh": fresh, "migration": self.migration}

    def _auto_migrate(self, conn: sqlite3.Connection) -> Optional[Dict[str, Any]]:
        """数据库是新建的，而旁边还躺着一份旧版 JSON —— 把它迁进来并归档。"""
        source = self.legacy_json
        if not source or not Path(source).is_file():
            return None
        try:
            summary = self._import_into(conn, Path(source))
        except Exception as exc:  # 迁移失败也不能毁掉原文件
            return {"ok": False, "source": str(source), "error": str(exc)}
        archived = self._archive_legacy(Path(source))
        self._set_info(conn, "migrated_from", str(source))
        self._set_info(conn, "migrated_at", now_iso())
        summary = dict(summary, ok=True, source=str(source), archived=str(archived) if archived else None)
        return summary

    def migration_info(self) -> Optional[Dict[str, str]]:
        """数据库里记录的「当初是从哪份 JSON 迁移来的」。"""
        with self._lock:
            conn = self.connection()
            try:
                source = self._info(conn, "migrated_from")
                if not source:
                    return None
                return {"source": source, "at": self._info(conn, "migrated_at") or ""}
            finally:
                conn.close()

    def _archive_legacy(self, source: Path) -> Optional[Path]:
        """把已经迁移完的旧 JSON 挪到 legacy/ 存档（绝不删除）。

        源文件本来就在 legacy/ 里的话（例如从归档里再迁一次），就地改名，
        不再套一层 legacy/legacy/。
        """
        target_dir = source.parent if source.parent.name == "legacy" else source.parent / "legacy"
        target_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        stem = source.stem.split("-migrated-")[0]      # 再迁一次也不要套娃
        target = target_dir / f"{stem}-migrated-{stamp}{source.suffix}"
        try:
            shutil.move(str(source), str(target))
            return target
        except OSError:
            return None

    # ------------------------------------------------------------------ #
    # info 表小工具
    # ------------------------------------------------------------------ #
    @staticmethod
    def _info(conn: sqlite3.Connection, key: str) -> Optional[str]:
        row = conn.execute("SELECT value FROM info WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    @staticmethod
    def _set_info(conn: sqlite3.Connection, key: str, value: str) -> None:
        conn.execute(
            "INSERT INTO info(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def _bump_revision(self, conn: sqlite3.Connection, action: str, detail: str = "") -> int:
        revision = int(self._info(conn, "revision") or 0) + 1
        stamped = now_iso()
        self._set_info(conn, "revision", str(revision))
        self._set_info(conn, "updated_at", stamped)
        conn.execute(
            "INSERT INTO change_log(at, revision, action, detail) VALUES(?,?,?,?)",
            (stamped, revision, action, detail[:500]),
        )
        conn.execute(
            "DELETE FROM change_log WHERE id <= (SELECT MAX(id) - ? FROM change_log)", (LOG_KEEP,)
        )
        return revision

    # ------------------------------------------------------------------ #
    # 读
    # ------------------------------------------------------------------ #
    def revision(self) -> int:
        with self._lock:
            conn = self.connection()
            try:
                return int(self._info(conn, "revision") or 0)
            finally:
                conn.close()

    def load_document(self) -> Dict[str, Any]:
        """完整文档（带内部 id）。界面就是拿这份做本地镜像的。"""
        with self._lock:
            conn = self.connection()
            try:
                return self._document(conn)
            finally:
                conn.close()

    def _document(self, conn: sqlite3.Connection) -> Dict[str, Any]:
        revision = int(self._info(conn, "revision") or 0)
        updated_at = self._info(conn, "updated_at") or None
        names = {row["char"]: row["name"] for row in conn.execute("SELECT char, name FROM char_name")}

        panels: Dict[str, List[int]] = {}
        for row in conn.execute(
            "SELECT panel.id AS id, panel_char.char AS char FROM panel "
            "JOIN panel_char ON panel_char.panel_id = panel.id ORDER BY panel_char.char"
        ):
            panels.setdefault(row["id"], []).append(row["char"])

        by_chapter: Dict[str, List[Dict[str, Any]]] = {}
        for row in conn.execute("SELECT id, chapter_id FROM panel ORDER BY chapter_id, position"):
            by_chapter.setdefault(row["chapter_id"], []).append({"id": row["id"], "chars": panels.get(row["id"], [])})

        chapters = []
        for row in conn.execute("SELECT id, no, title, note FROM chapter ORDER BY no"):
            chapters.append({
                "id": row["id"],
                "no": row["no"],
                "title": row["title"],
                "note": row["note"],
                "panels": by_chapter.get(row["id"], []),
            })

        return {
            "schema": SCHEMA_NAME,
            "schemaVersion": EXPORT_VERSION,
            "revision": revision,
            "updatedAt": updated_at,
            "meta": {
                "title": self._info(conn, "title") or self.title,
                "author": self._info(conn, "author") or "",
                "charMin": CHAR_MIN,
                "charMax": CHAR_MAX,
                "charNames": {str(k): v for k, v in names.items()},
            },
            "chapters": chapters,
        }

    def load_index(self) -> Dict[str, Any]:
        """轻量目录：只有话的元信息与计数，不带槽位内容。数据量大时先拉这个。"""
        with self._lock:
            conn = self.connection()
            try:
                rows = conn.execute(
                    "SELECT c.id, c.no, c.title, c.note, c.updated_at, "
                    "  COUNT(DISTINCT p.id) AS panels, "
                    "  COUNT(pc.char) AS appearances, "
                    "  COUNT(DISTINCT pc.char) AS chars "
                    "FROM chapter c "
                    "LEFT JOIN panel p ON p.chapter_id = c.id "
                    "LEFT JOIN panel_char pc ON pc.panel_id = p.id "
                    "GROUP BY c.id ORDER BY c.no"
                ).fetchall()
                chapters = [dict(row) for row in rows]
                totals = conn.execute(
                    "SELECT (SELECT COUNT(*) FROM chapter) AS chapters, "
                    "       (SELECT COUNT(*) FROM panel) AS panels, "
                    "       (SELECT COUNT(DISTINCT char) FROM panel_char) AS distinct_chars, "
                    "       (SELECT COUNT(*) FROM panel_char) AS appearances"
                ).fetchone()
                return {
                    "revision": int(self._info(conn, "revision") or 0),
                    "updatedAt": self._info(conn, "updated_at") or None,
                    "chapters": chapters,
                    "stats": dict(totals),
                }
            finally:
                conn.close()

    def load_chapter(self, chapter_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            conn = self.connection()
            try:
                row = conn.execute(
                    "SELECT id, no, title, note FROM chapter WHERE id = ?", (chapter_id,)
                ).fetchone()
                if row is None:
                    return None
                panels = [
                    {"id": p["id"], "chars": [
                        c["char"] for c in conn.execute(
                            "SELECT char FROM panel_char WHERE panel_id = ? ORDER BY char", (p["id"],))
                    ]}
                    for p in conn.execute(
                        "SELECT id FROM panel WHERE chapter_id = ? ORDER BY position", (chapter_id,))
                ]
                return {"id": row["id"], "no": row["no"], "title": row["title"],
                        "note": row["note"], "panels": panels}
            finally:
                conn.close()

    def char_names(self) -> Dict[str, str]:
        with self._lock:
            conn = self.connection()
            try:
                return {str(r["char"]): r["name"] for r in conn.execute("SELECT char, name FROM char_name")}
            finally:
                conn.close()

    def stats(self) -> Dict[str, Any]:
        """角色出场次数（按分镜计，同一槽位同一角色只算一次）。"""
        with self._lock:
            conn = self.connection()
            try:
                rows = conn.execute(
                    "SELECT pc.char AS char, COUNT(*) AS panels, COALESCE(cn.name, '') AS name "
                    "FROM panel_char pc LEFT JOIN char_name cn ON cn.char = pc.char "
                    "GROUP BY pc.char ORDER BY panels DESC, pc.char ASC"
                ).fetchall()
                totals = conn.execute(
                    "SELECT (SELECT COUNT(*) FROM chapter) AS chapters, "
                    "       (SELECT COUNT(*) FROM panel) AS panels, "
                    "       (SELECT COUNT(DISTINCT char) FROM panel_char) AS distinct_chars, "
                    "       (SELECT COUNT(*) FROM panel_char) AS appearances"
                ).fetchone()
                return {
                    "chapters": totals["chapters"],
                    "panels": totals["panels"],
                    "distinct_chars": totals["distinct_chars"],
                    "appearances": totals["appearances"],
                    "characters": [
                        {"char": r["char"], "name": r["name"], "panels": r["panels"]} for r in rows
                    ],
                }
            finally:
                conn.close()

    def find_char(self, char: int) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self.connection()
            try:
                rows = conn.execute(
                    "SELECT c.id AS chapterId, c.no AS chapterNo, c.title AS chapterTitle, "
                    "       p.id AS panelId, p.position AS panelIndex "
                    "FROM panel_char pc JOIN panel p ON p.id = pc.panel_id "
                    "JOIN chapter c ON c.id = p.chapter_id "
                    "WHERE pc.char = ? ORDER BY c.no, p.position", (char,)
                ).fetchall()
                return [dict(r) for r in rows]
            finally:
                conn.close()

    def search(self, text: str) -> Dict[str, Any]:
        """按标题/备注/角色名搜索。"""
        query = (text or "").strip()
        if not query:
            return {"chapters": [], "charNames": []}
        like = f"%{query}%"
        with self._lock:
            conn = self.connection()
            try:
                chapters = [
                    {"id": r["id"], "no": r["no"], "title": r["title"]}
                    for r in conn.execute(
                        "SELECT id, no, title FROM chapter WHERE title LIKE ? OR note LIKE ? ORDER BY no",
                        (like, like))
                ]
                names = [
                    {"char": r["char"], "name": r["name"]}
                    for r in conn.execute(
                        "SELECT char, name FROM char_name WHERE name LIKE ? ORDER BY char", (like,))
                ]
                return {"chapters": chapters, "charNames": names}
            finally:
                conn.close()

    def recent_log(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self.connection()
            try:
                rows = conn.execute(
                    "SELECT at, revision, action, detail FROM change_log ORDER BY id DESC LIMIT ?",
                    (max(1, min(500, int(limit))),))
                return [dict(r) for r in rows]
            finally:
                conn.close()

    # ------------------------------------------------------------------ #
    # 写：补丁
    # ------------------------------------------------------------------ #
    def apply_patch(
        self,
        ops: Sequence[Dict[str, Any]],
        expected_revision: Optional[int] = None,
        force: bool = False,
        label: str = "patch",
        include_document: bool = False,
    ) -> Dict[str, Any]:
        """在一个事务里应用一批操作，成功后 revision +1。

        默认**不**回传整份文档：补丁是增量的，每次写入的代价应当与「改了多少」成正比，
        而不是与「数据有多大」成正比。只有调用方明确要（include_document=True）才组装。
        """
        if not isinstance(ops, list) or not ops:
            raise OpError(0, "ops 必须是非空数组")
        issues: List[Dict[str, str]] = []
        applied: List[str] = []
        with self._lock:
            conn = self.connection()
            try:
                # VACUUM INTO 不能在事务里跑，所以先留快照再开事务（快照是改动前的状态）
                if self.exists() and self._should_backup():
                    self._backup_conn(conn)
                conn.execute("BEGIN IMMEDIATE")
                current = int(self._info(conn, "revision") or 0)
                if expected_revision is not None and not force and int(expected_revision) != current:
                    conn.execute("ROLLBACK")
                    raise RevisionConflict(current, self._document(conn))
                for index, op in enumerate(ops):
                    if not isinstance(op, dict) or not isinstance(op.get("op"), str):
                        raise OpError(index, "缺少 op 字段")
                    handler = getattr(self, "_op_" + op["op"].replace(".", "_"), None)
                    if handler is None:
                        raise OpError(index, f"不认识的操作 {op['op']!r}")
                    handler(conn, op, issues)
                    applied.append(op["op"])
                revision = self._bump_revision(conn, label, ",".join(sorted(set(applied))))
                document = self._document(conn) if include_document else None
                conn.execute("COMMIT")
                self.last_issues = issues
                result: Dict[str, Any] = {"revision": revision, "applied": applied, "issues": issues}
                if include_document:
                    result["db"] = document
                return result
            except (RevisionConflict, OpError, ValidationError):
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            except sqlite3.Error as exc:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise OpError(0, f"数据库错误：{exc}") from exc
            finally:
                conn.close()

    # ---- 各个 op 的实现 -------------------------------------------------- #
    def _op_chapter_upsert(self, conn: sqlite3.Connection, op: Dict[str, Any],
                           issues: List[Dict[str, str]]) -> None:
        raw = op.get("chapter") or {}
        if not isinstance(raw, dict):
            raise OpError(0, "chapter 必须是对象")
        chapter_id = raw.get("id")
        if not isinstance(chapter_id, str) or not chapter_id:
            chapter_id = new_id("ch")
        title = raw.get("title") if isinstance(raw.get("title"), str) else ""
        note = raw.get("note") if isinstance(raw.get("note"), str) else ""
        stored = now_iso()

        exists = conn.execute("SELECT 1 FROM chapter WHERE id = ?", (chapter_id,)).fetchone() is not None
        if exists:
            conn.execute("UPDATE chapter SET title = ?, note = ?, updated_at = ? WHERE id = ?",
                         (title, note, stored, chapter_id))
            conn.execute("DELETE FROM panel WHERE chapter_id = ?", (chapter_id,))
        else:
            position = op.get("position")
            ids = self._chapter_ids(conn)
            if not isinstance(position, int) or not 1 <= position <= len(ids) + 1:
                position = len(ids) + 1
            ids.insert(position - 1, chapter_id)
            self._insert_chapter(conn, chapter_id, title, note, stored)
            self._set_chapter_order(conn, ids)

        panels_in = op.get("panels")
        if panels_in is None:
            panels_in = []
        if not isinstance(panels_in, list):
            raise OpError(0, "panels 必须是数组")
        seen_ids = {row["id"] for row in conn.execute("SELECT id FROM panel")}
        for index, raw_panel in enumerate(panels_in):
            if not isinstance(raw_panel, dict):
                _issue(issues, "error", f"panels[{index}]", "槽位不是对象，已跳过")
                continue
            panel_id = raw_panel.get("id")
            if not isinstance(panel_id, str) or not panel_id or panel_id in seen_ids:
                panel_id = new_id("pn")
            seen_ids.add(panel_id)
            chars = clean_chars(raw_panel.get("chars"), issues, f"panels[{index}].chars")
            conn.execute(
                "INSERT INTO panel(id, chapter_id, position, updated_at) VALUES(?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET chapter_id = excluded.chapter_id, updated_at = excluded.updated_at",
                (panel_id, chapter_id, index + 1, stored),
            )
            self._set_panel_chars(conn, panel_id, chars)
        self._set_panel_order(conn, chapter_id, [
            row["id"] for row in conn.execute(
                "SELECT id FROM panel WHERE chapter_id = ? ORDER BY position", (chapter_id,))
        ])

    def _op_chapter_update(self, conn: sqlite3.Connection, op: Dict[str, Any], _issues) -> None:
        chapter_id = op.get("id")
        if not self._chapter_exists(conn, chapter_id):
            raise OpError(0, f"找不到这一话：{chapter_id}")
        sets, params = [], []
        if isinstance(op.get("title"), str):
            sets.append("title = ?")
            params.append(op["title"])
        if isinstance(op.get("note"), str):
            sets.append("note = ?")
            params.append(op["note"])
        if not sets:
            return
        sets.append("updated_at = ?")
        params.extend([now_iso(), chapter_id])
        conn.execute(f"UPDATE chapter SET {', '.join(sets)} WHERE id = ?", params)

    def _op_chapter_delete(self, conn: sqlite3.Connection, op: Dict[str, Any], _issues) -> None:
        chapter_id = op.get("id")
        conn.execute("DELETE FROM panel_char WHERE panel_id IN (SELECT id FROM panel WHERE chapter_id = ?)",
                     (chapter_id,))
        conn.execute("DELETE FROM panel WHERE chapter_id = ?", (chapter_id,))
        conn.execute("DELETE FROM chapter WHERE id = ?", (chapter_id,))
        self._set_chapter_order(conn, self._chapter_ids(conn))

    def _op_chapter_order(self, conn: sqlite3.Connection, op: Dict[str, Any], _issues) -> None:
        ids = op.get("ids")
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise OpError(0, "ids 必须是字符串数组")
        current = self._chapter_ids(conn)
        known = set(current)
        wanted = [i for i in ids if i in known]
        wanted += [i for i in current if i not in set(wanted)]   # 漏掉的按原顺序补在后面
        self._set_chapter_order(conn, wanted)

    def _op_chapter_move(self, conn: sqlite3.Connection, op: Dict[str, Any], _issues) -> None:
        chapter_id, to = op.get("id"), op.get("to")
        current = self._chapter_ids(conn)
        if chapter_id not in current:
            raise OpError(0, f"找不到这一话：{chapter_id}")
        current.remove(chapter_id)
        target = max(1, min(len(current) + 1, int(to) if isinstance(to, int) else len(current) + 1))
        current.insert(target - 1, chapter_id)
        self._set_chapter_order(conn, current)

    def _op_chapter_swap(self, conn: sqlite3.Connection, op: Dict[str, Any], _issues) -> None:
        first, second = op.get("a"), op.get("b")
        current = self._chapter_ids(conn)
        if first not in current or second not in current:
            raise OpError(0, "a / b 必须是已存在的话 id")
        i, j = current.index(first), current.index(second)
        current[i], current[j] = current[j], current[i]
        self._set_chapter_order(conn, current)

    def _op_panel_upsert(self, conn: sqlite3.Connection, op: Dict[str, Any],
                         issues: List[Dict[str, str]]) -> None:
        chapter_id = op.get("chapterId")
        if not self._chapter_exists(conn, chapter_id):
            raise OpError(0, f"找不到这一话：{chapter_id}")
        raw = op.get("panel") or {}
        if not isinstance(raw, dict):
            raise OpError(0, "panel 必须是对象")
        panel_id = raw.get("id")
        if not isinstance(panel_id, str) or not panel_id:
            panel_id = new_id("pn")
            taken = {row["id"] for row in conn.execute("SELECT id FROM panel")}
            while panel_id in taken:
                panel_id = new_id("pn")
        chars = clean_chars(raw.get("chars"), issues, "panel.chars")
        conn.execute(
            "INSERT INTO panel(id, chapter_id, position, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET chapter_id = excluded.chapter_id, updated_at = excluded.updated_at",
            (panel_id, chapter_id, 10 ** 6, now_iso()),
        )
        self._set_panel_chars(conn, panel_id, chars)
        ids = [row["id"] for row in conn.execute(
            "SELECT id FROM panel WHERE chapter_id = ? ORDER BY position", (chapter_id,)) if row["id"] != panel_id]
        position = op.get("position")
        target = int(position) if isinstance(position, int) else len(ids) + 1
        target = max(1, min(len(ids) + 1, target))
        ids.insert(target - 1, panel_id)
        self._set_panel_order(conn, chapter_id, ids)

    def _op_panel_delete(self, conn: sqlite3.Connection, op: Dict[str, Any], _issues) -> None:
        panel_id = op.get("id")
        row = conn.execute("SELECT chapter_id FROM panel WHERE id = ?", (panel_id,)).fetchone()
        conn.execute("DELETE FROM panel_char WHERE panel_id = ?", (panel_id,))
        conn.execute("DELETE FROM panel WHERE id = ?", (panel_id,))
        if row:
            self._set_panel_order(conn, row["chapter_id"], [
                r["id"] for r in conn.execute(
                    "SELECT id FROM panel WHERE chapter_id = ? ORDER BY position", (row["chapter_id"],))
            ])

    def _op_panel_chars(self, conn: sqlite3.Connection, op: Dict[str, Any],
                        issues: List[Dict[str, str]]) -> None:
        panel_id = op.get("panelId")
        if conn.execute("SELECT 1 FROM panel WHERE id = ?", (panel_id,)).fetchone() is None:
            raise OpError(0, f"找不到这个槽位：{panel_id}")
        chars = clean_chars(op.get("chars"), issues, "panel.chars")
        self._set_panel_chars(conn, panel_id, chars)
        conn.execute("UPDATE panel SET updated_at = ? WHERE id = ?", (now_iso(), panel_id))

    def _op_meta_update(self, conn: sqlite3.Connection, op: Dict[str, Any], _issues) -> None:
        if isinstance(op.get("title"), str) and op["title"].strip():
            self._set_info(conn, "title", op["title"])
        if isinstance(op.get("author"), str):
            self._set_info(conn, "author", op["author"])

    def _op_charName_setMany(self, conn: sqlite3.Connection, op: Dict[str, Any],
                             issues: List[Dict[str, str]]) -> None:
        names = op.get("names")
        if not isinstance(names, dict):
            raise OpError(0, "names 必须是对象")
        cleaned: Dict[int, str] = {}
        for key, value in names.items():
            try:
                number = int(str(key).strip())
            except (TypeError, ValueError):
                _issue(issues, "warn", "names", f"忽略非法编号键：{key!r}")
                continue
            if not (CHAR_MIN <= number <= CHAR_MAX):
                _issue(issues, "warn", "names", f"忽略越界编号：{number}")
                continue
            if isinstance(value, str) and value.strip():
                cleaned[number] = value
        conn.execute("DELETE FROM char_name")
        conn.executemany("INSERT INTO char_name(char, name) VALUES(?,?)",
                         sorted(cleaned.items()))

    def _op_clear(self, conn: sqlite3.Connection, _op: Dict[str, Any], _issues) -> None:
        conn.execute("DELETE FROM panel_char")
        conn.execute("DELETE FROM panel")
        conn.execute("DELETE FROM chapter")
        conn.execute("DELETE FROM char_name")

    def _op_replace(self, conn: sqlite3.Connection, op: Dict[str, Any],
                    issues: List[Dict[str, str]]) -> None:
        raw = op.get("db", op.get("document"))
        if raw is None:
            raise OpError(0, "缺少 db 字段")
        if not isinstance(raw, dict):
            raise OpError(0, "db 必须是对象")
        document = normalize_document(raw, issues, self.title)
        self._write_document(conn, document)
        if document["meta"].get("title"):
            self._set_info(conn, "title", document["meta"]["title"])
        self._set_info(conn, "author", document["meta"].get("author", ""))

    # ---- 底层写入工具 ---------------------------------------------------- #
    @staticmethod
    def _chapter_exists(conn: sqlite3.Connection, chapter_id: Any) -> bool:
        if not isinstance(chapter_id, str) or not chapter_id:
            return False
        return conn.execute("SELECT 1 FROM chapter WHERE id = ?", (chapter_id,)).fetchone() is not None

    @staticmethod
    def _insert_chapter(conn: sqlite3.Connection, chapter_id: str, title: str, note: str, stamped: str) -> None:
        # no 先给一个临时负数，随后由 _set_chapter_order 统一编号
        used = conn.execute("SELECT COALESCE(MIN(no), 0) AS m FROM chapter").fetchone()["m"]
        conn.execute(
            "INSERT INTO chapter(id, no, title, note, updated_at) VALUES(?,?,?,?,?)",
            (chapter_id, min(0, used) - 1, title, note, stamped),
        )

    @staticmethod
    def _chapter_ids(conn: sqlite3.Connection) -> List[str]:
        return [row["id"] for row in conn.execute("SELECT id FROM chapter ORDER BY no")]

    @staticmethod
    def _set_chapter_order(conn: sqlite3.Connection, ids: Sequence[str]) -> None:
        """先把 no 整体挪到很远的地方，再按目标顺序写 1..N，绕开 UNIQUE(no) 冲突。

        偏移量取 1000000：现有 no 恒为 ≥ -1（临时值），减完之后变成 ≤ -999999，
        与尚未处理的行（≥ -1）绝不会撞车，且 x → x-1000000 本身是单射。
        """
        conn.execute("UPDATE chapter SET no = no - 1000000")
        conn.executemany("UPDATE chapter SET no = ? WHERE id = ?",
                         [(index + 1, chapter_id) for index, chapter_id in enumerate(ids)])

    @staticmethod
    def _set_panel_order(conn: sqlite3.Connection, chapter_id: str, ids: Sequence[str]) -> None:
        conn.execute("UPDATE panel SET position = position - 1000000 WHERE chapter_id = ?", (chapter_id,))
        conn.executemany("UPDATE panel SET position = ? WHERE id = ?",
                         [(index + 1, panel_id) for index, panel_id in enumerate(ids)])

    @staticmethod
    def _set_panel_chars(conn: sqlite3.Connection, panel_id: str, chars: Sequence[int]) -> None:
        conn.execute("DELETE FROM panel_char WHERE panel_id = ?", (panel_id,))
        if chars:
            conn.executemany("INSERT OR IGNORE INTO panel_char(panel_id, char) VALUES(?,?)",
                             [(panel_id, int(char)) for char in chars])

    def _write_document(self, conn: sqlite3.Connection, document: Dict[str, Any]) -> None:
        conn.execute("DELETE FROM panel_char")
        conn.execute("DELETE FROM panel")
        conn.execute("DELETE FROM chapter")
        conn.execute("DELETE FROM char_name")
        for name_key, name in (document["meta"].get("charNames") or {}).items():
            number = int(name_key)
            if CHAR_MIN <= number <= CHAR_MAX and isinstance(name, str) and name.strip():
                conn.execute("INSERT OR REPLACE INTO char_name(char, name) VALUES(?,?)", (number, name))
        stamped = now_iso()
        for index, chapter in enumerate(document["chapters"], start=1):
            conn.execute("INSERT INTO chapter(id, no, title, note, updated_at) VALUES(?,?,?,?,?)",
                         (chapter["id"], index, chapter.get("title", ""), chapter.get("note", ""), stamped))
            for pindex, panel in enumerate(chapter.get("panels", []), start=1):
                conn.execute("INSERT INTO panel(id, chapter_id, position, updated_at) VALUES(?,?,?,?)",
                             (panel["id"], chapter["id"], pindex, stamped))
                self._set_panel_chars(conn, panel["id"], panel.get("chars", []))

    # ---- 整库替换 / 导入 -------------------------------------------------- #
    def replace_all(self, raw: Any, expected_revision: Optional[int] = None,
                    force: bool = True, strict: bool = False, label: str = "replace") -> Dict[str, Any]:
        """整库替换（PUT /api/db 用）。会回传整份文档，方便调用方直接拿到新状态。"""
        return self.apply_patch([{"op": "replace", "db": raw}], expected_revision=expected_revision,
                                force=force, label=label, include_document=True)

    def _import_into(self, conn: sqlite3.Connection, source: Path) -> Dict[str, Any]:
        """把一份 JSON 文件写进当前连接（调用方负责事务）。"""
        text = source.read_text(encoding="utf-8")
        if not text.strip():
            document = normalize_document({"chapters": []}, [], self.title)
        else:
            try:
                document = normalize_document(json.loads(text), [], self.title)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{source.name} 不是合法 JSON：{exc}") from exc
        conn.execute("BEGIN IMMEDIATE")
        try:
            self._write_document(conn, document)
            if document["meta"].get("title"):
                self._set_info(conn, "title", document["meta"]["title"])
            self._set_info(conn, "author", document["meta"].get("author", ""))
            revision = self._bump_revision(conn, "import", source.name)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        stats = {
            "source": str(source),
            "revision": revision,
            "chapters": len(document["chapters"]),
            "panels": sum(len(c["panels"]) for c in document["chapters"]),
            "chars": sum(len(p["chars"]) for c in document["chapters"] for p in c["panels"]),
        }
        return stats

    def import_json(self, source: Union[str, os.PathLike, Dict[str, Any]], archive: bool = False,
                    label: str = "import") -> Dict[str, Any]:
        """从 JSON 文件（或直接给对象）导入，可顺带把源文件归档。"""
        with self._lock:
            conn = self.connection()
            try:
                if isinstance(source, (str, os.PathLike)):
                    path = Path(source).resolve()
                    if not path.is_file():
                        raise FileNotFoundError(f"找不到文件：{path}")
                    stats = self._import_into(conn, path)
                    stats["source"] = str(path)
                else:
                    document = normalize_document(source, [], self.title)
                    conn.execute("BEGIN IMMEDIATE")
                    try:
                        self._write_document(conn, document)
                        if document["meta"].get("title"):
                            self._set_info(conn, "title", document["meta"]["title"])
                        self._set_info(conn, "author", document["meta"].get("author", ""))
                        revision = self._bump_revision(conn, label, "object")
                        conn.execute("COMMIT")
                    except Exception:
                        conn.execute("ROLLBACK")
                        raise
                    stats = {
                        "source": "(object)", "revision": revision,
                        "chapters": len(document["chapters"]),
                        "panels": sum(len(c["panels"]) for c in document["chapters"]),
                        "chars": sum(len(p["chars"]) for c in document["chapters"] for p in c["panels"]),
                    }
                if archive and stats["source"] not in ("(object)",):
                    archived = self._archive_legacy(Path(stats["source"]))
                    stats["archived"] = str(archived) if archived else None
                return stats
            finally:
                conn.close()

    def clear(self, label: str = "clear") -> Dict[str, Any]:
        return self.apply_patch([{"op": "clear"}], label=label)

    # ------------------------------------------------------------------ #
    # 导出
    # ------------------------------------------------------------------ #
    def export_document(self) -> Dict[str, Any]:
        """导出格式：**不含内部 id**，可以长期保存或交给别的程序。"""
        return strip_ids(self.load_document())

    def export_json(self) -> str:
        return pretty_json(self.export_document())

    def export_csv(self) -> str:
        """话-分镜 × 0..100 的 0/1 矩阵。"""
        document = self.load_document()
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\r\n")
        columns = list(range(CHAR_MIN, CHAR_MAX + 1))
        writer.writerow(["话-分镜"] + [str(char) for char in columns])
        for chapter in document["chapters"]:
            for index, panel in enumerate(chapter["panels"], start=1):
                chars = set(panel["chars"])
                writer.writerow(
                    [f"{chapter['no']}-{index}"] +
                    [1 if char in chars else 0 for char in columns]
                )
        return buffer.getvalue()

    # ------------------------------------------------------------------ #
    # 备份 / 回滚 / 校验
    # ------------------------------------------------------------------ #
    def _backup_conn(self, conn: sqlite3.Connection) -> Optional[Path]:
        if not self.exists():
            return None
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = self.backup_dir / f"{self.path.stem}-{stamp}.sqlite3"
        if target.exists():
            target = self.backup_dir / f"{self.path.stem}-{stamp}-{new_id('b')}.sqlite3"
        conn.execute("VACUUM INTO ?", (str(target),))
        self._prune_backups()
        return target

    def create_backup(self, tag: str = "") -> Path:
        with self._lock:
            conn = self.connection()
            try:
                target = self._backup_conn(conn)
            finally:
                conn.close()
            if target is None:
                raise FileNotFoundError("还没有数据库文件可备份")
            if tag and target.exists():
                renamed = target.with_name(f"{target.stem}-{tag}{target.suffix}")
                target.replace(renamed)
                target = renamed
            return target

    def list_backups(self) -> List[Dict[str, Any]]:
        if not self.backup_dir.is_dir():
            return []
        items = []
        for file in sorted(self.backup_dir.glob(f"{self.path.stem}-*"), reverse=True):
            if not file.is_file():
                continue
            stat = file.stat()
            items.append({
                "name": file.name, "size": stat.st_size,
                "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds"),
            })
        return items

    def restore_backup(self, name: str) -> Dict[str, Any]:
        """把快照内容整体拷回当前库（先给当前状态留一份底，再在事务里换掉）。"""
        source = (self.backup_dir / Path(name).name).resolve()
        if source.parent != self.backup_dir or not source.is_file():
            raise FileNotFoundError(f"找不到快照：{name}")
        if self.exists():
            self.create_backup(tag="before-restore")
        snapshot = GirlsDB(source, backup_dir=self.backup_dir, backup_interval=0, legacy_json=None)
        try:
            document = snapshot.load_document()
        finally:
            snapshot.close()
        with self._lock:
            conn = self.connection()
            try:
                conn.execute("BEGIN IMMEDIATE")
                self._write_document(conn, document)
                self._set_info(conn, "title", document["meta"].get("title") or self.title)
                self._set_info(conn, "author", document["meta"].get("author", ""))
                revision = self._bump_revision(conn, "restore", Path(name).name)
                conn.execute("COMMIT")
                return {"revision": revision, "restored": Path(name).name, "db": self._document(conn)}
            except Exception:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            finally:
                conn.close()

    def _should_backup(self) -> bool:
        if self.backup_interval <= 0:
            return False
        files = [f for f in self.backup_dir.glob(f"{self.path.stem}-*") if f.is_file()] if self.backup_dir.is_dir() else []
        if not files:
            return True
        newest = max(f.stat().st_mtime for f in files)
        return (datetime.now().timestamp() - newest) >= self.backup_interval

    def _prune_backups(self) -> None:
        files = sorted((f for f in self.backup_dir.glob(f"{self.path.stem}-*") if f.is_file()), reverse=True)
        for stale in files[self.backup_keep:]:
            try:
                stale.unlink()
            except OSError:
                pass

    def integrity_check(self) -> List[Dict[str, str]]:
        """结构与内容检查，返回问题列表（空 = 没问题）。"""
        issues: List[Dict[str, str]] = []
        with self._lock:
            conn = self.connection()
            try:
                result = conn.execute("PRAGMA integrity_check").fetchone()[0]
                if result != "ok":
                    _issue(issues, "error", "database", f"SQLite 完整性检查未通过：{result}")
                for row in conn.execute("PRAGMA foreign_key_check"):
                    _issue(issues, "error", "foreign_key", f"外键不完整：{dict(row)}")
                bad_chars = conn.execute(
                    "SELECT COUNT(*) AS c FROM panel_char WHERE char < ? OR char > ?",
                    (CHAR_MIN, CHAR_MAX)).fetchone()["c"]
                if bad_chars:
                    _issue(issues, "error", "panel_char", f"{bad_chars} 条角色编号超出范围")
                missing = conn.execute(
                    "SELECT COUNT(*) AS c FROM panel p LEFT JOIN chapter c ON c.id = p.chapter_id "
                    "WHERE c.id IS NULL").fetchone()["c"]
                if missing:
                    _issue(issues, "error", "panel", f"{missing} 个槽位没有对应的话")
                if conn.execute("SELECT COUNT(*) AS c FROM chapter").fetchone()["c"]:
                    numbers = [r["no"] for r in conn.execute("SELECT no FROM chapter ORDER BY no")]
                    if numbers != list(range(1, len(numbers) + 1)):
                        _issue(issues, "warn", "chapter.no", f"话编号不连续：{numbers[:10]}…")
                if self._info(conn, "schema_version") not in (None, str(STORAGE_VERSION)):
                    _issue(issues, "warn", "schema_version",
                           f"存储版本 {self._info(conn, 'schema_version')} 与程序支持的 {STORAGE_VERSION} 不一致")
            finally:
                conn.close()
        return issues

    def db_size(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.path) + suffix)
            if candidate.is_file():
                total += candidate.stat().st_size
        return total


# --------------------------------------------------------------------------- #
# 建表 SQL（与 schema/girls_dict.sql 保持一致）
# --------------------------------------------------------------------------- #
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS info (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter (
  id         TEXT PRIMARY KEY,
  no         INTEGER NOT NULL UNIQUE,
  title      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS panel (
  id         TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  updated_at TEXT,
  UNIQUE (chapter_id, position)
);
CREATE INDEX IF NOT EXISTS idx_panel_chapter ON panel(chapter_id, position);

CREATE TABLE IF NOT EXISTS panel_char (
  panel_id TEXT NOT NULL REFERENCES panel(id) ON DELETE CASCADE,
  char     INTEGER NOT NULL CHECK (char BETWEEN 0 AND 100),
  PRIMARY KEY (panel_id, char)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_panel_char_char ON panel_char(char);

CREATE TABLE IF NOT EXISTS char_name (
  char INTEGER PRIMARY KEY CHECK (char BETWEEN 0 AND 100),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action   TEXT NOT NULL,
  detail   TEXT
);
"""


if __name__ == "__main__":  # pragma: no cover - 手工调试
    import argparse

    parser = argparse.ArgumentParser(description="girls_dict 数据层自检")
    parser.add_argument("path", nargs="?", default="data/girls_dict.sqlite3")
    parser.add_argument("--index", action="store_true", help="打印轻量目录")
    parser.add_argument("--stats", action="store_true", help="打印统计")
    parser.add_argument("--check", action="store_true", help="完整性检查")
    args = parser.parse_args()
    database = GirlsDB(args.path)
    database.initialize()
    if args.check:
        print(json.dumps(database.integrity_check(), ensure_ascii=False, indent=2))
    elif args.index:
        print(json.dumps(database.load_index(), ensure_ascii=False, indent=2))
    elif args.stats:
        print(json.dumps(database.stats(), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(database.load_document(), ensure_ascii=False, indent=2))
