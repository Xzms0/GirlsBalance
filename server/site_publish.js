'use strict';
/**
 * 把 SQLite 数据导出为 docs/data 下的分片 JSON，并可选提交/推送。
 *
 * 与 server/site_publish.py 输出同一份格式：
 *   docs/data/manifest.json
 *   docs/data/stats.json
 *   docs/data/chapters/index.json
 *   docs/data/chapters/0001.json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const db = require('./db.js');
const pretty = require('./json_pretty.js');

const SITE_DIR = 'docs';
const DATA_DIR = path.join(SITE_DIR, 'data');
const CHAPTER_DIR = path.join(DATA_DIR, 'chapters');
const GIT_TIMEOUT = 90000;
const MAX_OUTPUT = 4000;
const SITE_FORMAT_VERSION = 2;
const DEFAULT_MESSAGE = 'data: rev {revision}（{chapters} 话 / {panels} 分镜）';

let busy = false;

class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

function json(value) {
  return pretty.stringify(value);
}

function short(text) {
  const value = String(text || '').trim();
  return value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value;
}

function buildPayload(document, revision) {
  const meta = document.meta || {};
  const names = {};
  Object.keys(meta.charNames || {}).forEach((key) => { names[String(key)] = String(meta.charNames[key]); });
  const exportedAt = String(document.exportedAt || '');
  const chapters = document.chapters || [];

  const totals = {};
  const firstChapter = {};
  const seenChars = new Set();
  let totalPanels = 0;
  let totalAppearances = 0;
  const chapterRows = [];
  const chapterFiles = {};

  chapters.forEach((chapter, index) => {
    const no = Number(chapter.no) || (index + 1);
    const panels = chapter.panels || [];
    const panelRows = [];
    const chapterChars = new Set();
    panels.forEach((panel) => {
      const chars = Array.from(new Set((panel.chars || []).map((char) => Number(char)))).sort((a, b) => a - b);
      panelRows.push({ chars });
      chars.forEach((char) => chapterChars.add(char));
    });

    const characters = Array.from(chapterChars).sort((a, b) => a - b);
    characters.forEach((char) => {
      if (firstChapter[char] === undefined) firstChapter[char] = no;
      seenChars.add(char);
    });
    const weight = seenChars.size;

    const chapterMetrics = {};
    let chapterAppearances = 0;
    panelRows.forEach((panel) => {
      const chars = panel.chars;
      const count = chars.length;
      chapterAppearances += count;
      if (!count) return;
      const pointEach = 8 / 10 / count;
      const weightedEach = (weight / 10) / count;
      chars.forEach((char) => {
        if (!chapterMetrics[char]) chapterMetrics[char] = { count: 0, points: 0, weighted: 0 };
        chapterMetrics[char].count += 1;
        chapterMetrics[char].points += pointEach;
        chapterMetrics[char].weighted += weightedEach;
        if (!totals[char]) totals[char] = { count: 0, points: 0, weighted: 0 };
        totals[char].count += 1;
        totals[char].points += pointEach;
        totals[char].weighted += weightedEach;
      });
    });

    totalPanels += panelRows.length;
    totalAppearances += chapterAppearances;
    const metrics = {};
    Object.keys(chapterMetrics).map(Number).sort((a, b) => a - b).forEach((char) => {
      const metric = chapterMetrics[char];
      metrics[String(char)] = {
        count: metric.count,
        points: Number(metric.points.toFixed(6)),
        weighted: Number(metric.weighted.toFixed(6)),
      };
    });
    const filename = `${String(no).padStart(4, '0')}.json`;
    chapterRows.push({
      no,
      title: String(chapter.title || ''),
      note: String(chapter.note || ''),
      panelCount: panelRows.length,
      appearances: chapterAppearances,
      characters,
      weight,
      metrics,
      file: filename,
    });
    chapterFiles[`chapters/${filename}`] = json({
      schema: db.SCHEMA_NAME,
      schemaVersion: db.EXPORT_VERSION,
      no,
      title: String(chapter.title || ''),
      note: String(chapter.note || ''),
      panelCount: panelRows.length,
      appearances: chapterAppearances,
      characters,
      panels: panelRows,
    });
  });

  const characters = [];
  for (let char = db.CHAR_MIN; char <= db.CHAR_MAX; char += 1) {
    const total = totals[char];
    const count = total ? total.count : 0;
    characters.push({
      char,
      name: names[String(char)] || '',
      count,
      panels: count,
      points: total ? Number(total.points.toFixed(1)) : 0,
      weighted: total ? Number(total.weighted.toFixed(1)) : 0,
      firstChapter: firstChapter[char] === undefined ? null : firstChapter[char],
    });
  }
  const characterCount = characters.filter((item) => item.count > 0).length;
  const lastChapter = chapterRows.reduce((max, row) => Math.max(max, row.no), 0);
  const maxCount = characters.reduce((max, item) => Math.max(max, item.count), 0);
  const maxPoints = characters.reduce((max, item) => Math.max(max, item.points), 0);
  const maxWeighted = characters.reduce((max, item) => Math.max(max, item.weighted), 0);

  const stats = {
    schema: db.SCHEMA_NAME,
    schemaVersion: db.EXPORT_VERSION,
    formatVersion: SITE_FORMAT_VERSION,
    revision,
    exportedAt,
    totalChapters: chapters.length,
    totalPanels,
    totalAppearances,
    characterCount,
    lastChapter,
    maxCount,
    maxPoints,
    maxWeighted,
    maxPanels: maxCount,
    characters,
  };
  const chapterIndex = {
    schema: db.SCHEMA_NAME,
    schemaVersion: db.EXPORT_VERSION,
    formatVersion: SITE_FORMAT_VERSION,
    revision,
    exportedAt,
    chapters: chapterRows,
  };
  const manifest = {
    schema: db.SCHEMA_NAME,
    schemaVersion: db.EXPORT_VERSION,
    formatVersion: SITE_FORMAT_VERSION,
    revision,
    exportedAt,
    title: String(meta.title || '超超你的字典'),
    author: String(meta.author || ''),
    counts: {
      chapters: chapters.length,
      panels: totalPanels,
      appearances: totalAppearances,
      characters: characterCount,
      charMin: db.CHAR_MIN,
      charMax: db.CHAR_MAX,
    },
    files: {
      stats: 'stats.json',
      chapters: 'chapters/index.json',
    },
  };

  return Object.assign({
    'manifest.json': json(manifest),
    'stats.json': json(stats),
    'chapters/index.json': json(chapterIndex),
  }, chapterFiles);
}

function writeText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, target);
}

function writePayload(root, payload) {
  const dataDir = path.join(root, DATA_DIR);
  const chapterDir = path.join(dataDir, 'chapters');
  if (fs.existsSync(chapterDir)) {
    fs.readdirSync(chapterDir).filter((name) => name.endsWith('.json')).forEach((name) => {
      fs.rmSync(path.join(chapterDir, name), { force: true });
    });
  }
  fs.mkdirSync(chapterDir, { recursive: true });
  Object.keys(payload).forEach((relative) => {
    if (relative === 'manifest.json') return;
    writeText(path.join(dataDir, relative), payload[relative]);
  });
  writeText(path.join(dataDir, 'manifest.json'), payload['manifest.json']);
  return Object.keys(payload).sort();
}

function readManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, DATA_DIR, 'manifest.json'), 'utf8'));
  } catch (error) {
    return null;
  }
}

function filesExist(root) {
  return fs.existsSync(path.join(root, DATA_DIR, 'stats.json'))
    && fs.existsSync(path.join(root, DATA_DIR, 'chapters', 'index.json'));
}

/* -------------------------------------------------------------------------- *
 * Git
 * -------------------------------------------------------------------------- */
function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new PublishError('找不到 git 命令，请先安装 Git');
    throw new PublishError(`git 命令失败：${result.error.message}`);
  }
  return result;
}

function gitInfo(root) {
  const version = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (version.error || version.status !== 0) {
    return { available: false, isRepo: false, reason: '找不到 git 命令' };
  }
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    return { available: true, isRepo: false, reason: '当前目录不是 Git 仓库' };
  }
  const resolvedTop = path.resolve(top.stdout.trim());
  const isRepo = process.platform === 'win32'
    ? resolvedTop.toLowerCase() === root.toLowerCase()
    : resolvedTop === root;
  if (!isRepo) {
    return { available: true, isRepo: false, reason: '项目目录不是独立的 Git 仓库根目录' };
  }
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const ahead = git(root, ['rev-list', '--count', '@{u}..HEAD']);
  const status = git(root, ['status', '--porcelain', '--', 'docs/data']);
  const remotes = git(root, ['remote']);
  return {
    available: true,
    isRepo: true,
    root,
    branch: branch.status === 0 ? branch.stdout.trim() : '',
    ahead: ahead.status === 0 && /^\d+$/.test(ahead.stdout.trim()) ? Number(ahead.stdout.trim()) : 0,
    hasUpstream: ahead.status === 0,
    dirty: status.status === 0 && Boolean(status.stdout.trim()),
    remotes: remotes.status === 0 ? remotes.stdout.split(/\r?\n/).filter(Boolean) : [],
  };
}

function aheadCount(root) {
  const result = git(root, ['rev-list', '--count', '@{u}..HEAD']);
  return result.status === 0 && /^\d+$/.test(result.stdout.trim()) ? Number(result.stdout.trim()) : 0;
}

function push(root) {
  let result = git(root, ['push']);
  if (result.status === 0) return { ok: true, output: short(result.stdout + result.stderr) };
  let error = result.stderr || result.stdout || 'git push 失败';
  if (error.includes('has no upstream branch') || error.includes('no upstream')) {
    result = git(root, ['push', '-u', 'origin', 'HEAD']);
    if (result.status === 0) return { ok: true, output: short(result.stdout + result.stderr) };
    error = result.stderr || result.stdout || error;
  }
  return { ok: false, error: short(error) };
}

function pushIfAhead(root, doPush) {
  if (!doPush) return null;
  const info = gitInfo(root);
  if (!info.isRepo) return null;
  if (info.hasUpstream) {
    if (aheadCount(root) <= 0) return null;
  } else if (!info.remotes || info.remotes.length === 0) {
    return null;
  } else if (git(root, ['rev-parse', '--verify', 'HEAD']).status !== 0) {
    return null;
  }
  const pushed = push(root);
  if (pushed.ok) return { ok: true, changed: false, pushed: true };
  return { ok: false, changed: false, pushed: false, error: pushed.error };
}

function publishStatus(root) {
  const manifest = readManifest(root);
  const info = gitInfo(root);
  if (!manifest) return { ok: true, published: false, git: info };
  return {
    ok: true,
    published: true,
    revision: manifest.revision,
    exportedAt: manifest.exportedAt,
    counts: manifest.counts || {},
    git: info,
  };
}

function publishSite(database, root, options) {
  const settings = options || {};
  const exportOnly = Boolean(settings.exportOnly);
  const doPush = settings.push !== false;
  const force = Boolean(settings.force);
  const message = String(settings.message || '');
  if (busy) return { ok: false, error: '正在发布，请稍候再试' };
  busy = true;
  try {
    return publishNow(database, root, message, exportOnly, doPush, force);
  } catch (error) {
    return { ok: false, error: error instanceof PublishError ? error.message : `发布失败：${error.message}` };
  } finally {
    busy = false;
  }
}

function publishNow(database, root, message, exportOnly, doPush, force) {
  const info = exportOnly ? null : gitInfo(root);
  if (!exportOnly && info && !info.isRepo) {
    return {
      ok: false,
      error: `${info.reason || '当前目录不是 Git 仓库'}。请先在项目根目录执行 git init，并配置 origin。`,
      git: info,
    };
  }

  const document = database.loadDocument();
  const revision = Number(document.revision) || 0;
  const existing = readManifest(root);
  const dbPanels = (document.chapters || [])
    .reduce((total, chapter) => total + (chapter.panels || []).length, 0);
  const existingCounts = (existing && existing.counts) || {};
  if (dbPanels === 0 && Number(existingCounts.panels || 0) > 0 && !force) {
    return {
      ok: false,
      error: `当前数据库是空的，但公开数据里已经有 ${existingCounts.panels} 个分镜。` +
        '为防止误覆盖，已拒绝发布；确实要清空请用命令行 --force。',
      revision,
      counts: existingCounts,
    };
  }
  if (existing && Number(existing.revision) === revision && filesExist(root) && !(info && info.dirty) && !force) {
    if (exportOnly) {
      return { ok: true, changed: false, revision, exportedAt: existing.exportedAt, counts: existing.counts || {} };
    }
    if (doPush) {
      const aheadResult = pushIfAhead(root, doPush);
      if (aheadResult) {
        aheadResult.revision = revision;
        aheadResult.counts = existing.counts || {};
        if (aheadResult.ok) {
          const hash = git(root, ['rev-parse', '--short', 'HEAD']);
          aheadResult.commit = hash.status === 0 ? hash.stdout.trim() : '';
        }
        return aheadResult;
      }
    }
    return { ok: true, changed: false, revision, exportedAt: existing.exportedAt, counts: existing.counts || {}, git: info };
  }

  const exported = db.stripIds(document);
  const payload = buildPayload(exported, revision);
  writePayload(root, payload);
  const manifest = JSON.parse(payload['manifest.json']);

  if (exportOnly) {
    return {
      ok: true,
      changed: true,
      revision,
      exportedAt: exported.exportedAt,
      files: Object.keys(payload).length,
      counts: manifest.counts,
    };
  }

  const add = git(root, ['add', '--', 'docs/data']);
  if (add.status !== 0) {
    return { ok: false, changed: true, revision, error: short(add.stderr || add.stdout || 'git add 失败') };
  }
  const diff = git(root, ['diff', '--cached', '--quiet', '--', 'docs/data']);
  if (diff.status === 0) {
    const aheadResult = pushIfAhead(root, doPush);
    if (aheadResult) {
      aheadResult.revision = revision;
      if (aheadResult.ok) {
        const hash = git(root, ['rev-parse', '--short', 'HEAD']);
        aheadResult.commit = hash.status === 0 ? hash.stdout.trim() : '';
      }
      return aheadResult;
    }
    return { ok: true, changed: false, revision, exportedAt: exported.exportedAt, counts: manifest.counts, git: gitInfo(root) };
  }
  if (diff.status !== 1) {
    return { ok: false, changed: true, revision, error: short(diff.stderr || diff.stdout || 'git diff 失败') };
  }

  const commitMessage = (message || DEFAULT_MESSAGE)
    .replace('{revision}', String(revision))
    .replace('{chapters}', String(manifest.counts.chapters))
    .replace('{panels}', String(manifest.counts.panels));
  const commit = git(root, ['commit', '--only', '-m', commitMessage, '--', 'docs/data']);
  if (commit.status !== 0) {
    return {
      ok: false,
      changed: true,
      revision,
      error: `${short(commit.stderr || commit.stdout || 'git commit 失败')}\n提示：如果提示作者身份未知，请先配置 git config user.name / user.email。`,
    };
  }
  const hash = git(root, ['rev-parse', '--short', 'HEAD']);
  const commitHash = hash.status === 0 ? hash.stdout.trim() : '';

  if (doPush) {
    const pushed = push(root);
    if (!pushed.ok) {
      return {
        ok: false,
        changed: true,
        committed: true,
        pushed: false,
        revision,
        commit: commitHash,
        counts: manifest.counts,
        error: `${pushed.error}\n提交已经保存在本地，修好网络或远端后再次点击发布即可补推。`,
      };
    }
    return {
      ok: true,
      changed: true,
      committed: true,
      pushed: true,
      revision,
      commit: commitHash,
      exportedAt: exported.exportedAt,
      counts: manifest.counts,
      git: gitInfo(root),
    };
  }

  return {
    ok: true,
    changed: true,
    committed: true,
    pushed: false,
    revision,
    commit: commitHash,
    exportedAt: exported.exportedAt,
    counts: manifest.counts,
    git: gitInfo(root),
  };
}

module.exports = {
  PublishError,
  SITE_FORMAT_VERSION,
  buildPayload,
  writePayload,
  publishSite,
  publishStatus,
  gitInfo,
};
