// ============================================================================
// LE888 Points - Cloudflare Worker backend (hardened)
// One Worker handles: player page, admin page, player APIs, admin APIs,
// and static assets. No Telegram. Players sign in with username + password.
//
// Production hardening in this version:
//  - Atomic, guarded point spending (arcade) - balances can never go negative
//  - Atomic reward-balance claim on submit (no duplicate payouts)
//  - Guarded payout decisions (no double approve/reject, refund exactly once)
//  - Singapore-time (UTC+8) calendar keys for all daily/weekly/monthly logic
//  - Per-attempt play_id idempotency for paid games
//  - Arcade daily reward system driven by settings
//  - Session versioning (password change signs old sessions out)
//  - Login lockout + generic errors + per-route rate limiting
//  - URL validation, security headers + CSP, standardized error envelope
// ============================================================================

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Long random string set as a Worker secret. Signs all session tokens.
  SESSION_SECRET: string;
  // Long random string set as a Worker secret. Required to create the very
  // first admin account. Never placed in any HTML file.
  ADMIN_SETUP_SECRET: string;
  // Web Push (VAPID) keys, set as Worker secrets. Public key is base64url raw
  // P-256 (65 bytes); private key is base64url PKCS8. Push is silently
  // disabled if these are not set.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  // Optional R2 bucket for chat image uploads. If not bound, image uploads
  // are disabled but text chat still works.
  CHAT_IMAGES?: R2BucketLite;
}

// Minimal R2 surface we use (keeps the file free of extra type packages).
interface R2BucketLite {
  put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlayerRow {
  id: number;
  username: string;
  password: string;
  display_name: string | null;
  points: number;
  reward_cents: number;
  status: string;
  note: string | null;
  session_version: number;
  created_at: string;
  updated_at: string;
}

const ADMIN_SESSION_SECONDS = 24 * 60 * 60; // 24 hours
const PLAYER_SESSION_SECONDS = 30 * 24 * 60 * 60; // 30 days
const ALLOWED_GAMES = ['wheel', 'plinko', 'egg', 'scratch', 'cross', 'crown'] as const;
// Lucky Crossing: a cash-out ladder. Its `prizes` are LANES — cents = the lane's prize, w = survive % (0-100].
const CROSS_MAX_LANES = 6;
const MAX_PRIZES = 10;          // per game, enforced server-side on save
const TOTAL_WEIGHT = 100;       // prize weights must add up to exactly this
const MAX_BODY_BYTES = 192 * 1024; // 192 KB request body cap (templates can embed images)

const GAME_LABELS: Record<string, string> = {
  wheel: 'LE888 Spin',
  plinko: 'Orange Drop',
  egg: 'Lucky Vault',
  scratch: 'LE888 Flip',
  cross: 'Lucky Crossing',
  crown: 'Crown Pick',
};

// GC77-exact game economy. DO NOT CHANGE these values or weights.
// - cost: POINTS (PTS) spent to play.
// - prizes: weighted table of gift-credit winnings in CENTS (e.g. 288 = 2.88).
//   The server picks one entry at random, weighted by `w`. Higher w = more common.
//   Only the wheel has a 0-win ("Try Again") outcome.
interface Prize { cents: number; w: number }
// Game settings now live in the `game_configs` table and are edited by
// managers from the admin panel. See loadGameConfigs() below.

// ---------------------------------------------------------------------------
// Free-credit withdrawal rules
//
// When staff approve a reward payout, that money lands on the player's game ID
// as "free credit". How much they may then withdraw is fixed by the size of
// that free credit — the player never types an amount.
//
// All figures in CENTS. `upTo` is inclusive.
//   free credit <= $10.00   -> no wagering,  withdraw $50
//   $10.01 - $50.00         -> wager x5,     withdraw $50
//   $50.01 - $100.00        -> wager x5,     withdraw $100
//   $100.01 - $500.00       -> wager x6,     withdraw $250
//   $500.01 and above       -> wager x10,    withdraw $588
//
// The winover is shown to the player and recorded on the request. This app
// cannot see wagering on the gaming platform, so staff verify it before
// approving — we never pretend to enforce something we can't check.
// ---------------------------------------------------------------------------
interface FreeCreditRule { upTo: number; winover: number; cap: number }

// Used only if `withdraw_rules` has not been created yet. Once the table
// exists it is the single source of truth and a manager edits it in the admin.
const FREE_CREDIT_RULES_FALLBACK: FreeCreditRule[] = [
  { upTo: 1000, winover: 0, cap: 5000 },
  { upTo: 5000, winover: 5, cap: 5000 },
  { upTo: 10000, winover: 5, cap: 10000 },
  { upTo: 50000, winover: 6, cap: 25000 },
  { upTo: 99999999, winover: 10, cap: 58800 },
];

const RULES_CACHE_MS = 60_000;
let rulesCache: { at: number; rules: FreeCreditRule[] } | null = null;
function invalidateRulesCache(): void { rulesCache = null; }

async function loadWithdrawRules(env: Env): Promise<FreeCreditRule[]> {
  const now = Date.now();
  if (rulesCache && now - rulesCache.at < RULES_CACHE_MS) return rulesCache.rules;
  let rules: FreeCreditRule[] = [];
  try {
    const rs = await env.DB.prepare(
      'SELECT up_to_cents, winover_x, cap_cents FROM withdraw_rules ORDER BY up_to_cents ASC',
    ).all<{ up_to_cents: number; winover_x: number; cap_cents: number }>();
    for (const r of rs.results ?? []) {
      const upTo = Math.round(Number(r.up_to_cents));
      const winover = Number(r.winover_x);
      const cap = Math.round(Number(r.cap_cents));
      if (!Number.isFinite(upTo) || upTo < 0) continue;
      if (!Number.isFinite(winover) || winover < 0) continue;
      if (!Number.isFinite(cap) || cap <= 0) continue;
      rules.push({ upTo, winover, cap });
    }
  } catch {
    if (rulesCache) return rulesCache.rules; // serve the last good copy
  }
  if (!rules.length) rules = FREE_CREDIT_RULES_FALLBACK.slice();
  rulesCache = { at: now, rules };
  return rules;
}

// Pick the band a free-credit amount falls into. Bands are inclusive at the top,
// and the largest band always catches anything above it — no amount can ever
// fall through without a rule.
function pickRule(rules: FreeCreditRule[], freeCents: number): FreeCreditRule {
  const c = Math.max(0, Math.round(Number(freeCents) || 0));
  for (const r of rules) if (c <= r.upTo) return r;
  return rules[rules.length - 1];
}

// The two figures the player sees: what they must hit, and what they get.
function freeCreditTerms(rule: FreeCreditRule, freeCents: number): { winover: number; hit_cents: number; cap_cents: number } {
  const c = Math.max(0, Math.round(Number(freeCents) || 0));
  return {
    winover: rule.winover,
    hit_cents: Math.round(c * rule.winover),
    cap_cents: rule.cap,
  };
}

async function freeCreditRule(env: Env, freeCents: number): Promise<FreeCreditRule> {
  return pickRule(await loadWithdrawRules(env), freeCents);
}

// A staff-given custom credit locks every other promo until it is cleared.
// "Locked" means the player has a custom credit still open (fc_status='open').
// A pending withdrawal against it keeps it 'open', so this covers the whole
// active -> submitted-for-withdrawal window; only staff approving (or voiding)
// the withdrawal flips it to 'used'/'voided' and unlocks the promos.
// The manual (VIP) credit's whole state lives on the players row:
//   mc_status = 'pending_submission' -> given; sits in the reward balance;
//               player hasn't pressed Submit yet. LOCKED + red notice.
//   mc_status = 'pending_approval'   -> player pressed Submit; waiting on staff.
//               LOCKED, red notice gone.
//   mc_status = NULL                 -> no manual credit. Everything unlocked.
interface ManualCredit { mc_status: string | null; mc_amount_cents: number | null; mc_winover: number | null; mc_cap_cents: number | null; mc_payout_id: number | null; }
async function getManualCredit(env: Env, playerId: number): Promise<ManualCredit | null> {
  try {
    return await env.DB.prepare(
      'SELECT mc_status, mc_amount_cents, mc_winover, mc_cap_cents, mc_payout_id FROM players WHERE id = ?',
    ).bind(playerId).first<ManualCredit>();
  } catch {
    return null; // mc_ columns not migrated yet
  }
}
// LOCKED while a manual credit is waiting (either given-not-submitted, or
// submitted-not-approved). Safe default (unlocked) if columns aren't migrated.
async function hasCustomCreditLock(env: Env, playerId: number): Promise<boolean> {
  const mc = await getManualCredit(env, playerId);
  return !!mc && (mc.mc_status === 'pending_submission' || mc.mc_status === 'pending_approval');
}
const CREDIT_LOCK_MSG = 'Please submit your VIP Free Credit first. Once you submit it and staff approve, everything unlocks again.';

// The player's single open free credit, if they have one. Only ever one row —
// guaranteed by idx_fc_one_open, not just by this query.
interface OpenFreeCredit {
  id: number; amount_cents: number; game: string; game_id: string;
  fc_winover_x: number | null; fc_hit_cents: number | null; fc_cap_cents: number | null;
}
// The player's latest approved free credit that has NOT already been withdrawn.
// Staff decide (by checking the platform) whether a player should get another
// one — the app does not block them. What the app DOES guarantee is that the
// same free credit can never be withdrawn twice.
async function getOpenFreeCredit(env: Env, playerId: number): Promise<OpenFreeCredit | null> {
  try {
    return await env.DB.prepare(
      "SELECT id, amount_cents, game, game_id, fc_winover_x, fc_hit_cents, fc_cap_cents FROM payout_requests WHERE player_id = ? AND status = 'approved' AND game_id IS NOT NULL AND game_id != '' AND (fc_status IS NULL OR fc_status NOT IN ('used','voided')) ORDER BY id DESC LIMIT 1",
    ).bind(playerId).first<OpenFreeCredit>();
  } catch {
    // Free-credit columns not migrated yet — fall back to the latest approved.
    try {
      return await env.DB.prepare(
        "SELECT id, amount_cents, game, game_id, NULL AS fc_winover_x, NULL AS fc_hit_cents, NULL AS fc_cap_cents FROM payout_requests WHERE player_id = ? AND status = 'approved' AND game_id IS NOT NULL AND game_id != '' ORDER BY id DESC LIMIT 1",
      ).bind(playerId).first<OpenFreeCredit>();
    } catch { return null; }
  }
}

// Secure weighted pick. Uses crypto random, never Math.random, never the client.
// ---------------------------------------------------------------------------
// Live game config (D1-backed)
//
// Settings live in the `game_configs` table so a manager can edit them from the
// admin panel. There is no hardcoded copy — the table is the only source.
//
// Caching: each Worker isolate keeps the settings in memory for 60 seconds.
// A save bumps `version` and clears this isolate's cache immediately; other
// isolates pick the change up within 60s. Nothing is cached longer than that.
// ---------------------------------------------------------------------------

interface LiveGameConf { cost: number; prizes: Prize[]; enabled: boolean; version: number }

const GAME_CACHE_MS = 60_000;
let gameCache: { at: number; map: Record<string, LiveGameConf> } | null = null;

function invalidateGameCache(): void { gameCache = null; }

// Parse prizes_json defensively. A bad row must never crash a play, and must
// never silently become a different prize table — we return [] and the caller
// falls back to the known-good const.
function parsePrizes(raw: unknown): Prize[] {
  let arr: unknown;
  try { arr = JSON.parse(String(raw ?? '')); } catch { return []; }
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > MAX_PRIZES) return [];
  const out: Prize[] = [];
  for (const item of arr) {
    const cents = Math.round(Number((item as any)?.cents));
    const w = Number((item as any)?.w);
    if (!Number.isFinite(cents) || cents < 0 || cents > 1000000) return [];
    if (!Number.isFinite(w) || w <= 0) return [];
    out.push({ cents, w });
  }
  return out;
}

async function loadGameConfigs(env: Env): Promise<Record<string, LiveGameConf>> {
  const now = Date.now();
  if (gameCache && now - gameCache.at < GAME_CACHE_MS) return gameCache.map;

  const map: Record<string, LiveGameConf> = {};
  try {
    const rs = await env.DB.prepare(
      'SELECT game, cost, prizes_json, enabled, version FROM game_configs',
    ).all<{ game: string; cost: number; prizes_json: string; enabled: number; version: number }>();
    for (const row of rs.results ?? []) {
      if (!(ALLOWED_GAMES as readonly string[]).includes(row.game)) continue;
      const prizes = parsePrizes(row.prizes_json);
      const cost = Math.floor(Number(row.cost));
      if (!prizes.length || !Number.isFinite(cost) || cost < 1) continue; // bad row -> use the const
      map[row.game] = {
        cost,
        prizes,
        enabled: Number(row.enabled) === 1,
        version: Number(row.version) || 1,
      };
    }
  } catch {
    // Table not migrated yet, or D1 hiccup. Serve the last good copy if we have
    // one rather than silently reverting to the const mid-flight.
    if (gameCache) return gameCache.map;
  }

  // No hardcoded fallback any more — `game_configs` is the single source of
  // truth. A game missing from the table simply cannot be played, which is the
  // safe failure: better a clear "unavailable" than paying out guessed prizes.
  gameCache = { at: now, map };
  return map;
}

// Uncached read for the admin editor, so a manager always sees exactly what is
// stored — never a copy that is up to 60 seconds stale.
async function readGameConfigsFresh(env: Env): Promise<Record<string, GameRow>> {
  const out: Record<string, GameRow> = {};
  const rs = await env.DB.prepare(
    'SELECT game, cost, prizes_json, enabled, version, updated_at, updated_by FROM game_configs',
  ).all<GameRow>();
  for (const row of rs.results ?? []) {
    if (!(ALLOWED_GAMES as readonly string[]).includes(row.game)) continue;
    out[row.game] = row;
  }
  return out;
}

interface GameRow {
  game: string; cost: number; prizes_json: string; enabled: number;
  version: number; updated_at: string; updated_by: string | null;
}

// ---- Validation, shared by /games/save and /games/simulate -----------------
// Server-side and authoritative. The admin UI does the same checks for instant
// feedback, but nothing here trusts the UI.
type GameValidation = { ok: true; cost: number; prizes: Prize[] } | { ok: false; code: string; msg: string };

function validateGameInput(game: string, rawCost: unknown, rawPrizes: unknown): GameValidation {
  if (!(ALLOWED_GAMES as readonly string[]).includes(game)) {
    return { ok: false, code: 'UNKNOWN_GAME', msg: 'Unknown game.' };
  }
  const cost = Math.floor(Number(rawCost));
  if (!Number.isFinite(cost) || cost < 1) {
    return { ok: false, code: 'BAD_COST', msg: 'Cost must be at least 1 point.' };
  }
  if (cost > 100000) return { ok: false, code: 'BAD_COST', msg: 'Cost is too large.' };

  if (!Array.isArray(rawPrizes) || rawPrizes.length === 0) {
    return { ok: false, code: 'NO_PRIZES', msg: 'Add at least one prize.' };
  }
  if (rawPrizes.length > MAX_PRIZES) {
    return { ok: false, code: 'TOO_MANY_PRIZES', msg: `A game can have at most ${MAX_PRIZES} prizes.` };
  }
  if (game === 'crown') {
    const paying = rawPrizes.filter((p) => Math.round(Number((p as any)?.cents)) > 0).length;
    const zeros = rawPrizes.length - paying;
    if (paying > 4) return { ok: false, code: 'TOO_MANY_JACKPOTS', msg: 'Crown Pick has 4 jackpots (Grand, Major, Minor, Mini) — add at most 4 paying prizes.' };
    if (zeros > 1) return { ok: false, code: 'TOO_MANY_ZEROS', msg: 'Crown Pick can have only one 0.00 (no win) prize.' };
  }
  if (game === 'cross' && rawPrizes.length > CROSS_MAX_LANES) {
    return { ok: false, code: 'TOO_MANY_LANES', msg: `Lucky Crossing has ${CROSS_MAX_LANES} lanes — add at most ${CROSS_MAX_LANES} prizes.` };
  }

  const prizes: Prize[] = [];
  let weightSum = 0;
  let anyPaying = false;
  for (const item of rawPrizes) {
    const cents = Math.round(Number((item as any)?.cents));
    const w = Math.round(Number((item as any)?.w) * 1000) / 1000; // 3 dp
    if (!Number.isFinite(cents) || cents < 0) {
      return { ok: false, code: 'BAD_PRIZE', msg: 'Prize amounts cannot be negative.' };
    }
    if (cents > 1000000) return { ok: false, code: 'BAD_PRIZE', msg: 'A prize is too large.' };
    if (!Number.isFinite(w) || w <= 0) {
      return { ok: false, code: 'BAD_WEIGHT', msg: 'Every prize needs a chance greater than 0.' };
    }
    if (game === 'cross' && w > 100) {
      return { ok: false, code: 'BAD_SURVIVE', msg: 'Survive chance cannot be more than 100%.' };
    }
    if (cents > 0) anyPaying = true;
    weightSum += w;
    prizes.push({ cents, w });
  }
  if (!anyPaying) {
    return { ok: false, code: 'NO_PAYING_PRIZE', msg: 'At least one prize must pay more than 0.00.' };
  }
  // Lucky Crossing: each lane's w is its own survive %, so there is no total to check.
  if (game === 'cross') return { ok: true, cost, prizes };
  // Exactly 100, allowing for the tiny error you get with decimals like 33.33.
  if (Math.abs(weightSum - TOTAL_WEIGHT) > 0.001) {
    return { ok: false, code: 'BAD_WEIGHT_SUM', msg: `Chances must add up to 100%. They currently add up to ${(Math.round(weightSum * 1000) / 1000)}%.` };
  }
  return { ok: true, cost, prizes };
}

// Lucky Crossing: value of the best stopping strategy (prize of lane k x chance of surviving lanes 1..k).
function crossBestValueCents(lanes: Prize[]): number {
  let p = 1, best = 0;
  for (const l of lanes) { p *= Math.max(0, Math.min(100, l.w)) / 100; best = Math.max(best, l.cents * p); }
  return best;
}
// Expected payout in cents for one play.
function expectedPayoutCents(prizes: Prize[]): number {
  const total = prizes.reduce((s, p) => s + p.w, 0) || 1;
  return prizes.reduce((s, p) => s + p.cents * (p.w / total), 0);
}

// What one point is worth, in cents, derived from the top-up rate:
// What one point is worth, in cents.
// `deposit_point_rate` = DOLLARS a player must top up to earn 1 point
// (see /api/admin/deposit/record: points = floor(amount / rate)).
// So rate 10 means $10 per point, i.e. one point is worth 1000 cents.
// rate 0 means deposit points are switched off — no meaningful value.
function pointValueCents(settings: Record<string, string>): number {
  const rate = Math.floor(Number(settings.deposit_point_rate ?? '10'));
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return rate * 100;
}

// Return to player: what a play pays back, against what the points cost to buy.
function rtpPercent(prizes: Prize[], cost: number, ptCents: number): number | null {
  const spend = cost * ptCents;
  if (!(spend > 0)) return null;
  return Math.round((expectedPayoutCents(prizes) / spend) * 10000) / 100;
}

// crypto.getRandomValues caps at 65536 bytes per call, so fill in chunks.
function randomFloats(n: number): Float64Array {
  const out = new Float64Array(n);
  const CHUNK = 16384; // 16384 * 4 bytes = 65536
  const buf = new Uint32Array(Math.min(n, CHUNK));
  for (let i = 0; i < n; i += CHUNK) {
    const take = Math.min(CHUNK, n - i);
    const view = take === buf.length ? buf : buf.subarray(0, take);
    crypto.getRandomValues(view);
    for (let j = 0; j < take; j++) out[i + j] = view[j] / 4294967296;
  }
  return out;
}

async function getGameConf(env: Env, game: string): Promise<LiveGameConf | null> {
  const map = await loadGameConfigs(env);
  return map[game] ?? null;
}

// What the player app needs to draw prize labels. These strings are produced by
// the SAME centsToStr() the play response uses, so a label always matches the
// `win` value exactly — Plinko's SLOTS.indexOf(res.win) can never miss.
async function publicGames(env: Env): Promise<{
  game_costs: Record<string, number>;
  game_prizes: Record<string, string[]>;
  game_enabled: Record<string, boolean>;
}> {
  const map = await loadGameConfigs(env);
  const game_costs: Record<string, number> = {};
  const game_prizes: Record<string, string[]> = {};
  const game_enabled: Record<string, boolean> = {};
  for (const g of ALLOWED_GAMES) {
    const c = map[g];
    if (!c) continue;
    game_costs[g] = c.cost;
    game_prizes[g] = c.prizes.map((p) => centsToStr(p.cents));
    game_enabled[g] = c.enabled;
  }
  return { game_costs, game_prizes, game_enabled };
}

function pickPrize(prizes: Prize[]): number {
  const total = prizes.reduce((s, p) => s + p.w, 0);
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; // [0,1)
  let acc = 0;
  const target = r * total;
  for (const p of prizes) {
    acc += p.w;
    if (target < acc) return p.cents;
  }
  return prizes[prizes.length - 1].cents;
}

function centsToStr(cents: number): string {
  return (cents / 100).toFixed(2);
}

const POINT_TYPES = {
  CHECKIN: 'checkin',
  TASK_COMPLETE: 'task_complete',
  ARCADE_DAILY: 'arcade_daily',
  ARCADE_PLAY: 'arcade_play',
  REWARD_SUBMIT: 'reward_submit',
  DEPOSIT_BONUS: 'deposit_bonus',
  PROMO: 'promo',
  VIP_WEEKLY: 'vip_weekly',
  VIP_UPGRADE: 'vip_upgrade',
  ADMIN_CORRECTION: 'admin_correction',
  SYSTEM_ADJUSTMENT: 'system_adjustment',
} as const;

// Daily check-in reward schedule (points for day 1..7 of the streak). DO NOT
// reorder without also updating the player UI. Once the streak reaches day 7 it
// STAYS at day 7's reward for every further consecutive day (never cycles back).
const CHECKIN_REWARDS = [1, 2, 3, 4, 5, 8, 10];
function checkinPointsForStreak(streak: number): number {
  const idx = Math.min(Math.max(streak, 1), CHECKIN_REWARDS.length) - 1;
  return CHECKIN_REWARDS[idx];
}
// Default minimum qualifying deposit (SGD) to unlock a day's check-in.
const CHECKIN_MIN_DEPOSIT_DEFAULT = 10;

// VIP ranks. DO NOT CHANGE. Rank is based on total deposits recorded in the
// current month (Singapore time).
const VIP_RANKS = [
  { name: 'Member', deposit: 500, weekly: 5, upgrade: 2 },
  { name: 'Silver', deposit: 1500, weekly: 12, upgrade: 4 },
  { name: 'Gold', deposit: 3000, weekly: 35, upgrade: 11 },
  { name: 'Platinum', deposit: 6000, weekly: 60, upgrade: 18 },
  { name: 'Diamond', deposit: 12000, weekly: 100, upgrade: 30 },
  { name: 'Royal', deposit: 25000, weekly: 160, upgrade: 48 },
  { name: 'Legend', deposit: 50000, weekly: 250, upgrade: 75 },
] as const;
// Badge image key per rank (same order as VIP_RANKS). The app shows /assets/vip-<key>.webp.
const VIP_RANK_KEYS = ['member', 'silver', 'gold', 'platinum', 'diamond', 'royal', 'legend'] as const;

// VIP weekly + tier-upgrade bonus AMOUNTS are editable by a manager in the admin
// (stored in `vip_rewards`, one row per rank). Rank names and deposit thresholds
// stay fixed in code — only the two point amounts per rank are overridable.
// Cached 60s like game configs; the code values above are the safe fallback.
interface VipReward { weekly: number; upgrade: number }
const VIP_CACHE_MS = 60_000;
let vipCache: { at: number; rewards: VipReward[] } | null = null;
function invalidateVipCache(): void { vipCache = null; }

async function loadVipRewards(env: Env, fresh = false): Promise<VipReward[]> {
  const now = Date.now();
  if (!fresh && vipCache && now - vipCache.at < VIP_CACHE_MS) return vipCache.rewards;
  // Start from the code defaults so a missing table/row always has a safe value.
  const rewards: VipReward[] = VIP_RANKS.map((r) => ({ weekly: r.weekly, upgrade: r.upgrade }));
  try {
    const rs = await env.DB.prepare('SELECT rank_idx, weekly, upgrade FROM vip_rewards')
      .all<{ rank_idx: number; weekly: number; upgrade: number }>();
    for (const row of rs.results ?? []) {
      const i = Math.floor(Number(row.rank_idx));
      if (!Number.isInteger(i) || i < 0 || i >= rewards.length) continue;
      const w = Math.floor(Number(row.weekly));
      const u = Math.floor(Number(row.upgrade));
      if (Number.isFinite(w) && w >= 0) rewards[i].weekly = w;
      if (Number.isFinite(u) && u >= 0) rewards[i].upgrade = u;
    }
  } catch {
    if (!fresh && vipCache) return vipCache.rewards; // serve last good copy on a hiccup
  }
  if (!fresh) vipCache = { at: now, rewards };
  return rewards;
}

// The rank table with the live (editable) reward amounts merged in. Everything
// that grants or displays a weekly/upgrade bonus reads through this.
interface Rank { name: string; deposit: number; weekly: number; upgrade: number }
async function getRanks(env: Env, fresh = false): Promise<Rank[]> {
  const rewards = await loadVipRewards(env, fresh);
  return VIP_RANKS.map((r, i) => ({ name: r.name, deposit: r.deposit, weekly: rewards[i].weekly, upgrade: rewards[i].upgrade }));
}

// Real game platforms a player can hold an account on. Keys are stored; labels
// are shown. Staff record the player's actual game ID per platform.
// DEPOSIT IDs — the player's own game accounts. All 7 games, 1 ID each.
const GAME_PLATFORMS = ['pussy888', 'mega888', '918kiss', '918kaya', 'live22', 'ace333', 'evo888'] as const;
const GAME_PLATFORM_LABELS: Record<string, string> = {
  pussy888: 'Pussy888', mega888: 'Mega888', '918kiss': '918kiss', '918kaya': '918kaya',
  live22: 'Live22', ace333: 'ACE333', evo888: 'evo888',
};

// FREE CREDIT IDs — separate accounts, only these 2 games, 1 ID each.
// Reward credits are sent here; deposits go to the accounts above.
const FREE_PLATFORMS = ['pussy888', 'mega888'] as const;
// A player's game IDs (one row per platform). Defensive: empty if not migrated.
async function loadGameIds(env: Env, playerId: number): Promise<Array<{ platform: string; game_id: string }>> {
  try {
    const r = await env.DB.prepare('SELECT platform, game_id FROM player_game_ids WHERE player_id = ? ORDER BY platform').bind(playerId).all<{ platform: string; game_id: string }>();
    return (r.results || []).map((x) => ({ platform: x.platform, game_id: x.game_id }));
  } catch { return []; }
}
// A player's FREE CREDIT accounts (Pussy888 / Mega888 only, 1 each).
async function loadFreeIds(env: Env, playerId: number): Promise<Array<{ platform: string; game_id: string }>> {
  try {
    const r = await env.DB.prepare('SELECT platform, game_id FROM player_free_ids WHERE player_id = ? ORDER BY platform').bind(playerId).all<{ platform: string; game_id: string }>();
    return (r.results || [])
      .filter((x) => (FREE_PLATFORMS as readonly string[]).includes(x.platform))
      .map((x) => ({ platform: x.platform, game_id: x.game_id }));
  } catch { return []; }
}
// Personal details straight off the players row (columns may be absent pre-migration).
function playerDetails(p: any) {
  return {
    bank_name: p.bank_name || '', bank_account: p.bank_account || '', bank_holder: p.bank_holder || '',
    paynow_number: p.paynow_number || '', birthday: p.birthday || '',
    bank_locked: !!p.bank_locked, birthday_locked: !!p.birthday_locked,
  };
}

// ---------------------------------------------------------------------------
// Security headers + CSP
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // The player/admin apps ship a single inline <script>. 'unsafe-inline' is
  // required for that; everything else is locked down. To drop 'unsafe-inline'
  // entirely, externalise the app JS and switch to a nonce/hash.
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
].join('; ');

// ---------------------------------------------------------------------------
// Install landing page  (/install)
//
// A public, shareable page that walks a player through installing the app:
//   - Android tab -> "Add to Home screen" via Chrome (PWA install, no APK).
//   - iPhone tab  -> Add-to-Home-Screen steps + an optional tutorial video.
// Pure marketing/onboarding. Touches no player data and no money code.
// No APK is served on purpose: an app-file download is the main thing that
// makes Google Safe Browsing flag a domain as "dangerous", so it was removed.
//
// R2 objects it expects (upload once via the Cloudflare R2 dashboard):
//   downloads/ios-install.mp4   -> optional; the iPhone tutorial video
// If it is missing the page still works (the iPhone video block hides itself).
// ---------------------------------------------------------------------------
const IOS_VIDEO_R2_KEY = 'downloads/ios-install.mp4';
const ANDROID_VIDEO_R2_KEY = 'downloads/android-install.mp4';

const INSTALL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0f">
<title>Install LE888</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #efe9dc;
    min-height: 100dvh;
    background:
      radial-gradient(1100px 620px at 50% -8%, rgba(120,92,30,0.42), transparent 60%),
      radial-gradient(760px 520px at 50% 8%, rgba(231,197,107,0.10), transparent 62%),
      linear-gradient(180deg, #0b0a0f 0%, #08070c 45%, #050409 100%);
    background-attachment: fixed;
    display: flex; flex-direction: column; align-items: center;
    padding: 30px 18px calc(34px + env(safe-area-inset-bottom));
  }
  .wrap { width: 100%; max-width: 460px; }
  .card {
    background: linear-gradient(180deg, rgba(26,23,32,0.92), rgba(16,14,20,0.94));
    border: 1px solid rgba(231,197,107,0.28);
    border-radius: 26px;
    padding: 30px 24px 26px;
    box-shadow: 0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04);
  }
  .crest { display: block; width: 96px; height: 96px; margin: 4px auto 14px; border-radius: 24px;
    box-shadow: 0 0 0 1px rgba(231,197,107,0.4), 0 10px 34px rgba(168,130,54,0.45); }
  h1 { font-family: 'Cinzel', serif; font-weight: 700; letter-spacing: 4px;
    text-align: center; margin: 0; font-size: 34px;
    background: linear-gradient(180deg, #fbead0 0%, #e7c56b 42%, #fff4d6 52%, #c1912f 70%, #8f6a22 100%);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: #e7c56b; }
  .rule { width: 190px; height: 2px; margin: 12px auto 6px;
    background: linear-gradient(90deg, transparent, rgba(231,197,107,0.85), transparent); }
  .sub { text-align: center; margin: 6px 0 20px; color: #b8ac92; font-size: 15px; font-weight: 500; }

  .tabs { display: flex; gap: 8px; background: rgba(8,7,11,0.7); border: 1px solid rgba(231,197,107,0.16);
    padding: 6px; border-radius: 16px; margin-bottom: 20px; }
  .tab { flex: 1; border: 0; cursor: pointer; border-radius: 11px; padding: 12px 8px;
    font-family: inherit; font-weight: 600; font-size: 15px; color: #b8ac92; background: transparent;
    display: flex; align-items: center; justify-content: center; gap: 8px; transition: all .18s; }
  .tab svg { width: 18px; height: 18px; }
  .tab.on { color: #1a1206;
    background: linear-gradient(180deg, #f6e4ae, #e7c56b 55%, #caa03a 100%);
    box-shadow: 0 6px 18px rgba(202,160,58,0.35); }

  .panel { display: none; }
  .panel.on { display: block; animation: fade .25s ease; }
  @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  .step { display: flex; align-items: flex-start; gap: 13px; padding: 14px 15px; margin-bottom: 10px;
    background: rgba(231,197,107,0.05); border: 1px solid rgba(231,197,107,0.14); border-radius: 14px; }
  .num { flex: none; width: 27px; height: 27px; border-radius: 50%; font-size: 14px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; color: #1a1206;
    background: linear-gradient(180deg, #f6e4ae, #e7c56b 60%, #caa03a); }
  .step p { margin: 2px 0 0; font-size: 14.5px; line-height: 1.5; color: #ded6c4; }
  .step b { color: #f6e4ae; font-weight: 600; }

  .hint { text-align: center; font-size: 13px; color: #9a8f78; margin: 2px 0 16px; }

  .cta { display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; margin-top: 8px; padding: 17px; border: 0; border-radius: 15px; cursor: pointer;
    font-family: inherit; font-weight: 700; font-size: 17px; color: #1a1206; text-decoration: none;
    background: linear-gradient(180deg, #f9ecc4, #e7c56b 55%, #caa03a 100%);
    box-shadow: 0 12px 30px rgba(202,160,58,0.4); transition: transform .12s; }
  .cta:active { transform: translateY(1px); }
  .cta svg { width: 20px; height: 20px; }
  .cta.ghost { background: transparent; color: #e7c56b; border: 1px solid rgba(231,197,107,0.4);
    box-shadow: none; font-size: 15px; padding: 14px; margin-top: 12px; }

  .vid { margin-top: 16px; border-radius: 14px; overflow: hidden; border: 1px solid rgba(231,197,107,0.2);
    background: #000; }
  .vid video { display: block; width: 100%; }
  .vidlabel { text-align: center; font-size: 12.5px; color: #9a8f78; margin: 12px 0 4px;
    text-transform: uppercase; letter-spacing: 1.5px; }

  .foot { text-align: center; margin-top: 22px; font-size: 13px; color: #7d745f; letter-spacing: .3px; }
  .foot b { color: #b8ac92; font-weight: 600; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <img class="crest" src="/icon-192.png" alt="LE888">
      <h1>LE888</h1>
      <div class="rule"></div>
      <p class="sub">Install the app on your phone</p>

      <div class="tabs">
        <button class="tab" id="tab-android" onclick="pick('android')">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.6 9.48l1.84-3.18a.4.4 0 00-.7-.4l-1.87 3.23a11.4 11.4 0 00-9.74 0L5.26 5.9a.4.4 0 10-.7.4L6.4 9.48A10.8 10.8 0 001 18h22a10.8 10.8 0 00-5.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z"/></svg>
          Android
        </button>
        <button class="tab" id="tab-iphone" onclick="pick('iphone')">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.36 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3-.79-1.55.02-2.98.9-3.77 2.29-1.6 2.79-.41 6.92 1.15 9.19.76 1.11 1.67 2.36 2.86 2.31 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.13 2.76-2.25.87-1.29 1.23-2.54 1.25-2.6-.03-.02-2.4-.92-2.42-3.65zM14.1 5.86c.64-.78 1.07-1.85.95-2.93-.92.04-2.03.61-2.69 1.38-.59.69-1.11 1.79-.97 2.85 1.02.08 2.07-.52 2.71-1.3z"/></svg>
          iPhone
        </button>
      </div>

      <!-- ANDROID -->
      <div class="panel" id="p-android">
        <div style="text-align:center;margin:2px 0 10px">
          <svg viewBox="0 0 48 48" width="38" height="38" xmlns="http://www.w3.org/2000/svg">
            <path fill="#EA4335" d="M24 24 L4.08 12.50 A23 23 0 0 1 43.92 12.50 Z"/>
            <path fill="#34A853" d="M24 24 L24.00 47.00 A23 23 0 0 1 4.08 12.50 Z"/>
            <path fill="#FBBC05" d="M24 24 L43.92 12.50 A23 23 0 0 1 24.00 47.00 Z"/>
            <circle cx="24" cy="24" r="11" fill="#fff"/>
            <circle cx="24" cy="24" r="8.2" fill="#4285F4"/>
          </svg>
        </div>
        <p class="hint">On Android, please use <b style="color:#e7c56b">Chrome</b>.</p>
        <div class="step"><div class="num">1</div><p>Tap the <b>menu</b> (the three dots at the top right of Chrome).</p></div>
        <div class="step"><div class="num">2</div><p>Tap <b>Install and create shortcut</b> (may also say <b>Add to Home screen</b> or <b>Install app</b>).</p></div>
        <div class="step"><div class="num">3</div><p>Tap <b>Install</b> (or <b>Add</b>). The LE888 icon appears on your home screen.</p></div>
        <a class="cta" href="/">Open the app now</a>
        <div id="vidbox-a">
          <div class="vidlabel">Watch: install guide</div>
          <div class="vid"><video id="amvid" controls playsinline preload="metadata" src="/media/android-install.mp4"></video></div>
        </div>
      </div>

      <!-- IPHONE -->
      <div class="panel" id="p-iphone">
        <div style="text-align:center;margin:2px 0 10px">
          <svg viewBox="0 0 48 48" width="38" height="38" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="safG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3AB0F0"/><stop offset="1" stop-color="#0C7CE6"/></linearGradient></defs><circle cx="24" cy="24" r="23" fill="url(#safG)"/><line x1="46.0" y1="24.0" x2="43.5" y2="24.0" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="43.1" y1="35.0" x2="40.9" y2="33.8" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="35.0" y1="43.1" x2="33.8" y2="40.9" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="24.0" y1="46.0" x2="24.0" y2="43.5" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="13.0" y1="43.1" x2="14.3" y2="40.9" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="4.9" y1="35.0" x2="7.1" y2="33.8" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="2.0" y1="24.0" x2="4.5" y2="24.0" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="4.9" y1="13.0" x2="7.1" y2="14.2" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="13.0" y1="4.9" x2="14.2" y2="7.1" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="24.0" y1="2.0" x2="24.0" y2="4.5" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="35.0" y1="4.9" x2="33.8" y2="7.1" stroke="#fff" stroke-width="1" opacity=".85"/><line x1="43.1" y1="13.0" x2="40.9" y2="14.2" stroke="#fff" stroke-width="1" opacity=".85"/><path fill="#F5514A" d="M34.6 13.4 L27.3 27.3 L20.7 20.7 Z"/><path fill="#F4F4F4" d="M13.4 34.6 L27.3 27.3 L20.7 20.7 Z"/></svg>
        </div>
        <p class="hint">On iPhone, please use <b style="color:#e7c56b">Safari</b>.</p>
        <div class="step"><div class="num">1</div><p>Open <b class="hostname">this website</b> in Safari.</p></div>
        <div class="step"><div class="num">2</div><p>Tap the <b>Share</b> button (a square with an arrow pointing up).</p></div>
        <div class="step"><div class="num">3</div><p>Scroll down and tap <b>Add to Home Screen</b>.</p></div>
        <div class="step"><div class="num">4</div><p>Tap <b>Add</b>. The LE888 icon appears on your home screen.</p></div>
        <a class="cta" href="/">Open in Safari now</a>
        <div id="vidbox">
          <div class="vidlabel">Watch: 30-second guide</div>
          <div class="vid"><video id="iosvid" controls playsinline preload="metadata" src="/media/ios-install.mp4"></video></div>
        </div>
      </div>

    </div>
  </div>

<script>
  // Show the current domain wherever the page says "this site".
  (function () {
    try {
      var host = location.hostname;
      var els = document.querySelectorAll('.hostname');
      for (var i = 0; i < els.length; i++) els[i].textContent = host;
    } catch (e) {}
  })();
  function pick(which) {
    var a = which === 'android';
    document.getElementById('p-android').classList.toggle('on', a);
    document.getElementById('p-iphone').classList.toggle('on', !a);
    document.getElementById('tab-android').classList.toggle('on', a);
    document.getElementById('tab-iphone').classList.toggle('on', !a);
    try { history.replaceState(null, '', '#' + which); } catch (e) {}
  }
  // Default tab: match the visitor's phone, honour a #hash if present.
  (function () {
    var h = (location.hash || '').replace('#', '');
    if (h === 'android' || h === 'iphone') return pick(h);
    var ua = navigator.userAgent || '';
    var isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
    pick(isIOS ? 'iphone' : 'android');
  })();
  // Hide a video block if its file has not been uploaded yet.
  (function () {
    [['iosvid','vidbox'],['amvid','vidbox-a']].forEach(function (pair) {
      var v = document.getElementById(pair[0]);
      if (!v) return;
      v.addEventListener('error', function () {
        var b = document.getElementById(pair[1]); if (b) b.style.display = 'none';
      });
    });
  })();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// ===== Member API bridge (step 2) — new frontend (cookie session) -> your real
// players backend. Verifies the real password, stores your signed player token in
// an HttpOnly cookie, and returns real points + points-ledger. Reward credits stay
// separate (not shown here). Games/deposits/withdrawals remain their own flows.
// Lucky Crossing rounds. Created on first use so no manual migration is needed
// (also listed in schema.sql for reference).
let crossTableReady = false;
async function ensureCrossTable(env: Env): Promise<void> {
  if (crossTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cross_rounds (
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
      UNIQUE(player_id, round_id)
    )`,
  ).run();
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_cross_rounds_player_status ON cross_rounds (player_id, status)').run(); } catch { /* ignore */ }
  crossTableReady = true;
}

async function handleMember(request: Request, env: Env, url: URL, ctx: ExecutionContext, rid: string): Promise<Response> {
  const p = url.pathname;
  const method = request.method.toUpperCase();
  const COOKIE = 'le888sid';
  const ip = clientIp(request);
  function j(data: unknown, status: number, cookie?: string): Response {
    const r = new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    if (cookie !== undefined) {
      const maxAge = cookie ? PLAYER_SESSION_SECONDS : 0;
      r.headers.append('Set-Cookie', COOKIE + '=' + cookie + '; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=' + maxAge);
    }
    return r;
  }
  function cookieToken(): string {
    const c = request.headers.get('Cookie') || '';
    for (const part of c.split(/;\s*/)) {
      if (part.indexOf(COOKIE + '=') === 0) return part.slice(COOKIE.length + 1);
    }
    return '';
  }
  async function currentPlayer(): Promise<PlayerRow | null> {
    const tok = cookieToken();
    if (!tok) return null;
    const claim = await verifyToken(env, tok, 'player');
    if (!claim) return null;
    const row = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(Number(claim.sub)).first<PlayerRow>();
    if (!row || (row.session_version || 1) !== claim.ver) return null;
    return row;
  }
  function isoDate(s: unknown): string {
    const v = String(s || '');
    if (!v) return new Date().toISOString();
    if (v.indexOf('Z') !== -1 || v.indexOf('T') !== -1) return v;
    return v.replace(' ', 'T') + 'Z';
  }

  // ---- LOGIN (real password check; token goes into an HttpOnly cookie) ----
  if (p === '/api/member/login' && method === 'POST') {
    let body: { username?: unknown; password?: unknown } = {};
    try { body = await request.json(); } catch (e) { /* ignore */ }
    const username = normalizeUsername(body.username);
    const password = String((body && body.password) || '');
    if (!username || !password) return j({ error: 'Invalid username or password.' }, 401);
    const lockKey = 'login:player:' + username;
    if ((await isLockedOut(env, lockKey)) || !(await rateLimit(env, 'login:ip:' + ip, 30, 300))) {
      return j({ error: 'Too many attempts. Please try again later.' }, 429);
    }
    const row = await env.DB.prepare('SELECT * FROM players WHERE username = ?').bind(username).first<PlayerRow>();
    if (!row || !(await verifyPassword(password, row.password))) {
      await recordAuthFail(env, lockKey, 8, 900);
      return j({ error: 'Invalid username or password.' }, 401);
    }
    if (row.status !== 'active') return j({ error: 'This account is not active. Please contact support.' }, 403);
    await clearAuthFail(env, lockKey);
    const token = await signToken(env, 'player', String(row.id), row.session_version || 1, PLAYER_SESSION_SECONDS);
    return j({ ok: true }, 200, token);
  }

  // ---- ME (real points + points-ledger) ----
  if (p === '/api/member/me' && method === 'GET') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    const { results } = await env.DB
      .prepare('SELECT type, amount, note, created_at FROM point_activity WHERE player_id = ? ORDER BY id DESC LIMIT 100')
      .bind(player.id)
      .all<{ type: string; amount: number; note: string | null; created_at: string }>();
    const ledger = (results || []).map((r) => ({
      delta: Number(r.amount) || 0,
      created_at: isoDate(r.created_at),
      type: r.type,
      note: r.note || '',
    }));
    // Profile shows the DISPLAY NAME (what the player/staff set) as the name, and
    // the player's USERNAME as the Player ID — matching the admin panel, where the
    // username IS the Player ID (e.g. le2805). The frontend upper-cases it for display.
    const displayName = (player.display_name && String(player.display_name).trim()) ? String(player.display_name).trim() : player.username;
    // Game settings come from the admin-managed `game_configs` table
    // (Admin -> Games): cost in PTS, prize labels (reward credit, SGD) and
    // whether the game is switched on. Prize labels are the SAME strings the
    // play response returns in `win`, so the app can map a result to a pocket.
    const games: Record<string, { cost: number; prizes: string[]; enabled: boolean }> = {};
    try {
      const pg = await publicGames(env);
      for (const g of Object.keys(pg.game_prizes)) {
        games[g] = { cost: pg.game_costs[g], prizes: pg.game_prizes[g], enabled: !!pg.game_enabled[g] };
      }
    } catch (e) { /* games stay empty -> app shows them as unavailable */ }
    // VIP rank for the VIP Club page: this month's deposit total decides the rank
    // (same rule as /api/vip). Names, thresholds and bonuses come from VIP_RANKS
    // plus the admin-editable bonus amounts, so the app never hard-codes them.
    let vip: Record<string, unknown> | null = null;
    try {
      const vs = await getVipStatus(env, player.id);
      const ranks = await getRanks(env);
      const next = vs.rank_idx + 1 < ranks.length ? ranks[vs.rank_idx + 1] : null;
      vip = {
        rank_idx: vs.rank_idx,
        rank_name: vs.rank_idx >= 0 ? ranks[vs.rank_idx].name : null,
        deposit_total: vs.deposit_total,
        month_key: vs.month_key,
        next_name: next ? next.name : null,
        next_deposit: next ? next.deposit : null,
        ranks: ranks.map((r, i) => ({ name: r.name, key: VIP_RANK_KEYS[i] || 'member', deposit: r.deposit, weekly: r.weekly, upgrade: r.upgrade })),
      };
    } catch (e) { vip = null; }
    return j({
      member: {
        username: displayName,
        id: player.username,
        points: Number(player.points) || 0,
        reward: centsToStr(Number(player.reward_cents) || 0),
      },
      ledger,
      games,
      vip,
      // The player's game accounts (set by staff in Admin -> Players). The home
      // screen shows the platform names; the profile lists the IDs.
      game_ids: (await loadGameIds(env, player.id)).map((g) => ({ platform: g.platform, label: GAME_PLATFORM_LABELS[g.platform] || g.platform, game_id: g.game_id })),
      free_ids: (await loadFreeIds(env, player.id)).map((g) => ({ platform: g.platform, label: GAME_PLATFORM_LABELS[g.platform] || g.platform, game_id: g.game_id })),
      game_platforms: GAME_PLATFORMS.map((k) => ({ key: k, label: GAME_PLATFORM_LABELS[k] })),
      free_platforms: FREE_PLATFORMS.map((k) => ({ key: k, label: GAME_PLATFORM_LABELS[k] })),
    }, 200);
  }

  // ---- WITHDRAW (request only; staff pay out manually). Two sources: the
  // player's open Free Credit ID (amount fixed by the rules locked at approval)
  // or a Deposit ID (player enters the amount). Bank details are saved once. ----
  const bridge = async (toPath: string) => {
    const raw = await request.text();
    const fwd = new Request(new URL(toPath, request.url).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cookieToken(), 'CF-Connecting-IP': ip },
      body: raw || '{}',
    });
    const res = await handleApi(fwd, env, ctx, rid);
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  };
  if (p === '/api/member/withdraw' && method === 'GET') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    const pl = player as any;
    const bank = { bank_name: pl.bank_name || '', bank_account: pl.bank_account || '', bank_holder: pl.bank_holder || '', paynow_number: pl.paynow_number || '', locked: !!pl.bank_locked };
    const depositIds = (await loadGameIds(env, player.id)).map((g) => ({ platform: g.platform, label: GAME_PLATFORM_LABELS[g.platform] || g.platform, game_id: g.game_id }));
    let freeCredit: Record<string, unknown> | null = null;
    try {
      const fc = await getOpenFreeCredit(env, player.id);
      if (fc) {
        let winover = fc.fc_winover_x, hitC = fc.fc_hit_cents, capC = fc.fc_cap_cents;
        if (capC == null || capC <= 0) {
          const t = freeCreditTerms(await freeCreditRule(env, fc.amount_cents), fc.amount_cents);
          winover = t.winover; hitC = t.hit_cents; capC = t.cap_cents;
        }
        let used = false;
        try { used = !!(await env.DB.prepare("SELECT 1 AS x FROM withdrawals WHERE source_payout_id = ? AND status IN ('pending','approved') LIMIT 1").bind(fc.id).first()); } catch { used = false; }
        freeCredit = { game: fc.game, game_id: fc.game_id, amount: centsToStr(fc.amount_cents), winover: winover ?? 0, hit: centsToStr(hitC ?? 0), payout: centsToStr(capC ?? 0), used };
      }
    } catch { freeCredit = null; }
    let withdrawals: unknown[] = [];
    let pending: Record<string, unknown> | null = null;
    try {
      const r = await env.DB.prepare('SELECT id, amount_cents, status, created_at, decided_at, note, source_type, source_game, source_game_id FROM withdrawals WHERE player_id = ? ORDER BY id DESC LIMIT 10').bind(player.id).all<any>()
        .catch(() => env.DB.prepare('SELECT id, amount_cents, status, created_at, decided_at, note FROM withdrawals WHERE player_id = ? ORDER BY id DESC LIMIT 10').bind(player.id).all<any>());
      withdrawals = (r.results || []).map((w: any) => ({ id: w.id, amount: centsToStr(w.amount_cents), status: w.status, created_at: isoDate(w.created_at), decided_at: w.decided_at ? isoDate(w.decided_at) : null, note: w.note || '', source_type: w.source_type || null, source_game: w.source_game || null, source_game_id: w.source_game_id || null }));
      const pw = (withdrawals as any[]).find((w) => w.status === 'pending');
      if (pw) pending = pw;
    } catch { withdrawals = []; }
    return j({ ok: true, bank, deposit_ids: depositIds, free_credit: freeCredit, pending, withdrawals }, 200);
  }
  if (p === '/api/member/withdraw' && method === 'POST') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    return bridge('/api/withdraw');
  }
  if (p === '/api/member/bank' && method === 'POST') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    return bridge('/api/me/details/save');
  }

  // ---- DEPOSIT (reference info + receipt submission; no payments happen in the app) ----
  if (p === '/api/member/deposit' && method === 'GET') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    const s = await getSettings(env);
    let submissions: unknown[] = [];
    try {
      await ensureDepositSubmissionsTable(env);
      const r = await env.DB.prepare('SELECT id, amount, method, receipt_url, reference, status, admin_note, created_at, decided_at FROM deposit_submissions WHERE player_id = ? ORDER BY id DESC LIMIT 10').bind(player.id).all<any>();
      submissions = (r.results || []).map((x: any) => ({ id: x.id, amount: Number(x.amount), method: x.method, receipt_url: x.receipt_url || '', reference: x.reference || '', status: x.status, note: x.admin_note || '', created_at: isoDate(x.created_at), decided_at: x.decided_at ? isoDate(x.decided_at) : null }));
    } catch { submissions = []; }
    return j({
      ok: true,
      info: {
        paynow: s.deposit_paynow || '', name: s.deposit_name || '', qr: s.deposit_qr || '',
        bank_name: s.deposit_bank_name || '', bank_account: s.deposit_bank_account || '', bank_holder: s.deposit_bank_holder || '',
        rate: Math.max(0, Math.floor(Number(s.deposit_point_rate ?? '10'))),
        receipts: !!env.CHAT_IMAGES,
      },
      submissions,
    }, 200);
  }
  if (p === '/api/member/deposit/receipt' && method === 'POST') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    if (!env.CHAT_IMAGES) return j({ error: 'Receipt uploads are not set up yet. Please send your receipt in Chat.' }, 503);
    if (!(await rateLimit(env, 'deprcpt:' + player.id, 20, 3600))) return j({ error: 'Please slow down.' }, 429);
    const ct = request.headers.get('content-type') || '';
    const ext = ct === 'image/webp' ? 'webp' : ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : null;
    if (!ext) return j({ error: 'Only JPG, PNG or WebP images are allowed.' }, 400);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 100 || bytes.byteLength > 3_000_000) return j({ error: 'Image must be under 3 MB.' }, 400);
    const key = 'rcpt-' + crypto.randomUUID().replace(/-/g, '') + '.' + ext;
    await env.CHAT_IMAGES.put(key, bytes, { httpMetadata: { contentType: ct } });
    return j({ ok: true, url: '/api/chat/img/' + key }, 200);
  }
  if (p === '/api/member/deposit/submit' && method === 'POST') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    if (player.status !== 'active') return j({ error: 'This account is not active. Please contact support.' }, 403);
    if (!(await rateLimit(env, 'depsub:' + player.id, 10, 3600))) return j({ error: 'Please slow down.' }, 429);
    let body: any = {};
    try { body = await request.json(); } catch { body = {}; }
    const amount = Math.round(Number(body.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount < 1 || amount > 100000) return j({ error: 'Enter the amount you transferred (SGD 1 - 100,000).' }, 400);
    const methodKey = String(body.method || 'paynow') === 'bank' ? 'bank' : 'paynow';
    const receipt = String(body.receipt_url || '').trim();
    if (receipt && !/^\/api\/chat\/img\/rcpt-[a-f0-9]{32}\.(webp|jpg|png)$/.test(receipt)) return j({ error: 'Invalid receipt.' }, 400);
    if (!receipt && env.CHAT_IMAGES) return j({ error: 'Please attach your transfer receipt.' }, 400);
    const reference = String(body.reference || '').trim().slice(0, 80);
    await ensureDepositSubmissionsTable(env);
    const pend = await env.DB.prepare("SELECT COUNT(*) AS c FROM deposit_submissions WHERE player_id = ? AND status = 'pending'").bind(player.id).first<{ c: number }>();
    if ((pend?.c ?? 0) >= 3) return j({ error: 'You already have 3 requests waiting. Please wait for staff to review them.' }, 429);
    const ins = await env.DB.prepare('INSERT INTO deposit_submissions (player_id, amount, method, receipt_url, reference) VALUES (?, ?, ?, ?, ?)').bind(player.id, amount, methodKey, receipt || null, reference || null).run();
    return j({ ok: true, submission: { id: ins.meta.last_row_id, amount, method: methodKey, receipt_url: receipt, reference, status: 'pending', note: '', created_at: new Date().toISOString(), decided_at: null } }, 200);
  }

  // ---- LUCKY CROSSING (real, cookie session) ----
  // A round = one entry fee, then lane by lane: each step is rolled HERE
  // against the lane's survive %, and the player can collect the current
  // lane's prize at any time. The ladder is snapshotted into the round so an
  // admin edit mid-round never changes a running game.
  if (p.indexOf('/api/member/cross/') === 0 && method === 'POST') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    if (player.status !== 'active') return j({ error: 'This account is not active. Please contact support.' }, 403);
    if (await hasCustomCreditLock(env, player.id)) return j({ error: CREDIT_LOCK_MSG }, 409);
    if (!(await rateLimit(env, 'cross:' + player.id, 90, 60))) return j({ error: 'Please slow down.' }, 429);
    let body: { round_id?: unknown; lane?: unknown } = {};
    try { body = await request.json(); } catch (e) { /* ignore */ }
    const action = p.slice('/api/member/cross/'.length);
    const roundId = String(body.round_id || '');
    if (!isValidPlayId(roundId)) return j({ error: 'Invalid round id.' }, 400);
    const conf = await getGameConf(env, 'cross');
    if (!conf) return j({ error: 'Lucky Crossing is being set up. Please try again shortly.' }, 503);
    await ensureCrossTable(env);
    type CrossRow = { id: number; player_id: number; round_id: string; status: string; lane: number; cost: number; win_cents: number; ladder_json: string };
    const getRound = () => env.DB.prepare('SELECT * FROM cross_rounds WHERE player_id = ? AND round_id = ?').bind(player.id, roundId).first<CrossRow>();
    const balances = async () => {
      const b = await env.DB.prepare('SELECT points, reward_cents FROM players WHERE id = ?').bind(player.id).first<{ points: number; reward_cents: number }>();
      return { points: b?.points ?? player.points, reward: centsToStr(b?.reward_cents ?? 0) };
    };
    const ladderOf = (r: CrossRow): Prize[] => { const l = parsePrizes(r.ladder_json); return l.length ? l : conf.prizes; };
    const view = async (r: CrossRow, extra: Record<string, unknown> = {}) => {
      const lad = ladderOf(r);
      return j({
        ok: true, round_id: r.round_id, status: r.status, lane: r.lane, lanes: lad.length, cost: r.cost,
        prize: r.lane > 0 ? centsToStr(lad[Math.min(r.lane, lad.length) - 1].cents) : '0.00',
        win: centsToStr(r.win_cents || 0),
        ...(await balances()), ...extra,
      }, 200);
    };
    // Finish a round exactly once: the status guard makes a double collect / double hit a no-op.
    const finish = async (r: CrossRow, status: 'hit' | 'collected', lane: number, winCents: number): Promise<boolean> => {
      const u = await env.DB.prepare("UPDATE cross_rounds SET status = ?, lane = ?, win_cents = ?, updated_at = datetime('now') WHERE id = ? AND status = 'active'").bind(status, lane, winCents, r.id).run();
      if (!u.meta.changes) return false;
      const stmts = [env.DB.prepare('UPDATE arcade_activity SET win_cents = ?, result_label = ? WHERE player_id = ? AND play_id = ?').bind(winCents, winCents > 0 ? 'win' : 'no_win', player.id, r.round_id)];
      if (winCents > 0) stmts.push(env.DB.prepare("UPDATE players SET reward_cents = reward_cents + ?, updated_at = datetime('now') WHERE id = ?").bind(winCents, player.id));
      await env.DB.batch(stmts);
      if (winCents >= 1000) { try { await sendAutoMessage(env, player.id, 'big_win', { win_amount: centsToStr(winCents), game: GAME_LABELS.cross }); } catch (e) { /* best-effort */ } }
      return true;
    };

    if (action === 'start') {
      if (!conf.enabled) return j({ error: 'Lucky Crossing is not available right now.' }, 403);
      // An unfinished round continues (no second charge).
      const active = await env.DB.prepare("SELECT * FROM cross_rounds WHERE player_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").bind(player.id).first<CrossRow>();
      if (active) return view(active, { resumed: true });
      const ins = await env.DB.prepare("INSERT OR IGNORE INTO cross_rounds (player_id, round_id, status, lane, cost, win_cents, ladder_json) VALUES (?, ?, 'pending', 0, ?, 0, ?)").bind(player.id, roundId, conf.cost, JSON.stringify(conf.prizes)).run();
      if (!ins.meta.changes) { const r = await getRound(); if (r) return view(r); return j({ error: 'Could not start the round.' }, 500); }
      const rowId = ins.meta.last_row_id as number;
      const ded = await env.DB.prepare("UPDATE players SET points = points - ?, updated_at = datetime('now') WHERE id = ? AND points >= ? RETURNING points").bind(conf.cost, player.id, conf.cost).first<{ points: number }>();
      if (!ded) { await env.DB.prepare('DELETE FROM cross_rounds WHERE id = ?').bind(rowId).run(); return j({ error: 'Not enough points.' }, 402); }
      try {
        await env.DB.batch([
          env.DB.prepare("UPDATE cross_rounds SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(rowId),
          env.DB.prepare("INSERT OR IGNORE INTO arcade_activity (player_id, play_id, game, activity_date, points_added, win_cents, result_label) VALUES (?, ?, 'cross', ?, ?, 0, 'pending')").bind(player.id, roundId, sgtDateKey(), -conf.cost),
          env.DB.prepare('INSERT INTO point_activity (player_id, type, amount, points_after, note) VALUES (?, ?, ?, ?, ?)').bind(player.id, POINT_TYPES.ARCADE_PLAY, -conf.cost, ded.points, 'Played Lucky Crossing'),
        ]);
      } catch (e) {
        try { await env.DB.batch([env.DB.prepare("UPDATE players SET points = points + ?, updated_at = datetime('now') WHERE id = ?").bind(conf.cost, player.id), env.DB.prepare('DELETE FROM cross_rounds WHERE id = ?').bind(rowId)]); } catch (e2) { console.error(JSON.stringify({ rid, msg: 'cross_refund_failed', player: player.id, err: String((e2 as any)?.message || e2) })); }
        return j({ error: 'That round could not be started. Your points have been returned — please try again.' }, 500);
      }
      const r = await getRound();
      if (!r) return j({ error: 'Could not start the round.' }, 500);
      return view(r);
    }

    const r = await getRound();
    if (!r) return j({ error: 'Round not found.' }, 404);
    if (r.status !== 'active') return view(r);
    const lad = ladderOf(r);

    if (action === 'step') {
      // The client says which lane it thinks it is on; a stale retry gets the current state back instead of a second roll.
      const expect = Number(body.lane);
      if (Number.isFinite(expect) && expect !== r.lane) return view(r);
      const next = r.lane + 1;
      if (next > lad.length) return view(r);
      const survive = Math.max(0, Math.min(100, lad[next - 1].w)) / 100;
      const roll = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
      if (roll < survive) {
        if (next === lad.length) {
          // Made it all the way across: the last lane pays out automatically.
          await finish(r, 'collected', next, lad[next - 1].cents);
          const done = await getRound();
          return view(done || r, { safe: true, auto: true });
        }
        const u = await env.DB.prepare("UPDATE cross_rounds SET lane = ?, updated_at = datetime('now') WHERE id = ? AND status = 'active' AND lane = ?").bind(next, r.id, r.lane).run();
        if (!u.meta.changes) { const cur = await getRound(); return view(cur || r); }
        return view({ ...r, lane: next }, { safe: true });
      }
      await finish(r, 'hit', r.lane, 0);
      const done = await getRound();
      return view(done || { ...r, status: 'hit' }, { hit_lane: next });
    }

    if (action === 'collect') {
      if (r.lane < 1) return j({ error: 'Cross at least one lane first.' }, 400);
      await finish(r, 'collected', r.lane, lad[r.lane - 1].cents);
      const done = await getRound();
      return view(done || r);
    }
    return j({ error: 'Unknown action.' }, 404);
  }

  // ---- PLAY (real, cookie session) ----
  // Bridges the new app to the existing, battle-tested /api/arcade/play:
  // same idempotent play_id, same atomic PTS deduction, same server-side
  // prize pick from the admin's prize table. The cookie's signed token is
  // handed over as a Bearer token so no second auth path exists.
  if (p === '/api/member/play' && method === 'POST') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    const raw = await request.text();
    const fwd = new Request(new URL('/api/arcade/play', request.url).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cookieToken(),
        'CF-Connecting-IP': ip,
      },
      body: raw,
    });
    const res = await handleApi(fwd, env, ctx, rid);
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  // ---- LOGOUT ----
  if (p === '/api/member/logout' && method === 'POST') {
    return j({ ok: true }, 200, '');
  }

  // ---- PASSWORD (real; bumps session_version, clears cookie) ----
  if (p === '/api/member/password' && method === 'POST') {
    const player = await currentPlayer();
    if (!player) return j({ error: 'Please sign in.' }, 401);
    if (!(await rateLimit(env, 'pwd:' + player.id, 6, 300))) return j({ error: 'Too many attempts. Please try again later.' }, 429);
    let body: { currentPassword?: unknown; newPassword?: unknown } = {};
    try { body = await request.json(); } catch (e) { /* ignore */ }
    const current = String((body && body.currentPassword) || '');
    const next = String((body && body.newPassword) || '');
    if (next.length < 8) return j({ error: 'New password must be at least 8 characters.' }, 400);
    if (!(await verifyPassword(current, player.password))) return j({ error: 'Current password is incorrect.' }, 401);
    const hash = await hashPassword(next);
    await env.DB.prepare("UPDATE players SET password = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?").bind(hash, player.id).run();
    return j({ ok: true }, 200, '');
  }

  return j({ error: 'Not found' }, 404);
}
// ===== end member API bridge ================================================

export default {
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledPushes(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const rid = crypto.randomUUID();

    try {
      // ===== Member API + /login gate =======================================
      // The new frontend talks to /api/member/* (cookie session). handleMember
      // verifies the real password, keeps your signed player token in an
      // HttpOnly cookie, and returns real points + points-ledger from D1.
      if (url.pathname.startsWith('/api/member/')) {
        return await handleMember(request, env, url, ctx, rid);
      }
      if (request.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login.html')) {
        const res = await env.ASSETS.fetch(new Request(new URL('/login.html', request.url).toString(), request));
        return decorateAsset(res, true);
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const authed = (request.headers.get('Cookie') || '').indexOf('le888sid=') !== -1;
        if (!authed) return Response.redirect(new URL('/login', request.url).toString(), 302);
        // authed -> fall through and serve public/index.html via ASSETS below
      }
      // ===== end step-1 preview block =======================================

      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx, rid);
      }

      // ---- Install landing page -----------------------------------------
      // Public onboarding page. Teaches "Add to Home Screen" (PWA install).
      // No app-file download is served — the APK was removed on purpose so
      // Google Safe Browsing has no "installing software" reason to flag it.
      if (request.method === 'GET' && (url.pathname === '/install' || url.pathname === '/install/')) {
        return decorateAsset(new Response(INSTALL_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }), true);
      }
      // Optional iPhone tutorial video, played inline on the install page.
      // Served from R2 or /public/ios-install.mp4.
      if (request.method === 'GET' && url.pathname === '/media/ios-install.mp4') {
        return await serveDownload(request, env, IOS_VIDEO_R2_KEY, 'ios-install.mp4', 'LE888-install.mp4', 'video/mp4', false);
      }
      // Optional Android tutorial video, played inline on the install page.
      if (request.method === 'GET' && url.pathname === '/media/android-install.mp4') {
        return await serveDownload(request, env, ANDROID_VIDEO_R2_KEY, 'android-install.mp4', 'LE888-install.mp4', 'video/mp4', false);
      }

      if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
        const res = await env.ASSETS.fetch(new Request(new URL('/admin.html', request.url).toString(), request));
        return decorateAsset(res, true);
      }

      const assetRes = await env.ASSETS.fetch(request);
      return decorateAsset(assetRes, (assetRes.headers.get('content-type') || '').includes('text/html'));
    } catch (err) {
      console.error(JSON.stringify({ rid, level: 'error', msg: 'unhandled', error: String((err && (err as Error).message) || err) }));
      return json({ ok: false, error: 'Internal error', code: 'INTERNAL_ERROR' }, 500, rid);
    }
  },
};

// Add CSP + security headers to served HTML; leave other assets cacheable.
function decorateAsset(res: Response, isHtml: boolean): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (isHtml) {
    headers.set('Content-Security-Policy', CSP);
    // HTML must always revalidate so a deploy is never trapped behind a cache.
    headers.set('Cache-Control', 'no-cache');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Stream a file (APK, video) to the browser. Looks in two places so uploading
// is flexible: first R2 (key), then the static assets folder (assetPath, i.e.
// a file committed to /public). `attach` forces a download prompt; otherwise
// the browser may play/preview it inline. Returns a friendly 404 when the file
// has not been provided in either place, so the page degrades cleanly.
async function serveDownload(request: Request, env: Env, key: string, assetPath: string, filename: string, contentType: string, attach: boolean): Promise<Response> {
  const dl: Record<string, string> = attach ? { 'Content-Disposition': 'attachment; filename="' + filename + '"' } : {};

  // 1) R2 object, if a bucket is bound and the key exists.
  if (env.CHAT_IMAGES) {
    const obj = await env.CHAT_IMAGES.get(key);
    if (obj) {
      return new Response(obj.body, { headers: {
        'Content-Type': obj.httpMetadata?.contentType || contentType,
        'Cache-Control': 'public, max-age=300', ...dl, ...SECURITY_HEADERS,
      } });
    }
  }

  // 2) Static asset committed to /public (e.g. /public/LE888.apk).
  try {
    const a = await env.ASSETS.fetch(new Request(new URL('/' + assetPath, request.url).toString(), request));
    if (a.ok) {
      return new Response(a.body, { headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=300', ...dl, ...SECURITY_HEADERS,
      } });
    }
  } catch { /* fall through to 404 */ }

  return new Response('This download is not ready yet. Please try again later.', {
    status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, rid?: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  };
  if (rid) headers['X-Request-Id'] = rid;
  return new Response(JSON.stringify(data), { status, headers });
}

// Standardized error envelope. Keeps the top-level string `error` for existing
// frontend compatibility and adds a machine-readable `code`.
function fail(code: string, message: string, status: number, rid?: string): Response {
  return json({ ok: false, error: message, code }, status, rid);
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

// True when a request comes from the installed app rather than a plain browser.
// - Android APK (TWA) sends X-Requested-With with our package name automatically.
// - The PWA (iPhone home-screen app / installed Android PWA) reports standalone
//   mode via the X-LE888-App header our own client sets.
// This is a CLIENT-PROVIDED signal, so it can be spoofed by a technical user. It
// only ever decides whether an app-only promo may be claimed — it can never move
// points or money — so the money invariants are unaffected either way.
function isAppRequest(request: Request): boolean {
  const xrw = (request.headers.get('X-Requested-With') || '').toLowerCase();
  if (xrw.indexOf('com.tr666app.official') !== -1) return true;
  if ((request.headers.get('X-LE888-App') || '') === '1') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Singapore time (UTC+8, no DST) - the single source of truth for calendars.
// Stored timestamps stay in UTC (datetime('now')); only calendar KEYS are SGT.
// ---------------------------------------------------------------------------

const SGT_OFFSET_MS = 8 * 3600 * 1000;

function sgtNow(): Date {
  return new Date(Date.now() + SGT_OFFSET_MS);
}
function sgtDateKey(d: Date = sgtNow()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (SGT)
}
function sgtYesterdayKey(): string {
  return new Date(sgtNow().getTime() - 86400000).toISOString().slice(0, 10);
}
function monthKeySGT(): string {
  return sgtNow().toISOString().slice(0, 7); // YYYY-MM (SGT)
}
function weekKeySGT(): string {
  // The Monday date (SGT) of the current week, e.g. "2026-07-20".
  const d = sgtNow();
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - daysSinceMonday * 86400000);
  return monday.toISOString().slice(0, 10);
}
// Convert an SGT calendar date to the UTC "YYYY-MM-DD HH:MM:SS" boundary that
// created_at (stored in UTC) is compared against. Keeps all admin date
// filters aligned to Singapore days.
function sgtDayStartUtc(day: string): string {
  return new Date(new Date(day + 'T00:00:00Z').getTime() - SGT_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}
function sgtDayEndUtc(day: string): string {
  return new Date(new Date(day + 'T23:59:59Z').getTime() - SGT_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) - no external services.
// Notifications are best-effort: any failure here must never affect game or
// balance logic, so every sender swallows its own errors.
// ---------------------------------------------------------------------------

function b64uToBytes(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

async function hkdfBits(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as unknown as ArrayBuffer, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, info: info as unknown as ArrayBuffer }, key, bytes * 8);
  return new Uint8Array(bits);
}

// Encrypt a payload for one subscription (RFC 8291, aes128gcm).
async function encryptWebPush(p256dhB64u: string, authB64u: string, payload: string): Promise<Uint8Array> {
  const clientPub = b64uToBytes(p256dhB64u);   // 65-byte uncompressed point
  const authSecret = b64uToBytes(authB64u);    // 16-byte auth secret
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const clientKey = await crypto.subtle.importKey('raw', clientPub as unknown as ArrayBuffer, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, eph.privateKey, 256));
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const ikm = await hkdfBits(authSecret, ecdh, concatBytes(utf8('WebPush: info\0'), clientPub, ephPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfBits(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfBits(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const plain = concatBytes(utf8(payload), new Uint8Array([2])); // 0x02 = last-record delimiter
  const aes = await crypto.subtle.importKey('raw', cek as unknown as ArrayBuffer, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer }, aes, plain as unknown as ArrayBuffer));
  // aes128gcm content header: salt(16) | record-size(4, 4096) | keyid-len(1, 65) | ephemeral pubkey(65) | ciphertext
  return concatBytes(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), ephPub, ct);
}

// Short-lived VAPID JWT (ES256) for one push service origin.
async function vapidJwt(env: Env, audience: string): Promise<string> {
  const priv = await crypto.subtle.importKey('pkcs8', b64uToBytes(String(env.VAPID_PRIVATE_KEY)) as unknown as ArrayBuffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = bytesToB64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(utf8(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:nicholaschow2805@gmail.com' })));
  const signing = head + '.' + claims;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, utf8(signing) as unknown as ArrayBuffer));
  return signing + '.' + bytesToB64u(sig);
}

// Send one push. Returns HTTP status (0 on failure / push not configured).
async function sendWebPush(env: Env, sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<number> {
  try {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
    const jwt = await vapidJwt(env, new URL(sub.endpoint).origin);
    const body = await encryptWebPush(sub.p256dh, sub.auth, payload);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '86400',
        'Urgency': 'normal',
        'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      },
      body: body as unknown as ArrayBuffer,
    });
    return res.status;
  } catch {
    return 0;
  }
}

type PushMsg = { title: string; body: string };
// Push to every device a player subscribed; dead subscriptions are pruned.
async function pushToPlayer(env: Env, playerId: number, en: PushMsg, zh: PushMsg): Promise<void> {
  try {
    const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth, lang FROM push_subs WHERE player_id = ?').bind(playerId).all();
    for (const s of (results || []) as any[]) {
      const m = s.lang === 'zh' ? zh : en;
      const status = await sendWebPush(env, s, JSON.stringify({ title: m.title, body: m.body }));
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(s.id).run();
    }
  } catch { /* notifications must never break game logic */ }
}

// Daily cron (12:00 SGT): check-in reminders + Monday weekly-VIP reminders.
// push_log makes every send idempotent - a retried cron never double-sends.
async function runScheduledPushes(env: Env): Promise<void> {
  try {
    const settings = await getSettings(env);
    const today = sgtDateKey();
    const week = weekKeySGT();
    const { results } = await env.DB.prepare('SELECT DISTINCT player_id AS pid FROM push_subs').all();
    for (const r of (results || []) as any[]) {
      const pid = Number(r.pid);
      try {
        const checked = await env.DB.prepare('SELECT 1 AS x FROM daily_checkins WHERE player_id = ? AND checkin_date = ?').bind(pid, today).first();
        if (!checked) {
          const ins = await env.DB.prepare('INSERT OR IGNORE INTO push_log (kind, key) VALUES (?, ?)').bind('checkin', pid + ':' + today).run();
          if (ins.meta.changes) {
            await pushToPlayer(env, pid,
              { title: 'Daily check-in', body: 'Deposit today and check in to grow your streak reward.' },
              { title: '\u6bcf\u65e5\u7b7e\u5230', body: '\u4eca\u5929\u5b58\u6b3e\u5e76\u7b7e\u5230\uff0c\u8fde\u7eed\u7b7e\u5230\u5956\u52b1\u66f4\u4e30\u539a\u3002' });
          }
        }
        if (today === week) { // Monday SGT
          const claimed = await env.DB.prepare('SELECT 1 AS x FROM vip_weekly_claims WHERE player_id = ? AND week_key = ?').bind(pid, week).first();
          if (!claimed) {
            const vip = await getVipStatus(env, pid);
            if (vip.rank_idx >= 0) {
              const ins = await env.DB.prepare('INSERT OR IGNORE INTO push_log (kind, key) VALUES (?, ?)').bind('weekly', pid + ':' + week).run();
              if (ins.meta.changes) {
                const rank = (await getRanks(env))[vip.rank_idx];
                await pushToPlayer(env, pid,
                  { title: 'Weekly VIP bonus', body: `Your ${rank.name} weekly bonus (+${rank.weekly} PT) is ready to collect.` },
                  { title: '\u6bcf\u5468 VIP \u5956\u52b1', body: `\u4f60\u7684${rank.name}\u6bcf\u5468\u5956\u52b1\uff08+${rank.weekly} \u79ef\u5206\uff09\u5df2\u53ef\u9886\u53d6\u3002` });
              }
            }
          }
        }
      } catch { /* continue with next player */ }
    }
    await env.DB.prepare("DELETE FROM push_log WHERE created_at < datetime('now', '-60 days')").run();
  } catch { /* cron is best-effort */ }
  await autoPurgeChat(env);
}

// Storage fail-safe: chat history auto-deletes after 14 days - both the D1
// rows AND the R2 image files (deleting only rows would leave images behind
// and storage would keep growing). Runs daily from the same cron. Image
// deletion is capped per run so one giant backlog can't blow the CPU budget;
// anything left over is picked up the next day.
async function autoPurgeChat(env: Env): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    // 1) delete up to 400 old image files from R2 (and their rows)
    const { results } = await env.DB.prepare(
      'SELECT id, image_url FROM chat_messages WHERE created_at < ? AND image_url IS NOT NULL LIMIT 400',
    ).bind(cutoff).all();
    const rows = (results || []) as Array<{ id: number; image_url: string }>;
    for (const r of rows) {
      const key = String(r.image_url).split('/').pop() || '';
      if (env.CHAT_IMAGES && key) { try { await env.CHAT_IMAGES.delete(key); } catch { /* already gone */ } }
      await env.DB.prepare('DELETE FROM chat_messages WHERE id = ?').bind(r.id).run();
    }
    // 2) delete old text-only rows in one sweep
    await env.DB.prepare('DELETE FROM chat_messages WHERE created_at < ? AND image_url IS NULL').bind(cutoff).run();
  } catch { /* best-effort housekeeping */ }
}

// ---------------------------------------------------------------------------
// Rate limiting + login lockout (D1-backed)
// ---------------------------------------------------------------------------

// Fixed-window counter. Returns true if the request is allowed.
async function rateLimit(env: Env, bucket: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const win = now - (now % windowSec);
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = ? THEN rate_limits.count + 1 ELSE 1 END,
         window_start = ?
       RETURNING count`,
    ).bind(bucket, win, win, win).first<{ count: number }>();
    return !row || row.count <= limit;
  } catch {
    // Fail open on limiter storage errors rather than blocking legitimate users.
    return true;
  }
}

async function isLockedOut(env: Env, key: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT locked_until FROM auth_throttle WHERE id = ?').bind(key).first<{ locked_until: number }>();
  return !!(row && row.locked_until > now);
}

async function recordAuthFail(env: Env, key: string, maxFails: number, lockSeconds: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO auth_throttle (id, fails, locked_until, updated_at) VALUES (?, 1, 0, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET fails = auth_throttle.fails + 1, updated_at = datetime('now')
     RETURNING fails`,
  ).bind(key).first<{ fails: number }>();
  if (row && row.fails >= maxFails) {
    await env.DB.prepare("UPDATE auth_throttle SET fails = 0, locked_until = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(now + lockSeconds, key).run();
  }
}

async function clearAuthFail(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_throttle WHERE id = ?').bind(key).run();
}

// ---------------------------------------------------------------------------
// URL validation (tasks + contact link)
// ---------------------------------------------------------------------------

function isSafeExternalUrl(raw: unknown): boolean {
  const s = String(raw || '').trim();
  if (!s || s.length > 500) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  // https only - blocks javascript:, data:, http:, and malformed schemes.
  if (u.protocol !== 'https:') return false;
  // Any https host is permitted; WhatsApp/Telegram are explicitly supported.
  return true;
}

// ---------------------------------------------------------------------------
// JSON body (size-guarded)
// ---------------------------------------------------------------------------

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const len = Number(request.headers.get('Content-Length') || '0');
  if (len > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return null; // malformed JSON
  }
}

// Usernames: 3-32 chars, letters/numbers/underscore/dot, start with letter/number.
function normalizeUsername(input: unknown): string | null {
  const u = String(input || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.]{2,31}$/.test(u)) return null;
  return u;
}

// play_id: client-generated idempotency key. 8-64 chars of url-safe chars.
function isValidPlayId(input: unknown): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(String(input || ''));
}

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2) - shared by admins and players
// ---------------------------------------------------------------------------

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexDecode(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password: string, iterations = 100000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${hexEncode(salt)}$${hexEncode(dk)}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  const salt = hexDecode(parts[3]);
  if (!iterations || !salt.length) return false;
  const dk = await pbkdf2(password, salt, iterations);
  return timingSafeEqualHex(hexEncode(dk), parts[4].toLowerCase());
}

// ---------------------------------------------------------------------------
// Session tokens (HMAC-signed, role-separated, versioned)
// ---------------------------------------------------------------------------

interface TokenPayload {
  role: 'admin' | 'player';
  sub: string; // admin username or player id (as string)
  ver: number; // session version - must match the account's session_version
  iat: number;
  exp: number;
}

async function sessionSigningKey(env: Env): Promise<Uint8Array> {
  return hmacSha256(new TextEncoder().encode(env.SESSION_SECRET), 'tr666-session-v1');
}
async function signToken(env: Env, role: 'admin' | 'player', sub: string, ver: number, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = { role, sub, ver, iat: now, exp: now + ttlSeconds };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await sessionSigningKey(env);
  const sig = hexEncode(await hmacSha256(key, payloadB64));
  return `${payloadB64}.${sig}`;
}
async function verifyToken(env: Env, token: string, role: 'admin' | 'player'): Promise<{ sub: string; ver: number } | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await sessionSigningKey(env);
  const expected = hexEncode(await hmacSha256(key, payloadB64));
  if (!timingSafeEqualHex(expected, sig.toLowerCase())) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as TokenPayload;
    if (!payload.sub || !payload.exp || payload.role !== role) return null;
    if (Math.floor(Date.now() / 1000) > payload.exp) return null;
    return { sub: payload.sub, ver: Number(payload.ver) || 0 };
  } catch {
    return null;
  }
}
function bearerToken(request: Request): string {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

// The staff-grantable sections ("empowerment"). Managers always have all of
// these implicitly; a staff account only has the ones a manager ticked.
const GRANTABLE_PERMS = ['players', 'earn', 'activity', 'credits', 'deposits', 'games', 'rules', 'vip', 'templates', 'domains', 'rtp', 'settings', 'view_app'];

// A game/platform image is allowed if it is either an uploaded R2 image
// (/api/chat/img/...) or a static asset we ship in /public/gameicons/<folder>/.
function isRtpImage(u: string): boolean {
  return /^\/api\/chat\/img\/[a-zA-Z0-9._-]{10,80}$/.test(u)
    || /^\/gameicons\/[a-z0-9_-]{1,40}\/[a-zA-Z0-9._-]{1,80}\.(webp|png|jpg|jpeg)$/.test(u);
}

async function requireAdmin(request: Request, env: Env): Promise<{ username: string; role: string; perms: string[] } | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const claim = await verifyToken(env, token, 'admin');
  if (!claim) return null;
  let row: { username: string; session_version: number; role?: string } | null = null;
  let columnMissing = false;
  try {
    row = await env.DB.prepare('SELECT username, session_version, role FROM admins WHERE username = ?')
      .bind(claim.sub).first<{ username: string; session_version: number; role?: string }>();
  } catch {
    // The `role` column does not exist yet (schema not migrated). This is a
    // deployment-ordering state, not an attacker-controllable value, so keep
    // the pre-role behaviour of manager here. Once migrated, the branch below
    // fails CLOSED on any unexpected role value.
    columnMissing = true;
    row = await env.DB.prepare('SELECT username, session_version FROM admins WHERE username = ?')
      .bind(claim.sub).first<{ username: string; session_version: number }>();
  }
  if (!row) return null;
  if ((row.session_version || 1) !== claim.ver) return null; // password changed -> old token dead
  // Fail closed: with the column present, only the exact string 'manager'
  // grants manager. Anything else (null, typo, tampered, unknown) -> 'staff'.
  const role = columnMissing ? 'manager' : (row.role === 'manager' ? 'manager' : 'staff');
  // Load this staff account's granted sections. Managers bypass, so we skip it.
  let perms: string[] = [];
  if (role !== 'manager') {
    try {
      const pr = await env.DB.prepare('SELECT permissions FROM admins WHERE username = ?').bind(row.username).first<{ permissions?: string | null }>();
      if (pr && typeof pr.permissions === 'string' && pr.permissions.length) {
        perms = pr.permissions.split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        perms = []; // column present but empty -> no extra sections until granted
      }
    } catch {
      // permissions column not migrated yet -> keep the pre-feature behaviour so
      // nothing breaks in the deploy gap (staff keep their current access).
      perms = GRANTABLE_PERMS.slice();
    }
  }
  return { username: row.username, role, perms };
}

async function requirePlayer(request: Request, env: Env): Promise<PlayerRow | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const claim = await verifyToken(env, token, 'player');
  if (!claim) return null;
  const row = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(Number(claim.sub)).first<PlayerRow>();
  if (!row) return null;
  if ((row.session_version || 1) !== claim.ver) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const row of results || []) out[row.key] = row.value;
  return out;
}
async function saveSettings(env: Env, updates: Record<string, string>): Promise<void> {
  const stmts = Object.entries(updates).map(([key, value]) =>
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value)),
  );
  if (stmts.length) await env.DB.batch(stmts);
}
function publicSettings(s: Record<string, string>) {
  return {
    checkin_min_deposit: Number(s.checkin_min_deposit || String(CHECKIN_MIN_DEPOSIT_DEFAULT)),
    checkin_rewards: CHECKIN_REWARDS,
    tasks_enabled: s.tasks_enabled === '1',
    announcement_text: s.announcement_text || '',
    contact_url: s.contact_url || '',
    // Dollars a player deposits to earn 1 point (shown on the Play page).
    deposit_point_rate: Math.max(0, Math.floor(Number(s.deposit_point_rate ?? '10'))),
    deposit_paynow: s.deposit_paynow || '',
    deposit_name: s.deposit_name || '',
    deposit_qr: s.deposit_qr || '',
    deposit_bank_name: s.deposit_bank_name || '',
    deposit_bank_account: s.deposit_bank_account || '',
    deposit_bank_holder: s.deposit_bank_holder || '',
    // Bumped whenever staff change the deposit account; the app shows a red dot
    // on the Deposit button until the player opens it.
    deposit_updated_at: s.deposit_updated_at || '',
  };
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

async function logActivity(env: Env, playerId: number, type: string, amount: number, pointsAfter: number, note: string | null, adminUsername: string | null = null): Promise<void> {
  await env.DB.prepare('INSERT INTO point_activity (player_id, type, amount, points_after, note, admin_username) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(playerId, type, amount, pointsAfter, note, adminUsername).run();
}

// Positive/system awards only. Arcade spends use the guarded path below.
async function awardPoints(env: Env, playerId: number, type: string, amount: number, note: string | null, adminUsername: string | null = null): Promise<number> {
  // Atomic: the balance change and its audit row commit together (or not at
  // all). The log's points_after is read via a sub-select on the SAME row in
  // the SAME transaction, so it always matches the post-update balance and can
  // never be left orphaned by a crash between the two writes.
  await env.DB.batch([
    env.DB.prepare("UPDATE players SET points = points + ?, updated_at = datetime('now') WHERE id = ?").bind(amount, playerId),
    env.DB.prepare('INSERT INTO point_activity (player_id, type, amount, points_after, note, admin_username) VALUES (?, ?, ?, (SELECT points FROM players WHERE id = ?), ?, ?)')
      .bind(playerId, type, amount, playerId, note, adminUsername),
  ]);
  const row = await env.DB.prepare('SELECT points FROM players WHERE id = ?').bind(playerId).first<{ points: number }>();
  return row?.points ?? 0;
}

// Atomic reward-credit award + audit row (mirrors awardPoints for cents). Both
// writes commit together so a crash can never change the balance without a log.
async function awardCredits(env: Env, playerId: number, cents: number, reason: string, adminUsername: string | null = null): Promise<number> {
  await env.DB.batch([
    env.DB.prepare("UPDATE players SET reward_cents = reward_cents + ?, updated_at = datetime('now') WHERE id = ?").bind(cents, playerId),
    env.DB.prepare('INSERT INTO credit_activity (player_id, amount_cents, reward_after_cents, reason, admin_username) VALUES (?, ?, (SELECT reward_cents FROM players WHERE id = ?), ?, ?)')
      .bind(playerId, cents, playerId, reason, adminUsername),
  ]);
  const row = await env.DB.prepare('SELECT reward_cents FROM players WHERE id = ?').bind(playerId).first<{ reward_cents: number }>();
  return row?.reward_cents ?? 0;
}

// Reward statements (balance change + audit row) for folding INTO a claim batch,
// so the claim and the reward commit as one all-or-nothing transaction.
function pointRewardStmts(env: Env, playerId: number, type: string, amount: number, note: string): any[] {
  return [
    env.DB.prepare("UPDATE players SET points = points + ?, updated_at = datetime('now') WHERE id = ?").bind(amount, playerId),
    env.DB.prepare('INSERT INTO point_activity (player_id, type, amount, points_after, note) VALUES (?, ?, ?, (SELECT points FROM players WHERE id = ?), ?)')
      .bind(playerId, type, amount, playerId, note),
  ];
}
function creditRewardStmts(env: Env, playerId: number, cents: number, reason: string): any[] {
  return [
    env.DB.prepare("UPDATE players SET reward_cents = reward_cents + ?, updated_at = datetime('now') WHERE id = ?").bind(cents, playerId),
    env.DB.prepare('INSERT INTO credit_activity (player_id, amount_cents, reward_after_cents, reason) VALUES (?, ?, (SELECT reward_cents FROM players WHERE id = ?), ?)')
      .bind(playerId, cents, playerId, reason),
  ];
}

// Deposit totals (whole SGD) over each supported window for a player.
const BONUS_PERIODS = ['lifetime', 'month', 'week', 'today'] as const;
type BonusPeriod = typeof BONUS_PERIODS[number];
async function lifetimeDeposit(env: Env, playerId: number): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM deposits WHERE player_id = ?').bind(playerId).first<{ s: number }>();
  return r?.s ?? 0;
}
function weekRangeSgt(): { start: string; end: string } {
  const monday = weekKeySGT();
  const sunday = new Date(new Date(monday + 'T00:00:00Z').getTime() + 6 * 86400000).toISOString().slice(0, 10);
  return { start: sgtDayStartUtc(monday), end: sgtDayEndUtc(sunday) };
}
// The claim-window key for a period (what makes a month/week/day bonus reset).
function periodKey(period: BonusPeriod): string {
  if (period === 'month') return monthKeySGT();
  if (period === 'week') return weekKeySGT();
  if (period === 'today') return sgtDateKey();
  return 'lifetime';
}
async function depositTotalForPeriod(env: Env, playerId: number, period: BonusPeriod): Promise<number> {
  if (period === 'lifetime') return lifetimeDeposit(env, playerId);
  if (period === 'month') {
    const r = await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM deposits WHERE player_id = ? AND month_key = ?').bind(playerId, monthKeySGT()).first<{ s: number }>();
    return r?.s ?? 0;
  }
  let start: string, end: string;
  if (period === 'week') { const w = weekRangeSgt(); start = w.start; end = w.end; }
  else { const d = sgtDateKey(); start = sgtDayStartUtc(d); end = sgtDayEndUtc(d); }
  const r = await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM deposits WHERE player_id = ? AND created_at >= ? AND created_at <= ?').bind(playerId, start, end).first<{ s: number }>();
  return r?.s ?? 0;
}

// Deposit-bonus tiers + this player's reached/claimed state (per each tier's window). Defensive.
async function depositBonusStatus(env: Env, playerId: number): Promise<{ tiers: any[] }> {
  let tiers: any[] = [];
  try {
    const r = await env.DB.prepare('SELECT id, title, min_deposit, period, reward_type, amount, start_date, end_date, image_url FROM deposit_bonus_tiers WHERE active = 1 ORDER BY min_deposit ASC, id ASC').all();
    tiers = r.results || [];
  } catch {
    try {
      const r = await env.DB.prepare('SELECT id, title, min_deposit, period, reward_type, amount FROM deposit_bonus_tiers WHERE active = 1 ORDER BY min_deposit ASC, id ASC').all();
      tiers = r.results || [];
    } catch { return { tiers: [] }; }
  }
  // Date frame: hide any tier whose calendar window hasn't started or has ended.
  const dbToday = sgtDateKey();
  tiers = tiers.filter((t) => !((t.start_date && dbToday < t.start_date) || (t.end_date && dbToday > t.end_date)));
  // Compute the four window totals once and reuse.
  const [life, month, week, tday] = await Promise.all(BONUS_PERIODS.map((p) => depositTotalForPeriod(env, playerId, p)));
  const totals: Record<string, number> = { lifetime: life, month, week, today: tday };
  const claimedSet = new Set<string>();
  try {
    const c = await env.DB.prepare('SELECT tier_id, period_key FROM deposit_bonus_claims WHERE player_id = ?').bind(playerId).all<{ tier_id: number; period_key: string }>();
    (c.results || []).forEach((x) => claimedSet.add(x.tier_id + '|' + x.period_key));
  } catch { /* claims table not migrated */ }
  return {
    tiers: tiers.map((t) => {
      const period = (BONUS_PERIODS as readonly string[]).includes(t.period) ? t.period as BonusPeriod : 'lifetime';
      const periodTotal = totals[period] ?? 0;
      const key = periodKey(period);
      return {
        id: t.id, title: t.title || '', min_deposit: t.min_deposit, period, reward_type: t.reward_type, amount: t.amount,
        image_url: t.image_url || null,
        period_total: periodTotal, reached: periodTotal >= t.min_deposit, claimed: claimedSet.has(t.id + '|' + key),
      };
    // A lifetime bonus is a once-ever reward: once the player has claimed it,
    // drop it from their list entirely so it never shows again.
    }).filter((t) => !(t.period === 'lifetime' && t.claimed)),
  };
}

function publicPlayer(p: PlayerRow) {
  return {
    id: p.id,
    username: p.username,
    display_name: p.display_name,
    points: p.points,
    reward_cents: p.reward_cents ?? 0,
    reward: centsToStr(p.reward_cents ?? 0),
    status: p.status,
  };
}

async function listPlayerTasks(env: Env, playerId: number, settings: Record<string, string>) {
  if (settings.tasks_enabled !== '1') return [];
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.description, t.points, t.url,
            CASE WHEN tc.id IS NULL THEN 0 ELSE 1 END AS completed
     FROM tasks t
     LEFT JOIN task_completions tc ON tc.task_id = t.id AND tc.player_id = ?
     WHERE t.active = 1
     ORDER BY t.id DESC`,
  ).bind(playerId).all();
  return results || [];
}

// Total deposits (SGD) recorded for a player on a given Singapore calendar day.
// Deposits store created_at in UTC, so the day is bounded by the SGT-day UTC
// window. Staff key the customer's daily total once, so a sum is the natural gate.
async function depositTotalForSgtDay(env: Env, playerId: number, day: string): Promise<number> {
  const r = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM deposits WHERE player_id = ? AND created_at >= ? AND created_at <= ?',
  ).bind(playerId, sgtDayStartUtc(day), sgtDayEndUtc(day)).first<{ s: number }>();
  return r?.s ?? 0;
}

// Deposit-gated 7-day check-in status for a player (Singapore day).
//  - streak advances only while the player checked in on consecutive SGT days
//  - a day is claimable only when that day has a qualifying deposit (>= min)
interface CheckinStatus {
  rewards: number[]; min_deposit: number;
  checked_in_today: boolean; deposit_ok: boolean;
  streak: number; standing_streak: number; current_day: number; current_points: number; can_check_in: boolean;
}
async function checkinStatus(env: Env, playerId: number, settings: Record<string, string>): Promise<CheckinStatus> {
  const today = sgtDateKey();
  const min = Math.max(0, Number(settings.checkin_min_deposit || String(CHECKIN_MIN_DEPOSIT_DEFAULT)));
  const [todayRow, prevRow, depositTotal] = await Promise.all([
    env.DB.prepare('SELECT streak FROM daily_checkins WHERE player_id = ? AND checkin_date = ?').bind(playerId, today).first<{ streak: number }>(),
    env.DB.prepare('SELECT streak FROM daily_checkins WHERE player_id = ? AND checkin_date = ?').bind(playerId, sgtYesterdayKey()).first<{ streak: number }>(),
    depositTotalForSgtDay(env, playerId, today),
  ]);
  const checkedInToday = !!todayRow;
  const streak = checkedInToday ? todayRow!.streak : ((prevRow?.streak ?? 0) + 1);
  const currentDay = Math.min(streak, CHECKIN_REWARDS.length);
  return {
    rewards: CHECKIN_REWARDS, min_deposit: min,
    checked_in_today: checkedInToday,
    deposit_ok: depositTotal >= min,
    streak,
    standing_streak: checkedInToday ? streak : (prevRow?.streak ?? 0),
    current_day: currentDay, current_points: checkinPointsForStreak(streak),
    can_check_in: !checkedInToday && depositTotal >= min,
  };
}

// ---------------------------------------------------------------------------
// VIP helpers
// ---------------------------------------------------------------------------

interface VipStatus { month_key: string; week_key: string; deposit_total: number; rank_idx: number }
async function getVipStatus(env: Env, playerId: number): Promise<VipStatus> {
  const monthKey = monthKeySGT();
  const row = await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM deposits WHERE player_id = ? AND month_key = ?')
    .bind(playerId, monthKey).first<{ s: number }>();
  const total = row?.s ?? 0;
  let rankIdx = -1;
  for (let i = 0; i < VIP_RANKS.length; i++) if (total >= VIP_RANKS[i].deposit) rankIdx = i;
  return { month_key: monthKey, week_key: weekKeySGT(), deposit_total: total, rank_idx: rankIdx };
}
// Record a verified deposit for a player: deposit row, deposit bonus points,
// VIP upgrade bonuses and the auto messages. Used by Admin -> Players (manual
// entry) and by approving a player's deposit request from the app.
type RecordDepositResult = { ok: true; deposit_total: number; rank_name: string | null; upgrade_points_granted: number; deposit_points_granted: number } | { ok: false; code: string; msg: string; status: number };
async function recordDeposit(env: Env, id: number, amount: number, note: string, reference: string, admin: string): Promise<RecordDepositResult> {
  if (!id || !Number.isFinite(amount) || amount <= 0) return { ok: false, code: 'BAD_REQUEST', msg: 'A player id and a positive deposit amount are required.', status: 400 };
  if (amount > 100000000) return { ok: false, code: 'AMOUNT_RANGE', msg: 'Deposit amount is too large.', status: 400 };
  const exists = await env.DB.prepare('SELECT id FROM players WHERE id = ?').bind(id).first();
  if (!exists) return { ok: false, code: 'PLAYER_NOT_FOUND', msg: 'Player not found.', status: 404 };
  const monthKey = monthKeySGT();
  // Rank BEFORE this deposit, so we can detect a rank-up afterwards.
  const rankBefore = (await getVipStatus(env, id)).rank_idx;
  // Duplicate-reference guard: if staff paste the bank/receipt reference, the
  // same deposit can't be recorded twice (also enforced by a unique index).
  if (reference) {
    try {
      const dup = await env.DB.prepare('SELECT id FROM deposits WHERE reference = ?').bind(reference).first();
      if (dup) return { ok: false, code: 'DUP_REFERENCE', msg: 'A deposit with this reference was already recorded.', status: 409 };
    } catch { /* reference column not migrated yet */ }
  }
  try {
    await env.DB.prepare('INSERT INTO deposits (player_id, amount, month_key, note, admin_username, reference) VALUES (?, ?, ?, ?, ?, ?)').bind(id, amount, monthKey, note || null, admin, reference || null).run();
  } catch (e) {
    const msg = String((e as any)?.message || e);
    if (/UNIQUE/i.test(msg)) return { ok: false, code: 'DUP_REFERENCE', msg: 'A deposit with this reference was already recorded.', status: 409 };
    // Pre-migration fallback: record without the reference column.
    await env.DB.prepare('INSERT INTO deposits (player_id, amount, month_key, note, admin_username) VALUES (?, ?, ?, ?, ?)').bind(id, amount, monthKey, note || null, admin).run();
  }
  // Deposit bonus points: $rate deposited = 1 point (Settings, default $10;
  // 0 disables). Logged like every other point movement, with the staff name.
  const depSettings = await getSettings(env);
  const rate = Math.max(0, Math.floor(Number(depSettings.deposit_point_rate ?? '10')));
  let depositPoints = 0;
  if (rate > 0) {
    depositPoints = Math.floor(amount / rate);
    if (depositPoints > 0) await awardPoints(env, id, POINT_TYPES.DEPOSIT_BONUS, depositPoints, `Deposit bonus: $${amount}`, admin);
  }
  const vip = await getVipStatus(env, id);
  const granted = await grantUpgradeBonuses(env, id, vip);
  // Auto-messages (best-effort): first deposit vs later, and a rank-up note.
  try {
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM deposits WHERE player_id = ?').bind(id).first<{ c: number }>();
    const isFirst = (cnt?.c ?? 0) <= 1;
    const dvars = { deposit_amount: String(amount), points_added: String(depositPoints) };
    await sendAutoMessage(env, id, isFirst ? 'first_deposit' : 'deposit_received', dvars);
    if (vip.rank_idx > rankBefore) await sendAutoMessage(env, id, 'vip_rank_up', {});
  } catch { /* best-effort */ }
  return { ok: true, deposit_total: vip.deposit_total, rank_name: vip.rank_idx >= 0 ? VIP_RANKS[vip.rank_idx].name : null, upgrade_points_granted: granted, deposit_points_granted: depositPoints };
}

// Deposit requests from the app: the player transfers money outside the app,
// then submits the amount + a receipt photo here. Staff verify and approve
// (which records the deposit above) or reject. Created lazily.
async function ensureDepositSubmissionsTable(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS deposit_submissions (
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
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_depsub_status ON deposit_submissions(status, id)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_depsub_player ON deposit_submissions(player_id, id)').run();
}

// Past monthly ranks, derived live from the player's own deposit records (no
// snapshots needed - every deposit is already tagged with its month). The
// current month is excluded (it is shown live above) and months that never
// reached a rank are skipped, so this reads as a trophy shelf, not a ledger.
interface RankHistoryEntry { month_key: string; rank_idx: number; rank_name: string }
async function vipRankHistory(env: Env, playerId: number, currentMonthKey: string): Promise<RankHistoryEntry[]> {
  const { results } = await env.DB.prepare(
    'SELECT month_key, COALESCE(SUM(amount), 0) AS s FROM deposits WHERE player_id = ? GROUP BY month_key ORDER BY month_key DESC',
  ).bind(playerId).all<{ month_key: string; s: number }>();
  const out: RankHistoryEntry[] = [];
  for (const r of (results || [])) {
    if (r.month_key === currentMonthKey) continue;
    let idx = -1;
    for (let i = 0; i < VIP_RANKS.length; i++) if (r.s >= VIP_RANKS[i].deposit) idx = i;
    if (idx < 0) continue;
    out.push({ month_key: r.month_key, rank_idx: idx, rank_name: VIP_RANKS[idx].name });
  }
  return out;
}
async function grantUpgradeBonuses(env: Env, playerId: number, vip: VipStatus): Promise<number> {
  let granted = 0;
  const ranks = await getRanks(env);
  for (let i = 0; i <= vip.rank_idx; i++) {
    const rank = ranks[i];
    // Grant marker + points in ONE transaction, same as check-in. The UNIQUE
    // index makes a repeat fail the whole batch, so a tier can never be
    // recorded as granted without the points landing.
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO vip_upgrade_grants (player_id, month_key, rank_idx, points_added) VALUES (?, ?, ?, ?)')
          .bind(playerId, vip.month_key, i, rank.upgrade),
        ...pointRewardStmts(env, playerId, POINT_TYPES.VIP_UPGRADE, rank.upgrade, `Tier Upgrade Bonus: ${rank.name}`),
      ]);
      granted += rank.upgrade;
    } catch (e) {
      // Already granted this month -> nothing to do. Anything else is logged
      // and skipped so one bad tier can't block the others.
      if (!/UNIQUE/i.test(String((e as any)?.message || e))) {
        console.error(JSON.stringify({ msg: 'vip_upgrade_failed', player: playerId, rank: i, err: String((e as any)?.message || e) }));
      }
    }
  }
  return granted;
}

// ---------------------------------------------------------------------------
// Chat message templates
// Manager writes rich (HTML) templates with {variables}; staff click to send.
// Variable VALUES are HTML-escaped so a player's own text can never inject
// markup; the template HTML itself is sanitized on the client before rendering.
// ---------------------------------------------------------------------------
function escVal(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function renderChatTemplate(env: Env, content: string, player: PlayerRow, extra: Record<string, string> = {}): Promise<string> {
  const settings = await getSettings(env);
  const gids = await loadGameIds(env, player.id);
  const fids = await loadFreeIds(env, player.id);
  const gm: Record<string, string> = {}; for (const g of gids as any[]) gm[g.platform] = g.game_id;
  const fm: Record<string, string> = {}; for (const g of fids as any[]) fm[g.platform] = g.game_id;
  const vip = await getVipStatus(env, player.id);
  const ranks = await getRanks(env);
  const rank = vip.rank_idx >= 0 ? ranks[vip.rank_idx].name : '';
  let fcId = '', fcGame = '', fcAmt = '', hit = '', wmax = '';
  try {
    const fc = await getOpenFreeCredit(env, player.id);
    if (fc) {
      fcId = fc.game_id; fcGame = fc.game; fcAmt = centsToStr(fc.amount_cents);
      let capC = fc.fc_cap_cents, hitC = fc.fc_hit_cents;
      if (capC == null || capC <= 0) { const t = freeCreditTerms(await freeCreditRule(env, fc.amount_cents), fc.amount_cents); hitC = t.hit_cents; capC = t.cap_cents; }
      hit = centsToStr(hitC ?? 0); wmax = centsToStr(capC ?? 0);
    }
  } catch { /* ignore */ }
  let streak = 0;
  try { streak = (await checkinStatus(env, player.id, settings)).standing_streak; } catch { /* ignore */ }
  const rate = Math.max(0, Math.floor(Number(settings.deposit_point_rate ?? '10')));
  const p = player as any;
  const vars: Record<string, string> = {
    name: p.display_name || p.username,
    player_id: p.username,
    points: String(p.points ?? 0),
    credits: centsToStr(p.reward_cents ?? 0),
    tag: p.tag || '',
    streak: String(streak),
    rank,
    deposit_total: String(vip.deposit_total ?? 0),
    telegram: p.telegram || '',
    whatsapp: p.whatsapp || '',
    game_id: (gids[0] as any)?.game_id || '',
    pussy888_id: gm['pussy888'] || '', mega888_id: gm['mega888'] || '',
    '918kiss_id': gm['918kiss'] || '', '918kaya_id': gm['918kaya'] || '',
    live22_id: gm['live22'] || '', ace333_id: gm['ace333'] || '', evo888_id: gm['evo888'] || '',
    free_credit_id: fcId, free_credit_game: fcGame, free_credit_amount: fcAmt, hit, withdraw_max: wmax,
    pussy888_free_id: fm['pussy888'] || '', mega888_free_id: fm['mega888'] || '',
    deposit_paynow: settings.deposit_paynow || '', deposit_name: settings.deposit_name || '',
    deposit_rate: String(rate),
    date: sgtDateKey(),
    password: '', // only filled by the Welcome message's extra; empty elsewhere
    rank_icon: vip.rank_idx >= 0 ? ('/img/' + (VIP_RANK_KEYS[vip.rank_idx] || '') + '.webp') : '', // current rank badge
  };
  // Event-specific variables (e.g. {amount} on a withdrawal message) override.
  for (const k in extra) vars[k] = extra[k];
  return String(content || '').replace(/\{([a-z0-9_]+)\}/gi, (m, k) => (k in vars ? escVal(vars[k]) : m));
}

// The 3 automatic messages. Their wording is editable in the Templates tab
// (they seed themselves on first load); this is the safe built-in fallback.
const AUTO_TEMPLATES: Record<string, { name: string; content: string }> = {
  free_credit_approved: {
    name: 'Auto · Free credit approved',
    content: '🎉 Your free credit has been approved! ✅<br>Please open the "History" page to check your Free Credit ID and Withdrawal Rules. 💰<br><br>🎉 你的免费信用已批准！✅<br>请到「历史 History」页面查看你的免费信用 ID 和提款规则。💰',
  },
  withdrawal_approved: {
    name: 'Auto · Withdrawal approved',
    content: '🎉 Congratulations! Your withdrawal of SGD {amount} has been approved. ✅<br><br>Thank you for choosing LE888 🐻 — we hope you play here with us again! 🎰<br><br>🎉 恭喜！您 SGD {amount} 的提款申请已批准。✅<br><br>感谢您选择 LE888 🐻，期待您再次光临游玩！🎰',
  },
  game_id_changed: {
    name: 'Auto · Game ID changed',
    content: 'Your free credit account has been changed to {new_game} · {new_game_id}. Please play on that account.<br><br>你的免费额度账号已更改为 {new_game} · {new_game_id}，请在该账号游玩。',
  },
  welcome: {
    name: 'Auto · Welcome (new player)',
    content: '👋 Welcome to LE888, {name}! 🐻<br>Your Player ID is <b>{player_id}</b>. Deposit and play to earn points and rewards. Good luck! 🎰<br><br>👋 欢迎加入 LE888，{name}！🐻<br>你的玩家编号是 <b>{player_id}</b>。充值并游玩即可赚取积分和奖励。祝你好运！🎰',
  },
  first_deposit: {
    name: 'Auto · First deposit',
    content: '🎉 Thank you for your first deposit of SGD {deposit_amount}, {name}! We\'ve added <b>{points_added}</b> points to your account. Enjoy the games! 🎰<br><br>🎉 感谢你的首次充值 SGD {deposit_amount}，{name}！我们已为你的账户添加 <b>{points_added}</b> 积分。祝你游玩愉快！🎰',
  },
  deposit_received: {
    name: 'Auto · Deposit received',
    content: '✅ Deposit received: SGD {deposit_amount}. <b>{points_added}</b> points have been added to your account. Have fun! 🎮<br><br>✅ 已收到充值：SGD {deposit_amount}。已为你的账户添加 <b>{points_added}</b> 积分。祝你玩得开心！🎮',
  },
  deposit_rejected: {
    name: 'Auto · Deposit request rejected',
    content: '⚠️ We could not verify your deposit request of SGD {deposit_amount}. Reason: {reason}<br>Please check your receipt and submit again, or contact support in this chat.<br><br>⚠️ 我们无法核实你 SGD {deposit_amount} 的充值申请。原因：{reason}<br>请检查收据后重新提交，或在此聊天联系客服。',
  },
  withdrawal_rejected: {
    name: 'Auto · Withdrawal rejected',
    content: 'Your withdrawal request of SGD {amount} could not be approved this time. Please contact support if you have any questions. 🙏<br><br>你的 SGD {amount} 提款申请此次未能通过。如有疑问请联系客服。🙏',
  },
  reward_rejected: {
    name: 'Auto · Reward rejected',
    content: 'Your reward request of SGD {amount} was not approved and has been returned to your reward balance. Please contact support if you need help. 🙏<br><br>你的 SGD {amount} 奖励申请未通过，金额已退回你的奖励余额。如需协助请联系客服。🙏',
  },
  vip_rank_up: {
    name: 'Auto · VIP rank up',
    content: '🏆 Congratulations {name}! You\'ve reached <b>{rank}</b> VIP! Enjoy your new rewards. 🎉<br><br>🏆 恭喜你，{name}！你已达到 <b>{rank}</b> 会员等级！尽情享受新的奖励吧。🎉',
  },
  big_win: {
    name: 'Auto · Big win',
    content: '🎰 Wow {name}, you just won <b>SGD {win_amount}</b> on {game}! 🎉 Keep it going! 🔥<br><br>🎰 哇，{name}，你刚在 {game} 赢得 <b>SGD {win_amount}</b>！🎉 继续保持！🔥',
  },
};

// Send one of the automatic messages, using the manager's edited wording if it
// exists (else the built-in default). Best-effort; a failure never blocks the
// action that triggered it.
async function sendAutoMessage(env: Env, playerId: number, triggerKey: string, extra: Record<string, string>, imageUrl?: string | null): Promise<void> {
  const player = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(playerId).first<PlayerRow>();
  if (!player) return;
  let content = AUTO_TEMPLATES[triggerKey]?.content || '';
  try {
    const row = await env.DB.prepare('SELECT content FROM chat_templates WHERE trigger_key = ? LIMIT 1').bind(triggerKey).first<{ content: string }>();
    if (row && row.content) content = row.content;
  } catch { /* templates not migrated -> built-in default */ }
  if (!content) return;
  const rendered = await renderChatTemplate(env, content, player, extra);
  const img = imageUrl || null;
  try {
    await env.DB.prepare('INSERT INTO chat_messages (player_id, sender, admin_username, body, image_url, is_html) VALUES (?, ?, ?, ?, ?, 1)').bind(playerId, 'admin', 'System', rendered, img).run();
  } catch {
    await env.DB.prepare('INSERT INTO chat_messages (player_id, sender, admin_username, body, image_url) VALUES (?, ?, ?, ?, ?)').bind(playerId, 'admin', 'System', rendered, img).run();
  }
  await env.DB.prepare("INSERT INTO chat_state (player_id, last_msg_at, admin_unread, player_unread) VALUES (?, datetime('now'), 0, 1) ON CONFLICT(player_id) DO UPDATE SET last_msg_at = datetime('now'), player_unread = player_unread + 1").bind(playerId).run();
}

// Create the 3 automatic templates once, so a manager can edit their wording.
async function ensureAutoTemplates(env: Env): Promise<void> {
  try {
    for (const key of Object.keys(AUTO_TEMPLATES)) {
      const t = AUTO_TEMPLATES[key];
      await env.DB.prepare('INSERT OR IGNORE INTO chat_templates (name, content, trigger_key) VALUES (?, ?, ?)').bind(t.name, t.content, key).run();
    }
  } catch { /* table/column not migrated yet */ }
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, rid: string): Promise<Response> {
  const path = new URL(request.url).pathname;

  // Chat images: GET streams from R2 (keys are unguessable random ids).
  if (path.startsWith('/api/chat/img/') && request.method === 'GET') {
    if (!env.CHAT_IMAGES) return fail('NOT_FOUND', 'Not found', 404, rid);
    const key = path.slice('/api/chat/img/'.length);
    if (!/^[a-z0-9-]{20,64}\.(webp|jpg|png)$/.test(key)) return fail('NOT_FOUND', 'Not found', 404, rid);
    const obj = await env.CHAT_IMAGES.get(key);
    if (!obj) return fail('NOT_FOUND', 'Not found', 404, rid);
    return new Response(obj.body, { headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
    } });
  }

  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'Method not allowed', 405, rid);

  // Chat image upload: raw image bytes (not JSON), player session required.
  if (path === '/api/chat/upload') {
    const player = await requirePlayer(request, env);
    if (!player) return fail('UNAUTHENTICATED', 'Please sign in.', 401, rid);
    if (player.status !== 'active') return fail('ACCOUNT_INACTIVE', 'This account is not active.', 403, rid);
    if (!env.CHAT_IMAGES) return fail('NOT_CONFIGURED', 'Image uploads are not set up yet.', 503, rid);
    if (!(await rateLimit(env, `chatimg:${player.id}`, 15, 3600))) return fail('RATE_LIMITED', 'Too many uploads. Please wait a while.', 429, rid);
    const ct = request.headers.get('content-type') || '';
    const ext = ct === 'image/webp' ? 'webp' : ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : null;
    if (!ext) return fail('BAD_TYPE', 'Only JPG, PNG or WebP images are allowed.', 400, rid);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 100) return fail('BAD_IMAGE', 'Image is empty.', 400, rid);
    if (bytes.byteLength > 2_500_000) return fail('TOO_LARGE', 'Image is too large (max 2.5 MB).', 400, rid);
    const key = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8) + '.' + ext;
    await env.CHAT_IMAGES.put(key, bytes, { httpMetadata: { contentType: ct } });
    return json({ ok: true, url: '/api/chat/img/' + key }, 200, rid);
  }

  // Admin: upload the PayNow QR image (raw bytes) -> R2 -> returns a URL.
  if (path === '/api/admin/deposit/qr-upload') {
    const auth = await requireAdmin(request, env);
    if (!auth) return fail('UNAUTHENTICATED', 'Unauthorized', 401, rid);
    if (!env.CHAT_IMAGES) return fail('NOT_CONFIGURED', 'Image storage (R2) is not set up yet.', 503, rid);
    const ct = request.headers.get('content-type') || '';
    const ext = ct === 'image/webp' ? 'webp' : ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : null;
    if (!ext) return fail('BAD_TYPE', 'Only JPG, PNG or WebP images are allowed.', 400, rid);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 100 || bytes.byteLength > 2_500_000) return fail('BAD_IMAGE', 'Image must be under 2.5 MB.', 400, rid);
    const key = 'qr-' + crypto.randomUUID().replace(/-/g, '') + '.' + ext;
    await env.CHAT_IMAGES.put(key, bytes, { httpMetadata: { contentType: ct } });
    return json({ ok: true, url: '/api/chat/img/' + key }, 200, rid);
  }

  // Admin: upload a promo banner image (raw bytes) -> R2 -> returns a URL.
  if (path === '/api/admin/promo/image-upload') {
    const auth = await requireAdmin(request, env);
    if (!auth) return fail('UNAUTHENTICATED', 'Unauthorized', 401, rid);
    if (!env.CHAT_IMAGES) return fail('NOT_CONFIGURED', 'Image storage (R2) is not set up yet.', 503, rid);
    const ct = request.headers.get('content-type') || '';
    const ext = ct === 'image/webp' ? 'webp' : ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : null;
    if (!ext) return fail('BAD_TYPE', 'Only JPG, PNG or WebP images are allowed.', 400, rid);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 100 || bytes.byteLength > 3_000_000) return fail('BAD_IMAGE', 'Image must be under 3 MB.', 400, rid);
    const key = 'promo-' + crypto.randomUUID().replace(/-/g, '') + '.' + ext;
    await env.CHAT_IMAGES.put(key, bytes, { httpMetadata: { contentType: ct } });
    return json({ ok: true, url: '/api/chat/img/' + key }, 200, rid);
  }

  // Admin: upload a withdrawal receipt image -> R2 -> returns a URL.
  if (path === '/api/admin/withdrawal/receipt-upload') {
    const auth = await requireAdmin(request, env);
    if (!auth) return fail('UNAUTHENTICATED', 'Unauthorized', 401, rid);
    if (!env.CHAT_IMAGES) return fail('NOT_CONFIGURED', 'Image storage (R2) is not set up yet.', 503, rid);
    const ct = request.headers.get('content-type') || '';
    const ext = ct === 'image/webp' ? 'webp' : ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : null;
    if (!ext) return fail('BAD_TYPE', 'Only JPG, PNG or WebP images are allowed.', 400, rid);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 100 || bytes.byteLength > 3_000_000) return fail('BAD_IMAGE', 'Image must be under 3 MB.', 400, rid);
    const key = 'wd-' + crypto.randomUUID().replace(/-/g, '') + '.' + ext;
    await env.CHAT_IMAGES.put(key, bytes, { httpMetadata: { contentType: ct } });
    return json({ ok: true, url: '/api/chat/img/' + key }, 200, rid);
  }

  // Admin: upload a chat image to send to a player -> R2 -> returns a URL.
  // Hex-only key so it passes the same chat image_url validation as players.
  if (path === '/api/admin/chat/upload') {
    const auth = await requireAdmin(request, env);
    if (!auth) return fail('UNAUTHENTICATED', 'Unauthorized', 401, rid);
    if (!env.CHAT_IMAGES) return fail('NOT_CONFIGURED', 'Image uploads are not set up yet.', 503, rid);
    const ct = request.headers.get('content-type') || '';
    const ext = ct === 'image/webp' ? 'webp' : ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : null;
    if (!ext) return fail('BAD_TYPE', 'Only JPG, PNG or WebP images are allowed.', 400, rid);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 100) return fail('BAD_IMAGE', 'Image is empty.', 400, rid);
    if (bytes.byteLength > 2_500_000) return fail('TOO_LARGE', 'Image is too large (max 2.5 MB).', 400, rid);
    const key = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8) + '.' + ext;
    await env.CHAT_IMAGES.put(key, bytes, { httpMetadata: { contentType: ct } });
    return json({ ok: true, url: '/api/chat/img/' + key }, 200, rid);
  }

  // Public config (no auth) — lets the login page reach the support link.
  if (path === '/api/config') {
    const s = await getSettings(env);
    const games = await publicGames(env);
    return json({
      ok: true,
      contact_url: s.contact_url || '',
      game_costs: games.game_costs,
      game_prizes: games.game_prizes,
      game_enabled: games.game_enabled,
    }, 200, rid);
  }

  // Public Game RTP data for the player page (active platforms + games only).
  if (path === '/api/rtp/list') {
    try {
      const pr = await env.DB.prepare('SELECT id, name, logo_url FROM rtp_platforms WHERE active=1 ORDER BY sort_order ASC, id ASC').all();
      const gr = await env.DB.prepare('SELECT platform_id, name, image_url, rtp FROM rtp_games WHERE active=1 ORDER BY platform_id ASC, sort_order ASC, id ASC').all();
      return json({ ok: true, platforms: pr.results || [], games: gr.results || [] }, 200, rid);
    } catch { return json({ ok: true, platforms: [], games: [] }, 200, rid); }
  }

  // ---- Slot Games (admin-managed launcher list) — display/link only ----
  if (path === '/api/slots/list') {
    try {
      const sr = await env.DB.prepare('SELECT id, name, logo_url, kind, play_url, android_package FROM slot_platforms WHERE active=1 ORDER BY sort_order ASC, id ASC').all();
      return json({ ok: true, platforms: sr.results || [] }, 200, rid);
    } catch { return json({ ok: true, platforms: [] }, 200, rid); }
  }

  // ---- Home banners (admin-managed carousel) — display/link only ----
  if (path === '/api/banners/list') {
    try {
      const br = await env.DB.prepare('SELECT id, image_url, link_url FROM banners WHERE active=1 ORDER BY sort_order ASC, id ASC').all();
      return json({ ok: true, banners: br.results || [] }, 200, rid);
    } catch { return json({ ok: true, banners: [] }, 200, rid); }
  }

  if (path.startsWith('/api/admin/')) return handleAdminApi(path, request, env, rid);
  return handlePlayerApi(path, request, env, rid);
}

// ---------------------------------------------------------------------------
// Player API
// ---------------------------------------------------------------------------

async function handlePlayerApi(path: string, request: Request, env: Env, rid: string): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return fail('BAD_REQUEST', 'Invalid request.', 400, rid);
  const ip = clientIp(request);

  // ---- Login (no session required) ----
  if (path === '/api/login') {
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    // Generic messages throughout - never reveal whether a username exists.
    if (!username || !password) return fail('INVALID_LOGIN', 'Invalid username or password.', 401, rid);
    const lockKey = `login:player:${username}`;
    if ((await isLockedOut(env, lockKey)) || !(await rateLimit(env, `login:ip:${ip}`, 30, 300))) {
      return fail('RATE_LIMITED', 'Too many attempts. Please try again later.', 429, rid);
    }
    const row = await env.DB.prepare('SELECT * FROM players WHERE username = ?').bind(username).first<PlayerRow>();
    if (!row || !(await verifyPassword(password, row.password))) {
      await recordAuthFail(env, lockKey, 8, 900); // 8 fails -> 15 min lock
      return fail('INVALID_LOGIN', 'Invalid username or password.', 401, rid);
    }
    if (row.status !== 'active') return fail('ACCOUNT_INACTIVE', 'This account is not active. Please contact support.', 403, rid);
    await clearAuthFail(env, lockKey);
    const token = await signToken(env, 'player', String(row.id), row.session_version || 1, PLAYER_SESSION_SECONDS);
    return json({ ok: true, token, player: publicPlayer(row), expires_in: PLAYER_SESSION_SECONDS }, 200, rid);
  }

  // ---- Everything below needs a valid player session ----
  const player = await requirePlayer(request, env);
  if (!player) return fail('UNAUTHENTICATED', 'Please sign in.', 401, rid);
  if (player.status !== 'active') return fail('ACCOUNT_INACTIVE', 'This account is not active. Please contact support.', 403, rid);

  const settings = await getSettings(env);
  const today = sgtDateKey();

  switch (path) {
    case '/api/push/key': {
      // Public VAPID key for PushManager.subscribe (not a secret).
      return json({ ok: true, key: env.VAPID_PUBLIC_KEY || '' }, 200, rid);
    }

    case '/api/push/subscribe': {
      const endpoint = String(body.endpoint || '');
      const p256dh = String(body.p256dh || '');
      const auth = String(body.auth || '');
      const lang = String(body.lang || 'en') === 'zh' ? 'zh' : 'en';
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1024 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) {
        return fail('BAD_REQUEST', 'Invalid subscription.', 400, rid);
      }
      await env.DB.prepare(
        'INSERT INTO push_subs (player_id, endpoint, p256dh, auth, lang) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(endpoint) DO UPDATE SET player_id = excluded.player_id, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang',
      ).bind(player.id, endpoint, p256dh, auth, lang).run();
      return json({ ok: true }, 200, rid);
    }

    case '/api/push/unsubscribe': {
      const endpoint = String(body.endpoint || '');
      if (endpoint) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND player_id = ?').bind(endpoint, player.id).run();
      return json({ ok: true }, 200, rid);
    }

    case '/api/promos': {
      // Active promos + this player's claim state for each. image_url and
      // sort_order are read defensively so the app still works whether or not
      // each column migration has run yet.
      let results: any[] | undefined;
      try {
        ({ results } = await env.DB.prepare('SELECT id, title, title_zh, tnc, tnc_zh, points, access, limit_type, limit_count, image_url, reward_type, app_only FROM promos WHERE active = 1 ORDER BY sort_order ASC, id DESC').all());
      } catch {
        try {
          ({ results } = await env.DB.prepare('SELECT id, title, title_zh, tnc, tnc_zh, points, access, limit_type, limit_count, image_url FROM promos WHERE active = 1 ORDER BY id DESC').all());
        } catch {
          ({ results } = await env.DB.prepare('SELECT id, title, title_zh, tnc, tnc_zh, points, access, limit_type, limit_count FROM promos WHERE active = 1 ORDER BY id DESC').all());
        }
      }
      const promos = (results || []) as any[];
      const out: any[] = [];
      for (const pr of promos) {
        const [avail, todayC, totalC] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS c FROM promo_unlocks WHERE player_id = ? AND promo_id = ? AND status = 'available'").bind(player.id, pr.id).first<{ c: number }>(),
          env.DB.prepare('SELECT COUNT(*) AS c FROM promo_claims WHERE player_id = ? AND promo_id = ? AND day_key = ?').bind(player.id, pr.id, today).first<{ c: number }>(),
          env.DB.prepare('SELECT COUNT(*) AS c FROM promo_claims WHERE player_id = ? AND promo_id = ?').bind(player.id, pr.id).first<{ c: number }>(),
        ]);
        out.push({
          id: pr.id, title: pr.title, title_zh: pr.title_zh, tnc: pr.tnc, tnc_zh: pr.tnc_zh,
          points: pr.points, access: pr.access, limit_type: pr.limit_type, limit_count: pr.limit_count,
          image_url: pr.image_url || null, reward_type: pr.reward_type || 'points',
          app_only: pr.app_only ? 1 : 0,
          available_unlocks: avail?.c ?? 0, claimed_today: todayC?.c ?? 0, claimed_total: totalC?.c ?? 0,
        });
      }
      return json({ ok: true, promos: out, deposit_bonus: await depositBonusStatus(env, player.id) }, 200, rid);
    }

    case '/api/promos/claim': {
      if (!(await rateLimit(env, `promo:${player.id}`, 20, 300))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      if (await hasCustomCreditLock(env, player.id)) return fail('CREDIT_LOCK', CREDIT_LOCK_MSG, 409, rid);
      const promoId = Number(body.promo_id);
      if (!promoId) return fail('BAD_REQUEST', 'promo_id is required.', 400, rid);
      const pr = await env.DB.prepare('SELECT * FROM promos WHERE id = ? AND active = 1').bind(promoId).first<any>();
      if (!pr) return fail('PROMO_NOT_FOUND', 'This promo is no longer available.', 404, rid);

      // App-only promos can only be claimed from the installed app. A browser
      // claim is refused here (never a balance change, just a gate).
      if (pr.app_only && !isAppRequest(request)) {
        return fail('APP_ONLY', 'Please open the LE888 app to claim this promo. Tap "Install" to get it.', 403, rid);
      }

      let unlockId: number | null = null;
      let claimRowId = 0;
      if (pr.access === 'gated') {
        // ONE claim per staff unlock: consume exactly one ticket. The guarded
        // UPDATE means two parallel claims can never share a ticket.
        const t = await env.DB.prepare(
          "UPDATE promo_unlocks SET status = 'claimed', claimed_at = datetime('now') WHERE id = (SELECT id FROM promo_unlocks WHERE player_id = ? AND promo_id = ? AND status = 'available' ORDER BY id LIMIT 1) AND status = 'available' RETURNING id",
        ).bind(player.id, promoId).first<{ id: number }>();
        if (!t) return fail('LOCKED', 'This promo is locked. Contact support to unlock it.', 403, rid);
        unlockId = t.id;
        const ci = await env.DB.prepare('INSERT INTO promo_claims (promo_id, player_id, points_added, day_key, unlock_id) VALUES (?, ?, ?, ?, ?)').bind(promoId, player.id, pr.points, today, unlockId).run();
        claimRowId = Number(ci?.meta?.last_row_id) || 0;
      } else {
        // Public promo: limit enforced in ONE conditional INSERT (atomic), so
        // parallel claims cannot exceed the per-day / lifetime cap.
        const cond = pr.limit_type === 'day'
          ? 'SELECT COUNT(*) FROM promo_claims WHERE player_id = ?2 AND promo_id = ?1 AND day_key = ?4'
          : 'SELECT COUNT(*) FROM promo_claims WHERE player_id = ?2 AND promo_id = ?1';
        const ins = await env.DB.prepare(
          `INSERT INTO promo_claims (promo_id, player_id, points_added, day_key) SELECT ?1, ?2, ?3, ?4 WHERE (${cond}) < ?5`,
        ).bind(promoId, player.id, pr.points, today, Math.max(1, pr.limit_count || 1)).run();
        if (!ins.meta.changes) {
          return fail('LIMIT_REACHED', pr.limit_type === 'day' ? 'You have already claimed this promo today.' : 'You have already claimed this promo the maximum number of times.', 409, rid);
        }
        claimRowId = Number(ins?.meta?.last_row_id) || 0;
      }
      // Award the reward. If it fails, roll the claim back (restore the ticket and
      // remove the claim row) so the player isn't left "claimed" with nothing.
      try {
        // pr.points is the amount: points, or cents when reward_type='credits'.
        if (pr.reward_type === 'credits') {
          const newCents = await awardCredits(env, player.id, pr.points, `Promo: ${pr.title}`);
          return json({ ok: true, reward_type: 'credits', amount: pr.points, reward_cents: newCents, reward: centsToStr(newCents) }, 200, rid);
        }
        const newTotal = await awardPoints(env, player.id, POINT_TYPES.PROMO, pr.points, `Promo: ${pr.title}`);
        return json({ ok: true, reward_type: 'points', points_added: pr.points, points: newTotal }, 200, rid);
      } catch (e) {
        const undo: any[] = [];
        if (claimRowId) undo.push(env.DB.prepare('DELETE FROM promo_claims WHERE id = ?').bind(claimRowId));
        if (unlockId) undo.push(env.DB.prepare("UPDATE promo_unlocks SET status = 'available', claimed_at = NULL WHERE id = ?").bind(unlockId));
        if (undo.length) { try { await env.DB.batch(undo); } catch { /* best effort */ } }
        return fail('CLAIM_FAILED', 'Could not claim right now. Please try again.', 500, rid);
      }
    }

    // ---- Claim a deposit-bonus tier (once per its window) ----
    case '/api/deposit-bonus/claim': {
      if (!(await rateLimit(env, `depbonus:${player.id}`, 20, 300))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      if (await hasCustomCreditLock(env, player.id)) return fail('CREDIT_LOCK', CREDIT_LOCK_MSG, 409, rid);
      const tierId = Number(body.tier_id);
      if (!tierId) return fail('BAD_REQUEST', 'tier_id is required.', 400, rid);
      let tier: any;
      try {
        tier = await env.DB.prepare('SELECT id, title, min_deposit, period, reward_type, amount, start_date, end_date FROM deposit_bonus_tiers WHERE id = ? AND active = 1').bind(tierId).first<any>();
      } catch {
        try { tier = await env.DB.prepare('SELECT id, title, min_deposit, period, reward_type, amount FROM deposit_bonus_tiers WHERE id = ? AND active = 1').bind(tierId).first<any>(); }
        catch { return fail('NEEDS_MIGRATION', 'This feature is being set up.', 503, rid); }
      }
      if (!tier) return fail('NOT_FOUND', 'This bonus is no longer available.', 404, rid);
      // Enforce the date frame: not before it starts, not after it ends.
      const bToday = sgtDateKey();
      if ((tier.start_date && bToday < tier.start_date) || (tier.end_date && bToday > tier.end_date)) {
        return fail('NOT_ACTIVE', 'This bonus is not available today.', 403, rid);
      }
      const period = (BONUS_PERIODS as readonly string[]).includes(tier.period) ? tier.period as BonusPeriod : 'lifetime';
      const total = await depositTotalForPeriod(env, player.id, period);
      if (total < tier.min_deposit) return fail('NOT_REACHED', 'You have not reached the deposit amount for this bonus yet.', 403, rid);
      const key = periodKey(period);
      const bonusNote = `Deposit bonus: ${tier.title || ('$' + tier.min_deposit)}`;
      // Claim + reward in ONE transaction. UNIQUE(player_id, tier_id, period_key)
      // is the anti-double-claim lock; a duplicate fails the whole batch, so the
      // reward is never given without a claim and never claimed without a reward.
      const reward = tier.reward_type === 'credits'
        ? creditRewardStmts(env, player.id, tier.amount, bonusNote)
        : pointRewardStmts(env, player.id, POINT_TYPES.PROMO, tier.amount, bonusNote);
      try {
        await env.DB.batch([
          env.DB.prepare('INSERT INTO deposit_bonus_claims (player_id, tier_id, period_key, reward_type, amount) VALUES (?, ?, ?, ?, ?)').bind(player.id, tierId, key, tier.reward_type, tier.amount),
          ...reward,
        ]);
      } catch (e) {
        if (/UNIQUE/i.test(String((e as any)?.message || e))) return fail('ALREADY_CLAIMED', 'You have already claimed this bonus.', 409, rid);
        return fail('CLAIM_FAILED', 'Could not claim right now. Please try again.', 500, rid);
      }
      if (tier.reward_type === 'credits') {
        const nc = await env.DB.prepare('SELECT reward_cents FROM players WHERE id = ?').bind(player.id).first<{ reward_cents: number }>();
        const newCents = nc?.reward_cents ?? 0;
        return json({ ok: true, reward_type: 'credits', amount: tier.amount, reward_cents: newCents, reward: centsToStr(newCents) }, 200, rid);
      }
      const np = await env.DB.prepare('SELECT points FROM players WHERE id = ?').bind(player.id).first<{ points: number }>();
      return json({ ok: true, reward_type: 'points', points_added: tier.amount, points: np?.points ?? 0 }, 200, rid);
    }

    // ---- Player sets bank details / birthday ONCE (then only staff can edit) ----
    case '/api/me/details/save': {
      const wantBank = ['bank_name', 'bank_account', 'bank_holder', 'paynow_number'].some((k) => body[k] !== undefined);
      const wantBday = body.birthday !== undefined;
      if (!wantBank && !wantBday) return fail('BAD_REQUEST', 'Nothing to save.', 400, rid);
      const cur = await env.DB.prepare('SELECT bank_locked, birthday_locked FROM players WHERE id = ?').bind(player.id).first<{ bank_locked: number; birthday_locked: number }>();
      const stmts: any[] = [];
      if (wantBank) {
        if (cur?.bank_locked) return fail('LOCKED', 'Your bank details are already saved. Contact support to change them.', 403, rid);
        const bn = String(body.bank_name || '').trim().slice(0, 60);
        const ba = String(body.bank_account || '').trim().slice(0, 40);
        const bh = String(body.bank_holder || '').trim().slice(0, 60);
        const pn = String(body.paynow_number || '').trim().slice(0, 30);
        if (!bn || !ba || !bh) return fail('BAD_REQUEST', 'Bank name, account number and account holder are all required.', 400, rid);
        // Guarded on bank_locked=0 so a double submit can't overwrite.
        stmts.push(env.DB.prepare("UPDATE players SET bank_name=?, bank_account=?, bank_holder=?, paynow_number=?, bank_locked=1, updated_at=datetime('now') WHERE id=? AND bank_locked=0").bind(bn, ba, bh, pn, player.id));
      }
      if (wantBday) {
        if (cur?.birthday_locked) return fail('LOCKED', 'Your birthday is already saved. Contact support to change it.', 403, rid);
        const bd = String(body.birthday || '').trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return fail('BAD_REQUEST', 'Please enter a valid birthday (YYYY-MM-DD).', 400, rid);
        stmts.push(env.DB.prepare("UPDATE players SET birthday=?, birthday_locked=1, updated_at=datetime('now') WHERE id=? AND birthday_locked=0").bind(bd, player.id));
      }
      try {
        await env.DB.batch(stmts);
      } catch {
        return fail('NEEDS_MIGRATION', 'This feature is being set up. Please try again later.', 503, rid);
      }
      const fresh = await env.DB.prepare('SELECT bank_name, bank_account, bank_holder, paynow_number, birthday, bank_locked, birthday_locked FROM players WHERE id = ?').bind(player.id).first();
      return json({ ok: true, details: playerDetails(fresh) }, 200, rid);
    }

    // ---- Withdrawal request (request-only: no in-app balance is deducted) ----
    case '/api/withdraw': {
      if (!(await rateLimit(env, `withdraw:${player.id}`, 8, 300))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      if (await hasCustomCreditLock(env, player.id)) return fail('CREDIT_LOCK', CREDIT_LOCK_MSG, 409, rid);
      // Must have bank details saved first.
      const bn = player.bank_name || '', ba = player.bank_account || '', bh = player.bank_holder || '';
      if (!bn || !ba || !bh) return fail('NEED_BANK', 'Please add your bank details in Settings first.', 400, rid);
      // Player must pick which account they're withdrawing from (required).
      const srcType = String(body.source_type || '');
      const srcGame = String(body.source_game || '').trim().slice(0, 60);
      const srcId = String(body.source_game_id || '').trim().slice(0, 60);
      if ((srcType !== 'free_credit' && srcType !== 'normal') || !srcId) {
        return fail('NEED_SOURCE', 'Please choose an ID to withdraw from.', 400, rid);
      }

      let cents = 0;
      let fcCents: number | null = null;
      let fcWinover: number | null = null;
      let fcCap: number | null = null;
      let fcPayoutId: number | null = null;

      if (srcType === 'free_credit') {
        // The amount is decided by the rules, NOT by the client. Anything the
        // app sends is ignored — a tampered request cannot inflate a payout.
        const fc = await getOpenFreeCredit(env, player.id);
        if (!fc) return fail('NO_FREE_CREDIT', 'You have no open free credit to withdraw from.', 400, rid);
        // The ID must be the one the free credit was actually sent to.
        if (String(fc.game_id) !== srcId) {
          return fail('SOURCE_MISMATCH', 'That is not your current Free Credit ID. Please reopen the page and try again.', 409, rid);
        }
        // Prefer the terms locked in at approval; fall back to current rules
        // only for credits issued before this feature existed.
        if (fc.fc_cap_cents != null && fc.fc_cap_cents > 0) {
          cents = fc.fc_cap_cents;
          fcWinover = fc.fc_winover_x ?? 0;
          fcCap = fc.fc_cap_cents;
        } else {
          const rule = await freeCreditRule(env, fc.amount_cents);
          const terms = freeCreditTerms(rule, fc.amount_cents);
          cents = terms.cap_cents;
          fcWinover = terms.winover;
          fcCap = terms.cap_cents;
        }
        fcCents = fc.amount_cents;
        fcPayoutId = fc.id;
        // Never let the SAME free credit be withdrawn twice. If a withdrawal for
        // this exact credit is already pending OR already approved, block it here
        // with a clear message. (If the column isn't migrated yet this is skipped,
        // and the "one pending at a time" + "used on approval" checks still apply.)
        try {
          const already = await env.DB.prepare(
            "SELECT 1 AS x FROM withdrawals WHERE source_payout_id = ? AND status IN ('pending','approved') LIMIT 1",
          ).bind(fcPayoutId).first();
          if (already) return fail('ALREADY_WITHDRAWN', 'This free credit has already been withdrawn. It cannot be withdrawn again.', 409, rid);
        } catch { /* source_payout_id column not migrated yet */ }
      } else {
        // Deposit ID withdrawals are unchanged: the player enters the amount.
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0) return fail('BAD_REQUEST', 'Enter a withdrawal amount.', 400, rid);
        cents = Math.round(amount * 100);
        if (cents <= 0 || cents > 100000000) return fail('AMOUNT_RANGE', 'Amount is out of range.', 400, rid);
      }
      // One withdrawal in flight at a time. This stops duplicate requests that a
      // staff member could accidentally pay twice. Enforced hard by a partial
      // unique index (see migration); this check gives a friendly message first.
      try {
        const pendingWd = await env.DB.prepare("SELECT 1 AS x FROM withdrawals WHERE player_id = ? AND status = 'pending' LIMIT 1").bind(player.id).first();
        if (pendingWd) return fail('WITHDRAW_PENDING', 'You already have a withdrawal pending. Please wait until it is processed.', 409, rid);
      } catch { /* ignore */ }
      const dupMsg = 'You already have a withdrawal pending. Please wait until it is processed.';
      try {
        await env.DB.prepare('INSERT INTO withdrawals (player_id, amount_cents, bank_name, bank_account, bank_holder, paynow_number, status, source_type, source_game, source_game_id, free_credit_cents, winover_x, rule_cap_cents, source_payout_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(player.id, cents, bn, ba, bh, player.paynow_number || null, 'pending', srcType, srcGame || null, srcId, fcCents, fcWinover, fcCap, fcPayoutId).run();
      } catch (e) {
        const msg = String((e as any)?.message || e);
        // A parallel submit slipped past the check and hit the unique index.
        if (/UNIQUE/i.test(msg)) return fail('WITHDRAW_PENDING', dupMsg, 409, rid);
        // Rule columns not migrated yet -> fall back to the previous shape.
        try {
          await env.DB.prepare('INSERT INTO withdrawals (player_id, amount_cents, bank_name, bank_account, bank_holder, paynow_number, status, source_type, source_game, source_game_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(player.id, cents, bn, ba, bh, player.paynow_number || null, 'pending', srcType, srcGame || null, srcId).run();
          return json({ ok: true, submitted: centsToStr(cents) }, 200, rid);
        } catch (e1) {
          if (/UNIQUE/i.test(String((e1 as any)?.message || e1))) return fail('WITHDRAW_PENDING', dupMsg, 409, rid);
        }
        // Otherwise assume the source columns aren't migrated yet — keep the request working.
        try {
          await env.DB.prepare('INSERT INTO withdrawals (player_id, amount_cents, bank_name, bank_account, bank_holder, paynow_number, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(player.id, cents, bn, ba, bh, player.paynow_number || null, 'pending').run();
        } catch (e2) {
          const msg2 = String((e2 as any)?.message || e2);
          if (/UNIQUE/i.test(msg2)) return fail('WITHDRAW_PENDING', dupMsg, 409, rid);
          return fail('NEEDS_MIGRATION', 'Withdrawals are being set up. Please try again later.', 503, rid);
        }
      }
      return json({
        ok: true,
        submitted: centsToStr(cents),
        winover: fcWinover,
        free_credit: fcCents == null ? null : centsToStr(fcCents),
      }, 200, rid);
    }

    case '/api/withdraw/list': {
      // Only the 10 most recent requests.
      try {
        const { results } = await env.DB.prepare('SELECT id, amount_cents, status, created_at, decided_at, note, source_type, source_game, source_game_id FROM withdrawals WHERE player_id = ? ORDER BY id DESC LIMIT 10').bind(player.id).all()
          .catch(() => env.DB.prepare('SELECT id, amount_cents, status, created_at, decided_at, note FROM withdrawals WHERE player_id = ? ORDER BY id DESC LIMIT 10').bind(player.id).all());
        const rows = ((results || []) as any[]).map((w) => ({
          id: w.id, amount: centsToStr(w.amount_cents), status: w.status,
          created_at: w.created_at, decided_at: w.decided_at, note: w.note || '',
          // Which account it came out of, so the player can tell them apart.
          source_type: w.source_type || null,
          source_game: w.source_game || null,
          source_game_id: w.source_game_id || null,
        }));
        return json({ ok: true, withdrawals: rows }, 200, rid);
      } catch { return json({ ok: true, withdrawals: [] }, 200, rid); }
    }

    case '/api/chat/list': {
      // Returns the last 50 messages (or only ones after after_id for cheap
      // polling) and marks staff replies as read for this player. Deleted
      // messages are excluded; recently-deleted ids are returned so an open app
      // can remove a message a staff member just un-sent.
      const afterId = Number(body.after_id) || 0;
      let messages: any[] = [];
      let deletedIds: number[] = [];
      try {
        if (afterId > 0) {
          const r = await env.DB.prepare('SELECT id, sender, body, image_url, is_html, created_at FROM chat_messages WHERE player_id = ? AND id > ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 100').bind(player.id, afterId).all();
          messages = r.results || [];
        } else {
          const r = await env.DB.prepare('SELECT id, sender, body, image_url, is_html, created_at FROM chat_messages WHERE player_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 50').bind(player.id).all();
          messages = (r.results || []).reverse();
        }
        const d = await env.DB.prepare("SELECT id FROM chat_messages WHERE player_id = ? AND deleted_at IS NOT NULL AND deleted_at > datetime('now','-1 day')").bind(player.id).all<{ id: number }>();
        deletedIds = (d.results || []).map((x) => x.id);
      } catch {
        // Pre-migration: no deleted_at column yet.
        if (afterId > 0) {
          const r = await env.DB.prepare('SELECT id, sender, body, image_url, created_at FROM chat_messages WHERE player_id = ? AND id > ? ORDER BY id ASC LIMIT 100').bind(player.id, afterId).all();
          messages = r.results || [];
        } else {
          const r = await env.DB.prepare('SELECT id, sender, body, image_url, created_at FROM chat_messages WHERE player_id = ? ORDER BY id DESC LIMIT 50').bind(player.id).all();
          messages = (r.results || []).reverse();
        }
      }
      await env.DB.prepare('UPDATE chat_state SET player_unread = 0 WHERE player_id = ?').bind(player.id).run();
      return json({ ok: true, messages, deleted_ids: deletedIds }, 200, rid);
    }

    case '/api/chat/send': {
      if (!(await rateLimit(env, `chat:${player.id}`, 30, 300))) return fail('RATE_LIMITED', 'Too many messages. Please slow down.', 429, rid);
      const text = String(body.body || '').trim().slice(0, 1000);
      const imageUrl = String(body.image_url || '').trim();
      if (imageUrl && !/^\/api\/chat\/img\/[a-z0-9]{20,64}\.(webp|jpg|png)$/.test(imageUrl)) return fail('BAD_REQUEST', 'Invalid image.', 400, rid);
      if (!text && !imageUrl) return fail('BAD_REQUEST', 'Message is empty.', 400, rid);
      const ins = await env.DB.prepare('INSERT INTO chat_messages (player_id, sender, body, image_url) VALUES (?, ?, ?, ?)').bind(player.id, 'player', text || null, imageUrl || null).run();
      await env.DB.prepare(
        'INSERT INTO chat_state (player_id, last_msg_at, admin_unread, player_unread) VALUES (?, datetime(\'now\'), 1, 0) ' +
        'ON CONFLICT(player_id) DO UPDATE SET last_msg_at = datetime(\'now\'), admin_unread = admin_unread + 1',
      ).bind(player.id).run();
      return json({ ok: true, id: ins.meta.last_row_id }, 200, rid);
    }

    case '/api/profile': {
      // Remember the player's chosen language so server-sent messages (e.g. the
      // withdrawal approval note) can match it. Defensive if column not migrated.
      const wantLang = String(body.lang || '') === 'zh' ? 'zh' : (String(body.lang || '') === 'en' ? 'en' : null);
      if (wantLang && wantLang !== ((player as any).lang || '')) {
        try { await env.DB.prepare('UPDATE players SET lang = ? WHERE id = ?').bind(wantLang, player.id).run(); } catch { /* lang column not migrated */ }
      }
      const [tasks, checkin] = await Promise.all([
        listPlayerTasks(env, player.id, settings),
        checkinStatus(env, player.id, settings),
      ]);

      const chatState = await env.DB.prepare('SELECT player_unread FROM chat_state WHERE player_id = ?').bind(player.id).first<{ player_unread: number }>();
      // Highest approved payout id — the player app watches this go up to chime
      // a "credit approved" sound.
      const approvedRow = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM payout_requests WHERE player_id = ? AND status = 'approved'").bind(player.id).first<{ m: number }>();
      // Highest payout id that staff have DECIDED (approved OR rejected). The app
      // compares this to the last id the player has seen to show a red dot on the
      // History tab until they open it.
      const decidedRow = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM payout_requests WHERE player_id = ? AND status IN ('approved','rejected')").bind(player.id).first<{ m: number }>();

      // Seconds left on the reward-submit cooldown (0 = can submit now). Lets the
      // app disable Submit and show a live countdown instead of a bare error.
      let submitCooldown = 0;
      try {
        const cd = await env.DB.prepare(
          "SELECT CAST(600 - (julianday('now') - julianday(MAX(created_at))) * 86400 AS INTEGER) AS s FROM payout_requests WHERE player_id = ? AND status NOT IN ('cancelled', 'rejected') AND created_at > datetime('now', '-600 seconds')",
        ).bind(player.id).first<{ s: number | null }>();
        submitCooldown = Math.max(0, Number(cd?.s ?? 0));
      } catch { /* ignore */ }

      // Latest "Free Credit" account handed to the player (from the most recent
      // approved reward payout) — offered as a withdrawal source.
      let latestFreeCredit: {
        game: string; game_id: string;
        amount_cents: number; amount: string;
        winover: number; hit: string; payout_cents: number; payout: string;
      } | null = null;
      try {
        const fc = await getOpenFreeCredit(env, player.id);
        if (fc) {
          // Terms were locked in when staff approved. Older credits fall back
          // to the current rules.
          let winover = fc.fc_winover_x, hitC = fc.fc_hit_cents, capC = fc.fc_cap_cents;
          if (capC == null || capC <= 0) {
            const t = freeCreditTerms(await freeCreditRule(env, fc.amount_cents), fc.amount_cents);
            winover = t.winover; hitC = t.hit_cents; capC = t.cap_cents;
          }
          latestFreeCredit = {
            game: fc.game,
            game_id: fc.game_id,
            amount_cents: fc.amount_cents,
            amount: centsToStr(fc.amount_cents),
            winover: winover ?? 0,
            hit: centsToStr(hitC ?? 0),
            payout_cents: capC,
            payout: centsToStr(capC),
          };
        }
      } catch { /* ignore */ }

      const games = await publicGames(env);

      // Rank travels with the profile so the player card paints the correct
      // badge on the FIRST render. It used to arrive later on /api/vip, which
      // made the badge flash "UNRANKED" for a moment on every load.
      // This is one indexed SUM over deposits — cheap enough for the 20s refresh.
      const vipNow = await getVipStatus(env, player.id);
      const rankNow = vipNow.rank_idx >= 0 ? VIP_RANKS[vipNow.rank_idx] : null;

      // VIP credit state: lock while pending; red notice only until submitted.
      const mcState = await getManualCredit(env, player.id);
      const mcLocked = !!mcState && (mcState.mc_status === 'pending_submission' || mcState.mc_status === 'pending_approval');
      const mcNotice = !!mcState && mcState.mc_status === 'pending_submission';

      return json({
        ok: true,
        player: publicPlayer(player),
        settings: publicSettings(settings),
        rank_idx: vipNow.rank_idx,
        rank_name: rankNow ? rankNow.name : null,
        game_costs: games.game_costs,
        game_prizes: games.game_prizes,
        game_enabled: games.game_enabled,
        today: { checked_in: checkin.checked_in_today },
        streak: checkin.standing_streak,
        checkin,
        chat_unread: chatState?.player_unread ?? 0,
        approved_payout_id: approvedRow?.m ?? 0,
        decided_payout_id: decidedRow?.m ?? 0,
        submit_cooldown: submitCooldown,
        // VIP credit: freeze everything but Submit while pending; show the red
        // notice only until the player presses Submit.
        credit_lock: mcLocked,
        credit_notice: mcNotice,
        manual_credit: mcState && mcState.mc_status ? { status: mcState.mc_status, amount: centsToStr(mcState.mc_amount_cents ?? 0) } : null,
        latest_free_credit: latestFreeCredit,
        game_ids: await loadGameIds(env, player.id),
        // Free credit accounts (max 2) — where reward credits get sent.
        free_ids: await loadFreeIds(env, player.id),
        free_platforms: FREE_PLATFORMS.map((k) => ({ key: k, label: GAME_PLATFORM_LABELS[k] })),
        game_platforms: GAME_PLATFORMS.map((k) => ({ key: k, label: GAME_PLATFORM_LABELS[k] })),
        details: playerDetails(player),
        tasks,
      }, 200, rid);
    }

    case '/api/checkin': {
      if (!(await rateLimit(env, `checkin:${player.id}`, 10, 60))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      if (await hasCustomCreditLock(env, player.id)) return fail('CREDIT_LOCK', CREDIT_LOCK_MSG, 409, rid);

      // Deposit gate: a check-in is only allowed on an SGT day where a
      // qualifying deposit (>= min) has been keyed in for this player.
      const min = Math.max(0, Number(settings.checkin_min_deposit || String(CHECKIN_MIN_DEPOSIT_DEFAULT)));
      const depositTotal = await depositTotalForSgtDay(env, player.id, today);
      if (depositTotal < min) {
        return fail('NEED_DEPOSIT', `Deposit at least SGD${min} today to check in.`, 403, rid);
      }

      // Streak advances only if the player checked in on the previous SGT day;
      // otherwise it restarts at day 1. Escalating reward per day (1..7, cycles).
      const prev = await env.DB.prepare('SELECT streak FROM daily_checkins WHERE player_id = ? AND checkin_date = ?').bind(player.id, sgtYesterdayKey()).first<{ streak: number }>();
      const streak = (prev?.streak ?? 0) + 1;
      const points = checkinPointsForStreak(streak);

      const day = Math.min(streak, CHECKIN_REWARDS.length);
      // Claim + points in ONE transaction. The UNIQUE(player_id, checkin_date)
      // makes a duplicate fail the whole batch, so a player can never be marked
      // "checked in" without receiving the points.
      try {
        await env.DB.batch([
          env.DB.prepare('INSERT INTO daily_checkins (player_id, checkin_date, points_added, streak) VALUES (?, ?, ?, ?)').bind(player.id, today, points, streak),
          ...pointRewardStmts(env, player.id, POINT_TYPES.CHECKIN, points, `Daily check-in (day ${day})`),
        ]);
      } catch (e) {
        if (/UNIQUE/i.test(String((e as any)?.message || e))) return fail('ALREADY_CHECKED_IN', 'Already checked in today. Come back tomorrow!', 409, rid);
        return fail('CHECKIN_FAILED', 'Could not check in right now. Please try again.', 500, rid);
      }
      const nt = await env.DB.prepare('SELECT points FROM players WHERE id = ?').bind(player.id).first<{ points: number }>();
      return json({ ok: true, points_added: points, points: nt?.points ?? (player.points + points), streak, day }, 200, rid);
    }

    case '/api/tasks': {
      const tasks = await listPlayerTasks(env, player.id, settings);
      return json({ ok: true, tasks }, 200, rid);
    }

    case '/api/task/complete': {
      if (settings.tasks_enabled !== '1') return fail('TASKS_DISABLED', 'Tasks are currently disabled.', 403, rid);
      const taskId = Number(body.task_id);
      if (!taskId) return fail('BAD_REQUEST', 'task_id is required.', 400, rid);

      const task = await env.DB.prepare('SELECT id, title, points FROM tasks WHERE id = ? AND active = 1').bind(taskId).first<{ id: number; title: string; points: number }>();
      if (!task) return fail('TASK_NOT_FOUND', 'Task not found or inactive.', 404, rid);

      // Claim + points in ONE transaction (UNIQUE(player_id, task_id) is the guard).
      try {
        await env.DB.batch([
          env.DB.prepare('INSERT INTO task_completions (player_id, task_id, points_added) VALUES (?, ?, ?)').bind(player.id, task.id, task.points),
          ...pointRewardStmts(env, player.id, POINT_TYPES.TASK_COMPLETE, task.points, `Task completed: ${task.title}`),
        ]);
      } catch (e) {
        if (/UNIQUE/i.test(String((e as any)?.message || e))) return fail('TASK_DONE', 'Task already completed.', 409, rid);
        return fail('TASK_FAILED', 'Could not complete the task right now. Please try again.', 500, rid);
      }
      const nt = await env.DB.prepare('SELECT points FROM players WHERE id = ?').bind(player.id).first<{ points: number }>();
      return json({ ok: true, points_added: task.points, points: nt?.points ?? (player.points + task.points) }, 200, rid);
    }

    // ---- Arcade play: idempotent + atomic guarded deduction ----
    case '/api/arcade/play': {
      if (await hasCustomCreditLock(env, player.id)) return fail('CREDIT_LOCK', CREDIT_LOCK_MSG, 409, rid);
      const game = String(body.game || '');
      if (game === 'cross') return fail('USE_CROSS_API', 'Lucky Crossing is played lane by lane.', 400, rid);
      // Settings now come from `game_configs` (cached 60s per isolate).
      const conf = await getGameConf(env, game);
      if (!conf) {
        // Either an unknown game, or its settings row is missing/invalid.
        // Fail closed: never guess a prize table.
        if (!(ALLOWED_GAMES as readonly string[]).includes(game)) {
          return fail('UNKNOWN_GAME', 'Unknown game.', 400, rid);
        }
        return fail('GAME_UNAVAILABLE', 'This game is being set up. Please try again shortly.', 503, rid);
      }
      if (!conf.enabled) return fail('GAME_DISABLED', 'This game is not available right now.', 403, rid);

      const playId = String(body.play_id || '');
      if (!isValidPlayId(playId)) return fail('BAD_PLAY_ID', 'Invalid play id.', 400, rid);

      if (!(await rateLimit(env, `play:${player.id}`, 40, 60))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);

      // (1) Reserve the play_id. Unique (player_id, play_id) makes this the
      //     idempotency guard: a repeat returns the ORIGINAL result, no charge.
      const reserve = await env.DB.prepare(
        "INSERT OR IGNORE INTO arcade_activity (player_id, play_id, game, activity_date, points_added, win_cents, result_label) VALUES (?, ?, ?, ?, 0, 0, 'pending')",
      ).bind(player.id, playId, game, today).run();

      if (reserve.meta.changes === 0) {
        // Duplicate play_id -> return the stored original outcome + live balances.
        const orig = await env.DB.prepare('SELECT points_added, win_cents, result_label FROM arcade_activity WHERE player_id = ? AND play_id = ?').bind(player.id, playId).first<{ points_added: number; win_cents: number; result_label: string }>();
        const bal = await env.DB.prepare('SELECT points, reward_cents FROM players WHERE id = ?').bind(player.id).first<{ points: number; reward_cents: number }>();
        if (orig && orig.result_label !== 'pending') {
          return json({
            ok: true, replay: true, game, cost: conf.cost,
            win_cents: orig.win_cents, win: centsToStr(orig.win_cents),
            points: bal?.points ?? player.points,
            reward_cents: bal?.reward_cents ?? 0, reward: centsToStr(bal?.reward_cents ?? 0),
          }, 200, rid);
        }
        // Reservation exists but was never finalized (rare crash mid-play).
        return fail('PLAY_IN_PROGRESS', 'This play is still processing. Please wait.', 409, rid);
      }

      const activityRowId = reserve.meta.last_row_id as number;

      // (2) Guarded atomic deduction - cannot go negative, immune to the earlier
      //     "check then deduct" race. Only proceeds if a row is returned.
      const deducted = await env.DB.prepare(
        "UPDATE players SET points = points - ?, updated_at = datetime('now') WHERE id = ? AND points >= ? RETURNING points",
      ).bind(conf.cost, player.id, conf.cost).first<{ points: number }>();

      if (!deducted) {
        // Not enough points -> release the reservation so the id can be reused.
        await env.DB.prepare('DELETE FROM arcade_activity WHERE id = ?').bind(activityRowId).run();
        return fail('INSUFFICIENT_POINTS', 'Not enough points.', 402, rid);
      }
      const pointsAfter = deducted.points;

      // (3) Server-chosen prize (secure).
      const winCents = pickPrize(conf.prizes);

      // (4) Finalize atomically: fill the reserved row, log the spend, credit the
      //     reward. One batch so activity is never half-written.
      const stmts = [
        env.DB.prepare('UPDATE arcade_activity SET points_added = ?, win_cents = ?, result_label = ? WHERE id = ?')
          .bind(-conf.cost, winCents, winCents > 0 ? 'win' : 'no_win', activityRowId),
        env.DB.prepare('INSERT INTO point_activity (player_id, type, amount, points_after, note) VALUES (?, ?, ?, ?, ?)')
          .bind(player.id, POINT_TYPES.ARCADE_PLAY, -conf.cost, pointsAfter, `Played ${game}`),
      ];
      if (winCents > 0) {
        stmts.push(env.DB.prepare("UPDATE players SET reward_cents = reward_cents + ?, updated_at = datetime('now') WHERE id = ?").bind(winCents, player.id));
      }
      try {
        await env.DB.batch(stmts);
      } catch (e) {
        // The points were already taken. If the finalize fails we MUST put them
        // back and free the play_id, or the player pays for a round they never
        // got and can never retry it.
        try {
          await env.DB.batch([
            env.DB.prepare("UPDATE players SET points = points + ?, updated_at = datetime('now') WHERE id = ?").bind(conf.cost, player.id),
            env.DB.prepare('DELETE FROM arcade_activity WHERE id = ?').bind(activityRowId),
          ]);
        } catch (e2) {
          // Refund itself failed — log loudly so it can be corrected by hand.
          console.error(JSON.stringify({ rid, msg: 'arcade_refund_failed', player: player.id, cost: conf.cost, activity: activityRowId, err: String((e2 as any)?.message || e2) }));
        }
        console.error(JSON.stringify({ rid, msg: 'arcade_finalize_failed', player: player.id, err: String((e as any)?.message || e) }));
        return fail('PLAY_FAILED', 'That round could not be completed. Your points have been returned — please try again.', 500, rid);
      }

      const bal = await env.DB.prepare('SELECT reward_cents FROM players WHERE id = ?').bind(player.id).first<{ reward_cents: number }>();
      // Big-win auto-message (SGD 10+). Best-effort; never blocks the play.
      if (winCents >= 1000) {
        try { await sendAutoMessage(env, player.id, 'big_win', { win_amount: centsToStr(winCents), game: GAME_LABELS[game] || game }); } catch { /* best-effort */ }
      }
      return json({
        ok: true, game, cost: conf.cost, win_cents: winCents, win: centsToStr(winCents),
        points: pointsAfter, reward_cents: bal?.reward_cents ?? 0, reward: centsToStr(bal?.reward_cents ?? 0),
      }, 200, rid);
    }

    // ---- Reward submit: atomic claim-and-reset (no duplicate payouts) ----
    case '/api/reward/submit': {
      if (!(await rateLimit(env, `submit:${player.id}`, 12, 60))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);

      // Cooldown: after a submission that is still pending or was approved, the
      // player must wait 10 minutes before submitting again. It is measured from
      // the submission time (created_at), so a later staff approval never resets
      // or extends the clock. Cancelled AND rejected submissions are excluded, so
      // a cancel-within-10s or a staff rejection never triggers the wait.
      // Uses only created_at + status values, so it needs no schema migration.
      try {
        const recent = await env.DB.prepare(
          "SELECT created_at FROM payout_requests WHERE player_id = ? AND status NOT IN ('cancelled', 'rejected') AND created_at > datetime('now', '-600 seconds') ORDER BY id DESC LIMIT 1",
        ).bind(player.id).first<{ created_at: string }>();
        if (recent) {
          const left = await env.DB.prepare(
            "SELECT CAST((600 - (julianday('now') - julianday(?)) * 86400) AS INTEGER) AS s",
          ).bind(recent.created_at).first<{ s: number }>();
          const secs = Math.max(1, left?.s ?? 600);
          const mins = Math.max(1, Math.ceil(secs / 60));
          return fail('COOLDOWN', `Please wait about ${mins} minute${mins === 1 ? '' : 's'} before submitting again.`, 429, rid);
        }
      } catch { /* payout table always exists; ignore any transient issue */ }

      // Read current balance, then claim it with a compare-and-swap so only ONE
      // parallel submit can win a given balance.
      // Reward credits go to a FREE CREDIT account (Pussy888 / Mega888 only) —
      // never to a deposit account. Only an ID the player actually owns is
      // accepted, so a forged request cannot send credit elsewhere.
      const ownIds = await loadFreeIds(env, player.id);
      const usable = (ownIds || []).filter((g: any) => g && g.game_id);
      if (!usable.length) {
        return fail('NO_GAME_ID', 'You have no free credit account yet. Please ask staff to set one up.', 400, rid);
      }
      let chosen = usable[0];
      if (usable.length > 1) {
        const wantPlat = String(body.platform || '').trim();
        const wantId = String(body.game_id || '').trim();
        const match = usable.find((g: any) => (wantPlat && g.platform === wantPlat) || (wantId && g.game_id === wantId));
        if (!match) return fail('NEED_GAME_ID', 'Please choose which game account to send this to.', 400, rid);
        chosen = match;
      }
      const chosenGame = GAME_PLATFORM_LABELS[chosen.platform] || chosen.platform;
      const chosenId = String(chosen.game_id);

      const cur = await env.DB.prepare('SELECT reward_cents FROM players WHERE id = ?').bind(player.id).first<{ reward_cents: number }>();
      const amount = cur?.reward_cents ?? 0;
      if (amount <= 0) return fail('EMPTY_BALANCE', 'Your reward balance is empty.', 400, rid);

      // Take the credits and create the request in ONE transaction.
      //
      // The INSERT reads the amount from the players row itself and both
      // statements are guarded on `reward_cents = amount`, so either both
      // happen or neither does. There is no window where the balance is
      // zeroed without a request existing — not even if the isolate dies.
      //
      // Two parallel submits: the first commits and sets the balance to 0, so
      // the second matches nothing on either statement and inserts nothing.
      // It stays hidden from staff for 10s (see the admin visibility filter),
      // giving the player a window to cancel. created_at drives that window.
      let payoutId = 0;
      try {
        const res = await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO payout_requests (player_id, amount_cents, status, game, game_id) SELECT ?1, reward_cents, 'pending', ?3, ?4 FROM players WHERE id = ?1 AND reward_cents = ?2 AND reward_cents > 0",
          ).bind(player.id, amount, chosenGame, chosenId),
          env.DB.prepare(
            "UPDATE players SET reward_cents = 0, updated_at = datetime('now') WHERE id = ?1 AND reward_cents = ?2 AND reward_cents > 0",
          ).bind(player.id, amount),
        ]);
        const inserted = Number(res?.[0]?.meta?.changes || 0);
        if (inserted === 0) {
          // Balance moved between the read and the write (another submit won,
          // or a game credited more). Nothing was taken here.
          return fail('BALANCE_CHANGED', 'Your reward balance just changed. Please try again.', 409, rid);
        }
        payoutId = Number(res?.[0]?.meta?.last_row_id) || 0;
        // Fallback in case last_row_id isn't populated: fetch the newest row.
        if (!payoutId) {
          const row = await env.DB.prepare(
            "SELECT id FROM payout_requests WHERE player_id = ? ORDER BY id DESC LIMIT 1",
          ).bind(player.id).first<{ id: number }>();
          payoutId = row?.id ?? 0;
        }
      } catch (e) {
        // The whole transaction rolled back, so the credits were never taken.
        console.error(JSON.stringify({ rid, msg: 'reward_submit_failed', player: player.id, err: String((e as any)?.message || e) }));
        return fail('SUBMIT_FAILED', 'Could not submit right now. Please try again.', 500, rid);
      }

      // If this player was submitting a VIP credit (pending_submission), move it
      // to pending_approval and tie it to this payout, and mark the payout so
      // History and the approval step know it's a VIP credit. The red notice
      // clears; the lock stays until staff approve.
      try {
        const mc = await getManualCredit(env, player.id);
        if (mc && mc.mc_status === 'pending_submission' && payoutId) {
          await env.DB.batch([
            env.DB.prepare("UPDATE players SET mc_status = 'pending_approval', mc_payout_id = ?, updated_at = datetime('now') WHERE id = ? AND mc_status = 'pending_submission'").bind(payoutId, player.id),
            env.DB.prepare('UPDATE payout_requests SET fc_custom = 1 WHERE id = ?').bind(payoutId),
          ]);
        }
      } catch { /* mc_/fc_custom columns not migrated: skip */ }

      return json({ ok: true, submitted: centsToStr(amount), reward_cents: 0, reward: '0.00', payout_id: payoutId, cancel_seconds: 10 }, 200, rid);
    }

    // ---- Cancel a just-submitted reward (only within the 10s hold window) ----
    case '/api/reward/cancel': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      // The amount is fixed once the request is created, so it is safe to read first.
      const row = await env.DB.prepare(
        "SELECT amount_cents FROM payout_requests WHERE id = ? AND player_id = ? AND status = 'pending' AND created_at > datetime('now', '-10 seconds')",
      ).bind(id, player.id).first<{ amount_cents: number }>();
      if (!row) return fail('TOO_LATE', 'This submission can no longer be cancelled.', 409, rid);
      // Cancel + refund in ONE transaction, so a mid-way failure can never leave a
      // request "cancelled" without returning the credits (both roll back together).
      // A unique token written by the flip gates the refund, so ONLY the caller that
      // actually flips this row (exactly one, even under a double-tap) restores the
      // balance — no double refund.
      const token = 'cxl:' + crypto.randomUUID();
      const res = await env.DB.batch([
        env.DB.prepare(
          "UPDATE payout_requests SET status = 'cancelled', decided_at = datetime('now'), decision_note = ? WHERE id = ? AND player_id = ? AND status = 'pending' AND created_at > datetime('now', '-10 seconds')",
        ).bind(token, id, player.id),
        env.DB.prepare(
          "UPDATE players SET reward_cents = reward_cents + ?, updated_at = datetime('now') WHERE id = ? AND EXISTS (SELECT 1 FROM payout_requests WHERE id = ? AND player_id = ? AND status = 'cancelled' AND decision_note = ?)",
        ).bind(row.amount_cents, player.id, id, player.id, token),
      ]);
      // If our flip changed nothing, another cancel won first — nothing was refunded here.
      const flipped = Number((res?.[0] as any)?.meta?.changes ?? 0) > 0;
      if (!flipped) return fail('TOO_LATE', 'This submission can no longer be cancelled.', 409, rid);
      const bal = await env.DB.prepare('SELECT reward_cents FROM players WHERE id = ?').bind(player.id).first<{ reward_cents: number }>();
      const newCents = bal?.reward_cents ?? row.amount_cents;
      // If this was the VIP-credit submission, roll it back to pending_submission
      // (the amount is back in the balance) so the red notice returns.
      try {
        await env.DB.prepare(
          "UPDATE players SET mc_status = 'pending_submission', mc_payout_id = NULL WHERE id = ? AND mc_status = 'pending_approval' AND mc_payout_id = ?",
        ).bind(player.id, id).run();
      } catch { /* mc_ columns not migrated */ }
      return json({ ok: true, reward_cents: newCents, reward: centsToStr(newCents), restored: centsToStr(row.amount_cents) }, 200, rid);
    }

    case '/api/history': {
      const [reward, activity, checkins, payouts] = await Promise.all([
        env.DB.prepare('SELECT type, amount, points_after, note, created_at FROM point_activity WHERE player_id = ? ORDER BY id DESC LIMIT 50').bind(player.id).all(),
        env.DB.prepare("SELECT game, points_added, win_cents, result_label, created_at FROM arcade_activity WHERE player_id = ? AND result_label != 'pending' ORDER BY id DESC LIMIT 50").bind(player.id).all(),
        env.DB.prepare('SELECT checkin_date, points_added, streak, created_at FROM daily_checkins WHERE player_id = ? ORDER BY id DESC LIMIT 50').bind(player.id).all(),
        env.DB.prepare("SELECT id, amount_cents, status, created_at, decided_at, game, game_id, decision_note, fc_status, fc_winover_x, fc_hit_cents, fc_cap_cents, fc_custom FROM payout_requests WHERE player_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 50").bind(player.id).all()
          .catch(() => env.DB.prepare("SELECT id, amount_cents, status, created_at, decided_at, game, game_id FROM payout_requests WHERE player_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 50").bind(player.id).all()),
      ]);

      const act: Array<{ kind: string; label: string; points_added: number; win?: string; created_at: string }> = [];
      for (const r of (activity.results || []) as any[]) {
        const label = GAME_LABELS[r.game] || r.game;
        act.push({ kind: 'game', label: `Played ${label}`, points_added: r.points_added, win: r.win_cents > 0 ? centsToStr(r.win_cents) : undefined, created_at: r.created_at });
      }
      for (const c of (checkins.results || []) as any[]) {
        act.push({ kind: 'checkin', label: `Check-in (day ${Math.min(c.streak, CHECKIN_REWARDS.length)})`, points_added: c.points_added, created_at: c.created_at });
      }
      act.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

      const payoutRows = ((payouts.results || []) as any[]).map((p) => ({
        id: p.id, amount: centsToStr(p.amount_cents), status: p.status, created_at: p.created_at, decided_at: p.decided_at,
        // game credentials are only shown for APPROVED payouts
        game: p.status === 'approved' ? p.game : undefined,
        game_id: p.status === 'approved' ? p.game_id : undefined,
        // Withdrawal rule for this free credit: what to hit, what you get.
        // Shown only once approved, alongside the game credentials.
        fc_status: p.status === 'approved' ? (p.fc_status ?? undefined) : undefined,
        // Staff handed this credit out directly (custom credit) — the app
        // labels it "VIP Free Credit" instead of "Reward submitted".
        fc_custom: p.fc_custom ? 1 : 0,
        // Staff moved this to another account after approving — the card
        // shows a tag so the player notices, not just the chat message.
        account_changed: p.status === 'approved' && String(p.decision_note || '').indexOf('[account changed') !== -1 ? true : undefined,
        winover: p.status === 'approved' && p.fc_winover_x != null ? p.fc_winover_x : undefined,
        hit: p.status === 'approved' && p.fc_hit_cents != null ? centsToStr(p.fc_hit_cents) : undefined,
        withdraw: p.status === 'approved' && p.fc_cap_cents != null ? centsToStr(p.fc_cap_cents) : undefined,
      }));
      // A VIP credit that's given but not yet submitted has no payout row yet,
      // so surface it here for the History "Pending submission" line.
      const mcHist = await getManualCredit(env, player.id);
      const manualPending = mcHist && mcHist.mc_status === 'pending_submission'
        ? { amount: centsToStr(mcHist.mc_amount_cents ?? 0) } : null;
      return json({ ok: true, reward: (reward.results || []).slice(0, 50), activity: act.slice(0, 50), payouts: payoutRows.slice(0, 50), manual_pending: manualPending }, 200, rid);
    }

    case '/api/vip': {
      const vip = await getVipStatus(env, player.id);
      await grantUpgradeBonuses(env, player.id, vip);
      const claimed = await env.DB.prepare('SELECT 1 AS x FROM vip_weekly_claims WHERE player_id = ? AND week_key = ?').bind(player.id, vip.week_key).first();
      const ranks = await getRanks(env);
      const current = vip.rank_idx >= 0 ? ranks[vip.rank_idx] : null;
      const next = vip.rank_idx + 1 < ranks.length ? ranks[vip.rank_idx + 1] : null;
      return json({
        ok: true, ranks, rank_idx: vip.rank_idx, rank_name: current ? current.name : null,
        deposit_total: vip.deposit_total, next_deposit: next ? next.deposit : null,
        weekly_points: current ? current.weekly : 0, weekly_claimed: !!claimed,
        month_key: vip.month_key, week_key: vip.week_key,
        history: await vipRankHistory(env, player.id, vip.month_key),
      }, 200, rid);
    }

    case '/api/vip/claim-weekly': {
      if (!(await rateLimit(env, `vipclaim:${player.id}`, 10, 60))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      if (await hasCustomCreditLock(env, player.id)) return fail('CREDIT_LOCK', CREDIT_LOCK_MSG, 409, rid);
      const vip = await getVipStatus(env, player.id);
      if (vip.rank_idx < 0) return fail('NO_RANK', 'Reach a VIP rank first to claim the Weekly Bonus.', 403, rid);
      const rank = (await getRanks(env))[vip.rank_idx];
      // Claim marker + points in ONE transaction. UNIQUE(player_id, week_key)
      // fails the whole batch on a repeat, so a week can never be marked
      // claimed without the points actually landing.
      try {
        await env.DB.batch([
          env.DB.prepare('INSERT INTO vip_weekly_claims (player_id, week_key, rank_idx, points_added) VALUES (?, ?, ?, ?)')
            .bind(player.id, vip.week_key, vip.rank_idx, rank.weekly),
          ...pointRewardStmts(env, player.id, POINT_TYPES.VIP_WEEKLY, rank.weekly, `Weekly Bonus: ${rank.name}`),
        ]);
      } catch (e) {
        if (/UNIQUE/i.test(String((e as any)?.message || e))) return fail('WEEKLY_CLAIMED', 'Weekly Bonus already claimed this week.', 409, rid);
        return fail('WEEKLY_FAILED', 'Could not claim the Weekly Bonus right now. Please try again.', 500, rid);
      }
      const nt = await env.DB.prepare('SELECT points FROM players WHERE id = ?').bind(player.id).first<{ points: number }>();
      return json({ ok: true, points_added: rank.weekly, points: nt?.points ?? (player.points + rank.weekly) }, 200, rid);
    }

    case '/api/password': {
      if (!(await rateLimit(env, `pwd:${player.id}`, 6, 300))) return fail('RATE_LIMITED', 'Too many attempts. Please try again later.', 429, rid);
      const current = String(body.current_password || '');
      const next = String(body.new_password || '');
      if (next.length < 8) return fail('WEAK_PASSWORD', 'New password must be at least 8 characters.', 400, rid);
      if (!(await verifyPassword(current, player.password))) return fail('BAD_PASSWORD', 'Current password is incorrect.', 401, rid);
      const hash = await hashPassword(next);
      // Bump session_version so every previous token is invalidated.
      await env.DB.prepare("UPDATE players SET password = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?").bind(hash, player.id).run();
      const fresh = await env.DB.prepare('SELECT session_version FROM players WHERE id = ?').bind(player.id).first<{ session_version: number }>();
      const token = await signToken(env, 'player', String(player.id), fresh?.session_version ?? 2, PLAYER_SESSION_SECONDS);
      return json({ ok: true, token }, 200, rid);
    }

    default:
      return fail('NOT_FOUND', 'Not found', 404, rid);
  }
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

async function handleAdminApi(path: string, request: Request, env: Env, rid: string): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return fail('BAD_REQUEST', 'Invalid request.', 400, rid);
  const ip = clientIp(request);

  // ---- First-time setup detection ----
  if (path === '/api/admin/needs-setup') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM admins').first<{ c: number }>();
    return json({ ok: true, setup: (count?.c ?? 0) === 0 }, 200, rid);
  }

  // ---- First admin creation - protected by ADMIN_SETUP_SECRET ----
  if (path === '/api/admin/setup') {
    if (!(await rateLimit(env, `setup:ip:${ip}`, 10, 3600))) return fail('RATE_LIMITED', 'Too many attempts. Please try again later.', 429, rid);
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM admins').first<{ c: number }>();
    if ((count?.c ?? 0) > 0) return fail('SETUP_DONE', 'Setup is already complete.', 403, rid);

    const provided = String(body.setup_secret || '');
    if (!env.ADMIN_SETUP_SECRET || !provided || !timingSafeEqualStr(provided, env.ADMIN_SETUP_SECRET)) {
      return fail('SETUP_FORBIDDEN', 'Setup secret is missing or incorrect.', 403, rid);
    }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || username.length < 3) return fail('BAD_USERNAME', 'Username must be at least 3 characters.', 400, rid);
    if (password.length < 8) return fail('WEAK_PASSWORD', 'Password must be at least 8 characters.', 400, rid);
    const hash = await hashPassword(password);
    await env.DB.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').bind(username, hash).run();
    const fresh = await env.DB.prepare('SELECT session_version FROM admins WHERE username = ?').bind(username).first<{ session_version: number }>();
    const token = await signToken(env, 'admin', username, fresh?.session_version ?? 1, ADMIN_SESSION_SECONDS);
    return json({ ok: true, token, username, expires_in: ADMIN_SESSION_SECONDS }, 200, rid);
  }

  // ---- Admin login ----
  if (path === '/api/admin/login') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return fail('INVALID_LOGIN', 'Invalid username or password.', 401, rid);
    const lockKey = `login:admin:${username.toLowerCase()}`;
    if ((await isLockedOut(env, lockKey)) || !(await rateLimit(env, `login:ip:${ip}`, 30, 300))) {
      return fail('RATE_LIMITED', 'Too many attempts. Please try again later.', 429, rid);
    }
    const row = await env.DB.prepare('SELECT username, password, session_version FROM admins WHERE username = ?').bind(username).first<{ username: string; password: string; session_version: number }>();
    if (!row || !(await verifyPassword(password, row.password))) {
      await recordAuthFail(env, lockKey, 6, 900); // 6 fails -> 15 min lock
      return fail('INVALID_LOGIN', 'Invalid username or password.', 401, rid);
    }
    await clearAuthFail(env, lockKey);
    const token = await signToken(env, 'admin', row.username, row.session_version || 1, ADMIN_SESSION_SECONDS);
    // Fail closed to match requireAdmin: only exact 'manager' is a manager.
    let loginRole = 'manager';
    try {
      const rr = await env.DB.prepare('SELECT role FROM admins WHERE username = ?').bind(row.username).first<{ role?: string }>();
      loginRole = rr && rr.role === 'manager' ? 'manager' : 'staff';
    } catch { /* role column not migrated yet -> manager (schema compat) */ }
    // Managers get every section; staff get exactly what was granted.
    let loginPerms = GRANTABLE_PERMS.slice();
    if (loginRole !== 'manager') {
      try {
        const pr = await env.DB.prepare('SELECT permissions FROM admins WHERE username = ?').bind(row.username).first<{ permissions?: string | null }>();
        loginPerms = (pr && typeof pr.permissions === 'string' && pr.permissions.length) ? pr.permissions.split(',').map((s) => s.trim()).filter(Boolean) : [];
      } catch { loginPerms = GRANTABLE_PERMS.slice(); }
    }
    return json({ ok: true, token, username: row.username, role: loginRole, perms: loginPerms, expires_in: ADMIN_SESSION_SECONDS }, 200, rid);
  }

  const auth = await requireAdmin(request, env);
  if (!auth) return fail('UNAUTHENTICATED', 'Unauthorized', 401, rid);
  const admin = auth.username;
  const isManager = auth.role === 'manager';

  // Role gate: these endpoints rewrite records or manage the system, so they
  // are for managers only. Enforced HERE, not just hidden in the UI.
  // ALWAYS manager-only, never grantable to staff — these control accounts and
  // destruction. (If staff could open Admins, they could grant themselves
  // anything, which would defeat the whole permission system.)
  const MANAGER_ONLY = [
    '/api/admin/history/purge',
    '/api/admin/admins/list', '/api/admin/admins/create', '/api/admin/admins/delete',
    '/api/admin/admins/permissions', '/api/admin/admins/password',
    // Permanently deleting a player wipes their records — managers only.
    '/api/admin/player/delete',
  ];
  if (!isManager && MANAGER_ONLY.indexOf(path) !== -1) {
    return fail('FORBIDDEN', 'Managers only. Ask a manager to do this.', 403, rid);
  }

  // Per-staff "empowerment": each of these sections is only reachable if a
  // manager granted the matching permission. Managers bypass. The player list
  // and activity logs are intentionally NOT here — they are shared with the
  // Messages search and the player profile popup, so they stay reachable; those
  // tabs are hidden in the UI instead. What IS locked here changes money/config.
  const PERM_MAP: Record<string, string> = {
    '/api/admin/deposits/all': 'deposits', '/api/admin/deposits/requests': 'deposits', '/api/admin/deposits/decide': 'deposits',
    '/api/admin/promos/list': 'earn', '/api/admin/promos/save': 'earn', '/api/admin/promos/delete': 'earn', '/api/admin/promos/reorder': 'earn',
    '/api/admin/games/list': 'games', '/api/admin/games/save': 'games', '/api/admin/games/simulate': 'games',
    '/api/admin/rules/list': 'rules', '/api/admin/rules/save': 'rules',
    '/api/admin/vip/list': 'vip', '/api/admin/vip/save': 'vip',
    '/api/admin/templates/save': 'templates', '/api/admin/templates/delete': 'templates',
    '/api/admin/domains/list': 'domains', '/api/admin/domains/save': 'domains', '/api/admin/domains/delete': 'domains', '/api/admin/domains/set-primary': 'domains', '/api/admin/domains/broadcast': 'domains',
    '/api/admin/settings/get': 'settings', '/api/admin/settings/save': 'settings',
    // Game RTP page (platforms + games + the paste-a-column RTP update).
    '/api/admin/rtp/platforms': 'rtp', '/api/admin/rtp/platform/save': 'rtp', '/api/admin/rtp/platform/delete': 'rtp',
    '/api/admin/rtp/games': 'rtp', '/api/admin/rtp/game/save': 'rtp', '/api/admin/rtp/game/delete': 'rtp',
    '/api/admin/rtp/bulk-add': 'rtp', '/api/admin/rtp/bulk-import': 'rtp', '/api/admin/rtp/paste': 'rtp',
    // Slot Games launcher (same "rtp" section — the slot/games area).
    '/api/admin/slots/list': 'rtp', '/api/admin/slots/save': 'rtp', '/api/admin/slots/delete': 'rtp', '/api/admin/slots/reorder': 'rtp',
    // Home banners (site display — grouped under "settings").
    '/api/admin/banners/list': 'settings', '/api/admin/banners/save': 'settings', '/api/admin/banners/delete': 'settings', '/api/admin/banners/reorder': 'settings',
    // "View app" (act as player) — grantable to trusted staff.
    '/api/admin/player/impersonate': 'view_app',
  };
  if (!isManager) {
    const need = PERM_MAP[path];
    if (need && auth.perms.indexOf(need) === -1) {
      return fail('FORBIDDEN', 'You do not have access to this section. Ask a manager to enable it.', 403, rid);
    }
  }

  switch (path) {
    // ---- Change the account an APPROVED reward went to ---------------------
    // For when a player asks to move to their other free credit account after
    // staff already approved. Staff may do this; it is everyday work.
    case '/api/admin/payout/change-id': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);

      const row = await env.DB.prepare(
        'SELECT id, player_id, status, game, game_id, fc_status FROM payout_requests WHERE id = ?',
      ).bind(id).first<{ id: number; player_id: number; status: string; game: string; game_id: string; fc_status: string | null }>()
        .catch(() => null);
      if (!row) return fail('NOT_FOUND', 'That reward request was not found.', 404, rid);
      if (row.status !== 'approved') return fail('NOT_APPROVED', 'Only approved rewards can have their account changed.', 409, rid);
      // Once it has been withdrawn the account is history — moving it would
      // rewrite a record the player already cashed out against.
      if (row.fc_status === 'used') {
        return fail('ALREADY_WITHDRAWN', 'This free credit was already withdrawn, so its account cannot be changed.', 409, rid);
      }

      const game = String(body.game || '').trim();
      const gameId = String(body.game_id || '').trim().slice(0, 64);
      if (!game || !gameId) return fail('BAD_REQUEST', 'Choose an account.', 400, rid);

      // Must be one of THIS player's own free credit accounts.
      const free = await loadFreeIds(env, row.player_id);
      const ok = free.some((g) => (GAME_PLATFORM_LABELS[g.platform] || g.platform) === game && g.game_id === gameId);
      if (!ok) return fail('NOT_THEIR_ACCOUNT', 'That is not one of this player’s free credit accounts.', 400, rid);

      if (row.game === game && row.game_id === gameId) {
        return json({ ok: true, unchanged: true, game, game_id: gameId }, 200, rid);
      }

      // Guarded on status so a concurrent withdrawal decision can't race it.
      const done = await env.DB.prepare(
        "UPDATE payout_requests SET game = ?, game_id = ?, decision_note = TRIM(COALESCE(decision_note,'') || ' [account changed to ' || ? || ' ' || ? || ' by ' || ? || ']') WHERE id = ? AND status = 'approved' RETURNING id",
      ).bind(game, gameId, game, gameId, admin, id).first<{ id: number }>();
      if (!done) return fail('ALREADY_DECIDED', 'That request changed while you were editing. Reload and try again.', 409, rid);

      // The player needs to know which account to actually play on.
      // Wording editable in the Templates tab.
      try { await sendAutoMessage(env, row.player_id, 'game_id_changed', { new_game: game, new_game_id: gameId }); } catch { /* message is best-effort */ }

      return json({ ok: true, game, game_id: gameId }, 200, rid);
    }

    // ---- Free-credit withdrawal rules (manager only) -----------------------
    case '/api/admin/rules/list': {
      const rules = await loadWithdrawRules(env);
      return json({
        ok: true,
        rules: rules.map((r) => ({ up_to_cents: r.upTo, winover_x: r.winover, cap_cents: r.cap })),
      }, 200, rid);
    }

    case '/api/admin/rules/save': {
      const raw = body.rules;
      if (!Array.isArray(raw) || raw.length === 0) return fail('NO_RULES', 'Add at least one rule band.', 400, rid);
      if (raw.length > 12) return fail('TOO_MANY_RULES', 'A maximum of 12 bands is allowed.', 400, rid);

      const parsed: FreeCreditRule[] = [];
      for (const item of raw) {
        const upTo = Math.round(Number((item as any)?.up_to_cents));
        const winover = Math.round(Number((item as any)?.winover_x) * 100) / 100;
        const cap = Math.round(Number((item as any)?.cap_cents));
        if (!Number.isFinite(upTo) || upTo <= 0 || upTo > 100000000) {
          return fail('BAD_BAND', 'Each band needs a valid "up to" amount.', 400, rid);
        }
        if (!Number.isFinite(winover) || winover < 0 || winover > 1000) {
          return fail('BAD_WINOVER', 'Wagering multiplier must be between 0 and 1000.', 400, rid);
        }
        if (!Number.isFinite(cap) || cap <= 0 || cap > 100000000) {
          return fail('BAD_CAP', 'Each band needs a withdraw amount above 0.', 400, rid);
        }
        parsed.push({ upTo, winover, cap });
      }
      parsed.sort((a, b) => a.upTo - b.upTo);
      // No two bands may end at the same place, or the lower one is unreachable.
      for (let i = 1; i < parsed.length; i++) {
        if (parsed[i].upTo === parsed[i - 1].upTo) {
          return fail('DUPLICATE_BAND', 'Two bands end at the same amount. Each "up to" must be different.', 400, rid);
        }
      }

      const before = await loadWithdrawRules(env);
      // Replace + audit in one transaction: rules can never be half-applied,
      // and every change leaves a record of what it was before.
      try {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM withdraw_rules'),
          ...parsed.map((r) => env.DB.prepare(
            "INSERT INTO withdraw_rules (up_to_cents, winover_x, cap_cents, updated_at, updated_by) VALUES (?, ?, ?, datetime('now'), ?)",
          ).bind(r.upTo, r.winover, r.cap, admin)),
          env.DB.prepare('INSERT INTO withdraw_rule_changes (before_json, after_json, changed_by) VALUES (?, ?, ?)')
            .bind(JSON.stringify(before), JSON.stringify(parsed), admin),
        ]);
      } catch (e) {
        // Almost always a missing table. Say which one and how to fix it,
        // instead of a bare 500 that tells the manager nothing.
        const msg = String((e as any)?.message || e);
        const m = /no such table:?\s*([a-zA-Z0-9_]+)/i.exec(msg);
        if (m) {
          return fail('NEEDS_MIGRATION', `Database table "${m[1]}" is missing. Run the withdraw rules migration in the D1 console, then try again.`, 503, rid);
        }
        console.error(JSON.stringify({ rid, msg: 'rules_save_failed', err: msg }));
        return fail('SAVE_FAILED', `Could not save the rules: ${msg.slice(0, 160)}`, 500, rid);
      }
      invalidateRulesCache();
      return json({ ok: true, rules: parsed.map((r) => ({ up_to_cents: r.upTo, winover_x: r.winover, cap_cents: r.cap })) }, 200, rid);
    }

    // ---- Game economy editor (manager only) --------------------------------
    case '/api/admin/games/list': {
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO game_configs (game, cost, prizes_json, enabled, version, updated_at, updated_by) VALUES ('cross', 5, ?, 0, 1, datetime('now'), 'system')`,
        ).bind(JSON.stringify([{ cents: 100, w: 85 }, { cents: 200, w: 80 }, { cents: 400, w: 75 }, { cents: 800, w: 70 }, { cents: 1600, w: 65 }, { cents: 3200, w: 60 }])).run();
        await env.DB.prepare(
          `INSERT OR IGNORE INTO game_configs (game, cost, prizes_json, enabled, version, updated_at, updated_by) VALUES ('wheel', 1, ?, 0, 1, datetime('now'), 'system')`,
        ).bind(JSON.stringify([{ cents: 0, w: 20 }, { cents: 50, w: 25 }, { cents: 100, w: 20 }, { cents: 200, w: 15 }, { cents: 500, w: 10 }, { cents: 888, w: 6 }, { cents: 2888, w: 3 }, { cents: 8888, w: 1 }])).run();
        await env.DB.prepare(
          `INSERT OR IGNORE INTO game_configs (game, cost, prizes_json, enabled, version, updated_at, updated_by) VALUES ('crown', 10, ?, 0, 1, datetime('now'), 'system')`,
        ).bind(JSON.stringify([{ cents: 7777, w: 2 }, { cents: 5077, w: 6 }, { cents: 3077, w: 15 }, { cents: 1077, w: 32 }, { cents: 0, w: 45 }])).run();
      } catch { /* table missing or older schema: the editor shows the game as not set up */ }
      const rows = await readGameConfigsFresh(env);
      const settings = await getSettings(env);
      const ptCents = pointValueCents(settings);
      const games = ALLOWED_GAMES.map((g) => {
        const row = rows[g];
        if (!row) {
          return { game: g, missing: true, cost: 0, prizes: [], enabled: false, version: 0, updated_at: null, updated_by: null, expected_cents: 0, rtp: null };
        }
        const prizes = parsePrizes(row.prizes_json);
        return {
          game: g,
          missing: false,
          cost: row.cost,
          prizes,
          enabled: Number(row.enabled) === 1,
          version: row.version,
          updated_at: row.updated_at,
          updated_by: row.updated_by,
          expected_cents: Math.round((g === 'cross' ? crossBestValueCents(prizes) : expectedPayoutCents(prizes)) * 100) / 100,
          rtp: g === 'cross' ? rtpPercent([{ cents: crossBestValueCents(prizes), w: 100 }], row.cost, ptCents) : rtpPercent(prizes, row.cost, ptCents),
        };
      });
      return json({
        ok: true,
        games,
        point_value_cents: Math.round(ptCents * 1000) / 1000,
        deposit_point_rate: Math.floor(Number(settings.deposit_point_rate ?? '10')),
        max_prizes: MAX_PRIZES,
      }, 200, rid);
    }

    case '/api/admin/games/save': {
      const game = String(body.game || '');
      const v = validateGameInput(game, body.cost, body.prizes);
      if (!v.ok) return fail(v.code, v.msg, 400, rid);
      const enabled = Number(body.enabled) === 1 ? 1 : 0;
      const afterJson = JSON.stringify(v.prizes);

      const before = await env.DB.prepare(
        'SELECT cost, prizes_json, enabled, version FROM game_configs WHERE game = ?',
      ).bind(game).first<{ cost: number; prizes_json: string; enabled: number; version: number }>();

      // If the caller sent the version they were looking at and it has moved on,
      // another manager saved in the meantime. Refuse rather than silently
      // overwrite their change.
      const expected = Number(body.version);
      if (before && Number.isFinite(expected) && expected > 0 && expected !== before.version) {
        return fail('VERSION_CONFLICT', 'Another manager changed this game while you were editing. Reload and try again.', 409, rid);
      }

      const beforeJson = before
        ? JSON.stringify({ cost: before.cost, prizes: parsePrizes(before.prizes_json), enabled: Number(before.enabled) === 1 })
        : null;

      // The settings write and its audit row go in one batch — a change can
      // never be applied without a matching log entry.
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO game_configs (game, cost, prizes_json, enabled, version, updated_at, updated_by)
           VALUES (?, ?, ?, ?, 1, datetime('now'), ?)
           ON CONFLICT(game) DO UPDATE SET
             cost = excluded.cost,
             prizes_json = excluded.prizes_json,
             enabled = excluded.enabled,
             version = game_configs.version + 1,
             updated_at = datetime('now'),
             updated_by = excluded.updated_by`,
        ).bind(game, v.cost, afterJson, enabled, admin),
        env.DB.prepare(
          'INSERT INTO game_config_changes (game, before_json, after_json, changed_by) VALUES (?, ?, ?, ?)',
        ).bind(game, beforeJson, JSON.stringify({ cost: v.cost, prizes: v.prizes, enabled: enabled === 1 }), admin),
      ]);

      // This isolate serves the new settings immediately; others expire within
      // 60 seconds (GAME_CACHE_MS).
      invalidateGameCache();

      const fresh = await env.DB.prepare('SELECT version FROM game_configs WHERE game = ?').bind(game).first<{ version: number }>();
      const settings = await getSettings(env);
      const ptCents = pointValueCents(settings);
      return json({
        ok: true,
        game,
        version: fresh?.version ?? 1,
        expected_cents: Math.round((game === 'cross' ? crossBestValueCents(v.prizes) : expectedPayoutCents(v.prizes)) * 100) / 100,
        rtp: game === 'cross' ? rtpPercent([{ cents: crossBestValueCents(v.prizes), w: 100 }], v.cost, ptCents) : rtpPercent(v.prizes, v.cost, ptCents),
      }, 200, rid);
    }

    case '/api/admin/games/simulate': {
      const game = String(body.game || '');
      if (game === 'cross') return fail('NOT_SUPPORTED', 'Simulation is not available for Lucky Crossing — the RTP shown is for a player who always stops at the best lane.', 400, rid);
      const v = validateGameInput(game, body.cost, body.prizes);
      if (!v.ok) return fail(v.code, v.msg, 400, rid);

      let n = Math.floor(Number(body.n));
      if (!Number.isFinite(n) || n <= 0) n = 10000;
      n = Math.max(100, Math.min(100000, n));

      // Same weighted draw the real game uses, just run n times.
      const total = v.prizes.reduce((s, p) => s + p.w, 0);
      const counts = new Array(v.prizes.length).fill(0);
      const rnd = randomFloats(n);
      let paid = 0;
      for (let i = 0; i < n; i++) {
        const target = rnd[i] * total;
        let acc = 0;
        let idx = v.prizes.length - 1;
        for (let k = 0; k < v.prizes.length; k++) {
          acc += v.prizes[k].w;
          if (target < acc) { idx = k; break; }
        }
        counts[idx]++;
        paid += v.prizes[idx].cents;
      }

      const settings = await getSettings(env);
      const ptCents = pointValueCents(settings);
      const spend = v.cost * ptCents * n;
      return json({
        ok: true,
        game,
        n,
        cost: v.cost,
        distribution: v.prizes.map((p, i) => ({
          cents: p.cents,
          weight: p.w,
          expected_pct: Math.round((p.w / total) * 10000) / 100,
          count: counts[i],
          actual_pct: Math.round((counts[i] / n) * 10000) / 100,
        })),
        total_paid_cents: paid,
        avg_payout_cents: Math.round((paid / n) * 100) / 100,
        expected_cents: Math.round(expectedPayoutCents(v.prizes) * 100) / 100,
        actual_rtp: spend > 0 ? Math.round((paid / spend) * 10000) / 100 : null,
        expected_rtp: rtpPercent(v.prizes, v.cost, ptCents),
      }, 200, rid);
    }

    case '/api/admin/vip/list': {
      // Fresh read so a manager always sees exactly what is stored.
      const ranks = await getRanks(env, true);
      return json({
        ok: true,
        ranks: ranks.map((r, i) => ({ rank_idx: i, name: r.name, deposit: r.deposit, weekly: r.weekly, upgrade: r.upgrade })),
      }, 200, rid);
    }

    case '/api/admin/vip/save': {
      const items = Array.isArray(body.ranks) ? body.ranks : [];
      if (!items.length) return fail('BAD_REQUEST', 'Nothing to save.', 400, rid);
      const clean: { i: number; w: number; u: number }[] = [];
      for (const it of items) {
        const i = Math.floor(Number((it as any)?.rank_idx));
        if (!Number.isInteger(i) || i < 0 || i >= VIP_RANKS.length) return fail('BAD_RANK', 'Invalid rank.', 400, rid);
        const w = Math.floor(Number((it as any)?.weekly));
        const u = Math.floor(Number((it as any)?.upgrade));
        if (!Number.isFinite(w) || w < 0 || w > 100000) return fail('BAD_WEEKLY', 'Weekly bonus must be between 0 and 100000.', 400, rid);
        if (!Number.isFinite(u) || u < 0 || u > 100000) return fail('BAD_UPGRADE', 'Upgrade bonus must be between 0 and 100000.', 400, rid);
        clean.push({ i, w, u });
      }
      try {
        await env.DB.batch(clean.map((c) => env.DB.prepare(
          "INSERT INTO vip_rewards (rank_idx, weekly, upgrade, updated_at, updated_by) VALUES (?, ?, ?, datetime('now'), ?) " +
          "ON CONFLICT(rank_idx) DO UPDATE SET weekly = excluded.weekly, upgrade = excluded.upgrade, updated_at = datetime('now'), updated_by = excluded.updated_by",
        ).bind(c.i, c.w, c.u, admin)));
      } catch (e) {
        return fail('SAVE_FAILED', 'Could not save. Has the vip_rewards table been created? Run migration 14.', 500, rid);
      }
      // This isolate serves the new amounts at once; others expire within 60s.
      invalidateVipCache();
      return json({ ok: true, ranks: (await getRanks(env, true)).map((r, i) => ({ rank_idx: i, name: r.name, deposit: r.deposit, weekly: r.weekly, upgrade: r.upgrade })) }, 200, rid);
    }

    case '/api/admin/overview': {
      const today = sgtDateKey();
      const [players, activeToday, pointsTotal, tasks, pendingPayouts] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS c FROM players').first<{ c: number }>(),
        env.DB.prepare(`SELECT COUNT(DISTINCT player_id) AS c FROM (
             SELECT player_id FROM daily_checkins WHERE checkin_date = ?
             UNION SELECT player_id FROM arcade_activity WHERE activity_date = ?
           )`).bind(today, today).first<{ c: number }>(),
        env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS s FROM players').first<{ s: number }>(),
        env.DB.prepare('SELECT COUNT(*) AS c FROM promos WHERE active = 1').first<{ c: number }>().catch(() => null),
        env.DB.prepare("SELECT COUNT(*) AS c FROM payout_requests WHERE status = 'pending' AND created_at <= datetime('now', '-10 seconds')").first<{ c: number }>(),
      ]);
      const chatUnread = await env.DB.prepare('SELECT COALESCE(SUM(admin_unread), 0) AS s FROM chat_state').first<{ s: number }>().catch(() => null);
      const pendingWithdrawals = await env.DB.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE status = 'pending'").first<{ c: number }>().catch(() => null);
      return json({ ok: true, role: auth.role, perms: isManager ? GRANTABLE_PERMS.slice() : auth.perms, players: players?.c ?? 0, active_today: activeToday?.c ?? 0, points_total: pointsTotal?.s ?? 0, tasks: tasks?.c ?? 0, pending_payouts: pendingPayouts?.c ?? 0, pending_withdrawals: pendingWithdrawals?.c ?? 0, chat_unread: chatUnread?.s ?? 0 }, 200, rid);
    }

    case '/api/admin/player/create': {
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      const displayName = String(body.display_name || '').trim().slice(0, 60);
      if (!username) return fail('BAD_USERNAME', 'Username must be 3-32 characters: letters, numbers, dot or underscore.', 400, rid);
      if (password.length < 8) return fail('WEAK_PASSWORD', 'Password must be at least 8 characters.', 400, rid);
      const hash = await hashPassword(password);
      try {
        const res = await env.DB.prepare('INSERT INTO players (username, password, display_name) VALUES (?, ?, ?)').bind(username, hash, displayName || null).run();
        const newId = Number(res.meta.last_row_id);
        // Pass the just-set password so the Welcome template can show the player
        // their starting login. This is the ONLY point it's known in plain text
        // (it's hashed at rest). It then lives in that chat as plain text.
        try { await sendAutoMessage(env, newId, 'welcome', { password }); } catch { /* best-effort */ }
        return json({ ok: true, id: res.meta.last_row_id, username }, 200, rid);
      } catch {
        return fail('USERNAME_TAKEN', 'That username already exists.', 409, rid);
      }
    }

    case '/api/admin/player/impersonate': {
      // "View app": mint a SHORT-LIVED (30 min) player token so a manager can
      // open and use the player's app exactly as the player. Manager-only.
      if (!(await rateLimit(env, `imp:${admin}`, 30, 300))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first<PlayerRow>();
      if (!p) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);
      if ((p as any).status !== 'active') return fail('ACCOUNT_INACTIVE', 'That account is not active.', 400, rid);
      const token = await signToken(env, 'player', String((p as any).id), (p as any).session_version || 1, 1800);
      return json({ ok: true, token, username: (p as any).username }, 200, rid);
    }

    case '/api/admin/player/password': {
      const id = Number(body.id);
      const next = String(body.new_password || '');
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      if (next.length < 8) return fail('WEAK_PASSWORD', 'New password must be at least 8 characters.', 400, rid);
      const exists = await env.DB.prepare('SELECT id FROM players WHERE id = ?').bind(id).first();
      if (!exists) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);
      const hash = await hashPassword(next);
      // Admin reset also invalidates that player's existing sessions.
      await env.DB.prepare("UPDATE players SET password = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?").bind(hash, id).run();
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/players': {
      const q = String(body.q || '').trim();
      const tagFilter = String(body.tag || '').trim();
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));
      const like = `%${q.toLowerCase()}%`;
      try {
        // Tag-aware: search matches the tag too, and an exact tag filter is supported.
        let sql = 'SELECT id, username, display_name, points, reward_cents, status, note, telegram, whatsapp, tag, created_at, updated_at FROM players';
        const conds: string[] = []; const binds: unknown[] = [];
        if (q) { conds.push("(lower(username) LIKE ? OR lower(display_name) LIKE ? OR CAST(id AS TEXT) LIKE ? OR lower(COALESCE(tag,'')) LIKE ?)"); binds.push(like, like, like, like); }
        if (tagFilter) { conds.push("lower(COALESCE(tag,'')) = ?"); binds.push(tagFilter.toLowerCase()); }
        if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        binds.push(limit, offset);
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        return json({ ok: true, players: results || [], offset, limit }, 200, rid);
      } catch {
        // tag column not migrated — fall back to name/username/id.
        let sql = 'SELECT id, username, display_name, points, reward_cents, status, note, telegram, whatsapp, created_at, updated_at FROM players';
        const binds: unknown[] = [];
        if (q) { sql += ' WHERE lower(username) LIKE ? OR lower(display_name) LIKE ? OR CAST(id AS TEXT) LIKE ?'; binds.push(like, like, like); }
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        binds.push(limit, offset);
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        return json({ ok: true, players: results || [], offset, limit }, 200, rid);
      }
    }

    case '/api/admin/player/update': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const status = body.status !== undefined ? String(body.status) : null;
      const note = body.note !== undefined ? String(body.note).slice(0, 500) : null;
      const displayName = body.display_name !== undefined ? String(body.display_name).trim().slice(0, 60) : null;
      const telegram = body.telegram !== undefined ? String(body.telegram).trim().slice(0, 100) : null;
      const whatsapp = body.whatsapp !== undefined ? String(body.whatsapp).trim().slice(0, 100) : null;
      const tag = body.tag !== undefined ? String(body.tag).trim().slice(0, 40) : null;
      if (status !== null && !['active', 'blocked'].includes(status)) return fail('BAD_STATUS', "status must be 'active' or 'blocked'.", 400, rid);
      // Optional username (= Player ID) change. Same rules as creation; the
      // account keeps its internal id so history, deposits and balances are
      // untouched — only the login name / Player ID changes.
      let newUsername: string | null = null;
      if (body.username !== undefined && String(body.username).trim() !== '') {
        newUsername = normalizeUsername(body.username);
        if (!newUsername) return fail('BAD_USERNAME', 'Username must be 3-32 characters: letters, numbers, dot or underscore.', 400, rid);
      }
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (status !== null) { sets.push('status = ?'); binds.push(status); }
      if (note !== null) { sets.push('note = ?'); binds.push(note); }
      if (displayName !== null) { sets.push('display_name = ?'); binds.push(displayName || null); }
      if (telegram !== null) { sets.push('telegram = ?'); binds.push(telegram || null); }
      if (whatsapp !== null) { sets.push('whatsapp = ?'); binds.push(whatsapp || null); }
      if (newUsername !== null) { sets.push('username = ?'); binds.push(newUsername); }
      if (sets.length) {
        binds.push(id);
        try {
          await env.DB.prepare(`UPDATE players SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).bind(...binds).run();
        } catch {
          return fail('USERNAME_TAKEN', 'That username already exists.', 409, rid);
        }
      }
      // Tag saved separately so a missing column (pre-migration) can't break the rest.
      if (tag !== null) {
        try { await env.DB.prepare("UPDATE players SET tag = ?, updated_at = datetime('now') WHERE id = ?").bind(tag || null, id).run(); } catch { /* tag column not migrated */ }
      }
      return json({ ok: true, username: newUsername || undefined }, 200, rid);
    }

    // Load a player's game IDs + bank/birthday details for the admin modal.
    case '/api/admin/player/profile': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first<any>();
      if (!p) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);
      return json({
        ok: true,
        // Full identity so the chat page can open any player action inline.
        player: {
          id: p.id, username: p.username, display_name: p.display_name,
          status: p.status, note: p.note ?? null, tag: p.tag ?? null,
          telegram: p.telegram ?? null, whatsapp: p.whatsapp ?? null,
          points: p.points, reward_cents: p.reward_cents,
        },
        // Deposit accounts: all 7 games. Free credit accounts: 2 games.
        platforms: GAME_PLATFORMS.map((k) => ({ key: k, label: GAME_PLATFORM_LABELS[k] })),
        free_platforms: FREE_PLATFORMS.map((k) => ({ key: k, label: GAME_PLATFORM_LABELS[k] })),
        game_ids: await loadGameIds(env, id),
        free_ids: await loadFreeIds(env, id),
        details: playerDetails(p),
      }, 200, rid);
    }

    // Permanently delete a player and all their data. Manager only.
    case '/api/admin/player/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const p = await env.DB.prepare('SELECT username FROM players WHERE id = ?').bind(id).first<{ username: string }>();
      if (!p) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);
      // The manager must type the exact username to confirm (guards against a
      // mis-click deleting the wrong account).
      if (String(body.confirm_username || '').trim() !== p.username) {
        return fail('CONFIRM_MISMATCH', 'Type the exact username to confirm deletion.', 400, rid);
      }
      // Remove child rows first (best-effort per table so an optional/absent
      // table can't block the delete), then the player row itself.
      const childTables = [
        'player_game_ids', 'player_free_ids', 'payout_requests', 'withdrawals', 'deposits',
        'point_activity', 'credit_activity', 'arcade_activity', 'daily_checkins',
        'chat_messages', 'chat_state', 'promo_claims', 'promo_unlocks',
        'vip_weekly_claims', 'vip_upgrade_grants', 'deposit_bonus_claims', 'push_subs',
      ];
      for (const t of childTables) {
        try { await env.DB.prepare(`DELETE FROM ${t} WHERE player_id = ?`).bind(id).run(); } catch { /* table may not exist */ }
      }
      await env.DB.prepare('DELETE FROM players WHERE id = ?').bind(id).run();
      return json({ ok: true, deleted_username: p.username }, 200, rid);
    }

    // Staff set/clear a player's game IDs (one per platform). Empty = remove.
    case '/api/admin/player/game-ids/save': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const map = (body.game_ids || {}) as Record<string, unknown>;
      const stmts: any[] = [];
      for (const plat of GAME_PLATFORMS) {
        const val = map[plat] === undefined ? undefined : String(map[plat] || '').trim().slice(0, 60);
        if (val === undefined) continue;
        if (val === '') {
          stmts.push(env.DB.prepare('DELETE FROM player_game_ids WHERE player_id = ? AND platform = ?').bind(id, plat));
        } else {
          stmts.push(env.DB.prepare("INSERT INTO player_game_ids (player_id, platform, game_id) VALUES (?, ?, ?) ON CONFLICT(player_id, platform) DO UPDATE SET game_id = excluded.game_id, updated_at = datetime('now')").bind(id, plat, val));
        }
      }
      // Free credit accounts save in the same call, from their own map.
      const freeMap = (body.free_ids || {}) as Record<string, unknown>;
      for (const plat of FREE_PLATFORMS) {
        const val = freeMap[plat] === undefined ? undefined : String(freeMap[plat] || '').trim().slice(0, 60);
        if (val === undefined) continue;
        if (val === '') {
          stmts.push(env.DB.prepare('DELETE FROM player_free_ids WHERE player_id = ? AND platform = ?').bind(id, plat));
        } else {
          stmts.push(env.DB.prepare("INSERT INTO player_free_ids (player_id, platform, game_id) VALUES (?, ?, ?) ON CONFLICT(player_id, platform) DO UPDATE SET game_id = excluded.game_id, updated_at = datetime('now')").bind(id, plat, val));
        }
      }
      if (!stmts.length) return json({ ok: true }, 200, rid);
      try { await env.DB.batch(stmts); } catch { return fail('NEEDS_MIGRATION', 'Run the profile migration first.', 409, rid); }
      return json({ ok: true, game_ids: await loadGameIds(env, id) }, 200, rid);
    }

    // Staff edit a player's bank details / birthday (bypasses the player lock).
    case '/api/admin/player/details/save': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const bn = String(body.bank_name || '').trim().slice(0, 60);
      const ba = String(body.bank_account || '').trim().slice(0, 40);
      const bh = String(body.bank_holder || '').trim().slice(0, 60);
      const pn = String(body.paynow_number || '').trim().slice(0, 30);
      const bd = String(body.birthday || '').trim().slice(0, 10);
      if (bd && !/^\d{4}-\d{2}-\d{2}$/.test(bd)) return fail('BAD_REQUEST', 'Birthday must be YYYY-MM-DD (or blank).', 400, rid);
      // Lock a group once it holds data; clearing it unlocks so the player could re-enter.
      const bankLock = (bn || ba || bh || pn) ? 1 : 0;
      const bdayLock = bd ? 1 : 0;
      try {
        await env.DB.prepare("UPDATE players SET bank_name=?, bank_account=?, bank_holder=?, paynow_number=?, birthday=?, bank_locked=?, birthday_locked=?, updated_at=datetime('now') WHERE id=?")
          .bind(bn || null, ba || null, bh || null, pn || null, bd || null, bankLock, bdayLock, id).run();
      } catch { return fail('NEEDS_MIGRATION', 'Run the profile migration first.', 409, rid); }
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first<any>();
      return json({ ok: true, details: playerDetails(p) }, 200, rid);
    }

    case '/api/admin/points/correct': {
      const id = Number(body.id);
      const amount = Number(body.amount);
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (!id || !Number.isFinite(amount) || amount === 0) return fail('BAD_REQUEST', 'id and a non-zero amount are required.', 400, rid);
      if (!Number.isInteger(amount) || Math.abs(amount) > 1000000) return fail('AMOUNT_RANGE', 'Amount must be a whole number no larger than 1,000,000.', 400, rid);
      if (!isManager && Math.abs(amount) > 200) return fail('STAFF_CAP', 'Staff can adjust up to \u00b1200 points. Ask a manager for larger corrections.', 403, rid);
      if (!reason) return fail('REASON_REQUIRED', 'A reason is required for point corrections.', 400, rid);
      const exists = await env.DB.prepare('SELECT id FROM players WHERE id = ?').bind(id).first();
      if (!exists) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);
      // Guarded so a negative correction can never push the balance below zero.
      const upd = await env.DB.prepare("UPDATE players SET points = points + ?, updated_at = datetime('now') WHERE id = ? AND points + ? >= 0 RETURNING points").bind(amount, id, amount).first<{ points: number }>();
      if (!upd) return fail('WOULD_GO_NEGATIVE', 'That correction would make the balance negative.', 409, rid);
      await logActivity(env, id, POINT_TYPES.ADMIN_CORRECTION, amount, upd.points, reason, admin);
      return json({ ok: true, points: upd.points }, 200, rid);
    }

    case '/api/admin/deposit/record': {
      const id = Number(body.id);
      const amount = Number(body.amount);
      const note = String(body.note || '').trim().slice(0, 300);
      const reference = String(body.reference || '').trim().slice(0, 80);
      const res = await recordDeposit(env, id, amount, note, reference, admin);
      if (!res.ok) return fail(res.code, res.msg, res.status, rid);
      return json({ ok: true, deposit_total: res.deposit_total, rank_name: res.rank_name, upgrade_points_granted: res.upgrade_points_granted, deposit_points_granted: res.deposit_points_granted }, 200, rid);
    }

    case '/api/admin/deposit/list': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      let results: any[] = [];
      try {
        ({ results } = await env.DB.prepare('SELECT id, amount, month_key, note, admin_username, created_at, reference FROM deposits WHERE player_id = ? ORDER BY id DESC LIMIT 50').bind(id).all() as any);
      } catch {
        ({ results } = await env.DB.prepare('SELECT id, amount, month_key, note, admin_username, created_at FROM deposits WHERE player_id = ? ORDER BY id DESC LIMIT 50').bind(id).all() as any);
      }
      const vip = await getVipStatus(env, id);
      return json({ ok: true, deposits: results || [], deposit_total: vip.deposit_total, rank_name: vip.rank_idx >= 0 ? VIP_RANKS[vip.rank_idx].name : null, month_key: vip.month_key }, 200, rid);
    }

    case '/api/admin/deposit/update': {
      // Edit one deposit record (amount / note). VIP rank recalculates from
      // the new totals; upgrade bonuses newly reached are granted (idempotent
      // per rank per month). Bonuses already granted are never clawed back.
      const depId = Number(body.deposit_id);
      const amount = Number(body.amount);
      const note = String(body.note || '').trim().slice(0, 300);
      if (!depId || !Number.isFinite(amount) || amount <= 0) return fail('BAD_REQUEST', 'deposit_id and a positive amount are required.', 400, rid);
      if (amount > 100000000) return fail('AMOUNT_RANGE', 'Deposit amount is too large.', 400, rid);
      const row = await env.DB.prepare('UPDATE deposits SET amount = ?, note = ? WHERE id = ? RETURNING player_id').bind(amount, note || null, depId).first<{ player_id: number }>();
      if (!row) return fail('DEPOSIT_NOT_FOUND', 'Deposit not found.', 404, rid);
      const vip = await getVipStatus(env, row.player_id);
      const granted = await grantUpgradeBonuses(env, row.player_id, vip);
      return json({ ok: true, deposit_total: vip.deposit_total, rank_name: vip.rank_idx >= 0 ? VIP_RANKS[vip.rank_idx].name : null, upgrade_points_granted: granted }, 200, rid);
    }

    case '/api/admin/deposit/delete': {
      const depId = Number(body.deposit_id);
      if (!depId) return fail('BAD_REQUEST', 'deposit_id is required.', 400, rid);
      const row = await env.DB.prepare('DELETE FROM deposits WHERE id = ? RETURNING player_id').bind(depId).first<{ player_id: number }>();
      if (!row) return fail('DEPOSIT_NOT_FOUND', 'Deposit not found.', 404, rid);
      const vip = await getVipStatus(env, row.player_id);
      return json({ ok: true, deposit_total: vip.deposit_total, rank_name: vip.rank_idx >= 0 ? VIP_RANKS[vip.rank_idx].name : null }, 200, rid);
    }

    case '/api/admin/reward/correct': {
      // Gift-credit (reward balance) correction. Same integrity rules as the
      // point correction: whole-cent amounts, required reason, guarded UPDATE
      // so a negative correction can never push the balance below zero, and
      // every correction is logged with the admin's username.
      const id = Number(body.id);
      const amount = Number(body.amount); // in credits, e.g. 2.88 or -1.50
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (!id || !Number.isFinite(amount) || amount === 0) return fail('BAD_REQUEST', 'id and a non-zero amount are required.', 400, rid);
      const cents = Math.round(amount * 100);
      if (cents === 0 || Math.abs(cents) > 100000000) return fail('AMOUNT_RANGE', 'Amount out of range.', 400, rid);
      if (!isManager && Math.abs(cents) > 1000) return fail('STAFF_CAP', 'Staff can adjust up to \u00b110.00 credits. Ask a manager for larger corrections.', 403, rid);
      if (!reason) return fail('REASON_REQUIRED', 'A reason is required for credit corrections.', 400, rid);
      const exists = await env.DB.prepare('SELECT id FROM players WHERE id = ?').bind(id).first();
      if (!exists) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);

      // ---- Manual (VIP) credit: give credit that shows in the reward balance,
      //      carries its own withdrawal rule, and locks the player until they
      //      submit it and staff approve. ----
      // rule_mode 'auto'   -> terms come from the backend free-credit brackets.
      // rule_mode 'manual' -> staff typed the multiplier + withdraw cap.
      // anything else       -> plain balance correction (handled below).
      const ruleMode = String(body.rule_mode || 'none');
      if (ruleMode === 'auto' || ruleMode === 'manual') {
        if (cents <= 0) return fail('BAD_CUSTOM_AMOUNT', 'A VIP credit must be a positive amount.', 400, rid);

        // One VIP credit at a time — the player must clear the current one first.
        const existing = await getManualCredit(env, id);
        if (existing && (existing.mc_status === 'pending_submission' || existing.mc_status === 'pending_approval')) {
          return fail('CREDIT_ACTIVE', 'This player already has an active VIP credit. Cancel it first, or wait for them to submit and you to approve it.', 409, rid);
        }

        // The player submits it via the reward flow, which needs a free-credit
        // Game ID (Pussy888/Mega888). Block here so they can't get locked with
        // no way to submit.
        const freeIds = await loadFreeIds(env, id);
        if (!(freeIds || []).some((g) => g && g.game_id)) {
          return fail('NO_FREE_ID', 'This player has no free-credit Game ID yet. Set one up first, then give the VIP credit.', 400, rid);
        }

        // Work out the terms for this credit.
        let winover: number, hitCents: number, capCents: number;
        if (ruleMode === 'manual') {
          winover = Math.round(Number(body.winover_x) * 100) / 100;
          capCents = Math.round(Number(body.cap) * 100);
          if (!Number.isFinite(winover) || winover < 0 || winover > 1000) return fail('BAD_WINOVER', 'Wagering multiplier must be between 0 and 1000.', 400, rid);
          if (!Number.isFinite(capCents) || capCents <= 0 || capCents > 100000000) return fail('BAD_CAP', 'Enter a withdraw amount above 0.', 400, rid);
          hitCents = Math.round(cents * winover);
        } else {
          const rule = await freeCreditRule(env, cents);
          const terms = freeCreditTerms(rule, cents);
          winover = terms.winover; hitCents = terms.hit_cents; capCents = terms.cap_cents;
        }

        // Add it to the reward balance (shows at the top) AND arm the lock, in
        // ONE guarded write. mc_status='pending_submission' freezes everything
        // but the Submit button and shows the red notice.
        let bal: { reward_cents: number } | null;
        try {
          bal = await env.DB.prepare(
            "UPDATE players SET reward_cents = reward_cents + ?, mc_status = 'pending_submission', mc_amount_cents = ?, mc_winover = ?, mc_cap_cents = ?, mc_payout_id = NULL, updated_at = datetime('now') WHERE id = ? RETURNING reward_cents",
          ).bind(cents, cents, winover, capCents, id).first<{ reward_cents: number }>();
        } catch (e) {
          const msg = String((e as any)?.message || e);
          const m = /no such (?:table|column):?\s*([a-zA-Z0-9_.]+)/i.exec(msg);
          if (m) return fail('NEEDS_MIGRATION', `Database is missing "${m[1]}". Run migration 25 (manual credit) in the D1 console, then try again.`, 503, rid);
          return fail('CUSTOM_FAILED', 'Could not give the VIP credit. Please try again.', 500, rid);
        }
        if (!bal) return fail('CUSTOM_FAILED', 'Could not give the VIP credit.', 500, rid);

        // Audit line in the credit ledger.
        try {
          const note = `[VIP credit x${winover}, cap ${centsToStr(capCents)}] ${reason}`.slice(0, 300);
          await env.DB.prepare('INSERT INTO credit_activity (player_id, amount_cents, reward_after_cents, reason, admin_username) VALUES (?, ?, ?, ?, ?)').bind(id, cents, bal.reward_cents, note, admin).run();
        } catch { /* best-effort audit */ }

        // Nudge the player to submit it.
        try {
          await pushToPlayer(env, id,
            { title: 'VIP Free Credit added', body: `${centsToStr(cents)} added. Open the app and tap Submit to claim it.` },
            { title: 'VIP \u514d\u8d39\u4fe1\u7528\u5df2\u5230\u8d26', body: `\u5df2\u5230\u8d26 ${centsToStr(cents)}\u3002\u6253\u5f00\u5e94\u7528\u5e76\u70b9\u51fb\u201c\u63d0\u4ea4\u201d\u9886\u53d6\u3002` });
        } catch { /* best-effort */ }

        return json({ ok: true, custom: true, winover, cap: centsToStr(capCents), hit: centsToStr(hitCents), credit: centsToStr(cents), reward: (bal.reward_cents / 100).toFixed(2) }, 200, rid);
      }

      // ---- Plain balance correction (rule_mode 'none') ----
      const upd = await env.DB.prepare("UPDATE players SET reward_cents = reward_cents + ?, updated_at = datetime('now') WHERE id = ? AND reward_cents + ? >= 0 RETURNING reward_cents").bind(cents, id, cents).first<{ reward_cents: number }>();
      if (!upd) return fail('WOULD_GO_NEGATIVE', 'That correction would make the credit balance negative.', 409, rid);
      await env.DB.prepare('INSERT INTO credit_activity (player_id, amount_cents, reward_after_cents, reason, admin_username) VALUES (?, ?, ?, ?, ?)').bind(id, cents, upd.reward_cents, reason, admin).run();

      // Deducting credit clears an active VIP credit too, so the lock + notice
      // release (this is the "deduct = cancel" fix). Only fires on a takeback
      // while the credit is still sitting in the balance (pending_submission).
      let unlocked = false;
      if (cents < 0) {
        try {
          const r = await env.DB.prepare(
            "UPDATE players SET mc_status = NULL, mc_amount_cents = 0, mc_winover = NULL, mc_cap_cents = NULL, mc_payout_id = NULL WHERE id = ? AND mc_status = 'pending_submission'",
          ).bind(id).run();
          unlocked = Number(r?.meta?.changes || 0) > 0;
        } catch { /* mc_ columns not migrated: nothing to clear */ }
      }
      return json({ ok: true, reward_cents: upd.reward_cents, reward: (upd.reward_cents / 100).toFixed(2), unlocked }, 200, rid);
    }

    case '/api/admin/credit/custom-cancel': {
      // Cancel a player's active VIP credit so the lock + notice release.
      //  - pending_submission: the amount is still in the reward balance, so
      //    take it back out (guarded, never below zero) and clear the state.
      //  - pending_approval: the player already submitted it (balance is 0 and
      //    a pending payout exists) — reject that payout and clear the state.
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);

      const mc = await getManualCredit(env, id);
      if (!mc || (mc.mc_status !== 'pending_submission' && mc.mc_status !== 'pending_approval')) {
        return json({ ok: true, cancelled: 0 }, 200, rid);
      }

      try {
        if (mc.mc_status === 'pending_submission') {
          // Pull the credit back out of the balance (never below zero), then clear.
          await env.DB.prepare(
            "UPDATE players SET reward_cents = MAX(0, reward_cents - ?), mc_status = NULL, mc_amount_cents = 0, mc_winover = NULL, mc_cap_cents = NULL, mc_payout_id = NULL, updated_at = datetime('now') WHERE id = ?",
          ).bind(mc.mc_amount_cents ?? 0, id).run();
        } else {
          // Reject the pending submission (if still pending) and clear the state.
          if (mc.mc_payout_id) {
            await env.DB.prepare(
              "UPDATE payout_requests SET status = 'rejected', decided_at = datetime('now'), admin_username = ?, decision_note = 'VIP credit cancelled' WHERE id = ? AND status = 'pending'",
            ).bind(admin, mc.mc_payout_id).run();
          }
          await env.DB.prepare(
            "UPDATE players SET mc_status = NULL, mc_amount_cents = 0, mc_winover = NULL, mc_cap_cents = NULL, mc_payout_id = NULL, updated_at = datetime('now') WHERE id = ?",
          ).bind(id).run();
        }
      } catch (e) {
        const msg = String((e as any)?.message || e);
        const m = /no such (?:table|column):?\s*([a-zA-Z0-9_.]+)/i.exec(msg);
        if (m) return fail('NEEDS_MIGRATION', `Database is missing "${m[1]}". Run migration 25 (manual credit) in the D1 console, then try again.`, 503, rid);
        return fail('CANCEL_FAILED', 'Could not cancel the credit. Please try again.', 500, rid);
      }

      try {
        await env.DB.prepare('INSERT INTO credit_activity (player_id, amount_cents, reward_after_cents, reason, admin_username) VALUES (?, ?, (SELECT reward_cents FROM players WHERE id = ?), ?, ?)')
          .bind(id, 0, id, '[VIP credit cancelled — player unlocked]', admin).run();
      } catch { /* best-effort audit */ }
      return json({ ok: true, cancelled: 1 }, 200, rid);
    }

    case '/api/admin/credit-activity': {
      // Unified credit ledger: admin corrections, game wins, payout
      // submissions and rejected-payout refunds. Read-only reporting.
      const q = String(body.q || '').trim();
      const from = String(body.from || '').trim();
      const to = String(body.to || '').trim();
      const playerId = Number(body.player_id) || 0;
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
      let sql = `SELECT x.*, p.username, p.display_name FROM (
          SELECT ca.created_at, ca.player_id, 'correction' AS type, ca.amount_cents, COALESCE(ca.reason,'') AS note, ca.admin_username FROM credit_activity ca
          UNION ALL
          SELECT aa.created_at, aa.player_id, 'game win', aa.win_cents, aa.game || CASE WHEN aa.result_label IS NOT NULL THEN ' - ' || aa.result_label ELSE '' END, NULL FROM arcade_activity aa WHERE aa.win_cents > 0
          UNION ALL
          SELECT pr.created_at, pr.player_id, 'payout submitted', -pr.amount_cents, 'request #' || pr.id, NULL FROM payout_requests pr WHERE pr.status != 'cancelled'
          UNION ALL
          SELECT pr.decided_at, pr.player_id, 'payout refund', pr.amount_cents, 'request #' || pr.id || ' rejected', pr.admin_username FROM payout_requests pr WHERE pr.status = 'rejected' AND pr.decided_at IS NOT NULL
          UNION ALL
          SELECT pr.decided_at, pr.player_id, 'payout paid', 0,
            printf('%.2f', pr.amount_cents / 100.0) || CASE WHEN pr.game IS NOT NULL THEN ' - ' || pr.game || CASE WHEN pr.game_id IS NOT NULL THEN ' - ' || pr.game_id ELSE '' END ELSE '' END,
            pr.admin_username FROM payout_requests pr WHERE pr.status = 'approved' AND pr.decided_at IS NOT NULL
        ) x LEFT JOIN players p ON p.id = x.player_id WHERE 1=1`;
      const binds: unknown[] = [];
      if (playerId) { sql += ' AND x.player_id = ?'; binds.push(playerId); }
      if (q) { sql += ' AND (lower(p.username) LIKE ? OR lower(p.display_name) LIKE ? OR lower(x.type) LIKE ?)'; const like = `%${q.toLowerCase()}%`; binds.push(like, like, like); }
      if (from) { sql += ' AND x.created_at >= ?'; binds.push(sgtDayStartUtc(from)); }
      if (to) { sql += ' AND x.created_at <= ?'; binds.push(sgtDayEndUtc(to)); }
      sql += ' ORDER BY x.created_at DESC LIMIT ? OFFSET ?';
      binds.push(limit, offset);
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return json({ ok: true, activity: results || [], offset, limit }, 200, rid);
    }

    case '/api/admin/history/purge': {
      // Free up storage: permanently delete OLD history rows across all
      // players. Hard server-side guard: only records older than 1 month can
      // ever be deleted, whatever the client sends. Financial records
      // (players, deposits, payout_requests, vip grants/claims) are NEVER
      // touched — they are small and they protect balance integrity.
      const oneMonthAgo = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
      const before = String(body.before || '').trim(); // optional SGT date
      let cutoff = oneMonthAgo;
      if (before) {
        const requested = sgtDayStartUtc(before);
        if (requested > oneMonthAgo) return fail('TOO_RECENT', 'History newer than 1 month cannot be deleted.', 400, rid);
        cutoff = requested;
      }
      const ALLOWED = ['point_activity', 'credit_activity', 'arcade_activity', 'daily_checkins', 'chat_messages'];
      let tables = ALLOWED;
      if (Array.isArray(body.categories) && body.categories.length) {
        tables = body.categories.map(String).filter((c: string) => ALLOWED.includes(c));
        if (!tables.length) return fail('BAD_CATEGORIES', 'Select at least one valid category.', 400, rid);
      }
      const deleted: Record<string, number> = {};
      for (const t of tables) {
        const r = await env.DB.prepare(`DELETE FROM ${t} WHERE created_at < ?`).bind(cutoff).run();
        deleted[t] = r.meta.changes || 0;
      }
      return json({ ok: true, cutoff_utc: cutoff, deleted }, 200, rid);
    }

    case '/api/admin/promos/list': {
      const listSql = (order: string) => `SELECT p.*,
          (SELECT COUNT(*) FROM promo_claims c WHERE c.promo_id = p.id) AS total_claims,
          (SELECT COUNT(*) FROM promo_unlocks u WHERE u.promo_id = p.id AND u.status = 'available') AS pending_unlocks
        FROM promos p ORDER BY ${order}`;
      let results: unknown[] | undefined;
      try {
        ({ results } = await env.DB.prepare(listSql('p.sort_order ASC, p.id DESC')).all());
      } catch {
        ({ results } = await env.DB.prepare(listSql('p.id DESC')).all());
      }
      return json({ ok: true, promos: results || [] }, 200, rid);
    }

    case '/api/admin/promos/reorder': {
      // Move one promo up or down. Rewrites sort_order for the whole list so the
      // order is always clean and consistent, then swaps the two neighbours.
      const id = Number(body.id);
      const dir = String(body.dir) === 'up' ? 'up' : 'down';
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      let ordered: { id: number }[];
      try {
        const r = await env.DB.prepare('SELECT id FROM promos ORDER BY sort_order ASC, id DESC').all<{ id: number }>();
        ordered = r.results || [];
      } catch {
        return fail('NEEDS_MIGRATION', 'Run the promo order migration (adds sort_order) before reordering.', 409, rid);
      }
      const idx = ordered.findIndex((p) => p.id === id);
      if (idx < 0) return fail('NOT_FOUND', 'Promo not found.', 404, rid);
      const swapWith = dir === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= ordered.length) return json({ ok: true }, 200, rid); // already at the edge
      const tmp = ordered[idx]; ordered[idx] = ordered[swapWith]; ordered[swapWith] = tmp;
      await env.DB.batch(ordered.map((p, i) =>
        env.DB.prepare("UPDATE promos SET sort_order = ?, updated_at = datetime('now') WHERE id = ?").bind(i, p.id),
      ));
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/promos/save': {
      const id = Number(body.id) || 0;
      const title = String(body.title || '').trim().slice(0, 100);
      const titleZh = String(body.title_zh || '').trim().slice(0, 100);
      const tnc = String(body.tnc || '').trim().slice(0, 2000);
      const tncZh = String(body.tnc_zh || '').trim().slice(0, 2000);
      const points = Math.max(1, Math.min(100000, Math.floor(Number(body.points) || 0)));
      const access = String(body.access) === 'public' ? 'public' : 'gated';
      const limitType = String(body.limit_type) === 'lifetime' ? 'lifetime' : 'day';
      // Public promos need a real per-player cap (min 1). Gated promos allow 0,
      // which means "no limit" — staff can unlock any number.
      const rawLc = Math.floor(Number(body.limit_count));
      const limitCount = access === 'public'
        ? Math.max(1, Math.min(1000, isNaN(rawLc) ? 1 : rawLc))
        : Math.max(0, Math.min(1000, isNaN(rawLc) ? 0 : rawLc));
      const active = Number(body.active) ? 1 : 0;
      const appOnly = Number(body.app_only) ? 1 : 0;
      const rewardType = String(body.reward_type) === 'credits' ? 'credits' : 'points';
      // Banner image is optional. Only accept a URL that points at our own R2
      // image route, so nothing arbitrary can be injected.
      const rawImg = String(body.image_url || '').trim();
      const imageUrl = /^\/api\/chat\/img\/[a-z0-9-]{20,64}\.(webp|jpg|png)$/.test(rawImg) ? rawImg : null;
      if (!title) return fail('BAD_REQUEST', 'A promo title is required.', 400, rid);
      try {
        if (id) {
          await env.DB.prepare("UPDATE promos SET title = ?, title_zh = ?, tnc = ?, tnc_zh = ?, points = ?, access = ?, limit_type = ?, limit_count = ?, active = ?, image_url = ?, reward_type = ?, app_only = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(title, titleZh || null, tnc || null, tncZh || null, points, access, limitType, limitCount, active, imageUrl, rewardType, appOnly, id).run();
        } else {
          await env.DB.prepare('INSERT INTO promos (title, title_zh, tnc, tnc_zh, points, access, limit_type, limit_count, active, image_url, reward_type, app_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(title, titleZh || null, tnc || null, tncZh || null, points, access, limitType, limitCount, active, imageUrl, rewardType, appOnly).run();
        }
      } catch {
        // image_url column not migrated yet — save the promo without the banner.
        if (id) {
          await env.DB.prepare("UPDATE promos SET title = ?, title_zh = ?, tnc = ?, tnc_zh = ?, points = ?, access = ?, limit_type = ?, limit_count = ?, active = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(title, titleZh || null, tnc || null, tncZh || null, points, access, limitType, limitCount, active, id).run();
        } else {
          await env.DB.prepare('INSERT INTO promos (title, title_zh, tnc, tnc_zh, points, access, limit_type, limit_count, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(title, titleZh || null, tnc || null, tncZh || null, points, access, limitType, limitCount, active).run();
        }
      }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/promos/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      await env.DB.prepare('DELETE FROM promos WHERE id = ?').bind(id).run();
      await env.DB.prepare("UPDATE promo_unlocks SET status = 'revoked' WHERE promo_id = ? AND status = 'available'").bind(id).run();
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/deposit-bonus/list': {
      try {
        const { results } = await env.DB.prepare('SELECT id, title, min_deposit, period, reward_type, amount, active, start_date, end_date, image_url FROM deposit_bonus_tiers ORDER BY min_deposit ASC, id ASC').all();
        return json({ ok: true, tiers: results || [] }, 200, rid);
      } catch {
        try {
          const { results } = await env.DB.prepare('SELECT id, title, min_deposit, period, reward_type, amount, active FROM deposit_bonus_tiers ORDER BY min_deposit ASC, id ASC').all();
          return json({ ok: true, tiers: results || [] }, 200, rid);
        } catch { return json({ ok: true, tiers: [], needs_migration: true }, 200, rid); }
      }
    }

    case '/api/admin/deposit-bonus/save': {
      const id = Number(body.id) || 0;
      const title = String(body.title || '').trim().slice(0, 80);
      const minDeposit = Math.max(1, Math.min(100000000, Math.floor(Number(body.min_deposit) || 0)));
      const period = ['lifetime', 'month', 'week', 'today'].includes(String(body.period)) ? String(body.period) : 'lifetime';
      const rewardType = String(body.reward_type) === 'credits' ? 'credits' : 'points';
      const amount = Math.max(1, Math.min(10000000, Math.floor(Number(body.amount) || 0)));
      const active = Number(body.active) ? 1 : 0;
      // Optional date frame (YYYY-MM-DD). Anything not matching that shape -> no bound.
      const dre = /^\d{4}-\d{2}-\d{2}$/;
      const startDate = dre.test(String(body.start_date || '')) ? String(body.start_date) : null;
      const endDate = dre.test(String(body.end_date || '')) ? String(body.end_date) : null;
      // Banner image: only accept our own R2 image route (never anything arbitrary).
      const rawImg = String(body.image_url || '').trim();
      const imageUrl = /^\/api\/chat\/img\/[a-z0-9-]{20,64}\.(webp|jpg|png)$/.test(rawImg) ? rawImg : null;
      if (!minDeposit || !amount) return fail('BAD_REQUEST', 'A deposit threshold and reward amount are required.', 400, rid);
      try {
        if (id) {
          await env.DB.prepare('UPDATE deposit_bonus_tiers SET title=?, min_deposit=?, period=?, reward_type=?, amount=?, active=?, start_date=?, end_date=?, image_url=? WHERE id=?').bind(title || null, minDeposit, period, rewardType, amount, active, startDate, endDate, imageUrl, id).run();
        } else {
          await env.DB.prepare('INSERT INTO deposit_bonus_tiers (title, min_deposit, period, reward_type, amount, active, start_date, end_date, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(title || null, minDeposit, period, rewardType, amount, active, startDate, endDate, imageUrl).run();
        }
      } catch {
        // Date columns not migrated yet — save without them so nothing breaks.
        try {
          if (id) {
            await env.DB.prepare('UPDATE deposit_bonus_tiers SET title=?, min_deposit=?, period=?, reward_type=?, amount=?, active=? WHERE id=?').bind(title || null, minDeposit, period, rewardType, amount, active, id).run();
          } else {
            await env.DB.prepare('INSERT INTO deposit_bonus_tiers (title, min_deposit, period, reward_type, amount, active) VALUES (?, ?, ?, ?, ?, ?)').bind(title || null, minDeposit, period, rewardType, amount, active).run();
          }
        } catch { return fail('NEEDS_MIGRATION', 'Run the Phase 2 migration (adds deposit_bonus_tiers) first.', 409, rid); }
      }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/deposit-bonus/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      await env.DB.prepare('DELETE FROM deposit_bonus_tiers WHERE id = ?').bind(id).run();
      return json({ ok: true }, 200, rid);
    }

    // ---- Game RTP: platforms + games + the paste-a-column RTP update -------
    // RTP touches no points and no money. It is display/config only.
    case '/api/admin/rtp/platforms': {
      try {
        const pr = await env.DB.prepare('SELECT id, name, logo_url, sort_order, active FROM rtp_platforms ORDER BY sort_order ASC, id ASC')
          .all<{ id: number; name: string; logo_url: string | null; sort_order: number; active: number }>();
        const cr = await env.DB.prepare('SELECT platform_id AS pid, COUNT(*) AS c FROM rtp_games GROUP BY platform_id')
          .all<{ pid: number; c: number }>();
        const cmap: Record<number, number> = {};
        for (const x of (cr.results || [])) cmap[x.pid] = x.c;
        const platforms = (pr.results || []).map((p) => ({
          id: p.id, name: p.name, logo_url: p.logo_url || '', sort_order: p.sort_order, active: p.active, games: cmap[p.id] || 0,
        }));
        return json({ ok: true, platforms }, 200, rid);
      } catch { return json({ ok: true, platforms: [], needs_migration: true }, 200, rid); }
    }

    case '/api/admin/rtp/platform/save': {
      const id = Number(body.id) || 0;
      const name = String(body.name || '').trim().slice(0, 80);
      const logo = String(body.logo_url || '').trim().slice(0, 300);
      const active = Number(body.active) ? 1 : 0;
      if (!name) return fail('BAD_REQUEST', 'A platform name is required.', 400, rid);
      if (logo && !isRtpImage(logo)) return fail('BAD_IMAGE', 'Bad logo image.', 400, rid);
      try {
        if (id) {
          await env.DB.prepare('UPDATE rtp_platforms SET name=?, logo_url=?, active=? WHERE id=?').bind(name, logo || null, active, id).run();
        } else {
          const m = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM rtp_platforms').first<{ n: number }>();
          await env.DB.prepare('INSERT INTO rtp_platforms (name, logo_url, sort_order, active) VALUES (?,?,?,?)').bind(name, logo || null, m?.n || 1, active).run();
        }
      } catch { return fail('NEEDS_MIGRATION', 'Run migration 23 (the RTP tables) first.', 503, rid); }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/rtp/platform/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      try {
        await env.DB.prepare('DELETE FROM rtp_games WHERE platform_id=?').bind(id).run();
        await env.DB.prepare('DELETE FROM rtp_platforms WHERE id=?').bind(id).run();
      } catch { /* tables gone */ }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/rtp/platform/reorder': {
      // Move one platform up or down. Rewrites sort_order for the whole list so
      // the order stays clean, then swaps the two neighbours. Player RTP page
      // and admin list both read ORDER BY sort_order, so this is all that's needed.
      const id = Number(body.id);
      const dir = String(body.dir) === 'up' ? 'up' : 'down';
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      let ordered: { id: number }[];
      try {
        const r = await env.DB.prepare('SELECT id FROM rtp_platforms ORDER BY sort_order ASC, id ASC').all<{ id: number }>();
        ordered = r.results || [];
      } catch {
        return fail('NEEDS_MIGRATION', 'RTP tables are not set up yet.', 409, rid);
      }
      const idx = ordered.findIndex((p) => p.id === id);
      if (idx < 0) return fail('NOT_FOUND', 'Platform not found.', 404, rid);
      const swapWith = dir === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= ordered.length) return json({ ok: true }, 200, rid); // already at the edge
      const tmp = ordered[idx]; ordered[idx] = ordered[swapWith]; ordered[swapWith] = tmp;
      await env.DB.batch(ordered.map((p, i) =>
        env.DB.prepare('UPDATE rtp_platforms SET sort_order = ? WHERE id = ?').bind(i, p.id),
      ));
      return json({ ok: true }, 200, rid);
    }

    // ---- Slot Games launcher: platforms + play links (display/link only) ----
    // No points, no money — this only stores what "Play Now" opens.
    case '/api/admin/slots/list': {
      try {
        const sr = await env.DB.prepare(
          'SELECT id, name, logo_url, kind, play_url, android_package, sort_order, active FROM slot_platforms ORDER BY sort_order ASC, id ASC',
        ).all();
        return json({ ok: true, platforms: sr.results || [] }, 200, rid);
      } catch { return json({ ok: true, platforms: [], needs_migration: true }, 200, rid); }
    }

    case '/api/admin/slots/save': {
      const id = Number(body.id) || 0;
      const name = String(body.name || '').trim().slice(0, 80);
      const logo = String(body.logo_url || '').trim().slice(0, 300);
      const kind = String(body.kind) === 'web' ? 'web' : 'app';
      const playUrl = String(body.play_url || '').trim().slice(0, 500);
      const pkg = String(body.android_package || '').trim().slice(0, 120);
      const active = Number(body.active) ? 1 : 0;
      if (!name) return fail('BAD_REQUEST', 'A platform name is required.', 400, rid);
      if (logo && !(isRtpImage(logo) || /^https:\/\//i.test(logo))) return fail('BAD_IMAGE', 'Logo must be an uploaded image or an https link.', 400, rid);
      if (playUrl && !/^https?:\/\//i.test(playUrl)) return fail('BAD_URL', 'Play link must start with http:// or https://', 400, rid);
      if (pkg && !/^[a-zA-Z0-9._]+$/.test(pkg)) return fail('BAD_PACKAGE', 'Android package looks invalid (letters, numbers and dots only).', 400, rid);
      try {
        if (id) {
          await env.DB.prepare('UPDATE slot_platforms SET name=?, logo_url=?, kind=?, play_url=?, android_package=?, active=? WHERE id=?')
            .bind(name, logo || null, kind, playUrl || null, pkg || null, active, id).run();
        } else {
          const m = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM slot_platforms').first<{ n: number }>();
          await env.DB.prepare('INSERT INTO slot_platforms (name, logo_url, kind, play_url, android_package, sort_order, active) VALUES (?,?,?,?,?,?,?)')
            .bind(name, logo || null, kind, playUrl || null, pkg || null, m?.n || 1, active).run();
        }
      } catch { return fail('NEEDS_MIGRATION', 'Run the slot_platforms table SQL first.', 503, rid); }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/slots/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      try { await env.DB.prepare('DELETE FROM slot_platforms WHERE id=?').bind(id).run(); } catch { /* table gone */ }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/slots/reorder': {
      const id = Number(body.id);
      const dir = String(body.dir) === 'up' ? 'up' : 'down';
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      let ordered: { id: number }[];
      try {
        const r = await env.DB.prepare('SELECT id FROM slot_platforms ORDER BY sort_order ASC, id ASC').all<{ id: number }>();
        ordered = r.results || [];
      } catch { return fail('NEEDS_MIGRATION', 'Slot table is not set up yet.', 409, rid); }
      const idx = ordered.findIndex((p) => p.id === id);
      if (idx < 0) return fail('NOT_FOUND', 'Platform not found.', 404, rid);
      const swapWith = dir === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= ordered.length) return json({ ok: true }, 200, rid);
      const tmp = ordered[idx]; ordered[idx] = ordered[swapWith]; ordered[swapWith] = tmp;
      await env.DB.batch(ordered.map((p, i) =>
        env.DB.prepare('UPDATE slot_platforms SET sort_order = ? WHERE id = ?').bind(i, p.id),
      ));
      return json({ ok: true }, 200, rid);
    }

    // ---- Home banners: carousel images (display/link only) ----
    case '/api/admin/banners/list': {
      try {
        const br = await env.DB.prepare('SELECT id, image_url, link_url, sort_order, active FROM banners ORDER BY sort_order ASC, id ASC').all();
        return json({ ok: true, banners: br.results || [] }, 200, rid);
      } catch { return json({ ok: true, banners: [], needs_migration: true }, 200, rid); }
    }

    case '/api/admin/banners/save': {
      const id = Number(body.id) || 0;
      const img = String(body.image_url || '').trim().slice(0, 300);
      const link = String(body.link_url || '').trim().slice(0, 500);
      const active = Number(body.active) ? 1 : 0;
      if (!img) return fail('BAD_REQUEST', 'A banner image is required.', 400, rid);
      if (!(isRtpImage(img) || /^https:\/\//i.test(img))) return fail('BAD_IMAGE', 'Banner must be an uploaded image or an https link.', 400, rid);
      if (link && !/^https?:\/\//i.test(link)) return fail('BAD_URL', 'Link must start with http:// or https://', 400, rid);
      try {
        if (id) {
          await env.DB.prepare('UPDATE banners SET image_url=?, link_url=?, active=? WHERE id=?').bind(img, link || null, active, id).run();
        } else {
          const m = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM banners').first<{ n: number }>();
          await env.DB.prepare('INSERT INTO banners (image_url, link_url, sort_order, active) VALUES (?,?,?,?)').bind(img, link || null, m?.n || 1, active).run();
        }
      } catch { return fail('NEEDS_MIGRATION', 'Run the banners table SQL first.', 503, rid); }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/banners/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      try { await env.DB.prepare('DELETE FROM banners WHERE id=?').bind(id).run(); } catch { /* table gone */ }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/banners/reorder': {
      const id = Number(body.id);
      const dir = String(body.dir) === 'up' ? 'up' : 'down';
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      let ordered: { id: number }[];
      try {
        const r = await env.DB.prepare('SELECT id FROM banners ORDER BY sort_order ASC, id ASC').all<{ id: number }>();
        ordered = r.results || [];
      } catch { return fail('NEEDS_MIGRATION', 'Banners table is not set up yet.', 409, rid); }
      const idx = ordered.findIndex((p) => p.id === id);
      if (idx < 0) return fail('NOT_FOUND', 'Banner not found.', 404, rid);
      const swapWith = dir === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= ordered.length) return json({ ok: true }, 200, rid);
      const tmp = ordered[idx]; ordered[idx] = ordered[swapWith]; ordered[swapWith] = tmp;
      await env.DB.batch(ordered.map((p, i) =>
        env.DB.prepare('UPDATE banners SET sort_order = ? WHERE id = ?').bind(i, p.id),
      ));
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/rtp/games': {
      const pid = Number(body.platform_id);
      if (!pid) return fail('BAD_REQUEST', 'platform_id is required.', 400, rid);
      try {
        const r = await env.DB.prepare('SELECT id, name, image_url, rtp, sort_order, active FROM rtp_games WHERE platform_id=? ORDER BY sort_order ASC, id ASC').bind(pid).all();
        return json({ ok: true, games: r.results || [] }, 200, rid);
      } catch { return json({ ok: true, games: [], needs_migration: true }, 200, rid); }
    }

    case '/api/admin/rtp/game/save': {
      const id = Number(body.id) || 0;
      const pid = Number(body.platform_id) || 0;
      const name = String(body.name || '').trim().slice(0, 120);
      const img = String(body.image_url || '').trim().slice(0, 300);
      const rtp = Math.max(0, Math.min(100, Number(body.rtp) || 0));
      const active = Number(body.active) ? 1 : 0;
      if (img && !isRtpImage(img)) return fail('BAD_IMAGE', 'Bad game image.', 400, rid);
      try {
        if (id) {
          await env.DB.prepare('UPDATE rtp_games SET name=?, image_url=?, rtp=?, active=? WHERE id=?').bind(name, img || null, rtp, active, id).run();
        } else {
          if (!pid || !name) return fail('BAD_REQUEST', 'platform and name are required.', 400, rid);
          const m = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM rtp_games WHERE platform_id=?').bind(pid).first<{ n: number }>();
          await env.DB.prepare('INSERT INTO rtp_games (platform_id,name,image_url,rtp,sort_order,active) VALUES (?,?,?,?,?,?)').bind(pid, name, img || null, rtp, m?.n || 1, active).run();
        }
      } catch { return fail('NEEDS_MIGRATION', 'Run migration 23 first.', 503, rid); }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/rtp/game/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      try { await env.DB.prepare('DELETE FROM rtp_games WHERE id=?').bind(id).run(); } catch { /* gone */ }
      return json({ ok: true }, 200, rid);
    }

    // Bulk-add games by pasting a list of names (one per line), kept in order.
    case '/api/admin/rtp/bulk-add': {
      const pid = Number(body.platform_id) || 0;
      if (!pid) return fail('BAD_REQUEST', 'platform_id is required.', 400, rid);
      const names = String(body.names || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2000);
      if (!names.length) return fail('BAD_REQUEST', 'Paste at least one game name.', 400, rid);
      try {
        const m = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) AS n FROM rtp_games WHERE platform_id=?').bind(pid).first<{ n: number }>();
        let so = m?.n || 0;
        const stmts = names.map((nm) => {
          so++;
          return env.DB.prepare('INSERT INTO rtp_games (platform_id,name,rtp,sort_order,active) VALUES (?,?,?,?,1)').bind(pid, nm.slice(0, 120), 0, so);
        });
        await env.DB.batch(stmts);
      } catch { return fail('NEEDS_MIGRATION', 'Run migration 23 first.', 503, rid); }
      return json({ ok: true, added: names.length }, 200, rid);
    }

    // Bulk-import games WITH icons in one shot. Each line pairs a name with its
    // icon file: "Game Name <TAB> file.webp". Name + icon are read from the same
    // line together, so they can never get mixed up. Icons must already be in
    // /public/gameicons/<folder>/. Games are appended in the pasted order.
    case '/api/admin/rtp/bulk-import': {
      const pid = Number(body.platform_id) || 0;
      if (!pid) return fail('BAD_REQUEST', 'platform_id is required.', 400, rid);
      const folder = String(body.folder || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,40}$/.test(folder)) return fail('BAD_REQUEST', 'Folder must be simple letters/numbers (e.g. ace333).', 400, rid);
      const lines = String(body.text || '').split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.trim());
      if (!lines.length) return fail('BAD_REQUEST', 'Paste the name + icon list first.', 400, rid);
      const items: Array<{ name: string; url: string }> = [];
      const bad: string[] = [];
      for (const ln of lines) {
        const parts = ln.split('\t');
        const name = (parts[0] || '').trim().slice(0, 120);
        const file = (parts[1] || '').trim();
        if (!name || !file) { bad.push(ln.slice(0, 40)); continue; }
        const url = '/gameicons/' + folder + '/' + file;
        if (!isRtpImage(url)) { bad.push(name); continue; }
        items.push({ name, url });
      }
      if (!items.length) return fail('BAD_REQUEST', 'No valid rows found. Each line needs: Name [tab] file.webp', 400, rid);
      try {
        const m = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) AS n FROM rtp_games WHERE platform_id=?').bind(pid).first<{ n: number }>();
        let so = m?.n || 0;
        const stmts = items.map((it) => { so++; return env.DB.prepare('INSERT INTO rtp_games (platform_id,name,image_url,rtp,sort_order,active) VALUES (?,?,?,?,?,1)').bind(pid, it.name, it.url, 0, so); });
        for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      } catch { return fail('NEEDS_MIGRATION', 'Run migration 23 first.', 503, rid); }
      return json({ ok: true, added: items.length, skipped: bad.length, skipped_names: bad.slice(0, 20) }, 200, rid);
    }

    // The paste-a-column RTP update. Values line up top-to-bottom with the
    // platform's games in their fixed order. preview:true returns the mapping
    // without saving; without it, the RTP values are written.
    case '/api/admin/rtp/paste': {
      const pid = Number(body.platform_id) || 0;
      if (!pid) return fail('BAD_REQUEST', 'platform_id is required.', 400, rid);
      let vals: number[];
      if (Array.isArray(body.values)) vals = body.values.map((v: unknown) => Number(v));
      else vals = String(body.text || '').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => Number(s.replace('%', '').trim()));
      vals = vals.filter((v) => !Number.isNaN(v));
      if (!vals.length) return fail('BAD_REQUEST', 'No RTP numbers were found in what you pasted.', 400, rid);
      let games: Array<{ id: number; name: string }>;
      try {
        const r = await env.DB.prepare('SELECT id, name FROM rtp_games WHERE platform_id=? ORDER BY sort_order ASC, id ASC').bind(pid).all<{ id: number; name: string }>();
        games = r.results || [];
      } catch { return fail('NEEDS_MIGRATION', 'Run migration 23 first.', 503, rid); }
      const n = Math.min(vals.length, games.length);
      const rows: Array<{ game: string | null; rtp: number | null }> = [];
      const total = Math.max(vals.length, games.length);
      for (let i = 0; i < total; i++) {
        rows.push({ game: games[i] ? games[i].name : null, rtp: i < vals.length ? vals[i] : null });
      }
      const preview = !!body.preview;
      let applied = 0;
      if (!preview) {
        const stmts = [];
        for (let i = 0; i < n; i++) {
          const rtp = Math.max(0, Math.min(100, vals[i]));
          stmts.push(env.DB.prepare('UPDATE rtp_games SET rtp=? WHERE id=?').bind(rtp, games[i].id));
        }
        if (stmts.length) await env.DB.batch(stmts);
        applied = n;
      }
      return json({
        ok: true, matched: n, pasted: vals.length, games: games.length,
        mismatch: vals.length !== games.length, applied, preview: rows.slice(0, 600),
      }, 200, rid);
    }

    case '/api/admin/promos/unlocks': {
      // Per-player unlock panel: every GATED promo + this player's ticket state.
      const pid = Number(body.player_id);
      if (!pid) return fail('BAD_REQUEST', 'player_id is required.', 400, rid);
      const uToday = sgtDateKey();
      let uResults: unknown[] = [];
      try {
        uResults = (await env.DB.prepare(`SELECT p.id, p.title, p.points, p.limit_type, p.limit_count,
            (SELECT COUNT(*) FROM promo_unlocks u WHERE u.promo_id = p.id AND u.player_id = ?1 AND u.status = 'available') AS available,
            (SELECT COUNT(*) FROM promo_claims c WHERE c.promo_id = p.id AND c.player_id = ?1) AS claimed_total,
            (SELECT COUNT(*) FROM promo_claims c WHERE c.promo_id = p.id AND c.player_id = ?1 AND c.day_key = ?2) AS claimed_today
          FROM promos p WHERE p.access = 'gated' AND p.active = 1 ORDER BY p.id DESC`).bind(pid, uToday).all()).results || [];
      } catch {
        uResults = (await env.DB.prepare(`SELECT p.id, p.title, p.points,
            (SELECT COUNT(*) FROM promo_unlocks u WHERE u.promo_id = p.id AND u.player_id = ?1 AND u.status = 'available') AS available,
            (SELECT COUNT(*) FROM promo_claims c WHERE c.promo_id = p.id AND c.player_id = ?1) AS claimed_total
          FROM promos p WHERE p.access = 'gated' AND p.active = 1 ORDER BY p.id DESC`).bind(pid).all()).results || [];
      }
      return json({ ok: true, promos: uResults }, 200, rid);
    }

    case '/api/admin/promos/grant': {
      const pid = Number(body.player_id);
      const promoId = Number(body.promo_id);
      if (!pid || !promoId) return fail('BAD_REQUEST', 'player_id and promo_id are required.', 400, rid);
      const pr = await env.DB.prepare("SELECT id, limit_type, limit_count FROM promos WHERE id = ? AND access = 'gated' AND active = 1").bind(promoId).first<{ id: number; limit_type?: string; limit_count?: number }>()
        .catch(() => env.DB.prepare("SELECT id FROM promos WHERE id = ? AND access = 'gated' AND active = 1").bind(promoId).first<{ id: number; limit_type?: string; limit_count?: number }>());
      if (!pr) return fail('PROMO_NOT_FOUND', 'Promo not found (or it is public).', 404, rid);
      const target = await env.DB.prepare('SELECT id FROM players WHERE id = ?').bind(pid).first();
      if (!target) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);
      // Respect the promo's claim limit: a manual unlock can never push a player
      // past it. "Used" = claims in the period + tickets already waiting to claim.
      const lc = Number(pr.limit_count) || 0;
      if (lc > 0) {
        const isDay = pr.limit_type === 'day';
        const gToday = sgtDateKey();
        const claimedRow = isDay
          ? await env.DB.prepare('SELECT COUNT(*) AS c FROM promo_claims WHERE player_id = ? AND promo_id = ? AND day_key = ?').bind(pid, promoId, gToday).first<{ c: number }>()
          : await env.DB.prepare('SELECT COUNT(*) AS c FROM promo_claims WHERE player_id = ? AND promo_id = ?').bind(pid, promoId).first<{ c: number }>();
        const availRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM promo_unlocks WHERE player_id = ? AND promo_id = ? AND status = 'available'").bind(pid, promoId).first<{ c: number }>();
        const used = (claimedRow?.c ?? 0) + (availRow?.c ?? 0);
        if (used >= lc) {
          return fail('LIMIT_REACHED', isDay
            ? 'This player has already reached this promo’s daily limit (unlocked or claimed). Try again tomorrow.'
            : 'This player has reached this promo’s total claim limit.', 409, rid);
        }
      }
      await env.DB.prepare('INSERT INTO promo_unlocks (promo_id, player_id, granted_by) VALUES (?, ?, ?)').bind(promoId, pid, admin).run();
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/promos/revoke': {
      // Takes back ONE unclaimed ticket (claimed ones are history, never touched).
      const pid = Number(body.player_id);
      const promoId = Number(body.promo_id);
      if (!pid || !promoId) return fail('BAD_REQUEST', 'player_id and promo_id are required.', 400, rid);
      const r = await env.DB.prepare(
        "UPDATE promo_unlocks SET status = 'revoked' WHERE id = (SELECT id FROM promo_unlocks WHERE player_id = ? AND promo_id = ? AND status = 'available' ORDER BY id DESC LIMIT 1) RETURNING id",
      ).bind(pid, promoId).first();
      if (!r) return fail('NONE_AVAILABLE', 'No unclaimed unlock to revoke.', 404, rid);
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/chat/threads': {
      const q = String(body.q || '').trim();
      const offset = Math.max(0, Number(body.offset) || 0);
      const like = `%${q.toLowerCase()}%`;
      const buildSql = (tagCol: boolean) => `SELECT cs.player_id, cs.last_msg_at, cs.admin_unread, p.username, p.display_name${tagCol ? ', p.tag' : ''},
          (SELECT COALESCE(m.body, '[image]') FROM chat_messages m WHERE m.player_id = cs.player_id ORDER BY m.id DESC LIMIT 1) AS last_body
        FROM chat_state cs LEFT JOIN players p ON p.id = cs.player_id WHERE 1=1${q ? ' AND (lower(p.username) LIKE ? OR lower(p.display_name) LIKE ?)' : ''} ORDER BY cs.last_msg_at DESC LIMIT 50 OFFSET ?`;
      const binds: unknown[] = q ? [like, like, offset] : [offset];
      let results: unknown[] | undefined;
      try {
        ({ results } = await env.DB.prepare(buildSql(true)).bind(...binds).all());
      } catch {
        ({ results } = await env.DB.prepare(buildSql(false)).bind(...binds).all());
      }
      const unread = await env.DB.prepare('SELECT COALESCE(SUM(admin_unread), 0) AS s FROM chat_state').first<{ s: number }>();
      return json({ ok: true, threads: results || [], unread_total: unread?.s ?? 0 }, 200, rid);
    }

    case '/api/admin/chat/list': {
      const pid = Number(body.player_id);
      if (!pid) return fail('BAD_REQUEST', 'player_id is required.', 400, rid);
      const afterId = Number(body.after_id) || 0;
      let messages: any[] = [];
      let deletedIds: number[] = [];
      try {
        if (afterId > 0) {
          const r = await env.DB.prepare('SELECT id, sender, admin_username, body, image_url, is_html, created_at FROM chat_messages WHERE player_id = ? AND id > ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 100').bind(pid, afterId).all();
          messages = r.results || [];
        } else {
          const r = await env.DB.prepare('SELECT id, sender, admin_username, body, image_url, is_html, created_at FROM chat_messages WHERE player_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 50').bind(pid).all();
          messages = (r.results || []).reverse();
        }
        const d = await env.DB.prepare("SELECT id FROM chat_messages WHERE player_id = ? AND deleted_at IS NOT NULL AND deleted_at > datetime('now','-1 day')").bind(pid).all<{ id: number }>();
        deletedIds = (d.results || []).map((x) => x.id);
      } catch {
        if (afterId > 0) {
          const r = await env.DB.prepare('SELECT id, sender, admin_username, body, image_url, created_at FROM chat_messages WHERE player_id = ? AND id > ? ORDER BY id ASC LIMIT 100').bind(pid, afterId).all();
          messages = r.results || [];
        } else {
          const r = await env.DB.prepare('SELECT id, sender, admin_username, body, image_url, created_at FROM chat_messages WHERE player_id = ? ORDER BY id DESC LIMIT 50').bind(pid).all();
          messages = (r.results || []).reverse();
        }
      }
      await env.DB.prepare('UPDATE chat_state SET admin_unread = 0 WHERE player_id = ?').bind(pid).run();
      return json({ ok: true, messages, deleted_ids: deletedIds }, 200, rid);
    }

    // Soft-delete a chat message (staff un-send a wrong reply). Hidden from both
    // sides; recently-deleted ids flow through chat/list for live removal.
    case '/api/admin/chat/delete': {
      const mid = Number(body.message_id);
      if (!mid) return fail('BAD_REQUEST', 'message_id is required.', 400, rid);
      try {
        await env.DB.prepare("UPDATE chat_messages SET deleted_at = datetime('now') WHERE id = ?").bind(mid).run();
      } catch {
        return fail('NEEDS_MIGRATION', 'This feature needs migration 15 (the deleted_at column). Run it first.', 503, rid);
      }
      return json({ ok: true }, 200, rid);
    }

    // ---- Chat message templates (manager edits; any staff can send) ----
    case '/api/admin/templates/list': {
      await ensureAutoTemplates(env);
      try {
        const r = await env.DB.prepare("SELECT id, name, content, trigger_key, sort_order FROM chat_templates ORDER BY (trigger_key != '') DESC, sort_order ASC, id ASC").all();
        return json({ ok: true, templates: r.results || [] }, 200, rid);
      } catch {
        // trigger_key column not migrated yet — fall back without it.
        try {
          const r = await env.DB.prepare('SELECT id, name, content, sort_order FROM chat_templates ORDER BY sort_order ASC, id ASC').all();
          return json({ ok: true, templates: r.results || [] }, 200, rid);
        } catch {
          return json({ ok: true, templates: [], needs_migration: true }, 200, rid);
        }
      }
    }

    case '/api/admin/templates/save': {
      const id = Number(body.id) || 0;
      const name = String(body.name || '').trim().slice(0, 80);
      const content = String(body.content || '').slice(0, 150000);
      if (!name) return fail('BAD_REQUEST', 'A template name is required.', 400, rid);
      if (!content.trim()) return fail('BAD_REQUEST', 'Template content is empty.', 400, rid);
      try {
        if (id) {
          await env.DB.prepare("UPDATE chat_templates SET name = ?, content = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(name, content, admin, id).run();
        } else {
          await env.DB.prepare("INSERT INTO chat_templates (name, content, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)").bind(name, content, admin).run();
        }
      } catch {
        return fail('NEEDS_MIGRATION', 'Run migration 16 (the chat_templates table) first.', 503, rid);
      }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/templates/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      try {
        const t = await env.DB.prepare('SELECT trigger_key FROM chat_templates WHERE id = ?').bind(id).first<{ trigger_key: string }>();
        if (t && t.trigger_key) return fail('AUTO_TEMPLATE', 'Automatic messages cannot be deleted — you can only edit their wording.', 400, rid);
        await env.DB.prepare('DELETE FROM chat_templates WHERE id = ?').bind(id).run();
      } catch { /* table gone */ }
      return json({ ok: true }, 200, rid);
    }

    // Staff click a template -> fill in the player's data -> send it (rich).
    case '/api/admin/chat/send-template': {
      const pid = Number(body.player_id);
      const tid = Number(body.template_id);
      if (!pid || !tid) return fail('BAD_REQUEST', 'player_id and template_id are required.', 400, rid);
      const target = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(pid).first<PlayerRow>();
      if (!target) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);
      let tpl: { content: string } | null;
      try { tpl = await env.DB.prepare('SELECT content FROM chat_templates WHERE id = ?').bind(tid).first<{ content: string }>(); }
      catch { return fail('NEEDS_MIGRATION', 'Run migration 16 first.', 503, rid); }
      if (!tpl) return fail('NOT_FOUND', 'Template not found.', 404, rid);
      const rendered = await renderChatTemplate(env, tpl.content, target);
      let ins;
      try {
        ins = await env.DB.prepare('INSERT INTO chat_messages (player_id, sender, admin_username, body, is_html) VALUES (?, ?, ?, ?, 1)').bind(pid, 'admin', admin, rendered).run();
      } catch {
        // is_html column not migrated — still send, just unstyled.
        ins = await env.DB.prepare('INSERT INTO chat_messages (player_id, sender, admin_username, body) VALUES (?, ?, ?, ?)').bind(pid, 'admin', admin, rendered).run();
      }
      await env.DB.prepare(
        'INSERT INTO chat_state (player_id, last_msg_at, admin_unread, player_unread) VALUES (?, datetime(\'now\'), 0, 1) ' +
        'ON CONFLICT(player_id) DO UPDATE SET last_msg_at = datetime(\'now\'), player_unread = player_unread + 1',
      ).bind(pid).run();
      try { await pushToPlayer(env, pid, { title: 'LE888 Support', body: 'You have a new message.' }, { title: 'LE888 客服', body: '你有一条新消息。' }); } catch { /* best-effort */ }
      return json({ ok: true, id: ins.meta.last_row_id }, 200, rid);
    }

    case '/api/admin/chat/send': {
      const pid = Number(body.player_id);
      const text = String(body.body || '').trim().slice(0, 1000);
      const imageUrl = String(body.image_url || '').trim();
      if (imageUrl && !/^\/api\/chat\/img\/[a-z0-9]{20,64}\.(webp|jpg|png)$/.test(imageUrl)) return fail('BAD_REQUEST', 'Invalid image.', 400, rid);
      if (!pid || (!text && !imageUrl)) return fail('BAD_REQUEST', 'player_id and a message or image are required.', 400, rid);
      const target = await env.DB.prepare('SELECT id FROM players WHERE id = ?').bind(pid).first();
      if (!target) return fail('PLAYER_NOT_FOUND', 'Player not found.', 404, rid);
      const ins = await env.DB.prepare('INSERT INTO chat_messages (player_id, sender, admin_username, body, image_url) VALUES (?, ?, ?, ?, ?)').bind(pid, 'admin', admin, text || null, imageUrl || null).run();
      await env.DB.prepare(
        'INSERT INTO chat_state (player_id, last_msg_at, admin_unread, player_unread) VALUES (?, datetime(\'now\'), 0, 1) ' +
        'ON CONFLICT(player_id) DO UPDATE SET last_msg_at = datetime(\'now\'), player_unread = player_unread + 1',
      ).bind(pid).run();
      // Best-effort push so the player sees the reply even with the app closed.
      try {
        const preview = text ? (text.length > 80 ? text.slice(0, 77) + '...' : text) : '\ud83d\udcf7 Image';
        await pushToPlayer(env, pid,
          { title: 'LE888 Support', body: preview },
          { title: 'LE888 \u5ba2\u670d', body: preview });
      } catch { /* best-effort */ }
      return json({ ok: true, id: ins.meta.last_row_id }, 200, rid);
    }

    case '/api/admin/push/broadcast': {
      if (!(await rateLimit(env, `broadcast:${admin}`, 5, 3600))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      const message = String(body.message || '').trim().slice(0, 300);
      const messageZh = String(body.message_zh || '').trim().slice(0, 300);
      if (!message) return fail('BAD_REQUEST', 'A message is required.', 400, rid);
      const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth, lang FROM push_subs').all();
      let sent = 0;
      for (const s of (results || []) as any[]) {
        const text = s.lang === 'zh' && messageZh ? messageZh : message;
        const status = await sendWebPush(env, s, JSON.stringify({ title: 'LE888', body: text }));
        if (status >= 200 && status < 300) sent++;
        else if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(s.id).run();
      }
      return json({ ok: true, sent, total: (results || []).length }, 200, rid);
    }

    // ---- Backup domains -----------------------------------------------------
    // A short list of web addresses the app can live on. If the primary one is
    // blocked, staff switch a spare to primary and broadcast it to players.
    case '/api/admin/domains/list': {
      try {
        const { results } = await env.DB.prepare('SELECT id, url, label, is_primary, created_at FROM app_domains ORDER BY is_primary DESC, id ASC').all();
        return json({ ok: true, domains: results || [] }, 200, rid);
      } catch { return json({ ok: true, domains: [], needs_migration: true }, 200, rid); }
    }

    case '/api/admin/domains/save': {
      // Manager only (setup). Accepts https://host[/path]. Trailing slash trimmed.
      let url = String(body.url || '').trim();
      const label = String(body.label || '').trim().slice(0, 60);
      const id = Number(body.id) || 0;
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;   // be forgiving
      url = url.replace(/\/+$/, '').slice(0, 200);
      if (!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(\/[\w\-./?%&=+#]*)?$/i.test(url)) {
        return fail('BAD_URL', 'Enter a full web address, e.g. https://backup.tr666app.com', 400, rid);
      }
      try {
        if (id) {
          await env.DB.prepare('UPDATE app_domains SET url = ?, label = ?, updated_by = ? WHERE id = ?').bind(url, label || null, admin, id).run();
        } else {
          await env.DB.prepare('INSERT INTO app_domains (url, label, is_primary, updated_by) VALUES (?, ?, 0, ?)').bind(url, label || null, admin).run();
        }
        return json({ ok: true }, 200, rid);
      } catch (e) {
        if (/UNIQUE/i.test(String((e as any)?.message || e))) return fail('DUP_URL', 'That web address is already in the list.', 409, rid);
        return fail('NEEDS_MIGRATION', 'Backup domains are being set up. Please try again later.', 503, rid);
      }
    }

    case '/api/admin/domains/delete': {
      const id = Number(body.id) || 0;
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      try { await env.DB.prepare('DELETE FROM app_domains WHERE id = ?').bind(id).run(); } catch { /* ignore */ }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/domains/set-primary': {
      // Staff-allowed: the emergency switch. Exactly one row ends up primary.
      const id = Number(body.id) || 0;
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      try {
        const row = await env.DB.prepare('SELECT id FROM app_domains WHERE id = ?').bind(id).first();
        if (!row) return fail('NOT_FOUND', 'That domain is no longer in the list.', 404, rid);
        await env.DB.prepare('UPDATE app_domains SET is_primary = 0').run();
        await env.DB.prepare('UPDATE app_domains SET is_primary = 1 WHERE id = ?').bind(id).run();
        return json({ ok: true }, 200, rid);
      } catch { return fail('NEEDS_MIGRATION', 'Backup domains are being set up. Please try again later.', 503, rid); }
    }

    case '/api/admin/domains/broadcast': {
      // Staff-allowed. Buzzes every player's phone with the new login link.
      // The tap opens the link even if the old domain is blocked (the push
      // travels through Google/Apple, not through your domain).
      if (!(await rateLimit(env, `dombc:${admin}`, 5, 3600))) return fail('RATE_LIMITED', 'Please wait a bit before sending another broadcast.', 429, rid);
      let url = String(body.url || '').trim();
      if (!url) {
        try { const p = await env.DB.prepare('SELECT url FROM app_domains WHERE is_primary = 1 LIMIT 1').first<{ url: string }>(); url = p?.url || ''; } catch { /* ignore */ }
      }
      url = url.replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(url)) {
        return fail('NO_PRIMARY', 'Set a primary domain first, then broadcast.', 400, rid);
      }
      const bodyEn = 'Our login link has changed. Tap to open: ' + url;
      const bodyZh = '我们的登录网址已更改。点击打开：' + url;   // 我们的登录网址已更改。点击打开：
      const payloadEn = JSON.stringify({ title: 'LE888 — New link', body: bodyEn, url, kind: 'domain' });
      const payloadZh = JSON.stringify({ title: 'LE888 — 新网址', body: bodyZh, url, kind: 'domain' });   // 新网址
      let sent = 0, total = 0;
      try {
        const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth, lang FROM push_subs').all();
        total = (results || []).length;
        for (const s of (results || []) as any[]) {
          const status = await sendWebPush(env, s, s.lang === 'zh' ? payloadZh : payloadEn);
          if (status >= 200 && status < 300) sent++;
          else if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(s.id).run();
        }
      } catch { /* best-effort */ }
      return json({ ok: true, sent, total, url }, 200, rid);
    }

    case '/api/admin/deposits/requests': {
      await ensureDepositSubmissionsTable(env);
      const status = String(body.status || 'pending');
      const sql = 'SELECT s.id, s.player_id, s.amount, s.method, s.receipt_url, s.reference, s.status, s.admin_username, s.admin_note, s.created_at, s.decided_at, p.username, p.display_name FROM deposit_submissions s LEFT JOIN players p ON p.id = s.player_id';
      const r = status === 'all'
        ? await env.DB.prepare(sql + " ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, s.id DESC LIMIT 150").all()
        : await env.DB.prepare(sql + ' WHERE s.status = ? ORDER BY s.id DESC LIMIT 150').bind(status).all();
      const pending = await env.DB.prepare("SELECT COUNT(*) AS c FROM deposit_submissions WHERE status = 'pending'").first<{ c: number }>();
      return json({ ok: true, requests: r.results || [], pending: pending?.c ?? 0 }, 200, rid);
    }

    case '/api/admin/deposits/decide': {
      const id = Number(body.id);
      const action = String(body.action || '');
      const note = String(body.note || '').trim().slice(0, 300);
      if (!id || (action !== 'approve' && action !== 'reject')) return fail('BAD_REQUEST', 'A request id and an action (approve/reject) are required.', 400, rid);
      await ensureDepositSubmissionsTable(env);
      const sub = await env.DB.prepare('SELECT id, player_id, amount, status FROM deposit_submissions WHERE id = ?').bind(id).first<{ id: number; player_id: number; amount: number; status: string }>();
      if (!sub) return fail('NOT_FOUND', 'Request not found.', 404, rid);
      if (sub.status !== 'pending') return fail('ALREADY_DECIDED', 'This request was already ' + sub.status + '.', 409, rid);
      // Claim it first (status guard) so two staff cannot approve the same request.
      const upd = await env.DB.prepare("UPDATE deposit_submissions SET status = ?, admin_username = ?, admin_note = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .bind(action === 'approve' ? 'approved' : 'rejected', admin, note || null, id).run();
      if (upd.meta.changes === 0) return fail('ALREADY_DECIDED', 'This request was already decided.', 409, rid);
      if (action === 'approve') {
        // Staff may correct the amount to what actually arrived.
        const amount = Number(body.amount) > 0 ? Number(body.amount) : Number(sub.amount);
        const res = await recordDeposit(env, sub.player_id, amount, note || ('App deposit request #' + id), 'DEP-' + id, admin);
        if (!res.ok) {
          await env.DB.prepare("UPDATE deposit_submissions SET status = 'pending', admin_username = NULL, admin_note = NULL, decided_at = NULL WHERE id = ?").bind(id).run();
          return fail(res.code, res.msg, res.status, rid);
        }
        if (amount !== Number(sub.amount)) { try { await env.DB.prepare('UPDATE deposit_submissions SET amount = ? WHERE id = ?').bind(amount, id).run(); } catch { /* ignore */ } }
        return json({ ok: true, deposit_total: res.deposit_total, rank_name: res.rank_name, deposit_points_granted: res.deposit_points_granted, upgrade_points_granted: res.upgrade_points_granted }, 200, rid);
      }
      try { await sendAutoMessage(env, sub.player_id, 'deposit_rejected', { deposit_amount: String(sub.amount), reason: note || 'receipt could not be verified' }); } catch { /* best-effort */ }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/deposits/all': {
      // Full deposit history across all players, with search + date range.
      // Also serves the CSV export (higher limit allowed, read-only).
      const q = String(body.q || '').trim();
      const from = String(body.from || '').trim();
      const to = String(body.to || '').trim();
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(isManager ? 1000 : 100, Math.max(1, Number(body.limit) || 50));
      let sql = `SELECT d.id, d.player_id, d.amount, d.month_key, d.note, d.admin_username, d.created_at, p.username, p.display_name
        FROM deposits d LEFT JOIN players p ON p.id = d.player_id WHERE 1=1`;
      const binds: unknown[] = [];
      if (q) { sql += ' AND (lower(p.username) LIKE ? OR lower(p.display_name) LIKE ? OR CAST(d.player_id AS TEXT) LIKE ?)'; const like = `%${q.toLowerCase()}%`; binds.push(like, like, like); }
      if (from) { sql += ' AND d.created_at >= ?'; binds.push(sgtDayStartUtc(from)); }
      if (to) { sql += ' AND d.created_at <= ?'; binds.push(sgtDayEndUtc(to)); }
      sql += ' ORDER BY d.id DESC LIMIT ? OFFSET ?';
      binds.push(limit, offset);
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return json({ ok: true, deposits: results || [], offset, limit }, 200, rid);
    }

    case '/api/admin/withdrawals': {
      const status = String(body.status || 'pending').trim();
      const q = String(body.q || '').trim();
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));
      try {
        let sql = 'SELECT w.*, p.username, p.display_name FROM withdrawals w LEFT JOIN players p ON p.id = w.player_id WHERE 1=1';
        const binds: unknown[] = [];
        if (status && status !== 'all') { sql += ' AND w.status = ?'; binds.push(status); }
        if (q) { sql += ' AND (lower(p.username) LIKE ? OR CAST(w.player_id AS TEXT) LIKE ?)'; const like = `%${q.toLowerCase()}%`; binds.push(like, like); }
        sql += ' ORDER BY w.id DESC LIMIT ? OFFSET ?';
        binds.push(limit, offset);
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        const pending = await env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE status = 'pending'").first<{ c: number; s: number }>();
        return json({ ok: true, withdrawals: results || [], pending_count: pending?.c ?? 0, pending_cents: pending?.s ?? 0, offset, limit }, 200, rid);
      } catch { return json({ ok: true, withdrawals: [], pending_count: 0, pending_cents: 0, needs_migration: true }, 200, rid); }
    }

    case '/api/admin/withdrawal/decide': {
      if (!(await rateLimit(env, `wdecide:${admin}`, 60, 60))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      const id = Number(body.id);
      const decision = String(body.decision || '');
      const note = String(body.note || '').trim().slice(0, 300);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      if (!['approved', 'rejected'].includes(decision)) return fail('BAD_DECISION', "decision must be 'approved' or 'rejected'.", 400, rid);
      // Optional receipt image (only our own R2 image route is accepted).
      const rawReceipt = String(body.receipt_url || '').trim();
      const receiptUrl = /^\/api\/chat\/img\/[a-z0-9-]{20,64}\.(webp|jpg|png)$/.test(rawReceipt) ? rawReceipt : null;
      // Request-only: no balance moves. Guarded on status='pending' — first decider wins.
      // We also grab source_payout_id so we mark the EXACT credit that was
      // withdrawn as used — not just the latest one. Older rows (before that
      // column existed) throw here, so we retry without it and fall back.
      let decided = await env.DB.prepare(
        "UPDATE withdrawals SET status = ?, decided_at = datetime('now'), decided_by = ?, note = ? WHERE id = ? AND status = 'pending' RETURNING player_id, amount_cents, source_type, source_payout_id",
      ).bind(decision, admin, note || null, id).first<{ player_id: number; amount_cents: number; source_type: string | null; source_payout_id: number | null }>().catch(() => 'NO_COL' as const);
      if (decided === 'NO_COL') {
        decided = await env.DB.prepare(
          "UPDATE withdrawals SET status = ?, decided_at = datetime('now'), decided_by = ? , note = ? WHERE id = ? AND status = 'pending' RETURNING player_id, amount_cents, source_type",
        ).bind(decision, admin, note || null, id).first<{ player_id: number; amount_cents: number; source_type: string | null; source_payout_id: number | null }>();
      }
      if (!decided) return fail('ALREADY_DECIDED', 'This request was already decided.', 409, rid);
      const amt = (decided.amount_cents / 100).toFixed(2);
      // An APPROVED free-credit withdrawal uses that free credit up, so the same
      // one can never be withdrawn twice. A REJECTED one leaves it available, so
      // a staff mistake never costs the player their credit.
      if (decision === 'approved' && decided.source_type === 'free_credit') {
        try {
          // Mark the EXACT credit that was withdrawn as used. This is the fix:
          // with two open credits, the right one gets consumed and the other
          // stays available. Only very old rows (no source_payout_id) fall back
          // to "latest open credit", which matches the previous behaviour.
          const targetId = decided.source_payout_id || null;
          if (targetId) {
            await env.DB.prepare(
              "UPDATE payout_requests SET fc_status = 'used', fc_cleared_at = datetime('now'), fc_cleared_by = ? WHERE id = ? AND (fc_status IS NULL OR fc_status != 'used')",
            ).bind(admin, targetId).run();
          } else {
            const fc = await getOpenFreeCredit(env, decided.player_id);
            if (fc) {
              await env.DB.prepare(
                "UPDATE payout_requests SET fc_status = 'used', fc_cleared_at = datetime('now'), fc_cleared_by = ? WHERE id = ? AND (fc_status IS NULL OR fc_status != 'used')",
              ).bind(admin, fc.id).run();
            }
          }
        } catch { /* columns not migrated yet */ }
      }
      if (decision === 'approved') {
        // "Withdrawal approved" message (wording editable in the Templates tab).
        // Any receipt image staff attached rides along with it.
        try { await sendAutoMessage(env, decided.player_id, 'withdrawal_approved', { amount: String(amt) }, receiptUrl); } catch { /* best-effort */ }
      } else {
        try { await sendAutoMessage(env, decided.player_id, 'withdrawal_rejected', { amount: String(amt) }); } catch { /* best-effort */ }
      }
      try {
        if (decision === 'approved') {
          await pushToPlayer(env, decided.player_id, { title: 'Withdrawal approved 🎉', body: `Your withdrawal of SGD ${amt} has been approved.` }, { title: '提款已批准 🎉', body: `你的 SGD ${amt} 提款已批准。` });
        } else {
          await pushToPlayer(env, decided.player_id, { title: 'Withdrawal update', body: `Your withdrawal request of SGD ${amt} was rejected.` }, { title: '提款更新', body: `你的 SGD ${amt} 提款申请被拒绝。` });
        }
      } catch { /* push best-effort */ }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/payouts': {
      const status = String(body.status || 'pending').trim();
      const q = String(body.q || '').trim();
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));
      let sql = `SELECT pr.*, p.username, p.display_name FROM payout_requests pr LEFT JOIN players p ON p.id = pr.player_id WHERE 1=1`;
      const binds: unknown[] = [];
      if (status && status !== 'all') { sql += ' AND pr.status = ?'; binds.push(status); }
      else { sql += " AND pr.status != 'cancelled'"; }
      // A pending request is held from staff for its first 10 seconds so the
      // player can still cancel it; only surface pending rows past that window.
      sql += " AND (pr.status != 'pending' OR pr.created_at <= datetime('now', '-10 seconds'))";
      if (q) { sql += ' AND (lower(p.username) LIKE ? OR CAST(pr.player_id AS TEXT) LIKE ?)'; const like = `%${q.toLowerCase()}%`; binds.push(like, like); }
      sql += ' ORDER BY pr.id DESC LIMIT ? OFFSET ?';
      binds.push(limit, offset);
      const { results } = await env.DB.prepare(sql).bind(...binds).all();

      // For each pending request, attach the player's PREVIOUS approved reward
      // — the account staff must go and check for leftover credit before
      // approving another one.
      const rows = (results || []) as any[];
      for (const r of rows) {
        try {
          const prev = await env.DB.prepare(
            "SELECT game, game_id, amount_cents, decided_at FROM payout_requests WHERE player_id = ? AND status = 'approved' AND id != ? ORDER BY id DESC LIMIT 1",
          ).bind(r.player_id, r.id).first<{ game: string; game_id: string; amount_cents: number; decided_at: string }>();
          r.last_reward = prev
            ? { game: prev.game, game_id: prev.game_id, amount: centsToStr(prev.amount_cents), decided_at: prev.decided_at }
            : null;
        } catch { r.last_reward = null; }
      }

      const pending = await env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS s FROM payout_requests WHERE status = 'pending' AND created_at <= datetime('now', '-10 seconds')").first<{ c: number; s: number }>();
      return json({ ok: true, payouts: rows, pending_count: pending?.c ?? 0, pending_cents: pending?.s ?? 0, offset, limit }, 200, rid);
    }

    case '/api/admin/payout/decide': {
      if (!(await rateLimit(env, `decide:${admin}`, 60, 60))) return fail('RATE_LIMITED', 'Please slow down.', 429, rid);
      const id = Number(body.id);
      const decision = String(body.decision || '');
      const note = String(body.note || '').trim().slice(0, 300);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      if (!['approved', 'rejected'].includes(decision)) return fail('BAD_DECISION', "decision must be 'approved' or 'rejected'.", 400, rid);

      // Approvals must record WHERE the payout was credited: the game
      // platform (fixed list) and the player's Game ID on that platform.
      // Free credit only ever goes to a free-credit game. Same list the player
      // picks from, so the two can never drift apart.
      const FREE_GAME_LABELS = FREE_PLATFORMS.map((k) => GAME_PLATFORM_LABELS[k]);
      const game = String(body.game || '').trim();
      const gameId = String(body.game_id || '').trim().slice(0, 64);

      if (decision === 'approved') {
        if (!FREE_GAME_LABELS.includes(game)) return fail('BAD_GAME', 'Free credit can only go to Pussy888 or Mega888.', 400, rid);
        if (!gameId) return fail('GAME_ID_REQUIRED', 'Enter the player’s Game ID.', 400, rid);
      }

      let decided: { player_id: number; amount_cents: number } | null;
      if (decision === 'approved') {
        const owner = await env.DB.prepare("SELECT player_id, amount_cents FROM payout_requests WHERE id = ? AND status = 'pending'").bind(id).first<{ player_id: number; amount_cents: number }>();
        if (!owner) return fail('ALREADY_DECIDED', 'This request was already decided by someone else.', 409, rid);

        // If this payout IS the player's VIP credit, its terms were set by
        // staff when it was given — use those, not the auto brackets.
        const mcOwner = await getManualCredit(env, owner.player_id);
        const isManualCredit = !!mcOwner && mcOwner.mc_status === 'pending_approval' && mcOwner.mc_payout_id === id;

        // Lock the rule in at approval time. Editing the rules later must never
        // change terms a player was already given.
        let terms: { winover: number; hit_cents: number; cap_cents: number };
        if (isManualCredit) {
          const w = mcOwner!.mc_winover ?? 0;
          const cap = mcOwner!.mc_cap_cents ?? 0;
          terms = { winover: w, hit_cents: Math.round(owner.amount_cents * w), cap_cents: cap };
        } else {
          const rule = await freeCreditRule(env, owner.amount_cents);
          terms = freeCreditTerms(rule, owner.amount_cents);
        }

        // Approval moves no balance (credits were already deducted at submit),
        // so a single guarded update is fully atomic. First decider wins.
        try {
          decided = await env.DB.prepare(
            "UPDATE payout_requests SET status = 'approved', decided_at = datetime('now'), admin_username = ?, decision_note = ?, game = ?, game_id = ?, fc_status = 'open', fc_winover_x = ?, fc_hit_cents = ?, fc_cap_cents = ? WHERE id = ? AND status = 'pending' RETURNING player_id, amount_cents",
          ).bind(admin, note || null, game, gameId, terms.winover, terms.hit_cents, terms.cap_cents, id).first<{ player_id: number; amount_cents: number }>();
        } catch (e) {
          // Free-credit columns not migrated yet — approve without them.
          decided = await env.DB.prepare(
            "UPDATE payout_requests SET status = 'approved', decided_at = datetime('now'), admin_username = ?, decision_note = ?, game = ?, game_id = ? WHERE id = ? AND status = 'pending' RETURNING player_id, amount_cents",
          ).bind(admin, note || null, game, gameId, id).first<{ player_id: number; amount_cents: number }>();
        }
        if (!decided) return fail('ALREADY_DECIDED', 'This request was already decided by someone else.', 409, rid);
        // ONE free credit at a time. Crediting a new free credit means the
        // player's game IDs were reset to 0 first, so every EARLIER open free
        // credit is now dead money. Void them all so none can be withdrawn after
        // this new one. Only the just-approved credit (id) stays open.
        try {
          await env.DB.prepare(
            "UPDATE payout_requests SET fc_status = 'voided', fc_cleared_at = datetime('now'), fc_cleared_by = ? WHERE player_id = ? AND fc_status = 'open' AND id != ?",
          ).bind('auto:new-credit', decided.player_id, id).run();
        } catch { /* free-credit columns not migrated yet */ }
        // VIP credit approved -> clear its state so the player is fully unlocked.
        if (isManualCredit) {
          try {
            await env.DB.prepare(
              "UPDATE players SET mc_status = NULL, mc_amount_cents = 0, mc_winover = NULL, mc_cap_cents = NULL, mc_payout_id = NULL, updated_at = datetime('now') WHERE id = ?",
            ).bind(decided.player_id).run();
          } catch { /* mc_ columns not migrated */ }
        }
      } else {
        // REJECT: refund + status flip must be one transaction, so a crash can
        // never leave a rejected request unrefunded (or refund it twice).
        // Both statements are guarded on status='pending': the refund only
        // applies while still pending, and evaluates the amount from the same
        // row, so re-calling after it is already rejected refunds nothing.
        const res = await env.DB.batch([
          env.DB.prepare("UPDATE players SET reward_cents = reward_cents + (SELECT amount_cents FROM payout_requests WHERE id = ?1 AND status = 'pending'), updated_at = datetime('now') WHERE id = (SELECT player_id FROM payout_requests WHERE id = ?1 AND status = 'pending')").bind(id),
          env.DB.prepare("UPDATE payout_requests SET status = 'rejected', decided_at = datetime('now'), admin_username = ?2, decision_note = ?3 WHERE id = ?1 AND status = 'pending'").bind(id, admin, note || null),
        ]);
        if (!res[1] || (res[1].meta.changes || 0) === 0) return fail('ALREADY_DECIDED', 'This request was already decided by someone else.', 409, rid);
        decided = await env.DB.prepare('SELECT player_id, amount_cents FROM payout_requests WHERE id = ?').bind(id).first<{ player_id: number; amount_cents: number }>();
        if (!decided) return fail('ALREADY_DECIDED', 'This request was already decided.', 409, rid);
      }
      // Best-effort push to the player - never blocks or fails the decision.
      try {
        const amt = (decided.amount_cents / 100).toFixed(2);
        if (decision === 'approved') {
          await pushToPlayer(env, decided.player_id,
            { title: 'Reward approved', body: `Your reward of ${amt} has been credited to ${game} (${gameId}).` },
            { title: '\u5956\u52b1\u5df2\u6279\u51c6', body: `\u4f60\u7684 ${amt} \u5956\u52b1\u5df2\u53d1\u653e\u81f3 ${game}\uff08${gameId}\uff09\u3002` });
        } else {
          await pushToPlayer(env, decided.player_id,
            { title: 'Reward update', body: `Your reward request of ${amt} was rejected and returned to your reward balance.` },
            { title: '\u5956\u52b1\u66f4\u65b0', body: `\u4f60\u7684 ${amt} \u5956\u52b1\u7533\u8bf7\u88ab\u62d2\u7edd\uff0c\u91d1\u989d\u5df2\u9000\u56de\u5956\u52b1\u4f59\u989d\u3002` });
        }
      } catch { /* push is best-effort */ }
      // Auto-messages (wording editable in the Templates tab). Best-effort.
      if (decision === 'approved') {
        try { await sendAutoMessage(env, decided.player_id, 'free_credit_approved', {}); } catch { /* best-effort */ }
      } else {
        try { await sendAutoMessage(env, decided.player_id, 'reward_rejected', { amount: (decided.amount_cents / 100).toFixed(2) }); } catch { /* best-effort */ }
      }
      return json({ ok: true, decision }, 200, rid);
    }

    case '/api/admin/point-activity': {
      const q = String(body.q || '').trim();
      const from = String(body.from || '').trim();
      const to = String(body.to || '').trim();
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));
      let sql = `SELECT pa.*, p.username FROM point_activity pa LEFT JOIN players p ON p.id = pa.player_id WHERE 1=1`;
      const binds: unknown[] = [];
      const paPlayerId = Number(body.player_id) || 0;
      if (paPlayerId) { sql += ' AND pa.player_id = ?'; binds.push(paPlayerId); }
      if (q) { sql += ' AND (lower(p.username) LIKE ? OR CAST(pa.player_id AS TEXT) LIKE ? OR lower(pa.type) LIKE ?)'; const like = `%${q.toLowerCase()}%`; binds.push(like, like, like); }
      if (from) { sql += ' AND pa.created_at >= ?'; binds.push(sgtDayStartUtc(from)); }
      if (to) { sql += ' AND pa.created_at <= ?'; binds.push(sgtDayEndUtc(to)); }
      sql += ' ORDER BY pa.id DESC LIMIT ? OFFSET ?';
      binds.push(limit, offset);
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return json({ ok: true, activity: results || [], offset, limit }, 200, rid);
    }

    case '/api/admin/tasks/list': {
      const { results } = await env.DB.prepare(`SELECT t.*, (SELECT COUNT(*) FROM task_completions tc WHERE tc.task_id = t.id) AS completions FROM tasks t ORDER BY t.id DESC`).all();
      return json({ ok: true, tasks: results || [] }, 200, rid);
    }

    case '/api/admin/tasks/create': {
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) return fail('BAD_REQUEST', 'Title is required.', 400, rid);
      const url = String(body.url || '').trim();
      if (url && !isSafeExternalUrl(url)) return fail('BAD_URL', 'Task URL must be a valid https link.', 400, rid);
      const res = await env.DB.prepare('INSERT INTO tasks (title, description, points, url, active) VALUES (?, ?, ?, ?, ?)')
        .bind(title, String(body.description || '').slice(0, 500), Math.max(0, Number(body.points) || 0), url, body.active === 0 || body.active === '0' ? 0 : 1).run();
      return json({ ok: true, id: res.meta.last_row_id }, 200, rid);
    }

    case '/api/admin/tasks/update': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) return fail('BAD_REQUEST', 'Title is required.', 400, rid);
      const url = String(body.url || '').trim();
      if (url && !isSafeExternalUrl(url)) return fail('BAD_URL', 'Task URL must be a valid https link.', 400, rid);
      await env.DB.prepare("UPDATE tasks SET title = ?, description = ?, points = ?, url = ?, active = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(title, String(body.description || '').slice(0, 500), Math.max(0, Number(body.points) || 0), url, body.active === 0 || body.active === '0' ? 0 : 1, id).run();
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/tasks/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/settings/get': {
      const settings = await getSettings(env);
      return json({ ok: true, settings }, 200, rid);
    }

    case '/api/admin/settings/save': {
      const incoming = (body.settings || {}) as Record<string, unknown>;
      const allowed = ['checkin_min_deposit', 'tasks_enabled', 'announcement_text', 'contact_url', 'deposit_point_rate', 'deposit_paynow', 'deposit_name', 'deposit_qr', 'deposit_bank_name', 'deposit_bank_account', 'deposit_bank_holder'];
      const updates: Record<string, string> = {};
      for (const key of allowed) {
        if (incoming[key] === undefined) continue;
        let val = String(incoming[key]);
        if (key === 'contact_url') {
          val = val.trim();
          if (val && !isSafeExternalUrl(val)) return fail('BAD_URL', 'Contact URL must be a valid https link (WhatsApp/Telegram allowed).', 400, rid);
        }
        if (key === 'announcement_text') val = val.slice(0, 500);
        if (key === 'deposit_paynow' || key === 'deposit_name' || key === 'deposit_qr' || key === 'deposit_bank_name' || key === 'deposit_bank_account' || key === 'deposit_bank_holder') val = val.trim().slice(0, 300);
        if (key === 'checkin_min_deposit' || key === 'deposit_point_rate') {
          val = String(Math.max(0, Math.min(100000, Math.floor(Number(val) || 0))));
        }
        updates[key] = val;
      }
      // If a deposit-account field ACTUALLY changed value, bump a marker so player
      // apps show a red dot on the Deposit button until each player opens it.
      // Comparing against the current value avoids a false dot when staff hit
      // Save without changing anything.
      const depKeys = ['deposit_paynow', 'deposit_name', 'deposit_qr', 'deposit_bank_name', 'deposit_bank_account', 'deposit_bank_holder'];
      if (depKeys.some((k) => updates[k] !== undefined)) {
        const cur = await getSettings(env);
        const changed = depKeys.some((k) => updates[k] !== undefined && String(updates[k]) !== String(cur[k] || ''));
        if (changed) updates.deposit_updated_at = String(Date.now());
      }
      await saveSettings(env, updates);
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/admins/list': {
      let results: unknown[] = [];
      try {
        results = (await env.DB.prepare('SELECT id, username, role, permissions, created_at FROM admins ORDER BY id ASC').all()).results || [];
      } catch {
        try {
          results = (await env.DB.prepare('SELECT id, username, role, created_at FROM admins ORDER BY id ASC').all()).results || [];
        } catch {
          results = (await env.DB.prepare('SELECT id, username, created_at FROM admins ORDER BY id ASC').all()).results || [];
        }
      }
      return json({ ok: true, admins: results }, 200, rid);
    }

    case '/api/admin/admins/create': {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || username.length < 3) return fail('BAD_USERNAME', 'Username must be at least 3 characters.', 400, rid);
      if (password.length < 8) return fail('WEAK_PASSWORD', 'Password must be at least 8 characters.', 400, rid);
      const newRole = String(body.role || 'staff') === 'manager' ? 'manager' : 'staff';
      const hash = await hashPassword(password);
      try {
        await env.DB.prepare('INSERT INTO admins (username, password, role) VALUES (?, ?, ?)').bind(username, hash, newRole).run();
      } catch {
        return fail('USERNAME_TAKEN', 'That username already exists (or the role migration has not been run).', 409, rid);
      }
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/admins/delete': {
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const target = await env.DB.prepare('SELECT username FROM admins WHERE id = ?').bind(id).first<{ username: string }>();
      if (!target) return fail('ADMIN_NOT_FOUND', 'Admin not found.', 404, rid);
      if (target.username === admin) return fail('SELF_DELETE', 'You cannot delete your own account.', 400, rid);
      const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM admins').first<{ c: number }>();
      if ((count?.c ?? 1) <= 1) return fail('LAST_ADMIN', 'At least one admin account must remain.', 400, rid);
      await env.DB.prepare('DELETE FROM admins WHERE id = ?').bind(id).run();
      return json({ ok: true }, 200, rid);
    }

    case '/api/admin/password': {
      if (!(await rateLimit(env, `pwd:admin:${admin}`, 6, 300))) return fail('RATE_LIMITED', 'Too many attempts. Please try again later.', 429, rid);
      const current = String(body.current_password || '');
      const next = String(body.new_password || '');
      if (next.length < 8) return fail('WEAK_PASSWORD', 'New password must be at least 8 characters.', 400, rid);
      const row = await env.DB.prepare('SELECT password FROM admins WHERE username = ?').bind(admin).first<{ password: string }>();
      if (!row || !(await verifyPassword(current, row.password))) return fail('BAD_PASSWORD', 'Current password is incorrect.', 401, rid);
      const hash = await hashPassword(next);
      await env.DB.prepare("UPDATE admins SET password = ?, session_version = session_version + 1 WHERE username = ?").bind(hash, admin).run();
      const fresh = await env.DB.prepare('SELECT session_version FROM admins WHERE username = ?').bind(admin).first<{ session_version: number }>();
      const token = await signToken(env, 'admin', admin, fresh?.session_version ?? 2, ADMIN_SESSION_SECONDS);
      return json({ ok: true, token }, 200, rid);
    }

    case '/api/admin/admins/permissions': {
      // Manager sets which sections a STAFF account may use. (MANAGER_ONLY above.)
      const id = Number(body.id);
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      const target = await env.DB.prepare('SELECT username, role FROM admins WHERE id = ?').bind(id).first<{ username: string; role?: string }>();
      if (!target) return fail('ADMIN_NOT_FOUND', 'Admin not found.', 404, rid);
      // Keep only real, known section keys; drop anything unknown or duplicated.
      const raw = Array.isArray(body.perms) ? body.perms : [];
      const clean = Array.from(new Set(raw.map((p: unknown) => String(p)).filter((p: string) => GRANTABLE_PERMS.indexOf(p) !== -1)));
      try {
        await env.DB.prepare('UPDATE admins SET permissions = ? WHERE id = ?').bind(clean.join(','), id).run();
      } catch {
        return fail('NEEDS_MIGRATION', 'Permissions are being set up. Please run migration 19.', 503, rid);
      }
      return json({ ok: true, perms: clean }, 200, rid);
    }

    case '/api/admin/admins/password': {
      // Manager resets ANOTHER admin's password (staff or manager). MANAGER_ONLY.
      const id = Number(body.id);
      const next = String(body.new_password || '');
      if (!id) return fail('BAD_REQUEST', 'id is required.', 400, rid);
      if (next.length < 8) return fail('WEAK_PASSWORD', 'Password must be at least 8 characters.', 400, rid);
      const target = await env.DB.prepare('SELECT username FROM admins WHERE id = ?').bind(id).first<{ username: string }>();
      if (!target) return fail('ADMIN_NOT_FOUND', 'Admin not found.', 404, rid);
      const hash = await hashPassword(next);
      // Bump session_version so the target's old login is kicked out immediately.
      await env.DB.prepare('UPDATE admins SET password = ?, session_version = session_version + 1 WHERE id = ?').bind(hash, id).run();
      return json({ ok: true }, 200, rid);
    }

    default:
      return fail('NOT_FOUND', 'Not found', 404, rid);
  }
}
