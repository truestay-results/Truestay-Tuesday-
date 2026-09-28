-- TrueStay Pay: plans, chasing, morning nudges.
-- Applied to the live D1 database on 28 Sep 2026. The Worker also checks for these on
-- start-up (src/pay-plans.js → ensureSchema) and, once, moves each old monthly repeat
-- (pay_schedules) into a monthly plan with the same id (pay_meta key 'plans_v1').

CREATE TABLE IF NOT EXISTS pay_plans (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- pt | coaching | programme | break
  programme_weeks INTEGER,          -- 4 | 8 | 12 | 16
  billing TEXT NOT NULL,            -- monthly | upfront | split | none (pays as they go)
  price_pence INTEGER NOT NULL DEFAULT 0,  -- per month (monthly) or total (upfront/split)
  instalments INTEGER,              -- split only
  method TEXT NOT NULL DEFAULT 'manual',
  day_of_month INTEGER,             -- monthly only
  first_due TEXT,                   -- first payment date
  start_date TEXT NOT NULL,
  end_date TEXT,                    -- inclusive; NULL = ongoing
  then_action TEXT,                 -- 'decide' = ask what's next when it ends
  decided INTEGER NOT NULL DEFAULT 0,
  hours_per_month REAL,             -- for £/hour
  sessions_per_week REAL,
  session_minutes INTEGER,
  generated_through TEXT,           -- monthly payments made up to this date
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pay_push_subs (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok INTEGER,
  fails INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE pay_payments ADD COLUMN plan_id INTEGER;
ALTER TABLE pay_payments ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;   -- 1 = created by a plan
ALTER TABLE pay_payments ADD COLUMN chased_at TEXT;
ALTER TABLE pay_payments ADD COLUMN chase_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pay_clients ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE pay_clients ADD COLUMN finished_on TEXT;

CREATE INDEX IF NOT EXISTS pay_plans_client ON pay_plans(client_id, start_date);
CREATE UNIQUE INDEX IF NOT EXISTS pay_payments_plan_due ON pay_payments(plan_id, due_date) WHERE auto = 1;
CREATE INDEX IF NOT EXISTS pay_payments_plan ON pay_payments(plan_id);
