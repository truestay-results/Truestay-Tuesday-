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
import { READER_V, SYSTEM, PROMPT, VERIFY, cleanReading, checkReading, applyVerify, flatFields, compactReading } from "./logs-read.js";

export { cleanReading, dateFromShown } from "./logs-read.js";

const PART = 1_000_000; // base64 characters per stored part (D1 rows max out at 2 MB)
const MAX_BYTES = 10 * 1024 * 1024; // app uploads (already resized on the phone)
const MAX_SHARE_BYTES = 6 * 1024 * 1024; // share button uploads (keeps the Worker well inside its CPU limit)
const KEEP_FILED_DAYS = 14;
const KEEP_ANY_DAYS = 60;
const DB_LIMIT = 500 * 1024 * 1024; // D1 database size on the Free plan
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
    // your call on a day the checks weren't sure about: 'count' it in the averages, or 'omit' it
    db.prepare(
      "CREATE TABLE IF NOT EXISTS logs_days (client_id INTEGER NOT NULL, day TEXT NOT NULL, verdict TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (client_id, day))"
    ),
  ]);
  // added later: which reader version read it (old ones get read again), and, for numbers you typed,
  // whether they're the whole day's or one meal's
  for (const sql of [
    "ALTER TABLE logs_items ADD COLUMN rv INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE logs_items ADD COLUMN scope TEXT",
  ]) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) console.error("logs schema", e && e.message);
    }
  }
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

export async function storeImage(env, { bytes, b64, clientId, clientName, source, name, lastModified }) {
  const db = env.LOGS_DB;
  let head;
  let size;
  let sha;
  if (bytes) {
    // share button: raw bytes. Hash the bytes (fast) and encode once.
    if (bytes.length < 100) bad("That file isn't a picture");
    head = bytes.subarray(0, 65536);
    size = bytes.length;
  } else {
    if (!b64 || typeof b64 !== "string") bad("No picture came through");
    if (b64.startsWith("data:")) b64 = b64.slice(b64.indexOf(",") + 1);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64.slice(0, 200)) || b64.length < 100) bad("That file isn't a picture");
    head = fromB64(b64.slice(0, 87380));
    size = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  }
  const info = imageInfo(head);
  if (!info) bad("That file isn't a picture");
  if (info.mime === "image/heic") bad("That's an iPhone HEIC photo. Add the Convert Image step to the Shortcut, or use Add screenshots in the app.");
  if (size > (bytes ? MAX_SHARE_BYTES : MAX_BYTES)) bad(`That picture is too big (${bytes ? 6 : 10} MB max). Add the Convert Image step to the Shortcut.`);
  sha = await sha256hex(bytes || fromB64(b64)); // always the picture's bytes, so the same file matches however it came in
  const dup = await db.prepare("SELECT id, filed_at FROM logs_items WHERE sha = ? AND status != 'uploading' LIMIT 1").bind(sha).first();
  if (dup) return { id: dup.id, dup: true, filed: !!dup.filed_at };
  if (bytes) b64 = toB64(bytes);

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
  // the row stays 'uploading' (hidden) until every part of the picture is saved
  const r = await db
    .prepare(
      `INSERT INTO logs_items (client_id, client_name, source, batch_key, orig_name, mime, bytes, w, h, sha, received_at, sent_at, sent_src, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'uploading',?,?)`
    )
    .bind(
      clientId ?? null, clientName || "", source, `${source}:${clientId ?? "later"}`, text(name, 160), info.mime, size,
      info.w || null, info.h || null, sha, now, sent ? sent.t : null, sentSrc, now, now
    )
    .run();
  const id = r.meta.last_row_id;
  const stmts = [];
  for (let i = 0, p = 0; i < b64.length; i += PART, p++) {
    stmts.push(db.prepare("INSERT INTO logs_blobs (item_id, part, b64) VALUES (?,?,?)").bind(id, p, b64.slice(i, i + PART)));
  }
  stmts.push(db.prepare("UPDATE logs_items SET status = 'new' WHERE id = ?").bind(id));
  try {
    await db.batch(stmts);
  } catch (e) {
    await db.batch([db.prepare("DELETE FROM logs_blobs WHERE item_id = ?").bind(id), db.prepare("DELETE FROM logs_items WHERE id = ?").bind(id)]);
    throw e;
  }
  return { id, dup: false };
}

async function loadB64(db, id) {
  const { results } = await db.prepare("SELECT b64 FROM logs_blobs WHERE item_id = ? ORDER BY part").bind(id).all();
  return results.map((p) => p.b64).join("");
}

// ---------- reading ----------
// What the model is asked, and the checks on its answer, are in logs-read.js.
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

// Workers AI's free allowance runs out for the day (it resets at 00:00 UTC): nothing is wrong with the picture
export class AiLimitError extends Error {}
const isLimit = (msg) => /\b4006\b|daily free allocation|neurons|quota/i.test(String(msg || ""));

async function askModel(env, model, dataUrl, withExtra, { system, prompt, maxTokens }) {
  const input = {
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
    temperature: 0,
    ...(withExtra ? model.extra : {}),
  };
  return env.AI.run(model.id, input);
}

export async function askModels(env, dataUrl, opts = {}, models = MODELS) {
  const o = { system: SYSTEM, prompt: PROMPT, maxTokens: 1600, ...opts };
  const errors = [];
  for (const m of models) {
    for (const withExtra of Object.keys(m.extra || {}).length ? [true, false] : [false]) {
      try {
        const res = await askModel(env, m, dataUrl, withExtra, o);
        const obj = parseJSONish(textOf(res));
        if (obj) return { reading: obj, model: m.id, raw: textOf(res).slice(0, 6000) };
        errors.push(`${m.id}: no JSON`);
        break; // it answered, just badly: try the next model
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (isLimit(msg)) throw new AiLimitError(msg.slice(0, 200));
        errors.push(`${m.id}${withExtra ? "+" : ""}: ${msg.slice(0, 160)}`);
      }
    }
  }
  throw new Error(errors.join(" | ") || "No model answered");
}

// Read one picture: the first look, then a focused second look if the numbers don't add up.
export async function readPicture(env, dataUrl) {
  const first = await askModels(env, dataUrl);
  let r = cleanReading(first.reading);
  const issues = checkReading(r);
  if (issues.length) {
    try {
      const again = await askModels(env, dataUrl, { system: SYSTEM, prompt: VERIFY, maxTokens: 700 });
      r = applyVerify(r, again.reading, issues);
    } catch (e) {
      if (e instanceof AiLimitError) throw e;
      r.checked = { asked: issues.map((i) => i.issue), still: issues.map((i) => i.issue), failed: true };
      r.unsure = [...new Set(issues.map((i) => i.field))];
    }
  }
  return { r, model: first.model, raw: first.raw };
}

const LIMIT_NOTE = "Paused: today's free reading allowance is used up. It carries on after 1am.";

export async function readItem(env, id) {
  const db = env.LOGS_DB;
  const it = await db.prepare("SELECT * FROM logs_items WHERE id = ?").bind(id).first();
  if (!it || it.status === "uploading" || it.status === "dup") return it ? itemById(db, id) : null;
  const now = nowS();
  if (!env.AI) {
    if (it.status !== "read") await db.prepare("UPDATE logs_items SET status='failed', read_error=?, updated_at=? WHERE id=?").bind("Reading isn't switched on", now, id).run();
    return itemById(db, id);
  }
  // counted before reading, so a picture that somehow always breaks the reader isn't retried for ever
  await db.prepare("UPDATE logs_items SET read_tries = read_tries + 1 WHERE id = ?").bind(id).run();
  let out = null;
  let err = null;
  try {
    out = await readPicture(env, `data:${it.mime};base64,${await loadB64(db, id)}`);
  } catch (e) {
    if (e instanceof AiLimitError) {
      // not the picture's fault: keep whatever was read before, don't count the try, carry on tomorrow
      await db.prepare("UPDATE logs_items SET read_tries = MAX(0, read_tries - 1), read_error=?, updated_at=? WHERE id=?").bind(LIMIT_NOTE, nowS(), id).run();
      return itemById(db, id);
    }
    err = String((e && e.message) || e).slice(0, 300);
    console.error("logs read failed", id, err);
  }
  const t = nowS();
  if (!out) {
    // a screenshot that was read before keeps its numbers if a re-read fails
    if (it.status === "read") await db.prepare("UPDATE logs_items SET read_error=?, updated_at=? WHERE id=?").bind(err || "Couldn't read it again", t, id).run();
    else await db.prepare("UPDATE logs_items SET status='failed', read_error=?, updated_at=? WHERE id=?").bind(err || "Couldn't read it", t, id).run();
    return itemById(db, id);
  }
  const r = out.r;
  const f = flatFields(r);
  const reading = compactReading(r, out.model);
  // "AND edited = 0": if you typed numbers yourself, yours win (the new reading is still kept for the day's checks)
  const res = await db
    .prepare(
      `UPDATE logs_items SET status='read', read_at=?, read_error=NULL, reading=?, rv=?, kind=?, app=?, kcal=?, protein=?, carbs=?, fat=?, steps=?,
         kcal_goal=?, partial=?, extras=?, note=?, updated_at=? WHERE id=? AND edited = 0`
    )
    .bind(t, reading, READER_V, f.kind, f.app, f.kcal, f.protein, f.carbs, f.fat, f.steps, f.kcal_goal, f.partial, JSON.stringify(f.extras), f.note, t, id)
    .run();
  if (!res.meta || !res.meta.changes) {
    await db.prepare("UPDATE logs_items SET status='read', read_at=?, read_error=NULL, reading=?, rv=?, updated_at=? WHERE id=?").bind(t, reading, READER_V, t, id).run();
  } else {
    await markIfRepeat(db, id, { clock: r.clock, calories: f.kcal, steps: f.steps, protein_g: f.protein });
  }
  return itemById(db, id);
}

// The same screenshot can come in twice (share button one night, then a chat export later): the picture
// bytes differ, but the screen doesn't. Same client, same status bar time, same kind and same numbers, arriving
// another way or at another time, means it's a repeat. (Two halves of one diary sent together aren't touched.)
// Keep the one with the better date, or the one you've already worked on.
async function markIfRepeat(db, id, r) {
  if (!r.clock || (r.calories == null && r.steps == null)) return;
  const it = await db.prepare("SELECT * FROM logs_items WHERE id = ?").bind(id).first();
  if (!it) return;
  const { results } = await db
    .prepare(
      `SELECT id, source, received_at, sent_at, filed_at, edited, day_src, reading, kind, kcal, steps, protein FROM logs_items
       WHERE id != ? AND status = 'read' AND COALESCE(client_id, -1) = COALESCE(?, -1) AND kind = ? AND received_at > ?`
    )
    .bind(id, it.client_id, it.kind, nowS() - 120 * 86400)
    .all();
  const twin = results.find((x) => {
    const rr = safeJSON(x.reading, {});
    const apart = x.source !== it.source || Math.abs(x.received_at - it.received_at) > 600;
    return apart && rr.clock === r.clock && (x.kcal ?? null) === (r.calories ?? null) && (x.steps ?? null) === (r.steps ?? null) && (x.protein ?? null) === (r.protein_g ?? null);
  });
  if (!twin) return;
  const oldIsWorkedOn = twin.filed_at || twin.edited || twin.day_src === "manual";
  const loser = !oldIsWorkedOn && it.sent_at && !twin.sent_at ? twin.id : id;
  await db.prepare("UPDATE logs_items SET status = 'dup', updated_at = ? WHERE id = ?").bind(nowS(), loser).run();
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
  rj: r.reading || null, // parsed in the app (keeps the Worker's CPU down)
  rv: r.rv || 1,
  scope: r.scope || null,
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
  v: String(r.sha || "").slice(0, 12),
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
  const [items, targets, usage, key, clients, verdicts] = await Promise.all([
    db.prepare("SELECT * FROM logs_items WHERE status NOT IN ('uploading','dup') AND (filed_at IS NULL OR filed_at > ?) ORDER BY received_at, id").bind(cutoff).all(),
    db.prepare("SELECT * FROM logs_targets").all(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM logs_items WHERE status != 'dup'").first(),
    getKey(db),
    clientsFromPay(env),
    db.prepare("SELECT client_id, day, verdict FROM logs_days").all(),
  ]);
  const t = {};
  for (const r of targets.results) t[r.client_id] = { kcal: r.kcal, protein: r.protein, steps: r.steps };
  const days = {};
  for (const r of verdicts.results) (days[r.client_id] = days[r.client_id] || {})[r.day] = r.verdict;
  return {
    clients,
    items: items.results.map(pub),
    targets: t,
    days,
    reader: READER_V,
    key,
    usage: { count: usage.n, bytes: usage.bytes, stored: Math.round(usage.bytes * 1.34), limit: DB_LIMIT },
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
    if (!b64) return new Response("Not ready", { status: 404, headers: { "cache-control": "no-store" } });
    // the app asks for /img/<id>?v=<content hash>, so a long cache is safe
    return new Response(fromB64(b64), {
      headers: { "content-type": it.mime, "cache-control": url.searchParams.get("v") ? "private, max-age=31536000, immutable" : "private, no-cache" },
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
    if ("scope" in b) {
      if (b.scope !== null && b.scope !== "day" && b.scope !== "meal") bad("Pick whole day or one meal");
      set("scope", b.scope);
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
    const all = Array.isArray(b.ids) ? [...new Set(b.ids.map(idOf))].slice(0, 1000) : [];
    if (!all.length) bad("Pick some screenshots first");
    const now = nowS();
    let c = null;
    if (b.action === "client") c = await clientRef(env, b.client_id);
    if (b.action === "day" && b.day !== null && b.day !== "" && !isDay(b.day)) bad("Pick a day");
    if (!["delete", "client", "day", "file", "unfile"].includes(b.action)) bad("Unknown action");
    // D1 takes at most 100 values per query, so big selections go in chunks
    const stmts = [];
    for (let i = 0; i < all.length; i += 90) {
      const ids = all.slice(i, i + 90);
      const ph = ids.map(() => "?").join(",");
      if (b.action === "delete") {
        stmts.push(db.prepare(`DELETE FROM logs_blobs WHERE item_id IN (${ph})`).bind(...ids));
        stmts.push(db.prepare(`DELETE FROM logs_items WHERE id IN (${ph})`).bind(...ids));
      } else if (b.action === "client") {
        stmts.push(db.prepare(`UPDATE logs_items SET client_id = ?, client_name = ?, updated_at = ? WHERE id IN (${ph})`).bind(c.id, c.name, now, ...ids));
      } else if (b.action === "day") {
        if (b.day === null || b.day === "") stmts.push(db.prepare(`UPDATE logs_items SET day = NULL, day_src = NULL, updated_at = ? WHERE id IN (${ph})`).bind(now, ...ids));
        else stmts.push(db.prepare(`UPDATE logs_items SET day = ?, day_src = 'manual', updated_at = ? WHERE id IN (${ph})`).bind(b.day, now, ...ids));
      } else if (b.action === "file") {
        stmts.push(db.prepare(`UPDATE logs_items SET filed_at = ?, updated_at = ? WHERE id IN (${ph}) AND filed_at IS NULL`).bind(now, now, ...ids));
      } else if (b.action === "unfile") {
        stmts.push(db.prepare(`UPDATE logs_items SET filed_at = NULL, updated_at = ? WHERE id IN (${ph})`).bind(now, ...ids));
      }
    }
    await db.batch(stmts);
    return json({ ok: true, state: await getState(env) });
  }

  if (path === "/days" && method === "POST") {
    const b = await body();
    const c = await clientRef(env, b.client_id);
    if (!c.id) bad("Pick a client");
    if (!isDay(b.day)) bad("Pick a day");
    if (b.verdict === null || b.verdict === "") {
      await db.prepare("DELETE FROM logs_days WHERE client_id = ? AND day = ?").bind(c.id, b.day).run();
    } else {
      if (b.verdict !== "count" && b.verdict !== "omit") bad("Count it or leave it out");
      await db
        .prepare(
          `INSERT INTO logs_days (client_id, day, verdict, updated_at) VALUES (?,?,?,?)
           ON CONFLICT(client_id, day) DO UPDATE SET verdict=excluded.verdict, updated_at=excluded.updated_at`
        )
        .bind(c.id, b.day, b.verdict, nowS())
        .run();
    }
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
export async function handleLogsShare(req, env, url, ctx) {
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
      let origName = "";
      const files = [];
      if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
        const fd = await req.formData();
        for (const [k, v] of fd.entries()) {
          if (typeof v === "string") {
            if (/^(client|who)$/i.test(k) && !who) who = v;
            else if (/^(name|filename)$/i.test(k) && v.trim()) origName = v.trim();
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
        const all = await clientsFromPay(env);
        const same = (c) => c.name.trim().toLowerCase() === who.toLowerCase();
        const match = all.find((c) => !c.finished && same(c)) || all.find(same);
        client = match ? { id: match.id, name: match.name } : { id: null, name: who.slice(0, 80) };
      }
      let saved = 0;
      let dups = 0;
      const errors = [];
      for (const f of files) {
        try {
          const res = await storeImage(env, {
            bytes: f.u8, b64: f.b64, clientId: client.id, clientName: client.name, source: "share", name: (files.length === 1 && origName) || f.name,
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
export async function logsCron(env, ctx) {
  const db = env.LOGS_DB;
  if (!db) return;
  await ensureLogsSchema(db);
  const now = nowS();
  const old = await db
    .prepare(
      `SELECT id FROM logs_items WHERE (filed_at IS NOT NULL AND filed_at < ?) OR received_at < ? OR status = 'dup'
         OR (status = 'uploading' AND received_at < ?) LIMIT 200`
    )
    .bind(now - KEEP_FILED_DAYS * 86400, now - KEEP_ANY_DAYS * 86400, now - 3600)
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
  // anything not read yet, then anything read by an older version of the reader (newest first, so this week's are fixed first)
  const todo = await db
    .prepare(
      `SELECT id FROM logs_items WHERE filed_at IS NULL AND received_at < ? AND (
         (status IN ('new','failed') AND read_tries < 3) OR (? AND status = 'read' AND rv < ? AND read_tries < 6))
       ORDER BY CASE WHEN status = 'read' THEN 1 ELSE 0 END, received_at DESC LIMIT ?`
    )
    .bind(now - 300, REREAD_OLD ? 1 : 0, READER_V, CRON_READS)
    .all();
  await readMany(env, ctx, todo.results.map((r) => r.id));
}

const CRON_READS = 20;
const REREAD_OLD = true; // screenshots read by an older reader are read again, a few each hour
// Each read runs as its own invocation (ctx.exports.Reader, a loopback to this Worker) so one hourly run can
// read 20 pictures without going over the per-invocation CPU limit. Stops early if the day's AI allowance runs out.
// background: each read carries on in its own invocation after answering straight away (for callers that can't wait).
export async function readMany(env, ctx, ids, conc = 4, background = false) {
  const reader = ctx && ctx.exports && ctx.exports.Reader;
  const out = { read: 0, failed: 0, limit: false, started: 0, loopback: !!reader };
  for (let i = 0; i < ids.length && !out.limit; i += conc) {
    const chunk = ids.slice(i, i + conc);
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          if (reader) {
            const res = await reader.fetch(new Request(`https://reader.internal/read/${id}${background ? "?bg=1" : ""}`, { method: "POST" }));
            return await res.json();
          }
          const it = await readItem(env, id);
          return { ok: true, status: it && it.status, error: it && it.read_error };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        }
      })
    );
    for (const r of results) {
      if (r && r.started) out.started++;
      else if (r && r.error === LIMIT_NOTE) out.limit = true;
      else if (r && r.ok && r.status === "read") out.read++;
      else out.failed++;
    }
  }
  return out;
}

// The loopback entrypoint behind readMany (exported from index.js as Reader).
export async function readerFetch(req, env, ctx) {
  const u = new URL(req.url);
  const m = u.pathname.match(/^\/read\/(\d+)$/);
  if (!m || req.method !== "POST") return json({ ok: false, error: "Not found" }, 404);
  if (u.searchParams.get("bg") && ctx && ctx.waitUntil) {
    ctx.waitUntil(ensureLogsSchema(env.LOGS_DB).then(() => readItem(env, Number(m[1]))).catch((e) => console.error("reader bg", e && e.message)));
    return json({ ok: true, started: true }, 202);
  }
  try {
    await ensureLogsSchema(env.LOGS_DB);
    const it = await readItem(env, Number(m[1]));
    return json({ ok: true, status: it && it.status, error: it && it.read_error });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}


// ---------- TEMPORARY: checking the new reader against real screenshots (removed once verified) ----------
// /api/logs/dev/<token>/trial/<id>: read one picture with the current reader and keep the full answer in
//   logs_meta ('trial:<id>') without changing the screenshot.
// /api/logs/dev/<token>/reread/<client id>/<how many>/<anything>: read again the client's screenshots that
//   an older reader read.
// The token lives in logs_meta ('dev_token' = token|expiry) and is put there by hand.
export async function handleLogsDev(req, env, url, ctx) {
  const db = env.LOGS_DB;
  if (!db || req.method !== "GET") return plain("Not found", 404);
  await ensureLogsSchema(db);
  const m = url.pathname.match(/^\/api\/logs\/dev\/([A-Za-z0-9_-]{24,})\/(.+)$/);
  const row = await db.prepare("SELECT value FROM logs_meta WHERE key = 'dev_token'").first();
  const [tok, until] = String((row && row.value) || "").split("|");
  if (!m || !tok || !(Number(until) > nowS()) || !safeEqual(await sha256hex(m[1]), await sha256hex(tok))) return plain("Not found", 404);
  const rest = m[2];
  let mm;
  if ((mm = rest.match(/^trial\/(\d+)(?:\/[A-Za-z0-9_-]*)?$/))) {
    const id = Number(mm[1]);
    const it = await db.prepare("SELECT id, mime FROM logs_items WHERE id = ?").bind(id).first();
    if (!it) return json({ ok: false, error: "no such item" }, 404);
    const save = (v) => db.prepare("INSERT INTO logs_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`trial:${id}`, JSON.stringify(v)).run();
    const work = (async () => {
      try {
        const out = await readPicture(env, `data:${it.mime};base64,${await loadB64(db, id)}`);
        await save({ at: nowS(), model: out.model, raw: out.raw, r: out.r, flat: flatFields(out.r) });
      } catch (e) {
        await save({ at: nowS(), error: String((e && e.message) || e).slice(0, 300) });
      }
    })();
    ctx.waitUntil(work);
    return json({ ok: true, id, started: true }, 202);
  }
  if ((mm = rest.match(/^reread\/(\d+)\/(\d+)\/[A-Za-z0-9_-]*$/))) {
    const n = Math.min(25, Math.max(1, Number(mm[2])));
    const { results } = await db
      .prepare("SELECT id FROM logs_items WHERE client_id = ? AND status IN ('read','new','failed') AND rv < ? ORDER BY received_at, id LIMIT ?")
      .bind(Number(mm[1]), READER_V, n)
      .all();
    const res = await readMany(env, ctx, results.map((r) => r.id), n, true);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM logs_items WHERE client_id = ? AND status IN ('read','new','failed') AND rv < ?").bind(Number(mm[1]), READER_V).first();
    return json({ ok: true, tried: results.length, ...res, left: left.n });
  }
  return plain("Not found", 404);
}
