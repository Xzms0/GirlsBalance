#!/usr/bin/env node
/**
 * girls_dict（超超你的字典）本地服务端 —— Node 版（SQLite 存储）。
 *
 * 与 server/server.py 暴露完全相同的 REST 接口与 JSON 结构，任选其一运行即可。
 * 只用 Node 内置模块（http / node:sqlite），零第三方依赖。它做两件事：
 *
 * 1. 把 public/（本机管理端）当静态网站托管；
 * 2. 暴露读写 data/girls_dict.sqlite3 的 REST 接口（补丁式增量写入 + 只读查询）；
 * 运行：
 *   node server/server.js
 *   node server/server.js --port 9000 --open
 *   node server/server.js --data D:/xiachao/girls_dict.sqlite3
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');

const db = require('./db.js');
const { SITE_FORMAT_VERSION, publishSite, publishStatus } = require('./site_publish.js');

const APP_NAME = 'girls_dict';
const APP_TITLE = '超超你的字典';
const APP_VERSION = '2.0.0';
const MAX_BODY = 64 * 1024 * 1024;

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PUBLIC = path.join(ROOT, 'public');
const DEFAULT_DATA = path.join(ROOT, 'data', 'girls_dict.sqlite3');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const ENDPOINTS = [
  { method: 'GET', path: '/api/health', desc: '服务信息、数据库文件、版本号' },
  { method: 'GET', path: '/api/index', desc: '轻量目录：每话的计数与元信息，不含槽位内容' },
  { method: 'GET', path: '/api/chapters/{id}', desc: '读取一话（含槽位与角色编号）' },
  { method: 'GET', path: '/api/chapters/{id}/panels/{pid}', desc: '读取单个槽位' },
  { method: 'GET', path: '/api/db', desc: '读取完整文档（带内部 id，界面用它做镜像）' },
  { method: 'POST', path: '/api/db/patch', desc: '★ 增量写入：body={revision, ops:[...], force?, label?}' },
  { method: 'PUT', path: '/api/db', desc: '整库替换；body={revision, db, force?}' },
  { method: 'POST', path: '/api/db/import', desc: '从 JSON 文件或对象导入；body={path} 或 {db}' },
  { method: 'POST', path: '/api/db/clear', desc: '清空所有数据' },
  { method: 'POST', path: '/api/db/validate', desc: '只校验不写入' },
  { method: 'GET', path: '/api/db/export?format=json|csv|sqlite', desc: '导出 JSON / CSV / SQLite' },
  { method: 'GET', path: '/api/stats', desc: '角色出场次数等派生统计' },
  { method: 'GET', path: '/api/find?char=12', desc: '某个角色出现在哪些话/槽位' },
  { method: 'GET', path: '/api/search?q=文字', desc: '按标题/备注/角色名搜索' },
  { method: 'GET', path: '/api/log?limit=50', desc: '最近改动记录' },
  { method: 'GET', path: '/api/backups', desc: '快照列表' },
  { method: 'POST', path: '/api/backups', desc: '立即创建快照；body={tag}' },
  { method: 'POST', path: '/api/backups/restore', desc: '回滚到某个快照；body={name}' },
  { method: 'GET', path: '/api/publish/status', desc: '公开站数据的已发布版本与 Git 状态' },
  { method: 'POST', path: '/api/publish', desc: '导出 docs/data 并 commit / push（仅本机）' },
  { method: 'GET', path: '/api/help', desc: '接口与补丁操作清单' },
];

/* --------------------------------------------------------------------------- *
 * 参数 / 工具
 * --------------------------------------------------------------------------- */
function parseArgs(argv) {
  const options = {
    data: DEFAULT_DATA,
    public: DEFAULT_PUBLIC,
    host: '127.0.0.1',
    port: 8777,
    open: false,
    quiet: false,
    allowOrigin: [],
    backupInterval: db.DEFAULT_BACKUP_INTERVAL,
    check: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--data') options.data = next();
    else if (arg === '--public') options.public = next();
    else if (arg === '--host') options.host = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--open') options.open = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--allow-origin') options.allowOrigin.push(next());
    else if (arg === '--backup-interval') options.backupInterval = Number(next());
    else if (arg === '--check') options.check = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw badRequest(`未知参数：${arg}`);
  }
  return options;
}

/** 只放行本机页面（含 file:// 打开时的 null）与命令行显式允许的来源。 */
function originAllowed(origin, extra) {
  if (!origin) return true;
  if (origin === 'null') return true;
  if (extra.includes(origin)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

function corsHeaders(origin, extra) {
  const headers = { Vary: 'Origin' };
  if (!origin) headers['Access-Control-Allow-Origin'] = '*';
  else if (originAllowed(origin, extra)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** 请求体不合法（对齐 Python 的 ValueError -> 400）。 */
function badRequest(message) {
  const error = new Error(message);
  error.code = 'ERR_BAD_BODY';
  return error;
}

/** 本地时间 2026-10-16T23:24:33（与 Python datetime.isoformat(timespec="seconds") 同形）。 */
function localIsoSeconds() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/* --------------------------------------------------------------------------- *
 * 应用
 * --------------------------------------------------------------------------- */
function createApp(options, existingDatabase) {
  const database = existingDatabase || (() => {
    const created = new db.GirlsDB(options.data, {
      backupInterval: options.backupInterval,
    });
    created.initialize();
    return created;
  })();
  const publicDir = path.resolve(options.public);

  const send = (res, status, body, contentType, extra, origin) => {
    res.writeHead(status, Object.assign({
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    }, corsHeaders(origin, options.allowOrigin), extra || {}));
    if (res.req && res.req.method === 'HEAD') res.end();
    else res.end(body);
  };

  const sendJson = (res, status, payload, origin) => {
    const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    send(res, status, body, 'application/json; charset=utf-8', null, origin);
  };

  const sendDownload = (res, body, filename, contentType, origin) => {
    send(res, 200, body, contentType,
      { 'Content-Disposition': `attachment; filename="${filename}"` }, origin);
  };

  const fail = (res, status, message, extra, origin) => {
    sendJson(res, status, Object.assign({ ok: false, error: message }, extra || {}), origin);
  };

  /** 把数据层的异常映射成 HTTP 状态码（与 server.py 的异常分支一一对应）。 */
  const handleError = (res, error, origin) => {
    if (error instanceof db.RevisionConflict) {
      return sendJson(res, 409, {
        ok: false,
        error: '版本冲突：数据库已被其它程序修改',
        revision: error.currentRevision,
        db: error.currentDocument,
      }, origin);
    }
    if (error instanceof db.ValidationError) {
      return sendJson(res, 422, { ok: false, error: error.message, issues: error.issues }, origin);
    }
    if (error instanceof db.OpError) {
      return sendJson(res, 400, { ok: false, error: error.message, opIndex: error.index }, origin);
    }
    if (error && error.code === 'ENOENT') return fail(res, 404, error.message, null, origin);
    if (error instanceof SyntaxError || (error && error.code === 'ERR_BAD_BODY')) {
      return fail(res, 400, error.message, null, origin);
    }
    return fail(res, 500, `服务端异常：${error && error.message ? error.message : error}`, null, origin);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && !/^\d+$/.test(String(declared))) {
      reject(badRequest('Content-Length 不合法'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(badRequest('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(badRequest(`请求体不是合法 JSON：${error.message}`));
      }
    });
    req.on('error', reject);
  });

  /* ---- 静态文件 ---------------------------------------------------- */
  const serveStatic = (res, pathname, origin) => {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    let target = path.resolve(publicDir, relative);
    if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
      return fail(res, 403, '越权访问', null, origin);
    }
    try {
      if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    } catch (error) {
      // 不存在就往下走
    }
    if (!fs.existsSync(target) && !path.basename(relative).includes('.')) {
      target = path.join(publicDir, 'index.html');
    }
    if (!fs.existsSync(target)) return fail(res, 404, `找不到文件：${relative}`, null, origin);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, fs.readFileSync(target), type, null, origin);
  };

  /* ---- 路由：GET ---------------------------------------------------- */
  const apiGet = (res, pathname, query, origin) => {
    if (pathname === '/api/health') {
      const index = database.loadIndex();
      return sendJson(res, 200, {
        ok: true, app: APP_NAME, title: APP_TITLE, version: APP_VERSION,
        storage: 'sqlite', storageVersion: db.STORAGE_VERSION, exportVersion: db.EXPORT_VERSION,
        siteFormatVersion: SITE_FORMAT_VERSION,
        charMin: db.CHAR_MIN, charMax: db.CHAR_MAX,
        dataFile: database.path, dataFileExists: database.exists(),
        dataFileSize: database.exists() ? database.dbSize() : 0,
        backupDir: database.backupDir,
        revision: index.revision, updatedAt: index.updatedAt,
        chapters: index.stats.chapters, panels: index.stats.panels,
        time: localIsoSeconds(),
      }, origin);
    }
    if (pathname === '/api/index') return sendJson(res, 200, Object.assign({ ok: true }, database.loadIndex()), origin);
    if (pathname === '/api/db') {
      const document = database.loadDocument();
      return sendJson(res, 200, { ok: true, revision: document.revision, db: document }, origin);
    }
    if (pathname === '/api/db/export') {
      const format = (query.get('format') || 'json').toLowerCase();
      if (format === 'csv') {
        return sendDownload(res, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(database.exportCsv(), 'utf8')]),
          'girls_dict.csv', 'text/csv; charset=utf-8', origin);
      }
      if (format === 'sqlite' || format === 'sqlite3' || format === 'db') {
        const blob = database.exists() ? fs.readFileSync(database.path) : Buffer.alloc(0);
        return sendDownload(res, blob, 'girls_dict.sqlite3', 'application/vnd.sqlite3', origin);
      }
      return sendDownload(res, Buffer.from(database.exportJson(), 'utf8'),
        'girls_dict.json', 'application/json; charset=utf-8', origin);
    }
    if (pathname === '/api/stats') return sendJson(res, 200, { ok: true, stats: database.stats() }, origin);
    if (pathname === '/api/find') {
      const raw = query.get('char') || '';
      if (!/^[+-]?\d+$/.test(raw.trim())) return fail(res, 400, 'char 必须是 0–100 的整数', null, origin);
      const char = Number.parseInt(raw.trim(), 10);
      const hits = database.findChar(char);
      return sendJson(res, 200, { ok: true, char, count: hits.length, hits }, origin);
    }
    if (pathname === '/api/search') {
      return sendJson(res, 200, Object.assign({ ok: true }, database.search(query.get('q') || '')), origin);
    }
    if (pathname === '/api/log') {
      const limit = Number.parseInt(query.get('limit') || '50', 10);
      return sendJson(res, 200, { ok: true, log: database.recentLog(Number.isFinite(limit) ? limit : 50) }, origin);
    }
    if (pathname === '/api/backups') return sendJson(res, 200, { ok: true, backups: database.listBackups() }, origin);
    if (pathname === '/api/publish/status') return sendJson(res, 200, publishStatus(ROOT), origin);
    if (pathname === '/api/help') {
      return sendJson(res, 200, { ok: true, endpoints: ENDPOINTS, ops: db.OP_DOCS }, origin);
    }

    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[0] === 'api' && parts[1] === 'chapters') {
      const chapterId = decodeURIComponent(parts[2]);
      if (parts.length === 3) {
        const chapter = database.loadChapter(chapterId);
        if (chapter === null) return fail(res, 404, `没有这一话：${chapterId}`, null, origin);
        return sendJson(res, 200, { ok: true, chapter }, origin);
      }
      if (parts.length === 5 && parts[3] === 'panels') {
        const chapter = database.loadChapter(chapterId);
        if (chapter === null) return fail(res, 404, `没有这一话：${chapterId}`, null, origin);
        const panelId = decodeURIComponent(parts[4]);
        const index = chapter.panels.findIndex((panel) => panel.id === panelId);
        if (index < 0) return fail(res, 404, `找不到这个槽位：${panelId}`, null, origin);
        return sendJson(res, 200, {
          ok: true, chapterId, panelIndex: index + 1, panel: chapter.panels[index],
        }, origin);
      }
    }
    return fail(res, 404, `没有这个接口：GET ${pathname}`, null, origin);
  };

  /* ---- 路由：写入 ---------------------------------------------------- */
  const envelope = (payload, allowed) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest('请求体必须是对象');
    if (Object.keys(payload).some((key) => !allowed.includes(key))) throw badRequest('请求体包含未知字段');
  };
  const apiPutDb = (payload) => {
    envelope(payload, ['db', 'revision', 'force']);
    if (!Object.hasOwn(payload, 'db')) throw badRequest('缺少 db 字段');
    if (payload.db === null) throw badRequest('db 字段不能为 null');
    const document = payload.db;
    const revision = (payload.revision === undefined || payload.revision === null) ? null : payload.revision;
    const explicitForce = !!payload.force;
    // 整库替换是「覆盖一切」的操作，必须表明意图：
    // 要么带上 revision（过期就 409），要么显式 force；空库才可以直接写。
    if (revision === null && !explicitForce) {
      if (database.loadIndex().stats.chapters > 0) {
        throw badRequest('整库替换会覆盖现有数据：请带上 revision（并处理 409），或显式传 force: true');
      }
    }
    const result = database.replaceAll(document, {
      expectedRevision: revision,
      force: explicitForce || revision === null,
      label: 'replace',
    });
    // 整库替换的返回体带上替换后的整份文档（前端可直接换掉本地镜像）
    return { status: 200, body: Object.assign({ ok: true }, result) };
  };

  const apiPost = async (pathname, payload, origin) => {
    if (pathname === '/api/db/patch') {
      const result = database.applyPatch(payload.ops, {
        expectedRevision: payload.revision,
        force: !!payload.force,
        label: payload.label ? String(payload.label) : 'patch',
      });
      // 补丁是增量的：返回体只有 {ok, revision, applied, issues}，不含 db（409 冲突路径才带）
      return { status: 200, body: Object.assign({ ok: true }, result) };
    }
    if (pathname === '/api/db/import') {
      envelope(payload, ['db', 'path']);
      const hasDb = Object.hasOwn(payload, 'db');
      const hasPath = Object.hasOwn(payload, 'path');
      if (hasDb === hasPath) throw badRequest('必须且只能提供 db 或 path');
      if (hasDb && payload.db === null) throw badRequest('db 字段不能为 null');
      if (hasPath && typeof payload.path !== 'string') throw badRequest('path 必须是字符串');
      const result = database.importJson(hasPath ? payload.path : payload.db);
      return { status: 200, body: Object.assign({ ok: true }, result) };
    }
    if (pathname === '/api/db/validate') {
      envelope(payload, ['db']);
      if (!Object.hasOwn(payload, 'db')) throw badRequest('缺少 db 字段');
      const issues = db.validateExportDocument(payload.db);
      const errors = issues.filter((item) => item.level === 'error');
      return { status: 200, body: { ok: true, valid: errors.length === 0, issues } };
    }
    if (pathname === '/api/db/clear') {
      return { status: 200, body: Object.assign({ ok: true }, database.clear()) };
    }
    if (pathname === '/api/backups') {
      const target = database.createBackup(payload.tag ? String(payload.tag) : '');
      return { status: 200, body: { ok: true, backup: path.basename(target) } };
    }
    if (pathname === '/api/backups/restore') {
      const name = payload.name ? String(payload.name) : '';
      if (!name) throw badRequest('缺少快照文件名 name');
      return { status: 200, body: Object.assign({ ok: true }, database.restoreBackup(name)) };
    }
    if (pathname === '/api/publish') {
      if (!originAllowed(origin, options.allowOrigin)) {
        return { status: 403, body: { ok: false, error: '只允许本机页面调用发布接口' } };
      }
      const result = publishSite(database, ROOT, {
        message: payload.message ? String(payload.message) : '',
        exportOnly: Boolean(payload.exportOnly),
        push: payload.push === undefined ? true : Boolean(payload.push),
        force: Boolean(payload.force),
      });
      return { status: 200, body: result };
    }
    return null;
  };

  /* ---- 主处理 -------------------------------------------------------- */
  const handler = async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({
        'Access-Control-Allow-Methods': 'GET, PUT, POST, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        'Content-Length': 0,
      }, corsHeaders(origin, options.allowOrigin)));
      res.end();
      return;
    }

    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return fail(res, 405, '静态资源只支持 GET', null, origin);
        }
        return serveStatic(res, pathname, origin);
      }

      if (req.method === 'GET' || req.method === 'HEAD') return apiGet(res, pathname, url.searchParams, origin);

      const payload = await readBody(req);
      if (req.method === 'PUT') {
        if (pathname !== '/api/db') return fail(res, 404, `没有这个接口：PUT ${pathname}`, null, origin);
        const result = apiPutDb(payload);
        return sendJson(res, result.status, result.body, origin);
      }
      if (req.method === 'POST') {
        const result = await apiPost(pathname, payload, origin);
        if (!result) return fail(res, 404, `没有这个接口：POST ${pathname}`, null, origin);
        return sendJson(res, result.status, result.body, origin);
      }
      return fail(res, 405, '不支持的请求方法', null, origin);
    } catch (error) {
      return handleError(res, error, origin);
    }
  };

  return { server: http.createServer((req, res) => { handler(req, res); }), database };
}

/* --------------------------------------------------------------------------- *
 * 监听 / 启动
 * --------------------------------------------------------------------------- */
/** 端口被占用时向下顺延，最多试 20 个（与 server.py 的 pick_port 同效）。 */
function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate, remaining) => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && remaining > 0) tryPort(candidate + 1, remaining - 1);
        else reject(error);
      });
      server.listen(candidate, host, () => resolve(candidate));
    };
    tryPort(port, 20);
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (error) {
    // 打不开就算了
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node server/server.js [--data 文件] [--public 目录] [--host 地址] [--port 端口]');
    console.log('                          [--open] [--quiet] [--allow-origin 来源] [--backup-interval 秒]');
    console.log('                          [--check]（只做自检后退出）');
    return 0;
  }

  const publicDir = path.resolve(options.public);


  if (!fs.existsSync(publicDir)) {
    console.error(`找不到前端目录：${publicDir}`);
    return 2;
  }

  const database = new db.GirlsDB(options.data, {
    backupInterval: options.backupInterval,
  });
  database.initialize();

  if (options.check) {
    const index = database.loadIndex();
    console.log(JSON.stringify({
      ok: true, storage: 'sqlite', dataFile: database.path,
      size: database.dbSize(), revision: index.revision,
      stats: index.stats,
      issues: database.integrityCheck(),
    }, null, 2));
    return 0;
  }

  const { server } = createApp(Object.assign({}, options, { public: publicDir }), database);
  const port = await listen(server, options.host, options.port);
  const url = `http://${options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host}:${port}/`;
  if (!options.quiet) {
    console.log(`┌─ ${APP_TITLE} (${APP_NAME}) v${APP_VERSION}　存储：SQLite`);
    console.log(`│  前端页面 : ${url}`);
    console.log(`│  数据库   : ${database.path}`);
    console.log(`│  备份目录 : ${database.backupDir}`);
    console.log('└─ Ctrl+C 停止服务');
  }
  if (options.open) setTimeout(() => openBrowser(url), 600);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createApp, parseArgs, originAllowed, listen, ENDPOINTS, APP_VERSION };
