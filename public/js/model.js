/*!
 * girls_dict · 数据模型（纯函数，无 DOM 依赖）
 *
 * 与 server/girls_db.py、server/db.js 的规则完全一致：
 * 编号范围 [0,100]，同一槽位内去重、升序，话编号 = 数组下标 + 1。
 * 这个文件可以被任何网页/小程序直接复用。
 */
(function (global) {
  'use strict';

  var CHAR_MIN = 0;
  var CHAR_MAX = 100;
  var SCHEMA_NAME = 'girls_dict';
  var SCHEMA_VERSION = 2;

  function newId(prefix) {
    var bytes = new Uint8Array(4);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    var hex = '';
    for (var j = 0; j < bytes.length; j += 1) hex += ('0' + bytes[j].toString(16)).slice(-2);
    return prefix + '-' + hex;
  }

  function defaultDb(title) {
    return {
      schema: SCHEMA_NAME,
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      updatedAt: null,
      meta: {
        title: title || '超超你的字典',
        author: '',
        charMin: CHAR_MIN,
        charMax: CHAR_MAX,
        charNames: {},
      },
      chapters: [],
    };
  }

  function newChapter(no, title) {
    return { id: newId('ch'), no: Number(no) || 1, title: title || '', note: '', panels: [] };
  }

  function newPanel(chars) {
    return { id: newId('pn'), chars: cleanChars(chars).chars };
  }

  function issue(bucket, level, path, message) {
    if (bucket) bucket.push({ level: level, path: path, message: message });
  }

  /** 整理成 [0,100] 去重升序的整数数组；返回 {chars, issues}。 */
  function cleanChars(raw, bucket, where) {
    var out = [];
    var seen = {};
    var list = raw;
    if (list === null || list === undefined) return { chars: out, issues: bucket || [] };
    if (Object.prototype.toString.call(list) !== '[object Array]') list = [list];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      var value = null;
      if (typeof item === 'boolean') value = null;
      else if (typeof item === 'number' && isFinite(item) && Math.floor(item) === item) value = item;
      else if (typeof item === 'string' && /^[+-]?\d+$/.test(item.trim())) value = parseInt(item.trim(), 10);
      if (value === null) {
        issue(bucket, 'error', where || '', '无法识别的角色编号：' + JSON.stringify(item));
        continue;
      }
      if (value < CHAR_MIN || value > CHAR_MAX) {
        issue(bucket, 'error', where || '', '角色编号超出 [' + CHAR_MIN + ',' + CHAR_MAX + ']：' + value);
        continue;
      }
      if (seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    out.sort(function (a, b) { return a - b; });
    return { chars: out, issues: bucket || [] };
  }

  /** 解析用户输入的一串编号（空格/逗号/顿号/分号分隔），返回 {ok, chars, bad}。 */
  function parseInput(text) {
    var parts = String(text || '').split(/[\s,，、;；|]+/).filter(function (t) { return t !== ''; });
    var chars = [];
    var bad = [];
    for (var i = 0; i < parts.length; i += 1) {
      var token = parts[i];
      if (!/^[+-]?\d+$/.test(token)) { bad.push(token); continue; }
      var value = parseInt(token, 10);
      if (value < CHAR_MIN || value > CHAR_MAX) { bad.push(token); continue; }
      if (chars.indexOf(value) === -1) chars.push(value);
    }
    chars.sort(function (a, b) { return a - b; });
    return { ok: bad.length === 0, chars: chars, bad: bad };
  }

  /** 把任意对象整理成合法数据库，返回 {db, issues}。 */
  function normalizeDb(input, title) {
    var issues = [];
    if (!input || typeof input !== 'object' || Object.prototype.toString.call(input) === '[object Array]') {
      issue(issues, 'error', '$', '顶层不是 JSON 对象，已重置为空库');
      return { db: defaultDb(title), issues: issues };
    }
    if (input.schema !== SCHEMA_NAME || input.schemaVersion !== SCHEMA_VERSION) {
      throw new Error('数据库必须使用 schema="girls_dict"、schemaVersion=2');
    }
    var out = defaultDb(title);
    var metaIn = input.meta;
    if (metaIn && typeof metaIn === 'object' && Object.prototype.toString.call(metaIn) !== '[object Array]') {
      if (typeof metaIn.title === 'string') out.meta.title = metaIn.title;
      if (typeof metaIn.author === 'string') out.meta.author = metaIn.author;
      if (metaIn.charNames && typeof metaIn.charNames === 'object') {
        var names = {};
        Object.keys(metaIn.charNames).forEach(function (key) {
          var number = parseInt(String(key).trim(), 10);
          if (!isFinite(number)) {
            issue(issues, 'warn', 'meta.charNames', '忽略非法角色编号键：' + key);
            return;
          }
          if (number >= CHAR_MIN && number <= CHAR_MAX && typeof metaIn.charNames[key] === 'string') {
            names[String(number)] = metaIn.charNames[key];
          }
        });
        out.meta.charNames = names;
      } else if (metaIn.charNames !== undefined) {
        issue(issues, 'warn', 'meta.charNames', 'charNames 不是对象，已重置');
      }
    } else if (metaIn !== undefined) {
      issue(issues, 'warn', 'meta', 'meta 不是对象，已重置');
    }
    out.revision = (isFinite(input.revision) && input.revision >= 0) ? Math.floor(input.revision) : 0;
    out.updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : null;

    var chaptersIn = input.chapters;
    if (chaptersIn === undefined || chaptersIn === null) chaptersIn = [];
    if (Object.prototype.toString.call(chaptersIn) !== '[object Array]') {
      issue(issues, 'error', 'chapters', 'chapters 不是数组，已重置为空');
      chaptersIn = [];
    }
    var seenIds = {};
    out.chapters = [];
    for (var ci = 0; ci < chaptersIn.length; ci += 1) {
      var rawChapter = chaptersIn[ci];
      var where = 'chapters[' + ci + ']';
      if (!rawChapter || typeof rawChapter !== 'object' || Object.prototype.toString.call(rawChapter) === '[object Array]') {
        issue(issues, 'error', where, '话记录不是对象，已丢弃');
        continue;
      }
      var chapter = {};
      Object.keys(rawChapter).forEach(function (k) { chapter[k] = rawChapter[k]; });
      var cid = chapter.id;
      if (typeof cid !== 'string' || !cid || seenIds[cid]) {
        cid = newId('ch');
        issue(issues, 'warn', where + '.id', 'id 缺失或重复，已重新生成');
      }
      seenIds[cid] = true;
      chapter.id = cid;
      if (chapter.no !== undefined && chapter.no !== ci + 1) {
        issue(issues, 'warn', where + '.no', '话编号 ' + JSON.stringify(chapter.no) + ' 与顺序不一致，已修正为 ' + (ci + 1));
      }
      chapter.no = ci + 1;
      chapter.title = typeof chapter.title === 'string' ? chapter.title : '';
      chapter.note = typeof chapter.note === 'string' ? chapter.note : '';

      var panelsIn = chapter.panels;
      if (panelsIn === undefined || panelsIn === null) panelsIn = [];
      if (Object.prototype.toString.call(panelsIn) !== '[object Array]') {
        issue(issues, 'error', where + '.panels', 'panels 不是数组，已重置为空');
        panelsIn = [];
      }
      chapter.panels = [];
      for (var pi = 0; pi < panelsIn.length; pi += 1) {
        var rawPanel = panelsIn[pi];
        var pwhere = where + '.panels[' + pi + ']';
        if (!rawPanel || typeof rawPanel !== 'object' || Object.prototype.toString.call(rawPanel) === '[object Array]') {
          issue(issues, 'error', pwhere, '槽位不是对象，已丢弃');
          continue;
        }
        var panel = {};
        Object.keys(rawPanel).forEach(function (k) { panel[k] = rawPanel[k]; });
        var pid = panel.id;
        if (typeof pid !== 'string' || !pid || seenIds[pid]) {
          pid = newId('pn');
          issue(issues, 'warn', pwhere + '.id', 'id 缺失或重复，已重新生成');
        }
        seenIds[pid] = true;
        panel.id = pid;
        panel.chars = cleanChars(panel.chars, issues, pwhere + '.chars').chars;
        chapter.panels.push(panel);
      }
      out.chapters.push(chapter);
    }
    return { db: out, issues: issues };
  }

  function validateDb(input) {
    return normalizeDb(JSON.parse(JSON.stringify(input))).issues;
  }

  function renumber(db) {
    (db.chapters || []).forEach(function (chapter, index) { chapter.no = index + 1; });
    return db;
  }

  function findChapter(db, id) {
    var list = (db && db.chapters) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
    return null;
  }

  function findPanel(chapter, id) {
    var list = (chapter && chapter.panels) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
    return null;
  }

  function indexOfChapter(db, id) {
    var list = (db && db.chapters) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return i;
    return -1;
  }

  function moveChapter(db, from, to) {
    var list = db.chapters || [];
    if (from < 0 || from >= list.length) return db;
    var target = Math.max(0, Math.min(list.length - 1, to));
    var moved = list.splice(from, 1)[0];
    list.splice(target, 0, moved);
    return renumber(db);
  }

  function swapChapters(db, indexA, indexB) {
    var list = db.chapters || [];
    if (indexA === indexB || indexA < 0 || indexB < 0 || indexA >= list.length || indexB >= list.length) return db;
    var tmp = list[indexA];
    list[indexA] = list[indexB];
    list[indexB] = tmp;
    return renumber(db);
  }

  function chapterChars(chapter) {
    var set = {};
    (chapter.panels || []).forEach(function (panel) {
      (panel.chars || []).forEach(function (char) { set[char] = true; });
    });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  function allChars(db) {
    var set = {};
    (db.chapters || []).forEach(function (chapter) {
      (chapter.panels || []).forEach(function (panel) {
        (panel.chars || []).forEach(function (char) { set[char] = true; });
      });
    });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  /** 角色 -> 出现位置列表，用于“查角色去哪了”。 */
  function locateChar(db, char) {
    var hits = [];
    (db.chapters || []).forEach(function (chapter) {
      (chapter.panels || []).forEach(function (panel, index) {
        if ((panel.chars || []).indexOf(char) !== -1) {
          hits.push({ chapterId: chapter.id, chapterNo: chapter.no, panelId: panel.id, panelIndex: index + 1 });
        }
      });
    });
    return hits;
  }

  function computeStats(db) {
    var counts = {};
    var panels = 0;
    (db.chapters || []).forEach(function (chapter) {
      (chapter.panels || []).forEach(function (panel) {
        panels += 1;
        (panel.chars || []).forEach(function (char) { counts[char] = (counts[char] || 0) + 1; });
      });
    });
    var names = (db.meta || {}).charNames || {};
    var characters = Object.keys(counts).map(Number).sort(function (a, b) {
      return counts[b] - counts[a] || a - b;
    }).map(function (char) {
      return { char: char, name: names[String(char)] || '', panels: counts[char] };
    });
    var appearances = characters.reduce(function (sum, row) { return sum + row.panels; }, 0);
    return {
      chapters: (db.chapters || []).length,
      panels: panels,
      distinct_chars: characters.length,
      appearances: appearances,
      characters: characters,
    };
  }

  function flatRows(db) {
    var rows = [];
    (db.chapters || []).forEach(function (chapter) {
      (chapter.panels || []).forEach(function (panel, index) {
        (panel.chars || []).forEach(function (char) {
          rows.push({
            chapter_no: chapter.no,
            chapter_title: chapter.title || '',
            panel_index: index + 1,
            char: char,
            char_name: ((db.meta || {}).charNames || {})[String(char)] || '',
          });
        });
      });
    });
    return rows;
  }

  function toCsv(db) {
    var columns = [];
    for (var char = CHAR_MIN; char <= CHAR_MAX; char += 1) columns.push(char);
    var lines = ['话-分镜,' + columns.join(',')];
    (db.chapters || []).forEach(function (chapter) {
      (chapter.panels || []).forEach(function (panel, index) {
        var present = {};
        (panel.chars || []).forEach(function (item) { present[item] = true; });
        lines.push((chapter.no + '-' + (index + 1)) + ',' + columns.map(function (item) {
          return present[item] ? 1 : 0;
        }).join(','));
      });
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* 紧凑 JSON：数组和小分镜对象保持一行，避免每个编号占一行。 */
  var JSON_MAX_INLINE = 200;

  function compactJson(value) {
    return JSON.stringify(value);
  }

  function formatJson(value, level) {
    var indent = new Array(level + 1).join('  ');
    var child = new Array(level + 2).join('  ');
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      if (value.every(function (item) { return item === null || typeof item !== 'object'; })) {
        return '[' + value.map(compactJson).join(', ') + ']';
      }
      var inline = compactJson(value);
      if (inline && inline.length <= JSON_MAX_INLINE) return inline;
      return '[\n' + value.map(function (item) {
        return child + formatJson(item, level + 1);
      }).join(',\n') + '\n' + indent + ']';
    }
    if (value && typeof value === 'object') {
      var keys = Object.keys(value);
      if (!keys.length) return '{}';
      var objectInline = compactJson(value);
      if (objectInline && objectInline.length <= JSON_MAX_INLINE) return objectInline;
      return '{\n' + keys.map(function (key) {
        return child + JSON.stringify(key) + ': ' + formatJson(value[key], level + 1);
      }).join(',\n') + '\n' + indent + '}';
    }
    return compactJson(value);
  }

  function prettyJson(value) {
    return formatJson(value, 0) + '\n';
  }

  function clone(db) {
    return JSON.parse(JSON.stringify(db));
  }

  /* ------------------------------------------------------------------ *
   * 增量保存：把「当前文档」和「上次保存成功时的指纹」做对比，只生成变化的操作。
   *
   * 这样每敲一个编号就只发一条 panel.chars，而不是把整本书重发一遍；
   * 撤销/重做、导入、清空也都走同一条路（它们同样只是让文档发生了变化）。
   * ------------------------------------------------------------------ */
  function metaKey(db) {
    var meta = db.meta || {};
    return JSON.stringify([meta.title || '', meta.author || '']);
  }

  function namesKey(db) {
    var names = (db.meta || {}).charNames || {};
    return JSON.stringify(Object.keys(names).sort().map(function (key) { return [key, names[key]]; }));
  }

  function orderKey(db) {
    return (db.chapters || []).map(function (chapter) { return chapter.id; }).join(',');
  }

  function chapterKey(chapter) {
    return JSON.stringify([chapter.title || '', chapter.note || '']);
  }

  function panelKey(panel) {
    return (panel.chars || []).join(',');
  }

  /** 记录「上次成功保存时」的样子，供 buildPatch 比对。 */
  function fingerprints(db) {
    var saved = { meta: metaKey(db), names: namesKey(db), order: orderKey(db), chapters: {}, panels: {}, panelChapter: {} };
    (db.chapters || []).forEach(function (chapter) {
      saved.chapters[chapter.id] = chapterKey(chapter);
      (chapter.panels || []).forEach(function (panel) {
        saved.panels[panel.id] = panelKey(panel);
        saved.panelChapter[panel.id] = chapter.id;
      });
    });
    return saved;
  }

  /** 生成补丁：{ops, saved, empty}。saved 是保存成功后应当记下的新指纹。 */
  function buildPatch(db, saved) {
    var previous = saved || null;
    var next = fingerprints(db);
    var ops = [];
    if (!previous) {
      // 没有基线（例如刚切换数据源）：整库替换，最稳。
      // 注意这里用带 id 的内部文档，这样服务端会保留同一批 id，
      // 后续的增量补丁才找得到目标（导出给别的程序时才去掉 id）。
      return { ops: [{ op: 'replace', db: clone(db) }], saved: next, empty: false };
    }

    var currentChapters = {};
    (db.chapters || []).forEach(function (chapter) { currentChapters[chapter.id] = chapter; });

    /* 1. 先删：已经不存在的槽位、已经不存在的话 */
    Object.keys(previous.panels || {}).forEach(function (panelId) {
      if (next.panels[panelId] !== undefined) return;
      var chapterId = (previous.panelChapter || {})[panelId];
      if (chapterId && !currentChapters[chapterId]) return;   // 整话被删，级联即可
      ops.push({ op: 'panel.delete', id: panelId, chapterId: chapterId || null });
    });
    Object.keys(previous.chapters || {}).forEach(function (chapterId) {
      if (!currentChapters[chapterId]) ops.push({ op: 'chapter.delete', id: chapterId });
    });

    /* 2. 再增改 */
    (db.chapters || []).forEach(function (chapter) {
      var known = (previous.chapters || {})[chapter.id];
      if (known === undefined) {
        // 新的一话：连同它的槽位一起 upsert，不必再逐槽位补一条
        ops.push({
          op: 'chapter.upsert',
          chapter: { id: chapter.id, title: chapter.title || '', note: chapter.note || '' },
          panels: (chapter.panels || []).map(function (panel) {
            return { id: panel.id, chars: (panel.chars || []).slice() };
          }),
        });
        return;
      }
      if (known !== chapterKey(chapter)) {
        ops.push({ op: 'chapter.update', id: chapter.id, title: chapter.title || '', note: chapter.note || '' });
      }
      (chapter.panels || []).forEach(function (panel, index) {
        var knownPanel = (previous.panels || {})[panel.id];
        if (knownPanel === undefined) {
          ops.push({
            op: 'panel.upsert',
            chapterId: chapter.id,
            panel: { id: panel.id, chars: (panel.chars || []).slice() },
            position: index + 1,
          });
        } else if (knownPanel !== panelKey(panel)) {
          ops.push({ op: 'panel.chars', panelId: panel.id, chapterId: chapter.id, chars: (panel.chars || []).slice() });
        }
      });
    });

    /* 3. 顺序（话编号） */
    if (previous.order !== next.order) {
      ops.push({ op: 'chapter.order', ids: (db.chapters || []).map(function (chapter) { return chapter.id; }) });
    }

    /* 4. 元信息与角色名 */
    if (previous.names !== next.names) {
      ops.push({ op: 'charName.setMany', names: clone((db.meta || {}).charNames || {}) });
    }
    if (previous.meta !== next.meta) {
      ops.push({
        op: 'meta.update',
        title: (db.meta || {}).title || '超超你的字典',
        author: (db.meta || {}).author || '',
      });
    }
    return { ops: ops, saved: next, empty: ops.length === 0 };
  }

  /** 导出格式：话、标题、备注和每个槽位的角色编号。 */
  function toExportDocument(db) {
    return {
      schema: SCHEMA_NAME,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      meta: {
        title: ((db.meta || {}).title) || '超超你的字典',
        author: ((db.meta || {}).author) || '',
        charMin: CHAR_MIN,
        charMax: CHAR_MAX,
        charNames: clone((db.meta || {}).charNames || {}),
      },
      chapters: (db.chapters || []).map(function (chapter, index) {
        return {
          no: index + 1,
          title: chapter.title || '',
          note: chapter.note || '',
          panels: (chapter.panels || []).map(function (panel) {
            return { chars: (panel.chars || []).slice() };
          }),
        };
      }),
    };
  }

  /** 外部交换文档严格校验：不修复、不接受内部实体字段。 */
  function validateExportDocument(payload) {
    function fail(path, message) { throw new Error(path + '：' + message); }
    function object(value, path, required, optional) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象');
      required.forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path + '.' + key, '缺少必需字段');
      });
      Object.keys(value).forEach(function (key) {
        if (required.indexOf(key) === -1 && (optional || []).indexOf(key) === -1) fail(path + '.' + key, '未知字段');
      });
    }
    function string(value, path) { if (typeof value !== 'string') fail(path, '必须是字符串'); }
    function integer(value) { return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && Math.abs(value) <= 9007199254740991; }
    object(payload, '$', ['schema', 'schemaVersion', 'meta', 'chapters'], ['exportedAt', 'revision']);
    if (payload.schema !== SCHEMA_NAME) fail('schema', '必须是 girls_dict');
    if (payload.schemaVersion !== SCHEMA_VERSION) fail('schemaVersion', '必须是 2');
    if (payload.exportedAt !== undefined && payload.exportedAt !== null) string(payload.exportedAt, 'exportedAt');
    if (payload.revision !== undefined && (!integer(payload.revision) || payload.revision < 0)) fail('revision', '必须是非负整数');
    object(payload.meta, 'meta', ['title', 'author', 'charMin', 'charMax', 'charNames']);
    string(payload.meta.title, 'meta.title');
    string(payload.meta.author, 'meta.author');
    if (payload.meta.charMin !== CHAR_MIN || payload.meta.charMax !== CHAR_MAX) fail('meta', '编号范围必须是 0..100');
    var names = payload.meta.charNames;
    if (!names || typeof names !== 'object' || Array.isArray(names)) fail('meta.charNames', '必须是对象');
    Object.keys(names).forEach(function (key) {
      if (!/^(0|[1-9]\d?|100)$/.test(key)) fail('meta.charNames.' + key, '编号键必须是规范的 0..100');
      string(names[key], 'meta.charNames.' + key);
    });
    if (!Array.isArray(payload.chapters)) fail('chapters', '必须是数组');
    payload.chapters.forEach(function (chapter, ci) {
      var where = 'chapters[' + ci + ']';
      object(chapter, where, ['no', 'title', 'note', 'panels']);
      if (chapter.no !== ci + 1) fail(where + '.no', '必须等于数组位置 + 1');
      string(chapter.title, where + '.title');
      string(chapter.note, where + '.note');
      if (!Array.isArray(chapter.panels)) fail(where + '.panels', '必须是数组');
      chapter.panels.forEach(function (panel, pi) {
        var pwhere = where + '.panels[' + pi + ']';
        object(panel, pwhere, ['chars']);
        if (!Array.isArray(panel.chars)) fail(pwhere + '.chars', '必须是数组');
        panel.chars.forEach(function (char, index) {
          if (!integer(char) || char < CHAR_MIN || char > CHAR_MAX || (index > 0 && char <= panel.chars[index - 1])) {
            fail(pwhere + '.chars', '编号必须是 0..100 的唯一升序整数');
          }
        });
      });
    });
    return payload;
  }

  function parseExport(text) {
    var payload = validateExportDocument(JSON.parse(text));
    return normalizeDb(payload).db;
  }

  global.GD = global.GD || {};
  global.GD.model = {
    CHAR_MIN: CHAR_MIN,
    CHAR_MAX: CHAR_MAX,
    SCHEMA_NAME: SCHEMA_NAME,
    SCHEMA_VERSION: SCHEMA_VERSION,
    newId: newId,
    defaultDb: defaultDb,
    newChapter: newChapter,
    newPanel: newPanel,
    cleanChars: cleanChars,
    parseInput: parseInput,
    normalizeDb: normalizeDb,
    validateDb: validateDb,
    renumber: renumber,
    findChapter: findChapter,
    findPanel: findPanel,
    indexOfChapter: indexOfChapter,
    moveChapter: moveChapter,
    swapChapters: swapChapters,
    chapterChars: chapterChars,
    allChars: allChars,
    locateChar: locateChar,
    computeStats: computeStats,
    flatRows: flatRows,
    toCsv: toCsv,
    prettyJson: prettyJson,
    clone: clone,
    fingerprints: fingerprints,
    buildPatch: buildPatch,
    toExportDocument: toExportDocument,
    validateExportDocument: validateExportDocument,
    parseExport: parseExport,
  };
}(window));
