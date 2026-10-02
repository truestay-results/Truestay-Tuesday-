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
//
// Clients pay up front for the month ahead, so a payment that never comes isn't a debt: their
// service stops and that month's money is lost. "Didn't pay" (missed_on) keeps the payment on record
// as lost, and ends their plan from its due date (see markMissed). Paid and didn't-pay payments are
// both kept records: nothing that ends or edits a plan removes or changes them.

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
  if (!pc.has("missed_on")) stmts.push(db.prepare("ALTER TABLE pay_payments ADD COLUMN missed_on TEXT"));
  if (!pc.has("missed_undo")) stmts.push(db.prepare("ALTER TABLE pay_payments ADD COLUMN missed_undo TEXT"));
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
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, '', ?, ?)`
    )
    .bind(clientId, planId, p.kind, p.programme_weeks, amount, due, p.method, now, now);
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
// "Open" = unpaid and not marked as didn't pay: the only payments a plan change may remove or rewrite.
const OPEN = "paid_date IS NULL AND missed_on IS NULL";
const dropUnpaidAfter = (db, planId, date) =>
  db.prepare(`DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND ${OPEN} AND due_date > ?`).bind(planId, date);
async function nextPlanId(db) {
  return (await db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM pay_plans").first()).n;
}
// payments that are history (paid, or didn't pay), so their plan can't be deleted
async function keptCount(db, planId) {
  return (await db.prepare("SELECT COUNT(*) AS n FROM pay_payments WHERE plan_id = ? AND (paid_date IS NOT NULL OR missed_on IS NOT NULL)").bind(planId).first()).n;
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
    if (await keptCount(db, old.id))
      bad(`Their ${planLabel(old).toLowerCase()} starting ${ukDate(old.start_date)} has a payment marked paid or didn't pay. Start the new plan after ${ukDate(old.start_date)}, or edit that plan instead.`);
    stmts.push(db.prepare(`DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND ${OPEN}`).bind(old.id));
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
      if (await keptCount(db, p.id)) bad(`Their plan starting ${ukDate(p.start_date)} has a payment marked paid or didn't pay, so it can't be removed.`);
      stmts.push(db.prepare(`DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND ${OPEN}`).bind(p.id));
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
        .prepare(`UPDATE pay_payments SET package = ?, programme_weeks = ?, amount_pence = ?, method = ?, updated_at = ? WHERE plan_id = ? AND auto = 1 AND ${OPEN}`)
        .bind(p.kind, p.programme_weeks, p.price_pence, p.method, now, planId)
    );
    const timing = old.day_of_month !== p.day_of_month || old.first_due !== p.first_due || old.start_date !== p.start_date || old.end_date !== p.end_date;
    if (timing) {
      stmts.push(
        db
          .prepare(
            `DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND ${OPEN}
             AND (due_date >= ? OR due_date < ? OR due_date < ? OR (? IS NOT NULL AND due_date > ?))`
          )
          .bind(planId, today, p.first_due, p.start_date, p.end_date, p.end_date)
      );
      stmts.push(db.prepare("UPDATE pay_plans SET generated_through = ? WHERE id = ?").bind(addDays(today, -1), planId));
    }
  } else if (p.billing === "upfront") {
    stmts.push(
      db
        .prepare(`UPDATE pay_payments SET package = ?, programme_weeks = ?, amount_pence = ?, method = ?, due_date = ?, updated_at = ? WHERE plan_id = ? AND auto = 1 AND ${OPEN}`)
        .bind(p.kind, p.programme_weeks, p.price_pence, p.method, p.first_due, now, planId)
    );
  } else if (p.billing === "split") {
    // Instalments are only rebuilt when something they depend on changed, so a notes or hours edit leaves
    // them (and their chase history) alone. Settled ones (paid, or didn't pay) keep their dates; the rest
    // go back on the schedule's other dates, whichever order things were settled in.
    const changed = ["price_pence", "instalments", "first_due", "kind", "programme_weeks", "method"].some((k) => (old[k] ?? null) !== (p[k] ?? null));
    if (changed) {
      const rows = (await db.prepare("SELECT due_date, amount_pence, paid_date, missed_on FROM pay_payments WHERE plan_id = ? AND auto = 1").bind(planId).all()).results;
      const settled = rows.filter((x) => x.paid_date || x.missed_on);
      const taken = new Set(settled.map((x) => x.due_date));
      const day = Number(p.first_due.slice(8, 10));
      const slots = Array.from({ length: p.instalments }, (_, i) => addMonthsKeepDay(p.first_due, i, day));
      const open = slots.filter((d) => !taken.has(d)).slice(0, Math.max(0, p.instalments - settled.length));
      const left = Math.max(0, p.price_pence - settled.reduce((a, x) => a + x.amount_pence, 0));
      stmts.push(db.prepare(`DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND ${OPEN}`).bind(planId));
      if (open.length) splitAmounts(left, open.length).forEach((amt, i) => stmts.push(insertAuto(db, old.client_id, planId, p, open[i], amt, now)));
    }
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
  if (await keptCount(db, planId)) bad("This plan has payments marked paid or didn't pay, so it can't be deleted. End it instead.");
  await db.batch([
    db.prepare(`DELETE FROM pay_payments WHERE plan_id = ? AND auto = 1 AND ${OPEN}`).bind(planId),
    db.prepare("UPDATE pay_payments SET plan_id = NULL WHERE plan_id = ?").bind(planId),
    db.prepare("DELETE FROM pay_plans WHERE id = ?").bind(planId),
  ]);
}

// ---------- didn't pay ----------
// A payment that never came: it stays on record as lost (missed_on), stops counting as owed, and
// (unless they're only skipping this one) their service stops from its due date:
//   pause  → plans end the day before it's due, later plans and payments come off, open-ended break
//   finish → the same, then marked finished instead of a break
//   skip   → nothing else changes; their plan carries on
// Everything a stop changes is saved on the payment (missed_undo), so Undo, or "they paid after all",
// can put it back exactly as it was, as long as their plans haven't been changed since.
export const MISSED_NEXT = ["pause", "finish", "skip"];
const PLAN_ROW = [
  "id", "client_id", "kind", "programme_weeks", "billing", "price_pence", "instalments", "method", "day_of_month", "first_due",
  "start_date", "end_date", "then_action", "decided", "hours_per_month", "sessions_per_week", "session_minutes", "generated_through",
  "notes", "created_at", "updated_at",
];
const PAY_ROW = [
  "client_id", "schedule_id", "plan_id", "auto", "package", "programme_weeks", "amount_pence", "due_date", "method", "paid_date",
  "notes", "chased_at", "chase_count", "created_at", "updated_at",
];
const parseSnap = (s) => {
  try {
    const o = s ? JSON.parse(s) : null;
    return o && o.v === 1 ? o : null;
  } catch {
    return null;
  }
};

// What a plan's payments depend on. If any of this changes after a stop, the payments saved with the stop
// no longer match the plan, so it can't be put back automatically. (Notes, hours and the like don't count.)
const PLAN_SHAPE = ["kind", "billing", "price_pence", "instalments", "method", "day_of_month", "first_due", "start_date", "end_date", "programme_weeks", "created_at"];
const shape = (p, over = {}) => JSON.stringify(PLAN_SHAPE.map((k) => (k in over ? over[k] : p[k] ?? null)));

// Last day of service when the payment due on `due` doesn't come: the day before it's due, or the
// plan's first day when the very first payment is the one that didn't come.
export function missedEnd(plan, due) {
  const before = addDays(due, -1);
  return plan && plan.start_date > before ? plan.start_date : before;
}

// What stopping would change, worked out from the client's plans and payments (nothing is written).
// null = nothing to change (already on a break, or already finished by then).
function planStop(pay, client, plans, pays, mode) {
  const own = pay.plan_id ? plans.find((p) => p.id === pay.plan_id) : null;
  const cover = own || currentPlan(plans, pay.due_date);
  const end = missedEnd(cover && cover.kind !== "break" ? cover : null, pay.due_date);
  const reach = plans.filter((p) => !p.end_date || p.end_date > end); // plans that run past the last day
  if (mode === "pause" && !reach.some((p) => p.kind !== "break")) return null;
  if (mode === "finish" && !reach.length && client.finished_on && client.finished_on <= end) return null;
  const later = reach.filter((p) => p.start_date > end);
  // an open-ended break already starting the next day is exactly what pausing adds
  const keptBrk =
    mode === "pause" && later.length === 1 && later[0].kind === "break" && !later[0].end_date && later[0].start_date === addDays(end, 1) ? later[0] : null;
  const ending = reach.filter((p) => p.start_date <= end);
  const gone = later.filter((p) => p !== keptBrk);
  const open = (x) => x.auto === 1 && !x.paid_date && !x.missed_on && x.id !== pay.id;
  const offPays = [
    ...pays.filter((x) => open(x) && ending.some((p) => p.id === x.plan_id) && x.due_date > end),
    ...pays.filter((x) => open(x) && gone.some((p) => p.id === x.plan_id)),
  ];
  const blocked = gone.find((p) => pays.some((x) => x.plan_id === p.id && (x.paid_date || x.missed_on)));
  return { end, ending, gone, keptBrk, offPays, blocked };
}

export async function markMissed(db, pay, mode) {
  if (!MISSED_NEXT.includes(mode)) bad("Pick what happens next");
  if (pay.paid_date) bad("This payment is marked as paid");
  if (pay.missed_on) bad("This one's already down as didn't pay");
  const today = londonToday();
  if (pay.due_date > today) bad("This payment isn't due yet. To stop their service early, change their plan to a break.");
  const now = nowS();
  // `id` makes this snapshot unique, so every write below can check it belongs to the request that marked the
  // payment. Each plan's `shape` after the stop is saved too, which is how Undo knows nothing has changed since.
  const snap = { v: 1, id: crypto.randomUUID(), mode, stamp: now, end: null, plans: [], gone: [], pays: [], brk: null, kept: null, fin: null, finAfter: null };
  let stop = null;
  let client = null;
  if (mode !== "skip") {
    client = await db.prepare("SELECT * FROM pay_clients WHERE id = ?").bind(pay.client_id).first();
    const plans = (await db.prepare("SELECT * FROM pay_plans WHERE client_id = ? ORDER BY start_date, id").bind(pay.client_id).all()).results;
    const pays = (await db.prepare("SELECT * FROM pay_payments WHERE client_id = ?").bind(pay.client_id).all()).results;
    stop = planStop(pay, client, plans, pays, mode);
    if (!stop) snap.mode = "none";
    else {
      if (stop.blocked)
        bad(`Their plan starting ${ukDate(stop.blocked.start_date)} already has a payment marked paid or didn't pay, so their service can't be stopped from here. Change their plan instead.`);
      snap.end = stop.end;
      snap.plans = stop.ending.map((p) => ({
        id: p.id, created_at: p.created_at, end_date: p.end_date, then_action: p.then_action, decided: p.decided, updated_at: p.updated_at, shape: shape(p, { end_date: stop.end }),
      }));
      snap.pays = stop.offPays.map((x) => Object.fromEntries(PAY_ROW.map((c) => [c, x[c] ?? null])));
      snap.gone = stop.gone.map((p) => Object.fromEntries(PLAN_ROW.map((c) => [c, p[c] ?? null])));
      snap.kept = stop.keptBrk ? { id: stop.keptBrk.id, shape: shape(stop.keptBrk) } : null;
      if (mode === "pause" && !stop.keptBrk) snap.brk = await nextPlanId(db);
      snap.fin = client.finished_on || null;
      snap.finAfter = mode === "finish" ? stop.end : snap.fin;
    }
  }
  const json = JSON.stringify(snap);
  const mine = "EXISTS (SELECT 1 FROM pay_payments WHERE id = ? AND missed_undo = ?)";
  const g = (sql, ...binds) => db.prepare(`${sql} AND ${mine}`).bind(...binds, pay.id, json);
  // the payment goes first: if another request got there first this matches nothing, and so does everything after it
  const stmts = [
    db
      .prepare("UPDATE pay_payments SET missed_on = ?, missed_undo = ?, updated_at = ? WHERE id = ? AND paid_date IS NULL AND missed_on IS NULL")
      .bind(today, json, now, pay.id),
  ];
  if (stop) {
    for (const p of stop.ending) stmts.push(g("UPDATE pay_plans SET end_date = ?, then_action = NULL, updated_at = ? WHERE id = ?", stop.end, now, p.id));
    for (const x of stop.offPays) stmts.push(g(`DELETE FROM pay_payments WHERE id = ? AND ${OPEN}`, x.id));
    for (const p of stop.gone) stmts.push(g("DELETE FROM pay_plans WHERE id = ?", p.id));
    if (snap.brk)
      stmts.push(
        db
          .prepare(
            `INSERT INTO pay_plans (id, client_id, kind, billing, price_pence, method, start_date, notes, created_at, updated_at)
             SELECT ?, ?, 'break', 'none', 0, 'manual', ?, '', ?, ? WHERE ${mine}`
          )
          .bind(snap.brk, pay.client_id, addDays(stop.end, 1), now, now, pay.id, json)
      );
    if (mode === "finish") stmts.push(g("UPDATE pay_clients SET finished_on = ?, updated_at = ? WHERE id = ?", stop.end, now, pay.client_id));
  }
  await db.batch(stmts);
  const after = await db.prepare("SELECT missed_undo FROM pay_payments WHERE id = ?").bind(pay.id).first();
  if (!after || after.missed_undo !== json) bad("This payment has just been changed somewhere else. Pull down to refresh.");
  return snap;
}

// The break a pause added, as it was made (a plan reusing its id later won't look like this).
const brkShape = (snap) =>
  shape({ kind: "break", billing: "none", price_pence: 0, method: "manual", start_date: addDays(snap.end, 1), created_at: snap.stamp });

// Why a stop can't be put back automatically any more (null = it can). Each plan has to be the same plan
// (id and creation time) and still set up the same way as the stop left it, so an edit, a new plan reusing an
// id, or being marked finished since all count as a change.
export function undoProblem(snap, plans, client) {
  if (!snap || !snap.end || !["pause", "finish"].includes(snap.mode)) return "nothing to restart";
  const changed = "their plans have changed since";
  for (const s of snap.plans) {
    const p = plans.find((x) => x.id === s.id);
    if (!p || shape(p) !== s.shape) return changed;
  }
  const later = plans.filter((p) => p.start_date > snap.end);
  const want = snap.brk ? { id: snap.brk, shape: brkShape(snap) } : snap.kept;
  if (want) {
    const b = later.find((p) => p.id === want.id);
    if (later.length !== 1 || !b || shape(b) !== want.shape) return changed;
  } else if (later.length) return changed;
  if ((client?.finished_on || null) !== (snap.finAfter || null)) return changed;
  return null;
}

// Clear "didn't pay": `paidDate` set = they paid after all. With `restart`, the stop is put back too, exactly
// as it was, so an earlier stop underneath can still be undone after.
export async function unmarkMissed(db, pay, { paidDate = null, restart = true } = {}) {
  if (!pay.missed_on) bad("This payment isn't down as didn't pay");
  const now = nowS();
  const snap = parseSnap(pay.missed_undo);
  const json = pay.missed_undo;
  const mine = "EXISTS (SELECT 1 FROM pay_payments WHERE id = ? AND missed_undo IS ?)";
  const g = (sql, ...binds) => db.prepare(`${sql} AND ${mine}`).bind(...binds, pay.id, json);
  const guardedInsert = (table, cols, row, overrides) =>
    db
      .prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) SELECT ${cols.map(() => "?").join(", ")} WHERE ${mine}`)
      .bind(...cols.map((c) => (c in overrides ? overrides[c] : row[c] ?? null)), pay.id, json);
  const stmts = [];
  let restored = false;
  if (restart && snap && snap.end && ["pause", "finish"].includes(snap.mode)) {
    const client = await db.prepare("SELECT * FROM pay_clients WHERE id = ?").bind(pay.client_id).first();
    const plans = (await db.prepare("SELECT * FROM pay_plans WHERE client_id = ?").bind(pay.client_id).all()).results;
    if (!undoProblem(snap, plans, client)) {
      restored = true;
      for (const s of snap.plans)
        stmts.push(g("UPDATE pay_plans SET end_date = ?, then_action = ?, decided = ?, updated_at = ? WHERE id = ?", s.end_date, s.then_action, s.decided ?? 0, s.updated_at ?? now, s.id));
      if (snap.brk) stmts.push(g("DELETE FROM pay_plans WHERE id = ?", snap.brk));
      // plans that were taken off come back under their own id (a new one if it has been reused)
      const allIds = new Set((await db.prepare("SELECT id FROM pay_plans").all()).results.map((r) => r.id));
      let next = await nextPlanId(db);
      const idMap = {};
      for (const gp of snap.gone) {
        const id = allIds.has(gp.id) && gp.id !== snap.brk ? next++ : gp.id;
        idMap[gp.id] = id;
        stmts.push(guardedInsert("pay_plans", PLAN_ROW, gp, { id }));
      }
      for (const x of snap.pays) stmts.push(guardedInsert("pay_payments", PAY_ROW, x, { plan_id: idMap[x.plan_id] ?? x.plan_id }));
      if (snap.mode === "finish") stmts.push(g("UPDATE pay_clients SET finished_on = ?, updated_at = ? WHERE id = ?", snap.fin, now, pay.client_id));
    }
  }
  // the flag clears last, because everything above only runs while it's still set
  stmts.push(
    db.prepare("UPDATE pay_payments SET missed_on = NULL, missed_undo = NULL, paid_date = ?, updated_at = ? WHERE id = ? AND missed_undo IS ?").bind(paidDate, now, pay.id, json)
  );
  await db.batch(stmts);
  return { restored };
}

// What the app needs to know about a didn't-pay payment (the saved undo itself stays on the server).
// Plans are only named while they're still the same plans (same id and creation time).
export function missedInfo(pay, plans, client) {
  const snap = parseSnap(pay.missed_undo);
  const plan = (id) => plans.find((p) => p.id === id);
  // a break counts as the stop's break while it's still a break that starts the day after (its end can be set later)
  const isBrk = (p) => !!p && p.kind === "break" && p.start_date === addDays(snap.end, 1);
  const brk = !snap || !snap.end ? null : snap.brk ? plan(snap.brk) : snap.kept ? plan(snap.kept.id) : null;
  return {
    stop_mode: snap ? snap.mode : "none",
    stop_from: snap && snap.end ? addDays(snap.end, 1) : null,
    stop_plans: snap ? snap.plans.filter((s) => plan(s.id)?.created_at === s.created_at).map((s) => s.id) : [],
    stop_break: isBrk(brk) && (!snap.brk || brk.created_at === snap.stamp) ? brk.id : null,
    can_restart: !undoProblem(snap, plans, client),
  };
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
