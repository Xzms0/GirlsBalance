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
  assert.strictEqual(data.formatVersion, 4);
}
assert.strictEqual(stats.totalPanels, 10);
assert.strictEqual(stats.totalAppearances, 23);
assert.strictEqual(stats.maxCount, 6);
assert.strictEqual(stats.maxPoints, 1.9);
assert.strictEqual(stats.maxWeighted, 1.1);
assert.strictEqual(stats.maxDensity, 27.39);
assert.ok(!('maxPanels' in stats));
for (const row of stats.characters) assert.ok(!('panels' in row));
const byChar = {};
for (const row of stats.characters) byChar[row.char] = row;
assert.deepStrictEqual(
  { 1: byChar[1].density, 2: byChar[2].density, 5: byChar[5].density,
    12: byChar[12].density, 23: byChar[23].density, 100: byChar[100].density },
  { 1: 23.33, 2: 18.33, 5: 15.83, 12: 16.14, 23: 15.0, 100: 27.39 },
);
assert.deepStrictEqual(index.chapters[0].metrics['1'], { count: 3, points: 0.866667, weighted: 0.433333 });

const withPlaceholder = JSON.parse(JSON.stringify(document));
withPlaceholder.chapters.push({
  no: withPlaceholder.chapters.length + 1,
  title: '占位',
  note: '',
  panels: [{ chars: [] }, { chars: [] }],
});
const placeholderPayload = site.buildPayload(withPlaceholder, 7);
const placeholderStats = JSON.parse(placeholderPayload['stats.json']);
const placeholderIndex = JSON.parse(placeholderPayload['chapters/index.json']);
assert.strictEqual(placeholderStats.totalChapters, 3);
assert.strictEqual(placeholderStats.lastChapter, 3);
assert.strictEqual(placeholderStats.totalPanels, 10);
assert.strictEqual(placeholderIndex.chapters.length, 3);
assert.ok(!('chapters/0004.json' in placeholderPayload));

const withMiddleGap = JSON.parse(JSON.stringify(document));
withMiddleGap.chapters[1].panels = [{ chars: [] }];
const gapPayload = site.buildPayload(withMiddleGap, 7);
const gapStats = JSON.parse(gapPayload['stats.json']);
const gapIndex = JSON.parse(gapPayload['chapters/index.json']);
assert.deepStrictEqual(gapIndex.chapters.map((chapter) => chapter.no), [1, 3]);
assert.strictEqual(gapStats.totalChapters, 2);
assert.strictEqual(gapStats.lastChapter, 3);
assert.ok(!('chapters/0002.json' in gapPayload));

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
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(work, 'docs/data/manifest.json'), 'utf8')).formatVersion, 4);
} finally {
  // work is a verified test-only absolute directory under .tmp-test-run.
  assert.ok(work.startsWith(path.resolve(__dirname, '..', '.tmp-test-run') + path.sep));
  fs.rmSync(work, { recursive: true, force: true });
}

const placeholderWork = path.resolve(__dirname, '..', '.tmp-test-run', 'placeholders-' + crypto.randomUUID());
fs.mkdirSync(placeholderWork, { recursive: true });
try {
  site.writePayload(placeholderWork, payload);
  const placeholderDoc = JSON.parse(JSON.stringify(document));
  for (const chapter of placeholderDoc.chapters) chapter.panels = [{ chars: [] }];
  const database = { loadDocument: () => Object.assign(placeholderDoc, { revision: 8 }) };
  const refused = site.publishSite(database, placeholderWork, { exportOnly: true });
  assert.strictEqual(refused.ok, false, '只有占位话时不应发布');
  assert.ok(refused.error.includes('没有可发布的角色数据'), refused.error);
  const forced = site.publishSite(database, placeholderWork, { exportOnly: true, force: true });
  assert.strictEqual(forced.ok, true, JSON.stringify(forced));
  assert.strictEqual(forced.counts.chapters, 0);
} finally {
  assert.ok(placeholderWork.startsWith(path.resolve(__dirname, '..', '.tmp-test-run') + path.sep));
  fs.rmSync(placeholderWork, { recursive: true, force: true });
}
console.log('公开分片格式、严格输入及同 revision 重新导出测试通过');
