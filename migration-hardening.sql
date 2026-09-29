-- ============================================================================
-- TR666 hardening migration (idempotent, non-destructive)
-- Run ONCE per existing D1 database, in the D1 Console or via:
--   wrangler d1 execute tr666-db --file=./migration-hardening.sql --remote
--
-- New databases created from an updated schema.sql already include everything;
-- this file upgrades EXISTING databases without touching existing rows.
--
-- NOTE on the four ALTER TABLE lines below: SQLite has no
-- "ADD COLUMN IF NOT EXISTS". If a column already exists that single line
-- errors with "duplicate column name" - that is expected and SAFE to ignore.
-- Everything else here is fully idempotent (IF NOT EXISTS).
-- ============================================================================

-- 1) Session versioning (password change / reset invalidates old sessions)
ALTER TABLE players ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admins  ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;

-- 2) Play idempotency key on arcade activity
ALTER TABLE arcade_activity ADD COLUMN play_id TEXT;

-- 3) Optional audit note recorded when a payout is decided
ALTER TABLE payout_requests ADD COLUMN decision_note TEXT;

-- ----------------------------------------------------------------------------
-- 4) Unique arcade play_id PER PLAYER (idempotency guard).
--    Partial index so legacy rows with a NULL play_id never collide.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_arcade_playid
  ON arcade_activity (player_id, play_id) WHERE play_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 5) Rate limiting (fixed-window counters)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------------------------
-- 6) Login lockout / throttle
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_throttle (
  id           TEXT PRIMARY KEY,          -- e.g. "login:player:<username>"
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, -- unix seconds
  updated_at   TEXT
);

-- ----------------------------------------------------------------------------
-- 7) Arcade daily reward grants (one row per granted slot per SGT day)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS arcade_daily_rewards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    INTEGER NOT NULL,
  reward_date  TEXT NOT NULL,             -- YYYY-MM-DD (Singapore time)
  seq          INTEGER NOT NULL,          -- 1..arcade_daily_limit
  points_added INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, reward_date, seq)
);
CREATE INDEX IF NOT EXISTS idx_arcade_daily_player ON arcade_daily_rewards (player_id, reward_date);

-- ----------------------------------------------------------------------------
-- 8) Supporting lookup indexes (safe to re-run)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_arcade_player      ON arcade_activity (player_id, activity_date);
CREATE INDEX IF NOT EXISTS idx_activity_player    ON point_activity (player_id, id);
CREATE INDEX IF NOT EXISTS idx_payouts_status     ON payout_requests (status, id);
CREATE INDEX IF NOT EXISTS idx_payouts_player     ON payout_requests (player_id, id);
CREATE INDEX IF NOT EXISTS idx_payouts_created    ON payout_requests (status, created_at);
CREATE INDEX IF NOT EXISTS idx_deposits_player    ON deposits (player_id, month_key);
CREATE INDEX IF NOT EXISTS idx_checkins_player    ON daily_checkins (player_id, checkin_date);

-- Uniqueness that the original schema already enforces via table constraints
-- (kept here as IF NOT EXISTS so fresh installs and older variants converge):
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_completion ON task_completions (player_id, task_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_checkin   ON daily_checkins (player_id, checkin_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vip_weekly      ON vip_weekly_claims (player_id, week_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vip_upgrade     ON vip_upgrade_grants (player_id, month_key, rank_idx);

-- ============================================================================
-- OPTIONAL (advanced): add CHECK constraints to existing tables.
-- SQLite cannot ALTER a column to add a CHECK; it requires a table rebuild.
-- The application already GUARANTEES these invariants (guarded atomic writes),
-- so this section is OPTIONAL. Run it only during a maintenance window; it
-- copies all existing data (non-destructive) but must run as a whole block.
--
-- Uncomment to apply. Balances that are already valid will copy cleanly.
-- ----------------------------------------------------------------------------
-- PRAGMA foreign_keys=OFF;
-- BEGIN;
-- CREATE TABLE players_new (
--   id INTEGER PRIMARY KEY AUTOINCREMENT,
--   username TEXT NOT NULL COLLATE NOCASE UNIQUE,
--   password TEXT NOT NULL,
--   display_name TEXT,
--   points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
--   reward_cents INTEGER NOT NULL DEFAULT 0 CHECK (reward_cents >= 0),
--   status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
--   note TEXT,
--   session_version INTEGER NOT NULL DEFAULT 1,
--   created_at TEXT NOT NULL DEFAULT (datetime('now')),
--   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
-- );
-- INSERT INTO players_new SELECT id, username, password, display_name, points,
--   reward_cents, status, note, session_version, created_at, updated_at FROM players;
-- DROP TABLE players; ALTER TABLE players_new RENAME TO players;
-- COMMIT;
-- PRAGMA foreign_keys=ON;
-- (A parallel rebuild can add: payout_requests.amount_cents CHECK (> 0),
--  status CHECK IN ('pending','approved','rejected').)
