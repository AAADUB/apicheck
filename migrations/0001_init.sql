-- API Check schema for Cloudflare D1 (SQLite). Times are milliseconds since 1970-01-01 UTC.
-- Every table that holds user data carries user_id, so one person's rows are one index range.

-- The workspace is closed: there is no sign-up. The first administrator is created once with the SETUP_TOKEN secret
-- (or by a one-time link issued at deployment); after that administrators create users, and each user sets a password through a one-time link.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL DEFAULT '',  -- empty until the person opens the link and sets a password
  role TEXT NOT NULL DEFAULT 'user',   -- admin | user
  disabled INTEGER NOT NULL DEFAULT 0, -- blocked: no sign-in, every watch of theirs stops; the data stays
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_login_at INTEGER,
  alert_mail INTEGER NOT NULL DEFAULT 1,  -- email notifications on or off
  notify_email TEXT NOT NULL DEFAULT ''   -- where they go; empty = the sign-in address (only administrators may name another)
);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- invite | reset
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- A provider credential. The secret is stored only as an AES-256-GCM envelope; the interface sees its last four characters.
CREATE TABLE keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,              -- lambda | upcloud | nebius | runpod
  label TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  key_enc BLOB NOT NULL,
  key_tail TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',     -- facts found when the key was checked: account name, tenant and project ids, and so on
  status TEXT NOT NULL DEFAULT 'ok',   -- ok | error
  last_error TEXT,
  error_at INTEGER,
  created_at INTEGER NOT NULL,
  checked_at INTEGER
);
CREATE INDEX keys_user ON keys(user_id);

-- A watch: what to look for with one key, and what to do when it is found.
CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,                  -- notify | launch
  state TEXT NOT NULL DEFAULT 'on',    -- on | paused | done | stopped
  stop_reason TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL,                  -- configurations, regions and the launch settings, as JSON (shared/providers.js says what is in it)
  every_sec INTEGER NOT NULL,          -- seconds between checks
  max_launch INTEGER NOT NULL DEFAULT 1,
  launched INTEGER NOT NULL DEFAULT 0,
  renotify_min INTEGER NOT NULL DEFAULT 30, -- the least time between two "available" messages for one watch
  max_price REAL,                      -- per hour in the provider's currency; NULL = no cap
  starts_at INTEGER,                   -- NULL = now
  ends_at INTEGER,                     -- NULL = until stopped
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_ok_at INTEGER,                  -- the last check that reached the provider
  last_seen_at INTEGER,                -- the last check that found a match
  last_notified_at INTEGER,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT '{}'    -- what the last check found, as JSON, for the list view
);
CREATE INDEX watches_user ON watches(user_id);
CREATE INDEX watches_key ON watches(key_id, state);

-- What happened, in order: availability seen and gone, launches, errors, state changes. Kept 120 days.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_id TEXT,
  key_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- seen | gone | launch | launch_failed | error | recovered | state | notice
  sev TEXT NOT NULL DEFAULT 'info',    -- info | ok | warn | crit
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX events_user ON events(user_id, at);
CREATE INDEX events_watch ON events(watch_id, at);

-- Periods during which a configuration was available in a region, as one watch saw them. They feed the history strip.
CREATE TABLE windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  region TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'yes',
  start_at INTEGER NOT NULL,
  end_at INTEGER                       -- NULL while it is still open
);
CREATE INDEX windows_watch ON windows(watch_id, start_at);

-- Machines a watch created. The row is written before the provider is asked, so a launch is never lost or repeated.
CREATE TABLE launches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_id TEXT REFERENCES watches(id) ON DELETE SET NULL,
  key_id TEXT REFERENCES keys(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  target TEXT NOT NULL,
  region TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  ext_id TEXT,                         -- the provider's id for the machine
  state TEXT NOT NULL,                 -- pending | created | failed | unknown
  price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  detail TEXT NOT NULL DEFAULT '{}',   -- address, status and the provider's own fields as they were last read
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX launches_user ON launches(user_id, created_at);

-- What was sent by email, and whether it went.
CREATE TABLE notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  result TEXT NOT NULL                 -- sent | off | failed:<code>
);
CREATE INDEX notices_user ON notices(user_id, at);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_user ON audit(user_id, at);

CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
