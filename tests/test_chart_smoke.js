'use strict';
/**
 * 公开统计页冒烟测试：用最小 DOM 桩执行 docs/js/chart.js，
 * 覆盖三种统计、排序、起始角色过滤、颜色和页脚链接。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'manifest.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'stats.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'chapters', 'index.json'), 'utf8'));
const colors = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'colors.json'), 'utf8'));
const pageHtml = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const siteCss = fs.readFileSync(path.join(ROOT, 'docs', 'css', 'site.css'), 'utf8');

function makeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    title: '',
    value: '',
    checked: false,
    disabled: false,
    listeners: {},
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      contains(value) { return this.values.has(value); },
    },
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(handler);
    },
    fire(type, event) {
      (this.listeners[type] || []).forEach((handler) => handler(event || {}));
    },
  };
}

const elements = {};
['meta-chars', 'meta-chapter', 'meta-updated', 'revision', 'metric', 'sort', 'order',
  'start-char', 'chart', 'empty'].forEach((id) => {
  elements[id] = makeElement(id);
});
elements.metric.value = 'count';
elements.sort.value = 'char';
elements.order.value = 'asc';
elements['start-char'].value = 'all';
elements.empty.classList.add('hidden');

const documentStub = {
  readyState: 'complete',
  hidden: false,
  title: '',
  listeners: {},
  getElementById(id) { return elements[id] || null; },
  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  },
};

function fetchStub(url) {
  const clean = String(url).split('?')[0];
  let data = null;
  if (clean.endsWith('manifest.json')) data = manifest;
  else if (clean.endsWith('stats.json')) data = stats;
  else if (clean.endsWith('chapters/index.json')) data = index;
  else if (clean.endsWith('colors.json')) data = colors;
  if (!data) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

const sandbox = {
  window: { setInterval() { return 0; } },
  document: documentStub,
  console,
  Date,
  Number,
  String,
  Array,
  Object,
  Math,
  JSON,
  Set,
  RegExp,
  isFinite,
  isNaN,
  Promise,
  setTimeout,
  clearTimeout,
  encodeURIComponent,
  fetch: fetchStub,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs', 'js', 'chart.js'), 'utf8'), sandbox, {
  filename: 'docs/js/chart.js',
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowCount = (html) => (html.match(/class="row"/g) || []).length;
const widths = (html) => Array.from(html.matchAll(/width:([\d.]+)%/g)).map((match) => match[1]);

(async () => {
  await wait(80);

  const visible = stats.characters.filter((item) => item.count > 0).sort((a, b) => a.char - b.char);
  const minChar = visible[0].char;
  const maxChar = visible[visible.length - 1].char;
  const byCount = visible.slice().sort((a, b) => (b.count - a.count) || (a.char - b.char))[0];
  const firstChar = (html) => {
    const match = html.match(/class="char">(\d+)<\/span>/);
    return match ? Number(match[1]) : null;
  };
  const valueText = (number) => number.toLocaleString('zh-CN', {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  });

  assert.strictEqual(elements.revision.textContent, String(manifest.revision));
  const charMeta = elements['meta-chars'].textContent;
  assert.ok(charMeta.includes(String(stats.characterCount)) && charMeta.includes('个角色'), '角色更新提示');
  assert.ok(elements['meta-chapter'].textContent.includes(`第 ${stats.lastChapter} 话`), '话数更新提示');
  assert.ok(/最后更新 \d{4}-\d{2}-\d{2}/.test(elements['meta-updated'].textContent), '最后更新日期');
  assert.strictEqual(rowCount(elements.chart.innerHTML), visible.length, '默认显示所有有记录角色');
  assert.ok(!elements.chart.innerHTML.includes('class="rank"'), '不应再有顺序号');
  assert.ok(elements.chart.innerHTML.includes('class="char"'), '应有角色编号');
  assert.strictEqual(firstChar(elements.chart.innerHTML), minChar, '默认按角色编号升序');
  assert.ok(new Set(widths(elements.chart.innerHTML)).size > 1, '条形长度不应全部一致');
  assert.ok(!elements.chart.innerHTML.includes('<small'), '不需要百分比');
  assert.ok(elements.chart.innerHTML.includes('style="--c:#'), '每行应有角色颜色');
  assert.ok(elements['start-char'].innerHTML.includes(`value="${minChar}"`), '起始角色选项');  assert.strictEqual((elements['start-char'].innerHTML.match(/<option/g) || []).length, visible.length + 1,
    '起始角色选项数量');

  /* 积分 / 加权 */
  elements.metric.value = 'points';
  elements.metric.fire('change');
  assert.ok(!elements.chart.innerHTML.includes('class="char">#'), '编号不加 #');
  assert.ok(/\d+\.\d/.test(elements.chart.innerHTML), '积分应保留一位小数');
  assert.ok(elements.chart.innerHTML.includes(valueText(visible[0].points)), '积分应使用 points 数据');
  elements.metric.value = 'weighted';
  elements.metric.fire('change');
  assert.ok(/\d+\.\d/.test(elements.chart.innerHTML), '加权应保留一位小数');
  assert.ok(elements.chart.innerHTML.includes(valueText(visible[0].weighted)), '加权应使用 weighted 数据');
  elements.metric.value = 'count';
  elements.metric.fire('change');

  /* 排序 */
  elements.sort.value = 'data';
  elements.order.value = 'desc';
  elements.sort.fire('change');
  elements.order.fire('change');
  assert.strictEqual(firstChar(elements.chart.innerHTML), byCount.char, '按数据降序时最高角色排在前面');
  elements.sort.value = 'char';
  elements.sort.fire('change');
  assert.strictEqual(firstChar(elements.chart.innerHTML), minChar, '角色编号排序固定升序，不受数据排序方向影响');
  elements.sort.value = 'char';
  elements.order.value = 'asc';
  elements.sort.fire('change');
  elements.order.fire('change');

  /* 起始角色过滤 */
  const late = visible[visible.length - 1];
  const before = elements.chart.innerHTML;
  elements['start-char'].value = String(late.char);
  elements['start-char'].fire('change');
  const after = elements.chart.innerHTML;
  assert.notStrictEqual(after, before, '选择起始角色后统计应变化');
  assert.ok(after.includes('class="char">' + late.char + '<'), '过滤后仍应显示该角色');
  assert.ok(rowCount(after) > 0 && rowCount(after) <= visible.length, '过滤后仍有记录的角色都显示');
  assert.ok(!after.includes('class="rank"'), '过滤后仍无顺序号');

  /* 页面骨架 */
  assert.ok(pageHtml.includes('<h1>超超你的小站</h1>'), '标题');
  assert.ok(pageHtml.includes('GIRLS BALANCE'), '英文标题');
  assert.ok(pageHtml.includes('本站用于统计漫画《超超超超超喜欢你的100个女朋友》中各角色的登场情况'), '描述');
  assert.ok(pageHtml.includes('https://github.com/Xzms0/GirlsBalance'), 'GitHub 链接');
  assert.ok(pageHtml.includes('https://space.bilibili.com/235507227'), 'Bilibili 链接');
  assert.ok(pageHtml.includes('mailto:1576966800@qq.com'), '邮箱链接');
  assert.ok(!pageHtml.includes('id="search"'), '不应有搜索框');
  assert.ok(!pageHtml.includes('id="show-zero"'), '不应有 0 次角色选项');
  assert.ok(!pageHtml.includes('id="cards"'), '不应有四个统计框');
  assert.ok(!pageHtml.includes('download-stats'), '不应有下载链接');
  assert.ok(!pageHtml.includes('data/chapters/index.json'), '不应保留分话数据链接');
  assert.ok(/\.track\s*\{[^}]*display:\s*block/s.test(siteCss), '轨道需要 display:block');
  assert.ok(/\.bar\s*\{[^}]*display:\s*block/s.test(siteCss), '条形需要 display:block 才能应用宽高');
  assert.ok(elements.chart.innerHTML.includes('class="bar" style="width:'), '条形应有显式宽度');

  /* 每次重启脚本，用独立响应验证格式边界。 */
  async function rejectsData(label, overrides) {
    sandbox.fetch = (url) => {
      const clean = String(url).split('?')[0];
      const key = clean.endsWith('manifest.json') ? 'manifest'
        : clean.endsWith('stats.json') ? 'stats'
          : clean.endsWith('chapters/index.json') ? 'index' : 'colors';
      const data = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key] : { manifest, stats, index, colors }[key];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs', 'js', 'chart.js'), 'utf8'), sandbox);
    await wait(10);
    assert.ok(elements.empty.textContent.includes('读取数据失败'), label);
    assert.ok(elements.chart.classList.contains('hidden'), label + ' 应隐藏图表');
  }
  await rejectsData('拒绝manifest旧格式', { manifest: { ...manifest, formatVersion: 2 } });
  await rejectsData('拒绝manifest错误schema', { manifest: { ...manifest, schema: 'other' } });
  await rejectsData('拒绝stats错误schema', { stats: { ...stats, schema: 'other' } });
  await rejectsData('拒绝index错误schema', { index: { ...index, schema: 'other' } });
  await rejectsData('拒绝旧分片格式', { stats: { ...stats, formatVersion: 2 } });
  await rejectsData('拒绝缺失schema版本', { manifest: { ...manifest, schemaVersion: undefined } });
  await rejectsData('拒绝旧schema版本', { index: { ...index, schemaVersion: 1 } });
  await rejectsData('拒绝maxPanels别名', { stats: { ...stats, maxPanels: 1 } });
  await rejectsData('拒绝角色panels别名', { stats: {
    ...stats, characters: [{ ...stats.characters[0], panels: 1 }],
  } });
  await rejectsData('拒绝颜色数组映射', { colors: { colors: ['#fff'] } });
  await rejectsData('拒绝顶层颜色数组', { colors: ['#fff'] });

  console.log('公开统计页冒烟测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
