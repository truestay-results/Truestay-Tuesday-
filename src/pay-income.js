// TrueStay Pay — other income (anything that isn't a client's plan: classes, online sales, affiliate, another job).
//
// A source is where the money comes from ("Sunday bootcamp", "Gym cover shifts"). It's either a one-off or
// repeats every month on a set day. Each expected amount is its own row in pay_income, like client payments:
// received_date set = received, else due_date < today = late, else expected.
// Monthly sources make their rows up to the end of next month (same as client plans). Stopping a source only
// removes its rows that aren't received and aren't due yet.

import { bad, nowS, londonToday, isDate, addDays, occurrence, endOfNextMonth, pence, oneOf, text, idFrom } from "./pay-util.js";

export const INCOME_TYPES = ["classes", "online", "products", "affiliate", "job", "other"];
const REPEATS = ["none", "monthly"];

let ready = false;
export async function ensureIncomeSchema(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS pay_income_sources (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'other', amount_pence INTEGER NOT NULL DEFAULT 0,
      repeat TEXT NOT NULL DEFAULT 'none', day_of_month INTEGER, start_date TEXT NOT NULL, end_date TEXT, generated_through TEXT,
      notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pay_income (
      id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, auto INTEGER NOT NULL DEFAULT 0, amount_pence INTEGER NOT NULL,
      due_date TEXT NOT NULL, received_date TEXT, notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS pay_income_source_due ON pay_income(source_id, due_date) WHERE auto = 1"),
    db.prepare("CREATE INDEX IF NOT EXISTS pay_income_due ON pay_income(due_date)"),
  ]);
  ready = true;
}

export async function generateIncome(db) {
  const today = londonToday();
  const horizon = endOfNextMonth(today);
  const { results } = await db
    .prepare(
      `SELECT * FROM pay_income_sources WHERE repeat = 'monthly' AND (generated_through IS NULL OR generated_through < ?)
       AND (end_date IS NULL OR generated_through IS NULL OR generated_through < end_date)`
    )
    .bind(horizon)
    .all();
  if (!results.length) return;
  const now = nowS();
  const stmts = [];
  for (const s of results) {
    const from = s.generated_through ? addDays(s.generated_through, 1) : s.start_date;
    const limit = s.end_date && s.end_date < horizon ? s.end_date : horizon;
    let [y, m] = from.split("-").map(Number);
    for (let k = 0; k < 36; k++) {
      const d = occurrence(y, m, s.day_of_month);
      if (d > limit) break;
      if (d >= from && d >= s.start_date) stmts.push(insertAuto(db, s.id, s.amount_pence, d, now));
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    stmts.push(db.prepare("UPDATE pay_income_sources SET generated_through = ? WHERE id = ?").bind(horizon, s.id));
  }
  await db.batch(stmts);
}
const insertAuto = (db, sid, amount, due, now) =>
  db
    .prepare("INSERT OR IGNORE INTO pay_income (source_id, auto, amount_pence, due_date, received_date, notes, created_at, updated_at) VALUES (?, 1, ?, ?, NULL, '', ?, ?)")
    .bind(sid, amount, due, now, now);

function cleanSource(b) {
  const name = text(b.name, 80);
  if (!name) bad("Give it a name");
  const type = oneOf(b.type || "other", INCOME_TYPES, "Pick a type");
  const repeat = oneOf(b.repeat || "none", REPEATS, "Pick how often");
  const amount_pence = pence(b.amount_pence);
  if (amount_pence <= 0) bad("Enter the amount");
  if (!isDate(b.start_date)) bad(repeat === "monthly" ? "Pick when it starts" : "Pick the date");
  let day_of_month = null;
  if (repeat === "monthly") {
    day_of_month = b.day_of_month ? Number(b.day_of_month) : Number(b.start_date.slice(8, 10));
    if (!Number.isInteger(day_of_month) || day_of_month < 1 || day_of_month > 31) bad("Pick a day of the month");
  }
  const end_date = b.end_date ? (isDate(b.end_date) ? b.end_date : bad("The end date isn't valid")) : null;
  if (end_date && end_date < b.start_date) bad("The end date is before the start");
  return { name, type, repeat, amount_pence, day_of_month, start_date: b.start_date, end_date: repeat === "monthly" ? end_date : null, notes: text(b.notes, 1000) };
}
function cleanEntry(b) {
  if (!isDate(b.due_date)) bad("Pick a date");
  if (b.received_date != null && b.received_date !== "" && !isDate(b.received_date)) bad("The received date isn't valid");
  const amount_pence = pence(b.amount_pence);
  if (amount_pence <= 0) bad("Enter the amount");
  return { amount_pence, due_date: b.due_date, received_date: b.received_date || null, notes: text(b.notes, 1000) };
}

// Returns true if it handled the route. `done()` builds the response with fresh data.
export async function handleIncome(db, path, method, body, done) {
  let m;
  const now = nowS();
  if (path === "/income/sources" && method === "POST") {
    const b = await body();
    const s = cleanSource(b);
    const r = await db
      .prepare(
        `INSERT INTO pay_income_sources (name, type, amount_pence, repeat, day_of_month, start_date, end_date, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .bind(s.name, s.type, s.amount_pence, s.repeat, s.day_of_month, s.start_date, s.end_date, s.notes, now, now)
      .first();
    if (s.repeat === "none") {
      const rec = b.received ? (isDate(b.received_date) ? b.received_date : s.start_date) : null;
      await db
        .prepare("INSERT INTO pay_income (source_id, auto, amount_pence, due_date, received_date, notes, created_at, updated_at) VALUES (?, 0, ?, ?, ?, '', ?, ?)")
        .bind(r.id, s.amount_pence, s.start_date, rec, now, now)
        .run();
    }
    return done();
  }
  if ((m = path.match(/^\/income\/sources\/(\d+)(\/stop)?$/))) {
    const id = idFrom(m[1]);
    const old = await db.prepare("SELECT * FROM pay_income_sources WHERE id = ?").bind(id).first();
    if (!old) bad("That income source has gone. Pull down to refresh.");
    if (m[2] && method === "POST") {
      // stop a monthly source from a date: nothing after it, received ones stay
      const b = await body();
      const date = isDate(b.date) ? b.date : londonToday();
      await db.batch([
        db.prepare("UPDATE pay_income_sources SET end_date = ?, updated_at = ? WHERE id = ?").bind(date, now, id),
        db.prepare("DELETE FROM pay_income WHERE source_id = ? AND auto = 1 AND received_date IS NULL AND due_date > ?").bind(id, date),
      ]);
      return done();
    }
    if (!m[2] && method === "PUT") {
      const b = await body();
      const s = cleanSource({ ...old, ...b, repeat: old.repeat });
      const stmts = [
        db
          .prepare("UPDATE pay_income_sources SET name = ?, type = ?, amount_pence = ?, day_of_month = ?, start_date = ?, end_date = ?, notes = ?, updated_at = ? WHERE id = ?")
          .bind(s.name, s.type, s.amount_pence, s.day_of_month, s.start_date, s.end_date, s.notes, now, id),
      ];
      if (old.repeat === "monthly") {
        // unreceived rows from today on follow the new amount and day
        const today = londonToday();
        stmts.push(db.prepare("DELETE FROM pay_income WHERE source_id = ? AND auto = 1 AND received_date IS NULL AND due_date >= ?").bind(id, today));
        stmts.push(db.prepare("UPDATE pay_income_sources SET generated_through = ? WHERE id = ?").bind(addDays(today, -1), id));
        if (s.end_date) stmts.push(db.prepare("DELETE FROM pay_income WHERE source_id = ? AND auto = 1 AND received_date IS NULL AND due_date > ?").bind(id, s.end_date));
      }
      await db.batch(stmts);
      return done();
    }
    if (!m[2] && method === "DELETE") {
      const got = await db.prepare("SELECT COUNT(*) AS n FROM pay_income WHERE source_id = ? AND received_date IS NOT NULL").bind(id).first();
      if (got.n) bad("Some of this has been received, so it stays in your history. Stop it instead.");
      await db.batch([
        db.prepare("DELETE FROM pay_income WHERE source_id = ?").bind(id),
        db.prepare("DELETE FROM pay_income_sources WHERE id = ?").bind(id),
      ]);
      return done();
    }
  }
  if (path === "/income" && method === "POST") {
    const b = await body();
    const sid = idFrom(b.source_id);
    if (!(await db.prepare("SELECT 1 FROM pay_income_sources WHERE id = ?").bind(sid).first())) bad("Pick where it's from");
    const e = cleanEntry(b);
    await db
      .prepare("INSERT INTO pay_income (source_id, auto, amount_pence, due_date, received_date, notes, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?)")
      .bind(sid, e.amount_pence, e.due_date, e.received_date, e.notes, now, now)
      .run();
    return done();
  }
  if ((m = path.match(/^\/income\/(\d+)(\/received)?$/))) {
    const id = idFrom(m[1]);
    const old = await db.prepare("SELECT * FROM pay_income WHERE id = ?").bind(id).first();
    if (!old) bad("That entry has gone. Pull down to refresh.");
    if (m[2] && method === "POST") {
      const b = await body();
      const d = b.received_date === null ? null : b.received_date || londonToday();
      if (d !== null && !isDate(d)) bad("The received date isn't valid");
      await db.prepare("UPDATE pay_income SET received_date = ?, updated_at = ? WHERE id = ?").bind(d, now, id).run();
      return done();
    }
    if (!m[2] && method === "PUT") {
      const e = cleanEntry(await body());
      try {
        await db
          .prepare("UPDATE pay_income SET amount_pence = ?, due_date = ?, received_date = ?, notes = ?, updated_at = ? WHERE id = ?")
          .bind(e.amount_pence, e.due_date, e.received_date, e.notes, now, id)
          .run();
      } catch (err) {
        if (/UNIQUE/i.test(String(err && err.message))) bad("There's already one from this source on that date.");
        throw err;
      }
      return done();
    }
    if (!m[2] && method === "DELETE") {
      await db.prepare("DELETE FROM pay_income WHERE id = ?").bind(id).run();
      return done();
    }
  }
  return null;
}
