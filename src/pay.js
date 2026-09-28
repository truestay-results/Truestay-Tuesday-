// TrueStay Pay — private client payment & revenue tracker at /pay
// API lives under /api/pay/*. Data in D1 (binding PAY_DB).
//
// Files
//   pay.js        routes, login/Face ID, settings, exports, morning nudges
//   pay-plans.js  plans (what each client is on over time) and the payments they create
//   pay-push.js   Web Push (VAPID + encryption) for the morning nudge
//   pay-util.js   dates, validation, labels
//
// Auth model
//  - One owner account (email + password), created once with a one-time setup code
//    whose SHA-256 is stored in pay_meta.setup_code_hash.
//  - Sessions last a year and slide forward with use (HttpOnly cookie).
//  - Optional Face ID / passkey (WebAuthn). When set up, the app locks after
//    `lock_minutes` away and unlocks with Face ID; password always works too.
//    The app itself shows the lock screen when you come back to it; the server
//    backs that up by locking a session that has gone quiet (the open app pings
//    /session every 30s, so it never locks mid-use).

import {
  TRACK_START, PACKAGES, TENURES, METHODS, WEEKS, PKG_LABEL, TEN_LABEL, METHOD_LABEL, STATUS_LABEL, BILLING_LABEL,
  HttpError, bad, nowS, londonToday, londonHour, londonWeekday, isDate, addDays, ukDate, pence, oneOf, text, idFrom, money,
} from "./pay-util.js";
import {
  ensureSchema, generate, cleanPlan, addFirstPlan, switchPlan, finishClient, editPlan, deletePlan, clientStatus, currentPlan, planLabel,
} from "./pay-plans.js";
import { vapidKeys, pushAll } from "./pay-push.js";

const LOCK_OPTIONS = [0, 1, 5, 15, 60, 240];
// Server-side idle window. "Every open" (1) gets a 2 minute window; the app's own lock screen handles re-opening.
const idleSecs = (m) => (m <= 1 ? 120 : m * 60);
const SESSION_DAYS = 365;
const COOKIE = "tsp_session";
const PBKDF2_ITER = 100000;
const PUSH_HOSTS = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "notify.windows.com", "push.services.mozilla.com"];

const enc = new TextEncoder();
const dec = new TextDecoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

// ---------- small helpers ----------
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
const sumP = (ps) => ps.reduce((a, p) => a + p.amount_pence, 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

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
  const lockSecs = idleSecs(user.lock_minutes || 0);
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
  if (now - s.row.last_seen < 25) return;
  await env.PAY_DB.prepare("UPDATE pay_sessions SET last_seen=?, expires_at=?, unlocked_until=? WHERE token_hash=?")
    .bind(now, now + SESSION_DAYS * 86400, s.lockOn ? now + idleSecs(s.lockMinutes) : s.row.unlocked_until, s.hash)
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


// ---------- settings (goals, chase message, morning nudges) ----------
const DEFAULT_CHASE =
  "Hi {first}, hope you're well! Just a quick one: your {amount} for {package} was due on {date} and I don't think it's come through yet. Could you sort it when you get a sec? Thanks, {me}";
const SETTINGS_DEFAULTS = { goalMonthly: 0, goalClients: 0, chaseTemplate: DEFAULT_CHASE, nudgeOn: false, nudgeHour: 8 };
async function getSettings(db) {
  const row = await db.prepare("SELECT value FROM pay_meta WHERE key = 'settings'").first();
  let s = {};
  try {
    s = row ? JSON.parse(row.value) : {};
  } catch {}
  return { ...SETTINGS_DEFAULTS, ...s };
}
async function saveSettings(db, patch) {
  const next = { ...(await getSettings(db)), ...patch };
  await db
    .prepare("INSERT INTO pay_meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(next))
    .run();
  return next;
}

// ---------- data ----------
async function getData(env) {
  const db = env.PAY_DB;
  await ensureSchema(db);
  await generate(db);
  const [c, p, pl, subs] = await db.batch([
    db.prepare("SELECT id, name, phone, tenure, package, programme_weeks, price_pence, method, notes, finished_on, created_at FROM pay_clients ORDER BY name COLLATE NOCASE"),
    db.prepare(
      "SELECT id, client_id, plan_id, auto, package, programme_weeks, amount_pence, due_date, method, paid_date, notes, chased_at, chase_count FROM pay_payments ORDER BY due_date, id"
    ),
    db.prepare("SELECT * FROM pay_plans ORDER BY client_id, start_date, id"),
    db.prepare("SELECT COUNT(*) AS n FROM pay_push_subs"),
  ]);
  return {
    today: londonToday(),
    trackStart: TRACK_START,
    clients: c.results,
    payments: p.results,
    plans: pl.results,
    settings: await getSettings(db),
    pushDevices: subs.results[0].n,
  };
}

function cleanClientDetails(b) {
  const name = text(b.name, 80);
  if (!name) bad("Name is required");
  return {
    name,
    phone: text(b.phone, 30).replace(/[^\d+ ()-]/g, ""),
    tenure: oneOf(b.tenure, TENURES, "Pick a tenure"),
    notes: text(b.notes, 2000),
  };
}
function weeksFor(pkg, v) {
  if (pkg !== "programme") return null;
  const n = Number(v);
  return WEEKS.includes(n) ? n : null;
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
async function requireClient(db, id) {
  const c = await db.prepare("SELECT * FROM pay_clients WHERE id = ?").bind(id).first();
  if (!c) bad("Client not found");
  return c;
}

// ---------- CSV ----------
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const pounds = (p) => (p / 100).toFixed(2);
const billingText = (p) => (p.billing === "split" ? `Split into ${p.instalments}` : BILLING_LABEL[p.billing]);

async function exportCsv(env, type) {
  const data = await getData(env);
  const today = data.today;
  const byId = Object.fromEntries(data.clients.map((c) => [c.id, c]));
  const plansOf = (id) => data.plans.filter((p) => p.client_id === id);
  let rows;
  let name;
  if (type === "clients") {
    rows = [
      ["Name", "Phone", "Tenure", "Current plan", "How they pay", "Price (£)", "Usual payment method", "Client status", "Notes"],
      ...data.clients.map((c) => {
        const ps = plansOf(c.id);
        const cur = currentPlan(ps, today) || ps[ps.length - 1];
        return [
          c.name, c.phone, TEN_LABEL[c.tenure], cur ? planLabel(cur) : "", cur ? billingText(cur) : "", cur && cur.kind !== "break" ? pounds(cur.price_pence) : "",
          cur ? METHOD_LABEL[cur.method] : "", STATUS_LABEL[clientStatus(c, ps, today)], c.notes,
        ];
      }),
    ];
    name = `truestay-clients-${today}.csv`;
  } else if (type === "plans") {
    rows = [
      ["Client", "Plan", "How they pay", "Price (£)", "Start date", "End date", "Payment method", "Hours per month", "Notes"],
      ...data.plans.map((p) => [
        byId[p.client_id]?.name || "(deleted client)", planLabel(p), p.kind === "break" ? "" : billingText(p), p.kind === "break" ? "" : pounds(p.price_pence),
        ukDate(p.start_date), p.end_date ? ukDate(p.end_date) : "Ongoing", p.kind === "break" ? "" : METHOD_LABEL[p.method], p.hours_per_month ?? "", p.notes,
      ]),
    ];
    name = `truestay-plans-${today}.csv`;
  } else {
    rows = [
      ["Client", "Package", "Programme length (weeks)", "Amount (£)", "Due date", "Payment method", "Status", "Paid date", "From plan", "Times chased", "Notes"],
      ...data.payments.map((p) => [
        byId[p.client_id]?.name || "(deleted client)", PKG_LABEL[p.package], p.programme_weeks || "", pounds(p.amount_pence), ukDate(p.due_date),
        METHOD_LABEL[p.method], p.paid_date ? "Paid" : p.due_date < today ? "Overdue" : "Unpaid", ukDate(p.paid_date), p.auto ? "Yes" : "No",
        p.chase_count || 0, p.notes,
      ]),
    ];
    name = `truestay-payments-${today}.csv`;
  }
  return new Response(csv(rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
}

// ---------- morning nudge ----------
export function composeNudge(data, weekday) {
  const today = data.today;
  const yesterday = addDays(today, -1);
  const first = (id) => (data.clients.find((c) => c.id === id)?.name || "Client").split(/\s+/)[0];
  const unpaid = data.payments.filter((p) => !p.paid_date);
  const dueToday = unpaid.filter((p) => p.due_date === today);
  const missed = unpaid.filter((p) => p.due_date === yesterday);
  const overdue = unpaid.filter((p) => p.due_date < today);
  const ending = data.plans.filter((p) => p.end_date === today && p.then_action === "decide" && !p.decided);
  const list = (ps) => ps.slice(0, 3).map((p) => `${first(p.client_id)} ${money(p.amount_pence)}`).join(", ") + (ps.length > 3 ? ` +${ps.length - 3} more` : "");
  const lines = [];
  if (dueToday.length) lines.push(`Due today: ${list(dueToday)}`);
  if (missed.length) lines.push(`Didn't land yesterday: ${list(missed)}`);
  for (const p of ending.slice(0, 2)) lines.push(`${first(p.client_id)}'s ${planLabel(p).toLowerCase()} ends today. What's next?`);
  const monday = weekday === "Mon";
  if (!lines.length && !(monday && overdue.length)) return null;
  if (monday && overdue.length > missed.length) lines.push(`Still overdue: ${plural(overdue.length, "payment")}, ${money(sumP(overdue))}`);
  const title = dueToday.length
    ? `${dueToday.length} due today · ${money(sumP(dueToday))}`
    : missed.length
    ? `${plural(missed.length, "payment")} didn't land`
    : ending.length
    ? "A plan ends today"
    : `${overdue.length} overdue · ${money(sumP(overdue))}`;
  return { title, body: lines.join("\n"), badge: dueToday.length + overdue.length, url: "/pay/", tag: "morning-" + today };
}

// Runs every hour from the Worker's cron trigger; sends once a day at the chosen hour (UK time).
export async function payCron(env) {
  if (!env.PAY_DB) return;
  const db = env.PAY_DB;
  await ensureSchema(db);
  const settings = await getSettings(db);
  if (!settings.nudgeOn || londonHour() !== Number(settings.nudgeHour)) return;
  const today = londonToday();
  const last = await db.prepare("SELECT value FROM pay_meta WHERE key = 'last_nudge'").first();
  if (last && last.value === today) return;
  await db.prepare("INSERT INTO pay_meta (key, value) VALUES ('last_nudge', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(today).run();
  const msg = composeNudge(await getData(env), londonWeekday());
  if (msg) await pushAll(db, msg);
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
          .bind(now + idleSecs(user.lock_minutes), now, now + SESSION_DAYS * 86400, s.hash)
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
    await ensureSchema(db);

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
      await db.prepare("UPDATE pay_sessions SET unlocked_until = ? WHERE token_hash = ?").bind(now + idleSecs(s.lockMinutes), s.hash).run();
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
        stmts.push(db.prepare("UPDATE pay_sessions SET unlocked_until = ? WHERE token_hash = ?").bind(now + idleSecs(m), s.hash));
      }
      if (b.name !== undefined) stmts.push(db.prepare("UPDATE pay_users SET name = ? WHERE id = ?").bind(text(b.name, 40), s.userId));
      if (stmts.length) await db.batch(stmts);
      const patch = {};
      if (b.goalMonthly !== undefined) patch.goalMonthly = pence(b.goalMonthly, "goal");
      if (b.goalClients !== undefined) {
        const n = Number(b.goalClients);
        if (!Number.isInteger(n) || n < 0 || n > 500) bad("Enter a client goal");
        patch.goalClients = n;
      }
      if (b.chaseTemplate !== undefined) patch.chaseTemplate = text(b.chaseTemplate, 1000) || DEFAULT_CHASE;
      if (b.nudgeHour !== undefined) {
        const h = Number(b.nudgeHour);
        if (!Number.isInteger(h) || h < 5 || h > 21) bad("Pick a time between 5am and 9pm");
        patch.nudgeHour = h;
      }
      if (b.nudgeOn !== undefined) patch.nudgeOn = !!b.nudgeOn;
      const settings = Object.keys(patch).length ? await saveSettings(db, patch) : await getSettings(db);
      return json({ ok: true, settings });
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


    // ----- morning nudges -----
    if (path === "/push/key" && method === "GET") return json({ key: (await vapidKeys(db)).pub });
    if (path === "/push/subscribe" && method === "POST") {
      const b = await readBody(req);
      const endpoint = String(b.endpoint || "");
      let host = "";
      try {
        host = new URL(endpoint).hostname;
      } catch {}
      if (!endpoint.startsWith("https://") || endpoint.length > 1000 || !PUSH_HOSTS.some((h) => host === h || host.endsWith("." + h)))
        bad("That notification subscription isn't valid");
      const p256dh = String(b.keys?.p256dh || "");
      const auth = String(b.keys?.auth || "");
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) bad("That notification subscription isn't valid");
      await db
        .prepare(
          "INSERT INTO pay_push_subs (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, fails = 0"
        )
        .bind(endpoint, p256dh, auth, now)
        .run();
      const settings = await saveSettings(db, { nudgeOn: true });
      return json({ ok: true, settings });
    }
    if (path === "/push/unsubscribe" && method === "POST") {
      const b = await readBody(req);
      await db.prepare("DELETE FROM pay_push_subs WHERE endpoint = ?").bind(String(b.endpoint || "")).run();
      const left = (await db.prepare("SELECT COUNT(*) AS n FROM pay_push_subs").first()).n;
      const settings = left ? await getSettings(db) : await saveSettings(db, { nudgeOn: false });
      return json({ ok: true, settings });
    }
    if (path === "/push/test" && method === "POST") {
      const data = await getData(env);
      const hour = Number(data.settings.nudgeHour);
      const real = composeNudge(data, "Mon");
      const msg = real
        ? { ...real, tag: "test" }
        : {
            title: "Morning nudges are on",
            body: `You'll get a heads-up at ${hour}:00 on days a payment is due, didn't land, or a plan ends.`,
            badge: 0,
            url: "/pay/",
            tag: "test",
          };
      const results = await pushAll(db, msg);
      return json({ ok: results.some((r) => r >= 200 && r < 300), sent: results.length, results });
    }

    // ----- clients -----
    if (path === "/clients" && method === "POST") {
      const b = await readBody(req);
      const c = cleanClientDetails(b);
      if (b.plan) cleanPlan(b.plan); // validate before anything is saved
      const r = await db
        .prepare(
          `INSERT INTO pay_clients (name, phone, tenure, package, programme_weeks, price_pence, method, status, notes, created_at, updated_at)
           VALUES (?, ?, ?, 'pt', NULL, 0, 'manual', 'active', ?, ?, ?)`
        )
        .bind(c.name, c.phone, c.tenure, c.notes, now, now)
        .run();
      const id = r.meta.last_row_id;
      if (b.plan) {
        try {
          await addFirstPlan(db, id, b.plan);
        } catch (e) {
          await db.prepare("DELETE FROM pay_clients WHERE id = ?").bind(id).run();
          throw e;
        }
      }
      return json({ ok: true, id, data: await getData(env) });
    }

    let m;
    if ((m = path.match(/^\/clients\/(\d+)(\/plan|\/finish)?$/))) {
      const id = idFrom(m[1]);
      await requireClient(db, id);
      if (m[2] === "/plan" && method === "POST") {
        await switchPlan(db, id, await readBody(req));
        return json({ ok: true, data: await getData(env) });
      }
      if (m[2] === "/finish" && method === "POST") {
        const b = await readBody(req);
        await finishClient(db, id, b.date || today);
        return json({ ok: true, data: await getData(env) });
      }
      if (!m[2] && method === "PUT") {
        const c = cleanClientDetails(await readBody(req));
        await db
          .prepare("UPDATE pay_clients SET name = ?, phone = ?, tenure = ?, notes = ?, updated_at = ? WHERE id = ?")
          .bind(c.name, c.phone, c.tenure, c.notes, now, id)
          .run();
        return json({ ok: true, data: await getData(env) });
      }
      if (!m[2] && method === "DELETE") {
        const n = await db.prepare("SELECT COUNT(*) AS n FROM pay_payments WHERE client_id = ?").bind(id).first();
        if (n.n > 0) bad("This client has payments. Mark them as finished instead so the history stays.");
        await db.batch([
          db.prepare("DELETE FROM pay_plans WHERE client_id = ?").bind(id),
          db.prepare("DELETE FROM pay_clients WHERE id = ?").bind(id),
        ]);
        return json({ ok: true, data: await getData(env) });
      }
    }

    // ----- plans -----
    if ((m = path.match(/^\/plans\/(\d+)(\/decided)?$/))) {
      const id = idFrom(m[1]);
      if (m[2] && method === "POST") {
        await db.prepare("UPDATE pay_plans SET decided = 1, updated_at = ? WHERE id = ?").bind(now, id).run();
        return json({ ok: true, data: await getData(env) });
      }
      if (!m[2] && method === "PUT") {
        await editPlan(db, id, await readBody(req));
        return json({ ok: true, data: await getData(env) });
      }
      if (!m[2] && method === "DELETE") {
        await deletePlan(db, id);
        return json({ ok: true, data: await getData(env) });
      }
    }

    // ----- payments -----
    if (path === "/payments" && method === "POST") {
      const p = cleanPayment(await readBody(req));
      await requireClient(db, p.client_id);
      await db
        .prepare(
          `INSERT INTO pay_payments (client_id, plan_id, auto, package, programme_weeks, amount_pence, due_date, method, paid_date, notes, created_at, updated_at)
           VALUES (?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(p.client_id, p.package, p.programme_weeks, p.amount_pence, p.due_date, p.method, p.paid_date, p.notes, now, now)
        .run();
      return json({ ok: true, data: await getData(env) });
    }
    if ((m = path.match(/^\/payments\/(\d+)(\/paid|\/chase)?$/))) {
      const id = idFrom(m[1]);
      const existing = await db.prepare("SELECT * FROM pay_payments WHERE id = ?").bind(id).first();
      if (!existing) bad("Payment not found");
      if (m[2] === "/paid" && method === "POST") {
        const b = await readBody(req);
        const paid = b.paid_date === null ? null : b.paid_date || today;
        if (paid !== null && !isDate(paid)) bad("Paid date isn't valid");
        await db.prepare("UPDATE pay_payments SET paid_date = ?, updated_at = ? WHERE id = ?").bind(paid, now, id).run();
        return json({ ok: true, data: await getData(env) });
      }
      if (m[2] === "/chase" && method === "POST") {
        const r = await db
          .prepare("UPDATE pay_payments SET chase_count = chase_count + 1, chased_at = ?, updated_at = ? WHERE id = ? RETURNING chase_count, chased_at")
          .bind(today, now, id)
          .first();
        return json({ ok: true, ...r });
      }
      if (!m[2] && method === "PUT") {
        const p = cleanPayment(await readBody(req));
        await requireClient(db, p.client_id);
        if (existing.auto && p.client_id !== existing.client_id) bad("This payment comes from a plan, so it stays with that client.");
        try {
          await db
            .prepare(
              "UPDATE pay_payments SET client_id=?, package=?, programme_weeks=?, amount_pence=?, due_date=?, method=?, paid_date=?, notes=?, updated_at=? WHERE id=?"
            )
            .bind(p.client_id, p.package, p.programme_weeks, p.amount_pence, p.due_date, p.method, p.paid_date, p.notes, now, id)
            .run();
        } catch (e) {
          if (/UNIQUE/i.test(String(e && e.message))) bad("There's already a payment from this plan on that date.");
          throw e;
        }
        return json({ ok: true, data: await getData(env) });
      }
      if (!m[2] && method === "DELETE") {
        await db.prepare("DELETE FROM pay_payments WHERE id = ?").bind(id).run();
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
