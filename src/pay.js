// TrueStay Pay — private client payment & revenue tracker at /pay
// API lives under /api/pay/*. Data in D1 (binding PAY_DB).
//
// Auth model
//  - One owner account (email + password), created once with a one-time setup code
//    whose SHA-256 is stored in pay_meta.setup_code_hash.
//  - Sessions last a year and slide forward with use (HttpOnly cookie).
//  - Optional Face ID / passkey (WebAuthn). When set up, the app locks after
//    `lock_minutes` idle and unlocks with Face ID; password always works too.

const TRACK_START = "2026-09-28";
const PACKAGES = ["pt", "coaching", "programme"];
const TENURES = ["new", "newish", "longstanding"];
const METHODS = ["manual", "dd"];
const CLIENT_STATUSES = ["active", "paused", "finished"];
const WEEKS = [4, 8, 12, 16];
const LOCK_OPTIONS = [0, 1, 15, 60, 240];
const SESSION_DAYS = 365;
const COOKIE = "tsp_session";
const PBKDF2_ITER = 100000;

const PKG_LABEL = { pt: "Personal training only", coaching: "Full coaching", programme: "Programme only" };
const TEN_LABEL = { new: "New", newish: "New-ish", longstanding: "Longstanding" };
const METHOD_LABEL = { manual: "Manual payment", dd: "Direct debit" };
const STATUS_LABEL = { active: "Active", paused: "Paused", finished: "Finished" };

const enc = new TextEncoder();
const dec = new TextDecoder();

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (msg) => {
  throw new HttpError(400, msg);
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

// ---------- small helpers ----------
const nowS = () => Math.floor(Date.now() / 1000);
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) bad("Bad encoding");
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};
const sha256 = async (data) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytesEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function safeEqual(a, b) {
  const A = enc.encode(a);
  const B = enc.encode(b);
  if (A.length !== B.length) return false;
  return crypto.subtle.timingSafeEqual(A, B);
}

// ---------- dates (UK) ----------
const londonToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};
const addDays = (s, n) => {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const occurrence = (y, m, day) =>
  `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, "0")}`;
const endOfNextMonth = (today) => {
  let [y, m] = today.split("-").map(Number);
  m += 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return occurrence(y, m, 31);
};
const ukDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

// ---------- passwords ----------
async function hashPassword(password, saltB64, iter = PBKDF2_ITER) {
  const salt = saltB64 ? b64u.dec(saltB64) : randomBytes(16);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return { hash: b64u.enc(bits), salt: b64u.enc(salt), iter };
}
const normEmail = (e) => String(e || "").trim().toLowerCase();
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---------- sessions ----------
function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
const sessionCookie = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/api/pay; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function createSession(env, req, user) {
  const token = b64u.enc(randomBytes(32));
  const hash = hex(await sha256(token));
  const now = nowS();
  const lockSecs = Math.max(user.lock_minutes || 0, 1) * 60;
  await env.PAY_DB.prepare(
    "INSERT INTO pay_sessions (token_hash,user_id,created_at,last_seen,expires_at,unlocked_until,user_agent) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(hash, user.id, now, now, now + SESSION_DAYS * 86400, now + lockSecs, (req.headers.get("user-agent") || "").slice(0, 200))
    .run();
  return token;
}

async function loadSession(req, env) {
  const token = getCookie(req, COOKIE);
  if (!token) return null;
  const hash = hex(await sha256(token));
  const row = await env.PAY_DB.prepare(
    `SELECT s.*, u.email, u.name, u.lock_minutes,
       (SELECT COUNT(*) FROM pay_passkeys p WHERE p.user_id = u.id) AS passkeys
     FROM pay_sessions s JOIN pay_users u ON u.id = s.user_id WHERE s.token_hash = ?`
  )
    .bind(hash)
    .first();
  if (!row || row.expires_at < nowS()) return null;
  const lockOn = row.passkeys > 0 && row.lock_minutes > 0;
  return {
    hash,
    token,
    row,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    lockMinutes: row.lock_minutes,
    passkeys: row.passkeys,
    lockOn,
    locked: lockOn && row.unlocked_until < nowS(),
  };
}

async function touchSession(env, s) {
  const now = nowS();
  if (now - s.row.last_seen < 45) return;
  await env.PAY_DB.prepare("UPDATE pay_sessions SET last_seen=?, expires_at=?, unlocked_until=? WHERE token_hash=?")
    .bind(now, now + SESSION_DAYS * 86400, s.lockOn ? now + s.lockMinutes * 60 : s.row.unlocked_until, s.hash)
    .run();
}

// ---------- rate limiting for password / setup ----------
async function checkRate(env, ip) {
  const since = nowS() - 900;
  const r = await env.PAY_DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN ip = ? THEN 1 ELSE 0 END),0) AS mine, COUNT(*) AS total FROM pay_login_attempts WHERE at > ? AND ok = 0"
  )
    .bind(ip, since)
    .first();
  if (r.mine >= 8 || r.total >= 40) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
}
async function recordAttempt(env, ip, ok) {
  const now = nowS();
  await env.PAY_DB.batch([
    env.PAY_DB.prepare("INSERT INTO pay_login_attempts (ip, at, ok) VALUES (?,?,?)").bind(ip, now, ok ? 1 : 0),
    env.PAY_DB.prepare("DELETE FROM pay_login_attempts WHERE at < ?").bind(now - 86400),
  ]);
}

// ---------- WebAuthn (Face ID / passkeys) ----------
const rpIdFor = (url) => url.hostname.replace(/^www\./, "");
function originOk(origin, rpId) {
  try {
    const u = new URL(origin);
    const hostOk = u.hostname === rpId || u.hostname.endsWith("." + rpId);
    const protoOk = u.protocol === "https:" || u.hostname === "localhost";
    return hostOk && protoOk;
  } catch {
    return false;
  }
}
async function newChallenge(env, kind, sessionHash = null) {
  const id = b64u.enc(randomBytes(16));
  const challenge = b64u.enc(randomBytes(32));
  await env.PAY_DB.batch([
    env.PAY_DB.prepare("DELETE FROM pay_challenges WHERE expires_at < ?").bind(nowS()),
    env.PAY_DB.prepare("INSERT INTO pay_challenges (id, challenge, kind, session_hash, expires_at) VALUES (?,?,?,?,?)").bind(
      id,
      challenge,
      kind,
      sessionHash,
      nowS() + 300
    ),
  ]);
  return { id, challenge };
}
async function takeChallenge(env, id, kind) {
  if (typeof id !== "string") bad("Missing challenge");
  const row = await env.PAY_DB.prepare("DELETE FROM pay_challenges WHERE id = ? AND kind = ? RETURNING *").bind(id, kind).first();
  if (!row || row.expires_at < nowS()) bad("That took too long. Try again.");
  return row;
}
function checkClientData(cdBytes, type, challenge, rpId) {
  let cd;
  try {
    cd = JSON.parse(dec.decode(cdBytes));
  } catch {
    bad("Bad client data");
  }
  if (cd.type !== type) bad("Wrong request type");
  if (cd.challenge !== challenge) bad("Challenge mismatch");
  if (!originOk(cd.origin, rpId)) bad("Wrong origin");
}
function derToRaw(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("bad sig");
  const len = der[i++];
  if (len & 0x80) i += len & 0x7f;
  const readInt = () => {
    if (der[i++] !== 0x02) throw new Error("bad sig");
    const l = der[i++];
    let v = der.slice(i, i + l);
    i += l;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error("bad sig");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(readInt(), 0);
  raw.set(readInt(), 32);
  return raw;
}
async function importCredKey(spki, alg) {
  if (alg === -7) return crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (alg === -257) return crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  bad("Unsupported key type");
}
async function verifySignature(cred, authData, cdBytes, sig) {
  const data = new Uint8Array(authData.length + 32);
  data.set(authData, 0);
  data.set(await sha256(cdBytes), authData.length);
  const key = await importCredKey(b64u.dec(cred.public_key), cred.alg);
  try {
    if (cred.alg === -7) return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(sig), data);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  } catch {
    return false;
  }
}

// ---------- validation ----------
function pence(v, label = "amount") {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) bad(`Enter a valid ${label}`);
  return n;
}
const oneOf = (v, list, msg) => (list.includes(v) ? v : bad(msg));
const text = (v, max) => String(v ?? "").trim().slice(0, max);
function weeksFor(pkg, v) {
  if (pkg !== "programme") return null;
  const n = Number(v);
  return WEEKS.includes(n) ? n : bad("Pick a programme length");
}
function cleanClient(b) {
  const name = text(b.name, 80);
  if (!name) bad("Name is required");
  const pkg = oneOf(b.package, PACKAGES, "Pick a package");
  return {
    name,
    tenure: oneOf(b.tenure, TENURES, "Pick a tenure"),
    package: pkg,
    programme_weeks: weeksFor(pkg, b.programme_weeks),
    price_pence: pence(b.price_pence, "price"),
    method: oneOf(b.method, METHODS, "Pick a payment method"),
    status: oneOf(b.status || "active", CLIENT_STATUSES, "Pick a status"),
    notes: text(b.notes, 2000),
  };
}
function cleanPayment(b) {
  const pkg = oneOf(b.package, PACKAGES, "Pick a package");
  if (!isDate(b.due_date)) bad("Pick a due date");
  if (b.paid_date != null && b.paid_date !== "" && !isDate(b.paid_date)) bad("Paid date isn't valid");
  return {
    client_id: Number(b.client_id),
    package: pkg,
    programme_weeks: weeksFor(pkg, b.programme_weeks),
    amount_pence: pence(b.amount_pence),
    due_date: b.due_date,
    method: oneOf(b.method, METHODS, "Pick a payment method"),
    paid_date: b.paid_date || null,
    notes: text(b.notes, 2000),
  };
}
const idFrom = (s) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) bad("Bad id");
  return n;
};

// ---------- recurring generation ----------
// Creates the monthly payments for active repeat rules, up to the end of next month.
// Never creates anything before the tracking start date or before the rule started.
// The unique index on (schedule_id, due_date) makes this safe to run repeatedly.
async function generateRecurring(env) {
  const db = env.PAY_DB;
  const horizon = endOfNextMonth(londonToday());
  const { results } = await db
    .prepare(
      `SELECT s.* FROM pay_schedules s JOIN pay_clients c ON c.id = s.client_id
       WHERE s.active = 1 AND c.status = 'active' AND (s.generated_through IS NULL OR s.generated_through < ?)`
    )
    .bind(horizon)
    .all();
  if (!results.length) return;
  const now = nowS();
  const stmts = [];
  for (const s of results) {
    const from = s.generated_through ? addDays(s.generated_through, 1) : s.start_date;
    let [y, m] = from.split("-").map(Number);
    for (let k = 0; k < 36; k++) {
      const d = occurrence(y, m, s.day_of_month);
      if (d > horizon) break;
      if (d >= from && d >= s.start_date && d >= TRACK_START) {
        stmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO pay_payments
               (client_id, schedule_id, package, programme_weeks, amount_pence, due_date, method, paid_date, notes, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,NULL,'',?,?)`
            )
            .bind(s.client_id, s.id, s.package, s.programme_weeks, s.amount_pence, d, s.method, now, now)
        );
      }
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    stmts.push(db.prepare("UPDATE pay_schedules SET generated_through = ? WHERE id = ?").bind(horizon, s.id));
  }
  await db.batch(stmts);
}

// Removes future, unpaid, auto-generated payments (used when stopping a repeat or pausing a client).
// Anything already due (today or earlier) stays on the books.
function dropFutureGenerated(db, where, bindVal, today) {
  return db
    .prepare(`DELETE FROM pay_payments WHERE ${where} = ? AND schedule_id IS NOT NULL AND paid_date IS NULL AND due_date > ?`)
    .bind(bindVal, today);
}

async function getData(env) {
  await generateRecurring(env);
  const db = env.PAY_DB;
  const [c, p, s] = await db.batch([
    db.prepare("SELECT * FROM pay_clients ORDER BY name COLLATE NOCASE"),
    db.prepare("SELECT * FROM pay_payments ORDER BY due_date, id"),
    db.prepare("SELECT * FROM pay_schedules"),
  ]);
  return { today: londonToday(), trackStart: TRACK_START, clients: c.results, payments: p.results, schedules: s.results };
}

async function requireClient(db, id) {
  const c = await db.prepare("SELECT * FROM pay_clients WHERE id = ?").bind(id).first();
  if (!c) bad("Client not found");
  return c;
}

// Insert one payment; if repeat is on, create the monthly rule it belongs to.
async function insertPayment(db, p, repeat) {
  const now = nowS();
  let scheduleId = null;
  if (repeat) {
    const r = await db
      .prepare(
        `INSERT INTO pay_schedules (client_id, package, programme_weeks, amount_pence, method, day_of_month, start_date, generated_through, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?)`
      )
      .bind(p.client_id, p.package, p.programme_weeks, p.amount_pence, p.method, Number(p.due_date.slice(8, 10)), p.due_date, p.due_date, now, now)
      .run();
    scheduleId = r.meta.last_row_id;
  }
  await db
    .prepare(
      `INSERT INTO pay_payments (client_id, schedule_id, package, programme_weeks, amount_pence, due_date, method, paid_date, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(p.client_id, scheduleId, p.package, p.programme_weeks, p.amount_pence, p.due_date, p.method, p.paid_date, p.notes, now, now)
    .run();
}

// ---------- CSV ----------
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const pounds = (p) => (p / 100).toFixed(2);

async function exportCsv(env, type) {
  const data = await getData(env);
  const today = data.today;
  const byId = Object.fromEntries(data.clients.map((c) => [c.id, c]));
  let body;
  let name;
  if (type === "clients") {
    body = csv([
      ["Name", "Tenure", "Package", "Programme length (weeks)", "Agreed price (£)", "Usual payment method", "Client status", "Notes"],
      ...data.clients.map((c) => [
        c.name,
        TEN_LABEL[c.tenure],
        PKG_LABEL[c.package],
        c.programme_weeks || "",
        pounds(c.price_pence),
        METHOD_LABEL[c.method],
        STATUS_LABEL[c.status],
        c.notes,
      ]),
    ]);
    name = `truestay-clients-${today}.csv`;
  } else {
    const sched = new Set(data.schedules.filter((s) => s.active).map((s) => s.id));
    body = csv([
      ["Client", "Package", "Programme length (weeks)", "Amount (£)", "Due date", "Payment method", "Status", "Paid date", "Repeats monthly", "Notes"],
      ...data.payments.map((p) => [
        byId[p.client_id]?.name || "(deleted client)",
        PKG_LABEL[p.package],
        p.programme_weeks || "",
        pounds(p.amount_pence),
        ukDate(p.due_date),
        METHOD_LABEL[p.method],
        p.paid_date ? "Paid" : p.due_date < today ? "Overdue" : "Unpaid",
        ukDate(p.paid_date),
        p.schedule_id && sched.has(p.schedule_id) ? "Yes" : "No",
        p.notes,
      ]),
    ]);
    name = `truestay-payments-${today}.csv`;
  }
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}

// ---------- request handling ----------
async function readBody(req) {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
}

function checkRequestShape(req, url) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) throw new HttpError(403, "Bad origin");
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new HttpError(415, "JSON only");
}

function sessionInfo(s, hasUser) {
  return {
    hasUser,
    authed: !!s,
    locked: !!s?.locked,
    email: s?.email || null,
    name: s?.name || null,
    hasPasskey: (s?.passkeys || 0) > 0,
    lockMinutes: s?.lockMinutes ?? null,
  };
}

async function signedInResponse(env, req, user, extra = {}) {
  const token = await createSession(env, req, user);
  return json({ ok: true, ...extra }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}

export async function handlePay(req, env, url) {
  try {
    if (!env.PAY_DB) throw new HttpError(500, "Database isn't connected");
    checkRequestShape(req, url);
    const db = env.PAY_DB;
    const path = url.pathname.slice("/api/pay".length) || "/";
    const method = req.method;
    const ip = req.headers.get("cf-connecting-ip") || "local";

    // ----- public routes -----
    if (path === "/session" && method === "GET") {
      const s = await loadSession(req, env);
      const hasUser = !!(await db.prepare("SELECT id FROM pay_users LIMIT 1").first());
      const headers = s && !s.locked ? { "set-cookie": sessionCookie(s.token, SESSION_DAYS * 86400) } : {};
      if (s && !s.locked) await touchSession(env, s);
      return json(sessionInfo(s, hasUser), 200, headers);
    }

    if (path === "/setup" && method === "POST") {
      await checkRate(env, ip);
      const b = await readBody(req);
      if (await db.prepare("SELECT id FROM pay_users LIMIT 1").first()) throw new HttpError(409, "Already set up. Sign in instead.");
      const stored = await db.prepare("SELECT value FROM pay_meta WHERE key = 'setup_code_hash'").first();
      const codeHash = hex(await sha256(normCode(b.code)));
      if (!stored || !safeEqual(stored.value, codeHash)) {
        await recordAttempt(env, ip, false);
        throw new HttpError(403, "That setup code isn't right.");
      }
      const email = normEmail(b.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad("Enter a valid email");
      const password = String(b.password || "");
      if (password.length < 10) bad("Use at least 10 characters for your password");
      const name = text(b.name, 40);
      const pw = await hashPassword(password);
      const r = await db
        .prepare("INSERT INTO pay_users (email, name, pw_hash, pw_salt, pw_iter, lock_minutes, created_at) VALUES (?,?,?,?,?,15,?)")
        .bind(email, name, pw.hash, pw.salt, pw.iter, nowS())
        .run();
      await db.prepare("DELETE FROM pay_meta WHERE key = 'setup_code_hash'").run();
      await recordAttempt(env, ip, true);
      return signedInResponse(env, req, { id: r.meta.last_row_id, lock_minutes: 15 });
    }

    if (path === "/login" && method === "POST") {
      await checkRate(env, ip);
      const b = await readBody(req);
      const user = await db.prepare("SELECT * FROM pay_users WHERE email = ?").bind(normEmail(b.email)).first();
      const pw = user ? await hashPassword(String(b.password || ""), user.pw_salt, user.pw_iter) : null;
      if (!user || !safeEqual(pw.hash, user.pw_hash)) {
        await recordAttempt(env, ip, false);
        throw new HttpError(401, "Email or password isn't right.");
      }
      await recordAttempt(env, ip, true);
      // Replace any old/locked session on this device.
      const old = await loadSession(req, env);
      if (old) await db.prepare("DELETE FROM pay_sessions WHERE token_hash = ?").bind(old.hash).run();
      return signedInResponse(env, req, user);
    }

    if (path === "/logout" && method === "POST") {
      const s = await loadSession(req, env);
      if (s) await db.prepare("DELETE FROM pay_sessions WHERE token_hash = ?").bind(s.hash).run();
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
    }

    if (path === "/webauthn/auth/options" && method === "POST") {
      const s = await loadSession(req, env);
      const ch = await newChallenge(env, "auth", s?.hash || null);
      let allow = [];
      if (s) {
        const { results } = await db.prepare("SELECT id FROM pay_passkeys WHERE user_id = ?").bind(s.userId).all();
        allow = results.map((r) => r.id);
      }
      return json({ challengeId: ch.id, challenge: ch.challenge, rpId: rpIdFor(url), allow });
    }

    if (path === "/webauthn/auth" && method === "POST") {
      const b = await readBody(req);
      const ch = await takeChallenge(env, b.challengeId, "auth");
      const cred = await db.prepare("SELECT * FROM pay_passkeys WHERE id = ?").bind(String(b.id || "")).first();
      if (!cred) throw new HttpError(401, "That Face ID key isn't registered here. Sign in with your password.");
      const rpId = rpIdFor(url);
      const cdBytes = b64u.dec(b.clientDataJSON);
      const authData = b64u.dec(b.authenticatorData);
      checkClientData(cdBytes, "webauthn.get", ch.challenge, rpId);
      if (authData.length < 37 || !bytesEqual(authData.slice(0, 32), await sha256(rpId))) bad("Wrong site");
      const flags = authData[32];
      if (!(flags & 0x01) || !(flags & 0x04)) bad("Face ID wasn't confirmed");
      const count = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
      if (cred.sign_count > 0 && count <= cred.sign_count) throw new HttpError(401, "Security check failed. Sign in with your password.");
      if (!(await verifySignature(cred, authData, cdBytes, b64u.dec(b.signature)))) throw new HttpError(401, "Face ID check failed.");
      await db.prepare("UPDATE pay_passkeys SET sign_count = ?, last_used = ? WHERE id = ?").bind(count, nowS(), cred.id).run();

      const user = await db.prepare("SELECT * FROM pay_users WHERE id = ?").bind(cred.user_id).first();
      const s = await loadSession(req, env);
      if (s && s.userId === user.id) {
        const now = nowS();
        await db
          .prepare("UPDATE pay_sessions SET unlocked_until = ?, last_seen = ?, expires_at = ? WHERE token_hash = ?")
          .bind(now + Math.max(user.lock_minutes, 1) * 60, now, now + SESSION_DAYS * 86400, s.hash)
          .run();
        return json({ ok: true }, 200, { "set-cookie": sessionCookie(s.token, SESSION_DAYS * 86400) });
      }
      return signedInResponse(env, req, user);
    }

    // ----- everything below needs a signed-in, unlocked session -----
    const s = await loadSession(req, env);
    if (!s) throw new HttpError(401, "Signed out");
    if (s.locked) throw new HttpError(423, "Locked", { locked: true });
    await touchSession(env, s);
    const today = londonToday();
    const now = nowS();

    if (path === "/data" && method === "GET") return json(await getData(env));

    if (path === "/export" && method === "GET") return exportCsv(env, url.searchParams.get("type"));

    // Face ID setup
    if (path === "/webauthn/register/options" && method === "POST") {
      const ch = await newChallenge(env, "register", s.hash);
      const { results } = await db.prepare("SELECT id FROM pay_passkeys WHERE user_id = ?").bind(s.userId).all();
      return json({
        challengeId: ch.id,
        publicKey: {
          challenge: ch.challenge,
          rp: { id: rpIdFor(url), name: "TrueStay Pay" },
          user: { id: b64u.enc(enc.encode(String(s.userId))), name: s.email, displayName: s.name || s.email },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
          excludeCredentials: results.map((r) => ({ type: "public-key", id: r.id })),
          attestation: "none",
          timeout: 60000,
        },
      });
    }
    if (path === "/webauthn/register" && method === "POST") {
      const b = await readBody(req);
      const ch = await takeChallenge(env, b.challengeId, "register");
      if (ch.session_hash !== s.hash) bad("Session changed. Try again.");
      checkClientData(b64u.dec(b.clientDataJSON), "webauthn.create", ch.challenge, rpIdFor(url));
      const alg = Number(b.alg);
      const spki = b64u.dec(b.publicKey);
      await importCredKey(spki, alg); // throws if not a usable key
      const id = String(b.id || "");
      if (!id || id.length > 1400) bad("Bad credential");
      b64u.dec(id);
      await db
        .prepare("INSERT OR REPLACE INTO pay_passkeys (id, user_id, public_key, alg, sign_count, name, created_at) VALUES (?,?,?,?,0,?,?)")
        .bind(id, s.userId, b64u.enc(spki), alg, text(b.name, 60) || "This device", now)
        .run();
      await db.prepare("UPDATE pay_sessions SET unlocked_until = ? WHERE token_hash = ?").bind(now + Math.max(s.lockMinutes, 1) * 60, s.hash).run();
      return json({ ok: true });
    }
    if (path === "/webauthn/list" && method === "GET") {
      const { results } = await db.prepare("SELECT id, name, created_at, last_used FROM pay_passkeys WHERE user_id = ? ORDER BY created_at").bind(s.userId).all();
      return json({ passkeys: results });
    }
    if (path === "/webauthn/remove" && method === "POST") {
      const b = await readBody(req);
      await db.prepare("DELETE FROM pay_passkeys WHERE id = ? AND user_id = ?").bind(String(b.id || ""), s.userId).run();
      return json({ ok: true });
    }

    if (path === "/settings" && method === "POST") {
      const b = await readBody(req);
      const stmts = [];
      if (b.lockMinutes !== undefined) {
        const m = Number(b.lockMinutes);
        if (!LOCK_OPTIONS.includes(m)) bad("Pick a lock time");
        stmts.push(db.prepare("UPDATE pay_users SET lock_minutes = ? WHERE id = ?").bind(m, s.userId));
        stmts.push(db.prepare("UPDATE pay_sessions SET unlocked_until = ? WHERE token_hash = ?").bind(now + Math.max(m, 1) * 60, s.hash));
      }
      if (b.name !== undefined) stmts.push(db.prepare("UPDATE pay_users SET name = ? WHERE id = ?").bind(text(b.name, 40), s.userId));
      if (stmts.length) await db.batch(stmts);
      return json({ ok: true });
    }

    if (path === "/password" && method === "POST") {
      await checkRate(env, ip);
      const b = await readBody(req);
      const user = await db.prepare("SELECT * FROM pay_users WHERE id = ?").bind(s.userId).first();
      const cur = await hashPassword(String(b.current || ""), user.pw_salt, user.pw_iter);
      if (!safeEqual(cur.hash, user.pw_hash)) {
        await recordAttempt(env, ip, false);
        throw new HttpError(403, "Current password isn't right.");
      }
      const next = String(b.next || "");
      if (next.length < 10) bad("Use at least 10 characters");
      const pw = await hashPassword(next);
      await db.batch([
        db.prepare("UPDATE pay_users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?").bind(pw.hash, pw.salt, pw.iter, s.userId),
        db.prepare("DELETE FROM pay_sessions WHERE user_id = ? AND token_hash != ?").bind(s.userId, s.hash),
      ]);
      return json({ ok: true });
    }

    // ----- clients -----
    if (path === "/clients" && method === "POST") {
      const b = await readBody(req);
      const c = cleanClient(b);
      const r = await db
        .prepare(
          `INSERT INTO pay_clients (name, tenure, package, programme_weeks, price_pence, method, status, notes, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(c.name, c.tenure, c.package, c.programme_weeks, c.price_pence, c.method, c.status, c.notes, now, now)
        .run();
      const clientId = r.meta.last_row_id;
      if (b.next && b.next.due_date) {
        const p = cleanPayment({
          client_id: clientId,
          package: c.package,
          programme_weeks: c.programme_weeks,
          amount_pence: c.price_pence,
          method: c.method,
          due_date: b.next.due_date,
        });
        await insertPayment(db, p, !!b.next.repeat && c.status === "active");
      }
      return json({ ok: true, id: clientId, data: await getData(env) });
    }

    let m;
    if ((m = path.match(/^\/clients\/(\d+)$/))) {
      const id = idFrom(m[1]);
      const before = await requireClient(db, id);
      if (method === "PUT") {
        const c = cleanClient(await readBody(req));
        const stmts = [
          db
            .prepare(
              "UPDATE pay_clients SET name=?, tenure=?, package=?, programme_weeks=?, price_pence=?, method=?, status=?, notes=?, updated_at=? WHERE id=?"
            )
            .bind(c.name, c.tenure, c.package, c.programme_weeks, c.price_pence, c.method, c.status, c.notes, now, id),
        ];
        if (before.status === "active" && c.status !== "active") {
          stmts.push(dropFutureGenerated(db, "client_id", id, today));
        }
        if (before.status !== "active" && c.status === "active") {
          // Resume repeats from today; no back-charging for the paused period.
          stmts.push(db.prepare("UPDATE pay_schedules SET generated_through = ? WHERE client_id = ? AND active = 1").bind(addDays(today, -1), id));
        }
        await db.batch(stmts);
        return json({ ok: true, data: await getData(env) });
      }
      if (method === "DELETE") {
        const n = await db.prepare("SELECT COUNT(*) AS n FROM pay_payments WHERE client_id = ?").bind(id).first();
        if (n.n > 0) bad("This client has payments. Set them to Finished instead so the history stays.");
        await db.batch([
          db.prepare("DELETE FROM pay_schedules WHERE client_id = ?").bind(id),
          db.prepare("DELETE FROM pay_clients WHERE id = ?").bind(id),
        ]);
        return json({ ok: true, data: await getData(env) });
      }
    }

    // ----- payments -----
    if (path === "/payments" && method === "POST") {
      const b = await readBody(req);
      const p = cleanPayment(b);
      const client = await requireClient(db, p.client_id);
      await insertPayment(db, p, !!b.repeat && client.status === "active");
      return json({ ok: true, data: await getData(env) });
    }
    if ((m = path.match(/^\/payments\/(\d+)(\/paid)?$/))) {
      const id = idFrom(m[1]);
      const existing = await db.prepare("SELECT * FROM pay_payments WHERE id = ?").bind(id).first();
      if (!existing) bad("Payment not found");
      if (m[2] && method === "POST") {
        const b = await readBody(req);
        const paid = b.paid_date === null ? null : b.paid_date || today;
        if (paid !== null && !isDate(paid)) bad("Paid date isn't valid");
        await db.prepare("UPDATE pay_payments SET paid_date = ?, updated_at = ? WHERE id = ?").bind(paid, now, id).run();
        return json({ ok: true, data: await getData(env) });
      }
      if (!m[2] && method === "PUT") {
        const p = cleanPayment(await readBody(req));
        await requireClient(db, p.client_id);
        await db
          .prepare(
            "UPDATE pay_payments SET client_id=?, package=?, programme_weeks=?, amount_pence=?, due_date=?, method=?, paid_date=?, notes=?, updated_at=? WHERE id=?"
          )
          .bind(p.client_id, p.package, p.programme_weeks, p.amount_pence, p.due_date, p.method, p.paid_date, p.notes, now, id)
          .run();
        return json({ ok: true, data: await getData(env) });
      }
      if (!m[2] && method === "DELETE") {
        await db.prepare("DELETE FROM pay_payments WHERE id = ?").bind(id).run();
        return json({ ok: true, data: await getData(env) });
      }
    }

    // ----- repeat rules -----
    if ((m = path.match(/^\/schedules\/(\d+)(\/stop)?$/))) {
      const id = idFrom(m[1]);
      const sch = await db.prepare("SELECT * FROM pay_schedules WHERE id = ?").bind(id).first();
      if (!sch) bad("Repeat not found");
      if (m[2] && method === "POST") {
        await db.batch([
          db.prepare("UPDATE pay_schedules SET active = 0, updated_at = ? WHERE id = ?").bind(now, id),
          dropFutureGenerated(db, "schedule_id", id, today),
        ]);
        return json({ ok: true, data: await getData(env) });
      }
      if (!m[2] && method === "PUT") {
        const b = await readBody(req);
        const pkg = oneOf(b.package, PACKAGES, "Pick a package");
        const weeks = weeksFor(pkg, b.programme_weeks);
        const amount = pence(b.amount_pence);
        const meth = oneOf(b.method, METHODS, "Pick a payment method");
        const day = Number(b.day_of_month);
        if (!Number.isInteger(day) || day < 1 || day > 31) bad("Pick a day of the month");
        const stmts = [
          db
            .prepare("UPDATE pay_schedules SET package=?, programme_weeks=?, amount_pence=?, method=?, day_of_month=?, updated_at=? WHERE id=?")
            .bind(pkg, weeks, amount, meth, day, now, id),
        ];
        if (day !== sch.day_of_month) {
          // Re-plan upcoming dates on the new day; anything due today or earlier is left alone.
          stmts.push(dropFutureGenerated(db, "schedule_id", id, today));
          stmts.push(db.prepare("UPDATE pay_schedules SET generated_through = ? WHERE id = ?").bind(today, id));
        } else {
          stmts.push(
            db
              .prepare(
                "UPDATE pay_payments SET package=?, programme_weeks=?, amount_pence=?, method=?, updated_at=? WHERE schedule_id=? AND paid_date IS NULL AND due_date >= ?"
              )
              .bind(pkg, weeks, amount, meth, now, id, today)
          );
        }
        await db.batch(stmts);
        return json({ ok: true, data: await getData(env) });
      }
    }

    throw new HttpError(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error("pay error", e && e.stack ? e.stack : e);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
}
