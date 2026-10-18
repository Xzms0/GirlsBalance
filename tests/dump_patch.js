#!/usr/bin/env node
/**
 * 生成一份「客户端补丁」样本，交给 tests/test_patch_contract.py 去喂给真正的 SQLite 服务端。
 *
 * 这个脚本本身不做断言，只输出 JSON：
 *   { before: 改动前的完整文档（带 id）, ops: 浏览器端算出来的补丁, after: 改动后应当得到的文档 }
 *
 * 用途：验证「界面生成的补丁」和「数据库理解的补丁」是同一套语言。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const sandbox = { window: { crypto: crypto.webcrypto }, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'model.js'), 'utf8'), sandbox,
  { filename: 'public/js/model.js' });
const model = sandbox.window.GD.model;

const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sample.girls_dict.json'), 'utf8'));
const before = model.normalizeDb(sample).db;
const baseline = model.fingerprints(before);

/* --- 一串有代表性的改动：改编号、改标题、加话、删槽位、换顺序、改角色名 ------ */
const after = model.clone(before);

// 1) 改一个槽位的编号（去重排序交给模型）
after.chapters[0].panels[1].chars = [30, 5, 5, 0];
// 2) 改标题与备注
after.chapters[1].title = '改过的标题';
after.chapters[1].note = '补一条备注';
// 3) 新增一话，插到中间，自带两个槽位
const created = model.newChapter(3, '插入的新一话');
created.panels = [model.newPanel([7, 8]), model.newPanel([])];
after.chapters.splice(1, 0, created);
// 4) 删掉一个槽位
const removedPanel = after.chapters[3].panels.pop();
// 5) 交换第 1、3 话的顺序
model.swapChapters(after, 0, 2);
// 6) 角色名与元信息
after.meta.charNames['30'] = '新角色';
delete after.meta.charNames['23'];
after.meta.author = '测试者';

// 真实界面里每次改动都会过一遍规范化（去重、升序、重排话编号），这里保持一致
const normalized = model.normalizeDb(after).db;
const patch = model.buildPatch(normalized, baseline);

process.stdout.write(JSON.stringify({
  before: before,
  ops: patch.ops,
  after: normalized,
  removedPanelId: removedPanel.id,
}, null, 2));
