# -*- coding: utf-8 -*-
"""紧凑但保留层级的 JSON 格式化。

数组里的数字/字符串保持一行；小的分镜对象也保持一行。
这样 2500 个分镜不会变成 7500 行，但顶层结构仍然可读。
"""
from __future__ import annotations

import json
from typing import Any

MAX_INLINE = 200


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def _format(value: Any, level: int) -> str:
    indent = "  " * level
    child = "  " * (level + 1)

    if isinstance(value, dict):
        if not value:
            return "{}"
        inline = _compact(value)
        if len(inline) <= MAX_INLINE:
            return inline
        items = []
        for key, item in value.items():
            items.append(f"{child}{json.dumps(str(key), ensure_ascii=False)}: {_format(item, level + 1)}")
        return "{\n" + ",\n".join(items) + "\n" + indent + "}"

    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        if all(not isinstance(item, (dict, list, tuple)) for item in value):
            return "[" + ", ".join(_compact(item) for item in value) + "]"
        inline = _compact(value)
        if len(inline) <= MAX_INLINE:
            return inline
        items = [child + _format(item, level + 1) for item in value]
        return "[\n" + ",\n".join(items) + "\n" + indent + "]"

    return _compact(value)


def dumps(value: Any) -> str:
    return _format(value, 0) + "\n"
