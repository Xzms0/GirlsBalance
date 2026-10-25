/**
 * girls_dict（超超你的字典）数据层 —— Node 版（SQLite 存储）。
 *
 * 与 server/girls_db.py 是同一套东西的两种实现：表结构、语义、返回结构一一对应，
 * 两个服务端可以指向同一个 .sqlite3 文件（别同时写就行）。
 *
 * 为什么不是「一份 JSON 文件」了：每录一个编号就重写整份文档会导致写入放大、
 * 内存随数据量线性增长、单文件损坏即全丢。换成 SQLite 之后：
 *   * 一次录入 = 一条 UPDATE / 几行 INSERT，写入量与改动量成正比；
 *   * 话、槽位、角色编号、角色名各自成表并带索引，可以只查一部分；
 *   * 事务 + WAL，断电写不坏；快照用 VACUUM INTO，秒级且一致；
 *   * 仍然是一个本地文件，零依赖（Node 内置 node:sqlite），拷走就能用；
 *   * JSON 仍然用于导入/导出，导出的 JSON 不包含内部 id。
 *
 * 存储结构见 schema/girls_dict.sql：
 *   info(key, value)                  schema_version / title / author / revision / updated_at
 *   chapter(id, no, title, note, updated_at)      no = 顺序位置，1..N，UNIQUE
 *   panel(id, chapter_id, position, updated_at)   position = 话内顺序，1..M
 *   panel_char(panel_id, char)                    主键 (panel_id, char) 天然去重
 *   char_name(char, name)                         编号 -> 角色名（仅用于显示）
 *   change_log(id, at, revision, action, detail)  最近改动（自动裁到 2000 条）
 *
 * 对外只暴露「文档 + 补丁」两种写入口：
 *   db.applyPatch([{op: 'panel.chars', panelId: '...', chars: [1, 5]}], {expectedRevision: 3})
 *   db.replaceAll(document, {force: true})
 * 补丁的 op 列表见 OP_DOCS。所有写入都在一个事务里完成，revision 是乐观锁。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const pretty = require('./json_pretty.js');

const SCHEMA_NAME = 'girls_dict';
const STORAGE_VERSION = 2; // SQLite 存储结构版本
const EXPORT_VERSION = 2; // 导出/导入用 JSON 的版本
const CHAR_MIN = 0;
const CHAR_MAX = 100;

const DEFAULT_BACKUP_INTERVAL = 600;
const DEFAULT_BACKUP_KEEP = 20;
const LOG_KEEP = 2000;

/** 补丁能用的全部操作（前端 public/js/model.js 的 buildPatch 生成同一套）。 */
const OP_DOCS = [
  {
    op: 'chapter.upsert',
    args: '{chapter:{id?,title,note}, panels:[{id?,chars}], position?}',
    desc: '新增或覆盖一话（连同它的槽位）；position 是 1 起的插入位置，默认追加到末尾',
  },
  { op: 'chapter.update', args: '{id, title?, note?}', desc: '只改标题/备注' },
  { op: 'chapter.delete', args: '{id}', desc: '删除一话（槽位级联删除）' },
  { op: 'chapter.order', args: '{ids:[...]}', desc: '按给定顺序重排所有话并修正编号' },
  { op: 'chapter.move', args: '{id, to}', desc: '把某一话移动到第 to 位' },
  { op: 'chapter.swap', args: '{a, b}', desc: '对换两话并修正编号' },
  { op: 'panel.upsert', args: '{chapterId, panel:{id?,chars}, position?}', desc: '新增或覆盖一个槽位' },
  { op: 'panel.delete', args: '{id}', desc: '删除一个槽位' },
  { op: 'panel.chars', args: '{panelId, chars:[...]}', desc: '整体覆盖某个槽位的角色编号（最常用）' },
  { op: 'meta.update', args: '{title?, author?}', desc: '更新作品名/录入者' },
  { op: 'charName.setMany', args: "{names:{'1':'超超',...}}", desc: '整体替换角色名表' },
  { op: 'clear', args: '{}', desc: '清空所有话、槽位与角色名（保留 schema 信息）' },
  { op: 'replace', args: '{db:{...}}', desc: '整库替换（导入外部 JSON 时用）' },
];

/** op 名 -> 处理函数名；查表即可判断「认不认识这个操作」。 */
const OP_HANDLERS = {
  'chapter.upsert': '_op_chapter_upsert',
  'chapter.update': '_op_chapter_update',
  'chapter.delete': '_op_chapter_delete',
  'chapter.order': '_op_chapter_order',
  'chapter.move': '_op_chapter_move',
  'chapter.swap': '_op_chapter_swap',
  'panel.upsert': '_op_panel_upsert',
  'panel.delete': '_op_panel_delete',
  'panel.chars': '_op_panel_chars',
  'meta.update': '_op_meta_update',
  'charName.setMany': '_op_charName_setMany',
  clear: '_op_clear',
  replace: '_op_replace',
};

/* --------------------------------------------------------------------------- *
 * 建表 SQL（与 schema/girls_dict.sql 的表/列/索引名一致；info 基础行由初始化写入）
 * --------------------------------------------------------------------------- */
const SCHEMA_SQL = `
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
`;

/* --------------------------------------------------------------------------- *
 * 基础工具
 * --------------------------------------------------------------------------- */
/** 任意时间 -> 2026-10-16T14:34:16+00:00（UTC 秒精度，与 Python isoformat 同形）。 */
function isoSeconds(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`;
}

/** 当前时间（UTC，秒精度，ISO-8601）。 */
function nowIso() {
  return isoSeconds(new Date());
}

/** 本地时间戳 20261016-143416，用于快照与归档文件名（与 Python strftime 一致）。 */
function fileStamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Python 风格的 repr，让提示信息与 Python 版逐字一致（'abc' / None / True / [1, 2]）。 */
function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).map((key) => `${pyRepr(key)}: ${pyRepr(value[key])}`).join(', ')}}`;
  }
  return String(value);
}

function issue(bucket, level, at, message) {
  if (bucket) bucket.push({ level, path: at, message });
}

/** 严格整数解析：只认 "12" / "+12" / "-5"（"12abc" 不算，与 Python int() 的常见用法一致）。 */
function parseIntStrict(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  return /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : null;
}

function toInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function checkOptions(options, allowed) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new TypeError('未知参数');
  }
}

/** node:sqlite 返回的行是 null 原型对象；转成普通对象，行为与 Python 的 dict(row) 一致。 */
function plain(row) {
  return Object.assign({}, row);
}

/** 文件不存在的错误，带 ENOENT，方便服务端映射成 404（对齐 Python 的 FileNotFoundError）。 */
function fileNotFound(message) {
  const error = new Error(message);
  error.code = 'ENOENT';
  return error;
}

/* --------------------------------------------------------------------------- *
 * 校验与规范化
 * --------------------------------------------------------------------------- */
/** 整理成 [0,100] 去重升序的整数数组；非法项丢弃并记录。 */
function cleanChars(raw, onIssue, where = '') {
  const out = [];
  const seen = new Set();
  let list = raw;
  if (list === null || list === undefined) return out;
  if (!Array.isArray(list)) list = [list];
  for (const item of list) {
    let value = null;
    if (typeof item === 'boolean') value = null;
    else if (typeof item === 'number' && Number.isInteger(item)) value = item;
    else if (typeof item === 'string' && /^[+-]?\d+$/.test(item.trim())) value = Number.parseInt(item.trim(), 10);
    if (value === null) {
      issue(onIssue, 'error', where, `无法识别的角色编号：${pyRepr(item)}`);
      continue;
    }
    if (value < CHAR_MIN || value > CHAR_MAX) {
      issue(onIssue, 'error', where, `角色编号超出 [${CHAR_MIN},${CHAR_MAX}]：${value}`);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 把外部（可能是人手改过的）一话整理成规范结构；无法识别返回 null。 */
function normalizeChapter(raw, index, issues, seenIds) {
  const where = `chapters[${index}]`;
  if (!isPlainObject(raw)) {
    issue(issues, 'error', where, '话记录不是对象，已丢弃');
    return null;
  }
  const seen = seenIds || new Set();
  // 内部修复保留有效 id（用于增量保存）；外部 JSON 必须先通过 validateExportDocument，
  // 那里会拒绝任何话/槽位 id，因此这里不存在"接受旧 id"的兼容路径。
  let chapterId = raw.id;
  if (typeof chapterId !== 'string' || !chapterId || seen.has(chapterId)) chapterId = newId('ch');
  seen.add(chapterId);

  let panelsIn = raw.panels;
  if (panelsIn === undefined || panelsIn === null) panelsIn = [];
  if (!Array.isArray(panelsIn)) {
    issue(issues, 'error', `${where}.panels`, 'panels 不是数组，已重置为空');
    panelsIn = [];
  }
  // 这里只接收 {chars:[...]} 槽位对象；裸编号数组槽位不会转换，而会报错并丢弃。
  const panels = [];
  panelsIn.forEach((rawPanel, pindex) => {
    const pwhere = `${where}.panels[${pindex}]`;
    if (!isPlainObject(rawPanel)) {
      issue(issues, 'error', pwhere, '槽位不是对象，已丢弃');
      return;
    }
    let panelId = rawPanel.id;
    if (typeof panelId !== 'string' || !panelId || seen.has(panelId)) panelId = newId('pn');
    seen.add(panelId);
    panels.push({ id: panelId, chars: cleanChars(rawPanel.chars, issues, `${pwhere}.chars`) });
  });

  return {
    id: chapterId,
    no: index + 1,
    title: typeof raw.title === 'string' ? raw.title : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    panels,
  };
}

/** 把任意对象整理成规范文档（内部结构，带 id）。用于导入 / 整库替换。 */
function normalizeDocument(raw, issues, title = '超超你的字典') {
  const bucket = issues || [];
  let source = raw;
  if (!isPlainObject(source)) {
    issue(bucket, 'error', '$', '顶层不是 JSON 对象，已重置为空文档');
    source = {};
  }
  // 内部运行期修复工具：补齐默认值、清理非法项并维持身份唯一。
  // 外部文档和整库替换必须先通过各自的严格边界校验。
  const seen = new Set();
  let chaptersIn = source.chapters;
  if (chaptersIn === undefined || chaptersIn === null) chaptersIn = [];
  if (!Array.isArray(chaptersIn)) {
    issue(bucket, 'error', 'chapters', 'chapters 不是数组，已重置为空');
    chaptersIn = [];
  }
  const chapters = chaptersIn
    .map((item, index) => normalizeChapter(item, index, bucket, seen))
    .filter(Boolean);

  const names = {};
  const metaIn = isPlainObject(source.meta) ? source.meta : {};
  const namesIn = isPlainObject(metaIn.charNames) ? metaIn.charNames : {};
  Object.keys(namesIn).forEach((key) => {
    const number = parseIntStrict(key);
    if (number === null) {
      issue(bucket, 'warn', 'meta.charNames', `忽略非法角色编号键：${pyRepr(key)}`);
      return;
    }
    if (number >= CHAR_MIN && number <= CHAR_MAX && typeof namesIn[key] === 'string') {
      names[String(number)] = namesIn[key];
    }
  });

  const revision = source.revision;
  return {
    schema: SCHEMA_NAME,
    schemaVersion: EXPORT_VERSION,
    revision: typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    meta: {
      title: typeof metaIn.title === 'string' ? metaIn.title : title,
      author: typeof metaIn.author === 'string' ? metaIn.author : '',
      charMin: CHAR_MIN,
      charMax: CHAR_MAX,
      charNames: names,
    },
    chapters,
  };
}

/** Strict document boundary; normalization is only a runtime repair tool. */
function validateShape(raw, internal = false) {
  const issues = [];
  const error = (at, message) => issue(issues, 'error', at, message);
  const object = (value, at, required, optional = []) => {
    if (!isPlainObject(value)) { error(at, '必须是对象'); return false; }
    required.forEach((key) => { if (!Object.hasOwn(value, key)) error(`${at}.${key}`, '缺少必需字段'); });
    Object.keys(value).forEach((key) => { if (![...required, ...optional].includes(key)) error(`${at}.${key}`, '未知字段'); });
    return true;
  };
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const text = (value, at) => { if (typeof value !== 'string') error(at, '必须是字符串'); };
  if (!object(raw, '$', ['schema', 'schemaVersion', ...(internal ? ['revision', 'updatedAt'] : []), 'meta', 'chapters'], internal ? [] : ['exportedAt', 'revision'])) return issues;
  if (raw.schema !== SCHEMA_NAME) error('schema', '必须是 girls_dict');
  if (raw.schemaVersion !== EXPORT_VERSION) error('schemaVersion', '必须是 2');
  if ('revision' in raw && !integer(raw.revision)) error('revision', '必须是非负整数');
  const stamp = internal ? 'updatedAt' : 'exportedAt';
  if (stamp in raw && raw[stamp] !== null) text(raw[stamp], stamp);
  if (object(raw.meta, 'meta', ['title', 'author', 'charMin', 'charMax', 'charNames'])) {
    text(raw.meta.title, 'meta.title'); text(raw.meta.author, 'meta.author');
    if (raw.meta.charMin !== 0) error('meta.charMin', '必须是 0');
    if (raw.meta.charMax !== 100) error('meta.charMax', '必须是 100');
    if (!isPlainObject(raw.meta.charNames)) error('meta.charNames', '必须是对象');
    else Object.entries(raw.meta.charNames).forEach(([key, value]) => {
      if (!/^(0|[1-9]\d?|100)$/.test(key)) error(`meta.charNames.${key}`, '必须是 0..100 的规范编号键');
      text(value, `meta.charNames.${key}`);
    });
  }
  const ids = new Set();
  const id = (value, at) => { if (typeof value !== 'string' || !value || ids.has(value)) error(at, 'id 必须是全局唯一的非空字符串'); else ids.add(value); };
  if (!Array.isArray(raw.chapters)) error('chapters', '必须是数组');
  else raw.chapters.forEach((chapter, index) => {
    const at = `chapters[${index}]`;
    if (!object(chapter, at, ['no', 'title', 'note', 'panels'], internal ? ['id'] : [])) return;
    if (internal && 'id' in chapter) id(chapter.id, `${at}.id`);
    if (!Number.isSafeInteger(chapter.no) || chapter.no !== index + 1) error(`${at}.no`, '必须等于数组位置 + 1');
    text(chapter.title, `${at}.title`); text(chapter.note, `${at}.note`);
    if (!Array.isArray(chapter.panels)) error(`${at}.panels`, '必须是数组');
    else chapter.panels.forEach((panel, pi) => {
      const pat = `${at}.panels[${pi}]`;
      if (!object(panel, pat, ['chars'], internal ? ['id'] : [])) return;
      if (internal && 'id' in panel) id(panel.id, `${pat}.id`);
      if (!Array.isArray(panel.chars)) error(`${pat}.chars`, '必须是数组');
      else if (panel.chars.some((char, i) => !Number.isSafeInteger(char) || char < 0 || char > 100 || (i > 0 && panel.chars[i - 1] >= char))) error(`${pat}.chars`, '必须是 0..100 唯一升序整数');
    });
  });
  return issues;
}
function validateExportDocument(raw) { return validateShape(raw); }
function validateInternalDocument(raw) { return validateShape(raw, true); }
function requireExportDocument(raw) {
  const issues = validateExportDocument(raw);
  if (issues.length) throw new ValidationError(issues);
  return raw;
}

/** 一份空文档（规范化后的样子）。 */
function defaultDocument(title = '超超你的字典') {
  return normalizeDocument({ chapters: [] }, [], title);
}

/** 去掉内部 id，得到可长期保存 / 交给别的程序的导出格式。 */
function stripIds(document) {
  const source = document || {};
  return {
    schema: SCHEMA_NAME,
    schemaVersion: EXPORT_VERSION,
    exportedAt: nowIso(),
    meta: JSON.parse(JSON.stringify(source.meta || {})),
    chapters: (source.chapters || []).map((chapter, index) => ({
      no: index + 1,
      title: chapter.title || '',
      note: chapter.note || '',
      panels: (chapter.panels || []).map((panel) => ({ chars: (panel.chars || []).slice() })),
    })),
  };
}

/* --------------------------------------------------------------------------- *
 * 异常
 * --------------------------------------------------------------------------- */
/** 写入时发现库里的 revision 与调用方持有的不一致。 */
class RevisionConflict extends Error {
  constructor(currentRevision, currentDocument) {
    super(`版本冲突：数据库里的 revision=${currentRevision}`);
    this.name = 'RevisionConflict';
    this.currentRevision = currentRevision;
    this.currentDocument = currentDocument === undefined ? null : currentDocument;
  }
}

class ValidationError extends Error {
  constructor(issues) {
    const first = (issues || []).slice(0, 5).map((item) => `${item.path}: ${item.message}`).join('；');
    super(first || '数据不合法');
    this.name = 'ValidationError';
    this.issues = issues || [];
  }
}

/** 补丁里的某个操作不合法。 */
class OpError extends Error {
  constructor(index, message) {
    super(`第 ${index + 1} 个操作不合法：${message}`);
    this.name = 'OpError';
    this.index = index;
  }
}

/** SQLite 抛出的错误包装成 OpError，语义与 Python 的 sqlite3.Error 分支一致。 */
function wrapDbError(error) {
  if (error instanceof RevisionConflict || error instanceof OpError || error instanceof ValidationError) {
    return error;
  }
  if (error && typeof error.code === 'string' && error.code.startsWith('ERR_SQLITE')) {
    return new OpError(0, `数据库错误：${error.message}`);
  }
  return error;
}

/* --------------------------------------------------------------------------- *
 * 数据库
 * --------------------------------------------------------------------------- */
class GirlsDB {
  /**
   * @param {string} dbPath SQLite 文件路径
   * @param {object} [options] {backupDir, backupInterval, backupKeep, title}
   */
  constructor(dbPath, options = {}) {
    checkOptions(options, ['backupDir', 'backupInterval', 'backupKeep', 'title']);
    this.path = path.resolve(dbPath);
    this.backupDir = options.backupDir
      ? path.resolve(options.backupDir)
      : path.join(path.dirname(this.path), 'backups');
    this.backupInterval = options.backupInterval === undefined
      ? DEFAULT_BACKUP_INTERVAL : Number(options.backupInterval);
    this.backupKeep = options.backupKeep === undefined ? DEFAULT_BACKUP_KEEP : Number(options.backupKeep);
    this.title = options.title || '超超你的字典';
    this.lastIssues = [];
  }

  /* ---------------------------------------------------------------- *
   * 连接与建表
   * ---------------------------------------------------------------- */
  /** 打开一个配好 PRAGMA 的连接（调用方负责 close）。 */
  connect() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const conn = new DatabaseSync(this.path, { timeout: 15 });
    conn.exec('PRAGMA journal_mode = WAL');
    conn.exec('PRAGMA synchronous = NORMAL');
    conn.exec('PRAGMA foreign_keys = ON');
    conn.exec('PRAGMA busy_timeout = 15000');
    return conn;
  }

  /** 每个方法自己开关连接（与 Python 版一致：不长期占着 WAL）。 */
  withConnection(fn) {
    const conn = this.connect();
    try {
      return fn(conn);
    } finally {
      conn.close();
    }
  }

  exists() {
    try {
      const stat = fs.statSync(this.path);
      return stat.isFile() && stat.size > 0;
    } catch (error) {
      return false;
    }
  }

  /** Fresh databases are initialized; existing storage versions are never upgraded. */
  initialize() {
    const fresh = !this.exists();
    const conn = this.connect();
    try {
      if (!fresh) {
        const hasInfo = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='info'").get();
        if (!hasInfo || this.info(conn, 'schema_version') !== String(STORAGE_VERSION)) {
          throw new ValidationError([{level: 'error', path: 'schema_version', message: 'SQLite 存储版本必须是 2'}]);
        }
      } else {
        conn.exec(SCHEMA_SQL);
        this.setInfo(conn, 'schema_version', String(STORAGE_VERSION));
        this.setInfo(conn, 'title', this.title);
        this.setInfo(conn, 'author', '');
        this.setInfo(conn, 'revision', '0');
        this.setInfo(conn, 'updated_at', '');
      }
    } finally { conn.close(); }
    return { fresh };
  }

  /* ---------------------------------------------------------------- *
   * info 表小工具
   * ---------------------------------------------------------------- */
  info(conn, key) {
    const row = conn.prepare('SELECT value FROM info WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setInfo(conn, key, value) {
    conn.prepare('INSERT INTO info(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  infoInt(conn, key) {
    const raw = this.info(conn, key);
    const number = raw === null ? 0 : parseIntStrict(raw);
    return number === null ? 0 : number;
  }

  /** revision +1、写 updated_at、记一条 change_log，并把日志裁到 LOG_KEEP 条。 */
  bumpRevision(conn, action, detail = '') {
    const revision = this.infoInt(conn, 'revision') + 1;
    const stamped = nowIso();
    this.setInfo(conn, 'revision', String(revision));
    this.setInfo(conn, 'updated_at', stamped);
    conn.prepare('INSERT INTO change_log(at, revision, action, detail) VALUES(?,?,?,?)')
      .run(stamped, revision, action, String(detail).slice(0, 500));
    conn.prepare('DELETE FROM change_log WHERE id <= (SELECT MAX(id) - ? FROM change_log)').run(LOG_KEEP);
    return revision;
  }

  /* ---------------------------------------------------------------- *
   * 读
   * ---------------------------------------------------------------- */
  revision() {
    return this.withConnection((conn) => this.infoInt(conn, 'revision'));
  }

  /** 完整文档（带内部 id）。界面就是拿这份做本地镜像的。 */
  loadDocument() {
    return this.withConnection((conn) => this.document(conn));
  }

  document(conn) {
    const revision = this.infoInt(conn, 'revision');
    const updatedAt = this.info(conn, 'updated_at') || null;
    const names = {};
    conn.prepare('SELECT char, name FROM char_name').all()
      .forEach((row) => { names[row.char] = row.name; });

    const panelChars = {};
    conn.prepare(
      'SELECT panel.id AS id, panel_char.char AS char FROM panel ' +
      'JOIN panel_char ON panel_char.panel_id = panel.id ORDER BY panel_char.char'
    ).all().forEach((row) => {
      if (!panelChars[row.id]) panelChars[row.id] = [];
      panelChars[row.id].push(row.char);
    });

    const byChapter = {};
    conn.prepare('SELECT id, chapter_id FROM panel ORDER BY chapter_id, position').all().forEach((row) => {
      if (!byChapter[row.chapter_id]) byChapter[row.chapter_id] = [];
      byChapter[row.chapter_id].push({ id: row.id, chars: panelChars[row.id] || [] });
    });

    const chapters = conn.prepare('SELECT id, no, title, note FROM chapter ORDER BY no').all()
      .map((row) => ({
        id: row.id,
        no: row.no,
        title: row.title,
        note: row.note,
        panels: byChapter[row.id] || [],
      }));

    const charNames = {};
    Object.keys(names).forEach((key) => { charNames[String(key)] = names[key]; });

    // 只有 info 表里确实没有 title 行（null）时才回退到默认标题。
    // 空字符串是合法的当前格式标题，不能因为真值判断被替换成默认值。
    const storedTitle = this.info(conn, 'title');
    return {
      schema: SCHEMA_NAME,
      schemaVersion: EXPORT_VERSION,
      revision,
      updatedAt,
      meta: {
        title: storedTitle === null ? this.title : storedTitle,
        author: this.info(conn, 'author') || '',
        charMin: CHAR_MIN,
        charMax: CHAR_MAX,
        charNames,
      },
      chapters,
    };
  }

  /** 轻量目录：只有话的元信息与计数，不带槽位内容。数据量大时先拉这个。 */
  loadIndex() {
    return this.withConnection((conn) => {
      const chapters = conn.prepare(
        'SELECT c.id, c.no, c.title, c.note, c.updated_at, ' +
        '  COUNT(DISTINCT p.id) AS panels, ' +
        '  COUNT(pc.char) AS appearances, ' +
        '  COUNT(DISTINCT pc.char) AS chars ' +
        'FROM chapter c ' +
        'LEFT JOIN panel p ON p.chapter_id = c.id ' +
        'LEFT JOIN panel_char pc ON pc.panel_id = p.id ' +
        'GROUP BY c.id ORDER BY c.no'
      ).all().map(plain);
      const totals = plain(conn.prepare(
        'SELECT (SELECT COUNT(*) FROM chapter) AS chapters, ' +
        '       (SELECT COUNT(*) FROM panel) AS panels, ' +
        '       (SELECT COUNT(DISTINCT char) FROM panel_char) AS distinct_chars, ' +
        '       (SELECT COUNT(*) FROM panel_char) AS appearances'
      ).get());
      return {
        revision: this.infoInt(conn, 'revision'),
        updatedAt: this.info(conn, 'updated_at') || null,
        chapters,
        stats: totals,
      };
    });
  }

  loadChapter(chapterId) {
    return this.withConnection((conn) => {
      const row = conn.prepare('SELECT id, no, title, note FROM chapter WHERE id = ?').get(chapterId);
      if (!row) return null;
      const panels = conn.prepare('SELECT id FROM panel WHERE chapter_id = ? ORDER BY position').all(chapterId)
        .map((panel) => ({
          id: panel.id,
          chars: conn.prepare('SELECT char FROM panel_char WHERE panel_id = ? ORDER BY char').all(panel.id)
            .map((item) => item.char),
        }));
      return { id: row.id, no: row.no, title: row.title, note: row.note, panels };
    });
  }

  charNames() {
    return this.withConnection((conn) => {
      const names = {};
      conn.prepare('SELECT char, name FROM char_name').all()
        .forEach((row) => { names[String(row.char)] = row.name; });
      return names;
    });
  }

  /** 角色出场次数（按分镜计，同一槽位同一角色只算一次）。 */
  stats() {
    return this.withConnection((conn) => {
      const rows = conn.prepare(
        "SELECT pc.char AS char, COUNT(*) AS panels, COALESCE(cn.name, '') AS name " +
        'FROM panel_char pc LEFT JOIN char_name cn ON cn.char = pc.char ' +
        'GROUP BY pc.char ORDER BY panels DESC, pc.char ASC'
      ).all();
      const totals = conn.prepare(
        'SELECT (SELECT COUNT(*) FROM chapter) AS chapters, ' +
        '       (SELECT COUNT(*) FROM panel) AS panels, ' +
        '       (SELECT COUNT(DISTINCT char) FROM panel_char) AS distinct_chars, ' +
        '       (SELECT COUNT(*) FROM panel_char) AS appearances'
      ).get();
      return {
        chapters: totals.chapters,
        panels: totals.panels,
        distinct_chars: totals.distinct_chars,
        appearances: totals.appearances,
        characters: rows.map((row) => ({ char: row.char, name: row.name, panels: row.panels })),
      };
    });
  }

  findChar(char) {
    return this.withConnection((conn) => conn.prepare(
      'SELECT c.id AS chapterId, c.no AS chapterNo, c.title AS chapterTitle, ' +
      '       p.id AS panelId, p.position AS panelIndex ' +
      'FROM panel_char pc JOIN panel p ON p.id = pc.panel_id ' +
      'JOIN chapter c ON c.id = p.chapter_id ' +
      'WHERE pc.char = ? ORDER BY c.no, p.position'
    ).all(char).map(plain));
  }

  /** 按标题 / 备注 / 角色名搜索。 */
  search(text) {
    const query = String(text === null || text === undefined ? '' : text).trim();
    if (!query) return { chapters: [], charNames: [] };
    const like = `%${query}%`;
    return this.withConnection((conn) => ({
      chapters: conn.prepare('SELECT id, no, title FROM chapter WHERE title LIKE ? OR note LIKE ? ORDER BY no')
        .all(like, like).map(plain),
      charNames: conn.prepare('SELECT char, name FROM char_name WHERE name LIKE ? ORDER BY char')
        .all(like).map(plain),
    }));
  }

  recentLog(limit = 50) {
    const size = Math.max(1, Math.min(500, toInt(limit, 50)));
    return this.withConnection((conn) => conn.prepare(
      'SELECT at, revision, action, detail FROM change_log ORDER BY id DESC LIMIT ?'
    ).all(size).map(plain));
  }

  /* ---------------------------------------------------------------- *
   * 写：补丁
   * ---------------------------------------------------------------- */
  /**
   * 在一个事务里应用一批操作，成功后 revision +1。
   * 任何一步出错都整体回滚，revision 不会被消耗。
   *
   * 默认**不**回传整份文档（includeDocument=false）：补丁是增量的，返回体应当与
   * 「改了多少」成正比，而不是与「数据有多大」成正比；只有调用方明确要才组装。
   */
  applyPatch(ops, options = {}) {
    const label = options.label === undefined ? 'patch' : String(options.label);
    const includeDocument = !!options.includeDocument;
    if (!Array.isArray(ops) || ops.length === 0) throw new OpError(0, 'ops 必须是非空数组');
    const issues = [];
    const applied = [];
    const expected = (options.expectedRevision === undefined || options.expectedRevision === null)
      ? null : Math.trunc(Number(options.expectedRevision));
    const force = !!options.force;

    const conn = this.connect();
    try {
      try {
        // VACUUM INTO 不能在事务里跑，所以先留快照再开事务（快照是改动前的状态）
        if (this.exists() && this.shouldBackup()) this.backupConn(conn);
        conn.exec('BEGIN IMMEDIATE');
        const current = this.infoInt(conn, 'revision');
        if (expected !== null && !force && expected !== current) {
          conn.exec('ROLLBACK');
          // 冲突时要把库里最新内容带回去，界面才知道怎么合并
          throw new RevisionConflict(current, this.document(conn));
        }
        ops.forEach((op, index) => {
          if (!isPlainObject(op) || typeof op.op !== 'string') throw new OpError(index, '缺少 op 字段');
          const handlerName = OP_HANDLERS[op.op];
          const handler = handlerName ? this[handlerName] : null;
          if (typeof handler !== 'function') throw new OpError(index, `不认识的操作 ${pyRepr(op.op)}`);
          handler.call(this, conn, op, issues);
          applied.push(op.op);
        });
        const revision = this.bumpRevision(conn, label, Array.from(new Set(applied)).sort().join(','));
        const document = includeDocument ? this.document(conn) : null;
        conn.exec('COMMIT');
        this.lastIssues = issues;
        const result = { revision, applied, issues };
        if (includeDocument) result.db = document;
        return result;
      } catch (error) {
        try {
          conn.exec('ROLLBACK');
        } catch (rollbackError) {
          // 事务可能已经回滚过，忽略
        }
        throw wrapDbError(error);
      }
    } finally {
      conn.close();
    }
  }

  /* ---- 各个 op 的实现（错误索引与 Python 一致，都是 0） ------------------ */
  _op_chapter_upsert(conn, op, issues) {
    const raw = op.chapter || {};
    if (!isPlainObject(raw)) throw new OpError(0, 'chapter 必须是对象');
    let chapterId = raw.id;
    if (typeof chapterId !== 'string' || !chapterId) chapterId = newId('ch');
    const title = typeof raw.title === 'string' ? raw.title : '';
    const note = typeof raw.note === 'string' ? raw.note : '';
    const stored = nowIso();

    const exists = conn.prepare('SELECT 1 FROM chapter WHERE id = ?').get(chapterId) !== undefined;
    if (exists) {
      conn.prepare('UPDATE chapter SET title = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(title, note, stored, chapterId);
      conn.prepare('DELETE FROM panel WHERE chapter_id = ?').run(chapterId);
    } else {
      let position = op.position;
      const ids = this.chapterIds(conn);
      if (!Number.isInteger(position) || position < 1 || position > ids.length + 1) position = ids.length + 1;
      ids.splice(position - 1, 0, chapterId);
      this.insertChapter(conn, chapterId, title, note, stored);
      this.setChapterOrder(conn, ids);
    }

    let panelsIn = op.panels;
    if (panelsIn === undefined || panelsIn === null) panelsIn = [];
    if (!Array.isArray(panelsIn)) throw new OpError(0, 'panels 必须是数组');
    const seenIds = new Set(conn.prepare('SELECT id FROM panel').all().map((row) => row.id));
    panelsIn.forEach((rawPanel, index) => {
      if (!isPlainObject(rawPanel)) {
        issue(issues, 'error', `panels[${index}]`, '槽位不是对象，已跳过');
        return;
      }
      let panelId = rawPanel.id;
      if (typeof panelId !== 'string' || !panelId || seenIds.has(panelId)) panelId = newId('pn');
      seenIds.add(panelId);
      const chars = cleanChars(rawPanel.chars, issues, `panels[${index}].chars`);
      conn.prepare(
        'INSERT INTO panel(id, chapter_id, position, updated_at) VALUES(?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET chapter_id = excluded.chapter_id, updated_at = excluded.updated_at'
      ).run(panelId, chapterId, index + 1, stored);
      this.setPanelChars(conn, panelId, chars);
    });
    this.setPanelOrder(conn, chapterId, conn.prepare(
      'SELECT id FROM panel WHERE chapter_id = ? ORDER BY position'
    ).all(chapterId).map((row) => row.id));
  }

  _op_chapter_update(conn, op) {
    const chapterId = op.id;
    if (!this.chapterExists(conn, chapterId)) throw new OpError(0, `找不到这一话：${chapterId}`);
    const sets = [];
    const params = [];
    if (typeof op.title === 'string') {
      sets.push('title = ?');
      params.push(op.title);
    }
    if (typeof op.note === 'string') {
      sets.push('note = ?');
      params.push(op.note);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    params.push(nowIso(), chapterId);
    conn.prepare(`UPDATE chapter SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  _op_chapter_delete(conn, op) {
    const chapterId = op.id;
    conn.prepare('DELETE FROM panel_char WHERE panel_id IN (SELECT id FROM panel WHERE chapter_id = ?)')
      .run(chapterId);
    conn.prepare('DELETE FROM panel WHERE chapter_id = ?').run(chapterId);
    conn.prepare('DELETE FROM chapter WHERE id = ?').run(chapterId);
    this.setChapterOrder(conn, this.chapterIds(conn));
  }

  _op_chapter_order(conn, op) {
    const ids = op.ids;
    if (!Array.isArray(ids) || !ids.every((item) => typeof item === 'string')) {
      throw new OpError(0, 'ids 必须是字符串数组');
    }
    const current = this.chapterIds(conn);
    const known = new Set(current);
    const wanted = ids.filter((id) => known.has(id));
    const picked = new Set(wanted);
    current.forEach((id) => {
      if (!picked.has(id)) wanted.push(id); // 漏掉的按原顺序补在后面
    });
    this.setChapterOrder(conn, wanted);
  }

  _op_chapter_move(conn, op) {
    const chapterId = op.id;
    const current = this.chapterIds(conn);
    if (!current.includes(chapterId)) throw new OpError(0, `找不到这一话：${chapterId}`);
    current.splice(current.indexOf(chapterId), 1);
    const target = Math.max(1, Math.min(current.length + 1,
      Number.isInteger(op.to) ? op.to : current.length + 1));
    current.splice(target - 1, 0, chapterId);
    this.setChapterOrder(conn, current);
  }

  _op_chapter_swap(conn, op) {
    const first = op.a;
    const second = op.b;
    const current = this.chapterIds(conn);
    if (!current.includes(first) || !current.includes(second)) {
      throw new OpError(0, 'a / b 必须是已存在的话 id');
    }
    const i = current.indexOf(first);
    const j = current.indexOf(second);
    const swap = current[i];
    current[i] = current[j];
    current[j] = swap;
    this.setChapterOrder(conn, current);
  }

  _op_panel_upsert(conn, op, issues) {
    const chapterId = op.chapterId;
    if (!this.chapterExists(conn, chapterId)) throw new OpError(0, `找不到这一话：${chapterId}`);
    const raw = op.panel || {};
    if (!isPlainObject(raw)) throw new OpError(0, 'panel 必须是对象');
    let panelId = raw.id;
    if (typeof panelId !== 'string' || !panelId) {
      panelId = newId('pn');
      const taken = new Set(conn.prepare('SELECT id FROM panel').all().map((row) => row.id));
      while (taken.has(panelId)) panelId = newId('pn');
    }
    const chars = cleanChars(raw.chars, issues, 'panel.chars');
    conn.prepare(
      'INSERT INTO panel(id, chapter_id, position, updated_at) VALUES(?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET chapter_id = excluded.chapter_id, updated_at = excluded.updated_at'
    ).run(panelId, chapterId, 10 ** 6, nowIso());
    this.setPanelChars(conn, panelId, chars);

    const ids = conn.prepare('SELECT id FROM panel WHERE chapter_id = ? ORDER BY position').all(chapterId)
      .map((row) => row.id)
      .filter((id) => id !== panelId);
    const target = Math.max(1, Math.min(ids.length + 1,
      Number.isInteger(op.position) ? op.position : ids.length + 1));
    ids.splice(target - 1, 0, panelId);
    this.setPanelOrder(conn, chapterId, ids);
  }

  _op_panel_delete(conn, op) {
    const panelId = op.id;
    const row = conn.prepare('SELECT chapter_id FROM panel WHERE id = ?').get(panelId);
    conn.prepare('DELETE FROM panel_char WHERE panel_id = ?').run(panelId);
    conn.prepare('DELETE FROM panel WHERE id = ?').run(panelId);
    if (row) {
      this.setPanelOrder(conn, row.chapter_id, conn.prepare(
        'SELECT id FROM panel WHERE chapter_id = ? ORDER BY position'
      ).all(row.chapter_id).map((item) => item.id));
    }
  }

  _op_panel_chars(conn, op, issues) {
    const panelId = op.panelId;
    if (conn.prepare('SELECT 1 FROM panel WHERE id = ?').get(panelId) === undefined) {
      throw new OpError(0, `找不到这个槽位：${panelId}`);
    }
    const chars = cleanChars(op.chars, issues, 'panel.chars');
    this.setPanelChars(conn, panelId, chars);
    conn.prepare('UPDATE panel SET updated_at = ? WHERE id = ?').run(nowIso(), panelId);
  }

  _op_meta_update(conn, op) {
    // 只做类型判断：空字符串是合法的"清空标题"操作，不能当作没有提供而忽略。
    if (typeof op.title === 'string') this.setInfo(conn, 'title', op.title);
    if (typeof op.author === 'string') this.setInfo(conn, 'author', op.author);
  }

  _op_charName_setMany(conn, op, issues) {
    const names = op.names;
    if (!isPlainObject(names)) throw new OpError(0, 'names 必须是对象');
    const cleaned = new Map();
    Object.keys(names).forEach((key) => {
      const number = parseIntStrict(key);
      if (number === null) {
        issue(issues, 'warn', 'names', `忽略非法编号键：${pyRepr(key)}`);
        return;
      }
      if (number < CHAR_MIN || number > CHAR_MAX) {
        issue(issues, 'warn', 'names', `忽略越界编号：${number}`);
        return;
      }
      const value = names[key];
      if (typeof value === 'string' && value.trim()) cleaned.set(number, value);
    });
    conn.prepare('DELETE FROM char_name').run();
    const insert = conn.prepare('INSERT INTO char_name(char, name) VALUES(?,?)');
    [...cleaned.keys()].sort((a, b) => a - b).forEach((number) => insert.run(number, cleaned.get(number)));
  }

  _op_clear(conn) {
    conn.prepare('DELETE FROM panel_char').run();
    conn.prepare('DELETE FROM panel').run();
    conn.prepare('DELETE FROM chapter').run();
    conn.prepare('DELETE FROM char_name').run();
  }

  _op_replace(conn, op, issues) {
    if (Object.hasOwn(op, 'document')) throw new OpError(0, '不支持 document 字段');
    const raw = op.db;
    if (raw === undefined || raw === null) throw new OpError(0, '缺少 db 字段');
    if (!isPlainObject(raw)) throw new OpError(0, 'db 必须是对象');
    const invalid = validateInternalDocument(raw);
    if (invalid.length) throw new ValidationError(invalid);
    const document = normalizeDocument(raw, issues, this.title);
    this.writeDocument(conn, document);
    // 严格文档里的 meta.title 一定是字符串（可以为空）；空字符串也要原样写入，
    // 不能用真值判断跳过，否则读回时标题会被默认值替换。
    this.setInfo(conn, 'title', document.meta.title);
    this.setInfo(conn, 'author', document.meta.author || '');
  }

  /* ---- 底层写入工具 --------------------------------------------------- */
  chapterExists(conn, chapterId) {
    if (typeof chapterId !== 'string' || !chapterId) return false;
    return conn.prepare('SELECT 1 FROM chapter WHERE id = ?').get(chapterId) !== undefined;
  }

  insertChapter(conn, chapterId, title, note, stamped) {
    // no 先给一个临时负数，随后由 setChapterOrder 统一编号
    const used = conn.prepare('SELECT COALESCE(MIN(no), 0) AS m FROM chapter').get().m;
    conn.prepare('INSERT INTO chapter(id, no, title, note, updated_at) VALUES(?,?,?,?,?)')
      .run(chapterId, Math.min(0, used) - 1, title, note, stamped);
  }

  chapterIds(conn) {
    return conn.prepare('SELECT id FROM chapter ORDER BY no').all().map((row) => row.id);
  }

  /**
   * 先把 no 整体挪到很远的地方，再按目标顺序写 1..N，绕开 UNIQUE(no) 冲突。
   * 偏移量取 1000000：现有 no 恒为 ≥ -1（临时值），减完之后 ≤ -999999，
   * 与尚未处理的行（≥ -1）绝不会撞车，且 x → x-1000000 本身是单射。
   */
  setChapterOrder(conn, ids) {
    conn.exec('UPDATE chapter SET no = no - 1000000');
    const update = conn.prepare('UPDATE chapter SET no = ? WHERE id = ?');
    ids.forEach((chapterId, index) => update.run(index + 1, chapterId));
  }

  setPanelOrder(conn, chapterId, ids) {
    conn.prepare('UPDATE panel SET position = position - 1000000 WHERE chapter_id = ?').run(chapterId);
    const update = conn.prepare('UPDATE panel SET position = ? WHERE id = ?');
    ids.forEach((panelId, index) => update.run(index + 1, panelId));
  }

  setPanelChars(conn, panelId, chars) {
    conn.prepare('DELETE FROM panel_char WHERE panel_id = ?').run(panelId);
    const insert = conn.prepare('INSERT OR IGNORE INTO panel_char(panel_id, char) VALUES(?,?)');
    chars.forEach((char) => insert.run(panelId, Math.trunc(Number(char))));
  }

  writeDocument(conn, document) {
    conn.prepare('DELETE FROM panel_char').run();
    conn.prepare('DELETE FROM panel').run();
    conn.prepare('DELETE FROM chapter').run();
    conn.prepare('DELETE FROM char_name').run();
    const names = document.meta.charNames || {};
    Object.keys(names).forEach((key) => {
      const number = parseIntStrict(key);
      const name = names[key];
      // 空字符串是合法的角色名（表示暂未命名），要按原样保留；
      // 这里只校验编号键与值类型，不再用 trim() 作为"是否写入"的条件。
      if (number !== null && number >= CHAR_MIN && number <= CHAR_MAX && typeof name === 'string') {
        conn.prepare('INSERT OR REPLACE INTO char_name(char, name) VALUES(?,?)').run(number, name);
      }
    });
    const stamped = nowIso();
    const insertChapter = conn.prepare('INSERT INTO chapter(id, no, title, note, updated_at) VALUES(?,?,?,?,?)');
    const insertPanel = conn.prepare('INSERT INTO panel(id, chapter_id, position, updated_at) VALUES(?,?,?,?)');
    document.chapters.forEach((chapter, index) => {
      insertChapter.run(chapter.id, index + 1, chapter.title || '', chapter.note || '', stamped);
      (chapter.panels || []).forEach((panel, pindex) => {
        insertPanel.run(panel.id, chapter.id, pindex + 1, stamped);
        this.setPanelChars(conn, panel.id, panel.chars || []);
      });
    });
  }

  /* ---- 整库替换 / 导入 ------------------------------------------------- */
  /**
   * 整库替换（严格内部文档）。
   * 与 Python 的 replace_all 一致：带上 includeDocument，调用方能直接拿到替换后的整库
   * （整库替换本来就把整份文档送进来了，回一份方便前端更新镜像）。
   */
  replaceAll(raw, options = {}) {
    checkOptions(options, ['expectedRevision', 'force', 'label']);
    return this.applyPatch([{ op: 'replace', db: raw }], {
      expectedRevision: options.expectedRevision,
      force: options.force === undefined ? true : options.force,
      label: options.label === undefined ? 'replace' : options.label,
      includeDocument: true,
    });
  }

  /** 把一份 JSON 文件写进当前连接（调用方负责事务）。 */
  importInto(conn, sourcePath) {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const document = normalizeDocument(requireExportDocument(parsed), [], this.title);
    conn.exec('BEGIN IMMEDIATE');
    let revision;
    try {
      this.writeDocument(conn, document);
      // 空标题同样原样保存（validateExportDocument 只要求字符串类型）。
      this.setInfo(conn, 'title', document.meta.title);
      this.setInfo(conn, 'author', document.meta.author || '');
      revision = this.bumpRevision(conn, 'import', path.basename(sourcePath));
      conn.exec('COMMIT');
    } catch (error) {
      try {
        conn.exec('ROLLBACK');
      } catch (rollbackError) {
        // 忽略
      }
      throw error;
    }
    return {
      source: String(sourcePath),
      revision,
      chapters: document.chapters.length,
      panels: document.chapters.reduce((sum, chapter) => sum + chapter.panels.length, 0),
      chars: document.chapters.reduce(
        (sum, chapter) => sum + chapter.panels.reduce((inner, panel) => inner + panel.chars.length, 0), 0),
    };
  }

  /** 从 JSON 文件（或直接给对象）导入，源文件保持不变。 */
  importJson(source, options = {}) {
    checkOptions(options, ['label']);
    const label = options.label === undefined ? 'import' : String(options.label);
    const conn = this.connect();
    try {
      let stats;
      const isPath = typeof source === 'string' || (source && typeof source === 'object' && source instanceof URL);
      if (isPath) {
        const target = path.resolve(String(source));
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw fileNotFound(`找不到文件：${target}`);
        }
        stats = this.importInto(conn, target);
      } else {
        const document = normalizeDocument(requireExportDocument(source), [], this.title);
        conn.exec('BEGIN IMMEDIATE');
        let revision;
        try {
          this.writeDocument(conn, document);
          // 对象导入与文件导入使用同一规则：空标题也原样保存。
          this.setInfo(conn, 'title', document.meta.title);
          this.setInfo(conn, 'author', document.meta.author || '');
          revision = this.bumpRevision(conn, label, 'object');
          conn.exec('COMMIT');
        } catch (error) {
          try {
            conn.exec('ROLLBACK');
          } catch (rollbackError) {
            // 忽略
          }
          throw error;
        }
        stats = {
          source: '(object)',
          revision,
          chapters: document.chapters.length,
          panels: document.chapters.reduce((sum, chapter) => sum + chapter.panels.length, 0),
          chars: document.chapters.reduce(
            (sum, chapter) => sum + chapter.panels.reduce((inner, panel) => inner + panel.chars.length, 0), 0),
        };
      }
      return stats;
    } finally {
      conn.close();
    }
  }

  clear(label = 'clear') {
    return this.applyPatch([{ op: 'clear' }], { label });
  }

  /* ---------------------------------------------------------------- *
   * 导出
   * ---------------------------------------------------------------- */
  /** 导出格式：**不含内部 id**，可以长期保存或交给别的程序。 */
  exportDocument() {
    return stripIds(this.loadDocument());
  }

  exportJson() {
    return pretty.stringify(this.exportDocument());
  }

  /** 话-分镜 × 0..100 的 0/1 矩阵。 */
  exportCsv() {
    const document = this.loadDocument();
    const columns = [];
    for (let char = CHAR_MIN; char <= CHAR_MAX; char += 1) columns.push(char);
    const lines = [`话-分镜,${columns.join(',')}\r\n`];
    document.chapters.forEach((chapter) => {
      chapter.panels.forEach((panel, index) => {
        const chars = new Set(panel.chars);
        const cells = columns.map((char) => (chars.has(char) ? '1' : '0'));
        lines.push(`${chapter.no}-${index + 1},${cells.join(',')}\r\n`);
      });
    });
    return lines.join('');
  }

  /* ---------------------------------------------------------------- *
   * 备份 / 回滚 / 校验
   * ---------------------------------------------------------------- */
  backupConn(conn) {
    if (!this.exists()) return null;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stem = path.basename(this.path, path.extname(this.path));
    const stamp = fileStamp();
    let target = path.join(this.backupDir, `${stem}-${stamp}.sqlite3`);
    if (fs.existsSync(target)) target = path.join(this.backupDir, `${stem}-${stamp}-${newId('b')}.sqlite3`);
    conn.prepare('VACUUM INTO ?').run(target);
    this.pruneBackups();
    return target;
  }

  /** 立即创建快照；返回快照文件的完整路径（Python 版返回 Path 对象）。 */
  createBackup(tag = '') {
    const conn = this.connect();
    let target;
    try {
      target = this.backupConn(conn);
    } finally {
      conn.close();
    }
    if (!target) throw fileNotFound('还没有数据库文件可备份');
    if (tag && fs.existsSync(target)) {
      const renamed = path.join(path.dirname(target),
        `${path.basename(target, path.extname(target))}-${tag}${path.extname(target)}`);
      fs.renameSync(target, renamed);
      target = renamed;
    }
    return target;
  }

  backupFiles() {
    const prefix = `${path.basename(this.path, path.extname(this.path))}-`;
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(this.backupDir, name))
      .filter((file) => {
        try {
          return fs.statSync(file).isFile();
        } catch (error) {
          return false;
        }
      })
      .sort()
      .reverse();
  }

  listBackups() {
    return this.backupFiles().map((file) => {
      const stat = fs.statSync(file);
      return { name: path.basename(file), size: stat.size, mtime: isoSeconds(new Date(stat.mtimeMs)) };
    });
  }

  /** 把快照内容整体拷回当前库（先给当前状态留一份底，再在事务里换掉）。 */
  restoreBackup(name) {
    const source = path.resolve(this.backupDir, path.basename(name));
    if (path.dirname(source) !== this.backupDir || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw fileNotFound(`找不到快照：${name}`);
    }
    if (this.exists()) this.createBackup('before-restore');
    const snapshot = new GirlsDB(source, {
      backupDir: this.backupDir, backupInterval: 0, title: this.title,
    });
    const document = snapshot.loadDocument();
    const conn = this.connect();
    try {
      conn.exec('BEGIN IMMEDIATE');
      try {
        this.writeDocument(conn, document);
        // 快照里的空标题也要保持为空，不能替换成当前实例的默认标题。
        this.setInfo(conn, 'title', document.meta.title);
        this.setInfo(conn, 'author', document.meta.author || '');
        const revision = this.bumpRevision(conn, 'restore', path.basename(name));
        conn.exec('COMMIT');
        return { revision, restored: path.basename(name), db: this.document(conn) };
      } catch (error) {
        try {
          conn.exec('ROLLBACK');
        } catch (rollbackError) {
          // 忽略
        }
        throw error;
      }
    } finally {
      conn.close();
    }
  }

  shouldBackup() {
    if (!(this.backupInterval > 0)) return false;
    const files = this.backupFiles();
    if (!files.length) return true;
    const newest = Math.max(...files.map((file) => fs.statSync(file).mtimeMs));
    return (Date.now() - newest) / 1000 >= this.backupInterval;
  }

  pruneBackups() {
    this.backupFiles().slice(this.backupKeep).forEach((stale) => {
      try {
        fs.unlinkSync(stale);
      } catch (error) {
        // 忽略
      }
    });
  }

  /** 结构与内容检查，返回问题列表（空 = 没问题）。 */
  integrityCheck() {
    const issues = [];
    return this.withConnection((conn) => {
      const result = conn.prepare('PRAGMA integrity_check').get().integrity_check;
      if (result !== 'ok') issue(issues, 'error', 'database', `SQLite 完整性检查未通过：${result}`);
      conn.prepare('PRAGMA foreign_key_check').all().forEach((row) => {
        issue(issues, 'error', 'foreign_key', `外键不完整：${pyRepr(row)}`);
      });
      const badChars = conn.prepare('SELECT COUNT(*) AS c FROM panel_char WHERE char < ? OR char > ?')
        .get(CHAR_MIN, CHAR_MAX).c;
      if (badChars) issue(issues, 'error', 'panel_char', `${badChars} 条角色编号超出范围`);
      const missing = conn.prepare(
        'SELECT COUNT(*) AS c FROM panel p LEFT JOIN chapter c ON c.id = p.chapter_id WHERE c.id IS NULL'
      ).get().c;
      if (missing) issue(issues, 'error', 'panel', `${missing} 个槽位没有对应的话`);
      if (conn.prepare('SELECT COUNT(*) AS c FROM chapter').get().c) {
        const numbers = conn.prepare('SELECT no FROM chapter ORDER BY no').all().map((row) => row.no);
        const expected = Array.from({ length: numbers.length }, (unused, index) => index + 1);
        if (numbers.join(',') !== expected.join(',')) {
          issue(issues, 'warn', 'chapter.no', `话编号不连续：${pyRepr(numbers.slice(0, 10))}…`);
        }
      }
      const storageVersion = this.info(conn, 'schema_version');
      if (storageVersion !== null && storageVersion !== String(STORAGE_VERSION)) {
        issue(issues, 'warn', 'schema_version',
          `存储版本 ${storageVersion} 与程序支持的 ${STORAGE_VERSION} 不一致`);
      }
      return issues;
    });
  }

  /** 数据库本体 + WAL / SHM 的总字节数。 */
  dbSize() {
    return ['', '-wal', '-shm'].reduce((total, suffix) => {
      try {
        const stat = fs.statSync(`${this.path}${suffix}`);
        return total + (stat.isFile() ? stat.size : 0);
      } catch (error) {
        return total;
      }
    }, 0);
  }
}

module.exports = {
  SCHEMA_NAME,
  STORAGE_VERSION,
  EXPORT_VERSION,
  CHAR_MIN,
  CHAR_MAX,
  DEFAULT_BACKUP_INTERVAL,
  DEFAULT_BACKUP_KEEP,
  LOG_KEEP,
  OP_DOCS,
  OP_HANDLERS,
  SCHEMA_SQL,
  nowIso,
  isoSeconds,
  fileStamp,
  newId,
  pyRepr,
  cleanChars,
  normalizeChapter,
  normalizeDocument,
  validateExportDocument,
  validateInternalDocument,
  defaultDocument,
  stripIds,
  GirlsDB,
  RevisionConflict,
  ValidationError,
  OpError,
};
