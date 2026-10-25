#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 SQLite 数据导出为 ``docs/data`` 下的分片 JSON，并可选提交/推送到 Git。

公开站只读这里的静态文件；管理端仍然只在本机写 SQLite。

目录结构（相对仓库根目录）::

    docs/data/manifest.json         版本、计数、文件清单
    docs/data/stats.json            各角色出场分镜数（条形图数据）
    docs/data/chapters/index.json   话目录
    docs/data/chapters/0001.json    每一话的分镜与角色编号

数据量变大时，话文件天然分片；公开站按需读取，不会一次拉整本书。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from girls_db import (CHAR_MAX, CHAR_MIN, EXPORT_VERSION, SCHEMA_NAME, GirlsDB,
                      ValidationError, strip_ids, validate_export_document)
from json_pretty import dumps as pretty_json

SITE_FORMAT_VERSION = 4

SITE_DIR = Path("docs")
DATA_DIR = SITE_DIR / "data"
CHAPTER_DIR = DATA_DIR / "chapters"
PUBLISH_LOCK = threading.Lock()
GIT_TIMEOUT = 90
MAX_OUTPUT = 4000

DEFAULT_MESSAGE = "data: rev {revision}（{chapters} 话 / {panels} 分镜）"


class PublishError(Exception):
    """发布过程中可直接展示给用户的错误。"""


# --------------------------------------------------------------------------- #
# 生成分片 JSON
# --------------------------------------------------------------------------- #
def _json(value: Any) -> str:
    return pretty_json(value)


def build_payload(document: Dict[str, Any], revision: int) -> Dict[str, str]:
    """根据当前完整 JSON 文档生成全部公开分片。"""
    issues = validate_export_document(document)
    if issues:
        raise ValidationError(issues)
    meta = document["meta"]
    names = {str(key): str(value) for key, value in (meta.get("charNames") or {}).items()}
    exported_at = str(document.get("exportedAt") or "")
    chapters = list(document.get("chapters") or [])

    totals: Dict[int, Dict[str, float]] = {}
    first_chapter: Dict[int, int] = {}
    seen_chars: set[int] = set()
    total_panels = 0
    total_appearances = 0
    chapter_rows: List[Dict[str, Any]] = []
    chapter_files: Dict[str, str] = {}

    for index, chapter in enumerate(chapters):
        no = int(chapter.get("no") or (index + 1))
        panels = list(chapter.get("panels") or [])
        panel_rows: List[Dict[str, Any]] = []
        chapter_chars: set[int] = set()
        for panel in panels:
            chars = sorted({int(char) for char in (panel.get("chars") or [])})
            panel_rows.append({"chars": chars})
            chapter_chars.update(chars)

        chapter_appearances = sum(len(panel["chars"]) for panel in panel_rows)
        if chapter_appearances == 0:
            # 只有标题和空分镜的占位话不进入公开数据（数据库里仍保留）。
            continue

        for char in chapter_chars:
            first_chapter.setdefault(char, no)
        seen_chars.update(chapter_chars)
        weight = len(seen_chars)

        chapter_metrics: Dict[int, Dict[str, float]] = {}
        for panel in panel_rows:
            chars = panel["chars"]
            count = len(chars)
            if not count:
                continue
            point_each = 8.0 / 10.0 / count
            weighted_each = float(weight) / 10.0 / count
            for char in chars:
                metric = chapter_metrics.setdefault(
                    char, {"count": 0.0, "points": 0.0, "weighted": 0.0})
                metric["count"] += 1
                metric["points"] += point_each
                metric["weighted"] += weighted_each
                total = totals.setdefault(
                    char, {"count": 0.0, "points": 0.0, "weighted": 0.0})
                total["count"] += 1
                total["points"] += point_each
                total["weighted"] += weighted_each

        total_panels += len(panel_rows)
        total_appearances += chapter_appearances
        metrics_json = {
            str(char): {
                "count": int(metric["count"]),
                "points": round(metric["points"], 6),
                "weighted": round(metric["weighted"], 6),
            }
            for char, metric in sorted(chapter_metrics.items())
        }
        filename = f"{no:04d}.json"
        chapter_rows.append({
            "no": no,
            "title": str(chapter.get("title") or ""),
            "note": str(chapter.get("note") or ""),
            "panelCount": len(panel_rows),
            "appearances": chapter_appearances,
            "characters": sorted(chapter_chars),
            "weight": weight,
            "metrics": metrics_json,
            "file": filename,
        })
        chapter_files[f"chapters/{filename}"] = _json({
            "schema": SCHEMA_NAME,
            "schemaVersion": EXPORT_VERSION,
            "formatVersion": SITE_FORMAT_VERSION,
            "no": no,
            "title": str(chapter.get("title") or ""),
            "note": str(chapter.get("note") or ""),
            "panelCount": len(panel_rows),
            "appearances": chapter_appearances,
            "characters": sorted(chapter_chars),
            "panels": panel_rows,
        })

    characters: List[Dict[str, Any]] = []
    for char in range(CHAR_MIN, CHAR_MAX + 1):
        total = totals.get(char)
        count = int(total["count"]) if total else 0
        characters.append({
            "char": char,
            "name": names.get(str(char), ""),
            "count": count,
            "points": round(total["points"], 1) if total else 0.0,
            "weighted": round(total["weighted"], 1) if total else 0.0,
            "density": 0.0,
            "firstChapter": first_chapter.get(char),
        })
    character_count = sum(1 for item in characters if item["count"] > 0)
    last_chapter = max((row["no"] for row in chapter_rows), default=0)
    max_count = max((item["count"] for item in characters), default=0)
    max_points = max((item["points"] for item in characters), default=0.0)
    max_weighted = max((item["weighted"] for item in characters), default=0.0)

    # 密度：份额 / 活跃跨度 × (活跃跨度 / 区间总跨度)^0.5。
    # 跨度按“话”计算：first = 首次出场话，last = 最新发布话；
    # 份额 = points / 0.8（公开数据里的 points 已整体除以 10）。
    chapter_panels = {row["no"]: row["panelCount"] for row in chapter_rows}

    def panels_from(first_no: int) -> int:
        return sum(panel_count for no, panel_count in chapter_panels.items() if no >= first_no)

    densities: Dict[int, float] = {}
    for char in range(CHAR_MIN, CHAR_MAX + 1):
        total = totals.get(char)
        first = first_chapter.get(char)
        if not total or total["count"] <= 0 or first is None or total_panels <= 0:
            densities[char] = 0.0
            continue
        active = panels_from(first)
        if active <= 0:
            densities[char] = 0.0
            continue
        share = total["points"] / 0.8
        densities[char] = round(share / active * (active / total_panels) ** 0.5 * 100, 2)
    for item in characters:
        item["density"] = densities[item["char"]]
    max_density = max(densities.values(), default=0.0)

    stats = {
        "schema": SCHEMA_NAME,
        "schemaVersion": EXPORT_VERSION,
        "formatVersion": SITE_FORMAT_VERSION,
        "revision": revision,
        "exportedAt": exported_at,
        "totalChapters": len(chapter_rows),
        "totalPanels": total_panels,
        "totalAppearances": total_appearances,
        "characterCount": character_count,
        "lastChapter": last_chapter,
        "maxCount": max_count,
        "maxPoints": max_points,
        "maxWeighted": max_weighted,
        "maxDensity": max_density,
        "characters": characters,
    }
    chapter_index = {
        "schema": SCHEMA_NAME,
        "schemaVersion": EXPORT_VERSION,
        "formatVersion": SITE_FORMAT_VERSION,
        "revision": revision,
        "exportedAt": exported_at,
        "chapters": chapter_rows,
    }
    manifest = {
        "schema": SCHEMA_NAME,
        "schemaVersion": EXPORT_VERSION,
        "formatVersion": SITE_FORMAT_VERSION,
        "revision": revision,
        "exportedAt": exported_at,
        "title": str(meta.get("title") or "超超你的字典"),
        "author": str(meta.get("author") or ""),
        "counts": {
            "chapters": len(chapter_rows),
            "panels": total_panels,
            "appearances": total_appearances,
            "characters": character_count,
            "charMin": CHAR_MIN,
            "charMax": CHAR_MAX,
        },
        "files": {
            "stats": "stats.json",
            "chapters": "chapters/index.json",
        },
    }

    payload = {
        "manifest.json": _json(manifest),
        "stats.json": _json(stats),
        "chapters/index.json": _json(chapter_index),
    }
    payload.update(chapter_files)
    return payload


def _write_text(target: Path, text: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    os.replace(temporary, target)


def write_payload(root: Path, payload: Dict[str, str]) -> List[str]:
    """把 payload 写入 docs/data；先清掉旧的分话文件，最后写 manifest。"""
    data_dir = root / DATA_DIR
    chapter_dir = data_dir / "chapters"
    if chapter_dir.exists():
        for stale in chapter_dir.rglob("*.json"):
            stale.unlink()
    chapter_dir.mkdir(parents=True, exist_ok=True)

    for relative, text in payload.items():
        if relative == "manifest.json":
            continue
        _write_text(data_dir / relative, text)
    _write_text(data_dir / "manifest.json", payload["manifest.json"])
    return sorted(payload)


def read_manifest(root: Path) -> Optional[Dict[str, Any]]:
    path = root / DATA_DIR / "manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def files_exist(root: Path) -> bool:
    return (
        (root / DATA_DIR / "stats.json").is_file()
        and (root / DATA_DIR / "chapters" / "index.json").is_file()
    )


# --------------------------------------------------------------------------- #
# Git
# --------------------------------------------------------------------------- #
def _short(text: str) -> str:
    text = (text or "").strip()
    return text[-MAX_OUTPUT:] if len(text) > MAX_OUTPUT else text


def _git(root: Path, args: List[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=str(root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=GIT_TIMEOUT,
        )
    except FileNotFoundError as exc:
        raise PublishError("找不到 git 命令，请先安装 Git") from exc
    except subprocess.TimeoutExpired as exc:
        raise PublishError("git 命令超时，请检查网络或仓库状态") from exc


def git_info(root: Path) -> Dict[str, Any]:
    if not shutil.which("git"):
        return {"available": False, "isRepo": False, "reason": "找不到 git 命令"}
    top = _git(root, ["rev-parse", "--show-toplevel"])
    if top.returncode != 0:
        return {"available": True, "isRepo": False, "reason": "当前目录不是 Git 仓库"}
    try:
        is_repo = Path(top.stdout.strip()).resolve() == root.resolve()
    except OSError:
        is_repo = False
    if not is_repo:
        return {"available": True, "isRepo": False,
                "reason": "项目目录不是独立的 Git 仓库根目录"}

    branch = _git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
    ahead = _git(root, ["rev-list", "--count", "@{u}..HEAD"])
    status = _git(root, ["status", "--porcelain", "--", "docs/data"])
    remotes = _git(root, ["remote"])
    return {
        "available": True,
        "isRepo": True,
        "root": str(root),
        "branch": branch.stdout.strip() if branch.returncode == 0 else "",
        "ahead": int(ahead.stdout.strip()) if ahead.returncode == 0 and ahead.stdout.strip().isdigit() else 0,
        "hasUpstream": ahead.returncode == 0,
        "dirty": bool(status.stdout.strip()) if status.returncode == 0 else False,
        "remotes": [line for line in remotes.stdout.splitlines() if line.strip()],
    }


def _push(root: Path) -> Dict[str, Any]:
    result = _git(root, ["push"])
    if result.returncode == 0:
        return {"ok": True, "output": _short(result.stdout + result.stderr)}
    error = result.stderr or result.stdout or "git push 失败"
    if "has no upstream branch" in error or "no upstream" in error:
        result = _git(root, ["push", "-u", "origin", "HEAD"])
        if result.returncode == 0:
            return {"ok": True, "output": _short(result.stdout + result.stderr)}
        error = result.stderr or result.stdout or error
    return {"ok": False, "error": _short(error)}


def _ahead(root: Path) -> int:
    result = _git(root, ["rev-list", "--count", "@{u}..HEAD"])
    if result.returncode == 0 and result.stdout.strip().isdigit():
        return int(result.stdout.strip())
    return 0


def _push_if_ahead(root: Path, push: bool) -> Optional[Dict[str, Any]]:
    if not push:
        return None
    info = git_info(root)
    if not info.get("isRepo"):
        return None
    if info.get("hasUpstream"):
        if _ahead(root) <= 0:
            return None
    elif not info.get("remotes"):
        return None
    elif _git(root, ["rev-parse", "--verify", "HEAD"]).returncode != 0:
        return None
    pushed = _push(root)
    if pushed["ok"]:
        return {"ok": True, "changed": False, "pushed": True}
    return {"ok": False, "changed": False, "pushed": False,
            "error": pushed["error"]}


# --------------------------------------------------------------------------- #
# 发布
# --------------------------------------------------------------------------- #
def publish_status(root: Path) -> Dict[str, Any]:
    root = Path(root).resolve()
    manifest = read_manifest(root)
    info = git_info(root)
    if not manifest:
        return {"ok": True, "published": False, "git": info}
    return {
        "ok": True,
        "published": True,
        "revision": manifest.get("revision"),
        "exportedAt": manifest.get("exportedAt"),
        "counts": manifest.get("counts") or {},
        "git": info,
    }


def publish_site(database: GirlsDB, root: Path, message: str = "",
                 export_only: bool = False, push: bool = True,
                 force: bool = False) -> Dict[str, Any]:
    """导出分片 JSON；export_only=False 时还会 commit + push。

    返回给前端 / CLI 的字典始终带 ``ok``，失败时带 ``error``。
    ``force=True`` 允许用空数据库覆盖已有的公开数据。
    """
    root = Path(root).resolve()
    if not PUBLISH_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "正在发布，请稍候再试"}
    try:
        return _publish(database, root, message=message, export_only=export_only,
                        push=push, force=force)
    except PublishError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # pragma: no cover - 兜底
        return {"ok": False, "error": f"发布失败：{exc}"}
    finally:
        PUBLISH_LOCK.release()


def _publish(database: GirlsDB, root: Path, message: str,
             export_only: bool, push: bool, force: bool) -> Dict[str, Any]:
    info = git_info(root) if not export_only else None
    if not export_only and info and not info.get("isRepo"):
        return {
            "ok": False,
            "error": (info.get("reason") or "当前目录不是 Git 仓库") +
                     "。请先在项目根目录执行 git init，并配置 origin。",
            "git": info,
        }

    revision = int(database.revision())
    manifest = read_manifest(root)
    if (manifest and manifest.get("schemaVersion") == EXPORT_VERSION
            and manifest.get("formatVersion") == SITE_FORMAT_VERSION
            and manifest.get("revision") == revision and files_exist(root)
            and not (info and info.get("dirty")) and not force):
        if export_only:
            return {"ok": True, "changed": False, "revision": revision,
                    "exportedAt": manifest.get("exportedAt"),
                    "counts": manifest.get("counts") or {}}
        if push:
            ahead_result = _push_if_ahead(root, push)
            if ahead_result is not None:
                ahead_result["revision"] = revision
                ahead_result["counts"] = manifest.get("counts") or {}
                if ahead_result.get("ok"):
                    ahead_result["commit"] = _git(root, ["rev-parse", "--short", "HEAD"]).stdout.strip()
                return ahead_result
        return {"ok": True, "changed": False, "revision": revision,
                "exportedAt": manifest.get("exportedAt"),
                "counts": manifest.get("counts") or {},
                "git": info}

    document = database.load_document()
    revision = int(document.get("revision") or revision)
    # 只有含角色数据的章节会发布；占位话/空分镜不计入防覆盖判断。
    published_panels = sum(
        len(chapter.get("panels") or [])
        for chapter in document.get("chapters") or []
        if any(panel.get("chars") for panel in chapter.get("panels") or [])
    )
    existing_counts = (manifest or {}).get("counts") or {}
    if published_panels == 0 and int(existing_counts.get("panels") or 0) > 0 and not force:
        return {
            "ok": False,
            "error": "当前数据库没有可发布的角色数据（只有占位话/空分镜），但公开数据里已经有 " +
                     str(existing_counts.get("panels")) +
                     " 个分镜。为防止误覆盖，已拒绝发布；确实要清空请用命令行 --force。",
            "revision": revision,
            "counts": existing_counts,
        }
    exported = strip_ids(document)
    payload = build_payload(exported, revision)
    written = write_payload(root, payload)
    manifest_payload = json.loads(payload["manifest.json"])
    counts = manifest_payload["counts"]

    if export_only:
        return {
            "ok": True,
            "changed": True,
            "revision": revision,
            "exportedAt": exported.get("exportedAt"),
            "files": len(written),
            "counts": counts,
        }

    add = _git(root, ["add", "--", "docs/data"])
    if add.returncode != 0:
        return {"ok": False, "changed": True, "revision": revision,
                "error": _short(add.stderr or add.stdout or "git add 失败")}

    diff = _git(root, ["diff", "--cached", "--quiet", "--", "docs/data"])
    if diff.returncode == 0:
        ahead_result = _push_if_ahead(root, push)
        if ahead_result is not None:
            ahead_result["revision"] = revision
            if ahead_result.get("ok"):
                ahead_result["commit"] = _git(root, ["rev-parse", "--short", "HEAD"]).stdout.strip()
            return ahead_result
        return {"ok": True, "changed": False, "revision": revision,
                "exportedAt": exported.get("exportedAt"),
                "counts": counts,
                "git": git_info(root)}
    if diff.returncode != 1:
        return {"ok": False, "changed": True, "revision": revision,
                "error": _short(diff.stderr or diff.stdout or "git diff 失败")}

    commit_message = (message or DEFAULT_MESSAGE)
    commit_message = (commit_message
                      .replace("{revision}", str(revision))
                      .replace("{chapters}", str(counts["chapters"]))
                      .replace("{panels}", str(counts["panels"])))
    commit = _git(root, ["commit", "--only", "-m", commit_message, "--", "docs/data"])
    if commit.returncode != 0:
        return {
            "ok": False,
            "changed": True,
            "revision": revision,
            "error": _short(commit.stderr or commit.stdout or "git commit 失败") +
                     "\n提示：如果提示作者身份未知，请先配置 git config user.name / user.email。",
        }
    commit_hash = _git(root, ["rev-parse", "--short", "HEAD"]).stdout.strip()

    if push:
        pushed = _push(root)
        if not pushed["ok"]:
            return {
                "ok": False,
                "changed": True,
                "committed": True,
                "pushed": False,
                "revision": revision,
                "commit": commit_hash,
                "counts": counts,
                "error": pushed["error"] +
                         "\n提交已经保存在本地，修好网络或远端后再次点击发布即可补推。",
            }
        return {
            "ok": True,
            "changed": True,
            "committed": True,
            "pushed": True,
            "revision": revision,
            "commit": commit_hash,
            "exportedAt": exported.get("exportedAt"),
            "counts": counts,
            "git": git_info(root),
        }

    return {
        "ok": True,
        "changed": True,
        "committed": True,
        "pushed": False,
        "revision": revision,
        "commit": commit_hash,
        "exportedAt": exported.get("exportedAt"),
        "counts": counts,
        "git": git_info(root),
    }
