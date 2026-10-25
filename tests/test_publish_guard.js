'use strict';
/** 管理端发布按钮的服务端版本守卫：旧服务必须禁用发布。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'publish.js'), 'utf8');

function boot(health) {
  const button = {
    disabled: false,
    textContent: '发布',
    title: '',
    handler: null,
    addEventListener(type, handler) { this.handler = handler; },
  };
  const toasts = [];
  const sandbox = {
    console,
    Number,
    String,
    Promise,
    setTimeout,
    clearTimeout,
    document: {
      readyState: 'complete',
      getElementById(id) { return id === 'btn-publish' ? button : null; },
      addEventListener() {},
    },
    fetch(url) {
      const clean = String(url).split('?')[0];
      if (clean === '/api/health') {
        return Promise.resolve({ json: () => Promise.resolve(health) });
      }
      if (clean === '/api/publish/status') {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, published: false }) });
      }
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true }),
        text: () => Promise.resolve('{}'),
      });
    },
    GD: {
      store: { state: { adapterKind: 'http' }, saveNow: () => Promise.resolve(true) },
      ui: { toast(message, kind) { toasts.push({ message, kind }); } },
    },
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'public/js/publish.js' });
  return { button, toasts };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const old = boot({ ok: true, version: '2.0.0' });
  await wait(30);
  assert.strictEqual(old.button.disabled, true, '旧服务应禁用发布');
  assert.strictEqual(old.button.textContent, '服务旧');
  assert.ok(old.button.title.includes('start.bat'));

  for (const version of [1, 2, 3, '4', null]) {
    const rejected = boot({ ok: true, siteFormatVersion: version });
    await wait(10);
    assert.strictEqual(rejected.button.disabled, true, '非当前版本必须禁止发布：' + version);
  }

  const current = boot({ ok: true, siteFormatVersion: 4 });
  await wait(30);
  assert.strictEqual(current.button.disabled, false, '新服务应允许发布');
  assert.strictEqual(current.button.textContent, '发布');

  console.log('发布服务端版本守卫测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
