#!/usr/bin/env node
/**
 * girls_dict 数据层（SQLite · Node 版）测试。
 *
 * 与 tests/test_girls_db.py 覆盖同一批行为，保证「Python 服务端 / Node 服务端 / 浏览器」
 * 三方看到的是同一套语义。临时库一律建在 <项目>/.tmp-tests/<随机>/ 下，跑完删掉。
 *
 * 运行：node tests/test_db.js      （或 npm test:db）
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'server', 'db.js'));

const WORK = path.join(ROOT, '.tmp-test-run', crypto.randomBytes(6).toString('hex'));
fs.mkdirSync(WORK, { recursive: true });

/* --------------------------------------------------------------------------- *
 * 极简测试框架
 * --------------------------------------------------------------------------- */
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

/** 每个用例一套独立的库文件。 */
function freshDatabase(name, options) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  const database = new db.GirlsDB(
    path.join(dir, 'girls.sqlite3'),
    Object.assign({ backupInterval: 0, legacyJson: null }, options || {})
  );
  database.initialize();
  return database;
}

function readSample() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sample.girls_dict.json'), 'utf8'));
}

/** 侧门：直接查底层的 panel.position，验证「顺序连续」这件事真的落到了表里。 */
function rawPositions(database, chapterId) {
  return database.withConnection((conn) => conn
    .prepare('SELECT position FROM panel WHERE chapter_id = ? ORDER BY position')
    .all(chapterId).map((row) => row.position));
}

function titles(document) {
  return document.chapters.map((chapter) => chapter.title);
}

console.log('girls_dict 数据层测试（Node · SQLite）\n');

/* --------------------------------------------------------------------------- *
 * 建表与基础信息
 * --------------------------------------------------------------------------- */
console.log('建表与基础信息');

test('常量与 Python 版一致', () => {
  assert.strictEqual(db.SCHEMA_NAME, 'girls_dict');
  assert.strictEqual(db.STORAGE_VERSION, 2);
  assert.strictEqual(db.EXPORT_VERSION, 1);
  assert.strictEqual(db.CHAR_MIN, 0);
  assert.strictEqual(db.CHAR_MAX, 100);
  assert.strictEqual(db.DEFAULT_BACKUP_KEEP, 20);
  assert.strictEqual(db.LOG_KEEP, 2000);
});

test('OP_DOCS 覆盖全部 op，且与 OP_HANDLERS 一一对应', () => {
  const documented = db.OP_DOCS.map((item) => item.op).sort();
  assert.deepStrictEqual(documented, Object.keys(db.OP_HANDLERS).sort());
  assert.ok(documented.includes('chapter.upsert') && documented.includes('panel.chars'));
  assert.ok(db.OP_DOCS.every((item) => item.args && item.desc));
});

test('SCHEMA_SQL 的表/列/索引名与 schema/girls_dict.sql 一致', () => {
  const ddl = fs.readFileSync(path.join(ROOT, 'schema', 'girls_dict.sql'), 'utf8');
  ['info', 'chapter', 'panel', 'panel_char', 'char_name', 'change_log',
    'idx_panel_chapter', 'idx_panel_char_char'].forEach((name) => {
    assert.ok(db.SCHEMA_SQL.includes(name), `SCHEMA_SQL 缺少 ${name}`);
    assert.ok(ddl.includes(name), `girls_dict.sql 缺少 ${name}`);
  });
});

test('initialize() 首次创建：fresh=true、无迁移', () => {
  const database = freshDatabase('init');
  assert.strictEqual(database.initialize().fresh, false, '第二次 initialize 不应再算 fresh');
  assert.strictEqual(database.exists(), true);
  assert.ok(database.path.endsWith('.sqlite3'));
  assert.strictEqual(database.backupDir, path.join(path.dirname(database.path), 'backups'));
});

test('info 基础行与存储版本', () => {
  const database = freshDatabase('info');
  database.withConnection((conn) => {
    assert.strictEqual(database.info(conn, 'schema_version'), '2');
    assert.strictEqual(database.info(conn, 'title'), '超超你的字典');
    assert.strictEqual(database.info(conn, 'author'), '');
    assert.strictEqual(database.info(conn, 'revision'), '0');
    assert.strictEqual(database.info(conn, 'updated_at'), '');
  });
  assert.strictEqual(database.revision(), 0);
});

test('PRAGMA：WAL + foreign_keys + busy_timeout', () => {
  const database = freshDatabase('pragma');
  database.withConnection((conn) => {
    assert.strictEqual(conn.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.strictEqual(conn.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.strictEqual(conn.prepare('PRAGMA busy_timeout').get().timeout, 15000);
  });
  assert.ok(database.dbSize() > 0);
});

test('外键级联：删掉一话，槽位与编号一起没', () => {
  const database = freshDatabase('cascade');
  database.replaceAll(readSample());
  const chapterId = database.loadDocument().chapters[0].id;
  const before = database.withConnection((conn) => conn
    .prepare('SELECT COUNT(*) AS c FROM panel WHERE chapter_id = ?').get(chapterId).c);
  assert.strictEqual(before, 4);
  database.withConnection((conn) => conn.prepare('DELETE FROM chapter WHERE id = ?').run(chapterId));
  const after = database.withConnection((conn) => conn
    .prepare('SELECT COUNT(*) AS c FROM panel WHERE chapter_id = ?').get(chapterId).c);
  assert.strictEqual(after, 0, 'ON DELETE CASCADE 没生效');
});

/* --------------------------------------------------------------------------- *
 * 话 / 槽位 / 编号 生命周期
 * --------------------------------------------------------------------------- */
console.log('\n话 / 槽位 / 编号');

test('chapter.upsert 新增一话（连槽位一起）', () => {
  const database = freshDatabase('upsert');
  const result = database.applyPatch([{
    op: 'chapter.upsert',
    chapter: { title: '第一话', note: '备注' },
    panels: [{ chars: [3, 1] }, { chars: [] }],
  }]);
  assert.deepStrictEqual(result.applied, ['chapter.upsert']);
  assert.strictEqual(result.revision, 1);
  const document = database.loadDocument();
  assert.strictEqual(document.chapters.length, 1);
  assert.strictEqual(document.chapters[0].no, 1);
  assert.strictEqual(document.chapters[0].title, '第一话');
  assert.strictEqual(document.chapters[0].note, '备注');
  assert.strictEqual(document.chapters[0].panels.length, 2);
  assert.deepStrictEqual(document.chapters[0].panels[0].chars, [1, 3]);
  assert.ok(document.chapters[0].id.startsWith('ch-'));
});

test('chapter.upsert 覆盖已有话（旧槽位被换掉、编号不变）', () => {
  const database = freshDatabase('upsert-overwrite');
  database.replaceAll(readSample());
  const target = database.loadDocument().chapters[1];
  database.applyPatch([{
    op: 'chapter.upsert',
    chapter: { id: target.id, title: '改写', note: '' },
    panels: [{ chars: [9] }],
  }]);
  const after = database.loadDocument();
  assert.strictEqual(after.chapters.length, 3);
  assert.strictEqual(after.chapters[1].id, target.id, 'id 不应变');
  assert.strictEqual(after.chapters[1].no, 2, '位置不应变');
  assert.strictEqual(after.chapters[1].title, '改写');
  assert.strictEqual(after.chapters[1].panels.length, 1);
  assert.deepStrictEqual(after.chapters[1].panels[0].chars, [9]);
});

test('chapter.upsert 的 position 决定插入位置', () => {
  const database = freshDatabase('upsert-position');
  database.replaceAll(readSample());
  database.applyPatch([{
    op: 'chapter.upsert', position: 2,
    chapter: { title: '插到第二' }, panels: [],
  }]);
  assert.deepStrictEqual(titles(database.loadDocument()), ['相遇', '插到第二', '放学后', '雨天']);
  assert.deepStrictEqual(database.loadDocument().chapters.map((c) => c.no), [1, 2, 3, 4]);
});

test('chapter.update 改标题/备注；找不到的话报错', () => {
  const database = freshDatabase('update');
  database.replaceAll(readSample());
  const chapter = database.loadDocument().chapters[0];
  database.applyPatch([{ op: 'chapter.update', id: chapter.id, title: '新标题', note: '新备注' }]);
  const after = database.loadChapter(chapter.id);
  assert.strictEqual(after.title, '新标题');
  assert.strictEqual(after.note, '新备注');
  assert.throws(() => database.applyPatch([{ op: 'chapter.update', id: 'ch-nope', title: 'x' }]),
    (error) => error instanceof db.OpError && error.message.includes('找不到这一话'));
});

test('panel.chars 覆盖编号：去重 + 升序', () => {
  const database = freshDatabase('chars');
  database.replaceAll(readSample());
  const panel = database.loadDocument().chapters[0].panels[0];
  database.applyPatch([{ op: 'panel.chars', panelId: panel.id, chars: [7, 3, 7, '5', 3] }]);
  const after = database.loadDocument().chapters[0].panels[0];
  assert.deepStrictEqual(after.chars, [3, 5, 7]);
  assert.strictEqual(after.id, panel.id, '槽位身份不变');
});

test('越界/非法编号被丢弃并记进 issues（lastIssues 同样留痕）', () => {
  const database = freshDatabase('chars-bad');
  database.replaceAll(readSample());
  const panel = database.loadDocument().chapters[0].panels[0];
  const result = database.applyPatch([{
    op: 'panel.chars', panelId: panel.id, chars: [101, -1, 999, 'abc', null, true, 42],
  }]);
  assert.deepStrictEqual(database.loadDocument().chapters[0].panels[0].chars, [42]);
  assert.strictEqual(result.issues.length, 6);
  assert.ok(result.issues.every((item) => item.level === 'error' && item.path === 'panel.chars'));
  assert.ok(result.issues.some((item) => item.message.includes('角色编号超出 [0,100]：101')));
  assert.ok(result.issues.some((item) => item.message.includes("无法识别的角色编号：'abc'")));
  assert.ok(result.issues.some((item) => item.message.includes('无法识别的角色编号：None')));
  assert.deepStrictEqual(database.lastIssues, result.issues, 'lastIssues 应保留同一批问题');
});

test('panel.upsert 插到中间后 position 仍连续', () => {
  const database = freshDatabase('panel-upsert');
  database.replaceAll(readSample());
  const chapter = database.loadDocument().chapters[0];
  const created = database.applyPatch([{
    op: 'panel.upsert', chapterId: chapter.id, position: 2, panel: { chars: [8] },
  }]);
  assert.deepStrictEqual(created.applied, ['panel.upsert']);
  const after = database.loadChapter(chapter.id);
  assert.strictEqual(after.panels.length, 5);
  assert.deepStrictEqual(after.panels[1].chars, [8], '新槽位插到了第 2 位');
  assert.deepStrictEqual(rawPositions(database, chapter.id), [1, 2, 3, 4, 5]);
});

test('panel.upsert 不带 id 时服务端自己生成，且不撞已有 id', () => {
  const database = freshDatabase('panel-newid');
  database.replaceAll(readSample());
  const chapter = database.loadDocument().chapters[0];
  database.applyPatch([{ op: 'panel.upsert', chapterId: chapter.id, panel: { chars: [1] } }]);
  const panels = database.loadChapter(chapter.id).panels;
  assert.strictEqual(new Set(panels.map((panel) => panel.id)).size, panels.length);
  assert.ok(panels[panels.length - 1].id.startsWith('pn-'));
});

test('panel.delete 之后 position 连续', () => {
  const database = freshDatabase('panel-delete');
  database.replaceAll(readSample());
  const chapter = database.loadDocument().chapters[0];
  const removed = chapter.panels[1].id;
  database.applyPatch([{ op: 'panel.delete', id: removed }]);
  const after = database.loadChapter(chapter.id);
  assert.strictEqual(after.panels.length, 3);
  assert.ok(!after.panels.some((panel) => panel.id === removed));
  assert.deepStrictEqual(rawPositions(database, chapter.id), [1, 2, 3]);
  assert.deepStrictEqual(after.panels.map((panel) => panel.chars), [[1, 5], [2], [1, 2, 5, 23]]);
});

test('chapter.order 按给定顺序重排并修正编号', () => {
  const database = freshDatabase('order');
  database.replaceAll(readSample());
  const ids = database.loadDocument().chapters.map((chapter) => chapter.id);
  database.applyPatch([{ op: 'chapter.order', ids: [ids[2], ids[0], ids[1]] }]);
  const after = database.loadDocument();
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.id), [ids[2], ids[0], ids[1]]);
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.no), [1, 2, 3]);
  assert.deepStrictEqual(titles(after), ['雨天', '相遇', '放学后']);
});

test('chapter.order 漏掉的话按原顺序补在后面', () => {
  const database = freshDatabase('order-partial');
  database.replaceAll(readSample());
  const ids = database.loadDocument().chapters.map((chapter) => chapter.id);
  database.applyPatch([{ op: 'chapter.order', ids: [ids[1]] }]);
  const after = database.loadDocument();
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.id), [ids[1], ids[0], ids[2]]);
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.no), [1, 2, 3]);
});

test('chapter.order 参数不合法时报错', () => {
  const database = freshDatabase('order-bad');
  database.replaceAll(readSample());
  assert.throws(() => database.applyPatch([{ op: 'chapter.order', ids: 'ch-1' }]),
    (error) => error instanceof db.OpError && error.message.includes('ids 必须是字符串数组'));
});

test('chapter.move 移动到位并重排编号', () => {
  const database = freshDatabase('move');
  database.replaceAll(readSample());
  const ids = database.loadDocument().chapters.map((chapter) => chapter.id);
  database.applyPatch([{ op: 'chapter.move', id: ids[0], to: 3 }]);
  let after = database.loadDocument();
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.id), [ids[1], ids[2], ids[0]]);
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.no), [1, 2, 3]);

  database.applyPatch([{ op: 'chapter.move', id: ids[0], to: 1 }]);
  after = database.loadDocument();
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.id), [ids[0], ids[1], ids[2]]);

  database.applyPatch([{ op: 'chapter.move', id: ids[0], to: 99 }]);
  after = database.loadDocument();
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.no), [1, 2, 3]);
  assert.strictEqual(after.chapters[2].id, ids[0], '越界的 to 应当夹到末尾');

  assert.throws(() => database.applyPatch([{ op: 'chapter.move', id: 'ch-nope', to: 1 }]),
    (error) => error instanceof db.OpError && error.message.includes('找不到这一话'));
});

test('chapter.swap 对换两话并修正编号', () => {
  const database = freshDatabase('swap');
  database.replaceAll(readSample());
  const ids = database.loadDocument().chapters.map((chapter) => chapter.id);
  database.applyPatch([{ op: 'chapter.swap', a: ids[0], b: ids[2] }]);
  const after = database.loadDocument();
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.id), [ids[2], ids[1], ids[0]]);
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.no), [1, 2, 3]);
  assert.throws(() => database.applyPatch([{ op: 'chapter.swap', a: ids[0], b: 'ch-nope' }]),
    (error) => error instanceof db.OpError && error.message.includes('a / b 必须是已存在的话 id'));
});

test('chapter.delete 后编号自动补位', () => {
  const database = freshDatabase('chapter-delete');
  database.replaceAll(readSample());
  const ids = database.loadDocument().chapters.map((chapter) => chapter.id);
  database.applyPatch([{ op: 'chapter.delete', id: ids[1] }]);
  const after = database.loadDocument();
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.id), [ids[0], ids[2]]);
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.no), [1, 2]);
  const orphans = database.withConnection((conn) => conn
    .prepare('SELECT COUNT(*) AS c FROM panel WHERE chapter_id = ?').get(ids[1]).c);
  assert.strictEqual(orphans, 0);
});

test('meta.update 与 charName.setMany（整体替换、非法键丢弃）', () => {
  const database = freshDatabase('meta');
  database.replaceAll(readSample());
  const result = database.applyPatch([
    { op: 'meta.update', title: '改过的作品名', author: '录入者' },
    { op: 'charName.setMany', names: { 3: '三号', abc: '非法键', 200: '越界', 4: '', 5: '阿蓝' } },
  ]);
  assert.deepStrictEqual(result.applied, ['meta.update', 'charName.setMany']);
  const after = database.loadDocument();
  assert.strictEqual(after.meta.title, '改过的作品名');
  assert.strictEqual(after.meta.author, '录入者');
  assert.deepStrictEqual(database.charNames(), { 3: '三号', 5: '阿蓝' }, 'setMany 是整体替换');
  assert.ok(result.issues.some((item) => item.level === 'warn' && item.message.includes("忽略非法编号键：'abc'")));
  assert.ok(result.issues.some((item) => item.level === 'warn' && item.message.includes('忽略越界编号：200')));
});

test('clear 清空数据但保留 schema 与 info', () => {
  const database = freshDatabase('clear');
  database.replaceAll(readSample());
  const result = database.clear();
  assert.strictEqual(result.applied[0], 'clear');
  const after = database.loadDocument();
  assert.deepStrictEqual(after.chapters, []);
  assert.deepStrictEqual(after.meta.charNames, {});
  assert.strictEqual(database.stats().appearances, 0);
  assert.strictEqual(database.withConnection((conn) => database.info(conn, 'schema_version')), '2');
  assert.deepStrictEqual(database.integrityCheck(), []);
});

/* --------------------------------------------------------------------------- *
 * 事务 / revision / 日志
 * --------------------------------------------------------------------------- */
console.log('\n事务与 revision');

test('补丁默认不回传整库，includeDocument 时才带；整库替换则带', () => {
  const database = freshDatabase('patch-shape');
  database.replaceAll(readSample());
  const panel = database.loadDocument().chapters[0].panels[0];
  const light = database.applyPatch([{ op: 'panel.chars', panelId: panel.id, chars: [1] }]);
  assert.deepStrictEqual(Object.keys(light).sort(), ['applied', 'issues', 'revision']);
  assert.strictEqual(light.db, undefined, '补丁是增量的，返回体不应带整库');
  const heavy = database.applyPatch([{ op: 'panel.chars', panelId: panel.id, chars: [2] }],
    { includeDocument: true });
  assert.deepStrictEqual(Object.keys(heavy).sort(), ['applied', 'db', 'issues', 'revision']);
  assert.strictEqual(heavy.db.chapters.length, 3);
  // 整库替换本来就带着整份文档来，回一份方便前端换掉镜像
  database.clear();
  const replaced = database.replaceAll(readSample());
  assert.strictEqual(replaced.db.chapters.length, 3);
  assert.strictEqual(replaced.revision > 0, true);
});

test('每次成功写入 revision +1，失败不消耗 revision', () => {
  const database = freshDatabase('revision');
  database.replaceAll(readSample());
  assert.strictEqual(database.revision(), 1);
  const panel = database.loadDocument().chapters[0].panels[0];
  database.applyPatch([{ op: 'panel.chars', panelId: panel.id, chars: [1] }]);
  assert.strictEqual(database.revision(), 2);
  assert.throws(() => database.applyPatch([{ op: 'panel.chars', panelId: 'pn-nope', chars: [1] }]),
    (error) => error instanceof db.OpError);
  assert.strictEqual(database.revision(), 2, '失败的补丁不应消耗 revision');
});

test('revision 冲突：抛 RevisionConflict 并带回库里最新文档', () => {
  const database = freshDatabase('conflict');
  database.replaceAll(readSample());
  const stale = database.revision();
  const panel = database.loadDocument().chapters[0].panels[0];
  database.applyPatch([{ op: 'panel.chars', panelId: panel.id, chars: [9] }], { expectedRevision: stale });

  let conflict = null;
  try {
    database.applyPatch([{ op: 'clear' }], { expectedRevision: stale });
  } catch (error) {
    conflict = error;
  }
  assert.ok(conflict instanceof db.RevisionConflict, '应当抛 RevisionConflict');
  assert.strictEqual(conflict.currentRevision, stale + 1);
  assert.ok(conflict.currentDocument && conflict.currentDocument.chapters.length === 3, '冲突要带回最新文档');
  assert.strictEqual(database.revision(), stale + 1, '冲突不消耗 revision');
  assert.deepStrictEqual(database.loadDocument().chapters[0].panels[0].chars, [9]);

  const forced = database.applyPatch([{ op: 'clear' }], { expectedRevision: stale, force: true });
  assert.strictEqual(forced.revision, stale + 2);
  assert.strictEqual(database.loadDocument().chapters.length, 0);
});

test('未知 op / 缺 op 字段：报错、整体回滚、revision 不变', () => {
  const database = freshDatabase('rollback');
  database.replaceAll(readSample());
  const before = database.revision();
  const chapter = database.loadDocument().chapters[0];

  assert.throws(() => database.applyPatch([{ op: 'panel.explode' }]),
    (error) => error instanceof db.OpError && error.index === 0
      && error.message.includes("不认识的操作 'panel.explode'"));
  assert.throws(() => database.applyPatch([{ nope: 1 }]),
    (error) => error instanceof db.OpError && error.message.includes('缺少 op 字段'));

  // 第 1 步合法、第 2 步非法 —— 第 1 步必须一起回滚
  let error = null;
  try {
    database.applyPatch([
      { op: 'chapter.update', id: chapter.id, title: '不该生效' },
      { op: 'panel.chars', panelId: 'pn-nope', chars: [1] },
    ], { expectedRevision: before });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof db.OpError, '应当抛 OpError');
  // 与 Python 一致：处理函数内部的错误索引是 0（消息里才带真实位置）
  assert.strictEqual(error.index, 0);
  assert.ok(error.message.includes('找不到这个槽位：pn-nope'));
  assert.strictEqual(database.revision(), before);
  assert.strictEqual(database.loadChapter(chapter.id).title, '相遇', '同批的前一个操作也必须回滚');
});

test('ops 必须是数组且非空', () => {
  const database = freshDatabase('ops-empty');
  assert.throws(() => database.applyPatch([]),
    (error) => error instanceof db.OpError && error.message.includes('ops 必须是非空数组'));
  assert.throws(() => database.applyPatch(null),
    (error) => error instanceof db.OpError);
});

test('change_log 记录每次写入，recentLog 倒序可限量', () => {
  const database = freshDatabase('log');
  database.replaceAll(readSample());
  const panel = database.loadDocument().chapters[0].panels[0];
  database.applyPatch([{ op: 'panel.chars', panelId: panel.id, chars: [1] }], { label: 'ui' });
  database.clear();
  const log = database.recentLog(10);
  assert.strictEqual(log.length, 3);
  assert.strictEqual(log[0].action, 'clear');
  assert.strictEqual(log[0].revision, 3);
  assert.strictEqual(log[1].action, 'ui');
  assert.strictEqual(log[1].detail, 'panel.chars');
  assert.strictEqual(log[2].action, 'replace');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(log[0].at), `时间格式不对：${log[0].at}`);
  assert.strictEqual(database.recentLog(1).length, 1);
  assert.strictEqual(database.recentLog(0).length, 1, 'limit 至少为 1');
  assert.strictEqual(database.recentLog(999).length, 3, 'limit 上限内取全部');
  assert.ok(Object.getPrototypeOf(log[0]) === Object.prototype, '返回的应是普通对象（对齐 Python 的 dict）');
});

/* --------------------------------------------------------------------------- *
 * 查询
 * --------------------------------------------------------------------------- */
console.log('\n查询');

test('loadIndex 给出每话计数与总计，且不含槽位内容', () => {
  const database = freshDatabase('index');
  database.replaceAll(readSample());
  const index = database.loadIndex();
  assert.strictEqual(index.revision, 1);
  assert.ok(typeof index.updatedAt === 'string' && index.updatedAt.length > 0);
  assert.deepStrictEqual(index.stats, { chapters: 3, panels: 10, distinct_chars: 6, appearances: 23 });
  const first = index.chapters[0];
  assert.deepStrictEqual(Object.keys(first).sort(),
    ['appearances', 'chars', 'id', 'no', 'note', 'panels', 'title', 'updated_at']);
  assert.strictEqual(first.no, 1);
  assert.strictEqual(first.title, '相遇');
  assert.strictEqual(first.panels, 4);
  assert.strictEqual(first.appearances, 10);
  assert.strictEqual(first.chars, 4);
  assert.strictEqual(JSON.stringify(index).includes('pn-'), false, '目录不该带槽位 id');
});

test('loadChapter 读一话（含槽位顺序与编号）；不存在返回 null', () => {
  const database = freshDatabase('load-chapter');
  database.replaceAll(readSample());
  const chapter = database.loadDocument().chapters[1];
  const loaded = database.loadChapter(chapter.id);
  assert.strictEqual(loaded.no, 2);
  assert.strictEqual(loaded.title, '放学后');
  assert.strictEqual(loaded.note, '这一话开始出现会长');
  assert.deepStrictEqual(loaded.panels.map((panel) => panel.chars), [[1, 12], [12, 23], [1, 2, 12, 23]]);
  assert.strictEqual(database.loadChapter('ch-nope'), null);
});

test('stats 按分镜计出场次数并带角色名', () => {
  const database = freshDatabase('stats');
  database.replaceAll(readSample());
  const stats = database.stats();
  assert.strictEqual(stats.chapters, 3);
  assert.strictEqual(stats.panels, 10);
  assert.strictEqual(stats.distinct_chars, 6);
  assert.strictEqual(stats.appearances, 23);
  assert.deepStrictEqual(stats.characters[0], { char: 1, name: '超超', panels: 6 });
  assert.deepStrictEqual(stats.characters[5], { char: 100, name: '彩蛋角色', panels: 2 });
});

test('findChar 定位角色出现在哪些话/槽位', () => {
  const database = freshDatabase('find');
  database.replaceAll(readSample());
  const hits = database.findChar(100);
  assert.strictEqual(hits.length, 2);
  assert.deepStrictEqual(hits.map((hit) => [hit.chapterNo, hit.panelIndex]), [[3, 2], [3, 3]]);
  assert.ok(hits[0].chapterId.startsWith('ch-') && hits[0].panelId.startsWith('pn-'));
  assert.strictEqual(hits[0].chapterTitle, '雨天');
  assert.deepStrictEqual(database.findChar(77), []);
});

test('search 按标题/备注/角色名搜索，空串返回空', () => {
  const database = freshDatabase('search');
  database.replaceAll(readSample());
  const byTitle = database.search('放学');
  assert.deepStrictEqual(byTitle.chapters, [{ id: database.loadDocument().chapters[1].id, no: 2, title: '放学后' }]);
  assert.deepStrictEqual(database.search('会长').charNames, [{ char: 12, name: '会长' }]);
  assert.strictEqual(database.search('开始出现').chapters.length, 1, '备注也应参与搜索');
  assert.deepStrictEqual(database.search('   '), { chapters: [], charNames: [] });
  assert.deepStrictEqual(database.search('不存在的词'), { chapters: [], charNames: [] });
});

/* --------------------------------------------------------------------------- *
 * 导出 / 导入
 * --------------------------------------------------------------------------- */
console.log('\n导出与导入');

test('exportDocument/exportJson 不含任何 id，结构固定', () => {
  const database = freshDatabase('export');
  database.replaceAll(readSample());
  const exported = database.exportDocument();
  const text = JSON.stringify(exported);
  assert.ok(!text.includes('"id"'), '导出不应带 id');
  assert.ok(!text.includes('pn-') && !text.includes('ch-'), '导出不应出现内部 id');
  assert.deepStrictEqual(Object.keys(exported), ['schema', 'schemaVersion', 'exportedAt', 'meta', 'chapters']);
  assert.strictEqual(exported.schema, 'girls_dict');
  assert.strictEqual(exported.schemaVersion, 1);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(exported.exportedAt));
  assert.deepStrictEqual(Object.keys(exported.chapters[0]), ['no', 'title', 'note', 'panels']);
  assert.deepStrictEqual(Object.keys(exported.chapters[0].panels[0]), ['chars']);
  assert.deepStrictEqual(exported.chapters[0].panels[1], { chars: [1, 2, 5] });
  assert.strictEqual(exported.revision, undefined, '导出格式不含内部 revision');
  assert.ok(database.exportJson().endsWith('\n'));
  assert.strictEqual(JSON.parse(database.exportJson()).chapters.length, 3);
});

test('导出 → 导入（对象）往返后内容一致', () => {
  const database = freshDatabase('roundtrip');
  database.replaceAll(readSample());
  const before = database.loadDocument();
  const exported = database.exportDocument();

  const other = freshDatabase('roundtrip-target');
  const stats = other.importJson(exported);
  assert.strictEqual(stats.source, '(object)');
  assert.strictEqual(stats.chapters, 3);
  assert.strictEqual(stats.panels, 10);
  assert.strictEqual(stats.chars, 23);

  const after = other.loadDocument();
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.title), before.chapters.map((c) => c.title));
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.panels.map((p) => p.chars)),
    before.chapters.map((chapter) => chapter.panels.map((p) => p.chars)));
  assert.deepStrictEqual(after.chapters.map((chapter) => chapter.note), before.chapters.map((c) => c.note));
  assert.deepStrictEqual(after.meta.charNames, before.meta.charNames);
  assert.strictEqual(after.meta.title, before.meta.title);
  // 对象导入与文件导入写回的信息一致：title 和 author 都要落库
  assert.strictEqual(after.meta.author, before.meta.author);
  // 内部 id 是新生成的（导出格式里没有 id）
  assert.notStrictEqual(after.chapters[0].id, before.chapters[0].id);
  assert.strictEqual(JSON.stringify(exported).includes('"id"'), false);
});

test('importJson 也能吃 JSON 文本解析出来的对象，并重排编号', () => {
  const database = freshDatabase('import-object');
  const raw = {
    meta: { title: '手工数据', charNames: { 2: '小美', 999: '越界' } },
    chapters: [
      { no: 9, title: '甲', panels: [{ chars: [2, 2, 999] }, 'garbage'] },
      { title: '乙', panels: [] },
    ],
  };
  const stats = database.importJson(raw);
  assert.strictEqual(stats.chapters, 2);
  const document = database.loadDocument();
  assert.deepStrictEqual(document.chapters.map((chapter) => chapter.no), [1, 2]);
  assert.deepStrictEqual(document.chapters[0].panels.map((panel) => panel.chars), [[2]]);
  assert.deepStrictEqual(document.meta.charNames, { 2: '小美' });
  assert.strictEqual(document.meta.title, '手工数据');
});

test('exportCsv 是 0/1 矩阵：话-分镜 × 0..100', () => {
  const database = freshDatabase('csv');
  database.replaceAll(readSample());
  const csv = database.exportCsv();
  const rows = csv.split('\r\n').filter(Boolean);
  assert.strictEqual(rows.length, 11, '表头 + 10 个分镜');
  const header = rows[0].split(',');
  assert.strictEqual(header[0], '话-分镜');
  assert.strictEqual(header.length, 102);
  assert.deepStrictEqual(header.slice(1), Array.from({ length: 101 }, (unused, index) => String(index)));
  const first = rows[1].split(',');
  assert.strictEqual(first[0], '1-1');
  assert.strictEqual(first[1 + 1], '1');
  assert.strictEqual(first[1 + 5], '1');
  assert.strictEqual(first[1 + 2], '0');
  assert.ok(!csv.includes('相遇'), 'CSV 不包含标题信息');
});

test('exportJson 使用紧凑格式，数组不逐项换行', () => {
  const database = freshDatabase('json-pretty');
  database.replaceAll(readSample());
  const text = database.exportJson();
  assert.ok(text.includes('"chars": [1, 5]') || text.includes('{"chars":[1,5]}'));
  assert.ok(!/"chars": \[\r?\n/.test(text), 'chars 数组不应逐个换行');
  assert.strictEqual(JSON.parse(text).chapters.length, 3);
});

/* --------------------------------------------------------------------------- *
 * 快照 / 回滚 / 完整性
 * --------------------------------------------------------------------------- */
console.log('\n快照与完整性');

test('createBackup 用 VACUUM INTO 生成可读快照，listBackups 带名字/大小/时间', () => {
  const database = freshDatabase('backup');
  database.replaceAll(readSample());
  const target = database.createBackup('manual');
  assert.ok(fs.existsSync(target), '快照文件应存在');
  assert.ok(target.endsWith('-manual.sqlite3'));
  assert.ok(fs.readFileSync(target).subarray(0, 15).toString('utf8') === 'SQLite format 3');

  const listed = database.listBackups();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].name, path.basename(target));
  assert.ok(listed[0].size > 0);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(listed[0].mtime));

  const snapshot = new db.GirlsDB(target, { backupInterval: 0, legacyJson: null });
  assert.strictEqual(snapshot.loadDocument().chapters.length, 3, '快照本身是一份可用数据库');
});

test('备份数量按 backupKeep 裁剪（保留最新的）', () => {
  const database = freshDatabase('backup-prune', { backupKeep: 3 });
  database.replaceAll(readSample());
  for (let index = 0; index < 6; index += 1) database.createBackup(`t${index}`);
  const listed = database.listBackups();
  assert.strictEqual(listed.length, 3);
  assert.ok(listed.some((item) => item.name.includes('-t5')), '最新的一份应当留下');
});

test('restoreBackup 回滚内容，并先留一份 before-restore', () => {
  const database = freshDatabase('restore');
  database.replaceAll(readSample());
  const target = database.createBackup('keep');
  database.clear();
  assert.strictEqual(database.loadDocument().chapters.length, 0);

  const result = database.restoreBackup(path.basename(target));
  assert.strictEqual(result.restored, path.basename(target));
  assert.strictEqual(result.db.chapters.length, 3, '回滚结果要带整库');
  assert.deepStrictEqual(result.db.chapters.map((chapter) => chapter.title), ['相遇', '放学后', '雨天']);
  assert.strictEqual(database.loadDocument().chapters.length, 3);
  assert.ok(database.listBackups().some((item) => item.name.includes('before-restore')));
  assert.strictEqual(database.recentLog(1)[0].action, 'restore');
});

test('restoreBackup 拒绝不存在的快照与路径穿越', () => {
  const database = freshDatabase('restore-bad');
  database.replaceAll(readSample());
  assert.throws(() => database.restoreBackup('nope.sqlite3'),
    (error) => error.code === 'ENOENT' && error.message.includes('找不到快照'));
  assert.throws(() => database.restoreBackup('../../etc/passwd'),
    (error) => error.code === 'ENOENT');
});

test('integrityCheck 干净；导出导入往返后依然干净', () => {
  const database = freshDatabase('integrity');
  database.replaceAll(readSample());
  assert.deepStrictEqual(database.integrityCheck(), []);
  const panel = database.loadDocument().chapters[0].panels[0];
  database.applyPatch([{ op: 'panel.chars', panelId: panel.id, chars: [0, 100] }]);
  database.applyPatch([{ op: 'chapter.swap', a: database.loadDocument().chapters[0].id,
    b: database.loadDocument().chapters[1].id }]);
  assert.deepStrictEqual(database.integrityCheck(), []);
  assert.deepStrictEqual(db.defaultDocument().chapters, []);
});

/* --------------------------------------------------------------------------- *
 * 旧 JSON 迁移 / 导入归档
 * --------------------------------------------------------------------------- */
console.log('\n迁移与归档');

test('importJson 从文件导入并可归档源文件（字节一致）', () => {
  const dir = path.join(WORK, 'import-file');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'old-data.json');
  const payload = JSON.stringify(readSample(), null, 2);
  fs.writeFileSync(source, payload, 'utf8');
  const originalBytes = fs.readFileSync(source);

  const database = new db.GirlsDB(path.join(dir, 'girls.sqlite3'), { backupInterval: 0, legacyJson: null });
  database.initialize();
  const stats = database.importJson(source, { archive: true });
  assert.strictEqual(stats.source, source);
  assert.strictEqual(stats.chapters, 3);
  assert.strictEqual(stats.panels, 10);
  assert.ok(stats.archived && stats.archived.includes(`${path.sep}legacy${path.sep}`));
  assert.ok(stats.archived.endsWith('-migrated-') === false);
  assert.ok(/-migrated-\d{8}-\d{6}\.json$/.test(stats.archived), `归档名不对：${stats.archived}`);
  assert.strictEqual(fs.existsSync(source), false, '归档后原文件应被移走');
  assert.ok(fs.readFileSync(stats.archived).equals(originalBytes), '归档内容必须与原文件逐字节一致');
  assert.strictEqual(database.loadDocument().chapters.length, 3);
  // 文件导入同样会写回 author
  assert.strictEqual(database.loadDocument().meta.author, '示例数据');

  assert.throws(() => database.importJson(path.join(dir, 'missing.json')),
    (error) => error.code === 'ENOENT' && error.message.includes('找不到文件'));
});

test('自动迁移：首次建库时吃掉旁边的 girls_dict.json 并归档', () => {
  const dir = path.join(WORK, 'migrate');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dir, 'girls_dict.json');
  fs.writeFileSync(legacy, JSON.stringify(readSample(), null, 2), 'utf8');
  const originalBytes = fs.readFileSync(legacy);

  const database = new db.GirlsDB(path.join(dir, 'girls_dict.sqlite3'), { backupInterval: 0 });
  const info = database.initialize();
  assert.strictEqual(info.fresh, true);
  assert.strictEqual(info.migration.ok, true);
  assert.strictEqual(info.migration.chapters, 3);
  assert.strictEqual(info.migration.panels, 10);
  assert.strictEqual(info.migration.chars, 23);
  assert.strictEqual(database.loadDocument().chapters.length, 3);
  assert.strictEqual(database.loadDocument().meta.title, '超超你的字典 · 示例');
  assert.strictEqual(fs.existsSync(legacy), false, '旧 JSON 应被移走（不是删除）');
  assert.ok(fs.readFileSync(info.migration.archived).equals(originalBytes), '归档必须逐字节一致');

  // 第二次启动不该再迁移（文件已经不在了）
  const again = new db.GirlsDB(path.join(dir, 'girls_dict.sqlite3'), { backupInterval: 0 });
  assert.strictEqual(again.initialize().fresh, false);
  assert.strictEqual(again.migration, null);
});

test('迁移失败（坏 JSON）时源文件原封不动，库仍可用', () => {
  const dir = path.join(WORK, 'migrate-broken');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dir, 'girls_dict.json');
  fs.writeFileSync(legacy, '{ 这不是 JSON', 'utf8');
  const originalBytes = fs.readFileSync(legacy);

  const database = new db.GirlsDB(path.join(dir, 'girls_dict.sqlite3'), { backupInterval: 0 });
  const info = database.initialize();
  assert.strictEqual(info.migration.ok, false);
  assert.ok(info.migration.error.includes('不是合法 JSON'), info.migration.error);
  assert.strictEqual(info.migration.source, legacy);
  assert.ok(fs.existsSync(legacy), '迁移失败绝不能动源文件');
  assert.ok(fs.readFileSync(legacy).equals(originalBytes), '源文件必须逐字节原样');
  assert.strictEqual(fs.existsSync(path.join(dir, 'legacy')), false, '失败时不该产生归档');
  assert.deepStrictEqual(database.loadDocument().chapters, []);
  assert.deepStrictEqual(database.integrityCheck(), []);
  // 库本身还能正常用
  database.replaceAll(readSample());
  assert.strictEqual(database.loadDocument().chapters.length, 3);
});

test('空文件与不存在的旧 JSON 都不算迁移', () => {
  const dir = path.join(WORK, 'migrate-empty');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'girls_dict.json'), '   \n', 'utf8');
  const database = new db.GirlsDB(path.join(dir, 'girls_dict.sqlite3'), { backupInterval: 0 });
  const info = database.initialize();
  assert.strictEqual(info.migration.ok, true, '空文件按空库导入');
  assert.strictEqual(info.migration.chapters, 0);
  assert.deepStrictEqual(database.loadDocument().chapters, []);

  const none = path.join(WORK, 'migrate-none');
  fs.mkdirSync(none, { recursive: true });
  const empty = new db.GirlsDB(path.join(none, 'girls_dict.sqlite3'), { backupInterval: 0 });
  assert.strictEqual(empty.initialize().migration, null, '旁边没有旧 JSON 就不迁移');
});

/* --------------------------------------------------------------------------- *
 * 规范化工具
 * --------------------------------------------------------------------------- */
console.log('\n规范化工具');

test('cleanChars 去重升序、越界与乱码记录后丢弃', () => {
  assert.deepStrictEqual(db.cleanChars([5, 1, '3', 1]), [1, 3, 5]);
  assert.deepStrictEqual(db.cleanChars([0, 100]), [0, 100]);
  const issues = [];
  assert.deepStrictEqual(db.cleanChars([-1, 101, 50, 'abc', null, true], issues), [50]);
  assert.strictEqual(issues.length, 5);
  assert.ok(issues.every((item) => item.level === 'error'));
  assert.deepStrictEqual(db.cleanChars(null), []);
  assert.deepStrictEqual(db.cleanChars('7'), [7]);
});

test('normalizeDocument 修好乱七八糟的输入', () => {
  const issues = [];
  const document = db.normalizeDocument({
    meta: { title: '测试', charNames: { 3: '三号', abc: 'x', 200: 'y' } },
    chapters: [
      { no: 9, panels: [{ chars: [5, 3, 3, '2'] }, { chars: [] }, 'garbage'] },
      { id: 'dup', panels: [{ id: 'p1', chars: [101, -1, 0, 100] }] },
      { id: 'dup', panels: 'not-an-array' },
      'not-a-chapter',
    ],
  }, issues);
  assert.strictEqual(document.schema, db.SCHEMA_NAME);
  assert.strictEqual(document.schemaVersion, db.EXPORT_VERSION);
  assert.deepStrictEqual(document.chapters.map((chapter) => chapter.no), [1, 2, 3]);
  assert.deepStrictEqual(document.chapters[0].panels[0].chars, [2, 3, 5]);
  assert.deepStrictEqual(document.chapters[1].panels[0].chars, [0, 100]);
  assert.deepStrictEqual(document.meta.charNames, { 3: '三号' });
  assert.strictEqual(document.meta.title, '测试');
  assert.ok(issues.some((item) => item.level === 'error' && item.message.includes('话记录不是对象')));
  assert.ok(issues.some((item) => item.level === 'warn' && item.message.includes('忽略非法角色编号键')));
  // 重复 id 会被换掉，保证唯一
  const ids = [document.chapters[0].id, document.chapters[1].id, document.chapters[2].id];
  assert.strictEqual(new Set(ids).size, 3);
});

test('stripIds 只留导出字段', () => {
  const document = db.normalizeDocument(readSample());
  const stripped = db.stripIds(document);
  assert.strictEqual(JSON.stringify(stripped).includes('"id"'), false);
  assert.deepStrictEqual(Object.keys(stripped), ['schema', 'schemaVersion', 'exportedAt', 'meta', 'chapters']);
  assert.deepStrictEqual(stripped.chapters[1].panels[2], { chars: [1, 2, 12, 23] });
});

test('newId / nowIso / pyRepr / defaultDocument', () => {
  assert.ok(/^ch-[0-9a-f]{8}$/.test(db.newId('ch')));
  assert.ok(/^pn-[0-9a-f]{8}$/.test(db.newId('pn')));
  assert.strictEqual(new Set([db.newId('ch'), db.newId('ch')]).size, 2);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(db.nowIso()));
  assert.strictEqual(db.pyRepr('abc'), "'abc'");
  assert.strictEqual(db.pyRepr(null), 'None');
  assert.strictEqual(db.pyRepr(true), 'True');
  assert.strictEqual(db.pyRepr([1, 'a']), "[1, 'a']");
  assert.strictEqual(db.pyRepr({ a: 1, b: 'x' }), "{'a': 1, 'b': 'x'}");
  const empty = db.defaultDocument('标题');
  assert.deepStrictEqual(empty.chapters, []);
  assert.strictEqual(empty.meta.title, '标题');
  assert.strictEqual(empty.meta.charMin, 0);
  assert.strictEqual(empty.meta.charMax, 100);
  assert.strictEqual(empty.revision, 0);
});

/* --------------------------------------------------------------------------- *
 * HTTP 层：整库替换的意图防线（起一个临时服务，跑完就关）
 * --------------------------------------------------------------------------- */
const { createApp, listen } = require(path.join(ROOT, 'server', 'server.js'));

const OVERWRITE_REFUSED = '整库替换会覆盖现有数据：请带上 revision（并处理 409），或显式传 force: true';

async function httpPhase() {
  console.log('\nHTTP 层：整库替换的意图防线');
  const dir = path.join(WORK, 'http');
  fs.mkdirSync(dir, { recursive: true });
  const dataFile = path.join(dir, 'http.sqlite3');
  const database = new db.GirlsDB(dataFile, { backupInterval: 0, legacyJson: null });
  database.initialize();
  const options = {
    data: dataFile, public: path.join(ROOT, 'public'), allowOrigin: [],
    backupInterval: 0, legacyJson: null,
  };
  const { server } = createApp(options, database);
  const port = await listen(server, '127.0.0.1', 8917);
  const base = `http://127.0.0.1:${port}`;

  const call = async (method, url, payload) => {
    const response = await fetch(base + url, {
      method,
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      body = { raw: text };
    }
    return { status: response.status, body };
  };

  const sample = readSample();
  try {
    let result = await call('PUT', '/api/db', { revision: 0, db: sample });
    test('PUT 带 revision 整库写入，返回体带 db', () => {
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.revision, 1);
      assert.strictEqual(result.body.db.chapters.length, 3);
    });

    result = await call('PUT', '/api/db', { db: { chapters: [] } });
    test('非空库 + 无 revision/force：拒绝覆盖（400 + 精确文案）', () => {
      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.body.error, OVERWRITE_REFUSED);
      assert.strictEqual(database.loadDocument().chapters.length, 3, '拒绝时不能真的写进去');
    });

    result = await call('PUT', '/api/db', { revision: 0, db: sample });
    test('旧 revision：409 且带回最新整库', () => {
      assert.strictEqual(result.status, 409);
      assert.strictEqual(result.body.revision, 1);
      assert.strictEqual(result.body.db.chapters.length, 3);
    });

    result = await call('PUT', '/api/db', { revision: 1, db: sample });
    test('revision 匹配：正常写入', () => {
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.revision, 2);
    });

    result = await call('PUT', '/api/db', { db: sample, force: true });
    test('显式 force：不需要 revision', () => {
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.revision, 3);
    });

    result = await call('PUT', '/api/db', { db: null });
    test('db=null 被拒绝', () => {
      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.body.error, 'db 字段不能为 null');
    });

    const document = database.loadDocument();
    const panelId = document.chapters[0].panels[0].id;
    result = await call('POST', '/api/db/patch', {
      revision: document.revision,
      ops: [{ op: 'panel.chars', panelId, chars: [7, 3, 3] }],
    });
    test('POST /api/db/patch：增量写入且不回传整库', () => {
      assert.strictEqual(result.status, 200);
      assert.deepStrictEqual(result.body.applied, ['panel.chars']);
      assert.strictEqual(result.body.db, undefined);
      assert.deepStrictEqual(database.loadChapter(document.chapters[0].id).panels[0].chars, [3, 7]);
    });

    result = await call('POST', '/api/db/patch', { revision: 0, ops: [{ op: 'clear' }] });
    test('补丁 409 冲突仍然带回整库', () => {
      assert.strictEqual(result.status, 409);
      assert.strictEqual(result.body.db.chapters.length, 3);
    });

    result = await call('POST', '/api/db/patch', { ops: [{ op: 'panel.explode' }] });
    test('未知 op：400 + opIndex', () => {
      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.body.opIndex, 0);
    });

    await call('POST', '/api/db/clear', {});
    result = await call('PUT', '/api/db', { db: sample });
    test('空库 + 无 revision：允许写入（视为 force）', () => {
      assert.strictEqual(result.status, 200);
      assert.strictEqual(database.loadDocument().chapters.length, 3);
    });

    result = await call('GET', '/api/health');
    test('GET /api/health 报告 sqlite 存储与规模', () => {
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.storage, 'sqlite');
      assert.strictEqual(result.body.storageVersion, 2);
      assert.strictEqual(result.body.chapters, 3);
      assert.ok(result.body.dataFileSize > 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

httpPhase().then(() => {
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch (error) {
    console.error(`（清理临时目录失败：${error.message}）`);
  }
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    failures.forEach((item) => console.error(`- ${item.name}: ${item.error.stack || item.error.message}`));
    process.exitCode = 1;
  }
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
