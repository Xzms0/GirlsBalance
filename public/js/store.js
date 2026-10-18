/*!
 * girls_dict · 状态仓库
 *
 * 负责：当前数据库、当前存储适配器、撤销/重做、防抖自动保存、保存状态。
 * UI 只调用这里的方法，不直接碰适配器。
 */
(function (global) {
  'use strict';

  var model = global.GD.model;
  var adapters = global.GD.adapters;

  var HISTORY_LIMIT = 80;
  var AUTOSAVE_DELAY = 600;

  var state = {
    db: model.defaultDb(),
    revision: 0,
    issues: [],
    saved: null,              // 上次保存成功时的指纹，用来算增量补丁
    lastLabel: 'ui',

    adapterKind: 'idb',
    adapter: null,
    storage: { ok: false, canWrite: false, detail: '未连接' },
    legacyMigration: null,

    status: 'idle',           // idle | loading | dirty | saving | saved | error | conflict
    statusMessage: '未连接数据源',

    view: 'entry',            // entry | dict | data
    openIds: {},              // 展开了哪些话
    activeChapterId: null,
    panelOf: {},              // 话 id -> 当前选中的槽位 id
    swapPick: null,           // “对换顺序”模式下先点的那一话
    search: '',
    dictFilter: '',
    keypadOpen: {},           // 槽位 id -> 数字键盘是否展开（默认展开）
    clipboard: [],
    history: [],
    future: [],
    ready: false,
  };

  var listeners = [];
  var saveTimer = null;
  var saving = false;
  var lastCoalesce = { key: null, at: 0 };
  var focusSnapshot = null;

  function on(handler) {
    listeners.push(handler);
    return function off() { listeners = listeners.filter(function (h) { return h !== handler; }); };
  }

  function emit() {
    listeners.forEach(function (handler) {
      try { handler(state); } catch (error) { console.error(error); }
    });
  }

  function patch(changes) {
    Object.keys(changes).forEach(function (key) { state[key] = changes[key]; });
    emit();
  }

  function setStatus(status, message) {
    patch({ status: status, statusMessage: message || '' });
  }

  /* ------------------------------------------------------------------ *
   * 撤销 / 重做
   * ------------------------------------------------------------------ */
  function pushHistory(label, coalesceKey) {
    var now = Date.now();
    var coalesce = coalesceKey && lastCoalesce.key === coalesceKey && (now - lastCoalesce.at) < 1200;
    lastCoalesce = { key: coalesceKey || null, at: now };
    if (coalesce) return;
    state.history.push({ db: JSON.stringify(state.db), label: label || '修改', at: now });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.future = [];
  }

  /** 所有数据改动都走这里：自动快照 + 标记脏数据 + 触发自动保存。 */
  function mutate(mutator, options) {
    var opts = options || {};
    var draft = model.clone(state.db);
    mutator(draft, state);
    model.renumber(draft);
    pushHistory(opts.label, opts.coalesce);
    state.db = draft;
    state.issues = [];
    state.lastLabel = opts.label || '修改';
    scheduleSave();
    patch({ status: 'dirty', statusMessage: '有改动待保存' });
  }

  function restore(snapshot) {
    state.db = JSON.parse(snapshot);
    scheduleSave();
    patch({ status: 'dirty', statusMessage: '已撤销' });
  }

  function undo() {
    if (!state.history.length) return false;
    var entry = state.history.pop();
    state.future.push({ db: JSON.stringify(state.db), label: entry.label });
    restore(entry.db);
    return true;
  }

  function redo() {
    if (!state.future.length) return false;
    var entry = state.future.pop();
    state.history.push({ db: JSON.stringify(state.db), label: entry.label });
    restore(entry.db);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 保存
   * ------------------------------------------------------------------ */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveNow(false); }, AUTOSAVE_DELAY);
  }

  function saveNow(force) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!state.adapter || !state.ready) return Promise.resolve(false);
    if (saving) return Promise.resolve(false);

    var patch = model.buildPatch(state.db, state.saved);
    if (patch.empty && !force) {
      setStatus('saved', '已是最新');
      return Promise.resolve(true);
    }

    saving = true;
    setStatus('saving', patch.ops.length === 1 && patch.ops[0].op === 'replace'
      ? '保存中…（整库）'
      : '保存中…（' + patch.ops.length + ' 项改动）');
    return state.adapter.save(state.db, state.revision, {
      force: !!force,
      ops: patch.ops,
      label: state.lastLabel || 'ui',
    }).then(function (result) {
      saving = false;
      state.revision = Number(result.revision || state.revision);
      state.db.revision = state.revision;
      state.issues = result.issues || [];
      state.saved = patch.saved;
      setStatus('saved', '已保存 ' + new Date().toLocaleTimeString() +
        (result.note ? '（' + result.note + '）' : ''));
      return true;
    }).catch(function (error) {
      saving = false;
      if (error && error.name === 'ConflictError') {
        patch({
          status: 'conflict',
          statusMessage: '版本冲突：数据源已被其它程序修改',
          conflict: { revision: error.currentRevision, db: error.currentDb },
        });
        return false;
      }
      setStatus('error', error && error.message ? error.message : '保存失败');
      return false;
    });
  }

  /* ------------------------------------------------------------------ *
   * 装载 / 切换数据源
   * ------------------------------------------------------------------ */
  function applyLoaded(result, options) {
    var normalized = model.normalizeDb(result.db);
    state.db = normalized.db;
    state.revision = Number(result.revision || normalized.db.revision || 0);
    state.issues = (result.issues || []).concat(normalized.issues || []);
    state.history = [];
    state.future = [];
    state.openIds = {};
    state.panelOf = {};
    state.activeChapterId = state.db.chapters.length ? state.db.chapters[0].id : null;
    state.swapPick = null;
    state.ready = true;
    state.db.revision = state.revision;
    state.saved = model.fingerprints(state.db);
    setStatus('saved', (options && options.message) || '已载入数据');
  }

  function loadFromAdapter(options) {
    if (!state.adapter) return Promise.resolve(false);
    setStatus('loading', '读取数据中…');
    return state.adapter.load().then(function (result) {
      applyLoaded(result, options);
      return true;
    }).catch(function (error) {
      state.ready = false;
      setStatus('error', error && error.message ? error.message : '读取失败');
      return false;
    });
  }

  function refreshStorageStatus() {
    if (!state.adapter || !state.adapter.status) return Promise.resolve(state.storage);
    return state.adapter.status().then(function (status) {
      state.storage = status;
      emit();
      return status;
    });
  }

  /** 切换存储方式；返回是否连通。 */
  function useAdapter(kind, options) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var adapter = adapters.create(kind, options);
    state.adapterKind = kind;
    state.adapter = adapter;
    state.ready = false;
    adapters.lsSet('adapterKind', kind);
    state.storage = { ok: false, canWrite: false, detail: '连接中…' };
    emit();
    return refreshStorageStatus().then(function (status) {
      if (!status.ok) {
        setStatus('error', status.detail || '数据源不可用');
        return false;
      }
      return loadFromAdapter().then(function (ok) { return ok; });
    });
  }

  /** 把旧版「浏览器缓存（localStorage）」里的数据搬进 IndexedDB（原键保留不删）。 */
  function migrateLegacyLocalStorage() {
    if (state.adapterKind !== 'idb' || !state.ready) return Promise.resolve(null);
    if ((state.db.chapters || []).length) return Promise.resolve(null);
    var legacy = adapters.readLegacyLocalStorage();
    if (!legacy) return Promise.resolve(null);
    // 直接替换内存里的文档：与「空库」的指纹一比，自然会产生 chapter.upsert 系列补丁
    // （带 id，服务端会原样保留），不需要退回整库替换。
    state.db = legacy.db;
    state.issues = [];
    state.legacyMigration = { chapters: legacy.chapters, panels: legacy.panels };
    scheduleSave();
    return saveNow(false).then(function (ok) {
      if (!ok) { state.legacyMigration = null; return null; }
      return state.legacyMigration;
    });
  }

  /** 启动：优先用上次的选择，其次按当前地址猜测（服务 > 浏览器数据库 > JSON 文件）。 */
  function boot() {
    var preferred = adapters.lsGet('adapterKind', null);
    var protocol = global.location.protocol;
    var order = ['http', 'idb', 'file'];
    var candidates;
    if (preferred) {
      candidates = [preferred].concat(order.filter(function (kind) { return kind !== preferred; }));
    } else if (protocol === 'http:' || protocol === 'https:') {
      candidates = order;
    } else {
      candidates = order;
    }
    var index = 0;
    function tryNext() {
      if (index >= candidates.length) return useAdapter('idb');
      var kind = candidates[index];
      index += 1;
      var adapter = adapters.create(kind);
      if (adapter.available && !adapter.available()) return tryNext();
      state.adapter = adapter;
      state.adapterKind = kind;
      return adapter.status().then(function (status) {
        if (!status.ok) return tryNext();
        state.storage = status;
        return loadFromAdapter().then(function (ok) {
          if (!ok) return tryNext();
          adapters.lsSet('adapterKind', kind);
          return migrateLegacyLocalStorage();
        });
      }).catch(function () { return tryNext(); });
    }
    return tryNext();
  }

  /* ------------------------------------------------------------------ *
   * 便捷数据操作（供 UI 调用）
   * ------------------------------------------------------------------ */
  var actions = {
    addChapter: function () {
      var created = null;
      mutate(function (db) {
        var chapter = model.newChapter(db.chapters.length + 1, '');
        chapter.panels = [model.newPanel()];
        // 新记录固定追加到最末尾，不插在当前选中话后面
        db.chapters.push(chapter);
        created = chapter;
      }, { label: '新增一话' });
      if (created) {
        // 折叠其它所有话，只展开新建的这一话
        state.openIds = {};
        state.openIds[created.id] = true;
        state.activeChapterId = created.id;
        state.panelOf[created.id] = created.panels[0] ? created.panels[0].id : null;
        emit();
      }
      return created;
    },
    duplicateChapter: function (chapterId) {
      mutate(function (db) {
        var index = model.indexOfChapter(db, chapterId);
        if (index < 0) return;
        var source = db.chapters[index];
        var copy = JSON.parse(JSON.stringify(source));
        copy.id = model.newId('ch');
        copy.title = (source.title || '') + '（副本）';
        copy.panels = copy.panels.map(function (panel) {
          panel.id = model.newId('pn');
          return panel;
        });
        db.chapters.splice(index + 1, 0, copy);
      }, { label: '复制一话' });
    },
    deleteChapter: function (chapterId) {
      mutate(function (db) {
        var index = model.indexOfChapter(db, chapterId);
        if (index >= 0) db.chapters.splice(index, 1);
      }, { label: '删除一话' });
      delete state.openIds[chapterId];
      delete state.panelOf[chapterId];
      if (state.activeChapterId === chapterId) {
        state.activeChapterId = state.db.chapters.length ? state.db.chapters[0].id : null;
      }
      emit();
    },
    moveChapter: function (chapterId, delta) {
      mutate(function (db) {
        var index = model.indexOfChapter(db, chapterId);
        model.moveChapter(db, index, index + delta);
      }, { label: '调整顺序' });
    },
    moveChapterTo: function (chapterId, targetIndex) {
      mutate(function (db) {
        var index = model.indexOfChapter(db, chapterId);
        model.moveChapter(db, index, targetIndex);
      }, { label: '拖动排序' });
    },
    swapChapters: function (idA, idB) {
      mutate(function (db) {
        model.swapChapters(db, model.indexOfChapter(db, idA), model.indexOfChapter(db, idB));
      }, { label: '对换话顺序' });
      state.swapPick = null;
      emit();
    },
    setChapterField: function (chapterId, field, value) {
      mutate(function (db) {
        var chapter = model.findChapter(db, chapterId);
        if (chapter) chapter[field] = value;
      }, { label: '修改话信息', coalesce: 'chapter-' + field + '-' + chapterId });
    },
    addPanel: function (chapterId, afterPanelId) {
      var created = null;
      mutate(function (db) {
        var chapter = model.findChapter(db, chapterId);
        if (!chapter) return;
        var panel = model.newPanel();
        created = panel;
        if (!afterPanelId) { chapter.panels.push(panel); return; }
        var index = chapter.panels.findIndex(function (item) { return item.id === afterPanelId; });
        chapter.panels.splice(index < 0 ? chapter.panels.length : index + 1, 0, panel);
      }, { label: '新增槽位' });
      if (created) state.panelOf[chapterId] = created.id;
      emit();
      return created;
    },
    deletePanel: function (chapterId, panelId) {
      mutate(function (db) {
        var chapter = model.findChapter(db, chapterId);
        if (!chapter) return;
        var index = chapter.panels.findIndex(function (item) { return item.id === panelId; });
        if (index < 0) return;
        chapter.panels.splice(index, 1);
        var next = chapter.panels[Math.min(index, chapter.panels.length - 1)];
        state.panelOf[chapterId] = next ? next.id : null;
      }, { label: '删除槽位' });
      emit();
    },
    setPanelChars: function (chapterId, panelId, chars, options) {
      mutate(function (db) {
        var chapter = model.findChapter(db, chapterId);
        var panel = chapter && model.findPanel(chapter, panelId);
        if (panel) panel.chars = model.cleanChars(chars).chars;
      }, options || { label: '录入角色' });
    },
    addChar: function (chapterId, panelId, char) {
      var chapter = model.findChapter(state.db, chapterId);
      var panel = chapter && model.findPanel(chapter, panelId);
      if (!panel || panel.chars.indexOf(char) !== -1) return false;
      actions.setPanelChars(chapterId, panelId, panel.chars.concat([char]), { label: '添加角色 ' + char });
      return true;
    },
    removeChar: function (chapterId, panelId, char) {
      var chapter = model.findChapter(state.db, chapterId);
      var panel = chapter && model.findPanel(chapter, panelId);
      if (!panel || panel.chars.indexOf(char) === -1) return false;
      actions.setPanelChars(chapterId, panelId,
        panel.chars.filter(function (item) { return item !== char; }), { label: '移除角色 ' + char });
      return true;
    },
    toggleChar: function (chapterId, panelId, char) {
      var chapter = model.findChapter(state.db, chapterId);
      var panel = chapter && model.findPanel(chapter, panelId);
      if (!panel) return;
      if (panel.chars.indexOf(char) !== -1) actions.removeChar(chapterId, panelId, char);
      else actions.addChar(chapterId, panelId, char);
    },
    setCharName: function (char, name) {
      mutate(function (db) {
        if (name) db.meta.charNames[String(char)] = name;
        else delete db.meta.charNames[String(char)];
      }, { label: '修改角色名', coalesce: 'name-' + char });
    },
    setMeta: function (field, value) {
      mutate(function (db) { db.meta[field] = value; }, { label: '修改元信息', coalesce: 'meta-' + field });
    },
    replaceWholeDb: function (newDb, label) {
      mutate(function (db) {
        var normalized = model.normalizeDb(newDb).db;
        db.meta = normalized.meta;
        db.chapters = normalized.chapters;
      }, { label: label || '导入数据' });
    },
    clearAll: function () {
      mutate(function (db) {
        db.chapters = [];
        db.meta.charNames = {};
      }, { label: '清空全部数据' });
      state.openIds = {};
      state.panelOf = {};
      state.activeChapterId = null;
    },
  };

  global.GD.store = {
    state: state,
    on: on,
    emit: emit,
    patch: patch,
    setStatus: setStatus,
    mutate: mutate,
    actions: actions,
    undo: undo,
    redo: redo,
    canUndo: function () { return state.history.length > 0; },
    canRedo: function () { return state.future.length > 0; },
    saveNow: saveNow,
    scheduleSave: scheduleSave,
    loadFromAdapter: loadFromAdapter,
    useAdapter: useAdapter,
    refreshStorageStatus: refreshStorageStatus,
    migrateLegacyLocalStorage: migrateLegacyLocalStorage,
    boot: boot,
    setFocusSnapshot: function (snapshot) { focusSnapshot = snapshot; },
    getFocusSnapshot: function () { return focusSnapshot; },
  };
}(window));
