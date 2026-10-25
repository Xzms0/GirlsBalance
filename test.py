#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统计 girls_dict JSON 中角色的相对戏份。

参数直接写在下方 CONFIG 中，改完直接运行：
    python girls_stats.py

后续数据增加时，只需把新的 girls_dict.json 放到 INPUT 指向的位置。
"""

import csv
import json
import math
from collections import defaultdict
from pathlib import Path

# ============================================================
# 配置区：改这里
# ============================================================
CONFIG = {
    # 输入 JSON（相对脚本所在目录，或绝对路径）
    "input": "girls_dict.json",

    # 输出 CSV；设为 None 则不输出
    "output_csv": "girls_stats_result.csv",

    # 要排除的角色编号，默认排除 0 恋太郎
    "exclude": [],

    # 活跃段切分间隔（panel 数）；相邻出现间隔 > gap 就切段
    "gap": 10000,

    # 活跃时长惩罚指数 alpha
    # 0 = 不惩罚；0.5 = 平方根；1 = 线性
    "alpha": 0.5,

    # 只打印前 N 名；0 表示全部
    "top_n": 0,
}
# ============================================================

BASE_DIR = Path(__file__).resolve().parent


def resolve_path(value):
    p = Path(value)
    if p.is_absolute():
        return p
    return (BASE_DIR / p).resolve()


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def flatten_panels(data: dict):
    """
    把 chapters[].panels[] 展平成连续 panel 列表。
    返回：
        panels: list[list[int]]  # 每个 panel 的角色编号列表（已去重排序）
        panel_meta: list[dict]   # 每个 panel 的章节/分镜信息
    """
    panels = []
    panel_meta = []
    for ch in data.get("chapters", []):
        ch_no = ch.get("no")
        ch_title = ch.get("title", "")
        for p_idx, panel in enumerate(ch.get("panels", [])):
            chars = sorted(set(panel.get("chars", [])))
            panels.append(chars)
            panel_meta.append({
                "chapter_no": ch_no,
                "chapter_title": ch_title,
                "panel_in_chapter": p_idx + 1,
                "global_panel_index": len(panels),  # 1-based
            })
    return panels, panel_meta


def compute_active_segments(positions, gap: int):
    """
    根据角色出现的 panel 序号列表，按间隔 > gap 切分活跃段。
    返回 list[(start, end)]，闭区间。
    """
    if not positions:
        return []
    segments = []
    start = prev = positions[0]
    for p in positions[1:]:
        if p - prev > gap:
            segments.append((start, prev))
            start = p
        prev = p
    segments.append((start, prev))
    return segments


def compute_stats(data: dict, exclude: set[int], gap: int, alpha: float):
    panels, panel_meta = flatten_panels(data)
    total_panels = len(panels)

    # 角色 -> 出现过的 panel 序号（1-based）
    char_positions = defaultdict(list)
    # 角色 -> 共现份额（排除 exclude 后重新归一化）
    char_share = defaultdict(float)

    for idx, chars in enumerate(panels, start=1):
        effective = [c for c in chars if c not in exclude]
        if not effective:
            continue
        share = 1.0 / len(effective)
        for c in effective:
            char_positions[c].append(idx)
            char_share[c] += share

    char_names = data.get("meta", {}).get("charNames", {})
    name_map = {}
    for k, v in char_names.items():
        try:
            name_map[int(k)] = v
        except (TypeError, ValueError):
            pass

    rows = []
    for c in sorted(char_positions):
        positions = char_positions[c]
        segments = compute_active_segments(positions, gap)
        active_panels = sum(end - start + 1 for start, end in segments)
        if active_panels == 0:
            continue

        appear_count = len(positions)
        active_rate = appear_count / active_panels
        share_density = char_share[c] / active_panels

        penalty = (active_panels / total_panels) ** alpha if total_panels else 0.0
        composite_rate = active_rate * penalty
        composite_share = share_density * penalty

        rows.append({
            "char_id": c,
            "char_name": name_map.get(c, f"角色{c}"),
            "first_panel": positions[0],
            "last_panel": positions[-1],
            "appear_count": appear_count,
            "active_segments": segments,
            "active_segment_count": len(segments),
            "active_panels": active_panels,
            "active_rate": active_rate,
            "share_density": share_density,
            "penalty": penalty,
            "composite_rate": composite_rate,
            "composite_share": composite_share,
        })

    # 主排名：份额密度综合分
    rows_sorted = sorted(rows, key=lambda r: r["composite_share"], reverse=True)
    for rank, r in enumerate(rows_sorted, start=1):
        r["rank_by_composite_share"] = rank

    # 次排名：出场率综合分
    rows_by_rate = sorted(rows, key=lambda r: r["composite_rate"], reverse=True)
    rate_rank = {r["char_id"]: i for i, r in enumerate(rows_by_rate, start=1)}
    for r in rows_sorted:
        r["rank_by_composite_rate"] = rate_rank[r["char_id"]]

    return {
        "total_panels": total_panels,
        "total_chapters": len(data.get("chapters", [])),
        "gap": gap,
        "alpha": alpha,
        "exclude": sorted(exclude),
        "rows": rows_sorted,
        "panel_meta": panel_meta,
    }


def format_segments(segments):
    return "; ".join(f"{a}-{b}" for a, b in segments)


def print_report(result, top_n: int = 0):
    print("=" * 110)
    print(f"总 panel 数: {result['total_panels']}")
    print(f"总话数: {result['total_chapters']}")
    print(f"排除角色: {result['exclude']}")
    print(f"活跃段切分间隔: {result['gap']} panels")
    print(f"惩罚指数 alpha: {result['alpha']}")
    print("=" * 110)

    header = (
        f"{'排名':>4} {'编号':>4} {'角色':<12} "
        f"{'首panel':>8} {'末panel':>8} {'出场数':>6} "
        f"{'活跃panel':>9} {'出场率':>7} {'份额密度':>8} "
        f"{'惩罚':>7} {'份额综合':>8} {'出场率综合':>9} {'出场率排名':>8}"
    )
    print(header)
    print("-" * len(header))

    rows = result["rows"]
    if top_n and top_n > 0:
        rows = rows[:top_n]

    for r in rows:
        print(
            f"{r['rank_by_composite_share']:>4} "
            f"{r['char_id']:>4} "
            f"{r['char_name']:<12} "
            f"{r['first_panel']:>8} "
            f"{r['last_panel']:>8} "
            f"{r['appear_count']:>6} "
            f"{r['active_panels']:>9} "
            f"{r['active_rate']*100:>6.2f}% "
            f"{r['share_density']*100:>7.2f}% "
            f"{r['penalty']:>7.3f} "
            f"{r['composite_share']*100:>7.2f}% "
            f"{r['composite_rate']*100:>8.2f}% "
            f"{r['rank_by_composite_rate']:>8}"
        )

    print("\n活跃段详情：")
    for r in result["rows"]:
        print(
            f"  {r['char_id']:>2} {r['char_name']:<12} "
            f"活跃段数={r['active_segment_count']} "
            f"段={format_segments(r['active_segments'])}"
        )


def write_csv(result, path: Path):
    fieldnames = [
        "char_id",
        "char_name",
        "rank_by_composite_share",
        "active_rate",          # 出场密度
        "composite_rate",       # 惩罚后的出场密度
        "share_density",        # 份额密度
        "composite_share",      # 惩罚后的份额密度
    ]

    def pct(x):
        return f"{x * 100:.2f}%"

    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in result["rows"]:
            writer.writerow({
                "char_id": r["char_id"],
                "char_name": r["char_name"],
                "rank_by_composite_share": r["rank_by_composite_share"],
                "active_rate": pct(r["active_rate"]),
                "composite_rate": pct(r["composite_rate"]),
                "share_density": pct(r["share_density"]),
                "composite_share": pct(r["composite_share"]),
            })
    print(f"\nCSV 已写入: {path}")

def main():
    input_path = resolve_path(CONFIG["input"])
    if not input_path.exists():
        raise FileNotFoundError(f"找不到输入文件: {input_path}")

    data = load_json(input_path)
    exclude = {int(x) for x in CONFIG.get("exclude", [0])}
    gap = int(CONFIG.get("gap", 80))
    alpha = float(CONFIG.get("alpha", 0.6))
    top_n = int(CONFIG.get("top_n", 0))

    result = compute_stats(data, exclude=exclude, gap=gap, alpha=alpha)
    print_report(result, top_n=top_n)

    out_csv = CONFIG.get("output_csv")
    if out_csv:
        write_csv(result, resolve_path(out_csv))


if __name__ == "__main__":
    main()