-- ============================================================================
-- LE888 — COMPLETE D1 schema (every table + column the current index.ts uses)
-- Safe to run on a new OR existing database: only CREATE ... IF NOT EXISTS.
-- Existing tables are never changed by this file; missing COLUMNS on existing
-- tables are added by the app itself (Admin -> Settings -> Database check).
-- ============================================================================

-- ---------- Players & staff ----------
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password TEXT NOT NULL,
  display_name TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  reward_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  tag TEXT,
  telegram TEXT,
  whatsapp TEXT,
  lang TEXT,
  bank_name TEXT,
  bank_account TEXT,
  bank_holder TEXT,
  paynow_number TEXT,
  bank_locked INTEGER NOT NULL DEFAULT 0,
  birthday TEXT,
  birthday_locked INTEGER NOT NULL DEFAULT 0,
  mc_status TEXT,                 -- VIP custom credit: pending_submission | pending_approval
  mc_amount_cents INTEGER NOT NULL DEFAULT 0,
  mc_winover REAL,
  mc_cap_cents INTEGER,
  mc_payout_id INTEGER,
  avatar INTEGER NOT NULL DEFAULT 0,      -- 0 = default icon, 1..9 = chosen avatar
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'manager',     -- manager | staff
  permissions TEXT,                          -- JSON list of tabs a staff may open
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- Points, credits, activity ----------
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
CREATE INDEX IF NOT EXISTS idx_activity_player ON point_activity (player_id, id);

CREATE TABLE IF NOT EXISTS credit_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  reward_after_cents INTEGER,
  reason TEXT,
  admin_username TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_player ON credit_activity (player_id, id);

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
CREATE INDEX IF NOT EXISTS idx_checkins_player ON daily_checkins (player_id, checkin_date);

-- ---------- Mini games ----------
CREATE TABLE IF NOT EXISTS game_configs (
  game TEXT PRIMARY KEY,           -- wheel | plinko | egg | scratch | cross | crown
  cost INTEGER NOT NULL DEFAULT 0,
  prizes_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS game_config_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  changed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS arcade_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  game TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  result_label TEXT,
  win_cents INTEGER NOT NULL DEFAULT 0,
  play_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_arcade_player ON arcade_activity (player_id, activity_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_arcade_playid ON arcade_activity (player_id, play_id) WHERE play_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS arcade_daily_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  reward_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, reward_date, seq)
);
CREATE TABLE IF NOT EXISTS cross_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lane INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL,
  win_cents INTEGER NOT NULL DEFAULT 0,
  ladder_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, round_id)
);
CREATE INDEX IF NOT EXISTS idx_cross_rounds_player_status ON cross_rounds (player_id, status);

-- ---------- Reward credit payouts (free credit) & withdraw rules ----------
CREATE TABLE IF NOT EXISTS payout_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled
  admin_username TEXT,
  decision_note TEXT,
  game TEXT,
  game_id TEXT,
  fc_status TEXT,
  fc_winover_x REAL,
  fc_hit_cents INTEGER,
  fc_cap_cents INTEGER,
  fc_custom INTEGER NOT NULL DEFAULT 0,
  fc_cleared_at TEXT,
  fc_cleared_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payout_requests (status, id);
CREATE INDEX IF NOT EXISTS idx_payouts_player ON payout_requests (player_id, id);
CREATE INDEX IF NOT EXISTS idx_payouts_created ON payout_requests (status, created_at);

CREATE TABLE IF NOT EXISTS withdraw_rules (
  up_to_cents INTEGER NOT NULL,
  winover_x REAL NOT NULL,
  cap_cents INTEGER NOT NULL,
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS withdraw_rule_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  before_json TEXT,
  after_json TEXT,
  changed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Bank withdrawals ----------
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  bank_name TEXT,
  bank_account TEXT,
  bank_holder TEXT,
  paynow_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  source_type TEXT,                          -- free_credit | normal
  source_game TEXT,
  source_game_id TEXT,
  free_credit_cents INTEGER,
  winover_x REAL,
  rule_cap_cents INTEGER,
  source_payout_id INTEGER,
  note TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_player ON withdrawals (player_id, id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals (status, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawal_one_pending ON withdrawals (player_id) WHERE status = 'pending';

-- ---------- Deposits & VIP ----------
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  month_key TEXT NOT NULL,
  note TEXT,
  admin_username TEXT,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deposits_player ON deposits (player_id, month_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_reference ON deposits (reference) WHERE reference IS NOT NULL AND reference != '';

CREATE TABLE IF NOT EXISTS deposit_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'paynow',
  receipt_url TEXT,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_username TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_depsub_status ON deposit_submissions (status, id);
CREATE INDEX IF NOT EXISTS idx_depsub_player ON deposit_submissions (player_id, id);

CREATE TABLE IF NOT EXISTS deposit_bonus_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  min_deposit REAL NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'once',
  reward_type TEXT NOT NULL DEFAULT 'points',
  amount REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  start_date TEXT,
  end_date TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deposit_bonus_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  tier_id INTEGER NOT NULL,
  period_key TEXT NOT NULL,
  reward_type TEXT,
  amount REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, tier_id, period_key)
);

CREATE TABLE IF NOT EXISTS vip_rewards (
  rank_idx INTEGER PRIMARY KEY,
  weekly INTEGER NOT NULL DEFAULT 0,
  upgrade INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS vip_upgrade_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  month_key TEXT NOT NULL,
  rank_idx INTEGER NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, month_key, rank_idx)
);
CREATE TABLE IF NOT EXISTS vip_weekly_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  week_key TEXT NOT NULL,
  rank_idx INTEGER NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, week_key)
);

-- ---------- Game accounts ----------
CREATE TABLE IF NOT EXISTS player_game_ids (
  player_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  game_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, platform)
);
CREATE TABLE IF NOT EXISTS player_free_ids (
  player_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  game_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, platform)
);

-- ---------- Promotions ----------
CREATE TABLE IF NOT EXISTS promos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  title_zh TEXT,
  tnc TEXT,
  tnc_zh TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  access TEXT NOT NULL DEFAULT 'open',       -- open | gated
  limit_type TEXT NOT NULL DEFAULT 'total',  -- total | day
  limit_count INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  image_url TEXT,
  reward_type TEXT NOT NULL DEFAULT 'points',
  app_only INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS promo_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  points_added INTEGER NOT NULL DEFAULT 0,
  day_key TEXT,
  unlock_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promo_claims ON promo_claims (player_id, promo_id, day_key);
CREATE TABLE IF NOT EXISTS promo_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',  -- available | claimed | revoked
  granted_by TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promo_unlocks ON promo_unlocks (player_id, promo_id, status);

-- ---------- Live chat ----------
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  sender TEXT NOT NULL,                      -- player | admin
  admin_username TEXT,
  body TEXT,
  image_url TEXT,
  is_html INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_player ON chat_messages (player_id, id);
CREATE TABLE IF NOT EXISTS chat_state (
  player_id INTEGER PRIMARY KEY,
  last_msg_at TEXT,
  admin_unread INTEGER NOT NULL DEFAULT 0,
  player_unread INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  trigger_key TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_template_trigger ON chat_templates (trigger_key) WHERE trigger_key != '';

-- ---------- Push notifications ----------
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  lang TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_player ON push_subs (player_id);
CREATE TABLE IF NOT EXISTS push_log (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, key)
);

-- ---------- Content: banners, slot games, domains ----------
CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_url TEXT NOT NULL,
  link_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS slot_platforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  logo_url TEXT,
  kind TEXT NOT NULL DEFAULT 'app',
  play_url TEXT,
  android_package TEXT,
  links_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Security ----------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_throttle (
  id TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- ---------- Default settings ----------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('tasks_enabled', '1'),
  ('announcement_text', ''),
  ('contact_url', ''),
  ('chat_keep_messages', '100');
