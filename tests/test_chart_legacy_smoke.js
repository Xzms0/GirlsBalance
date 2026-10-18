'use strict';
/**
 * 旧版 stats/index（没有 count / points / weighted / formatVersion）的兼容测试。
 * 发布时如果本机服务还在跑旧代码，页面至少应该继续显示计数，并提示重新发布。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'manifest.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'stats.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'chapters', 'index.json'), 'utf8'));
const colors = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'colors.json'), 'utf8'));

const legacyStats = {
  schema: stats.schema,
  schemaVersion: stats.schemaVersion,
  revision: stats.revision,
  exportedAt: stats.exportedAt,
  totalChapters: stats.totalChapters,
  totalPanels: stats.totalPanels,
  totalAppearances: stats.totalAppearances,
  maxPanels: stats.maxCount,
  characters: stats.characters.map((item) => ({
    char: item.char,
    name: item.name,
    panels: item.count,
    share: stats.totalPanels ? item.count / stats.totalPanels : 0,
  })),
};
const legacyIndex = {
  schema: index.schema,
  schemaVersion: index.schemaVersion,
  revision: index.revision,
  exportedAt: index.exportedAt,
  chapters: index.chapters.map((chapter) => ({
    no: chapter.no,
    title: chapter.title,
    note: chapter.note,
    panelCount: chapter.panelCount,
    appearances: chapter.appearances,
    characters: chapter.characters,
    file: chapter.file,
  })),
};

function element(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    listeners: {},
    options: id === 'metric'
      ? [{ value: 'count', disabled: false }, { value: 'points', disabled: false }, { value: 'weighted', disabled: false }]
      : undefined,
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      contains(value) { return this.values.has(value); },
    },
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(handler);
    },
    fire(type) {
      (this.listeners[type] || []).forEach((handler) => handler({}));
    },
  };
}

const elements = {};
['meta-chars', 'meta-chapter', 'meta-updated', 'revision', 'metric', 'sort', 'order',
  'start-char', 'chart', 'empty', 'format-warning'].forEach((id) => {
  elements[id] = element(id);
});
elements.metric.value = 'count';
elements.sort.value = 'char';
elements.order.value = 'asc';
elements['start-char'].value = 'all';
elements.empty.classList.add('hidden');
elements['format-warning'].classList.add('hidden');

const documentStub = {
  readyState: 'complete',
  hidden: false,
  listeners: {},
  getElementById(id) { return elements[id] || null; },
  addEventListener() {},
};

function fetchStub(url) {
  const clean = String(url).split('?')[0];
  let data = null;
  if (clean.endsWith('manifest.json')) data = manifest;
  else if (clean.endsWith('stats.json')) data = legacyStats;
  else if (clean.endsWith('chapters/index.json')) data = legacyIndex;
  else if (clean.endsWith('colors.json')) data = colors;
  if (!data) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

const sandbox = {
  window: { setInterval() { return 0; } },
  document: documentStub,
  console,
  Date, Number, String, Array, Object, Math, JSON, Set, RegExp,
  isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent,
  fetch: fetchStub,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs', 'js', 'chart.js'), 'utf8'), sandbox, {
  filename: 'docs/js/chart.js',
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await wait(80);
  const expected = legacyStats.characters.filter((item) => item.panels > 0).length;
  assert.ok(expected > 0, '测试数据应有角色');
  assert.strictEqual((elements.chart.innerHTML.match(/class="row"/g) || []).length, expected,
    '旧格式也应该显示所有有记录角色');
  assert.ok(elements.chart.innerHTML.includes('class="char">' + legacyStats.characters[0].char + '<'),
    '旧格式计数不应变成 0');
  assert.ok(elements['meta-chars'].textContent.includes('第 ' + expected + ' 个角色'),
    '旧格式也应推导角色数');
  assert.ok(!elements['format-warning'].classList.contains('hidden'), '旧格式应显示提示');
  assert.ok(elements['format-warning'].textContent.includes('旧版格式'), '提示应说明旧版格式');
  assert.ok(elements['start-char'].disabled, '旧格式没有章节聚合时应禁用起始角色');
  assert.ok(elements.metric.options.filter((option) => option.value !== 'count').every((option) => option.disabled),
    '旧格式应禁用积分 / 加权选项');
  console.log('旧版数据兼容测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
