-- TrueStay Pay (/pay) schema. D1 database: truestay-pay
-- Money is stored in pence (integers). Dates are 'YYYY-MM-DD' strings (UK local dates).

CREATE TABLE IF NOT EXISTS pay_users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL,
  lock_minutes INTEGER NOT NULL DEFAULT 15,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pay_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  unlocked_until INTEGER NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS pay_passkeys (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);

CREATE TABLE IF NOT EXISTS pay_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_hash TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pay_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS pay_login_attempts (
  id INTEGER PRIMARY KEY,
  ip TEXT,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pay_clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tenure TEXT NOT NULL,            -- new | newish | longstanding
  package TEXT NOT NULL,           -- pt | coaching | programme
  programme_weeks INTEGER,         -- 4 | 8 | 12 | 16 (programme only)
  price_pence INTEGER NOT NULL,
  method TEXT NOT NULL,            -- manual | dd
  status TEXT NOT NULL DEFAULT 'active', -- active | paused | finished
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Optional "repeat monthly" rule. Generates one payment per month on day_of_month.
CREATE TABLE IF NOT EXISTS pay_schedules (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  package TEXT NOT NULL,
  programme_weeks INTEGER,
  amount_pence INTEGER NOT NULL,
  method TEXT NOT NULL,
  day_of_month INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  generated_through TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Every payment is its own row. Status is derived: paid_date set = Paid,
-- else due_date < today = Overdue, else Unpaid.
CREATE TABLE IF NOT EXISTS pay_payments (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  schedule_id INTEGER,
  package TEXT NOT NULL,
  programme_weeks INTEGER,
  amount_pence INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  method TEXT NOT NULL,
  paid_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS pay_payments_schedule_due ON pay_payments(schedule_id, due_date);
CREATE INDEX IF NOT EXISTS pay_payments_client ON pay_payments(client_id);
CREATE INDEX IF NOT EXISTS pay_payments_due ON pay_payments(due_date);
CREATE INDEX IF NOT EXISTS pay_payments_paid ON pay_payments(paid_date);
CREATE INDEX IF NOT EXISTS pay_sessions_user ON pay_sessions(user_id);
