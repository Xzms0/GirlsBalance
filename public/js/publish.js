/*!
 * girls_dict · 发布到公开站
 *
 * 只做一件事：把当前 SQLite 保存后，调用本机服务的 /api/publish，
 * 由服务端导出 docs/data 并 commit / push。浏览器不接触 Git 凭据。
 *
 * 发布前会检查 /api/health 的 siteFormatVersion；如果服务端还是旧代码，
 * 按钮会被禁用，避免用旧格式覆盖 docs/data。
 */
(function (global) {
  'use strict';

  var store = global.GD && global.GD.store;
  var ui = global.GD && global.GD.ui;
  var button = null;
  var busy = false;
  var serverReady = false;
  var LABEL = '发布';

  function toast(message, kind, duration) {
    if (ui && ui.toast) ui.toast(message, kind || 'info', duration || 4200);
  }

  function setBusy(value) {
    busy = value;
    if (!button) return;
    button.disabled = value || !serverReady;
    button.textContent = value ? '发布中…' : (serverReady ? LABEL : '服务旧');
  }

  function commitLink(hash) {
    if (!hash) return '';
    return ' · ' + hash;
  }

  function checkServer(notify) {
    if (!global.fetch) {
      serverReady = false;
      setBusy(false);
      return Promise.resolve(false);
    }
    return global.fetch('/api/health', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        // 每次发布前检查当前公开格式，避免不匹配的服务覆盖公开数据。
        serverReady = !!(data && data.siteFormatVersion === 4);
        if (!serverReady) {
          if (button) {
            button.title = '当前运行的服务端还是旧代码。请关闭所有旧服务进程，重新运行 start.bat 后再发布。';
          }
          if (notify) {
            toast('服务端代码不是最新版本，已禁止发布。请关闭旧进程并重启 start.bat。', 'error', 9000);
          }
        } else if (button) {
          button.title = '导出 docs/data 并提交到 Git';
        }
        setBusy(busy);
        return serverReady;
      })
      .catch(function () {
        serverReady = false;
        if (button) button.title = '无法连接本机服务，请确认服务正在运行。';
        if (notify) toast('无法连接本机服务，已取消发布。', 'error', 7000);
        setBusy(busy);
        return false;
      });
  }

  function refreshStatus() {
    if (!button || !global.fetch || !serverReady) return;
    global.fetch('/api/publish/status', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || !data.ok) return;
        if (!data.published) {
          button.title = '还没有发布过。点击导出 docs/data 并提交到 Git。';
          return;
        }
        var counts = data.counts || {};
        var text = '上次发布 rev ' + data.revision;
        if (data.exportedAt) text += ' · ' + data.exportedAt;
        if (counts.chapters !== undefined) text += ' · ' + counts.chapters + ' 话 / ' + counts.panels + ' 分镜';
        if (data.git && data.git.isRepo && data.git.ahead > 0) {
          text += '（有 ' + data.git.ahead + ' 个提交未推送）';
        }
        button.title = text;
      })
      .catch(function () { /* 服务没起来时静默 */ });
  }

  function publish() {
    if (busy) return;
    if (!store || !store.saveNow) {
      toast('当前页面没有可用的数据源', 'error');
      return;
    }
    if (store.state && store.state.adapterKind !== 'http') {
      toast('发布需要连接本机 SQLite 服务（http://127.0.0.1:8777）', 'warn', 6000);
      return;
    }
    setBusy(true);
    checkServer(true).then(function (ok) {
      if (!ok) return null;
      var saving;
      try {
        saving = store.saveNow(false);
      } catch (error) {
        toast('保存失败：' + (error && error.message ? error.message : error), 'error');
        return null;
      }
      return Promise.resolve(saving).then(function (saved) {
        if (!saved) {
          toast('保存失败，已取消发布。请先处理保存错误。', 'warn', 6000);
          return null;
        }
        return global.fetch('/api/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).then(function (response) {
          return response.text().then(function (text) {
            try {
              return text ? JSON.parse(text) : {};
            } catch (error) {
              return { ok: false, error: '服务返回的不是 JSON（HTTP ' + response.status + '）' };
            }
          });
        });
      }).then(function (data) {
        if (!data) return;
        if (data.ok) {
          if (data.changed === false) {
            toast('数据没有变化，没有产生新提交', 'info');
          } else if (data.pushed === false) {
            toast('已提交' + commitLink(data.commit) + '，但推送失败：' +
              (data.error || '请检查网络 / 远端 / 凭据'), 'warn', 8000);
          } else {
            toast('已发布 rev ' + data.revision + commitLink(data.commit), 'ok', 5200);
          }
        } else {
          var message = data.error || '未知错误';
          if (data.committed) message = '本地已提交' + commitLink(data.commit) + '，但发布未完成：' + message;
          toast('发布失败：' + message, 'error', 9000);
        }
        refreshStatus();
      }).catch(function (error) {
        toast('发布失败：' + (error && error.message ? error.message : error), 'error', 8000);
      });
    }).then(function () {
      setBusy(false);
    });
  }

  function boot() {
    button = document.getElementById('btn-publish');
    if (!button) return;
    button.addEventListener('click', publish);
    checkServer(true).then(function (ok) {
      if (ok) refreshStatus();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}(window));
