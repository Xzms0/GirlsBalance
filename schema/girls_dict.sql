# -*- coding: utf-8 -*-
# girls_dict（超超你的字典）SQLite 存储结构
#
# 这份 DDL 与 server/girls_db.py 里的 SCHEMA_SQL 完全一致，
# 想用别的语言（Node / Go / Java / …）直接操作数据库时照抄即可：
#
#     sqlite3 data/girls_dict.sqlite3 < schema/girls_dict.sql
#
# 设计要点：
#   * 一份数据只存一次：话在 chapter，槽位在 panel，角色编号在 panel_char；
#   * panel_char 的主键是 (panel_id, char)，天然保证「同一分镜里同一角色只算一次」；
#   * chapter.no 是顺序位置（1..N）并带 UNIQUE，panel.position 是话内顺序（1..M）；
#   * 角色名单独放 char_name 表，只影响显示，数据里存的始终是编号；
#   * 改一个槽位 = 删几行 + 插几行 panel_char，写入量与改动量成正比；
#   * 索引让「查某个角色出现在哪」这类问题走索引而不是全表扫描。

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 15000;
PRAGMA journal_size_limit = 4194304;

-- 键值对：schema_version / title / author / revision / updated_at
CREATE TABLE IF NOT EXISTS info (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 话：no 就是顺序（1..N），恒等于 ORDER BY no 的下标 + 1
CREATE TABLE IF NOT EXISTS chapter (
  id         TEXT PRIMARY KEY,
  no         INTEGER NOT NULL UNIQUE,
  title      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

-- 槽位（分镜）：position 是话内顺序（1..M）
CREATE TABLE IF NOT EXISTS panel (
  id         TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  updated_at TEXT,
  UNIQUE (chapter_id, position)
);
CREATE INDEX IF NOT EXISTS idx_panel_chapter ON panel(chapter_id, position);

-- 分镜里出场的角色编号：主键去重，CHECK 保证范围
CREATE TABLE IF NOT EXISTS panel_char (
  panel_id TEXT NOT NULL REFERENCES panel(id) ON DELETE CASCADE,
  char     INTEGER NOT NULL CHECK (char BETWEEN 0 AND 100),
  PRIMARY KEY (panel_id, char)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_panel_char_char ON panel_char(char);

-- 角色名（编号 -> 名字），只用于显示与检索
CREATE TABLE IF NOT EXISTS char_name (
  char INTEGER PRIMARY KEY CHECK (char BETWEEN 0 AND 100),
  name TEXT NOT NULL
);

-- 最近改动记录（程序会自动裁到 2000 条）
CREATE TABLE IF NOT EXISTS change_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action   TEXT NOT NULL,
  detail   TEXT
);

-- 首次初始化时写入基础信息（用 INSERT OR IGNORE 可以重复执行）
INSERT OR IGNORE INTO info(key, value) VALUES
  ('schema_version', '2'),
  ('title', '超超你的字典'),
  ('author', ''),
  ('revision', '0'),
  ('updated_at', '');
