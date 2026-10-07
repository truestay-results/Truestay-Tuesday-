-- TrueStay Pay: other income (classes, online, products, affiliate, another job...).
-- The Worker also creates these on start-up (src/pay-income.js → ensureIncomeSchema).

CREATE TABLE IF NOT EXISTS pay_income_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',      -- classes | online | products | affiliate | job | other
  amount_pence INTEGER NOT NULL DEFAULT 0, -- per month (monthly) or the one-off amount
  repeat TEXT NOT NULL DEFAULT 'none',     -- none | monthly
  day_of_month INTEGER,                    -- monthly only
  start_date TEXT NOT NULL,
  end_date TEXT,                           -- monthly only; NULL = ongoing
  generated_through TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pay_income (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,         -- 1 = made by a monthly source
  amount_pence INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  received_date TEXT,                      -- set = received
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pay_income_source_due ON pay_income(source_id, due_date) WHERE auto = 1;
CREATE INDEX IF NOT EXISTS pay_income_due ON pay_income(due_date);
