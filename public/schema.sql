-- ============================================================================
-- TR666 - D1 database schema
-- Run once on a NEW, empty D1 database.
-- ============================================================================

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password TEXT NOT NULL,
  display_name TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  reward_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, task_id)
);

CREATE TABLE IF NOT EXISTS daily_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  checkin_date TEXT NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, checkin_date)
);

CREATE TABLE IF NOT EXISTS arcade_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  game TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  result_label TEXT,
  win_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS point_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  points_after INTEGER NOT NULL,
  note TEXT,
  admin_username TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- VIP: deposits drive a player's monthly rank
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  month_key TEXT NOT NULL,          -- YYYY-MM in Singapore time
  note TEXT,
  admin_username TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- VIP: one Tier Upgrade Bonus per rank per month
CREATE TABLE IF NOT EXISTS vip_upgrade_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  month_key TEXT NOT NULL,
  rank_idx INTEGER NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, month_key, rank_idx)
);

-- VIP: one Weekly Bonus claim per week
CREATE TABLE IF NOT EXISTS vip_weekly_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  week_key TEXT NOT NULL,           -- Monday date (SGT) YYYY-MM-DD
  rank_idx INTEGER NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, week_key)
);

CREATE INDEX IF NOT EXISTS idx_deposits_player ON deposits (player_id, month_key);
CREATE INDEX IF NOT EXISTS idx_checkins_player ON daily_checkins (player_id, checkin_date);
CREATE INDEX IF NOT EXISTS idx_arcade_player ON arcade_activity (player_id, activity_date);
CREATE INDEX IF NOT EXISTS idx_activity_player ON point_activity (player_id, id);

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('daily_checkin_points', '10'),
  ('arcade_daily_points', '5'),
  ('arcade_daily_limit', '1'),
  ('tasks_enabled', '1'),
  ('announcement_text', ''),
  ('contact_url', '');

-- Reward payout requests (Submit button creates these; admin approves/rejects)
CREATE TABLE IF NOT EXISTS payout_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  admin_username TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payout_requests (status, id);
CREATE INDEX IF NOT EXISTS idx_payouts_player ON payout_requests (player_id, id);

-- Lucky Crossing rounds (the Worker also creates this automatically on first use).
CREATE TABLE IF NOT EXISTS cross_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | active | hit | collected
  lane INTEGER NOT NULL DEFAULT 0,   -- lanes survived so far
  cost INTEGER NOT NULL,             -- PTS charged at start
  win_cents INTEGER NOT NULL DEFAULT 0,
  ladder_json TEXT NOT NULL,         -- snapshot of the lane prizes / survive % for this round
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(player_id, round_id)
);
CREATE INDEX IF NOT EXISTS idx_cross_rounds_player_status ON cross_rounds (player_id, status);
