/*!
 * girls_dict · 存储适配层
 *
 * 上层界面只认同一套接口，因此换存储方式不用改一行界面代码：
 *
 *   http —— 本地服务（SQLite）。补丁式增量写入：改一个编号只发一条 panel.chars。
 *   idb  —— 浏览器自带数据库 IndexedDB。每个话一条记录，改哪条写哪条。
 *   file —— 一个 .json 文件（File System Access API）。整份重写，适合备份/恢复。
 *
 * 统一接口（store.js 只依赖这些）：
 *   status()                    -> Promise<{ok, canWrite, detail, info?}>
 *   load()                      -> Promise<{db, revision, issues?}>
 *   save(db, revision, {ops})   -> Promise<{revision, issues}>   冲突时 reject GD.ConflictError
 *   pick()                      -> Promise<{ok, detail}>         选择/连接数据源
 *   exportDownload(format)      -> Promise<void>
 *   listBackups() / createBackup(tag) / restoreBackup(name)
 *   raw()                       -> Promise<string>               JSON 文本
 */
(function (global) {
  'use strict';

  var LS_PREFIX = 'girls_dict.';   // 只存 UI 偏好（数据源、服务地址），不存业务数据
  var IDB_NAME = 'girls_dict';
  var IDB_VERSION = 1;
  var model = global.GD.model;

  function ConflictError(currentRevision, currentDb) {
    var error = new Error('版本冲突：数据源上的 revision=' + currentRevision);
    error.name = 'ConflictError';
    error.currentRevision = currentRevision;
    error.currentDb = currentDb;
    return error;
  }

  function lsGet(key, fallback) {
    try {
      var raw = global.localStorage.getItem(LS_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) { return fallback; }
  }

  function lsSet(key, value) {
    try { global.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch (error) { /* 忽略 */ }
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function stamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /* ------------------------------------------------------------------ *
   * 1) HTTP 适配器：本地 SQLite 服务
   * ------------------------------------------------------------------ */
  function defaultHttpBase() {
    if (global.location.protocol === 'http:' || global.location.protocol === 'https:') {
      return global.location.origin;
    }
    return lsGet('httpBase', 'http://127.0.0.1:8777');
  }

  function createHttpAdapter(baseOverride) {
    var base = (baseOverride || defaultHttpBase()).replace(/\/+$/, '');
    lsSet('httpBase', base);

    function request(path, options, timeoutMs) {
      var controller = global.AbortController ? new AbortController() : null;
      var timer = null;
      var settings = Object.assign({ cache: 'no-store' }, options || {});
      if (controller) {
        settings.signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, timeoutMs || 20000);
      }
      return fetch(base + path, settings).then(function (response) {
        if (timer) clearTimeout(timer);
        return response.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (error) { data = { raw: text }; }
          return { status: response.status, data: data };
        });
      }).catch(function (error) {
        if (timer) clearTimeout(timer);
        throw new Error('连接服务失败（' + base + '）：' + error.message);
      });
    }

    function post(path, payload) {
      return request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    }

    return {
      kind: 'http',
      label: '本地服务（SQLite）',
      detail: base,
      base: function () { return base; },
      setBase: function (value) { base = String(value || '').replace(/\/+$/, ''); lsSet('httpBase', base); },
      available: function () { return !!(global.fetch); },
      status: function () {
        return request('/api/health', { method: 'GET' }, 5000).then(function (result) {
          if (result.status !== 200 || !result.data || !result.data.ok) {
            return { ok: false, canWrite: false, detail: '服务未响应（' + base + '）' };
          }
          var info = result.data;
          return {
            ok: true, canWrite: true, info: info,
            detail: info.dataFile + '　' + formatSize(info.dataFileSize) +
              '　' + info.chapters + ' 话 / ' + info.panels + ' 槽位　revision=' + info.revision,
          };
        }).catch(function (error) {
          return { ok: false, canWrite: false, detail: error.message };
        });
      },
      load: function () {
        return request('/api/db', { method: 'GET' }).then(function (result) {
          if (result.status !== 200) throw new Error((result.data && result.data.error) || '读取失败');
          return { db: result.data.db, revision: result.data.revision };
        });
      },
      /** 只拉轻量目录（话的计数与元信息），数据量大时可以先用它渲染骨架。 */
      loadIndex: function () {
        return request('/api/index', { method: 'GET' }).then(function (result) {
          if (result.status !== 200) throw new Error('读取目录失败');
          return result.data;
        });
      },
      loadChapter: function (id) {
        return request('/api/chapters/' + encodeURIComponent(id), { method: 'GET' }).then(function (result) {
          if (result.status !== 200) throw new Error('读取这一话失败');
          return result.data.chapter;
        });
      },
      stats: function () {
        return request('/api/stats', { method: 'GET' }).then(function (result) { return result.data.stats; });
      },
      findChar: function (char) {
        return request('/api/find?char=' + encodeURIComponent(char), { method: 'GET' })
          .then(function (result) { return result.data; });
      },
      search: function (text) {
        return request('/api/search?q=' + encodeURIComponent(text), { method: 'GET' })
          .then(function (result) { return result.data; });
      },
      log: function (limit) {
        return request('/api/log?limit=' + encodeURIComponent(limit || 20), { method: 'GET' })
          .then(function (result) { return result.data.log || []; });
      },
      save: function (db, revision, options) {
        var settings = options || {};
        var ops = settings.ops || [];
        var payload;
        var path;
        if (ops.length) {
          payload = { revision: revision, ops: ops, force: !!settings.force, label: settings.label || 'ui' };
          path = '/api/db/patch';
        } else {
          payload = { revision: revision, db: db, force: !!settings.force };
          path = '/api/db';
        }
        return request(path, {
          method: path === '/api/db' ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (result) {
          if (result.status === 409) throw ConflictError(result.data.revision, result.data.db);
          if (result.status !== 200) {
            throw new Error((result.data && result.data.error) || '保存失败（HTTP ' + result.status + '）');
          }
          return { revision: result.data.revision, issues: result.data.issues || [] };
        });
      },
      listBackups: function () {
        return request('/api/backups', { method: 'GET' })
          .then(function (result) { return (result.data && result.data.backups) || []; })
          .catch(function () { return []; });
      },
      createBackup: function (tag) {
        return post('/api/backups', { tag: tag || '' }).then(function (result) { return result.data; });
      },
      restoreBackup: function (name) {
        return post('/api/backups/restore', { name: name }).then(function (result) {
          if (result.status !== 200) throw new Error((result.data && result.data.error) || '回滚失败');
          return { db: result.data.db, revision: result.data.revision };
        });
      },
      exportDownload: function (format) {
        var link = document.createElement('a');
        link.href = base + '/api/db/export?format=' + encodeURIComponent(format || 'json');
        link.download = 'girls_dict.' + (format === 'csv' ? 'csv' : format === 'sqlite' ? 'sqlite3' : 'json');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return Promise.resolve();
      },
      raw: function () {
        return request('/api/db/raw', { method: 'GET' }).then(function (result) {
          return typeof result.data === 'string' ? result.data : (result.data && result.data.raw) || '';
        });
      },
      pick: function () { return Promise.resolve({ ok: true, detail: base }); },
    };
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ------------------------------------------------------------------ *
   * 2) IndexedDB 适配器：浏览器自带的数据库
   * ------------------------------------------------------------------ */
  function idbRequest(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('当前浏览器不支持 IndexedDB'));
      var request = global.indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
        if (!database.objectStoreNames.contains('chapters')) {
          var store = database.createObjectStore('chapters', { keyPath: 'id' });
          store.createIndex('by_no', 'no');
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function idbTransaction(database, stores, mode, work) {
    return new Promise(function (resolve, reject) {
      var transaction = database.transaction(stores, mode);
      var result;
      transaction.oncomplete = function () { resolve(result); };
      transaction.onerror = function () { reject(transaction.error || new Error('IndexedDB 事务出错')); };
      transaction.onabort = function () { reject(transaction.error || new Error('IndexedDB 事务被中止')); };
      Promise.resolve(work(transaction)).then(function (value) { result = value; }, function (error) {
        try { transaction.abort(); } catch (ignored) { /* 忽略 */ }
        reject(error);
      });
    });
  }

  function idbReadAll(database) {
    return idbTransaction(database, ['meta', 'chapters'], 'readonly', function (transaction) {
      return Promise.all([
        idbRequest(transaction.objectStore('meta').getAll()),
        idbRequest(transaction.objectStore('chapters').getAll()),
      ]).then(function (results) { return { meta: results[0], chapters: results[1] }; });
    });
  }

  function assembleDocument(raw) {
    var meta = { title: '超超你的字典', author: '', charMin: model.CHAR_MIN, charMax: model.CHAR_MAX, charNames: {} };
    var extra = {};
    raw.meta.forEach(function (row) { extra[row.key] = row.value; });
    if (typeof extra.title === 'string') meta.title = extra.title;
    if (typeof extra.author === 'string') meta.author = extra.author;
    if (extra.charNames && typeof extra.charNames === 'object') meta.charNames = extra.charNames;
    var chapters = raw.chapters
      .slice()
      .sort(function (a, b) { return (a.no || 0) - (b.no || 0); })
      .map(function (chapter, index) {
        return {
          id: chapter.id,
          no: index + 1,
          title: chapter.title || '',
          note: chapter.note || '',
          panels: (chapter.panels || []).map(function (panel) {
            return { id: panel.id, chars: (panel.chars || []).slice() };
          }),
        };
      });
    return {
      db: {
        schema: model.SCHEMA_NAME,
        schemaVersion: model.SCHEMA_VERSION,
        revision: Number(extra.revision || 0),
        updatedAt: extra.updated_at || null,
        meta: meta,
        chapters: chapters,
      },
      revision: Number(extra.revision || 0),
    };
  }

  function createIndexedDbAdapter() {
    var cached = null;

    function database() {
      if (cached) return Promise.resolve(cached);
      return idbOpen().then(function (opened) { cached = opened; return cached; });
    }

    /** 把补丁里提到的实体写进 IndexedDB；内容直接从当前文档取，写哪条读哪条。 */
    function writePatch(document, ops, revision) {
      var chapterById = {};
      document.chapters.forEach(function (chapter) { chapterById[chapter.id] = chapter; });
      var put = {};       // chapterId -> 新记录
      var remove = {};    // chapterId -> true
      var meta = {};      // key -> value
      var wipe = false;
      var orderChanged = false;

      (ops || []).forEach(function (op) {
        switch (op.op) {
          case 'chapter.upsert':
          case 'chapter.update':
            if (chapterById[op.chapter ? op.chapter.id : op.id]) put[op.chapter ? op.chapter.id : op.id] = true;
            break;
          case 'chapter.delete':
            remove[op.id] = true;
            break;
          case 'chapter.order':
          case 'chapter.move':
          case 'chapter.swap':
            orderChanged = true;
            break;
          case 'panel.upsert':
          case 'panel.delete':
          case 'panel.chars':
            if (op.chapterId) put[op.chapterId] = true;
            else if (op.chapter_id) put[op.chapter_id] = true;
            else {
              // 补丁里没带 chapterId：去当前文档里反查它属于哪一话
              var found = false;
              document.chapters.forEach(function (chapter) {
                if (found) return;
                if (chapter.panels.some(function (panel) { return panel.id === op.panelId || panel.id === op.id; })) {
                  put[chapter.id] = true;
                  found = true;
                }
              });
              if (!found) wipe = true;   // 查不到就整体重写，绝不丢数据
            }
            break;
          case 'meta.update':
            meta.title = op.title !== undefined ? op.title : document.meta.title;
            meta.author = op.author !== undefined ? op.author : document.meta.author;
            break;
          case 'charName.setMany':
            meta.charNames = op.names || {};
            break;
          case 'clear':
            wipe = true;
            break;
          case 'replace':
            wipe = true;
            break;
          default:
            wipe = true;   // 不认识的补丁就整体重写，宁可慢一点也不能丢数据
        }
      });

      if (wipe) {
        put = {};
        document.chapters.forEach(function (chapter) { put[chapter.id] = true; });
        meta.title = document.meta.title;
        meta.author = document.meta.author;
        meta.charNames = document.meta.charNames;
      }
      if (orderChanged) {
        document.chapters.forEach(function (chapter) { put[chapter.id] = true; });
      }
      meta.revision = revision;
      meta.updated_at = stamp();
      meta.schema_version = model.SCHEMA_VERSION;
      meta.title = document.meta.title;
      meta.author = document.meta.author;
      meta.charNames = document.meta.charNames;

      return database().then(function (db) {
        return idbTransaction(db, ['meta', 'chapters'], 'readwrite', function (transaction) {
          var store = transaction.objectStore('chapters');
          var metaStore = transaction.objectStore('meta');
          var jobs = [];
          if (wipe) jobs.push(idbRequest(store.clear()));
          Object.keys(remove).forEach(function (id) { jobs.push(idbRequest(store.delete(id))); });
          Object.keys(put).forEach(function (id) {
            var chapter = chapterById[id];
            if (!chapter) { jobs.push(idbRequest(store.delete(id))); return; }
            jobs.push(idbRequest(store.put({
              id: chapter.id, no: chapter.no, title: chapter.title || '', note: chapter.note || '',
              panels: chapter.panels.map(function (panel) {
                return { id: panel.id, chars: (panel.chars || []).slice() };
              }),
            })));
          });
          Object.keys(meta).forEach(function (key) {
            jobs.push(idbRequest(metaStore.put({ key: key, value: meta[key] })));
          });
          return Promise.all(jobs);
        });
      });
    }

    var adapter = {
      kind: 'idb',
      label: '浏览器数据库（IndexedDB）',
      detail: '存在本机浏览器里，容量按硬盘走；换浏览器/清缓存前记得导出 JSON',
      available: function () { return !!global.indexedDB; },
      status: function () {
        if (!global.indexedDB) {
          return Promise.resolve({ ok: false, canWrite: false, detail: '当前浏览器不支持 IndexedDB' });
        }
        return database().then(function (db) {
          return idbTransaction(db, ['chapters', 'meta'], 'readonly', function (transaction) {
            return Promise.all([
              idbRequest(transaction.objectStore('chapters').count()),
              idbRequest(transaction.objectStore('meta').get('revision')),
            ]).then(function (results) {
              return {
                ok: true, canWrite: true,
                detail: (results[0] || 0) + ' 话　revision=' + ((results[1] && results[1].value) || 0),
              };
            });
          });
        }).catch(function (error) {
          return { ok: false, canWrite: false, detail: error.message };
        });
      },
      pick: function () { return Promise.resolve({ ok: true, detail: 'IndexedDB' }); },
      load: function () {
        return database().then(idbReadAll).then(function (raw) {
          var assembled = assembleDocument(raw);
          var normalized = model.normalizeDb(assembled.db);
          return { db: normalized.db, revision: assembled.revision, issues: normalized.issues };
        });
      },
      save: function (db, revision, options) {
        var settings = options || {};
        return database().then(function (databaseInstance) {
          return idbTransaction(databaseInstance, ['meta'], 'readonly', function (transaction) {
            return idbRequest(transaction.objectStore('meta').get('revision'));
          }).then(function (row) {
            var current = Number((row && row.value) || 0);
            if (!settings.force && Number(revision) !== current) {
              throw ConflictError(current, null);
            }
            var next = current + 1;
            return writePatch(db, settings.ops && settings.ops.length ? settings.ops : [{ op: 'replace' }], next)
              .then(function () { return { revision: next, issues: [] }; });
          });
        });
      },
      listBackups: function () { return Promise.resolve([]); },
      createBackup: function () { return Promise.reject(new Error('浏览器数据库模式没有内置快照，请用「导出 JSON」备份')); },
      restoreBackup: function () { return Promise.reject(new Error('浏览器数据库模式没有内置快照，请用「导入 JSON」恢复')); },
      exportDownload: function (format) {
        return adapter.load().then(function (result) {
          downloadExport(result.db, format);
        });
      },
      raw: function () {
        return adapter.load().then(function (result) {
          return JSON.stringify(model.toExportDocument(result.db), null, 2) + '\n';
        });
      },
      /** 统计/查找在本地算（没有服务端 SQL，但数据都在内存里） */
      count: function () {
        return database().then(function (db) {
          return idbTransaction(db, ['chapters'], 'readonly', function (transaction) {
            return idbRequest(transaction.objectStore('chapters').count());
          });
        });
      },
    };
    return adapter;
  }

  function downloadExport(db, format) {
    var text;
    var mime;
    var name;
    if (format === 'csv') {
      text = '\ufeff' + model.toCsv(db);
      mime = 'text/csv';
      name = 'girls_dict.csv';
    } else {
      text = model.prettyJson(model.toExportDocument(db));
      mime = 'application/json';
      name = 'girls_dict.json';
    }
    download(name, text, mime);
  }

  /* ------------------------------------------------------------------ *
   * 3) JSON 文件适配器（备份/恢复）
   * ------------------------------------------------------------------ */
  function createFileAdapter() {
    var handle = null;

    function supported() {
      return typeof global.showOpenFilePicker === 'function' && typeof global.showSaveFilePicker === 'function';
    }

    function verifyPermission(target, mode) {
      var options = { mode: mode || 'readwrite' };
      if (target.queryPermission) {
        return target.queryPermission(options).then(function (state) {
          if (state === 'granted') return true;
          return target.requestPermission(options).then(function (next) { return next === 'granted'; });
        });
      }
      return Promise.resolve(true);
    }

    function readHandle(target) {
      return target.getFile().then(function (file) { return file.text(); });
    }

    function loadText(text) {
      if (!text || !text.trim()) return { db: model.defaultDb(), revision: 0, empty: true };
      var parsed = model.parseExport(text);
      return { db: parsed, revision: Number(parsed.revision || 0) };
    }

    var adapter = {
      kind: 'file',
      label: 'JSON 文件（备份）',
      detail: handle ? handle.name : '（未选择文件）',
      available: supported,
      handleName: function () { return handle ? handle.name : ''; },
      status: function () {
        if (!supported()) {
          return Promise.resolve({ ok: false, canWrite: false,
            detail: '当前浏览器不支持直接读写本地文件（建议 Chrome / Edge）' });
        }
        if (!handle) {
          return Promise.resolve({ ok: false, canWrite: false, detail: '还没有选择 JSON 文件' });
        }
        return verifyPermission(handle, 'readwrite').then(function (granted) {
          return { ok: granted, canWrite: granted, detail: handle.name + (granted ? '' : '（需要重新授权）'),
            warning: 'JSON 文件每次保存都会整份重写，数据量大时建议改用本地服务（SQLite）' };
        });
      },
      pick: function (mode) {
        if (!supported()) return Promise.reject(new Error('当前浏览器不支持直接读写本地文件'));
        var picker = mode === 'save'
          ? global.showSaveFilePicker({
            suggestedName: 'girls_dict.json',
            types: [{ description: 'girls_dict JSON', accept: { 'application/json': ['.json'] } }],
          })
          : global.showOpenFilePicker({
            multiple: false,
            types: [{ description: 'girls_dict JSON', accept: { 'application/json': ['.json'] } }],
          });
        return picker.then(function (result) {
          handle = mode === 'save' ? result : result[0];
          return { ok: true, detail: handle.name };
        });
      },
      forget: function () { handle = null; return Promise.resolve(true); },
      load: function () {
        if (!handle) return Promise.reject(new Error('还没有选择 JSON 文件'));
        return verifyPermission(handle, 'readwrite').then(function (granted) {
          if (!granted) throw new Error('没有文件读写权限');
          return readHandle(handle);
        }).then(loadText);
      },
      save: function (db, revision, options) {
        if (!handle) return Promise.reject(new Error('还没有选择 JSON 文件'));
        var payload = model.toExportDocument(db);
        payload.revision = Number(revision || 0) + 1;
        return handle.createWritable().then(function (writable) {
          return writable.write(JSON.stringify(payload, null, 2) + '\n').then(function () {
            return writable.close();
          });
        }).then(function () {
          return { revision: payload.revision, issues: [], note: 'JSON 文件为整份重写' };
        });
      },
      listBackups: function () { return Promise.resolve([]); },
      createBackup: function () { return Promise.reject(new Error('JSON 文件模式没有内置快照')); },
      restoreBackup: function () { return Promise.reject(new Error('JSON 文件模式没有内置快照，请用「导入 JSON」')); },
      exportDownload: function (format) {
        return adapter.load().then(function (result) { downloadExport(result.db, format); });
      },
      raw: function () { return readHandle(handle).catch(function () { return ''; }); },
    };
    return adapter;
  }

  var module = {
    ConflictError: ConflictError,
    createHttpAdapter: createHttpAdapter,
    createIndexedDbAdapter: createIndexedDbAdapter,
    createFileAdapter: createFileAdapter,
    download: download,
    downloadExport: downloadExport,
    formatSize: formatSize,
    lsGet: lsGet,
    lsSet: lsSet,
    defaultHttpBase: defaultHttpBase,
    /** 可选的数据源顺序：服务 > 浏览器数据库 > JSON 文件 */
    availableKinds: function () { return ['http', 'idb', 'file']; },
    create: function (kind, options) {
      if (kind === 'http') return createHttpAdapter(options && options.base);
      if (kind === 'idb') return createIndexedDbAdapter();
      return createFileAdapter();
    },
  };

  global.GD = global.GD || {};
  global.GD.adapters = module;
}(window));
