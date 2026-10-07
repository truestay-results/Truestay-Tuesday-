// TrueStay Pay — plans.
//
// A plan is what a client is on for a stretch of time: PT, full coaching, a programme, or a break,
// at their own price, paid monthly / upfront / split / as they go. Plans run one after another,
// so a client's history reads as a timeline:
//   Coaching £160/month (28 Sep – 30 Nov) → Break (Dec) → 12-week programme £200 upfront → PT …
//
// Payments stay separate records. Plans create them automatically (auto = 1, plan_id set):
//   monthly → one on the payment day each month (made up to the end of next month)
//   upfront → one payment; split → N monthly instalments
// Ending or switching a plan only ever removes that plan's *unpaid, not-yet-due* automatic
// payments. Anything paid, and anything already due, stays exactly as it is.

import {
  TRACK_START, KINDS, BILLINGS, METHODS, WEEKS, KIND_LABEL, bad, nowS, londonToday, isDate, addDays,
  occurrence, addMonthsKeepDay, nextOnDay, endOfNextMonth, ukDate, pence, oneOf, text, numOrNull,
} from "./pay-util.js";

// ---------- schema + one-time move from the old "repeat" model ----------
let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  const tables = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((r) => r.name));
  const cols = async (t) => new Set((await db.prepare(`PRAGMA table_info(${t})`).all()).results.map((r) => r.name));
  const stmts = [];
  if (!tables.has("pay_plans")) {
    stmts.push(
      db.prepare(`CREATE TABLE pay_plans (
        id INTEGER PRIMARY KEY,
        client_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        programme_weeks INTEGER,
        billing TEXT NOT NULL,
        price_pence INTEGER NOT NULL DEFAULT 0,
        instalments INTEGER,
        method TEXT NOT NULL DEFAULT 'manual',
        day_of_month INTEGER,
        first_due TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT,
        then_action TEXT,
        decided INTEGER NOT NULL DEFAULT 0,
        hours_per_month REAL,
        sessions_per_week REAL,
        session_minutes INTEGER,
        generated_through TEXT,
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`)
    );
  }
  if (!tables.has("pay_skips")) {
    stmts.push(
      db.prepare(`CREATE TABLE pay_skips (
        id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, plan_id INTEGER, package TEXT NOT NULL, programme_weeks INTEGER,
        amount_pence INTEGER NOT NULL, due_date TEXT NOT NULL, method TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'other',
        notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS pay_skips_client ON pay_skips(client_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS pay_skips_plan_due ON pay_skips(plan_id, due_date)")
    );
  }
  if (!tables.has("pay_push_subs")) {
    stmts.push(
      db.prepare(`CREATE TABLE pay_push_subs (
        id INTEGER PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_ok INTEGER, fails INTEGER NOT NULL DEFAULT 0
      )`)
    );
  }
  const pc = await cols("pay_payments");
  if (!pc.has("plan_id")) stmts.push(db.prepare("ALTER TABLE pay_payments ADD COLUMN plan_id INTEGER"));
  if (!pc.has("auto")) stmts.push(db.prepare("ALTER TABLE pay_payments ADD COLUMN auto INTEGER NOT NULL DEFAULT 0"));
  if (!pc.has("chased_at")) stmts.push(db.prepare("ALTER TABLE pay_payments ADD COLUMN chased_at TEXT"));
  if (!pc.has("chase_count")) stmts.push(db.prepare("ALTER TABLE pay_payments ADD COLUMN chase_count INTEGER NOT NULL DEFAULT 0"));
  const cc = await cols("pay_clients");
  if (!cc.has("phone")) stmts.push(db.prepare("ALTER TABLE pay_clients ADD COLUMN phone TEXT NOT NULL DEFAULT ''"));
  if (!cc.has("finished_on")) stmts.push(db.prepare("ALTER TABLE pay_clients ADD COLUMN finished_on TEXT"));
  stmts.push(db.prepare("CREATE INDEX IF NOT EXISTS pay_plans_client ON pay_plans(client_id, start_date)"));
  stmts.push(db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS pay_payments_plan_due ON pay_payments(plan_id, due_date) WHERE auto = 1"));
  stmts.push(db.prepare("CREATE INDEX IF NOT EXISTS pay_payments_plan ON pay_payments(plan_id)"));
  await db.batch(stmts);
  await migrateRepeatsToPlans(db);
  schemaReady = true;
}

// Runs once. Each old monthly repeat becomes a monthly plan with the same id, and its payments
// are linked to it. Clients with no repeat get a "pay as they go" plan (no automatic charges).
async function migrateRepeatsToPlans(db) {
  if (await db.prepare("SELECT 1 FROM pay_meta WHERE key = 'plans_v1'").first()) return;
  const hasSchedules = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pay_schedules'").first()) != null;
  const stmts = [db.prepare("INSERT INTO pay_meta (key, value) VALUES ('plans_v1', ?)").bind(new Date().toISOString())];
  if (hasSchedules) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO pay_plans (id, client_id, kind, programme_weeks, billing, price_pence, method, day_of_month, first_due,
             start_date, end_date, generated_through, created_at, updated_at)
           SELECT s.id, s.client_id, s.package, s.programme_weeks, 'monthly', s.amount_pence, s.method, s.day_of_month, s.start_date,
             MIN(s.start_date, MAX(?, date(s.created_at, 'unixepoch'))),
             CASE WHEN s.active = 0 THEN MAX(s.start_date, date(s.updated_at, 'unixepoch')) END,
             s.generated_through, s.created_at, s.updated_at
           FROM pay_schedules s`
        )
        .bind(TRACK_START),
      db.prepare("UPDATE pay_payments SET plan_id = schedule_id, auto = 1 WHERE schedule_id IS NOT NULL AND plan_id IS NULL")
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO pay_plans (client_id, kind, programme_weeks, billing, price_pence, method, start_date, created_at, updated_at)
         SELECT c.id, c.package, c.programme_weeks, 'none', c.price_pence, c.method, MAX(?, date(c.created_at, 'unixepoch')), c.created_at, c.updated_at
         FROM pay_clients c WHERE NOT EXISTS (SELECT 1 FROM pay_plans p WHERE p.client_id = c.id)`
      )
      .bind(TRACK_START),
    // paused → plan ends on the pause date, then an open-ended break
    db.prepare(
      `UPDATE pay_plans SET end_date = MAX(start_date, (SELECT date(c.updated_at, 'unixepoch') FROM pay_clients c WHERE c.id = pay_plans.client_id))
       WHERE end_date IS NULL AND client_id IN (SELECT id FROM pay_clients WHERE status = 'paused')`
    ),
    db.prepare(
      `INSERT INTO pay_plans (client_id, kind, billing, price_pence, method, start_date, created_at, updated_at)
       SELECT c.id, 'break', 'none', 0, 'manual', date(c.updated_at, 'unixepoch', '+1 day'), c.updated_at, c.updated_at
       FROM pay_clients c WHERE c.status = 'paused'`
    ),
    // finished → plans end, finished_on recorded
    db.prepare("UPDATE pay_clients SET finished_on = date(updated_at, 'unixepoch') WHERE status = 'finished' AND finished_on IS NULL"),
    db.prepare(
      `UPDATE pay_plans SET end_date = MAX(start_date, (SELECT c.finished_on FROM pay_clients c WHERE c.id = pay_plans.client_id))
       WHERE end_date IS NULL AND client_id IN (SELECT id FROM pay_clients WHERE status = 'finished')`
    )
  );
  try {
    await db.batch(stmts); // atomic: if another request got here first, the pay_meta insert fails and nothing is applied
  } catch (e) {
    if (!(await db.prepare("SELECT 1 FROM pay_meta WHERE key = 'plans_v1'").first())) throw e;
  }
}

// ---------- reading plans ----------
export function currentPlan(plans, today) {
  let best = null;
  for (const p of plans) {
    if (p.start_date <= today && (!p.end_date || p.end_date >= today)) {
      if (!best || p.start_date > best.start_date || (p.start_date === best.start_date && p.id > best.id)) best = p;
    }
  }
  return best;
}
export function clientStatus(client, plans, today) {
  if (client.finished_on && client.finished_on <= today) return "finished";
  const cur = currentPlan(plans, today);
  if (cur) return cur.kind === "break" ? "paused" : "active";
  const next = plans.filter((p) => p.start_date > today).sort((a, b) => (a.start_date < b.start_date ? -1 : 1))[0];
  if (next && next.kind === "break") return "paused";
  return "active";
}
export const planLabel = (p) => (p.kind === "programme" && p.programme_weeks ? `${p.programme_weeks}-week programme` : KIND_LABEL[p.kind]);

// ---------- validation ----------
export function cleanPlan(b) {
  const kind = oneOf(b.kind, KINDS, "Pick what they're on");
  if (!isDate(b.start_date)) bad("Pick a start date");
  const start_date = b.start_date;
  let end_date = b.end_date ? (isDate(b.end_date) ? b.end_date : bad("The end date isn't valid")) : null;
  if (end_date && end_date < start_date) bad("The end date is before the start date");
  const then_action = b.then_action === "decide" ? "decide" : null;
  const notes = text(b.notes, 1000);
  if (kind === "break") {
    return {
      kind, start_date, end_date, then_action, notes, billing: "none", price_pence: 0, method: "manual", programme_weeks: null,
      instalments: null, day_of_month: null, first_due: null, hours_per_month: null, sessions_per_week: null, session_minutes: null,
    };
  }
  const billing = oneOf(b.billing, BILLINGS, "Pick how they pay");
  let programme_weeks = null;
  if (kind === "programme") {
    const w = Number(b.programme_weeks);
    if (WEEKS.includes(w)) programme_weeks = w;
    else if (billing !== "monthly") bad("Pick the programme length");
  }
  const blank = b.price_pence === null || b.price_pence === undefined || b.price_pence === "";
  const price_pence = billing === "none" && blank ? 0 : pence(b.price_pence, "price");
  if (billing !== "none" && price_pence <= 0) bad("Enter the price");
  const method = oneOf(b.method || "manual", METHODS, "Pick a payment method");
  let first_due = null;
  let day_of_month = null;
  let instalments = null;
  if (billing !== "none") {
    first_due = b.first_due ? (isDate(b.first_due) ? b.first_due : bad("The payment date isn't valid")) : start_date;
  }
  if (billing === "monthly") {
    const d = b.day_of_month ? Number(b.day_of_month) : Number(first_due.slice(8, 10));
    if (!Number.isInteger(d) || d < 1 || d > 31) bad("Pick a payment day");
    day_of_month = d;
  }
  if (billing === "split") {
    const n = Number(b.instalments);
    if (!Number.isInteger(n) || n < 2 || n > 12) bad("Split into 2 to 12 payments");
    instalments = n;
  }
  if (kind === "programme" && programme_weeks && !end_date && billing !== "monthly") end_date = addDays(start_date, programme_weeks * 7 - 1);
  const sessions_per_week = numOrNull(b.sessions_per_week, 0, 21);
  const session_minutes = b.session_minutes ? Math.round(numOrNull(b.session_minutes, 10, 300)) : null;
  let hours_per_month = numOrNull(b.hours_per_month, 0, 500);
  if (hours_per_month == null && sessions_per_week && session_minutes) hours_per_month = Math.round(((sessions_per_week * session_minutes * 52) / 12 / 60) * 10) / 10;
  return {
    kind, start_date, end_date, then_action, notes, billing, price_pence, method, programme_weeks, instalments,
    day_of_month, first_due, hours_per_month, sessions_per_week, session_minutes,
  };
}

// ---------- writing ----------
const PLAN_COLS = [
  "kind", "programme_weeks", "billing", "price_pence", "instalments", "method", "day_of_month", "first_due", "start_date", "end_date",
  "then_action", "hours_per_month", "sessions_per_week", "session_minutes", "notes",
];
function insertPlan(db, id, clientId, p, now) {
  return db
    .prepare(
      `INSERT INTO pay_plans (id, client_id, ${PLAN_COLS.join(", ")}, created_at, updated_at) VALUES (?, ?, ${PLAN_COLS.map(() => "?").join(", ")}, ?, ?)`
    )
    .bind(id, clientId, ...PLAN_COLS.map((c) => p[c] ?? null), now, now);
}
function insertAuto(db, clientId, planId, p, due, amount, now) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO pay_payments (client_id, plan_id, auto, package, programme_weeks, amount_pence, due_date, method, paid_date, notes, created_at, updated_at)
       SELECT ?, ?, 1, ?, ?, ?, ?, ?, NULL, '', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM pay_skips WHERE plan_id = ? AND due_date = ?)`
    )
    .bind(clientId, planId, p.kind, p.programme_weeks, amount, due, p.method, now, now, planId, due);
// A skipped payment never comes back on its own: plan payments are not made again on a skipped date.
}
const splitAmounts = (total, n) => {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + (total - base * n) : base));
};
// Payments that are created straight away (upfront + split). Monthly ones come from generate().
function upfrontPayments(db, clientId, planId, p, now, skip = 0, remaining = null) {
  if (p.billing === "upfront" && skip === 0) return [insertAuto(db, clientId, planId, p, p.first_due, p.price_pence, now)];
  if (p.billing === "split") {
    const left = p.instalments - skip;
    if (left <= 0) return [];
    const amounts = splitAmounts(remaining ?? p.price_pence, left);
    const day = Number(p.first_due.slice(8, 10));
    return amounts.map((a, i) => insertAuto(db, clientId, planId, p, addMonthsKeepDay(p.first_due, skip + i, day), a, now));
  }
  return [];
}
const dropUnpaidAfter = (db, planId, date) =>
  db.prepare("DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND paid_date IS NULL AND due_date > ?").bind(planId, date);
async function nextPlanId(db) {
  return (await db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM pay_plans").first()).n;
}
async function paidCount(db, planId) {
  return (await db.prepare("SELECT COUNT(*) AS n FROM pay_payments WHERE plan_id = ? AND paid_date IS NOT NULL").bind(planId).first()).n;
}
function headlineStmt(db, clientId, p, now) {
  return db
    .prepare("UPDATE pay_clients SET package = ?, programme_weeks = ?, price_pence = ?, method = ?, updated_at = ? WHERE id = ?")
    .bind(p.kind, p.programme_weeks, p.price_pence, p.method, now, clientId);
}
// A fresh copy of an earlier plan, starting on `start` (used for "pick their old plan back up").
export function resumeCopy(prev, start) {
  const copy = {
    kind: prev.kind, billing: prev.billing, price_pence: prev.price_pence, method: prev.method, programme_weeks: prev.programme_weeks,
    instalments: prev.instalments, hours_per_month: prev.hours_per_month, sessions_per_week: prev.sessions_per_week,
    session_minutes: prev.session_minutes, start_date: start, end_date: null, then_action: null, notes: "",
    day_of_month: prev.day_of_month, first_due: null,
  };
  if (prev.billing === "monthly") copy.first_due = nextOnDay(prev.day_of_month || Number(start.slice(8, 10)), start);
  else if (prev.billing !== "none") copy.first_due = start;
  if (prev.kind === "programme" && prev.programme_weeks && prev.billing !== "monthly") copy.end_date = addDays(start, prev.programme_weeks * 7 - 1);
  return copy;
}

// New client's first plan
export async function addFirstPlan(db, clientId, body) {
  const p = cleanPlan(body);
  const id = await nextPlanId(db);
  const now = nowS();
  await db.batch([insertPlan(db, id, clientId, p, now), ...upfrontPayments(db, clientId, id, p, now), ...(p.kind !== "break" ? [headlineStmt(db, clientId, p, now)] : [])]);
}

// Switch to a new plan from its start date. `then` says what happens when a plan with an end date finishes:
//   { mode: "decide" }  → ask on the day,   { mode: "resume" } → back to the plan before this one,
//   { mode: "plan", plan: {...} } → a specific next plan.
export async function switchPlan(db, clientId, body) {
  const now = nowS();
  const then = body.then || {};
  const p = cleanPlan({ ...body.plan, then_action: then.mode === "decide" ? "decide" : null });
  const S = p.start_date;
  const plans = (await db.prepare("SELECT * FROM pay_plans WHERE client_id = ? ORDER BY start_date, id").bind(clientId).all()).results;
  const stmts = [];
  for (const old of plans.filter((x) => x.start_date >= S)) {
    if (await paidCount(db, old.id))
      bad(`Their ${planLabel(old).toLowerCase()} starting ${ukDate(old.start_date)} already has a paid payment. Edit that plan instead.`);
    stmts.push(db.prepare("DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND paid_date IS NULL").bind(old.id));
    stmts.push(db.prepare("DELETE FROM pay_plans WHERE id = ?").bind(old.id));
  }
  const E = addDays(S, -1);
  for (const old of plans.filter((x) => x.start_date < S && (!x.end_date || x.end_date >= S))) {
    stmts.push(db.prepare("UPDATE pay_plans SET end_date = ?, updated_at = ? WHERE id = ?").bind(E, now, old.id));
    stmts.push(dropUnpaidAfter(db, old.id, E));
  }
  const prevPaid = plans.filter((x) => x.start_date < S && x.kind !== "break").pop();
  let id = await nextPlanId(db);
  stmts.push(insertPlan(db, id, clientId, p, now), ...upfrontPayments(db, clientId, id, p, now));
  let next = null;
  if (p.end_date && then.mode === "resume") {
    if (!prevPaid) bad("There's no earlier plan to go back to. Choose the next plan instead.");
    next = resumeCopy(prevPaid, addDays(p.end_date, 1));
  } else if (p.end_date && then.mode === "plan" && then.plan) {
    next = cleanPlan({ ...then.plan, start_date: addDays(p.end_date, 1) });
  }
  if (next) {
    id += 1;
    stmts.push(insertPlan(db, id, clientId, next, now), ...upfrontPayments(db, clientId, id, next, now));
  }
  stmts.push(db.prepare("UPDATE pay_clients SET finished_on = NULL, updated_at = ? WHERE id = ?").bind(now, clientId));
  const headline = p.kind !== "break" ? p : next && next.kind !== "break" ? next : null;
  if (headline) stmts.push(headlineStmt(db, clientId, headline, now));
  await db.batch(stmts);
}

// Finished with you: current plan ends on `date`, anything planned later is removed.
export async function finishClient(db, clientId, date) {
  if (!isDate(date)) bad("Pick their last day");
  const now = nowS();
  const plans = (await db.prepare("SELECT * FROM pay_plans WHERE client_id = ?").bind(clientId).all()).results;
  const stmts = [];
  for (const p of plans) {
    if (p.start_date > date) {
      if (await paidCount(db, p.id)) bad(`Their plan starting ${ukDate(p.start_date)} has a paid payment, so it can't be removed.`);
      stmts.push(db.prepare("DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND paid_date IS NULL").bind(p.id));
      stmts.push(db.prepare("DELETE FROM pay_plans WHERE id = ?").bind(p.id));
    } else if (!p.end_date || p.end_date > date) {
      stmts.push(db.prepare("UPDATE pay_plans SET end_date = ?, updated_at = ? WHERE id = ?").bind(date, now, p.id));
      stmts.push(dropUnpaidAfter(db, p.id, date));
    }
  }
  stmts.push(db.prepare("UPDATE pay_clients SET finished_on = ?, updated_at = ? WHERE id = ?").bind(date, now, clientId));
  await db.batch(stmts);
}

// Fix a plan in place (typo in the price, wrong payment day, dates). Its unpaid payments follow;
// paid ones never change. For a real change from a date onwards, use switchPlan instead.
export async function editPlan(db, planId, body) {
  const old = await db.prepare("SELECT * FROM pay_plans WHERE id = ?").bind(planId).first();
  if (!old) bad("Plan not found");
  const kind = body.kind ?? old.kind;
  if ((kind === "break") !== (old.kind === "break")) bad("To swap between a break and a paid plan, use Change plan");
  const merged = { ...old, ...body, kind, billing: old.billing };
  const p = cleanPlan(merged);
  const now = nowS();
  const today = londonToday();
  const stmts = [
    db
      .prepare(`UPDATE pay_plans SET ${PLAN_COLS.map((c) => `${c} = ?`).join(", ")}, decided = 0, updated_at = ? WHERE id = ?`)
      .bind(...PLAN_COLS.map((c) => p[c] ?? null), now, planId),
  ];
  if (p.billing === "monthly") {
    stmts.push(
      db
        .prepare("UPDATE pay_payments SET package = ?, programme_weeks = ?, amount_pence = ?, method = ?, updated_at = ? WHERE plan_id = ? AND auto = 1 AND paid_date IS NULL")
        .bind(p.kind, p.programme_weeks, p.price_pence, p.method, now, planId)
    );
    const timing = old.day_of_month !== p.day_of_month || old.first_due !== p.first_due || old.start_date !== p.start_date || old.end_date !== p.end_date;
    if (timing) {
      stmts.push(
        db
          .prepare(
            `DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND paid_date IS NULL
             AND (due_date >= ? OR due_date < ? OR due_date < ? OR (? IS NOT NULL AND due_date > ?))`
          )
          .bind(planId, today, p.first_due, p.start_date, p.end_date, p.end_date)
      );
      stmts.push(db.prepare("UPDATE pay_plans SET generated_through = ? WHERE id = ?").bind(addDays(today, -1), planId));
    }
  } else if (p.billing === "upfront") {
    stmts.push(
      db
        .prepare("UPDATE pay_payments SET package = ?, programme_weeks = ?, amount_pence = ?, method = ?, due_date = ?, updated_at = ? WHERE plan_id = ? AND auto = 1 AND paid_date IS NULL")
        .bind(p.kind, p.programme_weeks, p.price_pence, p.method, p.first_due, now, planId)
    );
  } else if (p.billing === "split") {
    const paid = await db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_pence), 0) AS s FROM pay_payments WHERE plan_id = ? AND auto = 1 AND paid_date IS NOT NULL")
      .bind(planId)
      .first();
    stmts.push(db.prepare("DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND paid_date IS NULL").bind(planId));
    stmts.push(...upfrontPayments(db, old.client_id, planId, p, now, paid.n, Math.max(0, p.price_pence - paid.s)));
  }
  if (p.end_date) stmts.push(dropUnpaidAfter(db, planId, p.end_date));
  const plans = (await db.prepare("SELECT * FROM pay_plans WHERE client_id = ?").bind(old.client_id).all()).results;
  const cur = currentPlan(plans, today);
  if (p.kind !== "break" && (!cur || cur.id === planId)) stmts.push(headlineStmt(db, old.client_id, p, now));
  await db.batch(stmts);
}

export async function deletePlan(db, planId) {
  const old = await db.prepare("SELECT * FROM pay_plans WHERE id = ?").bind(planId).first();
  if (!old) bad("Plan not found");
  if (await paidCount(db, planId)) bad("This plan has paid payments, so it can't be deleted. End it instead.");
  await db.batch([
    db.prepare("DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND paid_date IS NULL").bind(planId),
    db.prepare("UPDATE pay_payments SET plan_id = NULL WHERE plan_id = ?").bind(planId),
    db.prepare("DELETE FROM pay_plans WHERE id = ?").bind(planId),
  ]);
}

// ---------- monthly payments ----------
// Creates each monthly plan's payments up to the end of next month. Never before the tracking start,
// the plan's first payment date, or after its end. The unique (plan_id, due_date) index makes it
// safe to run on every request.
export async function generate(db) {
  const today = londonToday();
  const horizon = endOfNextMonth(today);
  const { results } = await db
    .prepare(
      `SELECT * FROM pay_plans WHERE billing = 'monthly' AND (generated_through IS NULL OR generated_through < ?)
       AND (end_date IS NULL OR generated_through IS NULL OR generated_through < end_date)`
    )
    .bind(horizon)
    .all();
  if (!results.length) return;
  const now = nowS();
  const stmts = [];
  for (const p of results) {
    const from = p.generated_through ? addDays(p.generated_through, 1) : p.first_due || p.start_date;
    const limit = p.end_date && p.end_date < horizon ? p.end_date : horizon;
    const floor = [from, p.first_due || p.start_date, p.start_date, TRACK_START].sort().pop();
    let [y, m] = from.split("-").map(Number);
    for (let k = 0; k < 36; k++) {
      const d = occurrence(y, m, p.day_of_month);
      if (d > limit) break;
      if (d >= floor) stmts.push(insertAuto(db, p.client_id, p.id, p, d, p.price_pence, now));
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    stmts.push(db.prepare("UPDATE pay_plans SET generated_through = ? WHERE id = ?").bind(horizon, p.id));
  }
  await db.batch(stmts);
}
