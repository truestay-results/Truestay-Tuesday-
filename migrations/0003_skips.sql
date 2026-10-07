-- TrueStay Pay: skipped payments (lost money).
-- The Worker also creates this on start-up (src/pay-plans.js → ensureSchema).
-- Skipping a payment moves it here instead of deleting it, so it counts as money lost.
-- Plans never make a payment again on a date that was skipped. Undo puts the payment back.

CREATE TABLE IF NOT EXISTS pay_skips (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  plan_id INTEGER,                  -- the plan it came from (NULL for a one-off)
  package TEXT NOT NULL,
  programme_weeks INTEGER,
  amount_pence INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  method TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'other',  -- holiday | ill | money | other
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_skips_client ON pay_skips(client_id);
CREATE INDEX IF NOT EXISTS pay_skips_plan_due ON pay_skips(plan_id, due_date);
