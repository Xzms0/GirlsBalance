/*!
 * girls_dict · 交互与引导
 *
 * 负责：事件绑定、快捷键、导入导出、数据源操作、帮助弹窗、启动流程。
 */
(function (global) {
  'use strict';

  var model = global.GD.model;
  var store = global.GD.store;
  var ui = global.GD.ui;
  var adapters = global.GD.adapters;

  var dragState = null;

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  function activeChapter() {
    var state = store.state;
    var id = state.activeChapterId;
    var chapter = id ? model.findChapter(state.db, id) : null;
    if (chapter) return chapter;
    return state.db.chapters[0] || null;
  }

  function activePanel(chapter) {
    var state = store.state;
    if (!chapter) return null;
    return model.findPanel(chapter, state.panelOf[chapter.id]) || chapter.panels[0] || null;
  }

  function openChapter(chapterId, options) {
    var state = store.state;
    state.openIds[chapterId] = true;
    state.activeChapterId = chapterId;
    if (options && options.panelId) state.panelOf[chapterId] = options.panelId;
    if (options && options.focusQuick) {
      var panelId = state.panelOf[chapterId];
      if (panelId) ui.setFocus('quick-' + panelId);
    }
  }

  function commitQuickInput(input) {
    var chapter = activeChapter();
    var panel = activePanel(chapter);
    if (!chapter || !panel || !input) return;
    var text = input.value;
    if (!text.trim()) return;
    var parsed = model.parseInput(text);
    if (parsed.bad.length) {
      ui.toast('这些不是 0–100 的编号，已忽略：' + parsed.bad.join(' '), 'warn');
    }
    var merged = panel.chars.concat(parsed.chars);
    var before = panel.chars.length;
    store.actions.setPanelChars(chapter.id, panel.id, merged, { label: '录入角色' });
    input.value = '';
    ui.setFocus('quick-' + panel.id);
    var added = model.cleanChars(merged).chars.length - before;
    if (added > 0) ui.toast('已添加 ' + added + ' 个角色编号', 'ok');
  }

  function exportData(format) {
    var db = store.state.db;
    var text;
    var name;
    var mime;
    if (format === 'csv') {
      text = model.toCsv(db);
      name = 'girls_dict.csv';
      mime = 'text/csv';
    } else if (format === 'md') {
      text = model.toMarkdown(db);
      name = 'girls_dict.md';
      mime = 'text/markdown';
    } else {
      // 交换格式：不含任何内部 id
      text = JSON.stringify(model.toExportDocument(db), null, 2) + '\n';
      name = 'girls_dict.json';
      mime = 'application/json';
    }
    adapters.download(name, text, mime);
    ui.toast('已导出 ' + name + (format === 'json' ? '（不含 id）' : ''), 'ok');
  }

  function importJsonText(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      ui.toast('不是合法 JSON：' + error.message, 'error');
      return;
    }
    var issues = model.validateDb(parsed);
    var errors = issues.filter(function (item) { return item.level === 'error'; });
    var body = '<p>将用文件内容整库替换当前数据（当前 ' + store.state.db.chapters.length +
      ' 话 → 文件 ' + (((parsed || {}).chapters || []).length) + ' 话）。</p>';
    if (errors.length) {
      body += '<p class="warn-text">检测到 ' + errors.length + ' 处问题，导入时会自动修正：</p><ul class="issues">' +
        errors.slice(0, 8).map(function (item) {
          return '<li>' + ui.esc(item.path) + '：' + ui.esc(item.message) + '</li>';
        }).join('') + '</ul>';
    }
    ui.confirm('确认导入？', body, '导入并替换', 'primary').then(function (ok) {
      if (!ok) return;
      store.actions.replaceWholeDb(parsed, '导入 JSON');
      ui.toast('导入完成', 'ok');
    });
  }

  /** 有未保存改动时先问一句，避免切数据源/重新载入把当前内容冲掉。 */
  function confirmDiscard(message) {
    var status = store.state.status;
    if (status !== 'dirty' && status !== 'saving' && status !== 'conflict') return Promise.resolve(true);
    return ui.confirm('有未保存的改动', message, '继续', 'danger');
  }

  function showHelp() {
    ui.openModal({
      title: '使用说明',
      body: [
        '<h4>三步上手</h4>',
        '<ol class="help-list">',
        '<li><b>新建一话</b>：一话 = 一条记录，自动从 1 开始编号。</li>',
        '<li><b>加槽位</b>：展开这一话后点「+ 槽位」，一个槽位 = 一个分镜。</li>',
        '<li><b>填编号</b>：选中槽位后用 0–100 数字键盘点选，或在输入框里打字/粘贴（如 <code>1 5 23</code>），回车或空格即添加。</li>',
        '</ol>',
        '<h4>编号与顺序</h4>',
        '<ul class="help-list">',
        '<li>同一槽位里同一个编号只会保留一次，并自动从小到大排序。</li>',
        '<li>用 ↑ ↓ 或按住左侧 ⠿ 拖动可以调整话的顺序；点「对换」再点另一话的「对换」可以直接互换位置。</li>',
        '<li>无论怎么调整，话编号都会自动重排为 1…N，不会出现重复或跳号。</li>',
        '</ul>',
        '<h4>数据存在哪</h4>',
        '<ul class="help-list">',
        '<li><b>本地服务（推荐）</b>：数据库是 <code>data/girls_dict.sqlite3</code>，' +
        '改一个编号只写一行，数据多了也不会整份重写；写入前自动留快照，还能用 SQL 查询。</li>',
        '<li><b>浏览器数据库</b>：不装任何东西也能用，数据存在浏览器自带的 IndexedDB 里（容量按硬盘走）。</li>',
        '<li><b>JSON 文件</b>：整份读写的交换格式，适合和别的程序交换或做备份，数据量大时不如前两种。</li>',
        '<li>导出的 JSON <b>不含内部 id</b>，只有话号、标题、备注和每个槽位的角色编号。</li>',
        '</ul>',
        '<h4>发布到公开站</h4>',
        '<ul class="help-list">',
        '<li>点右上角「发布」：先保存 SQLite，再把数据导出到 <code>docs/data/</code> 并 commit / push。</li>',
        '<li>公开站是纯静态只读页，GitHub Pages 的发布源设为 <code>main</code> / <code>/docs</code>。</li>',
        '<li>发布需要本机 Git 仓库、<code>origin</code> 和 <code>user.name</code> / <code>user.email</code>；首次先把整个仓库提交一次。</li>',
        '</ul>',
        '<h4>快捷键</h4>',
        '<table class="keys"><tbody>',
        '<tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>立即保存</td></tr>',
        '<tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd></td><td>撤销 / 重做</td></tr>',
        '<tr><td><kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd></td><td>把当前话上移 / 下移</td></tr>',
        '<tr><td><kbd>[</kbd> / <kbd>]</kbd></td><td>切换上一个 / 下一个槽位</td></tr>',
        '<tr><td><kbd>Esc</kbd></td><td>关闭弹窗 / 取消对换</td></tr>',
        '</tbody></table>',
      ].join(''),
      actions: [{ label: '知道了', value: true, kind: 'primary' }],
    });
  }

  function showConflictDialog() {
    var conflict = store.state.conflict || {};
    ui.openModal({
      title: '版本冲突',
      body: '<p>数据源上的内容已经被其它程序改动（磁盘 revision=' + (conflict.revision) +
        '，本页 revision=' + store.state.revision + '）。</p>' +
        '<p>选择处理方式：</p><ul class="help-list">' +
        '<li><b>用本页覆盖</b>：以当前浏览器里的内容为准写回（磁盘上的版本会被覆盖，但服务端仍留快照）。</li>' +
        '<li><b>放弃本页改动</b>：重新从数据源读取最新内容。</li>' +
        '<li><b>导出本页</b>：先把本页数据下载成 JSON，再决定怎么合并。</li></ul>',
      actions: [
        { label: '稍后再说', value: 'later', kind: 'ghost' },
        { label: '导出本页 JSON', value: 'export', kind: 'ghost' },
        { label: '放弃本页改动，重新载入', value: 'reload', kind: 'ghost' },
        { label: '用本页覆盖', value: 'force', kind: 'danger' },
      ],
    }).then(function (choice) {
      if (choice === 'force') {
        store.saveNow(true).then(function (ok) {
          if (ok) ui.toast('已用本页内容覆盖数据源', 'ok');
        });
      } else if (choice === 'reload') {
        store.loadFromAdapter({ message: '已重新载入数据源内容' }).then(function (ok) {
          if (ok) ui.toast('已重新载入', 'ok');
        });
      } else if (choice === 'export') {
        exportData('json');
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 事件：点击
   * ------------------------------------------------------------------ */
  function handleAction(event, action, node) {
    var state = store.state;
    var chapterNode = node.closest('[data-chapter-id]');
    var chapterId = chapterNode ? chapterNode.dataset.chapterId : state.activeChapterId;
    var chapter = chapterId ? model.findChapter(state.db, chapterId) : null;
    var panelId = node.dataset.panelId || (chapter ? state.panelOf[chapter.id] : null);
    var panel = null;
    if (chapter) {
      panel = (panelId ? model.findPanel(chapter, panelId) : null) ||
        model.findPanel(chapter, state.panelOf[chapter.id]) || chapter.panels[0] || null;
      if (panel) panelId = panel.id;
    }

    switch (action) {
      /* 视图 */
      case 'view': return;
      /* 话 */
      case 'new-chapter': {
        var after = state.activeChapterId;
        var created = store.actions.addChapter(after);
        ui.toast('已新建第 ' + created.no + ' 话' + (after ? '（插在第 ' + model.findChapter(state.db, after).no + ' 话后面）' : ''),
          'ok');
        ui.scrollToChapter(created.id);      // 列表很长时也要能立刻看到它
        ui.setFocus('title-' + created.id);
        return;
      }
      case 'expand-all':
        state.db.chapters.forEach(function (item) { state.openIds[item.id] = true; });
        return store.emit();
      case 'collapse-all':
        state.openIds = {};
        return store.emit();
      case 'toggle-chapter':
        state.openIds[chapterId] = !state.openIds[chapterId];
        state.activeChapterId = chapterId;
        if (state.openIds[chapterId] && !state.panelOf[chapterId] && chapter.panels.length) {
          state.panelOf[chapterId] = chapter.panels[0].id;
        }
        return store.emit();
      case 'up':
        store.actions.moveChapter(chapterId, -1);
        state.activeChapterId = chapterId;
        return store.emit();
      case 'down':
        store.actions.moveChapter(chapterId, 1);
        state.activeChapterId = chapterId;
        return store.emit();
      case 'swap':
        if (!state.swapPick) {
          state.swapPick = chapterId;
          state.activeChapterId = chapterId;
          ui.toast('已选中第 ' + chapter.no + ' 话，再点另一话的「对换」完成交换', 'info');
          return store.emit();
        }
        if (state.swapPick === chapterId) { state.swapPick = null; return store.emit(); }
        var first = model.findChapter(state.db, state.swapPick);
        store.actions.swapChapters(state.swapPick, chapterId);
        ui.toast('已对换第 ' + (first ? first.no : '?') + ' 话与第 ' + chapter.no + ' 话，编号已修正', 'ok');
        return;
      case 'dup':
        store.actions.duplicateChapter(chapterId);
        ui.toast('已复制这一话', 'ok');
        return;
      case 'del':
        ui.confirm('删除这一话？', '第 ' + chapter.no + ' 话' + (chapter.title ? '「' + ui.esc(chapter.title) + '」' : '') +
          '（' + chapter.panels.length + ' 个槽位）将被删除，后面的编号会自动前移。可用 Ctrl+Z 撤销。', '删除', 'danger')
          .then(function (ok) { if (ok) store.actions.deleteChapter(chapterId); });
        return;

      /* 槽位 */
      case 'select-panel':
        state.panelOf[chapterId] = panelId;
        state.activeChapterId = chapterId;
        ui.setFocus('quick-' + panelId);
        return store.emit();
      case 'add-panel': {
        var made = store.actions.addPanel(chapterId);
        state.activeChapterId = chapterId;
        ui.setFocus('quick-' + made.id);
        ui.toast('已新增槽位', 'ok');
        return;
      }
      case 'panel-insert': {
        var inserted = store.actions.addPanel(chapterId, panel.id);
        ui.setFocus('quick-' + inserted.id);
        return;
      }
      case 'del-panel':
        store.actions.deletePanel(chapterId, panelId);
        ui.toast('已删除槽位', 'info');
        return;
      case 'panel-clear':
        store.actions.setPanelChars(chapterId, panel.id, [], { label: '清空槽位' });
        ui.setFocus('quick-' + panel.id);
        return;
      case 'panel-copy':
        state.clipboard = panel.chars.slice();
        ui.toast('已复制 ' + panel.chars.length + ' 个编号到剪贴板', 'ok');
        return store.emit();
      case 'panel-paste':
        if (!state.clipboard.length) return;
        store.actions.setPanelChars(chapterId, panel.id, panel.chars.concat(state.clipboard), { label: '粘贴到槽位' });
        ui.toast('已粘贴 ' + state.clipboard.length + ' 个编号', 'ok');
        return;
      case 'key': {
        var char = Number(node.dataset.char);
        store.actions.toggleChar(chapterId, panel.id, char);
        ui.setFocus('quick-' + panel.id);
        return;
      }
      case 'remove-char':
        store.actions.removeChar(chapterId, panel.id, Number(node.dataset.char));
        ui.setFocus('quick-' + panel.id);
        return;
      case 'quick-commit': {
        var input = document.querySelector('[data-focus-id="quick-' + panel.id + '"]');
        commitQuickInput(input);
        return;
      }

      /* 侧栏检索 */
      case 'nav-goto': {
        openChapter(chapterId, { focusQuick: true });
        ui.flashChapter(chapterId);
        return store.emit();
      }
      case 'goto':
        openChapter(chapterId, { panelId: panelId, focusQuick: true });
        ui.flashChapter(chapterId);
        return store.emit();
      case 'goto-char':
        state.search = node.dataset.char;
        document.getElementById('search-input').value = node.dataset.char;
        state.view = 'entry';
        return store.emit();

      /* 数据源 */
      case 'connect-http': {
        var baseInput = document.getElementById('http-base');
        return store.useAdapter('http', { base: baseInput ? baseInput.value : undefined }).then(function (ok) {
          ui.toast(ok ? '已连接本地服务' : '连接失败，请确认服务已启动', ok ? 'ok' : 'error');
        });
      }
      case 'pick-file':
        return store.useAdapter('file').then(function () {
          var adapter = store.state.adapter;
          return adapter.pick('open').then(function () {
            return store.loadFromAdapter({ message: '已打开本地 JSON 文件' }).then(function (ok) {
              ui.toast(ok ? '已打开 ' + adapter.handleName() : '文件读取失败', ok ? 'ok' : 'error');
            });
          });
        }).catch(function (error) { ui.toast(error.message, 'error'); });
      case 'new-file':
        return store.useAdapter('file').then(function () {
          var adapter = store.state.adapter;
          return adapter.pick('save').then(function () {
            return store.saveNow(true).then(function () {
              ui.toast('已保存到 ' + adapter.handleName(), 'ok');
            });
          });
        }).catch(function (error) { ui.toast(error.message, 'error'); });
      case 'reload':
        return confirmDiscard('重新载入会丢弃当前界面里未保存的改动，确定继续吗？').then(function (ok) {
          if (!ok) return false;
          return store.loadFromAdapter({ message: '已重新载入' }).then(function (done) {
            ui.toast(done ? '已重新载入数据源内容' : '载入失败', done ? 'ok' : 'error');
            return done;
          });
        });
      case 'use-adapter':
        return;

      /* 导入导出 */
      case 'export-json': return exportData('json');
      case 'export-csv': return exportData('csv');
      case 'export-md': return exportData('md');
      case 'export-sqlite':
        if (state.adapter.exportDownload) {
          state.adapter.exportDownload('sqlite');
          ui.toast('正在下载 SQLite 数据库文件（含内部 id，可直接用 sqlite3 打开）', 'ok', 3600);
        }
        return;
      case 'import-json':
        document.getElementById('import-file').click();
        return;
      case 'copy-json':
        if (global.navigator.clipboard) {
          global.navigator.clipboard.writeText(JSON.stringify(model.toExportDocument(state.db), null, 2))
            .then(function () { ui.toast('交换格式 JSON 已复制到剪贴板（不含 id）', 'ok'); })
            .catch(function (error) { ui.toast('复制失败：' + error.message, 'error'); });
        } else {
          ui.toast('当前浏览器不支持剪贴板写入，请用导出 JSON', 'warn');
        }
        return;
      case 'backup-now':
        if (!state.adapter.createBackup) return ui.toast('当前数据源不支持快照', 'warn');
        return store.saveNow(false).then(function () {
          return state.adapter.createBackup('manual');
        }).then(function () {
          ui.toast('已创建快照', 'ok');
          return refreshBackups();
        }).catch(function (error) { ui.toast(error.message, 'error'); });
      case 'refresh-backups': return refreshBackups();
      case 'load-log':
        if (!state.adapter.log) return ui.toast('当前数据源没有改动记录（只有本地服务模式有）', 'warn');
        return state.adapter.log(30).then(function (rows) {
          var box = document.getElementById('backup-list');
          if (!box) return;
          box.innerHTML = rows.length
            ? '<div class="result-title">最近改动</div>' + rows.map(function (row) {
              return '<div class="backup-row"><span class="muted small">' + ui.esc(row.at) + '</span>' +
                '<span>rev ' + row.revision + '　' + ui.esc(row.action) + '　' + ui.esc(row.detail || '') + '</span></div>';
            }).join('')
            : '<p class="muted small">暂无改动记录。</p>';
        }).catch(function (error) { ui.toast(error.message, 'error'); });
      case 'load-raw':
        return state.adapter.raw().then(function (text) {
          document.getElementById('raw-view').textContent = text || '（空）';
        }).catch(function (error) { ui.toast(error.message, 'error'); });
      case 'validate': {
        var issues = model.validateDb(state.db);
        if (!issues.length) ui.toast('数据完全合法 ✅', 'ok');
        else ui.toast('发现 ' + issues.length + ' 处问题（保存时会自动修正）', 'warn');
        return;
      }
      case 'clear-all':
        ui.confirm('清空全部数据？', '所有话、槽位和角色名都会被删除（可用 Ctrl+Z 撤销）。', '清空', 'danger')
          .then(function (ok) { if (ok) { store.actions.clearAll(); ui.toast('已清空', 'info'); } });
        return;
      case 'conflict': return showConflictDialog();
      case 'dismiss':
        document.getElementById('banner').classList.add('hidden');
        return;
      default:
        return;
    }
  }

  function refreshBackups() {
    var adapter = store.state.adapter;
    if (!adapter || !adapter.listBackups) return Promise.resolve();
    return adapter.listBackups().then(function (items) {
      var box = document.getElementById('backup-list');
      if (!box) return;
      if (!items.length) {
        box.innerHTML = '<p class="muted small">暂无快照（只有「本地服务」模式支持自动快照）。</p>';
        return;
      }
      box.innerHTML = items.map(function (item) {
        return '<div class="backup-row"><span class="muted small">' + ui.esc(item.mtime) + '</span>' +
          '<span>' + ui.esc(item.name) + '</span>' +
          '<button class="btn tiny" data-act="restore-backup" data-backup="' + ui.esc(item.name) + '" data-nofocus="1">回滚</button></div>';
      }).join('');
    });
  }

  /* ------------------------------------------------------------------ *
   * 事件：拖拽排序
   * ------------------------------------------------------------------ */
  function clearDropMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.chapter.drop-before, .chapter.drop-after'), function (node) {
      node.classList.remove('drop-before', 'drop-after');
    });
  }

  function setupDragAndDrop() {
    document.addEventListener('dragstart', function (event) {
      var grip = event.target.closest ? event.target.closest('.grip') : null;
      if (!grip) return;
      var card = grip.closest('[data-chapter-id]');
      dragState = { chapterId: card.dataset.chapterId };
      card.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', card.dataset.chapterId); } catch (error) { /* 忽略 */ }
      }
    });

    document.addEventListener('dragover', function (event) {
      if (!dragState) return;
      var card = event.target.closest ? event.target.closest('.chapter') : null;
      if (!card) return;
      event.preventDefault();
      clearDropMarks();
      var rect = card.getBoundingClientRect();
      card.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
    });

    document.addEventListener('drop', function (event) {
      if (!dragState) return;
      var card = event.target.closest ? event.target.closest('.chapter') : null;
      if (!card) return;
      event.preventDefault();
      var rect = card.getBoundingClientRect();
      var after = event.clientY >= rect.top + rect.height / 2;
      var chapters = store.state.db.chapters;
      var targetIndex = chapters.findIndex(function (item) { return item.id === card.dataset.chapterId; });
      var fromIndex = chapters.findIndex(function (item) { return item.id === dragState.chapterId; });
      if (targetIndex < 0 || fromIndex < 0) return;
      var insertAt = after ? targetIndex + 1 : targetIndex;
      if (fromIndex < insertAt) insertAt -= 1;
      clearDropMarks();
      if (insertAt === fromIndex) return;
      store.actions.moveChapterTo(dragState.chapterId, insertAt);
      ui.toast('已调整顺序，编号自动修正', 'ok');
    });

    document.addEventListener('dragend', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.chapter.dragging'), function (node) {
        node.classList.remove('dragging');
      });
      clearDropMarks();
      dragState = null;
    });
  }

  /* ------------------------------------------------------------------ *
   * 事件：输入
   * ------------------------------------------------------------------ */
  function setupInputs() {
    /* 点击：所有 data-act 走一个委托 */
    document.addEventListener('click', function (event) {
      var node = event.target.closest ? event.target.closest('[data-act]') : null;
      if (!node) return;
      var action = node.dataset.act;
      if (action === 'toggle-keypad' || action === 'use-adapter') return; // 交给 change 事件
      if (action === 'view') {
        store.patch({ view: node.dataset.view });
        return;
      }
      event.preventDefault();
      handleAction(event, action, node);
    });

    /* 顶栏视图切换 */
    document.getElementById('view-tabs').addEventListener('click', function (event) {
      var tab = event.target.closest('.tab');
      if (!tab) return;
      store.patch({ view: tab.dataset.view });
    });

    /* 阻止按钮抢焦点，保证输入框里的光标不丢 */
    document.addEventListener('mousedown', function (event) {
      var node = event.target.closest ? event.target.closest('[data-nofocus]') : null;
      if (node) event.preventDefault();
    });

    /* change：文本字段提交 */
    document.addEventListener('change', function (event) {
      var node = event.target;
      if (!node || !node.dataset) return;
      var act = node.dataset.act;

      if (act === 'toggle-keypad') {
        var chapter = activeChapter();
        var panel = activePanel(chapter);
        if (panel) {
          store.state.keypadOpen[panel.id] = !!node.checked;
          store.emit();
        }
        return;
      }
      if (act === 'use-adapter' && node.checked) {
        var targetKind = node.value;
        confirmDiscard('切换到别处的数据源会用新数据源的内容替换当前界面，未保存的改动会丢失。要先保存吗？' +
          '（选“继续”= 直接切换）').then(function (ok) {
          if (!ok) { store.emit(); return; }
          store.useAdapter(targetKind).then(function (done) {
            if (done) ui.toast('已切换数据源：' + (store.state.adapter ? store.state.adapter.label : ''), 'ok');
            else ui.toast('切换失败，已保留原数据源', 'error');
          });
        });
        return;
      }
      if (node.dataset.field === 'title' || node.dataset.field === 'note') {
        var card = node.closest('[data-chapter-id]');
        if (!card) return;
        var target = model.findChapter(store.state.db, card.dataset.chapterId);
        if (target && target[node.dataset.field] !== node.value) {
          store.actions.setChapterField(card.dataset.chapterId, node.dataset.field, node.value);
        }
        return;
      }
      if (node.dataset.field === 'meta-title') {
        store.actions.setMeta('title', node.value);
        return;
      }
      if (node.dataset.field === 'meta-author') {
        store.actions.setMeta('author', node.value);
        return;
      }
      if (node.classList && node.classList.contains('name-input')) {
        var char = Number(node.dataset.char);
        var names = (store.state.db.meta || {}).charNames || {};
        if ((names[String(char)] || '') !== node.value) {
          store.actions.setCharName(char, node.value.trim());
        }
        return;
      }
      if (node.id === 'import-file' && node.files && node.files[0]) {
        var reader = new FileReader();
        reader.onload = function () { importJsonText(String(reader.result)); };
        reader.readAsText(node.files[0], 'utf-8');
        node.value = '';
        return;
      }
      if (node.id === 'http-base') {
        adapters.lsSet('httpBase', node.value);
        return;
      }
    });

    /* input：只用于检索/筛选这类即时反馈 */
    document.addEventListener('input', function (event) {
      var node = event.target;
      if (!node || !node.id) return;
      if (node.id === 'search-input') {
        store.state.search = node.value;
        ui.scheduleRender();
        return;
      }
      if (node.id === 'dict-filter') {
        store.state.dictFilter = node.value;
        ui.scheduleRender();
        return;
      }
      if (node.dataset && node.dataset.quick) {
        /* 让用户能连续输入 “1 5 23”，这里不做任何重绘 */
      }
    });

    /* 快捷输入框：空格/回车/逗号即提交 */
    document.addEventListener('keydown', function (event) {
      var node = event.target;
      if (node && node.dataset && node.dataset.quick) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === ',' || event.key === '，' || event.key === '、') {
          event.preventDefault();
          commitQuickInput(node);
          return;
        }
        if (event.key === 'Backspace' && !node.value) {
          var chapter = activeChapter();
          var panel = activePanel(chapter);
          if (panel && panel.chars.length) {
            event.preventDefault();
            store.actions.removeChar(chapter.id, panel.id, panel.chars[panel.chars.length - 1]);
            ui.setFocus('quick-' + panel.id);
          }
          return;
        }
        if (event.key === 'Escape') { node.value = ''; node.blur(); }
      }
    });

    /* 恢复快照里的回滚按钮 */
    document.addEventListener('click', function (event) {
      var node = event.target.closest ? event.target.closest('[data-act="restore-backup"]') : null;
      if (!node) return;
      var name = node.dataset.backup;
      ui.confirm('回滚到快照？', '将用快照 <b>' + ui.esc(name) + '</b> 覆盖当前数据（覆盖前会再留一份快照）。', '回滚', 'danger')
        .then(function (ok) {
          if (!ok) return;
          store.state.adapter.restoreBackup(name).then(function (result) {
            store.patch({});
            return store.loadFromAdapter({ message: '已回滚到快照' }).then(function () {
              ui.toast('已回滚到 ' + name, 'ok');
            });
          }).catch(function (error) { ui.toast(error.message, 'error'); });
        });
    });
  }

  /* ------------------------------------------------------------------ *
   * 快捷键
   * ------------------------------------------------------------------ */
  function setupShortcuts() {
    document.addEventListener('keydown', function (event) {
      var node = event.target;
      var typing = node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA');
      var modalOpen = !document.getElementById('modal-root').classList.contains('hidden');

      if (event.key === 'Escape') {
        if (modalOpen) { ui.closeModal(null); return; }
        if (store.state.swapPick) { store.state.swapPick = null; store.emit(); return; }
      }
      if (event.ctrlKey || event.metaKey) {
        switch (event.key.toLowerCase()) {
          case 's':
            event.preventDefault();
            store.saveNow(false).then(function (ok) {
              ui.toast(ok ? '已保存' : '保存未完成，请看顶部状态', ok ? 'ok' : 'warn');
            });
            return;
          case 'z':
            event.preventDefault();
            if (event.shiftKey) store.redo(); else store.undo();
            return;
          case 'y':
            event.preventDefault();
            store.redo();
            return;
          default:
            break;
        }
      }
      if (typing || modalOpen) return;

      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        var chapter = activeChapter();
        if (chapter) {
          store.actions.moveChapter(chapter.id, event.key === 'ArrowUp' ? -1 : 1);
          ui.toast('已移动到第 ' + model.findChapter(store.state.db, chapter.id).no + ' 位', 'info', 1400);
        }
        return;
      }
      if (event.key === '[' || event.key === ']') {
        var current = activeChapter();
        if (!current) return;
        var panel = activePanel(current);
        var index = panel ? current.panels.indexOf(panel) : -1;
        var next = current.panels[index + (event.key === ']' ? 1 : -1)];
        if (next) {
          store.state.panelOf[current.id] = next.id;
          store.state.openIds[current.id] = true;
          ui.setFocus('quick-' + next.id);
          store.emit();
        }
        return;
      }
      if (event.key === '?' || event.key === 'F1') {
        event.preventDefault();
        showHelp();
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function boot() {
    ui.init();
    store.on(ui.scheduleRender);
    setupInputs();
    setupShortcuts();
    setupDragAndDrop();

    document.getElementById('btn-undo').addEventListener('click', function () { store.undo(); });
    document.getElementById('btn-redo').addEventListener('click', function () { store.redo(); });
    document.getElementById('btn-save').addEventListener('click', function () {
      store.saveNow(false).then(function (ok) {
        ui.toast(ok ? '已保存到数据源' : '保存未完成：' + store.state.statusMessage, ok ? 'ok' : 'warn');
      });
    });
    document.getElementById('btn-help').addEventListener('click', showHelp);

    document.addEventListener('click', function (event) {
      var node = event.target.closest ? event.target.closest('[data-banner-act]') : null;
      if (!node) return;
      if (node.dataset.bannerAct === 'conflict') showConflictDialog();
    });

    global.addEventListener('beforeunload', function (event) {
      if (store.state.status === 'dirty' || store.state.status === 'saving') {
        event.preventDefault();
        event.returnValue = '';
        return '';
      }
      return undefined;
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && store.state.status === 'dirty') store.saveNow(false);
    });

    /* 自动保存：状态变化到 dirty 时由 store 内部定时器负责，这里只做兜底渲染 */
    ui.render();
    store.boot().then(function () {
      ui.render();
      var state = store.state;
      if (state.legacyMigration) {
        ui.toast('已把旧版浏览器缓存里的数据迁移到 IndexedDB：' + state.legacyMigration.chapters +
          ' 话 / ' + state.legacyMigration.panels + ' 槽位', 'ok', 5200);
      }
      if (state.adapterKind === 'idb' && !state.db.chapters.length) {
        ui.toast('欢迎使用超超你的字典：先「+ 新建一话」，再给它加槽位', 'info', 4200);
      }
      if (state.status === 'error') {
        ui.toast('没能连上数据源：' + state.statusMessage, 'warn', 5200);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}(window));
