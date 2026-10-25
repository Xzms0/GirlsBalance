#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../server/db.js');
const site = require('../server/site_publish.js');
const sample = require('../data/sample.girls_dict.json');
const document = db.stripIds(db.normalizeDocument(sample));
const payload = site.buildPayload(document, 7);
const stats = JSON.parse(payload['stats.json']);
const index = JSON.parse(payload['chapters/index.json']);
for (const text of Object.values(payload)) {
  const data = JSON.parse(text);
  assert.strictEqual(data.schema, 'girls_dict');
  assert.strictEqual(data.schemaVersion, 2);
  assert.strictEqual(data.formatVersion, 3);
}
assert.strictEqual(stats.totalPanels, 10);
assert.strictEqual(stats.totalAppearances, 23);
assert.strictEqual(stats.maxCount, 6);
assert.strictEqual(stats.maxPoints, 1.9);
assert.strictEqual(stats.maxWeighted, 1.1);
assert.ok(!('maxPanels' in stats));
for (const row of stats.characters) assert.ok(!('panels' in row));
assert.deepStrictEqual(index.chapters[0].metrics['1'], { count: 3, points: 0.866667, weighted: 0.433333 });
for (const mutate of [
  (data) => { data.schemaVersion = 1; },
  (data) => { delete data.schemaVersion; },
  (data) => { data.chapters[0].id = 'ch-old'; },
  (data) => { data.chapters[0].panels[0].id = 'pn-old'; },
]) {
  const data = JSON.parse(JSON.stringify(document));
  mutate(data);
  assert.throws(() => site.buildPayload(data, 7), db.ValidationError);
}

const work = path.resolve(__dirname, '..', '.tmp-test-run', 'site-' + crypto.randomUUID());
fs.mkdirSync(work, { recursive: true });
try {
  const outdated = Object.assign({}, payload);
  const manifest = JSON.parse(outdated['manifest.json']);
  manifest.formatVersion = 2;
  outdated['manifest.json'] = JSON.stringify(manifest);
  site.writePayload(work, outdated);
  const database = { loadDocument: () => Object.assign(db.normalizeDocument(document), { revision: 7 }) };
  const result = site.publishSite(database, work, { exportOnly: true });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.changed, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(work, 'docs/data/manifest.json'), 'utf8')).formatVersion, 3);
} finally {
  // work is a verified test-only absolute directory under .tmp-test-run.
  assert.ok(work.startsWith(path.resolve(__dirname, '..', '.tmp-test-run') + path.sep));
  fs.rmSync(work, { recursive: true, force: true });
}
console.log('公开分片格式、严格输入及同 revision 重新导出测试通过');
