/*!
 * 超超你的小站 · 公开统计页
 *
 * 只读 docs/data 下的分片 JSON 和 docs/colors.json；不连接任何后端。
 * 统计口径：
 *   count    分镜计数
 *   points   每个分镜固定 8 分，平均分给该分镜里的角色
 *   weighted 每话按“截至该话已登场角色总数”给每个分镜计分，再平均分给角色
 */
(function () {
  'use strict';

  var FALLBACK_COLORS = ['#5eead4', '#fbbf24', '#fb7185', '#60a5fa', '#a78bfa', '#34d399', '#f97316', '#e879f9'];

  var state = {
    manifest: null,
    stats: null,
    index: null,
    colors: null,
    metric: 'count',
    sort: 'char',
    order: 'asc',
    startChar: 'all',
    loading: false,
  };

  var els = {};

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function num(value) {
    var number = Number(value);
    if (!isFinite(number)) return '—';
    return number.toLocaleString('zh-CN');
  }

  function formatValue(value, metric) {
    var number = Number(value);
    if (!isFinite(number)) number = 0;
    if (metric === 'count') return Math.round(number).toLocaleString('zh-CN');
    return number.toLocaleString('zh-CN', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }

  function formatDateOnly(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso).slice(0, 10);
    var pad = function (value) { return String(value).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function validColor(value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value);
  }

  function colorFor(char) {
    var table = (state.colors && state.colors.colors) || {};
    var value = Array.isArray(table) ? table[char] : table[String(char)];
    if (validColor(value)) return value;
    var fallback = state.colors && state.colors.fallback;
    if (validColor(fallback)) return fallback;
    return FALLBACK_COLORS[Math.abs(Number(char) || 0) % FALLBACK_COLORS.length];
  }

  function countOf(item) {
    if (item && item.count != null) return Number(item.count) || 0;
    return item && item.panels != null ? Number(item.panels) || 0 : 0;
  }

  function hasRichData() {
    var stats = state.stats || {};
    if (Number(stats.formatVersion) >= 2) return true;
    return (stats.characters || []).some(function (item) {
      return item && (item.points != null || item.weighted != null);
    });
  }

  function hasIndexMetrics() {
    var chapters = state.index && state.index.chapters;
    if (!Array.isArray(chapters) || !chapters.length) return false;
    return chapters.some(function (chapter) {
      return chapter && chapter.metrics && Object.keys(chapter.metrics).length > 0;
    });
  }

  function canFilter() {
    var characters = (state.stats && state.stats.characters) || [];
    return hasIndexMetrics() && characters.some(function (item) {
      return countOf(item) > 0 && item.firstChapter != null;
    });
  }

  function normalizeItem(item) {
    return {
      char: item.char,
      name: item.name || '',
      count: countOf(item),
      points: item.points == null ? null : Number(item.points) || 0,
      weighted: item.weighted == null ? null : Number(item.weighted) || 0,
      firstChapter: item.firstChapter == null ? null : Number(item.firstChapter),
    };
  }

  function syncMetricOptions() {
    var rich = hasRichData();
    if (els.metric && els.metric.options) {
      Array.prototype.forEach.call(els.metric.options, function (option) {
        if (option.value !== 'count') option.disabled = !rich;
      });
    }
    if (!rich) {
      state.metric = 'count';
      if (els.metric) els.metric.value = 'count';
    }
  }

  function renderWarning() {
    if (!els.warning) return;
    var rich = hasRichData();
    var filter = canFilter();
    if (rich && filter) {
      els.warning.classList.add('hidden');
      els.warning.textContent = '';
      return;
    }
    var messages = [];
    if (!rich) {
      messages.push('当前公开数据是旧版格式：计数可用；积分、加权需要重启本机服务后重新发布。');
    }
    if (!filter) {
      messages.push('起始角色筛选暂不可用，需要重新发布数据。');
    }
    els.warning.textContent = messages.join(' ');
    els.warning.classList.remove('hidden');
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + '：' + url);
      return response.json();
    });
  }

  function setLoading(value) {
    state.loading = value;
    ['metric', 'sort', 'order', 'start-char'].forEach(function (id) {
      if (!els[id]) return;
      if (id === 'start-char' && !value && !canFilter()) {
        els[id].disabled = true;
        return;
      }
      els[id].disabled = value;
    });
  }

  function showEmpty(message) {
    if (els.empty) {
      els.empty.textContent = message;
      els.empty.classList.remove('hidden');
    }
    if (els.chart) els.chart.classList.add('hidden');
    if (els['meta-chars']) els['meta-chars'].textContent = '尚无数据';
    if (els['meta-chapter']) els['meta-chapter'].textContent = '';
    if (els['meta-updated']) els['meta-updated'].textContent = '';
    if (els['start-char']) {
      els['start-char'].innerHTML = '<option value="all">从最初开始</option>';
      els['start-char'].disabled = true;
    }
    if (els.warning) els.warning.classList.add('hidden');
  }

  function hideEmpty() {
    if (els.empty) els.empty.classList.add('hidden');
    if (els.chart) els.chart.classList.remove('hidden');
  }

  function load(options) {
    var quiet = options && options.quiet;
    if (state.loading) return Promise.resolve();
    setLoading(true);
    if (!quiet && els['meta-chars']) els['meta-chars'].textContent = '正在读取…';
    return fetchJson('data/manifest.json?t=' + Date.now())
      .then(function (manifest) {
        state.manifest = manifest;
        var version = encodeURIComponent(manifest.revision == null ? Date.now() : manifest.revision);
        var statsPromise = fetchJson('data/stats.json?v=' + version);
        var indexPromise = fetchJson('data/chapters/index.json?v=' + version)
          .catch(function () { return null; });
        var colorsPromise = fetchJson('colors.json?t=' + Date.now())
          .catch(function () { return null; });
        return Promise.all([statsPromise, indexPromise, colorsPromise]).then(function (results) {
          state.stats = results[0];
          state.index = results[1];
          state.colors = results[2];
          renderAll();
          hideEmpty();
        });
      })
      .catch(function (error) {
        if (!quiet) {
          showEmpty('读取数据失败：' + (error && error.message ? error.message : error) +
            '。请确认已经发布过 docs/data。');
        }
      })
      .then(function () { setLoading(false); });
  }

  function renderAll() {
    syncMetricOptions();
    renderWarning();
    renderMeta();
    renderStartOptions();
    renderChart();
  }

  function renderMeta() {
    var manifest = state.manifest || {};
    var stats = state.stats || {};
    var characters = Array.isArray(stats.characters) ? stats.characters : [];
    var characterCount = Number(stats.characterCount);
    if (!isFinite(characterCount) || characterCount <= 0) {
      characterCount = characters.filter(function (item) { return countOf(item) > 0; }).length;
    }
    var lastChapter = Number(stats.lastChapter);
    if (!isFinite(lastChapter) || lastChapter <= 0) {
      var chapters = state.index && state.index.chapters;
      lastChapter = Array.isArray(chapters) && chapters.length
        ? chapters.reduce(function (max, chapter) { return Math.max(max, Number(chapter.no) || 0); }, 0)
        : 0;
    }
    if (els['meta-chars']) els['meta-chars'].textContent = '更新至第 ' + num(characterCount) + ' 个角色';
    if (els['meta-chapter']) els['meta-chapter'].textContent = '更新至第 ' + num(lastChapter) + ' 话';
    if (els['meta-updated']) els['meta-updated'].textContent = '最后更新 ' + formatDateOnly(manifest.exportedAt);
    if (els.revision) els.revision.textContent = manifest.revision == null ? '—' : String(manifest.revision);
  }

  function renderStartOptions() {
    if (!els['start-char']) return;
    if (!canFilter()) {
      els['start-char'].innerHTML = '<option value="all">从最初开始</option>';
      els['start-char'].value = 'all';
      els['start-char'].disabled = true;
      state.startChar = 'all';
      return;
    }
    var stats = state.stats || {};
    var characters = (Array.isArray(stats.characters) ? stats.characters : [])
      .filter(function (item) { return countOf(item) > 0 && item.firstChapter != null; })
      .sort(function (a, b) { return a.char - b.char; });

    var html = '<option value="all">从最初开始</option>';
    characters.forEach(function (item) {
      var name = item.name ? ' ' + item.name : '';
      html += '<option value="' + esc(item.char) + '">' + esc(item.char) + esc(name) +
        ' · 第 ' + esc(item.firstChapter) + ' 话</option>';
    });
    els['start-char'].innerHTML = html;

    var exists = characters.some(function (item) { return String(item.char) === state.startChar; });
    if (!exists) state.startChar = 'all';
    els['start-char'].value = state.startChar;
    els['start-char'].disabled = false;
  }

  function aggregateFromIndex(startChapter) {
    var totals = {};
    var chapters = state.index && state.index.chapters ? state.index.chapters : [];
    chapters.forEach(function (chapter) {
      if (Number(chapter.no) < startChapter) return;
      var metrics = chapter.metrics || {};
      Object.keys(metrics).forEach(function (key) {
        var metric = metrics[key] || {};
        if (!totals[key]) totals[key] = { count: 0, points: 0, weighted: 0 };
        totals[key].count += Number(metric.count) || 0;
        totals[key].points += Number(metric.points) || 0;
        totals[key].weighted += Number(metric.weighted) || 0;
      });
    });

    var stats = state.stats || {};
    return (Array.isArray(stats.characters) ? stats.characters : []).map(function (item) {
      var row = normalizeItem(item);
      var total = totals[String(row.char)];
      row.count = total ? total.count : 0;
      row.points = total ? total.points : 0;
      row.weighted = total ? total.weighted : 0;
      return row;
    });
  }

  function currentRows() {
    var stats = state.stats || {};
    var characters = (Array.isArray(stats.characters) ? stats.characters : []).map(normalizeItem);
    if (state.startChar !== 'all' && canFilter()) {
      var selected = null;
      characters.forEach(function (item) {
        if (String(item.char) === state.startChar) selected = item;
      });
      if (selected && selected.firstChapter != null) {
        return aggregateFromIndex(Number(selected.firstChapter));
      }
    }
    return characters;
  }

  function renderChart() {
    if (!els.chart) return;
    var rows = currentRows()
      .filter(function (item) { return Number(item.count) > 0; })
      .map(function (item) {
        return {
          char: item.char,
          name: item.name || '',
          firstChapter: item.firstChapter,
          value: Number(item[state.metric]) || 0,
        };
      });

    if (!rows.length) {
      els.chart.innerHTML = '<p class="empty">这个范围还没有角色记录。</p>';
      return;
    }

    rows.sort(function (a, b) {
      if (state.sort === 'data') {
        var diff = a.value - b.value;
        if (diff !== 0) return state.order === 'asc' ? diff : -diff;
        return a.char - b.char;
      }
      return state.order === 'asc' ? a.char - b.char : b.char - a.char;
    });

    var max = rows.reduce(function (highest, item) {
      return Math.max(highest, item.value);
    }, 0);

    els.chart.innerHTML = rows.map(function (item) {
      var width = max > 0 ? (item.value / max) * 100 : 0;
      var color = colorFor(item.char);
      var name = item.name || '';
      var label = '角色 ' + item.char + (item.name ? ' ' + item.name : '') +
        ' · ' + formatValue(item.value, state.metric);
      return '<div class="row" role="listitem" style="--c:' + color + '" ' +
        'title="' + esc(label) + '" aria-label="' + esc(label) + '">' +
        '<span class="char">' + esc(item.char) + '</span>' +
        '<span class="name' + (name ? '' : ' empty-name') + '">' + esc(name) + '</span>' +
        '<span class="track"><span class="bar" style="width:' + width.toFixed(2) +
        '%;background:' + color + '"></span></span>' +
        '<span class="value">' + esc(formatValue(item.value, state.metric)) + '</span>' +
        '</div>';
    }).join('');
  }

  function poll() {
    if (document.hidden || state.loading || !state.manifest) return;
    fetchJson('data/manifest.json?t=' + Date.now()).then(function (manifest) {
      if (manifest.revision !== state.manifest.revision) load({ quiet: true });
    }).catch(function () { /* 下次再试 */ });
  }

  function bind() {
    els['meta-chars'] = $('meta-chars');
    els['meta-chapter'] = $('meta-chapter');
    els['meta-updated'] = $('meta-updated');
    els.revision = $('revision');
    els.metric = $('metric');
    els.sort = $('sort');
    els.order = $('order');
    els['start-char'] = $('start-char');
    els.chart = $('chart');
    els.empty = $('empty');
    els.warning = $('format-warning');

    if (els.metric) {
      els.metric.addEventListener('change', function () {
        state.metric = els.metric.value;
        renderChart();
      });
    }
    if (els.sort) {
      els.sort.addEventListener('change', function () {
        state.sort = els.sort.value;
        renderChart();
      });
    }
    if (els.order) {
      els.order.addEventListener('change', function () {
        state.order = els.order.value;
        renderChart();
      });
    }
    if (els['start-char']) {
      els['start-char'].addEventListener('change', function () {
        state.startChar = els['start-char'].value;
        renderChart();
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll();
    });
    window.setInterval(poll, 60000);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
}());
