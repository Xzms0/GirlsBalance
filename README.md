# 超超你的小站

用于辅助录入漫画《超超超超超喜欢你的100个女朋友》中各角色在各分镜的出场情况。

项目分成两部分：

- **`public/`**：本机管理端，负责录入、修改 SQLite、发布。
- **`docs/`**：公开只读站「超超你的小站」。由 GitHub Pages 托管，展示各角色登场统计的条形图。

---

## 管理端

### 启动

双击 `start.bat`（Windows）：

```bat
python server\server.py --port 8777 --open
```

双击 `start.sh`（macOS / Linux）：

```bash
python3 server/server.py --port 8777 --open
```

然后访问 `http://127.0.0.1:8777`。

## 发布公开数据

管理端右上角有一个 **发布** 按钮。点击后：

1. 先把当前改动保存到 SQLite；
2. 服务端把数据导出为 `docs/data/` 下的分片 JSON；
3. 只把 `docs/data/` 加入 Git，提交一条 `data: rev ...`；
4. 推送到 `origin`；
5. 如果 GitHub Pages 的发布源是 `main` / `docs`，站点会自动更新。

## 公开站

+ 三种统计方式：**计数**、**积分**、**加权**

  - **计数**：角色出现在多少个分镜里。

  - **积分**：每个分镜固定 8 分，统计结果统一除以 10（即每个分镜 0.8 分），平均分给该分镜中出现的所有角色；一个分镜有 k 个角色，每人得 `0.8 / k`。

  - **加权**：每一话先算出“截至这一话已经登场过的角色总数 W”（这一话新登场的角色也计入），该话每个分镜的总分就是 `W / 10`，再平均分给分镜里的 k 个角色，每人得 `W / 10 / k`。

+ 每个角色的颜色来自 [`docs/colors.json`](docs/colors.json)，可直接编辑


## 数据存储结构

### 本地 SQLite

本地源是 `data/girls_dict.sqlite3`（WAL 模式）。完整 DDL 见 [`schema/girls_dict.sql`](schema/girls_dict.sql)：

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

`docs/data/stats.json`

```json
{
  "schema": "girls_dict",
  "schemaVersion": 1,
  "formatVersion": 2,
  "revision": 6642,
  "exportedAt": "2026-10-18T13:22:04+00:00",
  "totalChapters": 41,
  "totalPanels": 2855,
  "totalAppearances": 5305,
  "characterCount": 9,
  "lastChapter": 41,
  "maxCount": 1478,
  "maxPoints": 731.4,
  "maxWeighted": 524.1,
  "characters": [
    {
      "char": 0,
      "name": "爱城恋太郎",
      "count": 1478,
      "panels": 1478,
      "points": 731.4,
      "weighted": 524.1,
      "firstChapter": 1
    }
  ]
}
```

`docs/data/manifest.json`

```json
{
  "schema": "girls_dict",
  "schemaVersion": 1,
  "formatVersion": 2,
  "revision": 6642,
  "exportedAt": "2026-10-18T13:22:04+00:00",
  "title": "超超你的字典",
  "author": "Xzer0",
  "counts": { "chapters": 41, "panels": 2855, "appearances": 5305, "characters": 9, "charMin": 0, "charMax": 100 },
  "files": { "stats": "stats.json", "chapters": "chapters/index.json" }
}
```

`docs/data/chapters/index.json`

```json
{
  "schema": "girls_dict",
  "schemaVersion": 1,
  "formatVersion": 2,
  "revision": 6642,
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
        "0": { "count": 134, "points": 81.866667, "weighted": 30.7 }
      },
      "file": "0001.json"
    }
  ]
}
```

`docs/data/chapters/0001.json`

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

### 颜色表

`docs/colors.json` 保存“角色编号 -> 条形颜色”的十六进制颜色表

```json
{
  "_note": "角色编号 -> 条形图颜色（十六进制）缺失的编号使用 fallback。",
  "fallback": "#8fa6b2",
  "colors": {
    "0": "#dc6a6a",
    "1": "#7897e3",
    "2": "#c0ea86"
  }
}
```


### 完整 JSON 导出格式

管理端可以导出完整 JSON

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

### CSV 导出

CSV 是一张 0/1 表：

- 第一列是「话-分镜」，例如 `1-1`、`1-2`、`2-1`；
- 后面是角色编号 `0` 到 `100`，共 101 列；
- 单元格 `1` 表示该角色在这个分镜里出现过，`0` 表示没有；
- 不包含标题、角色名或其他元信息。

## 项目结构

```
girls_dict/
├─ public/                     本地管理端
│  ├─ index.html
│  ├─ css/styles.css
│  └─ js/                      model / adapters / store / ui / app / publish
│
├─ docs/                       GitHub Pages 公开站
│  ├─ index.html
│  ├─ css/site.css
│  ├─ js/chart.js              条形图与三种统计
│  ├─ colors.json              颜色表
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
└─ data/                       本地 SQLite、快照
```