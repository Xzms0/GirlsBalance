/*!
 * 超超你的小站 · 公开统计页
 *
 * 只读 docs/data 下的分片 JSON 和 docs/colors.json；不连接任何后端。
 * 数据格式固定为 formatVersion=4、schemaVersion=2。
 *
 * 统计口径：
 *   count    分镜计数
 *   points   每个分镜 8 分除以 10，再平均分给该分镜里的角色
 *   weighted 每话按“截至该话已登场角色总数 / 10”给每个分镜计分，再平均分给角色
 *   density  份额密度：份额 = points / 0.8；跨度按话计算，
 *            first = 首次出场话，last = 最新发布话
 *            density = 份额 / 跨度分镜数 × (跨度分镜数 / 区间分镜数)^0.5 × 100
 */
(function () {
  'use strict';

  var DATA_FORMAT = 4;
  var DENSITY_ALPHA = 0.5;   // composite_share 的指数，来自原统计脚本
  var POINTS_TO_SHARE = 1 / 0.8;  // points 已整体除以 10；份额 = points / 0.8

  // 条形长度算法。以后想换显示方式，只改这一行：
  //   'min10' —— 线性：最小值 10%，最大值 100%（当前默认）
  //   'ratio' —— 旧版：value / max × 100，最小值可能贴近 0
  //   'log'   —— 对数刻度：拉开低值差距、压缩高值，适合长尾数据
  //   'sqrt'  —— 平方根刻度：介于线性和对数之间的折中
  var BAR_SCALE_MODE = 'sqrt';
  var FALLBACK_COLORS = ['#5eead4', '#fbbf24', '#fb7185', '#60a5fa', '#a78bfa', '#34d399', '#f97316', '#e879f9'];

  var state = {
    manifest: null,
    stats: null,
    index: null,
    colors: null,
    metric: 'count',
    sort: 'char',
    order: 'asc',
    scope: 'all',
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
    if (metric === 'density') {
      return number.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + '%';
    }
    return number.toLocaleString('zh-CN', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }

  /**
   * 计算条形宽度（百分比）。算法由文件顶部的 BAR_SCALE_MODE 决定：
   *   min10（默认）：线性映射到 10–100；所有值相等时统一 100。
   *   ratio（旧版）：value / max × 100；max ≤ 0 时为 0。
   *   log：先取对数再映射到 10–100；低值之间的差距更明显，高值会被压缩。
   *   sqrt：先开平方再映射到 10–100；效果介于线性和对数之间。
   * 对数/平方根在无法计算时（0 或负数）自动退回线性，避免出现 NaN。
   */
  function barWidth(value, min, max) {
    if (max <= 0) return 0;
    if (BAR_SCALE_MODE === 'ratio') return (value / max) * 100;
    if (max === min) return 100;
    var ratio;
    if (BAR_SCALE_MODE === 'log') {
      ratio = (min > 0 && value > 0)
        ? (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min))
        : (value - min) / (max - min);
    } else if (BAR_SCALE_MODE === 'sqrt') {
      ratio = min >= 0
        ? (Math.sqrt(value) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min))
        : (value - min) / (max - min);
    } else {
      ratio = (value - min) / (max - min);
    }
    return 10 + ratio * 90;
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
    var value = table[String(char)];
    if (validColor(value)) return value;
    var fallback = state.colors && state.colors.fallback;
    if (validColor(fallback)) return fallback;
    return FALLBACK_COLORS[Math.abs(Number(char) || 0) % FALLBACK_COLORS.length];
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + '：' + url);
      return response.json();
    });
  }

  function setLoading(value) {
    state.loading = value;
    ['metric', 'sort', 'scope', 'start-char'].forEach(function (id) {
      if (els[id]) els[id].disabled = value;
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
        if (!manifest || manifest.schema !== 'girls_dict' || manifest.schemaVersion !== 2 || manifest.formatVersion !== DATA_FORMAT) {
          throw new Error('公开数据需要 girls_dict、schemaVersion=2、formatVersion=' + DATA_FORMAT);
        }
        state.manifest = manifest;
        // formatVersion 参与缓存 key：同 revision、不同格式时不会命中旧缓存
        var version = DATA_FORMAT + '-' + encodeURIComponent(
          manifest.revision == null ? Date.now() : manifest.revision
        );
        var statsPromise = fetchJson('data/stats.json?v=' + version);
        var indexPromise = fetchJson('data/chapters/index.json?v=' + version);
        var colorsPromise = fetchJson('colors.json?t=' + Date.now())
          .catch(function () { return null; });
        return Promise.all([statsPromise, indexPromise, colorsPromise]).then(function (results) {
          var stats = results[0];
          var index = results[1];
          if (!stats || stats.formatVersion !== DATA_FORMAT) {
            throw new Error('公开数据格式不匹配（需要 formatVersion=' + DATA_FORMAT + '），请重启本机服务后重新发布。');
          }
          if (!index || index.formatVersion !== DATA_FORMAT) {
            throw new Error('章节数据格式不匹配，请重启本机服务后重新发布。');
          }
          if (stats.schema !== 'girls_dict' || index.schema !== 'girls_dict' || stats.schemaVersion !== 2 || index.schemaVersion !== 2) {
            throw new Error('分片需要 girls_dict、schemaVersion=2');
          }
          if (!Array.isArray(stats.characters) || !Array.isArray(index.chapters) ||
              Object.prototype.hasOwnProperty.call(stats, 'maxPanels') || Object.prototype.hasOwnProperty.call(stats, 'panels') ||
              typeof stats.maxDensity !== 'number') throw new Error('统计字段不合法');
          stats.characters.forEach(function (item) {
            if (!item || Object.prototype.hasOwnProperty.call(item, 'panels') || Object.prototype.hasOwnProperty.call(item, 'maxPanels') ||
                typeof item.count !== 'number' || typeof item.points !== 'number' ||
                typeof item.weighted !== 'number' || typeof item.density !== 'number') {
              throw new Error('角色统计必须使用 count/points/weighted/density');
            }
          });
          index.chapters.forEach(function (chapter) {
            if (Object.prototype.hasOwnProperty.call(chapter, 'panels') || Object.prototype.hasOwnProperty.call(chapter, 'maxPanels')) throw new Error('章节统计字段不合法');
            if (!chapter.metrics || typeof chapter.metrics !== 'object' || Array.isArray(chapter.metrics)) throw new Error('章节缺少 metrics');
            Object.keys(chapter.metrics).forEach(function (key) {
              var metric = chapter.metrics[key];
              if (!metric || Object.prototype.hasOwnProperty.call(metric, 'panels') || Object.prototype.hasOwnProperty.call(metric, 'maxPanels') ||
                  typeof metric.count !== 'number' || typeof metric.points !== 'number' || typeof metric.weighted !== 'number') {
                throw new Error('章节统计必须使用 count/points/weighted');
              }
            });
          });
          var colors = results[2];
          if (colors !== null && (!colors || typeof colors !== 'object' || Array.isArray(colors) ||
              !colors.colors || typeof colors.colors !== 'object' || Array.isArray(colors.colors))) {
            throw new Error('颜色配置必须使用 colors 对象映射');
          }
          state.stats = stats;
          state.index = index;
          state.colors = results[2];
          renderAll();
          hideEmpty();
        });
      })
      .catch(function (error) {
        if (!quiet) {
          showEmpty('读取数据失败：' + (error && error.message ? error.message : error));
        }
      })
      .then(function () { setLoading(false); });
  }

  function renderAll() {
    renderMeta();
    renderStartOptions();
    renderChart();
  }

  function renderMeta() {
    var manifest = state.manifest || {};
    var stats = state.stats || {};
    if (els['meta-chars']) {
      els['meta-chars'].textContent = '已记录 ' + num(stats.characterCount) + ' 个角色';
    }
    if (els['meta-chapter']) {
      els['meta-chapter'].textContent = '更新至第 ' + num(stats.lastChapter) + ' 话';
    }
    if (els['meta-updated']) {
      els['meta-updated'].textContent = '最后更新 ' + formatDateOnly(manifest.exportedAt);
    }
    if (els.revision) {
      els.revision.textContent = manifest.revision == null ? '—' : String(manifest.revision);
    }
  }

  function renderStartOptions() {
    if (!els['start-char']) return;
    var stats = state.stats || {};
    var characters = (Array.isArray(stats.characters) ? stats.characters : [])
      .filter(function (item) { return Number(item.count) > 0; })
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
  }

  function aggregateFromIndex(startChapter) {
    var chapters = (state.index.chapters || []).filter(function (chapter) {
      return Number(chapter.no) >= startChapter;
    });
    var totalPanels = chapters.reduce(function (sum, chapter) {
      return sum + (Number(chapter.panelCount) || 0);
    }, 0);
    var panelsFrom = function (firstNo) {
      return chapters.reduce(function (sum, chapter) {
        return sum + (Number(chapter.no) >= firstNo ? (Number(chapter.panelCount) || 0) : 0);
      }, 0);
    };
    var totals = {};
    chapters.forEach(function (chapter) {
      var metrics = chapter.metrics || {};
      Object.keys(metrics).forEach(function (key) {
        var metric = metrics[key] || {};
        if (!totals[key]) totals[key] = { count: 0, points: 0, weighted: 0 };
        totals[key].count += Number(metric.count) || 0;
        totals[key].points += Number(metric.points) || 0;
        totals[key].weighted += Number(metric.weighted) || 0;
      });
    });

    return state.stats.characters.map(function (item) {
      var total = totals[String(item.char)];
      var count = total ? total.count : 0;
      var density = 0;
      if (count > 0 && item.firstChapter != null && totalPanels > 0) {
        var first = Math.max(startChapter, Number(item.firstChapter));
        var active = panelsFrom(first);
        if (active > 0) {
          var share = total.points * POINTS_TO_SHARE;
          density = Number((share / active * Math.pow(active / totalPanels, DENSITY_ALPHA) * 100).toFixed(2));
        }
      }
      return {
        char: item.char,
        name: item.name,
        firstChapter: item.firstChapter,
        count: count,
        points: total ? total.points : 0,
        weighted: total ? total.weighted : 0,
        density: density,
      };
    });
  }

  function currentRows() {
    var characters = state.stats.characters;
    if (state.startChar !== 'all') {
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
      .filter(function (item) { 
        if(state.scope === 'only' && Number(item.char) === 0) {
          return false;
        }
        return Number(item.count) > 0; })
      .map(function (item) {
        return {
          char: item.char,
          name: item.name || '',
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

    // 条形长度统一由 barWidth() 计算；算法切换见文件顶部的 BAR_SCALE_MODE。
    // 这里只负责取当前列的 min/max，两种模式共用。
    var values = rows.map(function (item) { return item.value; });
    var max = Math.max.apply(null, values);
    var min = Math.min.apply(null, values);

    els.chart.innerHTML = rows.map(function (item) {
      var width = barWidth(item.value, min, max);
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
    els.scope = $('scope');
    els['start-char'] = $('start-char');
    els.chart = $('chart');
    els.empty = $('empty');

    if (els.metric) {
      els.metric.addEventListener('change', function () {
        state.metric = els.metric.value;
        renderChart();
      });
    }
    if (els.sort) {
      els.sort.addEventListener('change', function () {
        state.sort = els.sort.value;
        if(state.sort === 'char') {
          state.order = 'asc';
        } else {
          state.order = 'desc';
        }
        renderChart();
      });
    }
    if (els.scope) {
      els.scope.addEventListener('change', function () {
        state.scope = els.scope.value;
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
