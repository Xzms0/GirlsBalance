#!/usr/bin/env node
/**
 * 前端数据模型（public/js/model.js）单元测试。
 *
 * 覆盖：编号清洗、输入解析、文档规范化、派生统计、导出格式、
 * 增量补丁生成（保存时只发变化的部分）。
 *
 * 运行：node tests/test_model.js      （或 npm test）
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* --- 在沙箱里加载浏览器端的 model.js --------------------------------- */
const sandbox = {
  window: { crypto: crypto.webcrypto },
  console,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'model.js'), 'utf8'), sandbox, {
  filename: 'public/js/model.js',
});
const model = sandbox.window.GD.model;

/* --- 极简测试框架 ----------------------------------------------------- */
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

function messyDb() {
  return {
    schema: 'girls_dict',
    schemaVersion: 2,
    revision: 7,
    meta: { title: '测试', charNames: { '3': '三号', 'abc': '非法', '200': '越界' } },
    chapters: [
      { no: 9, title: '乱序', panels: [{ chars: [5, 3, 3, '2'] }, { chars: [] }, 'garbage'] },
      { id: 'dup', no: 1, panels: [{ id: 'p1', chars: [101, -1, 0, 100] }] },
      { id: 'dup', panels: 'not-an-array' },
      'not-a-chapter',
    ],
  };
}

/**
 * 浏览器里的对象来自另一个 realm（vm 沙箱），原型不同，
 * 所以这里用 JSON 序列化来比内容，顺便把随机 id 归一化（id 本身不参与比较）。
 */
function same(actual, expected, message) {
  const replacer = (key, value) => (key === 'id' ? 'ID' : value);
  const left = JSON.stringify(actual, replacer);
  const right = JSON.stringify(expected, replacer);
  assert.strictEqual(left, right, message || '内容不一致');
}

function sameRaw(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message || '内容不一致');
}

console.log('girls_dict 数据模型一致性测试\n');

console.log('常量');
test('编号范围固定为 [0,100]', () => {
  assert.strictEqual(model.CHAR_MIN, 0);
  assert.strictEqual(model.CHAR_MAX, 100);
});
test('schema 标识稳定', () => {
  assert.strictEqual(model.SCHEMA_NAME, 'girls_dict');
  assert.strictEqual(model.SCHEMA_VERSION, 2);
});

console.log('\n编号清洗');
[
  [[5, 1, '3', 1], [1, 3, 5]],
  [[0, 100], [0, 100]],
  [[-1, 101, 50], [50]],
  [[null, 'abc', true, {}, 4], [4]],
  [[], []],
].forEach(([input, expected]) => {
  test(`cleanChars(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, () => {
    sameRaw(model.cleanChars(input).chars, expected);
  });
});

console.log('\n输入解析（网页输入框）');
test('空格/逗号/顿号分隔', () => {
  sameRaw(model.parseInput('1 5,23、7；9').chars, [1, 5, 7, 9, 23]);
});
test('越界与乱码会被挑出来', () => {
  const parsed = model.parseInput('1 abc 101 -5 20');
  sameRaw(parsed.chars, [1, 20]);
  sameRaw(parsed.bad, ['abc', '101', '-5']);
});

console.log('\n规范化与校验');
test('normalizeDb 修正编号、去重、补 id', () => {
  const normalized = model.normalizeDb(messyDb()).db;
  sameRaw(normalized.chapters.map((c) => c.no), [1, 2, 3]);
  sameRaw(normalized.chapters[0].panels[0].chars, [2, 3, 5]);
  sameRaw(normalized.meta.charNames, { '3': '三号' });
  assert.ok(normalized.chapters[0].id.startsWith('ch-'));
});
test('校验只报告不修改', () => {
  const issues = model.validateDb(messyDb());
  assert.ok(issues.some((i) => i.level === 'error'));
  assert.ok(issues.some((i) => i.level === 'warn'));
  sameRaw(model.validateDb(model.defaultDb()), []);
  assert.throws(() => model.normalizeDb({ chapters: [] }), /schemaVersion=2/);
  assert.throws(() => model.normalizeDb({ schema: 'girls_dict', schemaVersion: 1, chapters: [] }), /schemaVersion=2/);
});
test('脏数据的问题清单稳定', () => {
  const issues = model.validateDb(messyDb());
  const paths = [...new Set(issues.map((i) => i.level + ':' + i.path))].sort();
  sameRaw(paths, [
    'error:chapters[0].panels[2]',
    'error:chapters[1].panels[0].chars',
    'error:chapters[2].panels',
    'error:chapters[3]',
    'warn:chapters[0].id',
    'warn:chapters[0].no',
    'warn:chapters[0].panels[0].id',
    'warn:chapters[0].panels[1].id',
    'warn:chapters[1].no',
    'warn:chapters[2].id',
    'warn:meta.charNames',
  ].sort());
});

console.log('\n派生数据');
const fixture = model.normalizeDb(require(path.join(ROOT, 'data', 'sample.girls_dict.json'))).db;
test('统计正确', () => {
  const stats = model.computeStats(fixture);
  sameRaw([stats.chapters, stats.panels, stats.distinct_chars, stats.appearances], [3, 10, 6, 23]);
  sameRaw(stats.characters[0], { char: 1, name: '超超', panels: 6 });
});
test('拉平成行', () => {
  const rows = model.flatRows(fixture);
  assert.strictEqual(rows.length, 23);
  sameRaw(rows[0], { chapter_no: 1, chapter_title: '相遇', panel_index: 1, char: 1, char_name: '超超' });
});
test('CSV 是 0/1 矩阵', () => {
  const csv = model.toCsv(fixture);
  const rows = csv.split('\r\n').filter(Boolean);
  assert.strictEqual(rows.length, 11);
  const header = rows[0].split(',');
  assert.strictEqual(header[0], '话-分镜');
  assert.strictEqual(header.length, 102);
  assert.strictEqual(header[1], '0');
  assert.strictEqual(header[101], '100');
  const first = rows[1].split(',');
  assert.strictEqual(first[0], '1-1');
  assert.strictEqual(first[1 + 1], '1');
  assert.strictEqual(first[1 + 5], '1');
  assert.strictEqual(first[1 + 2], '0');
  assert.ok(!csv.includes('相遇'));
});
test('JSON 导出为紧凑格式', () => {
  const text = model.prettyJson(model.toExportDocument(fixture));
  assert.ok(text.includes('"chars": [1, 5]') || text.includes('{"chars":[1,5]}'));
  assert.ok(!/"chars": \[\r?\n/.test(text));
  assert.strictEqual(JSON.parse(text).chapters.length, 3);
});

console.log('\n顺序操作');
test('交换两话后编号连续', () => {
  const copy = model.clone(fixture);
  const firstId = copy.chapters[0].id;
  model.swapChapters(copy, 0, 2);
  assert.strictEqual(copy.chapters[2].id, firstId);
  sameRaw(copy.chapters.map((c) => c.no), [1, 2, 3]);
});
test('移动一话后编号连续', () => {
  const copy = model.clone(fixture);
  model.moveChapter(copy, 0, 2);
  sameRaw(copy.chapters.map((c) => c.no), [1, 2, 3]);
  assert.strictEqual(copy.chapters[2].no, 3);
});
test('定位角色', () => {
  const hits = model.locateChar(fixture, 100);
  assert.strictEqual(hits.length, 2);
  sameRaw(hits.map((h) => `${h.chapterNo}-${h.panelIndex}`), ['3-2', '3-3']);
});

console.log('\nJSON 导出格式');
test('不含任何内部 id', () => {
  const exported = model.toExportDocument(fixture);
  const text = JSON.stringify(exported);
  assert.ok(!text.includes('"id"'), '不应出现 id 字段');
  assert.ok(!text.includes('ch-') && !text.includes('pn-'), '不应出现内部 id 值');
  sameRaw(Object.keys(exported.chapters[0]), ['no', 'title', 'note', 'panels']);
  assert.strictEqual(exported.chapters[0].panels[0].chars.join(','), '1,5');
  assert.ok(exported.exportedAt);
});
test('导出再导入内容不丢', () => {
  const exported = model.toExportDocument(fixture);
  const restored = model.parseExport(JSON.stringify(exported));
  same(model.toExportDocument(restored).chapters, exported.chapters);
  assert.ok(restored.chapters[0].id.startsWith('ch-'), '导入时应重新生成 id');
});

test('内部运行期规范化保留合法 id', () => {
  const again = model.normalizeDb(model.clone(fixture)).db;
  sameRaw(again.chapters, fixture.chapters);
});

test('外部无 id 文档通过严格校验并生成内部 id', () => {
  const exported = model.toExportDocument(fixture);
  exported.revision = 7;
  exported.exportedAt = null;
  assert.strictEqual(model.validateExportDocument(exported), exported);
  const restored = model.parseExport(JSON.stringify(exported));
  assert.strictEqual(restored.revision, 7);
  assert.ok(restored.chapters[0].id);
  assert.ok(restored.chapters[0].panels[0].id);
});

const invalidExports = [
  ['缺版本', (d) => { delete d.schemaVersion; }],
  ['旧版本', (d) => { d.schemaVersion = 1; }],
  ['字符串版本', (d) => { d.schemaVersion = '2'; }],
  ['错误 schema', (d) => { d.schema = 'other'; }],
  ['未知顶层字段', (d) => { d.extra = true; }],
  ['内部 updatedAt', (d) => { d.updatedAt = null; }],
  ['错误时间类型', (d) => { d.exportedAt = 1; }],
  ['负 revision', (d) => { d.revision = -1; }],
  ['小数 revision', (d) => { d.revision = 0.5; }],
  ['超出安全整数 revision', (d) => { d.revision = 9007199254740992; }],
  ['缺 meta 字段', (d) => { delete d.meta.author; }],
  ['未知 meta 字段', (d) => { d.meta.extra = ''; }],
  ['错误标题类型', (d) => { d.meta.title = 0; }],
  ['错误范围', (d) => { d.meta.charMax = 99; }],
  ['数组名称', (d) => { d.meta.charNames = []; }],
  ['非规范编号键', (d) => { d.meta.charNames['01'] = 'x'; }],
  ['编号键带后缀', (d) => { d.meta.charNames['1x'] = 'x'; }],
  ['越界编号键', (d) => { d.meta.charNames['101'] = 'x'; }],
  ['非字符串名称', (d) => { d.meta.charNames['1'] = null; }],
  ['非数组 chapters', (d) => { d.chapters = {}; }],
  ['章节 id', (d) => { d.chapters[0].id = 'old'; }],
  ['分镜 id', (d) => { d.chapters[0].panels[0].id = 'old'; }],
  ['缺章节 note', (d) => { delete d.chapters[0].note; }],
  ['错误章节号', (d) => { d.chapters[0].no = 2; }],
  ['错误章节标题', (d) => { d.chapters[0].title = null; }],
  ['非数组 panels', (d) => { d.chapters[0].panels = {}; }],
  ['分镜未知字段', (d) => { d.chapters[0].panels[0].extra = 0; }],
  ['缺 chars', (d) => { delete d.chapters[0].panels[0].chars; }],
  ['裸数组分镜', (d) => { d.chapters[0].panels[0] = [1]; }],
  ...[[2, 1], [1, 1], ['1'], [true], [-1], [101], [0.5]].map((chars) =>
    ['非法 chars ' + JSON.stringify(chars), (d) => { d.chapters[0].panels[0].chars = chars; }]),
];
invalidExports.forEach(([label, mutate]) => test('严格导入拒绝：' + label, () => {
  const payload = JSON.parse(JSON.stringify(model.toExportDocument(fixture)));
  mutate(payload);
  assert.throws(() => model.validateExportDocument(payload));
  assert.throws(() => model.parseExport(JSON.stringify(payload)));
}));
test('空文件与空白文件拒绝导入', () => {
  assert.throws(() => model.parseExport(''));
  assert.throws(() => model.parseExport('  '));
});

console.log('\n增量补丁（保存时只发变化的部分）');
test('没有改动时补丁为空', () => {
  const saved = model.fingerprints(fixture);
  const patch = model.buildPatch(fixture, saved);
  assert.strictEqual(patch.empty, true, '不该产生任何操作');
  sameRaw(patch.ops, []);
});
test('改一个槽位只产生一条 panel.chars', () => {
  const saved = model.fingerprints(fixture);
  const copy = model.clone(fixture);
  copy.chapters[1].panels[0].chars = [9, 1];
  const patch = model.buildPatch(copy, saved);
  sameRaw(patch.ops, [{ op: 'panel.chars', panelId: copy.chapters[1].panels[0].id,
    chapterId: copy.chapters[1].id, chars: [9, 1] }]);
});
test('改标题只产生一条 chapter.update', () => {
  const saved = model.fingerprints(fixture);
  const copy = model.clone(fixture);
  copy.chapters[0].title = '新标题';
  const patch = model.buildPatch(copy, saved);
  sameRaw(patch.ops, [{ op: 'chapter.update', id: copy.chapters[0].id, title: '新标题', note: '' }]);
});
test('新增一话 = upsert + order', () => {
  const saved = model.fingerprints(fixture);
  const copy = model.clone(fixture);
  const created = model.newChapter(4, '番外');
  created.panels = [model.newPanel([7])];
  copy.chapters.push(created);
  const patch = model.buildPatch(copy, saved);
  sameRaw(patch.ops.map((op) => op.op), ['chapter.upsert', 'chapter.order']);
  sameRaw(patch.ops[0].panels, [{ id: created.panels[0].id, chars: [7] }]);
});
test('删除一话 = chapter.delete + order', () => {
  const saved = model.fingerprints(fixture);
  const copy = model.clone(fixture);
  const removedId = copy.chapters[1].id;
  copy.chapters.splice(1, 1);
  const patch = model.buildPatch(copy, saved);
  const kinds = patch.ops.map((op) => op.op);
  assert.ok(kinds.includes('chapter.delete'), '应有 chapter.delete');
  assert.ok(kinds.includes('chapter.order'), '应有 chapter.order');
  assert.ok(!kinds.includes('panel.delete'), '整话删除时不必再逐个删槽位');
  sameRaw(patch.ops[0], { op: 'chapter.delete', id: removedId });
});
test('删一个槽位 = panel.delete（带 chapterId）', () => {
  const saved = model.fingerprints(fixture);
  const copy = model.clone(fixture);
  const chapter = copy.chapters[0];
  const removed = chapter.panels.pop();
  const patch = model.buildPatch(copy, saved);
  sameRaw(patch.ops, [{ op: 'panel.delete', id: removed.id, chapterId: chapter.id }]);
});
test('新增槽位 = panel.upsert（带位置）', () => {
  const saved = model.fingerprints(fixture);
  const copy = model.clone(fixture);
  const chapter = copy.chapters[0];
  chapter.panels.splice(1, 0, model.newPanel([4, 2]));
  const patch = model.buildPatch(copy, saved);
  sameRaw(patch.ops, [{ op: 'panel.upsert', chapterId: chapter.id,
    panel: { id: chapter.panels[1].id, chars: [2, 4] }, position: 2 }]);
});
test('调顺序只产生 chapter.order', () => {
  const saved = model.fingerprints(fixture);
  const copy = model.clone(fixture);
  model.moveChapter(copy, 0, 2);
  const patch = model.buildPatch(copy, saved);
  sameRaw(patch.ops, [{ op: 'chapter.order', ids: copy.chapters.map((c) => c.id) }]);
});
test('改角色名与元信息', () => {
  const saved = model.fingerprints(fixture);
  const copy = model.clone(fixture);
  copy.meta.charNames['9'] = '新角色';
  copy.meta.title = '新作品名';
  const patch = model.buildPatch(copy, saved);
  sameRaw(patch.ops.map((op) => op.op), ['charName.setMany', 'meta.update']);
});
test('没有基线时退回整库 replace（并保留 id，便于后续增量）', () => {
  const patch = model.buildPatch(fixture, null);
  assert.strictEqual(patch.ops.length, 1);
  assert.strictEqual(patch.ops[0].op, 'replace');
  assert.strictEqual(patch.ops[0].db.chapters[0].id, fixture.chapters[0].id, 'replace 应带上原 id');
  assert.strictEqual(patch.ops[0].db.chapters[0].panels[0].id, fixture.chapters[0].panels[0].id);
  // 换成导出给别的程序时，才需要去掉 id
  assert.ok(!JSON.stringify(model.toExportDocument(fixture)).includes('"id"'));
});
test('保存成功能推进指纹（第二次补丁为空）', () => {
  const copy = model.clone(fixture);
  const first = model.buildPatch(copy, model.fingerprints(fixture));
  copy.chapters[0].panels[0].chars = [0];
  const second = model.buildPatch(copy, first.saved);
  assert.strictEqual(second.ops.length, 1);
  const third = model.buildPatch(copy, second.saved);
  assert.strictEqual(third.empty, true, '指纹推进后不该重复发送');
});

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  failures.forEach((f) => console.error(`- ${f.name}: ${f.error.stack || f.error.message}`));
  process.exitCode = 1;
}
