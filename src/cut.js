// TrueStay Cut (/cut): Shan's own fat loss phase. Daily weigh-in, steps, calories and a workout tick,
// targets that change over the phase, and a weekly set of front / side / back photos.
//
// Same sign-in as TrueStay Pay: the app's routes are /api/pay/cut/* (see pay.js).
// Data lives in its own D1 database (binding CUT_DB):
//   cut_days     one row per day: weight (kg), steps, calories, protein (g), workout tick, the "hit it" ticks,
//                and day tags (bad sleep, salty food, drinks...) with a short note, to explain weigh-in jumps
//   cut_targets  steps / calories / protein / workouts-a-week, each row in force from its from_day until the next one,
//                so changing a target never rewrites how earlier weeks scored
//   cut_meta     settings: phase start, phase end, a loose goal weight
//   cut_waist    one waist measurement a week (cm), keyed by the Monday of that week
//   cut_lifts    the 3 or 4 main lifts being tracked (name, order; removing one hides it but keeps its history)
//   cut_sets     one top set a week per lift (kg x reps), keyed by the Monday of that week
//   cut_breaks   planned diet breaks: whole weeks (Monday to Sunday) at a maintenance calorie target.
//                Optionally they push the phase end back by the same number of weeks (extended = 1)
//   cut_photos   one photo per pose per week (weeks start on Monday). A new photo for the same week and pose replaces the old one
//   cut_blobs    the photos themselves, base64 in parts under 1 MB (D1 rows max out at 2 MB)

import { HttpError, bad, nowS, londonToday, isDate, addDays } from "./pay-util.js";

const PART = 1_000_000;
const MAX_B64 = 8 * 1024 * 1024; // photos are resized on the phone first, so this is generous
const POSES = ["front", "side", "back"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function fromB64(b64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// Monday of the week a date falls in
export function weekOf(day) {
  const d = new Date(day + "T12:00:00Z");
  const wd = (d.getUTCDay() + 6) % 7; // Mon = 0
  return addDays(day, -wd);
}

let ready = false;
async function ensureSchema(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS cut_days (
      day TEXT PRIMARY KEY, weight REAL, steps INTEGER, steps_hit INTEGER, kcal INTEGER, kcal_hit INTEGER, workout INTEGER,
      note TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS cut_targets (
      id INTEGER PRIMARY KEY, from_day TEXT NOT NULL UNIQUE, steps INTEGER, kcal INTEGER, workouts INTEGER, created_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE TABLE IF NOT EXISTS cut_meta (key TEXT PRIMARY KEY, value TEXT)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS cut_photos (
      id INTEGER PRIMARY KEY, week TEXT NOT NULL, pose TEXT NOT NULL, day TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
      w INTEGER, h INTEGER, ready INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE TABLE IF NOT EXISTS cut_blobs (photo_id INTEGER NOT NULL, part INTEGER NOT NULL, b64 TEXT NOT NULL, PRIMARY KEY (photo_id, part))"),
    db.prepare("CREATE INDEX IF NOT EXISTS cut_photos_week ON cut_photos(week, pose)"),
    db.prepare("CREATE TABLE IF NOT EXISTS cut_waist (week TEXT PRIMARY KEY, day TEXT NOT NULL, cm REAL NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS cut_breaks (
      id INTEGER PRIMARY KEY, from_day TEXT NOT NULL, to_day TEXT NOT NULL, weeks INTEGER NOT NULL, kcal INTEGER, extended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE TABLE IF NOT EXISTS cut_lifts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS cut_sets (
      week TEXT NOT NULL, lift_id INTEGER NOT NULL, day TEXT NOT NULL, kg REAL NOT NULL, reps INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (week, lift_id)
    )`),
  ]);
  // columns added after the first version
  const cols = async (t) => new Set((await db.prepare(`PRAGMA table_info(${t})`).all()).results.map((r) => r.name));
  const dc = await cols("cut_days");
  const tc = await cols("cut_targets");
  const add = [];
  if (!dc.has("protein")) add.push(db.prepare("ALTER TABLE cut_days ADD COLUMN protein INTEGER"));
  if (!dc.has("protein_hit")) add.push(db.prepare("ALTER TABLE cut_days ADD COLUMN protein_hit INTEGER"));
  if (!dc.has("tags")) add.push(db.prepare("ALTER TABLE cut_days ADD COLUMN tags TEXT NOT NULL DEFAULT ''"));
  if (!tc.has("protein")) add.push(db.prepare("ALTER TABLE cut_targets ADD COLUMN protein INTEGER"));
  if (add.length) await db.batch(add);
  ready = true;
}
export const DAY_TAGS = ["sleep", "salt", "drinks", "takeaway", "carbs", "late", "legs", "travel", "ill", "stress"];

async function getSettings(db) {
  const r = await db.prepare("SELECT value FROM cut_meta WHERE key = 'settings'").first();
  try {
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}

async function getState(db) {
  const [s, d, t, p, w, l, st, br] = await db.batch([
    db.prepare("SELECT value FROM cut_meta WHERE key = 'settings'"),
    db.prepare("SELECT day, weight, steps, steps_hit, kcal, kcal_hit, protein, protein_hit, workout, tags, note FROM cut_days ORDER BY day"),
    db.prepare("SELECT id, from_day, steps, kcal, protein, workouts FROM cut_targets ORDER BY from_day"),
    db.prepare("SELECT id, week, pose, day, bytes, w, h, created_at FROM cut_photos WHERE ready = 1 ORDER BY week, pose"),
    db.prepare("SELECT week, day, cm FROM cut_waist ORDER BY week"),
    db.prepare("SELECT id, name, sort, active FROM cut_lifts ORDER BY sort, id"),
    db.prepare("SELECT week, lift_id, day, kg, reps FROM cut_sets ORDER BY week, lift_id"),
    db.prepare("SELECT id, from_day, to_day, weeks, kcal, extended FROM cut_breaks ORDER BY from_day"),
  ]);
  let settings = null;
  try {
    settings = s.results[0] ? JSON.parse(s.results[0].value) : null;
  } catch {}
  return { today: londonToday(), settings, days: d.results, targets: t.results, photos: p.results, waist: w.results, lifts: l.results, sets: st.results, breaks: br.results };
}

// ---------- validation ----------
const has = (b, k) => Object.prototype.hasOwnProperty.call(b, k);
function numIn(v, min, max, label, round = 0) {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) bad(`${label} doesn't look right`);
  const f = 10 ** round;
  return Math.round(n * f) / f;
}
const tick = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
function cleanTargets(b) {
  return {
    steps: numIn(b.steps ?? null, 0, 60000, "The steps target"),
    kcal: numIn(b.kcal ?? null, 0, 8000, "The calorie target"),
    workouts: numIn(b.workouts ?? null, 0, 14, "The workouts target"),
    protein: numIn(b.protein ?? null, 0, 500, "The protein target"),
  };
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    bad("That didn't send properly. Try again.");
  }
}

export async function handleCut(req, env, url, path) {
  const db = env.CUT_DB;
  if (!db) throw new HttpError(500, "The Cut database isn't connected yet.");
  await ensureSchema(db);
  const method = req.method;
  const now = nowS();
  const today = londonToday();
  const state = async () => json({ ok: true, state: await getState(db) });
  let m;

  if (path === "/state" && method === "GET") return json(await getState(db));

  // ----- settings: phase start/end, loose goal weight. First save can carry the starting targets too.
  if (path === "/settings" && method === "POST") {
    const b = await readJson(req);
    const old = (await getSettings(db)) || {};
    const start = has(b, "start_date") ? b.start_date : old.start_date;
    const end = has(b, "end_date") ? b.end_date : old.end_date;
    if (!isDate(start)) bad("Pick when the phase starts");
    if (!isDate(end)) bad("Pick when the phase ends");
    if (end <= start) bad("The end has to be after the start");
    const goal = has(b, "goal_kg") ? numIn(b.goal_kg, 30, 300, "The goal weight", 1) : old.goal_kg ?? null;
    const waist_unit = has(b, "waist_unit") ? (b.waist_unit === "in" ? "in" : "cm") : old.waist_unit || "cm";
    const next = { start_date: start, end_date: end, goal_kg: goal, waist_unit };
    const stmts = [
      db
        .prepare("INSERT INTO cut_meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify(next)),
    ];
    if (b.targets) {
      const t = cleanTargets(b.targets);
      const first = await db.prepare("SELECT id FROM cut_targets ORDER BY from_day LIMIT 1").first();
      if (!first)
        stmts.push(
          db.prepare("INSERT INTO cut_targets (from_day, steps, kcal, protein, workouts, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(start, t.steps, t.kcal, t.protein, t.workouts, now)
        );
    }
    // the earliest targets always cover the start of the phase
    stmts.push(
      db
        .prepare("UPDATE cut_targets SET from_day = ? WHERE id = (SELECT id FROM cut_targets ORDER BY from_day LIMIT 1) AND from_day > ? AND NOT EXISTS (SELECT 1 FROM cut_targets WHERE from_day = ?)")
        .bind(start, start, start)
    );
    await db.batch(stmts);
    return state();
  }

  // ----- one day: send only the fields that changed; null clears one
  if ((m = path.match(/^\/days\/(\d{4}-\d{2}-\d{2})$/)) && method === "PUT") {
    const day = m[1];
    if (!isDate(day)) bad("That date isn't valid");
    if (day > today) bad("That day hasn't happened yet");
    const b = await readJson(req);
    const old = (await db.prepare("SELECT * FROM cut_days WHERE day = ?").bind(day).first()) || {};
    const row = {
      weight: has(b, "weight") ? numIn(b.weight, 30, 300, "That weight", 2) : old.weight ?? null,
      steps: has(b, "steps") ? numIn(b.steps, 0, 150000, "That step count") : old.steps ?? null,
      steps_hit: has(b, "steps_hit") ? tick(b.steps_hit) : old.steps_hit ?? null,
      kcal: has(b, "kcal") ? numIn(b.kcal, 0, 15000, "That calorie number") : old.kcal ?? null,
      kcal_hit: has(b, "kcal_hit") ? tick(b.kcal_hit) : old.kcal_hit ?? null,
      protein: has(b, "protein") ? numIn(b.protein, 0, 1000, "That protein number") : old.protein ?? null,
      protein_hit: has(b, "protein_hit") ? tick(b.protein_hit) : old.protein_hit ?? null,
      workout: has(b, "workout") ? tick(b.workout) : old.workout ?? null,
      tags: has(b, "tags") ? [...new Set((Array.isArray(b.tags) ? b.tags : []).filter((x) => DAY_TAGS.includes(x)))].join(",") : old.tags ?? "",
      note: has(b, "note") ? String(b.note ?? "").trim().slice(0, 500) : old.note ?? "",
    };
    const empty = ["weight", "steps", "steps_hit", "kcal", "kcal_hit", "protein", "protein_hit", "workout"].every((k) => row[k] == null) && !row.note && !row.tags;
    if (empty) await db.prepare("DELETE FROM cut_days WHERE day = ?").bind(day).run();
    else
      await db
        .prepare(
          `INSERT INTO cut_days (day, weight, steps, steps_hit, kcal, kcal_hit, protein, protein_hit, workout, tags, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET weight = excluded.weight, steps = excluded.steps, steps_hit = excluded.steps_hit, kcal = excluded.kcal,
             kcal_hit = excluded.kcal_hit, protein = excluded.protein, protein_hit = excluded.protein_hit, workout = excluded.workout,
             tags = excluded.tags, note = excluded.note, updated_at = excluded.updated_at`
        )
        .bind(day, row.weight, row.steps, row.steps_hit, row.kcal, row.kcal_hit, row.protein, row.protein_hit, row.workout, row.tags, row.note, now)
        .run();
    return state();
  }

  // ----- targets: a change applies from a day onwards (usually today); earlier days keep the old ones
  if (path === "/targets" && method === "POST") {
    const b = await readJson(req);
    const from = b.from_day || today;
    if (!isDate(from)) bad("Pick when the new targets start");
    const t = cleanTargets(b);
    const settings = await getSettings(db);
    const first = await db.prepare("SELECT from_day FROM cut_targets ORDER BY from_day LIMIT 1").first();
    const day = first && from < first.from_day ? first.from_day : settings && from < settings.start_date ? settings.start_date : from;
    await db
      .prepare(
        `INSERT INTO cut_targets (from_day, steps, kcal, protein, workouts, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_day) DO UPDATE SET steps = excluded.steps, kcal = excluded.kcal, protein = excluded.protein, workouts = excluded.workouts`
      )
      .bind(day, t.steps, t.kcal, t.protein, t.workouts, now)
      .run();
    return state();
  }
  if ((m = path.match(/^\/targets\/(\d+)$/)) && method === "DELETE") {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM cut_targets").first();
    if (n.n <= 1) bad("You need at least one set of targets");
    const first = await db.prepare("SELECT id FROM cut_targets ORDER BY from_day LIMIT 1").first();
    if (first.id === Number(m[1])) bad("That's your starting targets. Change them instead.");
    await db.prepare("DELETE FROM cut_targets WHERE id = ?").bind(Number(m[1])).run();
    return state();
  }

  // ----- weekly waist: one a week, saved against the Monday of the week the day falls in. cm: null clears it
  if ((m = path.match(/^\/waist\/(\d{4}-\d{2}-\d{2})$/)) && method === "PUT") {
    const day = m[1];
    if (!isDate(day)) bad("That date isn't valid");
    if (day > today) bad("That day hasn't happened yet");
    const b = await readJson(req);
    const cm = numIn(b.cm ?? null, 40, 200, "That waist measurement", 1);
    const week = weekOf(day);
    if (cm == null) await db.prepare("DELETE FROM cut_waist WHERE week = ?").bind(week).run();
    else
      await db
        .prepare("INSERT INTO cut_waist (week, day, cm, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(week) DO UPDATE SET day = excluded.day, cm = excluded.cm, updated_at = excluded.updated_at")
        .bind(week, day, cm, now)
        .run();
    return state();
  }

  // ----- strength: the main lifts, and one top set a week for each
  if (path === "/lifts" && method === "POST") {
    // add one or more lifts by name; a name that's already there (even removed) comes back instead of doubling up
    const b = await readJson(req);
    const names = (Array.isArray(b.names) ? b.names : [b.name]).map((n) => String(n ?? "").trim().slice(0, 40)).filter(Boolean);
    if (!names.length) bad("Name the lift");
    const have = (await db.prepare("SELECT id, name, active FROM cut_lifts").all()).results;
    const live = have.filter((x) => x.active).length;
    const fresh = names.filter((n) => !have.some((x) => x.active && x.name.toLowerCase() === n.toLowerCase()));
    if (live + fresh.length > 6) bad("Six lifts at most. Keep it to the ones that matter.");
    let sort = (await db.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM cut_lifts").first()).m;
    const stmts = [];
    for (const n of fresh) {
      const old = have.find((x) => !x.active && x.name.toLowerCase() === n.toLowerCase());
      sort += 1;
      if (old) stmts.push(db.prepare("UPDATE cut_lifts SET active = 1, sort = ? WHERE id = ?").bind(sort, old.id));
      else stmts.push(db.prepare("INSERT INTO cut_lifts (name, sort, active, created_at) VALUES (?, ?, 1, ?)").bind(n, sort, now));
    }
    if (stmts.length) await db.batch(stmts);
    return state();
  }
  if ((m = path.match(/^\/lifts\/(\d+)$/)) && method === "PUT") {
    const b = await readJson(req);
    const id = Number(m[1]);
    const old = await db.prepare("SELECT * FROM cut_lifts WHERE id = ?").bind(id).first();
    if (!old) bad("That lift has gone. Pull down to refresh.");
    const name = has(b, "name") ? String(b.name ?? "").trim().slice(0, 40) || bad("Name the lift") : old.name;
    const active = has(b, "active") ? (b.active ? 1 : 0) : old.active;
    await db.prepare("UPDATE cut_lifts SET name = ?, active = ? WHERE id = ?").bind(name, active, id).run();
    return state();
  }
  if ((m = path.match(/^\/sets\/(\d{4}-\d{2}-\d{2})\/(\d+)$/)) && method === "PUT") {
    const day = m[1];
    const liftId = Number(m[2]);
    if (!isDate(day)) bad("That date isn't valid");
    if (day > today) bad("That day hasn't happened yet");
    if (!(await db.prepare("SELECT 1 FROM cut_lifts WHERE id = ?").bind(liftId).first())) bad("That lift has gone. Pull down to refresh.");
    const b = await readJson(req);
    const week = weekOf(day);
    const kg = numIn(b.kg ?? null, 0, 500, "That weight", 2);
    const reps = numIn(b.reps ?? null, 1, 50, "That number of reps");
    if (kg == null || reps == null) await db.prepare("DELETE FROM cut_sets WHERE week = ? AND lift_id = ?").bind(week, liftId).run();
    else
      await db
        .prepare(
          `INSERT INTO cut_sets (week, lift_id, day, kg, reps, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(week, lift_id) DO UPDATE SET day = excluded.day, kg = excluded.kg, reps = excluded.reps, updated_at = excluded.updated_at`
        )
        .bind(week, liftId, day, kg, reps, now)
        .run();
    return state();
  }

  // ----- diet breaks: 1 to 3 whole weeks at maintenance, never overlapping
  if (path === "/breaks" && method === "POST") {
    const b = await readJson(req);
    if (!isDate(b.from_day)) bad("Pick when the break starts");
    const from = weekOf(b.from_day);
    const weeks = Number(b.weeks);
    if (![1, 2, 3].includes(weeks)) bad("A break is 1, 2 or 3 weeks");
    const to = addDays(from, weeks * 7 - 1);
    const kcal = numIn(b.kcal ?? null, 1000, 8000, "The maintenance calories");
    const clash = await db.prepare("SELECT from_day FROM cut_breaks WHERE from_day <= ? AND to_day >= ?").bind(to, from).first();
    if (clash) bad("That overlaps a break you've already planned");
    const settings = await getSettings(db);
    if (!settings) bad("Set up the phase first");
    if (from < weekOf(settings.start_date)) bad("That's before the phase started");
    const extend = !!b.extend;
    const stmts = [
      db.prepare("INSERT INTO cut_breaks (from_day, to_day, weeks, kcal, extended, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(from, to, weeks, kcal, extend ? 1 : 0, now),
    ];
    if (extend)
      stmts.push(
        db
          .prepare("INSERT INTO cut_meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(JSON.stringify({ ...settings, end_date: addDays(settings.end_date, weeks * 7) }))
      );
    await db.batch(stmts);
    return state();
  }
  if ((m = path.match(/^\/breaks\/(\d+)$/)) && method === "DELETE") {
    const br = await db.prepare("SELECT * FROM cut_breaks WHERE id = ?").bind(Number(m[1])).first();
    if (!br) bad("That break has gone. Pull down to refresh.");
    const stmts = [db.prepare("DELETE FROM cut_breaks WHERE id = ?").bind(br.id)];
    const settings = await getSettings(db);
    if (br.extended && settings)
      stmts.push(
        db
          .prepare("INSERT INTO cut_meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(JSON.stringify({ ...settings, end_date: addDays(settings.end_date, -br.weeks * 7) }))
      );
    await db.batch(stmts);
    return state();
  }

  // ----- weekly photos
  if (path === "/photos" && method === "POST") {
    const b = await readJson(req);
    const pose = POSES.includes(b.pose) ? b.pose : bad("Pick front, side or back");
    const day = isDate(b.day) ? b.day : today;
    if (day > today) bad("That day hasn't happened yet");
    const week = weekOf(day);
    const data = String(b.data || "").replace(/^data:[^,]+,/, "");
    if (!data || data.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) bad("That photo didn't come through. Try again.");
    const mime = /^image\/(jpeg|png|webp)$/.test(b.mime || "") ? b.mime : "image/jpeg";
    const r = await db
      .prepare("INSERT INTO cut_photos (week, pose, day, mime, bytes, w, h, ready, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING id")
      .bind(week, pose, day, mime, Math.round((data.length * 3) / 4), Number(b.w) || null, Number(b.h) || null, now)
      .first();
    const id = r.id;
    const stmts = [];
    for (let i = 0, p = 0; i < data.length; i += PART, p++) stmts.push(db.prepare("INSERT INTO cut_blobs (photo_id, part, b64) VALUES (?, ?, ?)").bind(id, p, data.slice(i, i + PART)));
    try {
      await db.batch(stmts);
    } catch (e) {
      await db.batch([db.prepare("DELETE FROM cut_blobs WHERE photo_id = ?").bind(id), db.prepare("DELETE FROM cut_photos WHERE id = ?").bind(id)]);
      throw e;
    }
    // swap in the new one, then clear out whatever it replaced
    const old = (await db.prepare("SELECT id FROM cut_photos WHERE week = ? AND pose = ? AND id != ?").bind(week, pose, id).all()).results.map((x) => x.id);
    await db.batch([
      db.prepare("UPDATE cut_photos SET ready = 1 WHERE id = ?").bind(id),
      ...old.flatMap((o) => [db.prepare("DELETE FROM cut_blobs WHERE photo_id = ?").bind(o), db.prepare("DELETE FROM cut_photos WHERE id = ?").bind(o)]),
    ]);
    return json({ ok: true, id, replaced: old.length > 0, state: await getState(db) });
  }
  if ((m = path.match(/^\/photos\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === "GET") {
      const ph = await db.prepare("SELECT mime FROM cut_photos WHERE id = ? AND ready = 1").bind(id).first();
      if (!ph) throw new HttpError(404, "Not found");
      const { results } = await db.prepare("SELECT b64 FROM cut_blobs WHERE photo_id = ? ORDER BY part").bind(id).all();
      // each photo id is never reused for different content, so it can be cached for good
      return new Response(fromB64(results.map((x) => x.b64).join("")), {
        headers: { "content-type": ph.mime, "cache-control": "private, max-age=31536000, immutable" },
      });
    }
    if (method === "DELETE") {
      await db.batch([db.prepare("DELETE FROM cut_blobs WHERE photo_id = ?").bind(id), db.prepare("DELETE FROM cut_photos WHERE id = ?").bind(id)]);
      return state();
    }
  }

  throw new HttpError(404, "Not found");
}

// tidy anything left half-uploaded (called from the hourly cron)
export async function cutCron(env) {
  const db = env.CUT_DB;
  if (!db) return;
  await ensureSchema(db);
  const stale = (await db.prepare("SELECT id FROM cut_photos WHERE ready = 0 AND created_at < ?").bind(nowS() - 3600).all()).results.map((x) => x.id);
  for (const id of stale) {
    await db.batch([db.prepare("DELETE FROM cut_blobs WHERE photo_id = ?").bind(id), db.prepare("DELETE FROM cut_photos WHERE id = ?").bind(id)]);
  }
}
