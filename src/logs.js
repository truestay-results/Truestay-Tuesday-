// TrueStay Logs: the food and step screenshots clients send each night, sorted into one PDF per client (/logs)
//
// Getting screenshots in
//  - WhatsApp share button: an iPhone Shortcut posts each picture to /api/logs/upload?k=KEY and gets the
//    client list from /api/logs/clients?k=KEY. KEY is made in the app (Settings) and kept in logs_meta.
//  - The app itself (Add screenshots) posts compressed JPEGs to /api/pay/logs/upload, signed in with the
//    TrueStay Pay account (same email, password and Face ID).
//
// Then
//  - Pictures are held in D1 (binding LOGS_DB) as base64 text in parts under 1 MB, until they go in a PDF.
//    (base64 because D1 hands BLOBs back as arrays of numbers, which is slow; base64 also goes straight to the AI.)
//  - Workers AI (binding AI) reads each one: what it shows, the date on it, calories, macros, steps.
//  - Which day a screenshot belongs to is worked out in the app from what was read plus when it was sent
//    (see effDay in public/logs/app.js), unless you set it yourself.
//  - The app shows everything by client and day and makes the PDF on the phone.
//  - The hourly cron reads anything missed and deletes pictures 14 days after they went in a PDF (90 days max).

import { HttpError, bad, nowS, text, isDate } from "./pay-util.js";

const PART = 1_000_000; // base64 characters per stored part (D1 rows max out at 2 MB)
const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_FILED_DAYS = 14;
const KEEP_ANY_DAYS = 90;
const SORT_LATER = "Sort later";
const KINDS = ["food", "steps", "food_steps", "weight", "other"];

// Vision models on Workers AI, best first. The first one that answers with usable JSON wins.
const MODELS = [
  { id: "@cf/google/gemma-4-26b-a4b-it", extra: { chat_template_kwargs: { enable_thinking: false } } },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", extra: {} },
];

const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const plain = (msg, status = 200) => new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256hex = async (s) => hex(await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc.encode(s) : s));
const safeJSON = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
export function toB64(u8) {
  if (typeof u8.toBase64 === "function") return u8.toBase64();
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ---------- schema ----------
let schemaReady = false;
export async function ensureLogsSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS logs_items (
      id INTEGER PRIMARY KEY,
      client_id INTEGER,
      client_name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'app',
      batch_key TEXT NOT NULL DEFAULT '',
      orig_name TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      w INTEGER,
      h INTEGER,
      sha TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      sent_at INTEGER,
      sent_src TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      read_tries INTEGER NOT NULL DEFAULT 0,
      read_at INTEGER,
      read_error TEXT,
      reading TEXT,
      day TEXT,
      day_src TEXT,
      kind TEXT,
      app TEXT,
      kcal REAL,
      protein REAL,
      carbs REAL,
      fat REAL,
      steps INTEGER,
      kcal_goal REAL,
      partial INTEGER NOT NULL DEFAULT 0,
      extras TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      edited INTEGER NOT NULL DEFAULT 0,
      filed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS logs_items_client ON logs_items(client_id, filed_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS logs_items_sha ON logs_items(sha)"),
    db.prepare("CREATE INDEX IF NOT EXISTS logs_items_status ON logs_items(status, received_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS logs_items_filed ON logs_items(filed_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS logs_blobs (item_id INTEGER NOT NULL, part INTEGER NOT NULL, b64 TEXT NOT NULL, PRIMARY KEY (item_id, part))"),
    db.prepare("CREATE TABLE IF NOT EXISTS logs_meta (key TEXT PRIMARY KEY, value TEXT)"),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS logs_targets (client_id INTEGER PRIMARY KEY, kcal INTEGER, protein INTEGER, steps INTEGER, updated_at INTEGER NOT NULL)"
    ),
  ]);
  schemaReady = true;
}

// ---------- pictures ----------
// Type and size from the first bytes. HEIC is recognised so we can say what to do about it.
export function imageInfo(u8) {
  const n = u8.length;
  const at = (i) => (i < n ? u8[i] : 0);
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { mime: "image/png", w: (at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19), h: (at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23) };
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (at(i) !== 0xff) {
        i++;
        continue;
      }
      const m = at(i + 1);
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { mime: "image/jpeg", h: (at(i + 5) << 8) | at(i + 6), w: (at(i + 7) << 8) | at(i + 8) };
      }
      i += 2 + ((at(i + 2) << 8) | at(i + 3));
    }
    return { mime: "image/jpeg", w: null, h: null };
  }
  const str = (a, b) => String.fromCharCode(...u8.subarray(a, b));
  if (n > 30 && str(0, 4) === "RIFF" && str(8, 12) === "WEBP") {
    const c = str(12, 16);
    if (c === "VP8 ") return { mime: "image/webp", w: ((at(27) << 8) | at(26)) & 0x3fff, h: ((at(29) << 8) | at(28)) & 0x3fff };
    if (c === "VP8L")
      return { mime: "image/webp", w: 1 + (((at(22) & 0x3f) << 8) | at(21)), h: 1 + (((at(24) & 0x0f) << 10) | (at(23) << 2) | ((at(22) & 0xc0) >> 6)) };
    if (c === "VP8X") return { mime: "image/webp", w: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), h: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) };
    return { mime: "image/webp", w: null, h: null };
  }
  if (n > 12 && str(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(str(8, 12))) return { mime: "image/heic", w: null, h: null };
  if (n > 10 && str(0, 4) === "GIF8") return { mime: "image/gif", w: at(6) | (at(7) << 8), h: at(8) | (at(9) << 8) };
  return null;
}

// ---------- dates in file names ----------
// WhatsApp and phones often put the date and time in the file name, e.g.
// PHOTO-2026-09-21-21-34-12.jpg, "WhatsApp Image 2026-09-21 at 21.34.12.jpeg", IMG_20260921_213412.jpg, IMG-20260921-WA0012.jpg
function londonParts(epochS) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(epochS * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function londonToEpoch(y, mo, d, h, mi, s) {
  const want = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = want;
  for (let k = 0; k < 3; k++) {
    const p = londonParts(t / 1000);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    if (got === want) break;
    t += want - got;
  }
  return Math.floor(t / 1000);
}
export function dateFromName(name, now = nowS()) {
  const s = String(name || "");
  const pats = [
    [/(20\d\d)-(\d\d)-(\d\d)(?:\s+at\s+|[ _T-])(\d\d)[.:\-](\d\d)[.:\-](\d\d)/i, true],
    [/(20\d\d)(\d\d)(\d\d)[_-](\d\d)(\d\d)(\d\d)/, true],
    [/IMG-(20\d\d)(\d\d)(\d\d)-WA\d+/i, false],
    [/(20\d\d)-(\d\d)-(\d\d)/, false],
  ];
  for (const [re, hasTime] of pats) {
    const m = s.match(re);
    if (!m) continue;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const [h, mi, se] = hasTime ? [+m[4], +m[5], +m[6]] : [12, 0, 0];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) continue;
    const t = londonToEpoch(y, mo, d, h, mi, se);
    if (t > now + 86400 || t < now - 400 * 86400) continue;
    return { t, timeKnown: hasTime };
  }
  return null;
}

// ---------- storing ----------
async function clientsFromPay(env) {
  if (!env.PAY_DB) return [];
  try {
    const { results } = await env.PAY_DB.prepare("SELECT id, name, finished_on FROM pay_clients ORDER BY name COLLATE NOCASE").all();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    return results.map((c) => ({ id: c.id, name: c.name, finished: !!(c.finished_on && c.finished_on <= today) }));
  } catch {
    return [];
  }
}

export async function storeImage(env, { b64, clientId, clientName, source, name, lastModified }) {
  const db = env.LOGS_DB;
  if (!b64 || typeof b64 !== "string") bad("No picture came through");
  b64 = b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64.slice(0, 200)) || b64.length < 100) bad("That file isn't a picture");
  const info = imageInfo(fromB64(b64.slice(0, 87380)));
  if (!info) bad("That file isn't a picture");
  if (info.mime === "image/heic") bad("That's an iPhone HEIC photo. Add the Convert Image step to the Shortcut, or use Add screenshots in the app.");
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_BYTES) bad("That picture is too big (10 MB max)");
  const sha = await sha256hex(b64);
  const dup = await db.prepare("SELECT id, filed_at FROM logs_items WHERE sha = ? LIMIT 1").bind(sha).first();
  if (dup) return { id: dup.id, dup: true, filed: !!dup.filed_at };

  const now = nowS();
  let sent = dateFromName(name, now);
  let sentSrc = sent ? (sent.timeKnown ? "name" : "name_day") : null;
  const lm = Number(lastModified);
  if (!sent && Number.isFinite(lm) && lm > 0) {
    const t = Math.floor(lm / 1000);
    if (t < now - 180 && t > now - 400 * 86400) {
      sent = { t };
      sentSrc = "photo";
    }
  }
  const r = await db
    .prepare(
      `INSERT INTO logs_items (client_id, client_name, source, batch_key, orig_name, mime, bytes, w, h, sha, received_at, sent_at, sent_src, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`
    )
    .bind(
      clientId ?? null, clientName || "", source, `${source}:${clientId ?? "later"}`, text(name, 160), info.mime, bytes,
      info.w || null, info.h || null, sha, now, sent ? sent.t : null, sentSrc, now, now
    )
    .run();
  const id = r.meta.last_row_id;
  const stmts = [];
  for (let i = 0, p = 0; i < b64.length; i += PART, p++) {
    stmts.push(db.prepare("INSERT INTO logs_blobs (item_id, part, b64) VALUES (?,?,?)").bind(id, p, b64.slice(i, i + PART)));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    await db.prepare("DELETE FROM logs_items WHERE id = ?").bind(id).run();
    throw e;
  }
  return { id, dup: false };
}

async function loadB64(db, id) {
  const { results } = await db.prepare("SELECT b64 FROM logs_blobs WHERE item_id = ? ORDER BY part").bind(id).all();
  return results.map((p) => p.b64).join("");
}

// ---------- reading ----------
const SYSTEM = `You read screenshots that a personal trainer's clients send him each night: food diaries (MyFitnessPal, Nutracheck, MacroFactor, Cronometer, Lose It, Carb Manager, Samsung Health and others) and step or activity screens (Apple Health, Apple Fitness, Google Fit, Samsung Health, Fitbit, Garmin, Strava, pedometer apps).
Read only what is actually on the screen. Never guess, estimate or add up numbers that are not shown as a total. Reply with one JSON object and nothing else.`;

const PROMPT = `Read this screenshot and fill in this JSON. Use null for anything that is not on the screen.
{
  "kind": "food" | "steps" | "food_steps" | "weight" | "other",
  "app": "name of the app if you can tell, else null",
  "date_shown": "the date label exactly as written on the screen, e.g. Today, Yesterday, Mon 21 Sep, 21/09/2026. Not the status bar clock. null if none",
  "date": "that date as YYYY-MM-DD if a year is printed, MM-DD if only day and month are printed, null for Today/Yesterday/weekday-only labels",
  "clock": "the time in the phone status bar at the very top, HH:MM 24 hour, or null",
  "calories": "total calories EATEN that day (the food total). Not the goal, not calories remaining, not calories burned",
  "calorie_goal": "the daily calorie goal or budget if shown",
  "protein_g": "the day's total protein in grams if shown (not a single meal, not a goal)",
  "carbs_g": "the day's total carbohydrate in grams if shown",
  "fat_g": "the day's total fat in grams if shown",
  "steps": "the day's step count if shown",
  "exercise_kcal": "calories burned by exercise or activity if shown",
  "extras": [{"label": "Water", "value": "2.1 L"}],
  "partial": "true if the screenshot is cut off before the day's totals",
  "note": "one short sentence a coach would want to know, e.g. Only breakfast and lunch logged. Empty string if nothing"
}
For extras give up to 4 other daily numbers worth a coach seeing, such as water, body weight, fibre, sugar, distance or sleep. Numbers as plain numbers without units, except inside extras values.`;

function textOf(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  if (typeof res.response === "string") return res.response;
  if (res.response && typeof res.response === "object") return JSON.stringify(res.response);
  const c = res.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  if (res.result) return textOf(res.result);
  return "";
}
export function parseJSONish(s) {
  if (!s) return null;
  const t = String(s).replace(/```(?:json)?/gi, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

async function askModel(env, model, dataUrl, withExtra) {
  const input = {
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 900,
    temperature: 0,
    ...(withExtra ? model.extra : {}),
  };
  return env.AI.run(model.id, input);
}

export async function askModels(env, dataUrl, models = MODELS) {
  const errors = [];
  for (const m of models) {
    for (const withExtra of Object.keys(m.extra || {}).length ? [true, false] : [false]) {
      try {
        const res = await askModel(env, m, dataUrl, withExtra);
        const obj = parseJSONish(textOf(res));
        if (obj) return { reading: obj, model: m.id, raw: textOf(res).slice(0, 3000) };
        errors.push(`${m.id}: no JSON`);
        break; // it answered, just badly: try the next model
      } catch (e) {
        errors.push(`${m.id}${withExtra ? "+" : ""}: ${String((e && e.message) || e).slice(0, 160)}`);
      }
    }
  }
  throw new Error(errors.join(" | ") || "No model answered");
}

const toNum = (v, min, max, dp = 0) => {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]|kcal|cal|g$/gi, ""));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const fmtKcal = (n) => `${Math.round(n).toLocaleString("en-GB")} kcal`;

export function cleanReading(o) {
  o = o && typeof o === "object" ? o : {};
  let kind = String(o.kind || "").toLowerCase().replace(/[^a-z_]/g, "");
  if (kind === "foodsteps" || kind === "food_and_steps" || kind === "both") kind = "food_steps";
  if (!KINDS.includes(kind)) kind = "other";
  const s = (v, max) => (typeof v === "string" && v.trim() && !/^null$/i.test(v.trim()) ? v.trim().slice(0, max) : null);
  let date = s(o.date, 12);
  if (date && !/^(\d{4}-)?\d{2}-\d{2}$/.test(date)) date = null;
  let clock = s(o.clock, 8);
  if (clock) {
    const m = clock.match(/^(\d{1,2})[:.](\d{2})/);
    clock = m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
  }
  const extras = [];
  if (Array.isArray(o.extras)) {
    for (const e of o.extras.slice(0, 6)) {
      const label = s(e && e.label, 24);
      const value = s(e && e.value != null ? String(e.value) : null, 24);
      if (label && value && !extras.some((x) => x.label.toLowerCase() === label.toLowerCase())) extras.push({ label, value });
    }
  }
  const ex = toNum(o.exercise_kcal, 1, 6000);
  if (ex != null && !extras.some((x) => /exercise|burn|active/i.test(x.label))) extras.unshift({ label: "Exercise", value: fmtKcal(ex) });
  const r = {
    kind,
    app: s(o.app, 40),
    date_shown: s(o.date_shown, 40),
    date,
    clock,
    calories: toNum(o.calories, 0, 12000),
    calorie_goal: toNum(o.calorie_goal, 500, 8000),
    protein_g: toNum(o.protein_g, 0, 700, 1),
    carbs_g: toNum(o.carbs_g, 0, 1500, 1),
    fat_g: toNum(o.fat_g, 0, 600, 1),
    steps: toNum(o.steps, 0, 150000),
    extras: extras.slice(0, 4),
    partial: o.partial === true || o.partial === "true",
    note: s(o.note, 160) || "",
  };
  // a steps screen with no food numbers shouldn't claim food, and vice versa
  const hasFood = [r.calories, r.protein_g, r.carbs_g, r.fat_g].some((v) => v != null);
  if (r.kind === "food_steps" && !hasFood) r.kind = r.steps != null ? "steps" : "other";
  if (r.kind === "food_steps" && r.steps == null) r.kind = "food";
  if (r.kind === "steps" && hasFood && r.steps != null) r.kind = "food_steps";
  return r;
}

export async function readItem(env, id) {
  const db = env.LOGS_DB;
  const it = await db.prepare("SELECT * FROM logs_items WHERE id = ?").bind(id).first();
  if (!it) return null;
  const now = nowS();
  if (!env.AI) {
    await db.prepare("UPDATE logs_items SET status='failed', read_error=?, updated_at=? WHERE id=?").bind("Reading isn't switched on", now, id).run();
    return itemById(db, id);
  }
  await db.prepare("UPDATE logs_items SET read_tries = read_tries + 1 WHERE id = ?").bind(id).run();
  let out = null;
  let err = null;
  try {
    out = await askModels(env, `data:${it.mime};base64,${await loadB64(db, id)}`);
  } catch (e) {
    err = String((e && e.message) || e).slice(0, 300);
    console.error("logs read failed", id, err);
  }
  const t = nowS();
  if (!out) {
    await db.prepare("UPDATE logs_items SET status='failed', read_error=?, updated_at=? WHERE id=?").bind(err || "Couldn't read it", t, id).run();
    return itemById(db, id);
  }
  const r = cleanReading(out.reading);
  const reading = JSON.stringify({ date_shown: r.date_shown, date: r.date, clock: r.clock, model: out.model });
  if (it.edited) {
    await db.prepare("UPDATE logs_items SET status='read', read_at=?, read_error=NULL, reading=?, updated_at=? WHERE id=?").bind(t, reading, t, id).run();
  } else {
    await db
      .prepare(
        `UPDATE logs_items SET status='read', read_at=?, read_error=NULL, reading=?, kind=?, app=?, kcal=?, protein=?, carbs=?, fat=?, steps=?,
           kcal_goal=?, partial=?, extras=?, note=?, updated_at=? WHERE id=?`
      )
      .bind(t, reading, r.kind, r.app, r.calories, r.protein_g, r.carbs_g, r.fat_g, r.steps, r.calorie_goal, r.partial ? 1 : 0, JSON.stringify(r.extras), r.note, t, id)
      .run();
  }
  return itemById(db, id);
}

// ---------- shaping for the app ----------
const pub = (r) => ({
  id: r.id,
  client_id: r.client_id,
  client_name: r.client_name,
  source: r.source,
  batch: r.batch_key,
  name: r.orig_name,
  mime: r.mime,
  bytes: r.bytes,
  w: r.w,
  h: r.h,
  received_at: r.received_at,
  sent_at: r.sent_at,
  sent_src: r.sent_src,
  status: r.status,
  read_error: r.read_error,
  read_tries: r.read_tries,
  r: safeJSON(r.reading, null),
  day: r.day,
  day_src: r.day_src,
  kind: r.kind,
  app: r.app,
  kcal: r.kcal,
  protein: r.protein,
  carbs: r.carbs,
  fat: r.fat,
  steps: r.steps,
  kcal_goal: r.kcal_goal,
  partial: !!r.partial,
  extras: safeJSON(r.extras, []),
  note: r.note,
  edited: !!r.edited,
  filed_at: r.filed_at,
});
async function itemById(db, id) {
  const r = await db.prepare("SELECT * FROM logs_items WHERE id = ?").bind(id).first();
  return r ? pub(r) : null;
}

async function getKey(db) {
  const r = await db.prepare("SELECT value FROM logs_meta WHERE key = 'share_key'").first();
  return r ? r.value : null;
}
function newKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getState(env) {
  const db = env.LOGS_DB;
  const cutoff = nowS() - KEEP_FILED_DAYS * 86400;
  const [items, targets, usage, key, clients] = await Promise.all([
    db.prepare("SELECT * FROM logs_items WHERE filed_at IS NULL OR filed_at > ? ORDER BY received_at, id").bind(cutoff).all(),
    db.prepare("SELECT * FROM logs_targets").all(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM logs_items").first(),
    getKey(db),
    clientsFromPay(env),
  ]);
  const t = {};
  for (const r of targets.results) t[r.client_id] = { kcal: r.kcal, protein: r.protein, steps: r.steps };
  return {
    clients,
    items: items.results.map(pub),
    targets: t,
    key,
    usage: { count: usage.n, bytes: usage.bytes },
    keep: { filedDays: KEEP_FILED_DAYS, anyDays: KEEP_ANY_DAYS },
    now: nowS(),
  };
}

const idOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) bad("Bad id");
  return n;
};
const numIn = (v, min, max, dp = 0) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) bad("One of the numbers isn't valid");
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const isDay = (s) => isDate(s);

async function clientRef(env, v) {
  if (v === null || v === undefined || v === "" || v === "later") return { id: null, name: "" };
  const id = idOf(v);
  const c = env.PAY_DB ? await env.PAY_DB.prepare("SELECT id, name FROM pay_clients WHERE id = ?").bind(id).first() : null;
  if (!c) bad("That client isn't there any more");
  return { id: c.id, name: c.name };
}

// ---------- app routes: /api/pay/logs/* (already signed in and unlocked) ----------
export async function handleLogsApp(req, env, url, path, ctx) {
  const db = env.LOGS_DB;
  if (!db) throw new HttpError(500, "The logs database isn't connected");
  await ensureLogsSchema(db);
  const method = req.method;
  const body = async () => {
    try {
      const b = await req.json();
      return b && typeof b === "object" ? b : {};
    } catch {
      return {};
    }
  };
  let m;

  if (path === "/state" && method === "GET") return json(await getState(env));

  if ((m = path.match(/^\/img\/(\d+)$/)) && method === "GET") {
    const id = idOf(m[1]);
    const it = await db.prepare("SELECT mime FROM logs_items WHERE id = ?").bind(id).first();
    if (!it) throw new HttpError(404, "Not found");
    const b64 = await loadB64(db, id);
    return new Response(fromB64(b64), {
      headers: { "content-type": it.mime, "cache-control": "private, max-age=31536000, immutable" },
    });
  }

  if (path === "/upload" && method === "POST") {
    const b = await body();
    const c = await clientRef(env, b.client_id);
    const res = await storeImage(env, { b64: b.data, clientId: c.id, clientName: c.name, source: "app", name: b.name, lastModified: b.lm });
    if (!res.dup && ctx && ctx.waitUntil) ctx.waitUntil(readItem(env, res.id).catch(() => {}));
    return json({ ok: true, dup: res.dup, item: await itemById(db, res.id) });
  }

  if ((m = path.match(/^\/read\/(\d+)$/)) && method === "POST") {
    const item = await readItem(env, idOf(m[1]));
    if (!item) throw new HttpError(404, "That screenshot has gone");
    return json({ ok: true, item });
  }

  if ((m = path.match(/^\/items\/(\d+)$/)) && method === "POST") {
    const id = idOf(m[1]);
    const it = await db.prepare("SELECT * FROM logs_items WHERE id = ?").bind(id).first();
    if (!it) throw new HttpError(404, "That screenshot has gone");
    const b = await body();
    const sets = [];
    const vals = [];
    const set = (col, v) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if ("client_id" in b) {
      const c = await clientRef(env, b.client_id);
      set("client_id", c.id);
      set("client_name", c.name);
    }
    if ("day" in b) {
      if (b.day === null || b.day === "") {
        set("day", null);
        set("day_src", null);
      } else {
        if (!isDay(b.day)) bad("Pick a day");
        set("day", b.day);
        set("day_src", "manual");
      }
    }
    const numbers = [
      ["kcal", 0, 12000, 0],
      ["protein", 0, 700, 1],
      ["carbs", 0, 1500, 1],
      ["fat", 0, 600, 1],
      ["steps", 0, 150000, 0],
    ];
    let edited = false;
    for (const [k, min, max, dp] of numbers) {
      if (k in b) {
        set(k, numIn(b[k], min, max, dp));
        edited = true;
      }
    }
    if ("kind" in b) {
      if (!KINDS.includes(b.kind)) bad("Pick what the screenshot shows");
      set("kind", b.kind);
      edited = true;
    }
    if ("note" in b) set("note", text(b.note, 300));
    if (edited) set("edited", 1);
    if (!sets.length) bad("Nothing to change");
    set("updated_at", nowS());
    await db.prepare(`UPDATE logs_items SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
    return json({ ok: true, item: await itemById(db, id) });
  }

  if (path === "/bulk" && method === "POST") {
    const b = await body();
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(idOf))].slice(0, 500) : [];
    if (!ids.length) bad("Pick some screenshots first");
    const now = nowS();
    const ph = ids.map(() => "?").join(",");
    if (b.action === "delete") {
      await db.batch([
        db.prepare(`DELETE FROM logs_blobs WHERE item_id IN (${ph})`).bind(...ids),
        db.prepare(`DELETE FROM logs_items WHERE id IN (${ph})`).bind(...ids),
      ]);
    } else if (b.action === "client") {
      const c = await clientRef(env, b.client_id);
      await db.prepare(`UPDATE logs_items SET client_id = ?, client_name = ?, updated_at = ? WHERE id IN (${ph})`).bind(c.id, c.name, now, ...ids).run();
    } else if (b.action === "day") {
      if (b.day === null || b.day === "") {
        await db.prepare(`UPDATE logs_items SET day = NULL, day_src = NULL, updated_at = ? WHERE id IN (${ph})`).bind(now, ...ids).run();
      } else {
        if (!isDay(b.day)) bad("Pick a day");
        await db.prepare(`UPDATE logs_items SET day = ?, day_src = 'manual', updated_at = ? WHERE id IN (${ph})`).bind(b.day, now, ...ids).run();
      }
    } else if (b.action === "file") {
      await db.prepare(`UPDATE logs_items SET filed_at = ?, updated_at = ? WHERE id IN (${ph}) AND filed_at IS NULL`).bind(now, now, ...ids).run();
    } else if (b.action === "unfile") {
      await db.prepare(`UPDATE logs_items SET filed_at = NULL, updated_at = ? WHERE id IN (${ph})`).bind(now, ...ids).run();
    } else bad("Unknown action");
    return json({ ok: true, state: await getState(env) });
  }

  if (path === "/targets" && method === "POST") {
    const b = await body();
    const c = await clientRef(env, b.client_id);
    if (!c.id) bad("Pick a client");
    const kcal = numIn(b.kcal, 500, 8000);
    const protein = numIn(b.protein, 10, 600);
    const steps = numIn(b.steps, 500, 60000);
    if (kcal == null && protein == null && steps == null) {
      await db.prepare("DELETE FROM logs_targets WHERE client_id = ?").bind(c.id).run();
    } else {
      await db
        .prepare(
          `INSERT INTO logs_targets (client_id, kcal, protein, steps, updated_at) VALUES (?,?,?,?,?)
           ON CONFLICT(client_id) DO UPDATE SET kcal=excluded.kcal, protein=excluded.protein, steps=excluded.steps, updated_at=excluded.updated_at`
        )
        .bind(c.id, kcal, protein, steps, nowS())
        .run();
    }
    return json({ ok: true, state: await getState(env) });
  }

  if (path === "/key" && method === "POST") {
    const key = newKey();
    await db
      .prepare("INSERT INTO logs_meta (key, value) VALUES ('share_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key)
      .run();
    return json({ ok: true, key });
  }

  throw new HttpError(404, "Not found");
}

// ---------- share button routes: /api/logs/* (the iPhone Shortcut, key in ?k=) ----------
// TEMPORARY while tuning the reading: runs a model on one of the bundled test screenshots. Remove once tuned.
async function modelCheck(env, url) {
  const img = url.searchParams.get("img") || "a.jpg";
  if (!/^[a-f]\.jpg$/.test(img)) return plain("bad img", 400);
  const res = await env.ASSETS.fetch(new Request(new URL(`/logs/_test/${img}`, url)));
  if (!res.ok) return plain("no img", 404);
  const u8 = new Uint8Array(await res.arrayBuffer());
  const dataUrl = `data:image/jpeg;base64,${toB64(u8)}`;
  const t0 = Date.now();
  if (url.searchParams.get("mode") === "prod") {
    try {
      const out = await askModels(env, dataUrl);
      return json({ ms: Date.now() - t0, model: out.model, cleaned: cleanReading(out.reading), raw: out.raw.slice(0, 1200) });
    } catch (e) {
      return json({ ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 800) });
    }
  }
  const model = url.searchParams.get("m") || MODELS[0].id;
  let extra = {};
  try {
    extra = JSON.parse(url.searchParams.get("x") || "{}");
  } catch {}
  const content = url.searchParams.get("fmt") === "image"
    ? PROMPT
    : [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: dataUrl } }];
  const input = { messages: [{ role: "system", content: SYSTEM }, { role: "user", content }], ...extra };
  if (url.searchParams.get("fmt") === "image") input.image = dataUrl;
  try {
    const out = await env.AI.run(model, input);
    const text = textOf(out);
    const parsed = parseJSONish(text);
    return json({ ms: Date.now() - t0, model, text: text.slice(0, 1500), cleaned: parsed ? cleanReading(parsed) : null, usage: (out && out.usage) || null, keys: Object.keys(out || {}) });
  } catch (e) {
    return json({ ms: Date.now() - t0, model, error: String((e && e.message) || e).slice(0, 800) });
  }
}

export async function handleLogsShare(req, env, url, ctx) {
  if (url.pathname === "/api/logs/_modelcheck" && url.searchParams.get("t") === "sbPUd7RLFKxZ9NN9UEHhYq12") return modelCheck(env, url);
  try {
    const db = env.LOGS_DB;
    if (!db) return plain("The logs database isn't connected.", 500);
    await ensureLogsSchema(db);
    const given = url.searchParams.get("k") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const key = await getKey(db);
    if (!key || !given || !safeEqual(await sha256hex(given), await sha256hex(key))) {
      return plain("That link's key isn't right. Copy the links again from Logs, Settings, Share button.", 401);
    }
    const path = url.pathname.slice("/api/logs".length);

    if (path === "/clients" && req.method === "GET") {
      const names = (await clientsFromPay(env)).filter((c) => !c.finished).map((c) => c.name.replace(/[\r\n]+/g, " "));
      return plain([...names, SORT_LATER].join("\n"));
    }

    if (path === "/upload" && req.method === "POST") {
      const ct = (req.headers.get("content-type") || "").toLowerCase();
      let who = url.searchParams.get("client") || "";
      const files = [];
      if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
        const fd = await req.formData();
        for (const [k, v] of fd.entries()) {
          if (typeof v === "string") {
            if (/^(client|who)$/i.test(k) && !who) who = v;
          } else if (v && typeof v.arrayBuffer === "function") files.push({ name: v.name || "", u8: new Uint8Array(await v.arrayBuffer()) });
        }
      } else if (ct.startsWith("image/") || ct.includes("octet-stream")) {
        files.push({ name: url.searchParams.get("name") || "", u8: new Uint8Array(await req.arrayBuffer()) });
      } else if (ct.includes("application/json")) {
        const b = await req.json().catch(() => ({}));
        if (!who && b.client) who = String(b.client);
        if (b.data) files.push({ name: String(b.name || ""), b64: String(b.data) });
      }
      if (!files.length) return plain("No picture came through. Check the Shortcut sends the image as a File field.", 400);

      who = who.trim();
      let client = { id: null, name: "" };
      if (who && !/^sort later$/i.test(who)) {
        const match = (await clientsFromPay(env)).find((c) => c.name.trim().toLowerCase() === who.toLowerCase());
        client = match ? { id: match.id, name: match.name } : { id: null, name: who.slice(0, 80) };
      }
      let saved = 0;
      let dups = 0;
      const errors = [];
      for (const f of files) {
        try {
          if (f.u8 && f.u8.length > MAX_BYTES) bad("That picture is too big (10 MB max)");
          const res = await storeImage(env, {
            b64: f.b64 || toB64(f.u8), clientId: client.id, clientName: client.name, source: "share", name: f.name,
          });
          if (res.dup) dups++;
          else {
            saved++;
            if (ctx && ctx.waitUntil) ctx.waitUntil(readItem(env, res.id).catch(() => {}));
          }
        } catch (e) {
          errors.push(e instanceof HttpError ? e.message : "Couldn't save one of them.");
        }
      }
      const waiting = await db
        .prepare(`SELECT COUNT(*) AS n FROM logs_items WHERE filed_at IS NULL AND ${client.id ? "client_id = ?" : "client_id IS NULL"}`)
        .bind(...(client.id ? [client.id] : []))
        .first();
      const who2 = client.id ? client.name.split(/\s+/)[0] : "Sort later";
      if (errors.length && !saved && !dups) return plain(errors[0], 400);
      const parts = [];
      if (saved) parts.push(`Saved for ${who2}.`);
      if (dups) parts.push(dups === 1 ? "Already had that one." : `Already had ${dups} of those.`);
      if (errors.length) parts.push(errors[0]);
      parts.push(`${waiting.n} waiting.`);
      return plain(parts.join(" "));
    }
    return plain("Not found", 404);
  } catch (e) {
    console.error("logs share error", e && e.stack ? e.stack : e);
    return plain(e instanceof HttpError ? e.message : "Something went wrong saving that. Try again.", e instanceof HttpError ? e.status : 500);
  }
}

// ---------- hourly tidy-up ----------
export async function logsCron(env) {
  const db = env.LOGS_DB;
  if (!db) return;
  await ensureLogsSchema(db);
  const now = nowS();
  const old = await db
    .prepare("SELECT id FROM logs_items WHERE (filed_at IS NOT NULL AND filed_at < ?) OR received_at < ? LIMIT 200")
    .bind(now - KEEP_FILED_DAYS * 86400, now - KEEP_ANY_DAYS * 86400)
    .all();
  const ids = old.results.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const ph = chunk.map(() => "?").join(",");
    await db.batch([
      db.prepare(`DELETE FROM logs_blobs WHERE item_id IN (${ph})`).bind(...chunk),
      db.prepare(`DELETE FROM logs_items WHERE id IN (${ph})`).bind(...chunk),
    ]);
  }
  if (!env.AI) return;
  const todo = await db
    .prepare("SELECT id FROM logs_items WHERE status IN ('new','failed') AND read_tries < 3 AND received_at < ? AND filed_at IS NULL ORDER BY received_at LIMIT 8")
    .bind(now - 300)
    .all();
  for (const r of todo.results) {
    try {
      await readItem(env, r.id);
    } catch (e) {
      console.error("logs cron read", r.id, e && e.message);
    }
  }
}
