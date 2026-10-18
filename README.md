# 超超你的字典

用于辅助录入漫画《超超超超超喜欢你的100个女朋友》中各角色在各分镜的出场情况。

> 其他漫画仍然适用。

项目分成两半：

- **`public/`**：本机管理端。只在 `http://127.0.0.1:8777` 运行，负责录入、修改 SQLite、发布。
- **`docs/`**：公开只读站「超超你的小站」。由 GitHub Pages 托管，展示各角色登场统计的条形图，支持计数 / 积分 / 加权三种口径。

`docs/` 可以部署到 GitHub Pages；`public/`、`server/`、`data/` 不会出现在公开站点里。

---

## 启动

### A. 一键启动管理端

双击 `start.bat`（Windows）：

```bat
python server\server.py --port 8777 --open
```

双击 `start.sh`（macOS / Linux）：

```bash
python3 server/server.py --port 8777 --open
```

然后访问 `http://127.0.0.1:8777`。

### B. 直接打开管理端网页

双击 `public/index.html`，页面会尝试连接本机 `8777` 服务；连不上时会回落到浏览器自带的 IndexedDB（仅适合临时使用，数据不会进 SQLite）。

### C. 只看公开站

```bash
python -m http.server 8788 --directory docs
```

访问 `http://127.0.0.1:8788/`。公开站只读 `docs/data/` 下的 JSON，不需要启动后端。

### 公开站功能

- 标题「超超你的小站」，英文标识 `GIRLS BALANCE`；
- 标题下方自动显示：更新至第几个角色、更新至第几话、最后更新日期；
- 条形图默认按角色编号排序，可切换为按数据排序，并可选择升序 / 降序；
- 没有记录的角色不显示；
- 三种统计：**计数**、**积分**、**加权**；
- 可选择某个角色，只统计从该角色首次登场话到最新话的数据；
- 每个角色使用 `docs/colors.json` 里对应的十六进制颜色；
- 页脚保留数据版本，并提供 GitHub、Bilibili、邮箱链接。

> **修改页脚链接**：打开 [`docs/index.html`](docs/index.html)，找到页脚的 `<nav class="links">`，改三个 `<a>` 的 `href` 和文字即可；HTML 里也有注释标记。数据版本由 [`docs/js/chart.js`](docs/js/chart.js) 自动填。

---

## 发布公开数据

管理端右上角有一个 **发布** 按钮。点击后：

1. 先把当前改动保存到 SQLite；
2. 服务端把数据导出为 `docs/data/` 下的分片 JSON；
3. 只把 `docs/data/` 加入 Git，提交一条 `data: rev ...`；
4. 推送到 `origin`；
5. 如果 GitHub Pages 的发布源是 `main` / `docs`，站点会自动更新。

浏览器不接触任何 Git 凭据；提交和推送都由本机服务端完成，使用系统 Git 凭据管理器 / SSH Key。

### 首次配置

```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

然后在 GitHub 仓库的 **Settings → Pages**：

- Source 选 **Deploy from a branch**
- Branch 选 **main**
- Folder 选 **/docs**

不需要 GitHub Actions。

> 首次务必先 `git add .` 并提交一次。发布按钮只提交 `docs/data`；如果站点 HTML/CSS/JS 还没进 Git，它们不会被按钮带上去。

### 也可以命令行发布

```bash
python tools/publish.py --export-only   # 只生成 docs/data，不碰 Git
python tools/publish.py                 # 生成 + commit + push
python tools/publish.py --no-push       # 生成 + commit，不 push
python tools/publish.py --force         # 允许空库覆盖已有公开数据（危险）
```

要求：

- 项目根目录本身是一个独立的 Git 仓库（不能只是父仓库的子目录）；
- 已配置 `origin`；
- 已配置 `git config user.name` / `user.email`；
- 本机已安装 Git。

发布失败时不会影响本地 SQLite；如果 commit 成功但 push 失败，提交会留在本地，修好网络/远端后再点一次发布即可补推。

> 安全阀：如果当前 SQLite 是空的，而 `docs/data` 里已有分镜，按钮会拒绝发布，避免新机器/空库误覆盖公开数据。确实要清空时用 `python tools/publish.py --force`。

> 注意：`git push` 会推送当前分支上所有未推送的提交，不只是数据提交。发布前如果还有其它本地提交，它们也会一起上去。

### 数据量变大时

公开数据已经按话分片，不会把所有分镜塞进一个文件：

```
docs/data/
├─ manifest.json          # 版本、计数、文件清单
├─ stats.json             # 三种统计的全量结果 + 首次登场话
└─ chapters/
   ├─ index.json          # 每话的计数、加权系数、角色聚合
   ├─ 0001.json           # 第 1 话的槽位与角色编号
   ├─ 0002.json
   └─ ...
```

- 公开站首屏读取 `manifest.json` + `stats.json` + `chapters/index.json` + `colors.json`；
- `index.json` 只存每话的角色聚合，不重复存分镜内容；数据量增长时仍远小于分话文件；
- 单个话文件只包含那一话，数据量增长不会拖慢首屏；
- `colors.json` 是静态颜色表，不随发布生成，直接编辑即可。

---

## 数据存储结构

### 本地 SQLite

本地真源是 `data/girls_dict.sqlite3`（WAL 模式），**不提交到 Git**。完整 DDL 见 [`schema/girls_dict.sql`](schema/girls_dict.sql)：

```sql
CREATE TABLE info (            -- 键值对：schema_version / title / author / revision / updated_at
  key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE chapter (         -- 话；no 就是顺序位置 1..N，带 UNIQUE
  id TEXT PRIMARY KEY, no INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', updated_at TEXT);

CREATE TABLE panel (           -- 槽位（分镜）；position 是话内顺序 1..M
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, updated_at TEXT,
  UNIQUE (chapter_id, position));

CREATE TABLE panel_char (      -- 分镜里出场的角色编号：主键天然去重
  panel_id TEXT NOT NULL REFERENCES panel(id) ON DELETE CASCADE,
  char INTEGER NOT NULL CHECK (char BETWEEN 0 AND 100),
  PRIMARY KEY (panel_id, char)) WITHOUT ROWID;

CREATE TABLE char_name (       -- 编号 -> 角色名（仅用于显示/检索）
  char INTEGER PRIMARY KEY CHECK (char BETWEEN 0 AND 100), name TEXT NOT NULL);

CREATE TABLE change_log (      -- 最近改动（自动裁到 2000 条）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT);
```

### 公开分片 JSON

`docs/data/stats.json` 是条形图的全量数据源：

```json
{
  "schema": "girls_dict",
  "schemaVersion": 1,
  "revision": 5908,
  "exportedAt": "2026-10-18T08:23:08+00:00",
  "totalChapters": 32,
  "totalPanels": 2574,
  "totalAppearances": 4746,
  "characterCount": 8,
  "lastChapter": 32,
  "maxCount": 1370,
  "maxPoints": 6829.3,
  "maxWeighted": 4695.92,
  "characters": [
    {
      "char": 0,
      "name": "爱城恋太郎",
      "count": 1370,
      "panels": 1370,
      "points": 6829.3,
      "weighted": 4695.92,
      "firstChapter": 1
    }
  ]
}
```

`characters` 固定包含 0–100 全部编号，按角色编号升序；`count` / `panels` 是分镜计数，`points` 是积分，`weighted` 是加权，`firstChapter` 是首次登场话（没有记录时为 `null`）。`points` / `weighted` 保留两位小数。

三种统计口径：

- **计数**：角色出现在多少个分镜里。
- **积分**：每个分镜固定 8 分，平均分给该分镜中出现的所有角色；一个分镜有 k 个角色，每人得 `8 / k`。
- **加权**：每一话先算出“截至这一话已经登场过的角色总数 W”（这一话新登场的角色也计入），该话每个分镜的总分就是 W，再平均分给分镜里的 k 个角色，每人得 `W / k`。

`docs/data/manifest.json`：

```json
{
  "schema": "girls_dict",
  "schemaVersion": 1,
  "revision": 5908,
  "exportedAt": "2026-10-18T08:23:08+00:00",
  "title": "超超你的字典",
  "author": "Xzer0",
  "counts": { "chapters": 32, "panels": 2574, "appearances": 4746, "characters": 8, "charMin": 0, "charMax": 100 },
  "files": { "stats": "stats.json", "chapters": "chapters/index.json" }
}
```

`docs/data/chapters/index.json` 保存每话的聚合（公开站的“从某角色首次登场开始”筛选会读取它）：

```json
{
  "schema": "girls_dict",
  "revision": 5908,
  "chapters": [
    {
      "no": 1,
      "title": "相遇",
      "note": "",
      "panelCount": 204,
      "appearances": 318,
      "characters": [0, 1, 2],
      "weight": 3,
      "metrics": {
        "0": { "count": 204, "points": 1632.0, "weighted": 612.0 }
      },
      "file": "0001.json"
    }
  ]
}
```

`weight` 是“截至这一话已登场角色总数”；`metrics` 是每个角色在这一话的计数 / 积分 / 加权贡献。

`docs/data/chapters/0001.json`：

```json
{
  "schema": "girls_dict",
  "schemaVersion": 1,
  "no": 1,
  "title": "相遇",
  "note": "",
  "panelCount": 204,
  "appearances": 318,
  "characters": [0, 1, 2],
  "panels": [
    { "chars": [0, 1] },
    { "chars": [0, 1, 2] }
  ]
}
```

单话文件不带 `revision` / `exportedAt`：只改一话时，其它话文件不会产生 Git diff；版本号在 `manifest.json` 和 `chapters/index.json` 里。

### 颜色表

`docs/colors.json` 保存“角色编号 -> 条形颜色”的十六进制颜色表，直接编辑即可：

```json
{
  "_note": "角色编号 -> 条形图颜色（十六进制）。直接改这个文件即可；缺失的编号使用 fallback。",
  "fallback": "#8fa6b2",
  "colors": {
    "0": "#dc6a6a",
    "1": "#7897e3",
    "2": "#c0ea86"
  }
}
```

改完 `docs/colors.json` 后，正常 commit / push 即可，不需要重新发布数据。

公开站读取 `stats.json` 画全量图，读取 `chapters/index.json` 做“起始角色”筛选，读取 `colors.json` 上色；`chapters/0001.json` 等分话文件留给分话浏览或第三方调用。

### 完整交换格式

管理端仍然可以导出完整 JSON（不含内部 id），用于备份或交给别的程序：

```json
{
  "schema": "girls_dict",
  "schemaVersion": 1,
  "exportedAt": "2026-10-14T10:20:30Z",
  "meta": {
    "title": "超超你的字典",
    "author": "",
    "charMin": 0,
    "charMax": 100,
    "charNames": { "1": "超超", "5": "阿蓝" }
  },
  "chapters": [
    {
      "no": 1,
      "title": "相遇",
      "note": "",
      "panels": [{ "chars": [1, 5] }]
    }
  ]
}
```

Schema 见 [`schema/girls_dict.schema.json`](schema/girls_dict.schema.json)。

---

## 管理端使用

### 录入

- **输入框**：格式 `1 5 23`、`1,5,23`、`1、5`，回车 / 空格 / 逗号提交；
- **数字键盘**：0–100 共 101 个按钮，点击可移除或加入。

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl+S` | 立即保存（平时也会自动保存） |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Alt+↑` / `Alt+↓` | 把当前话上移 / 下移 |
| `[` / `]` | 上一个 / 下一个槽位 |
| `Esc` | 关闭弹窗 / 取消「对换」 |
| `?` | 打开帮助 |

### 发布状态

- 按钮悬停会显示上次发布的 revision、时间和未推送提交数；
- 数据没有变化时不会产生空 commit；
- 失败会提示“已提交但未推送 / 推送失败”，不会丢本地数据。

---

## REST 接口

管理端默认 `http://127.0.0.1:8777`，只监听本机。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务信息、数据库文件、版本号 |
| GET | `/api/index` | 每话的计数与元信息 |
| GET | `/api/db` | 完整文档（带内部 id） |
| POST | `/api/db/patch` | 增量写入：`{revision, ops:[...], force?, label?}` |
| PUT | `/api/db` | 整库替换：`{revision, db, force?}` |
| GET | `/api/db/export?format=json\|csv\|md\|sqlite` | 导出 |
| GET | `/api/stats` | 角色出场次数 |
| GET | `/api/find?char=12` | 某角色出现在哪些话/槽位 |
| GET | `/api/search?q=文字` | 按标题/备注/角色名搜索 |
| GET | `/api/backups` | 快照列表 |
| POST | `/api/backups` | 立即创建快照 |
| POST | `/api/backups/restore` | 回滚快照 |
| GET | `/api/publish/status` | 公开数据的已发布版本与 Git 状态 |
| POST | `/api/publish` | 导出 `docs/data` 并 commit / push |
| GET | `/api/help` | 接口与补丁操作清单 |

`/api/publish` 只应该在本机使用。它依赖本机 Git 凭据，不接受前端传入的 Token。

---

## 安全说明

- **管理端只在本机运行**：`server.py` 默认绑定 `127.0.0.1`，不要改成 `0.0.0.0`，也不要做公网端口映射。
- **公开站是纯静态的**：`docs/` 没有写接口，也没有任何 Token。
- **数据库不进 Git**：`.gitignore` 已排除 `/data/*.sqlite3`、WAL、快照；公开的只有 `docs/data/*.json`。
- **发布凭据不进浏览器**：Git 凭据由系统凭据管理器 / SSH Key 持有。
- 如果需要在手机或外网编辑，用 **Tailscale** 或 **Cloudflare Tunnel + Access** 把本机服务私密地暴露给指定账号，不要裸奔公网。通过隧道访问时，用 `--allow-origin https://<管理端域名>` 放行该来源，并确保 Access 只允许你。
- `docs/data` 里的标题、备注、角色名都会公开；不想公开的备注请在发布前移除。

---

## 项目结构

```
girls_dict/
├─ public/                     本机管理端（不部署；名字是历史遗留）
│  ├─ index.html
│  ├─ css/styles.css
│  └─ js/                      model / adapters / store / ui / app / publish
│
├─ docs/                       GitHub Pages 公开站
│  ├─ index.html
│  ├─ css/site.css
│  ├─ js/chart.js              条形图与三种统计
│  ├─ colors.json              角色编号 -> 十六进制颜色
│  └─ data/                    发布生成的分片 JSON
│     ├─ manifest.json
│     ├─ stats.json
│     └─ chapters/
│
├─ server/
│  ├─ girls_db.py              Python SQLite 数据层
│  ├─ server.py                Python 服务端（REST + 静态托管 + 发布接口）
│  ├─ db.js                    Node SQLite 数据层
│  ├─ server.js                Node 服务端
│  ├─ site_publish.py          分片导出 + Git 发布（Python）
│  └─ site_publish.js          分片导出 + Git 发布（Node）
│
├─ schema/                     SQLite DDL 与 JSON Schema
├─ tools/
│  ├─ gd.py                    命令行：统计 / 查询 / 导出 / 排序 / 快照
│  └─ publish.py               发布 docs/data
├─ tests/                      数据层、模型、界面、公开图、跨语言契约
└─ data/                       本地 SQLite、快照、示例 JSON（数据库本身不提交）
```

---

## 测试

```bash
python tests/test_girls_db.py
python tests/test_site_publish.py
node tests/test_db.js
node tests/test_model.js
node tests/test_ui_smoke.js
node tests/test_chart_smoke.js
```

`data/sample.girls_dict.json` 是测试用的 3 话示例数据，不参与真实发布。

`HANDOFF.md`、`TASK.md` 默认被 `.gitignore` 排除；如果要一起开源，删掉 `.gitignore` 里对应两行即可。
