'use strict';
/** 与 server/json_pretty.py 相同的紧凑 JSON 格式。 */

const MAX_INLINE = 200;

function compact(value) {
  return JSON.stringify(value);
}

function format(value, level) {
  const indent = '  '.repeat(level);
  const child = '  '.repeat(level + 1);

  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((item) => item === null || typeof item !== 'object')) {
      return `[${value.map(compact).join(', ')}]`;
    }
    const inline = compact(value);
    if (inline && inline.length <= MAX_INLINE) return inline;
    return `[\n${value.map((item) => child + format(item, level + 1)).join(',\n')}\n${indent}]`;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const inline = compact(value);
    if (inline && inline.length <= MAX_INLINE) return inline;
    const items = keys.map((key) => `${child}${JSON.stringify(key)}: ${format(value[key], level + 1)}`);
    return `{\n${items.join(',\n')}\n${indent}}`;
  }

  return JSON.stringify(value);
}

function stringify(value) {
  return `${format(value, 0)}\n`;
}

module.exports = { stringify, format };
