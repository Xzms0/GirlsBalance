#!/usr/bin/env node
/**
 * 界面冒烟测试：不依赖浏览器，用最小 DOM 桩把 public/js 下的脚本跑起来。
 *
 * 覆盖三件事：
 *   1. 渲染管线（ui.render）不抛异常、生成的 HTML 结构正确；
 *   2. 数据操作（数字键盘 / 槽位 / 排序 / 对换 / 撤销）能反映到界面上；
 *   3. app.js 的启动流程与点击委托（data-act）真的能改数据。
 *
 * 运行：node tests/test_ui_smoke.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
const failures = [];

function test(name, fn) {
  let result;
  try {
    result = fn();
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
    return Promise.resolve(false);
  }
  if (result && typeof result.then === 'function') {
    // 异步用例：调用方需要 await，否则计数会来不及
    return result.then(() => {
      passed += 1;
      console.log(`  ok   ${name}`);
      return true;
    }, (error) => {
      failures.push({ name, error });
      console.log(`  FAIL ${name}\n       ${error.message}`);
      return false;
    });
  }
  passed += 1;
  console.log(`  ok   ${name}`);
  return Promise.resolve(true);
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩
 * ------------------------------------------------------------------ */
function makeElement(id) {
  const classes = new Set();
  return {
    id: id || '',
    tagName: 'DIV',
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    title: '',
    files: null,
    dataset: {},
    style: {},
    children: [],
    listeners: {},
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() { this.ownerDocument.activeElement = this; },
    blur() { this.ownerDocument.activeElement = null; },
    setSelectionRange() {},
    getBoundingClientRect() { return { top: 0, height: 10, left: 0, width: 10 }; },
    setAttribute() {},
    removeAttribute() {},
    click() {},
    insertAdjacentHTML() {},
  };
}

/** 起一个干净的沙箱（含 DOM 桩、localStorage、file:// 环境），加载指定脚本。
 *  extras 会同时挂到 sandbox 与 window 上（浏览器里这两者是同一个全局对象）。 */
function loadSandbox(files, extras) {
  const cache = new Map();
  const documentStub = {
    readyState: 'complete',
    activeElement: null,
    listeners: {},
    getElementById(id) {
      if (!cache.has(id)) {
        const node = makeElement(id);
        node.ownerDocument = documentStub;
        cache.set(id, node);
      }
      return cache.get(id);
    },
    createElement(tag) {
      const node = makeElement();
      node.tagName = String(tag).toUpperCase();
      node.ownerDocument = documentStub;
      return node;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
    removeEventListener() {},
  };
  documentStub.body = documentStub.createElement('body');

  const storage = new Map();
  const windowStub = {
    document: documentStub,
    crypto: crypto.webcrypto,
    location: { protocol: 'file:', origin: 'null', href: 'file:///index.html' },
    navigator: { clipboard: null, userAgent: 'node-smoke' },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      key: (index) => [...storage.keys()][index],
      get length() { return storage.size; },
    },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    FileReader: class { readAsText() {} },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    AbortController: global.AbortController,
    indexedDB: undefined,
    console,
  };
  windowStub.window = windowStub;

  const sandbox = {
    window: windowStub,
    document: documentStub,
    console,
    localStorage: windowStub.localStorage,
    crypto: windowStub.crypto,
    navigator: windowStub.navigator,
    location: windowStub.location,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    setTimeout,
    clearTimeout,
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Map, Set,
    isFinite, parseInt, parseFloat, Uint8Array,
    Blob: windowStub.Blob,
    URL: windowStub.URL,
    AbortController: global.AbortController,
  };
  vm.createContext(sandbox);

  if (extras) {
    Object.keys(extras).forEach((key) => {
      sandbox[key] = extras[key];
      windowStub[key] = extras[key];
    });
  }

  /* Node 里没有 IndexedDB，用「内存适配器」顶替，接口与真实适配器一致，
     并且会记录每次保存收到的补丁，便于断言「只发变化的部分」。 */
  const memoryAdapters = [];
  function memoryAdapter() {
    const instance = {
      kind: 'idb',
      label: '内存数据源（测试用）',
      detail: 'memory',
      store: { db: null, revision: 0, ops: null, saves: 0 },
    };
    const model = windowStub.GD.model;
    instance.store.db = model.defaultDb();
    Object.assign(instance, {
      available: () => true,
      status: () => Promise.resolve({ ok: true, canWrite: true, detail: 'memory' }),
      pick: () => Promise.resolve({ ok: true, detail: 'memory' }),
      load: () => Promise.resolve({ db: model.clone(instance.store.db), revision: instance.store.revision }),
      save: (db, revision, options) => {
        const settings = options || {};
        if (!settings.force && Number(revision) !== instance.store.revision) {
          return Promise.reject(windowStub.GD.adapters.ConflictError(instance.store.revision, instance.store.db));
        }
        instance.store.revision += 1;
        instance.store.ops = settings.ops || [];
        instance.store.saves += 1;
        instance.store.db = model.clone(db);
        return Promise.resolve({ revision: instance.store.revision, issues: [] });
      },
      listBackups: () => Promise.resolve([]),
      createBackup: () => Promise.reject(new Error('内存数据源没有快照')),
      restoreBackup: () => Promise.reject(new Error('内存数据源没有快照')),
      exportDownload: () => Promise.resolve(),
      raw: () => Promise.resolve(JSON.stringify(model.toExportDocument(instance.store.db), null, 2)),
    });
    memoryAdapters.push(instance);
    return instance;
  }

  files.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8'), sandbox, { filename: file });
    if (file === 'adapters.js') {
      const original = windowStub.GD.adapters.create;
      windowStub.GD.adapters.create = function (kind, options) {
        if (kind === 'idb' || kind === 'local') return memoryAdapter();
        return original.call(this, kind, options);
      };
    }
  });

  const GD = windowStub.GD;
  /** 触发 document 上注册的某一类事件（点击委托用）。 */
  function fire(type, target) {
    (documentStub.listeners[type] || []).forEach((handler) => handler({
      type,
      target,
      preventDefault() {},
      stopPropagation() {},
      key: '',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      clientY: 0,
    }));
  }

  /** 造一个带 data-act 的假节点，closest 只认 [data-act] 与自己所属的话卡片。 */
  function fakeNode(action, data, chapterId) {
    const node = makeElement();
    node.dataset = Object.assign({ act: action }, data || {});
    node.closest = (selector) => {
      if (selector === '[data-act]') return node;
      if (selector === '[data-chapter-id]' && chapterId) {
        const card = makeElement();
        card.dataset = { chapterId };
        return card;
      }
      return null;
    };
    return node;
  }

  return { sandbox, GD, window: windowStub, document: documentStub, fire, fakeNode, cache, memoryAdapters };
}

const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sample.girls_dict.json'), 'utf8'));

/* ------------------------------------------------------------------ *
 * 第一部分：渲染管线与数据操作
 * ------------------------------------------------------------------ */
console.log('girls_dict 界面冒烟测试（最小 DOM 桩）\n');
console.log('渲染管线');

const env = loadSandbox(['model.js', 'adapters.js', 'store.js', 'ui.js']);
const { model, store, ui, adapters } = env.GD;
const doc = env.document;

store.state.adapter = adapters.create('idb');
store.state.adapterKind = 'idb';
store.state.ready = true;
store.patch({ db: model.normalizeDb(sample).db, revision: 0 });
store.state.openIds[store.state.db.chapters[0].id] = true;
store.state.panelOf[store.state.db.chapters[0].id] = store.state.db.chapters[0].panels[0].id;
ui.init();

test('render() 不抛异常', () => { ui.render(); });

test('渲染出全部话卡片', () => {
  const html = doc.getElementById('view-entry').innerHTML;
  assert.strictEqual(count(html, '<article class="chapter'), 3, '应有 3 张话卡片');
  assert.ok(html.includes('第 1 话') && html.includes('第 3 话'));
  assert.ok(html.includes('相遇'), '应显示标题');
});

test('展开的话里有槽位条（分镜）', () => {
  const html = doc.getElementById('view-entry').innerHTML;
  assert.ok(html.includes('panel-strip'));
  assert.strictEqual(count(html, 'data-act="select-panel"'), 4, '第 1 话应有 4 个槽位');
  assert.ok(html.includes('data-act="add-panel"'));
});

test('数字键盘是 0–100 共 101 个按钮', () => {
  const html = doc.getElementById('view-entry').innerHTML;
  assert.strictEqual(count(html, 'data-act="key"'), 101);
  assert.ok(html.includes('data-char="0"') && html.includes('data-char="100"'));
  assert.ok(html.includes('class="key on"'), '已选编号应处于选中态');
});

test('槽位编辑区显示已选角色与角色名', () => {
  const html = doc.getElementById('view-entry').innerHTML;
  assert.ok(html.includes('class="chip"'));
  assert.ok(html.includes('<i>超超</i>'));
  assert.ok(html.includes('槽位 1'));
});

test('侧栏目录与总览同步渲染', () => {
  assert.strictEqual(count(doc.getElementById('chapter-nav').innerHTML, 'nav-item'), 3);
  const overview = doc.getElementById('overview').innerHTML;
  assert.ok(overview.includes('槽位') && overview.includes('人次'));
});

test('选中别的槽位后编辑区刷新', () => {
  const chapter = store.state.db.chapters[0];
  store.state.panelOf[chapter.id] = chapter.panels[2].id;
  ui.render();
  const html = doc.getElementById('view-entry').innerHTML;
  assert.ok(html.includes('槽位 3'));
  assert.ok(html.includes('data-focus-id="quick-' + chapter.panels[2].id + '"'));
  store.state.panelOf[chapter.id] = chapter.panels[0].id;
});

console.log('\n数据操作 → 界面刷新');

test('数字键盘（toggleChar）能加能减', () => {
  const chapter = store.state.db.chapters[0];
  const panel = chapter.panels[0];
  store.actions.toggleChar(chapter.id, panel.id, 42);
  assert.ok(model.findChapter(store.state.db, chapter.id).panels[0].chars.includes(42));
  ui.render();
  assert.ok(doc.getElementById('view-entry').innerHTML.includes('data-char="42"'));
  store.actions.toggleChar(chapter.id, panel.id, 42);
  assert.ok(!model.findChapter(store.state.db, chapter.id).panels[0].chars.includes(42));
});

test('新增槽位后槽位条变长', () => {
  const chapter = store.state.db.chapters[0];
  const before = chapter.panels.length;
  const created = store.actions.addPanel(chapter.id);
  ui.render();
  assert.strictEqual(model.findChapter(store.state.db, chapter.id).panels.length, before + 1);
  assert.strictEqual(store.state.panelOf[chapter.id], created.id);
  assert.strictEqual(count(doc.getElementById('view-entry').innerHTML, 'data-act="select-panel"'), before + 1);
  store.actions.deletePanel(chapter.id, created.id);
});

test('新建一话会自动展开并带一个空槽位', () => {
  const created = store.actions.addChapter(null);
  assert.strictEqual(store.state.db.chapters.length, 4);
  assert.ok(store.state.openIds[created.id]);
  assert.strictEqual(created.panels.length, 1);
  ui.render();
  assert.ok(doc.getElementById('view-entry').innerHTML.includes('第 4 话'));
  store.actions.deleteChapter(created.id);
});

test('对换两话后编号自动修正', () => {
  const ids = store.state.db.chapters.map((c) => c.id);
  const firstTitle = store.state.db.chapters[0].title;
  store.actions.swapChapters(ids[0], ids[2]);
  const after = store.state.db.chapters;
  assert.strictEqual(after[2].title, firstTitle);
  assert.strictEqual(JSON.stringify(after.map((c) => c.no)), '[1,2,3]');
  ui.render();
  assert.ok(doc.getElementById('chapter-nav').innerHTML.includes('第 3 话'));
  store.actions.swapChapters(ids[0], ids[2]);
});

test('拖动排序保持编号连续', () => {
  const ids = store.state.db.chapters.map((c) => c.id);
  store.actions.moveChapterTo(ids[0], 2);
  assert.strictEqual(JSON.stringify(store.state.db.chapters.map((c) => c.no)), '[1,2,3]');
  store.actions.moveChapterTo(ids[0], 0);
  assert.strictEqual(store.state.db.chapters[0].id, ids[0]);
});

test('撤销 / 重做可用', () => {
  const chapter = store.state.db.chapters[0];
  store.actions.setChapterField(chapter.id, 'title', '临时标题');
  assert.strictEqual(model.findChapter(store.state.db, chapter.id).title, '临时标题');
  store.undo();
  assert.strictEqual(model.findChapter(store.state.db, chapter.id).title, '相遇');
  store.redo();
  assert.strictEqual(model.findChapter(store.state.db, chapter.id).title, '临时标题');
  store.undo();
  ui.render();
});

console.log('\n其它视图');

test('角色字典表格包含编号、名字与出现位置', () => {
  store.patch({ view: 'dict' });
  ui.render();
  const html = doc.getElementById('view-dict').innerHTML;
  assert.ok(html.includes('<th>编号</th>'));
  assert.ok(html.includes('data-char="1"'));
  assert.ok(html.includes('data-act="goto"'));
  assert.ok(html.includes('超超'));
});

test('字典筛选可用', () => {
  store.patch({ dictFilter: '会长' });
  ui.render();
  const html = doc.getElementById('view-dict').innerHTML;
  assert.ok(html.includes('会长'));
  assert.ok(!html.includes('data-char="100"'), '不含“会长”的行应被过滤');
  store.patch({ dictFilter: '' });
});

test('数据视图有三种数据源与导入导出按钮', () => {
  store.patch({ view: 'data' });
  ui.render();
  const html = doc.getElementById('view-data').innerHTML;
  ['本地服务（SQLite，推荐）', '浏览器数据库（IndexedDB）', 'JSON 文件（交换/备份）'].forEach((label) => {
    assert.ok(html.includes(label), '缺少数据源：' + label);
  });
  ['export-json', 'export-csv', 'export-md', 'import-json', 'backup-now', 'clear-all'].forEach((act) => {
    assert.ok(html.includes('data-act="' + act + '"'), '缺少按钮：' + act);
  });
  assert.ok(html.includes('导出 JSON（不含 id）'), '导出按钮应写明不含 id');
  store.patch({ view: 'entry' });
});

test('按编号检索能定位到槽位', () => {
  store.patch({ view: 'entry', search: '100' });
  ui.render();
  const html = doc.getElementById('search-results').innerHTML;
  assert.ok(html.includes('角色 <b>100</b>'));
  assert.ok(html.includes('第 3 话 · 槽位 2'));
  store.patch({ search: '' });
});

test('按文字检索能匹配标题', () => {
  store.patch({ search: '放学' });
  ui.render();
  assert.ok(doc.getElementById('search-results').innerHTML.includes('放学后'));
  store.patch({ search: '' });
});

test('toast 与弹窗可用', () => {
  ui.toast('测试提示', 'ok');
  assert.strictEqual(doc.getElementById('toasts').children.length, 1);
  ui.confirm('标题', '内容', '确定');
  assert.ok(doc.getElementById('modal-root').innerHTML.includes('modal'));
  ui.closeModal(false);
  assert.strictEqual(doc.getElementById('modal-root').innerHTML, '');
});

console.log('\n页面骨架（index.html）');

const pageHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('左上角 logo 里是 ❤，且不再有副标题', () => {
  assert.ok(/<span class="logo">❤<\/span>/.test(pageHtml), 'logo 应该是 ❤');
  assert.ok(!pageHtml.includes('字典</span>'), 'logo 里不该再有「字典」二字');
  assert.ok(!pageHtml.includes('分镜角色编号记录器'), '主标题下面那行小字应该去掉');
  assert.ok(!/<div class="brand-text">\s*<h1>[\s\S]*?<\/h1>\s*<p>/.test(pageHtml), 'brand-text 里不该再有 <p>');
});

test('有悬浮的快速新建按钮，并且复用 new-chapter 动作', () => {
  assert.ok(pageHtml.includes('id="btn-quick-new"'), '缺少悬浮按钮');
  const button = pageHtml.match(/<button[^>]*id="btn-quick-new"[^>]*>/);
  assert.ok(button, '按钮标签没匹配到');
  assert.ok(button[0].includes('data-act="new-chapter"'), '悬浮按钮应该触发新建一话');
  assert.ok(button[0].includes('class="fab'), '悬浮按钮应该带 fab 样式类');
  assert.ok(button[0].includes('data-nofocus="1"'), '点它不该抢走输入框焦点');
});

test('悬浮按钮只在录入视图出现', () => {
  const fab = doc.getElementById('btn-quick-new');
  store.patch({ view: 'entry' });
  ui.render();
  assert.strictEqual(fab.classList.contains('hidden'), false, '录入视图应该显示');
  store.patch({ view: 'dict' });
  ui.render();
  assert.strictEqual(fab.classList.contains('hidden'), true, '角色字典视图应该隐藏');
  store.patch({ view: 'data' });
  ui.render();
  assert.strictEqual(fab.classList.contains('hidden'), true, '数据视图应该隐藏');
  store.patch({ view: 'entry' });
  ui.render();
  assert.strictEqual(fab.classList.contains('hidden'), false);
});

test('新建一话会请求滚动到新话（列表很长也看得到）', () => {
  const before = store.state.db.chapters.length;
  ui.scrollToChapter('ch-anything');       // 记录「下次渲染要滚到哪里」
  assert.doesNotThrow(() => ui.render(), '目标不存在时也不能抛异常');
  const created = store.actions.addChapter(store.state.activeChapterId);
  ui.scrollToChapter(created.id);
  assert.doesNotThrow(() => ui.render());
  assert.strictEqual(store.state.db.chapters.length, before + 1);
  store.actions.deleteChapter(created.id);
  ui.render();
});

/* ------------------------------------------------------------------ *
 * 第二部分：app.js 启动 + 点击委托
 * ------------------------------------------------------------------ */
console.log('\napp.js 启动与点击委托');

const appEnv = loadSandbox(['model.js', 'adapters.js', 'store.js', 'ui.js', 'app.js']);
const appStore = appEnv.GD.store;
const appModel = appEnv.GD.model;

async function appPhase() {
  await new Promise((resolve) => setTimeout(resolve, 50));

  await test('app.js 载入后自动完成启动', () => {
    assert.strictEqual(appStore.state.ready, true, '启动后应已就绪');
    assert.strictEqual(appStore.state.adapterKind, 'idb', '没有服务时会落到浏览器数据库（这里用内存替身）');
    assert.ok(appEnv.document.getElementById('view-entry').innerHTML.length > 0, '启动后应渲染出内容');
  });

  test('启动后是空状态提示', () => {
    const html = appEnv.document.getElementById('view-entry').innerHTML;
    assert.ok(html.includes('还没有任何记录'), '空库应显示引导');
  });

  /* 用真实点击委托驱动 app.js */
  appEnv.fire('click', appEnv.fakeNode('new-chapter'));

  test('点击「+ 新建一话」会创建第 1 话并展开', () => {
    assert.strictEqual(appStore.state.db.chapters.length, 1);
    assert.strictEqual(appStore.state.db.chapters[0].no, 1);
    assert.strictEqual(appStore.state.db.chapters[0].panels.length, 1);
    assert.ok(appEnv.document.getElementById('view-entry').innerHTML.includes('第 1 话'));
  });

  test('点击数字键盘按钮会写入角色编号', () => {
    const chapter = appStore.state.db.chapters[0];
    appEnv.fire('click', appEnv.fakeNode('key', { char: '7' }, chapter.id));
    const after = appModel.findChapter(appStore.state.db, chapter.id).panels[0];
    assert.strictEqual(JSON.stringify(after.chars), '[7]');
    appEnv.fire('click', appEnv.fakeNode('key', { char: '7' }, chapter.id));
    assert.strictEqual(
      JSON.stringify(appModel.findChapter(appStore.state.db, chapter.id).panels[0].chars), '[]'
    );
  });

  test('点击「+ 槽位」新增分镜，点击芯片切换槽位', () => {
    const chapter = appStore.state.db.chapters[0];
    appEnv.fire('click', appEnv.fakeNode('add-panel', {}, chapter.id));
    assert.strictEqual(appModel.findChapter(appStore.state.db, chapter.id).panels.length, 2);
    const second = appModel.findChapter(appStore.state.db, chapter.id).panels[1];
    appEnv.fire('click', appEnv.fakeNode('select-panel', { panelId: second.id }, chapter.id));
    assert.strictEqual(appStore.state.panelOf[chapter.id], second.id);
  });

  test('点击角色标签上的 × 会移除该编号', () => {
    const chapter = appStore.state.db.chapters[0];
    appEnv.fire('click', appEnv.fakeNode('key', { char: '9' }, chapter.id));
    appEnv.fire('click', appEnv.fakeNode('key', { char: '3' }, chapter.id));
    const panel = appModel.findChapter(appStore.state.db, chapter.id).panels[1];
    assert.strictEqual(JSON.stringify(panel.chars.slice().sort((a, b) => a - b)), '[3,9]');
    appEnv.fire('click', appEnv.fakeNode('remove-char', { char: '3' }, chapter.id));
    assert.strictEqual(
      JSON.stringify(appModel.findChapter(appStore.state.db, chapter.id).panels[1].chars), '[9]'
    );
  });

  test('复制槽位 / 粘贴到另一个槽位', () => {
    const chapter = appStore.state.db.chapters[0];
    const firstPanelId = appModel.findChapter(appStore.state.db, chapter.id).panels[0].id;
    appEnv.fire('click', appEnv.fakeNode('panel-copy', {}, chapter.id));
    assert.strictEqual(JSON.stringify(appStore.state.clipboard), '[9]');
    appEnv.fire('click', appEnv.fakeNode('select-panel', { panelId: firstPanelId }, chapter.id));
    appEnv.fire('click', appEnv.fakeNode('panel-paste', {}, chapter.id));
    assert.strictEqual(
      JSON.stringify(appModel.findChapter(appStore.state.db, chapter.id).panels[0].chars), '[9]'
    );
  });

  test('点击「对换」两次完成两话互换并修正编号', () => {
    appEnv.fire('click', appEnv.fakeNode('new-chapter'));
    appEnv.fire('click', appEnv.fakeNode('new-chapter'));
    assert.strictEqual(appStore.state.db.chapters.length, 3);
    const ids = appStore.state.db.chapters.map((c) => c.id);
    appEnv.fire('click', appEnv.fakeNode('swap', {}, ids[0]));
    assert.strictEqual(appStore.state.swapPick, ids[0]);
    appEnv.fire('click', appEnv.fakeNode('swap', {}, ids[2]));
    assert.strictEqual(appStore.state.swapPick, null);
    assert.strictEqual(appStore.state.db.chapters[0].id, ids[2]);
    assert.strictEqual(JSON.stringify(appStore.state.db.chapters.map((c) => c.no)), '[1,2,3]');
  });

  test('点击 ↑ / ↓ 调整顺序', () => {
    const ids = appStore.state.db.chapters.map((c) => c.id);
    appEnv.fire('click', appEnv.fakeNode('up', {}, ids[2]));
    assert.strictEqual(appStore.state.db.chapters[1].id, ids[2]);
    appEnv.fire('click', appEnv.fakeNode('down', {}, ids[2]));
    assert.strictEqual(appStore.state.db.chapters[2].id, ids[2]);
  });

  test('展开 / 收起全部', () => {
    appEnv.fire('click', appEnv.fakeNode('expand-all'));
    assert.strictEqual(Object.keys(appStore.state.openIds).length, 3);
    appEnv.fire('click', appEnv.fakeNode('collapse-all'));
    assert.strictEqual(Object.keys(appStore.state.openIds).length, 0);
  });

  test('点击「清空全部数据」会先弹确认框', () => {
    appEnv.fire('click', appEnv.fakeNode('clear-all'));
    assert.ok(appEnv.document.getElementById('modal-root').innerHTML.includes('清空全部数据？'));
    appEnv.GD.ui.closeModal(false);
    assert.strictEqual(appStore.state.db.chapters.length, 3, '点“取消”不应该清空');
  });

  await test('保存把数据写进了数据源', async () => {
    const adapter = appStore.state.adapter;
    await appStore.saveNow(false);
    assert.ok(adapter.store.saves >= 1, '应至少保存一次');
    assert.strictEqual(adapter.store.db.chapters.length, 3);
    assert.ok(adapter.store.revision >= 1, 'revision 应递增');
  });

  await test('保存只发送变化的部分（增量补丁）', async () => {
    const adapter = appStore.state.adapter;
    const chapter = appStore.state.db.chapters[0];
    const panelId = appStore.state.panelOf[chapter.id] || chapter.panels[0].id;
    appStore.state.panelOf[chapter.id] = panelId;
    appEnv.fire('click', appEnv.fakeNode('key', { char: '44' }, chapter.id));
    const before = adapter.store.saves;
    await appStore.saveNow(false);
    assert.strictEqual(adapter.store.saves, before + 1);
    const ops = adapter.store.ops;
    assert.strictEqual(ops.length, 1, '应该只有一条操作，实际：' + JSON.stringify(ops));
    assert.strictEqual(ops[0].op, 'panel.chars');
    assert.strictEqual(ops[0].panelId, panelId);
    assert.ok(ops[0].chars.indexOf(44) !== -1);
  });

  await test('没有改动时不会重复发送', async () => {
    const adapter = appStore.state.adapter;
    const before = adapter.store.saves;
    await appStore.saveNow(false);
    assert.strictEqual(adapter.store.saves, before, '没有变化就不该产生请求');
  });

  await test('撤销之后的补丁是反向的', async () => {
    const adapter = appStore.state.adapter;
    appStore.undo();
    await appStore.saveNow(false);
    const ops = adapter.store.ops;
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].op, 'panel.chars');
    assert.ok(ops[0].chars.indexOf(44) === -1, '撤销后 44 应被移除');
  });

  await test('保存的内容能被重新读回（持久化闭环）', async () => {
    const before = JSON.stringify(appStore.state.db.chapters);
    const again = await appStore.loadFromAdapter();
    assert.strictEqual(again, true);
    assert.strictEqual(appStore.state.db.chapters.length, 3);
    assert.strictEqual(JSON.stringify(appStore.state.db.chapters), before, '读回的内容应与保存的一致');
  });

  await test('导出的交换格式不含任何 id', async () => {
    const text = JSON.stringify(appEnv.GD.model.toExportDocument(appStore.state.db));
    assert.ok(!text.includes('"id"'), '不应出现 id');
    assert.ok(!text.includes('pn-') && !text.includes('ch-'), '不应出现内部 id 值');
  });
}

/* ------------------------------------------------------------------ *
 * 第三部分：HTTP 适配器的传输层（生产上最主要的那条路）
 * ------------------------------------------------------------------ */
async function httpPhase() {
  console.log('\nHTTP 适配器（用假的 fetch 看它到底发了什么）');

  const calls = [];
  let nextReply = { status: 200, body: { ok: true, revision: 5, issues: [] } };
  const fakeFetch = (url, options) => {
    calls.push({ url: url, options: options || {} });
    const reply = nextReply;
    return Promise.resolve({
      status: reply.status,
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    });
  };

  const httpEnv = loadSandbox(['model.js', 'adapters.js'], {
    fetch: fakeFetch,
    AbortController: global.AbortController,
  });
  httpEnv.window.location = { protocol: 'http:', origin: 'http://127.0.0.1:8777', href: 'http://127.0.0.1:8777/' };
  const model = httpEnv.GD.model;
  const adapter = httpEnv.GD.adapters.create('http');
  httpEnv.GD.adapters.lsSet('httpBase', 'http://127.0.0.1:8777');

  await test('保存一条补丁 = 一次 POST /api/db/patch', async () => {
    calls.length = 0;
    nextReply = { status: 200, body: { ok: true, revision: 9, issues: [{ level: 'warn', path: 'x', message: 'y' }] } };
    const result = await adapter.save({ chapters: [] }, 8, {
      ops: [{ op: 'panel.chars', panelId: 'pn-1', chapterId: 'ch-1', chars: [1, 2] }],
      label: '录入角色',
    });
    assert.strictEqual(calls.length, 1, '只应发一次请求');
    assert.ok(calls[0].url.endsWith('/api/db/patch'), calls[0].url);
    assert.strictEqual(calls[0].options.method, 'POST');
    const sent = JSON.parse(calls[0].options.body);
    assert.strictEqual(sent.revision, 8);
    assert.strictEqual(sent.label, '录入角色');
    assert.strictEqual(sent.ops.length, 1);
    assert.strictEqual(sent.ops[0].op, 'panel.chars');
    assert.strictEqual(result.revision, 9);
    assert.strictEqual(result.issues.length, 1, '服务端报告的 issues 要带回来');
  });

  await test('强度覆盖（force）走 PUT /api/db', async () => {
    calls.length = 0;
    nextReply = { status: 200, body: { ok: true, revision: 10, issues: [] } };
    await adapter.save({ chapters: [] }, 9, { ops: [], force: true });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/api/db'), calls[0].url);
    assert.strictEqual(calls[0].options.method, 'PUT');
    const sent = JSON.parse(calls[0].options.body);
    assert.strictEqual(sent.force, true);
    assert.ok(sent.db, 'PUT 要带上整库');
  });

  await test('409 会被翻译成 ConflictError（带最新 revision 与内容）', async () => {
    calls.length = 0;
    nextReply = { status: 409, body: { ok: false, error: '版本冲突', revision: 42, db: { chapters: [] } } };
    let caught = null;
    try {
      await adapter.save({ chapters: [] }, 7, { ops: [{ op: 'panel.chars', panelId: 'pn-1', chars: [1] }] });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, '应该抛错');
    assert.strictEqual(caught.name, 'ConflictError');
    assert.strictEqual(caught.currentRevision, 42);
    assert.ok(caught.currentDb, '要带上服务端最新的文档');
  });

  await test('其它错误会把服务端的 message 带出来', async () => {
    calls.length = 0;
    nextReply = { status: 400, body: { ok: false, error: '第 1 个操作不合法：不认识的操作', opIndex: 0 } };
    let caught = null;
    try {
      await adapter.save({ chapters: [] }, 1, { ops: [{ op: 'nope' }] });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught && caught.message.indexOf('不认识的操作') !== -1, caught && caught.message);
  });

  await test('load() 解析 {db, revision}（规范化交给 store 在装载时做）', async () => {
    calls.length = 0;
    nextReply = {
      status: 200,
      body: { ok: true, revision: 3, db: { chapters: [{ no: 5, panels: [{ chars: [2, 2, 1] }] }] } },
    };
    const loaded = await adapter.load();
    assert.ok(calls[0].url.endsWith('/api/db'));
    assert.strictEqual(loaded.revision, 3);
    assert.strictEqual(loaded.db.chapters.length, 1, '原样带回服务端内容');
    // store.applyLoaded 会用 model.normalizeDb 过一遍：编号重排、去重升序、补 id
    const normalized = model.normalizeDb(loaded.db).db;
    assert.strictEqual(normalized.chapters[0].no, 1);
    assert.strictEqual(normalized.chapters[0].panels[0].chars.join(','), '1,2');
    assert.ok(normalized.chapters[0].id);
    assert.ok(normalized.chapters[0].panels[0].id);
  });

  await test('status() 报告数据库文件与规模', async () => {
    calls.length = 0;
    nextReply = {
      status: 200,
      body: { ok: true, storage: 'sqlite', storageVersion: 2, dataFile: 'D:/x/girls_dict.sqlite3',
        dataFileSize: 104448, chapters: 1, panels: 204, revision: 7, migration: null },
    };
    const status = await adapter.status();
    assert.strictEqual(status.ok, true);
    assert.ok(status.detail.indexOf('girls_dict.sqlite3') !== -1);
    assert.ok(status.detail.indexOf('102.0 KB') !== -1, status.detail);
    assert.ok(status.info && status.info.storage === 'sqlite');
  });

  await test('服务没起来时 status() 不抛异常而是 ok:false', async () => {
    const failing = loadSandbox(['model.js', 'adapters.js'], {
      fetch: () => Promise.reject(new Error('connection refused')),
      AbortController: global.AbortController,
    });
    const status = await failing.GD.adapters.create('http').status();
    assert.strictEqual(status.ok, false);
    assert.ok(status.detail.indexOf('连接服务失败') !== -1, status.detail);
  });
}

appPhase().then(httpPhase).then(() => {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    failures.forEach((f) => console.error(`- ${f.name}: ${f.error.stack || f.error.message}`));
    process.exitCode = 1;
  }
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
