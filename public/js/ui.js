/*!
 * girls_dict · 界面渲染
 *
 * 布局思路（对应 TASK 里的建议）：
 *   · 每条“话”是一张卡片，标题栏常显；展开后出现一排“槽位”。
 *   · 选中某个槽位后，就在这张卡片内部的固定位置刷新显示该槽位的角色编号。
 *   · 角色编号用 0–100 的数字键盘点选，也可以直接输入/粘贴。
 */
(function (global) {
  'use strict';

  var model = global.GD.model;
  var store = global.GD.store;
  var adapters = global.GD.adapters;

  var els = {};
  var explicitFocus = null;
  var flashTarget = null;
  var scrollTarget = null;

  function esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function charName(db, char) {
    return ((db.meta || {}).charNames || {})[String(char)] || '';
  }

  /* ------------------------------------------------------------------ *
   * 焦点保持：重绘前记录，重绘后恢复
   * ------------------------------------------------------------------ */
  function captureFocus() {
    var active = document.activeElement;
    if (!active || !active.dataset || !active.dataset.focusId) return null;
    var snapshot = { id: active.dataset.focusId, start: null, end: null };
    if (typeof active.selectionStart === 'number') {
      snapshot.start = active.selectionStart;
      snapshot.end = active.selectionEnd;
    }
    return snapshot;
  }

  function restoreFocus(snapshot) {
    var candidates = [snapshot, explicitFocus].filter(Boolean);
    for (var i = 0; i < candidates.length; i += 1) {
      var node = document.querySelector('[data-focus-id="' + candidates[i].id + '"]');
      if (!node) continue;
      node.focus();
      if (typeof node.setSelectionRange === 'function' && candidates[i].start !== null && candidates[i].start !== undefined) {
        try { node.setSelectionRange(candidates[i].start, candidates[i].end); } catch (error) { /* number 型输入框不支持 */ }
      }
      return;
    }
  }

  function setFocus(id) { explicitFocus = { id: id, start: null, end: null }; }

  /* ------------------------------------------------------------------ *
   * 小组件
   * ------------------------------------------------------------------ */
  function toast(message, kind, timeout) {
    var box = document.getElementById('toasts');
    if (!box) return;
    var node = document.createElement('div');
    node.className = 'toast ' + (kind || 'info');
    node.textContent = message;
    box.appendChild(node);
    setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }, timeout || 2600);
  }

  var modalResolve = null;

  function closeModal(value) {
    var root = document.getElementById('modal-root');
    root.classList.add('hidden');
    root.innerHTML = '';
    if (modalResolve) { var resolve = modalResolve; modalResolve = null; resolve(value); }
  }

  /** 通用弹窗：{title, body(HTML), actions:[{label, value, kind}]} */
  function openModal(options) {
    var root = document.getElementById('modal-root');
    root.innerHTML = [
      '<div class="modal-backdrop" data-modal-close="1"></div>',
      '<div class="modal" role="dialog" aria-modal="true">',
      '<header class="modal-head"><h3>' + esc(options.title || '') + '</h3>',
      '<button class="icon-btn" data-modal-close="1" title="关闭">✕</button></header>',
      '<div class="modal-body">' + (options.body || '') + '</div>',
      '<footer class="modal-foot">',
      (options.actions || []).map(function (action, index) {
        return '<button class="btn ' + (action.kind || 'ghost') + '" data-modal-action="' + index + '">' +
          esc(action.label) + '</button>';
      }).join(''),
      '</footer></div>',
    ].join('');
    root.classList.remove('hidden');
    root.onclick = function (event) {
      var closer = event.target.closest('[data-modal-close]');
      if (closer) { closeModal(null); return; }
      var action = event.target.closest('[data-modal-action]');
      if (action) closeModal((options.actions || [])[Number(action.dataset.modalAction)].value);
    };
    return new Promise(function (resolve) { modalResolve = resolve; });
  }

  function confirmDialog(title, body, confirmLabel, kind) {
    return openModal({
      title: title,
      body: '<p>' + body + '</p>',
      actions: [
        { label: '取消', value: false, kind: 'ghost' },
        { label: confirmLabel || '确定', value: true, kind: kind || 'primary' },
      ],
    });
  }

  /* ------------------------------------------------------------------ *
   * 顶栏 / 侧栏
   * ------------------------------------------------------------------ */
  function statusText(state) {
    switch (state.status) {
      case 'loading': return '读取中…';
      case 'saving': return '保存中…';
      case 'dirty': return '待保存';
      case 'saved': return '已保存';
      case 'conflict': return '版本冲突';
      case 'error': return '出错';
      default: return '就绪';
    }
  }

  function renderTopbar(state) {
    var pill = document.getElementById('save-status');
    pill.className = 'status-pill status-' + state.status;
    pill.textContent = statusText(state);
    pill.title = state.statusMessage || '';

    document.getElementById('btn-undo').disabled = !store.canUndo();
    document.getElementById('btn-redo').disabled = !store.canRedo();

    Array.prototype.forEach.call(document.querySelectorAll('#view-tabs .tab'), function (tab) {
      tab.classList.toggle('active', tab.dataset.view === state.view);
    });

    var banner = document.getElementById('banner');
    var adapter = state.adapter;
    var kindLabel = adapter ? adapter.label : '未连接';
    var messages = [];
    if (state.status === 'error' || (state.storage && !state.storage.ok && state.adapterKind !== 'idb')) {
      messages.push('数据源不可用：' + (state.storage.detail || state.statusMessage) +
        '　可到「数据与存储」切换存储方式，或双击 start.bat 启动本地服务（SQLite）。');
    }
    if (state.adapterKind === 'idb') {
      messages.push('当前数据存在这个浏览器的 IndexedDB 里；换浏览器或清理浏览器数据前，' +
        '记得在「数据与存储」里导出 JSON 备份。');
    }
    if (state.storage && state.storage.warning) {
      messages.push(state.storage.warning);
    }
    if (state.status === 'conflict') {
      messages.push('检测到版本冲突：数据源上的内容已被其它程序修改。');
    }
    if (messages.length) {
      banner.classList.remove('hidden');
      banner.innerHTML = messages.map(function (text) {
        return '<span>' + esc(text) + '</span>';
      }).join('') + (state.status === 'conflict'
        ? '<button class="btn tiny" data-banner-act="conflict">处理冲突</button>' : '') +
        '<button class="btn tiny ghost" data-banner-act="dismiss">知道了</button>';
    } else {
      banner.classList.add('hidden');
      banner.innerHTML = '';
    }
    void kindLabel;
  }

  function renderSidebar(state) {
    var db = state.db;
    var query = (state.search || '').trim();

    /* 目录 */
    var nav = document.getElementById('chapter-nav');
    document.getElementById('nav-count').textContent = db.chapters.length + ' 话';
    if (!db.chapters.length) {
      nav.innerHTML = '<p class="muted small">还没有话，点右边「+ 新建一话」开始。</p>';
    } else {
      nav.innerHTML = db.chapters.map(function (chapter) {
        var chars = model.chapterChars(chapter);
        var active = chapter.id === state.activeChapterId ? ' active' : '';
        return '<button class="nav-item' + active + '" data-act="nav-goto" data-chapter-id="' + chapter.id + '">' +
          '<span class="nav-no">第 ' + chapter.no + ' 话</span>' +
          '<span class="nav-title">' + esc(chapter.title || '（未命名）') + '</span>' +
          '<span class="nav-meta">' + chapter.panels.length + ' 槽 / ' + chars.length + ' 角色</span>' +
          '</button>';
      }).join('');
    }

    /* 总览 */
    var stats = model.computeStats(db);
    document.getElementById('overview').innerHTML = [
      '<div class="stat"><b>' + stats.chapters + '</b><span>话</span></div>',
      '<div class="stat"><b>' + stats.panels + '</b><span>槽位</span></div>',
      '<div class="stat"><b>' + stats.distinct_chars + '</b><span>角色</span></div>',
      '<div class="stat"><b>' + stats.appearances + '</b><span>人次</span></div>',
    ].join('');

    /* 检索结果 */
    var results = document.getElementById('search-results');
    if (!query) {
      results.innerHTML = '<p class="muted small">输入 0–100 的编号，查它出现在哪些槽位；输入文字则搜标题、备注和角色名。</p>';
      return;
    }
    if (/^\d+$/.test(query)) {
      var char = Number(query);
      if (char > model.CHAR_MAX) {
        results.innerHTML = '<p class="muted small">编号超出 0–100。</p>';
        return;
      }
      var hits = model.locateChar(db, char);
      var name = charName(db, char);
      results.innerHTML = '<div class="result-title">角色 <b>' + char + '</b> ' + esc(name) +
        '　共 ' + hits.length + ' 个槽位</div>' +
        (hits.length ? hits.map(function (hit) {
          return '<button class="result" data-act="goto" data-chapter-id="' + hit.chapterId +
            '" data-panel-id="' + hit.panelId + '">第 ' + hit.chapterNo + ' 话 · 槽位 ' + hit.panelIndex + '</button>';
        }).join('') : '<p class="muted small">没有出现记录。</p>');
      return;
    }
    var lower = query.toLowerCase();
    var matched = db.chapters.filter(function (chapter) {
      if ((chapter.title || '').toLowerCase().indexOf(lower) !== -1) return true;
      return (chapter.note || '').toLowerCase().indexOf(lower) !== -1;
    });
    var nameHits = Object.keys((db.meta || {}).charNames || {}).filter(function (key) {
      return (db.meta.charNames[key] || '').toLowerCase().indexOf(lower) !== -1;
    }).map(function (key) { return { char: Number(key), name: db.meta.charNames[key] }; });

    results.innerHTML = (matched.length ? '<div class="result-title">匹配的话</div>' + matched.map(function (chapter) {
      return '<button class="result" data-act="goto" data-chapter-id="' + chapter.id + '">第 ' + chapter.no +
        ' 话　' + esc(chapter.title || '（未命名）') + '</button>';
    }).join('') : '') + (nameHits.length ? '<div class="result-title">匹配的角色名</div>' + nameHits.map(function (hit) {
      return '<button class="result" data-act="goto-char" data-char="' + hit.char + '">' + hit.char + '　' + esc(hit.name) + '</button>';
    }).join('') : '') + (!matched.length && !nameHits.length ? '<p class="muted small">没有匹配结果。</p>' : '');
  }

  /* ------------------------------------------------------------------ *
   * 录入视图
   * ------------------------------------------------------------------ */
  function keypadOpen(state, panelId) {
    return state.keypadOpen[panelId] !== false;
  }

  function renderKeypad(state, panel) {
    var db = state.db;
    var cells = [];
    for (var n = model.CHAR_MIN; n <= model.CHAR_MAX; n += 1) {
      var selected = panel.chars.indexOf(n) !== -1;
      var name = charName(db, n);
      cells.push('<button class="key' + (selected ? ' on' : '') + '" data-act="key" data-char="' + n +
        '" data-nofocus="1" title="' + esc(name ? n + ' · ' + name : String(n)) + '">' + n + '</button>');
    }
    return '<div class="keypad">' + cells.join('') + '</div>';
  }

  function renderPanelEditor(state, chapter, panel) {
    var db = state.db;
    if (!panel) {
      return '<div class="editor empty"><p class="muted">这一话还没有槽位。</p>' +
        '<button class="btn primary" data-act="add-panel" data-nofocus="1">+ 新建槽位</button></div>';
    }
    var index = chapter.panels.indexOf(panel);
    var clip = state.clipboard || [];
    var chips = panel.chars.map(function (char) {
      var name = charName(db, char);
      return '<span class="chip"><b>' + char + '</b>' + (name ? '<i>' + esc(name) + '</i>' : '') +
        '<button data-act="remove-char" data-char="' + char + '" data-nofocus="1" title="移除">×</button></span>';
    }).join('');
    return [
      '<div class="editor">',
      '<div class="editor-head">',
      '<strong>槽位 ' + (index + 1) + '</strong>',
      '<span class="muted small">' + panel.chars.length + ' 个角色</span>',
      '<div class="editor-actions">',
      '<button class="btn tiny" data-act="panel-insert" data-nofocus="1" title="在这个槽位后面插入新槽位">插入槽位</button>',
      '<button class="btn tiny" data-act="panel-copy" data-nofocus="1" title="复制本槽位编号">复制</button>',
      '<button class="btn tiny" data-act="panel-paste" data-nofocus="1"' + (clip.length ? '' : ' disabled') +
      ' title="粘贴到本槽位">粘贴(' + clip.length + ')</button>',
      '<button class="btn tiny" data-act="panel-clear" data-nofocus="1"' + (panel.chars.length ? '' : ' disabled') + '>清空</button>',
      '<button class="btn tiny danger" data-act="panel-del" data-nofocus="1">删除槽位</button>',
      '</div></div>',
      '<div class="chips">' + (chips || '<span class="muted small">还没有角色：点下面的数字键盘，或直接输入编号。</span>') + '</div>',
      '<div class="quick">',
      '<input class="quick-input" data-focus-id="quick-' + panel.id + '" data-quick="1" ' +
      'placeholder="输入编号后回车 / 空格 / 逗号，可一次粘贴 “1 5 23”">',
      '<button class="btn tiny" data-act="quick-commit" data-nofocus="1">添加</button>',
      '<label class="check"><input type="checkbox" data-act="toggle-keypad" data-nofocus="1"' +
      (keypadOpen(state, panel.id) ? ' checked' : '') + '> 数字键盘</label>',
      '</div>',
      keypadOpen(state, panel.id) ? renderKeypad(state, panel) : '',
      '</div>',
    ].join('');
  }

  function renderChapter(state, chapter) {
    var db = state.db;
    var open = !!state.openIds[chapter.id];
    var chars = model.chapterChars(chapter);
    var appearances = chapter.panels.reduce(function (sum, panel) { return sum + panel.chars.length; }, 0);
    var activePanelId = state.panelOf[chapter.id];
    var activePanel = model.findPanel(chapter, activePanelId) || chapter.panels[0];
    if (activePanel && activePanelId !== activePanel.id) state.panelOf[chapter.id] = activePanel.id;

    var strip = chapter.panels.map(function (panel, index) {
      var active = activePanel && panel.id === activePanel.id;
      return '<div class="panel-chip' + (active ? ' active' : '') + '" data-act="select-panel" data-panel-id="' +
        panel.id + '" data-nofocus="1" title="槽位 ' + (index + 1) + '：' + (panel.chars.join('、') || '空') + '">' +
        '<span class="idx">' + (index + 1) + '</span>' +
        '<span class="cnt">' + panel.chars.length + '</span>' +
        '<button class="chip-del" data-act="del-panel" data-panel-id="' + panel.id + '" data-nofocus="1" title="删除该槽位">×</button>' +
        '</div>';
    }).join('');

    return [
      '<article class="chapter' + (open ? ' open' : '') + (state.swapPick === chapter.id ? ' swap-pick' : '') +
      (flashTarget === chapter.id ? ' flash' : '') + '" data-chapter-id="' + chapter.id + '">',
      '<header class="chapter-head">',
      '<span class="grip" draggable="true" title="按住拖动可以调整顺序">⠿</span>',
      '<button class="expander" data-act="toggle-chapter" data-nofocus="1">',
      '<span class="chev">' + (open ? '▾' : '▸') + '</span>',
      '<span class="no">第 ' + chapter.no + ' 话</span>',
      '</button>',
      '<input class="title-input" data-field="title" data-focus-id="title-' + chapter.id + '" value="' +
      esc(chapter.title) + '" placeholder="标题（可选）">',
      '<span class="badges">',
      '<span class="badge">' + chapter.panels.length + ' 槽位</span>',
      '<span class="badge">' + chars.length + ' 角色</span>',
      '<span class="badge">' + appearances + ' 人次</span>',
      '</span>',
      '<div class="head-actions">',
      '<button class="icon-btn" data-act="up" data-nofocus="1" title="上移一话">↑</button>',
      '<button class="icon-btn" data-act="down" data-nofocus="1" title="下移一话">↓</button>',
      '<button class="btn tiny' + (state.swapPick === chapter.id ? ' primary' : '') +
      '" data-act="swap" data-nofocus="1" title="与另一话对换顺序并自动修正编号">对换</button>',
      '<button class="icon-btn" data-act="dup" data-nofocus="1" title="复制这一话">⧉</button>',
      '<button class="icon-btn danger" data-act="del" data-nofocus="1" title="删除这一话">✕</button>',
      '</div>',
      '</header>',
      open ? [
        '<div class="chapter-body">',
        '<div class="panel-strip">',
        '<span class="strip-label">分镜</span>',
        strip,
        '<button class="panel-add" data-act="add-panel" data-nofocus="1" title="在末尾新增一个槽位">+ 槽位</button>',
        '</div>',
        renderPanelEditor(state, chapter, activePanel),
        '<div class="chapter-foot">',
        '<input class="note-input" data-field="note" data-focus-id="note-' + chapter.id + '" value="' +
        esc(chapter.note) + '" placeholder="这一话的备注（可选）">',
        '</div>',
        '</div>',
      ].join('') : '',
      '</article>',
    ].join('');
  }

  function renderEntry(state) {
    var db = state.db;
    var hint = state.swapPick
      ? '对换模式：已选中「第 ' + (model.findChapter(db, state.swapPick) || {}).no + ' 话」，再点另一话的「对换」即可互换，编号会自动修正。'
      : '点标题栏展开某一话 → 选槽位 → 用数字键盘或输入框录入角色编号。';
    return [
      '<div class="entry-head">',
      '<button class="btn primary" data-act="new-chapter" data-nofocus="1">+ 新建一话</button>',
      '<button class="btn tiny" data-act="expand-all" data-nofocus="1">展开全部</button>',
      '<button class="btn tiny" data-act="collapse-all" data-nofocus="1">收起全部</button>',
      '<span class="muted small grow-text">' + esc(hint) + '</span>',
      '</div>',
      db.chapters.length ? '<div class="chapter-list">' + db.chapters.map(function (chapter) {
        return renderChapter(state, chapter);
      }).join('') + '</div>' : [
        '<div class="empty-state">',
        '<h2>还没有任何记录</h2>',
        '<p>每一话 = 一条记录，记录里可以放任意多个槽位 = 分镜，每个槽位里填出场角色编号（0–100）。</p>',
        '<button class="btn primary big" data-act="new-chapter" data-nofocus="1">+ 新建第 1 话</button>',
        '</div>',
      ].join(''),
    ].join('');
  }

  /* ------------------------------------------------------------------ *
   * 角色字典视图
   * ------------------------------------------------------------------ */
  function renderDict(state) {
    var db = state.db;
    var stats = model.computeStats(db);
    var counts = {};
    stats.characters.forEach(function (row) { counts[row.char] = row.panels; });
    var numbers = {};
    model.allChars(db).forEach(function (char) { numbers[char] = true; });
    Object.keys((db.meta || {}).charNames || {}).forEach(function (key) { numbers[Number(key)] = true; });
    var list = Object.keys(numbers).map(Number).sort(function (a, b) { return a - b; });
    var filter = (state.dictFilter || '').trim();

    if (filter) {
      list = list.filter(function (char) {
        var name = charName(db, char);
        return String(char).indexOf(filter) !== -1 || name.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
      });
    }

    var rows = list.map(function (char) {
      var hits = model.locateChar(db, char);
      var places = hits.slice(0, 24).map(function (hit) {
        return '<button class="place" data-act="goto" data-chapter-id="' + hit.chapterId + '" data-panel-id="' +
          hit.panelId + '" title="跳到该槽位">' + hit.chapterNo + '-' + hit.panelIndex + '</button>';
      }).join('');
      return '<tr>' +
        '<td class="num">' + char + '</td>' +
        '<td><input class="name-input" data-char="' + char + '" data-focus-id="name-' + char + '" value="' +
        esc(charName(db, char)) + '" placeholder="（未命名）"></td>' +
        '<td class="num">' + (counts[char] || 0) + '</td>' +
        '<td class="places">' + (places || '<span class="muted small">未出场</span>') +
        (hits.length > 24 ? '<span class="muted small">…共 ' + hits.length + ' 处</span>' : '') + '</td>' +
        '</tr>';
    }).join('');

    return [
      '<div class="view-head">',
      '<h2>角色字典</h2>',
      '<p class="muted small">编号 → 角色名。名字只用于显示和检索，数据库里始终记录编号本身；编号 0–100。</p>',
      '<input id="dict-filter" class="dict-filter" data-focus-id="dict-filter" placeholder="筛选编号或名字" value="' + esc(state.dictFilter || '') + '">',
      '</div>',
      '<table class="dict-table"><thead><tr><th>编号</th><th>角色名</th><th>出场分镜</th><th>出现位置（话-槽位）</th></tr></thead>',
      '<tbody>' + (rows || '<tr><td colspan="4" class="muted">还没有记录。先去「录入」添加话和槽位吧。</td></tr>') + '</tbody></table>',
    ].join('');
  }

  /* ------------------------------------------------------------------ *
   * 数据与存储视图
   * ------------------------------------------------------------------ */
  function renderStorageCard(state) {
    var kinds = [
      { kind: 'http', title: '本地服务（SQLite，推荐）',
        desc: '数据库是 data/girls_dict.sqlite3。改一个编号只写一行，数据再多也不会整份重写；支持自动快照与 SQL 查询。' },
      { kind: 'idb', title: '浏览器数据库（IndexedDB）',
        desc: '不用装任何东西，浏览器自带数据库，每个话一条记录、改哪条写哪条。' },
      { kind: 'file', title: 'JSON 文件（备份）',
        desc: '直接读写一个 .json 文件，适合备份/恢复；每次保存都会整份重写，数据量大时不如前两种。' },
    ];
    var current = state.adapter || { label: '未连接', detail: '' };
    var info = (state.storage && state.storage.info) || {};
    var lines = ['<section class="card">', '<h3>数据源</h3>'];
    lines.push('<p class="muted small">当前：<b>' + esc(current.label) + '</b>　' + esc(current.detail || '') + '</p>');
    lines.push('<p class="muted small">' + esc(state.storage.detail || '') + '</p>');
    if (info.storage) {
      lines.push('<div class="kv">' +
        '<span>存储引擎</span><b>' + esc(info.storage) + ' v' + esc(info.storageVersion) + '</b>' +
        '<span>数据库文件</span><b>' + esc(info.dataFile) + '</b>' +
        '<span>文件大小</span><b>' + esc(adapters.formatSize(info.dataFileSize)) + '</b>' +
        '<span>内容</span><b>' + info.chapters + ' 话 / ' + info.panels + ' 槽位</b>' +
        '<span>备份目录</span><b>' + esc(info.backupDir) + '</b>' +
        '</div>');
    }
    lines.push('<div class="adapter-grid">' + kinds.map(function (item) {
      var supported = adapters.create(item.kind).available();
      return '<label class="adapter' + (state.adapterKind === item.kind ? ' current' : '') +
        (supported ? '' : ' disabled') + '">' +
        '<input type="radio" name="adapter" data-act="use-adapter" value="' + item.kind + '"' +
        (state.adapterKind === item.kind ? ' checked' : '') + (supported ? '' : ' disabled') + '>' +
        '<span class="adapter-title">' + item.title + (supported ? '' : '（不支持）') + '</span>' +
        '<span class="adapter-desc">' + item.desc + '</span>' +
        '</label>';
    }).join('') + '</div>');
    lines.push('<div class="row">' +
      '<label class="field"><span>服务地址</span><input id="http-base" data-focus-id="http-base" value="' +
      esc(adapters.lsGet('httpBase', adapters.defaultHttpBase())) + '" placeholder="http://127.0.0.1:8777"></label>' +
      '<button class="btn tiny" data-act="connect-http" data-nofocus="1">连接服务</button>' +
      '<button class="btn tiny" data-act="pick-file" data-nofocus="1">打开 JSON 文件</button>' +
      '<button class="btn tiny" data-act="new-file" data-nofocus="1">另存为…</button>' +
      '<button class="btn tiny" data-act="reload" data-nofocus="1">从数据源重新载入</button>' +
      '</div></section>');
    return lines.join('');
  }

  function renderDataCard(state) {
    var db = state.db;
    return [
      '<section class="card">',
      '<h3>导出 / 导入</h3>',
      '<p class="muted small">仅支持 schemaVersion=2 的无内部 id JSON；导入会严格校验并整库替换当前数据。</p>',
      '<div class="row">',
      '<button class="btn" data-act="export-json" data-nofocus="1">导出 JSON</button>',
      '<button class="btn" data-act="export-csv" data-nofocus="1">导出 CSV</button>',
      (state.adapterKind === 'http'
        ? '<button class="btn" data-act="export-sqlite" data-nofocus="1">下载 SQLite 数据库</button>' : ''),
      '<button class="btn" data-act="import-json" data-nofocus="1">导入 JSON（整库替换）</button>',
      '<button class="btn" data-act="copy-json" data-nofocus="1">复制 JSON 到剪贴板</button>',
      '<input id="import-file" type="file" accept=".json,application/json" class="hidden">',
      '</div>',
      '</section>',
      '<section class="card">',
      '<h3>元信息</h3>',
      '<div class="row">',
      '<label class="field"><span>作品名</span><input data-field="meta-title" data-focus-id="meta-title" value="' +
      esc((db.meta || {}).title || '') + '"></label>',
      '<label class="field"><span>录入者</span><input data-field="meta-author" data-focus-id="meta-author" value="' +
      esc((db.meta || {}).author || '') + '"></label>',
      '</div>',
      '</section>',
      '<section class="card">',
      '<h3>快照与恢复</h3>',
      '<p class="muted small">本地服务模式下，每次写入前会自动留一份 SQLite 快照' +
      '（默认 10 分钟一份，最多 20 份，秒级完成且不影响正在进行的录入）。</p>',
      '<div class="row"><button class="btn" data-act="backup-now" data-nofocus="1">立即创建快照</button>' +
      '<button class="btn tiny" data-act="refresh-backups" data-nofocus="1">刷新列表</button>' +
      '<button class="btn tiny" data-act="load-log" data-nofocus="1">最近改动</button></div>',
      '<div id="backup-list" class="backup-list"><p class="muted small">点“刷新列表”查看快照。</p></div>',
      '</section>',
      '<section class="card danger-zone">',
      '<h3>危险操作</h3>',
      '<div class="row"><button class="btn danger" data-act="clear-all" data-nofocus="1">清空全部数据</button></div>',
      '</section>',
    ].join('');
  }

  function renderData(state) {
    return '<div class="view-head"><h2>数据与存储</h2>' +
      '<p class="muted small">数据存在 SQLite（或浏览器 IndexedDB）里；JSON 用于导入、导出和备份。</p></div>' +
      renderStorageCard(state) + renderDataCard(state);
  }

  /* ------------------------------------------------------------------ *
   * 总渲染
   * ------------------------------------------------------------------ */
  function render() {
    var state = store.state;
    var snapshot = captureFocus();

    els.viewEntry.classList.toggle('hidden', state.view !== 'entry');
    els.viewDict.classList.toggle('hidden', state.view !== 'dict');
    els.viewData.classList.toggle('hidden', state.view !== 'data');

    if (state.view === 'entry') els.viewEntry.innerHTML = renderEntry(state);
    if (state.view === 'dict') els.viewDict.innerHTML = renderDict(state);
    if (state.view === 'data') els.viewData.innerHTML = renderData(state);

    renderTopbar(state);
    renderSidebar(state);

    /* 悬浮的「+」只在录入视图出现 */
    if (els.quickNew) els.quickNew.classList.toggle('hidden', state.view !== 'entry');

    restoreFocus(snapshot);

    /* 新建/跳转后把目标话滚进视野（列表很长时尤其重要） */
    if (scrollTarget) {
      var node = document.querySelector('[data-chapter-id="' + scrollTarget + '"]');
      if (node && node.scrollIntoView) {
        try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (error) { node.scrollIntoView(); }
      }
      scrollTarget = null;
    }

    explicitFocus = null;
    flashTarget = null;
  }

  var scheduled = false;

  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    global.requestAnimationFrame(function () {
      scheduled = false;
      render();
    });
  }

  function flashChapter(chapterId) {
    flashTarget = chapterId;
  }

  /** 下一次渲染后把某一话滚动到视野中间（并高亮一下）。 */
  function scrollToChapter(chapterId) {
    scrollTarget = chapterId;
    flashTarget = chapterId;
  }

  function init() {
    els.viewEntry = document.getElementById('view-entry');
    els.viewDict = document.getElementById('view-dict');
    els.viewData = document.getElementById('view-data');
    els.quickNew = document.getElementById('btn-quick-new');
  }

  global.GD.ui = {
    init: init,
    render: render,
    scheduleRender: scheduleRender,
    toast: toast,
    openModal: openModal,
    closeModal: closeModal,
    confirm: confirmDialog,
    setFocus: setFocus,
    flashChapter: flashChapter,
    scrollToChapter: scrollToChapter,
    esc: esc,
  };
}(window));
