/* TrueStay Pay — client payments & revenue. Vanilla JS, talks to /api/pay. */
(() => {
  "use strict";

  const API = "/api/pay";
  const TRACK_START = "2026-09-28";
  const PKG = { pt: "PT only", coaching: "Full coaching", programme: "Programme" };
  const KIND = { pt: "Personal training", coaching: "Full coaching", programme: "Programme", break: "Break" };
  const KIND_SHORT = { pt: "PT", coaching: "Coaching", programme: "Programme", break: "Break" };
  const TEN = { new: "New", newish: "New-ish", longstanding: "Longstanding" };
  const METH = { manual: "Manual", dd: "Direct debit" };
  const METH_LONG = { manual: "Manual payment", dd: "Direct debit" };
  const CST = { active: "Active", paused: "Paused", finished: "Finished" };
  const STL = { paid: "Paid", unpaid: "Unpaid", overdue: "Overdue", missed: "Didn't pay" };
  const BILL = { monthly: "Monthly", upfront: "Upfront", split: "Split", none: "As they go" };
  const WEEKS = [4, 6, 8, 12, 16];
  const LOCKS = [
    [1, "Every time I open it"],
    [5, "After 5 minutes away"],
    [15, "After 15 minutes away"],
    [60, "After an hour away"],
    [0, "Never"],
  ];
  const LOCK_GRACE_MS = 10000; // "every time": ignore quick glances at a notification
  const TAB_ORDER = { month: 0, calendar: 1, clients: 3, growth: 4 };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- tiny utils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pad = (n) => String(n).padStart(2, "0");
  const sum = (ps) => ps.reduce((a, p) => a + p.amount_pence, 0);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const pref = (k, d) => {
    try {
      return localStorage.getItem("tsp." + k) ?? d;
    } catch {
      return d;
    }
  };
  const setPref = (k, v) => {
    try {
      localStorage.setItem("tsp." + k, v);
    } catch {}
  };
  const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";

  // dates — 'YYYY-MM-DD' strings in UK time
  const londonToday = () =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const londonHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(new Date())) % 24;
  const nums = (iso) => iso.split("-").map(Number);
  const utc = (iso) => {
    const [y, m, d] = nums(iso);
    return new Date(Date.UTC(y, m - 1, d || 1));
  };
  const fmt = (iso, o) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(utc(iso));
  const fmtShort = (iso) => `${fmt(iso, { weekday: "short" })} ${fmt(iso, { day: "numeric", month: "short" })}`;
  const fmtDay = (iso) => fmt(iso, { day: "numeric", month: "short" });
  const fmtLong = (iso) => fmt(iso, { weekday: "long", day: "numeric", month: "long" });
  const fmtUK = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
  const mKey = (iso) => iso.slice(0, 7);
  const mLabel = (mk) => fmt(mk + "-01", { month: "long", year: "numeric" });
  const mName = (mk) => fmt(mk + "-01", { month: "long" });
  const mShort = (mk) => fmt(mk + "-01", { month: "short" });
  const addMonths = (mk, n) => {
    let [y, m] = nums(mk);
    m += n;
    while (m > 12) { m -= 12; y++; }
    while (m < 1) { m += 12; y--; }
    return `${y}-${pad(m)}`;
  };
  const daysIn = (mk) => {
    const [y, m] = nums(mk);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  };
  const addDays = (iso, n) => {
    const d = utc(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const occurrence = (mk, day) => `${mk}-${pad(Math.min(day, daysIn(mk)))}`;
  const nextOnDay = (day, from) => {
    const d = occurrence(mKey(from), day);
    return d >= from ? d : occurrence(addMonths(mKey(from), 1), day);
  };
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const ago = (iso) => {
    const d = daysBetween(iso, londonToday());
    return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  };

  // money — pence integers
  const money = (p) => {
    const s = "£" + Math.floor(p / 100).toLocaleString("en-GB");
    return p % 100 ? s + "." + pad(p % 100) : s;
  };
  const moneyBig = (p) => "£" + Math.floor(p / 100).toLocaleString("en-GB") + `<small>.${pad(p % 100)}</small>`;
  const moneyCompact = (p) => (p >= 100000 ? "£" + (p / 100000).toFixed(p >= 1000000 ? 0 : 1).replace(/\.0$/, "") + "k" : money(p));
  const parseMoney = (s) => {
    const t = String(s ?? "").replace(/[£,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(parseFloat(t) * 100);
  };
  const pounds0 = (p) => "£" + Math.round(p / 100).toLocaleString("en-GB");
  const moneyInput = (p) => (p == null || p === "" ? "" : p % 100 ? (p / 100).toFixed(2) : String(p / 100));
  const initials = (name) =>
    String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  // ---------- icons ----------
  const P = {
    bars: '<path d="M4 20V11"/><path d="M10 20V4"/><path d="M16 20v-6"/><path d="M22 20H2"/>',
    cal: '<rect x="3" y="4.5" width="18" height="17" rx="4"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.7.8 2.8 2.5 3.1 5.2"/>',
    trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    more: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    arrow: '<path d="M7 17 17 7M8.5 7H17v8.5"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V10a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9.5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="3"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    out: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9"/>',
    key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.5 11.5 9-9M17 6l3 3M14.5 8.5l2 2"/>',
    info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5V8"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M3 15h18M10 4v16"/>',
    receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    userplus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5 1.6 0 3 .4 4.1 1.2M19 14v6M16 17h6"/>',
    share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.7 7.4L3 20.5l1.6-4.9A8.5 8.5 0 1 1 21 11.5z"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="3"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/>',
    flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
    faceid:
      '<path d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2"/><path d="M8.5 9v1.5M15.5 9v1.5M12 9v4.5h-1"/><path d="M8.8 16.3c1.9 1.4 4.5 1.4 6.4 0"/>',
  };
  const ic = (n) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
  const rings =
    '<svg class="rings" viewBox="0 0 200 200" fill="none" stroke="rgba(255,255,255,.14)" aria-hidden="true">' +
    [30, 48, 66, 84, 100].map((r, i) => `<circle cx="100" cy="100" r="${r}" ${i % 2 ? 'stroke-dasharray="3 7"' : ""}/>`).join("") +
    "</svg>";

  // ---------- state ----------
  const S = {
    session: null,
    data: null,
    cmap: new Map(),
    tab: "month", // always opens on Month
    clientId: null,
    month: null,
    calMonth: null,
    calDay: null,
    calMode: "due",
    calAnim: "",
    heroAnim: "",
    scope: "month",
    q: "",
    fStatus: "all",
    fPkg: "all",
    listMode: pref("listMode", "list"),
    cStatus: "active",
    cq: "",
    mixMode: "month",
    trendSel: null,
    trendTable: false,
    platformAuth: false,
    pushHere: false,
    lastSync: 0,
    locked: false,
    counts: {},
    segPos: {},
    suppressClick: false,
  };

  const client = (id) => S.cmap.get(id);
  const cname = (p) => client(p.client_id)?.name || "Deleted client";
  // "missed" = marked as didn't pay: clients pay up front, so it's lost money, not owed money
  const stOf = (p) => (p.paid_date ? "paid" : p.missed_on ? "missed" : p.due_date < londonToday() ? "overdue" : "unpaid");
  const isOpen = (p) => !p.paid_date && !p.missed_on; // still expected: counts as owed, gets chased
  const isLost = (p) => !p.paid_date && !!p.missed_on;
  const pkgText = (pkg, weeks) => (pkg === "programme" && weeks ? `${weeks}-week programme` : PKG[pkg]);

  // ---------- plans ----------
  const byStart = (a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id);
  const plansOf = (cid) => S.data.plans.filter((p) => p.client_id === cid).sort(byStart);
  const planOf = (id) => S.data.plans.find((p) => p.id === id);
  function planOn(cid, day) {
    let best = null;
    for (const p of plansOf(cid)) if (p.start_date <= day && (!p.end_date || p.end_date >= day)) best = p;
    return best;
  }
  const curPlan = (cid) => planOn(cid, londonToday());
  const upcomingPlan = (cid) => plansOf(cid).find((p) => p.start_date > londonToday());
  const lastPaidPlanBefore = (cid, date) => plansOf(cid).filter((p) => p.start_date < date && p.kind !== "break").pop();
  // the paid plan they were on before plan `p` started (what "back to" means after a programme or break)
  const planBefore = (p) => plansOf(p.client_id).filter((x) => x.id !== p.id && x.start_date < p.start_date && x.kind !== "break").pop();
  function statusOf(c) {
    const today = londonToday();
    if (c.finished_on && c.finished_on <= today) return "finished";
    const cur = curPlan(c.id);
    if (cur) return cur.kind === "break" ? "paused" : "active";
    const next = upcomingPlan(c.id);
    if (next && next.kind === "break") return "paused";
    return "active";
  }
  const planName = (p) => (p.kind === "programme" && p.programme_weeks ? `${p.programme_weeks}-week programme` : KIND[p.kind]);
  function planPrice(p) {
    if (!p || p.kind === "break") return "";
    if (p.billing === "monthly") return `${money(p.price_pence)}/month`;
    if (p.billing === "upfront") return `${money(p.price_pence)} upfront`;
    if (p.billing === "split") return `${money(p.price_pence)} in ${p.instalments} payments`;
    return p.price_pence ? `Pays as they go · usually ${money(p.price_pence)}` : "Pays as they go";
  }
  const planDates = (p) =>
    p.end_date ? `${fmtDay(p.start_date)} → ${fmtDay(p.end_date)}` : p.start_date > londonToday() ? `From ${fmtDay(p.start_date)}` : `Since ${fmtDay(p.start_date)}`;
  // what a plan is worth per month (programmes spread across their length)
  function monthlyValue(p) {
    if (!p || p.kind === "break") return 0;
    if (p.billing === "monthly") return p.price_pence;
    if (p.billing === "upfront" || p.billing === "split") {
      const days = p.programme_weeks ? p.programme_weeks * 7 : p.end_date ? daysBetween(p.start_date, p.end_date) + 1 : 0;
      return days ? Math.round((p.price_pence * 30.44) / days) : 0;
    }
    return 0;
  }
  function decisions() {
    const today = londonToday();
    const soon = addDays(today, 7);
    const out = [];
    for (const c of S.data.clients) {
      if (statusOf(c) === "finished") continue;
      const ps = plansOf(c.id);
      const last = ps[ps.length - 1];
      if (!last || !last.end_date || last.decided) continue;
      if (last.end_date > soon) continue;
      if (last.then_action !== "decide" && last.end_date >= today) continue;
      out.push({ c, p: last, ended: last.end_date < today });
    }
    return out.sort((a, b) => (a.p.end_date < b.p.end_date ? -1 : 1));
  }

  function setData(d) {
    S.data = d;
    S.cmap = new Map(d.clients.map((c) => [c.id, c]));
    S.lastSync = Date.now();
    updateBadge();
  }
  function actionCount() {
    const today = londonToday();
    return S.data.payments.filter((p) => isOpen(p) && p.due_date <= today).length;
  }
  function updateBadge() {
    try {
      const n = actionCount();
      if (!("setAppBadge" in navigator)) return;
      (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
    } catch {}
  }

  // ---------- theme ----------
  function applyTheme(t) {
    const el = document.documentElement;
    if (t === "light" || t === "dark") el.dataset.theme = t;
    else el.removeAttribute("data-theme");
    const forced = t === "light" ? "#E8EBE8" : t === "dark" ? "#0E0F0D" : null;
    $$('meta[name="theme-color"]').forEach((m) =>
      m.setAttribute("content", forced || ((m.getAttribute("media") || "").includes("dark") ? "#0E0F0D" : "#E8EBE8"))
    );
  }
  function setTheme(t) {
    setPref("theme", t);
    applyTheme(t);
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(pref("theme", "system")));

  // ---------- feel: haptics + particles ----------
  function haptic() {
    try {
      if (navigator.vibrate) {
        navigator.vibrate(12);
        return;
      }
      const l = document.createElement("label");
      l.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      const i = document.createElement("input");
      i.type = "checkbox";
      i.setAttribute("switch", "");
      l.appendChild(i);
      document.body.appendChild(l);
      l.click();
      l.remove();
    } catch {}
  }
  function burst(x, y) {
    if (reduced) return;
    const b = document.createElement("div");
    b.className = "burst";
    b.style.left = x + "px";
    b.style.top = y + "px";
    let html = "";
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
      const d = 50 + Math.random() * 60;
      html += `<i style="--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d + 30}px;--r:${(Math.random() - 0.5) * 540}deg;animation-delay:${i * 12}ms">£</i>`;
    }
    b.innerHTML = html;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 1100);
  }

  // ---------- API ----------
  async function api(path, { method = "GET", body, raw = false } = {}) {
    const opts = { method, headers: {}, credentials: "same-origin" };
    if (method !== "GET") {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try {
      res = await fetch(API + path, opts);
    } catch {
      throw new Error("No connection. Check your signal and try again.");
    }
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!raw && res.status === 401) {
      renderLogin();
      const e = new Error("Signed out");
      e.silent = true;
      throw e;
    }
    if (!raw && res.status === 423) {
      renderLock();
      const e = new Error("Locked");
      e.silent = true;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(data.error || "Something went wrong. Try again.");
      e.status = res.status;
      throw e;
    }
    return data;
  }
  const fail = (e) => {
    if (!e.silent) toast(e.message);
  };

  // ---------- WebAuthn ----------
  const b64 = {
    enc(buf) {
      const b = new Uint8Array(buf);
      let s = "";
      for (const x of b) s += String.fromCharCode(x);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    dec(str) {
      let s = str.replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    },
  };
  const deviceName = () => {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? "iPad" : "Mac";
    if (/Android/.test(ua)) return "Android phone";
    if (/Windows/.test(ua)) return "Windows PC";
    return "This device";
  };
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  async function passkeyRegister() {
    const o = await api("/webauthn/register/options", { method: "POST" });
    const pk = o.publicKey;
    const cred = await navigator.credentials.create({
      publicKey: {
        ...pk,
        challenge: b64.dec(pk.challenge),
        user: { ...pk.user, id: b64.dec(pk.user.id) },
        excludeCredentials: pk.excludeCredentials.map((c) => ({ ...c, id: b64.dec(c.id) })),
      },
    });
    const r = cred.response;
    const spki = typeof r.getPublicKey === "function" ? r.getPublicKey() : null;
    if (!spki) throw new Error("This browser can't set up Face ID here. Update iOS and try again.");
    await api("/webauthn/register", {
      method: "POST",
      body: {
        challengeId: o.challengeId,
        id: b64.enc(cred.rawId),
        publicKey: b64.enc(spki),
        alg: r.getPublicKeyAlgorithm(),
        clientDataJSON: b64.enc(r.clientDataJSON),
        name: deviceName(),
      },
    });
  }
  async function passkeyAuth() {
    const o = await api("/webauthn/auth/options", { method: "POST", raw: true });
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64.dec(o.challenge),
        rpId: o.rpId,
        userVerification: "required",
        timeout: 60000,
        allowCredentials: (o.allow || []).map((id) => ({ type: "public-key", id: b64.dec(id) })),
      },
    });
    const r = cred.response;
    return api("/webauthn/auth", {
      method: "POST",
      raw: true,
      body: {
        challengeId: o.challengeId,
        id: b64.enc(cred.rawId),
        clientDataJSON: b64.enc(r.clientDataJSON),
        authenticatorData: b64.enc(r.authenticatorData),
        signature: b64.enc(r.signature),
      },
    });
  }
  const isCancel = (e) => e && (e.name === "NotAllowedError" || e.name === "AbortError");
  const webauthnError = (e) => (isCancel(e) ? "Face ID was cancelled." : e?.message || "Face ID didn't work.");

  // ---------- lock timing ----------
  function awayTooLong() {
    const s = S.session;
    if (!s?.hasPasskey || !s.lockMinutes) return false;
    const h = Number(pref("hiddenAt", "0"));
    if (!h) return false;
    const limit = s.lockMinutes <= 1 ? LOCK_GRACE_MS : s.lockMinutes * 60000;
    return Date.now() - h >= limit;
  }
  const markHidden = () => {
    if (S.data && !S.locked) setPref("hiddenAt", String(Date.now()));
  };

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, actions = []) {
    const t = $("#toast");
    t.innerHTML = `<div class="toast-inner"><span class="msg">${esc(msg)}</span>${actions
      .map((a, i) => `<button data-t="${i}">${esc(a.label)}</button>`)
      .join("")}</div>`;
    actions.forEach((a, i) => {
      $(`[data-t="${i}"]`, t).onclick = () => {
        hideToast();
        a.fn();
      };
    });
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actions.length ? 6000 : 2800);
  }
  const hideToast = () => $("#toast").classList.remove("show");

  // ---------- sheets ----------
  let sheet = null;
  function openSheet(title, html, onMount) {
    closeSheet(true);
    const bd = document.createElement("div");
    bd.className = "backdrop";
    const sh = document.createElement("div");
    sh.className = "sheet";
    sh.setAttribute("role", "dialog");
    sh.setAttribute("aria-modal", "true");
    sh.innerHTML = `<div class="grab"></div><div class="sheet-head"><h3>${esc(title)}</h3><button class="round" data-close aria-label="Close">${ic(
      "x"
    )}</button></div><div class="sheet-body">${html}</div>`;
    $("#sheet-root").append(bd, sh);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        bd.classList.add("show");
        sh.classList.add("show");
      })
    );
    bd.onclick = () => closeSheet();
    $("[data-close]", sh).onclick = () => closeSheet();
    sh.addEventListener("click", (e) => {
      const b = e.target.closest(".opt");
      if (!b || b.disabled) return;
      const g = b.parentElement;
      $$(".opt", g).forEach((x) => x.classList.toggle("on", x === b));
      g.dataset.value = b.dataset.val;
      g.dispatchEvent(new Event("change", { bubbles: true }));
    });
    let y0 = null;
    let dy = 0;
    [$(".grab", sh), $(".sheet-head", sh)].forEach((h) => {
      h.addEventListener("touchstart", (e) => {
        y0 = e.touches[0].clientY;
        dy = 0;
        sh.style.transition = "none";
      }, { passive: true });
      h.addEventListener("touchmove", (e) => {
        if (y0 == null) return;
        dy = Math.max(0, e.touches[0].clientY - y0);
        sh.style.transform = `translateY(${dy}px)`;
      }, { passive: true });
      h.addEventListener("touchend", () => {
        sh.style.transition = "";
        sh.style.transform = "";
        if (dy > 90) closeSheet();
        y0 = null;
      });
    });
    document.body.style.overflow = "hidden";
    sheet = { bd, sh };
    if (onMount) onMount(sh);
    return sh;
  }
  function closeSheet(instant) {
    if (!sheet) return;
    const { bd, sh } = sheet;
    sheet = null;
    document.body.style.overflow = "";
    if (instant) {
      bd.remove();
      sh.remove();
      return;
    }
    bd.classList.remove("show");
    sh.classList.remove("show");
    setTimeout(() => {
      bd.remove();
      sh.remove();
    }, 380);
  }
  const opts = (name, map, sel) =>
    `<div class="opts" data-name="${name}" data-value="${esc(sel ?? "")}">${Object.entries(map)
      .map(([v, l]) => `<button type="button" class="opt${String(sel) === String(v) ? " on" : ""}" data-val="${esc(v)}">${esc(l)}</button>`)
      .join("")}</div>`;
  const val = (sh, name) => $(`[data-name="${name}"]`, sh)?.dataset.value || "";
  const WEEK_OPTS = Object.fromEntries(WEEKS.map((w) => [w, `${w} wks`]));

  // ---------- auth screens ----------
  const root = () => $("#root");

  function renderSetup() {
    closeSheet(true);
    root().innerHTML = `
      <div class="auth">
        <div class="auth-hero">
          <div class="coin-logo big spin">£</div>
          <h1>TrueStay <em>Pay</em></h1>
          <p>One-time setup. Choose the email and password you'll use to get in. After this, you stay signed in.</p>
        </div>
        <form class="auth-card" id="authForm" autocomplete="on">
          <div class="field"><label for="f-name">Your first name</label><input id="f-name" name="name" autocomplete="given-name" required></div>
          <div class="field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="username" autocapitalize="off" required></div>
          <div class="field"><label for="f-pw">Password <span>10+ characters</span></label><input id="f-pw" name="password" type="password" autocomplete="new-password" minlength="10" required></div>
          <div class="field"><label for="f-code">Setup code</label><input id="f-code" name="code" autocapitalize="characters" autocomplete="one-time-code" required></div>
          <div class="err" id="authErr"></div>
          <button class="btn lime" type="submit">Create my account</button>
        </form>
      </div>`;
    $("#authForm").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("button[type=submit]", e.target);
      btn.disabled = true;
      $("#authErr").textContent = "";
      try {
        await api("/setup", { method: "POST", raw: true, body: Object.fromEntries(new FormData(e.target)) });
        await boot();
      } catch (err) {
        $("#authErr").textContent = err.message;
        btn.disabled = false;
      }
    };
  }

  function renderLogin() {
    closeSheet(true);
    S.locked = false;
    root().innerHTML = `
      <div class="auth">
        <div class="auth-hero">
          <div class="coin-logo big spin">£</div>
          <h1>Money in, <em>sorted.</em></h1>
          <p>Sign in once on this device and you'll stay signed in.</p>
        </div>
        <form class="auth-card" id="authForm" autocomplete="on">
          <div class="field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="username" autocapitalize="off" required></div>
          <div class="field"><label for="f-pw">Password</label><input id="f-pw" name="password" type="password" autocomplete="current-password" required></div>
          <div class="err" id="authErr"></div>
          <button class="btn lime" type="submit">Sign in</button>
          ${window.PublicKeyCredential ? `<div class="auth-alt">or <button type="button" id="faceLogin">sign in with Face ID</button></div>` : ""}
        </form>
      </div>`;
    $("#authForm").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("button[type=submit]", e.target);
      btn.disabled = true;
      $("#authErr").textContent = "";
      try {
        await api("/login", { method: "POST", raw: true, body: Object.fromEntries(new FormData(e.target)) });
        setPref("hiddenAt", "0");
        await boot();
      } catch (err) {
        $("#authErr").textContent = err.message;
        btn.disabled = false;
      }
    };
    const fl = $("#faceLogin");
    if (fl)
      fl.onclick = async () => {
        $("#authErr").textContent = "";
        try {
          await passkeyAuth();
          setPref("hiddenAt", "0");
          await boot();
        } catch (e) {
          $("#authErr").textContent = webauthnError(e);
        }
      };
  }

  let unlocking = false;
  function renderLock() {
    closeSheet(true);
    S.locked = true;
    root().innerHTML = `
      <div class="lock-screen" id="lockScreen">
        <div class="spacer"></div>
        <div class="faceid">${ic("faceid")}</div>
        <h1>Locked</h1>
        <p>Tap anywhere to unlock with Face ID</p>
        <div class="err" id="lockErr"></div>
        <div class="spacer"></div>
        <button class="btn lime" id="unlockBtn">${ic("faceid")} Unlock</button>
        <button class="pw" id="pwBtn">Use password instead</button>
      </div>`;
    const go = async (silent) => {
      if (unlocking) return;
      unlocking = true;
      const el = $("#lockErr");
      if (el) el.textContent = "";
      try {
        await passkeyAuth();
        setPref("hiddenAt", "0");
        S.locked = false;
        haptic();
        await boot();
      } catch (e) {
        const el2 = $("#lockErr");
        if (el2 && !(silent && isCancel(e))) el2.textContent = webauthnError(e);
      } finally {
        unlocking = false;
      }
    };
    $("#lockScreen").onclick = (e) => {
      if (e.target.closest("#pwBtn")) return renderLogin();
      go(false);
    };
    go(true);
  }

  // ---------- derived numbers ----------
  // due = everything that was expected that month (the prediction); it ends up collected, still to come, or lost
  function monthStats(mk) {
    const ps = S.data.payments;
    const due = ps.filter((p) => mKey(p.due_date) === mk);
    const unpaid = due.filter(isOpen);
    const lost = due.filter(isLost);
    const received = ps.filter((p) => p.paid_date && mKey(p.paid_date) === mk);
    const overdue = ps.filter((p) => stOf(p) === "overdue");
    const dueSum = sum(due);
    const unpaidSum = sum(unpaid);
    const lostSum = sum(lost);
    return {
      due, dueSum, unpaid, unpaidSum, lost, lostSum, received, receivedSum: sum(received), overdue, overdueSum: sum(overdue),
      collected: dueSum - unpaidSum - lostSum,
    };
  }
  function monthRange() {
    const cur = mKey(londonToday());
    let first = mKey(TRACK_START);
    let last = addMonths(cur, 2);
    for (const p of S.data.payments) {
      const k = mKey(p.due_date);
      if (k < first) first = k;
      if (k > last) last = k;
    }
    const out = [];
    for (let k = first; k <= last; k = addMonths(k, 1)) out.push(k);
    return out;
  }

  // animated numbers: rendered at their old value, then counted to the new one
  const fmtKinds = { big: moneyBig, pct: (v) => v + "%", int: (v) => String(v), money, rate: pounds0 };
  const count = (key, value, kind = "money") => {
    const from = S.counts[key] ?? 0;
    return `<span data-count="${key}" data-val="${value}" data-kind="${kind}">${fmtKinds[kind](from)}</span>`;
  };
  function runCounts() {
    $$("[data-count]").forEach((el) => {
      const key = el.dataset.count;
      const to = Number(el.dataset.val);
      const f = fmtKinds[el.dataset.kind] || money;
      const from = S.counts[key] ?? 0;
      S.counts[key] = to;
      if (from === to || reduced) {
        el.innerHTML = f(to);
        return;
      }
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 800);
        const e = 1 - Math.pow(1 - k, 3);
        el.innerHTML = f(Math.round(from + (to - from) * e));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  // ---------- shared row renderers ----------
  function pill(p) {
    const st = stOf(p);
    if (st === "paid") return `<span class="pill paid">Paid ${fmtDay(p.paid_date)}</span>`;
    if (st === "missed") return `<span class="pill missed">Didn't pay</span>`;
    if (st === "overdue") return `<span class="pill overdue">Overdue · ${daysBetween(p.due_date, londonToday())}d</span>`;
    return `<span class="pill unpaid">Unpaid</span>`;
  }
  const chasedNote = (p) => (p.chase_count && isOpen(p) ? `<span class="chased">${ic("chat")} Chased ${p.chase_count > 1 ? p.chase_count + "× · " : ""}${ago(p.chased_at)}</span>` : "");
  // what happened when it was marked as didn't pay
  const STOPPED = { pause: ["pause", "Service stopped"], finish: ["flag", "Finished"], skip: ["repeat", "Plan carried on"] };
  const stopNote = (p) => (isLost(p) && STOPPED[p.stop_mode] ? `<span class="chased">${ic(STOPPED[p.stop_mode][0])} ${STOPPED[p.stop_mode][1]}</span>` : "");
  function prow(p, { showClient = true } = {}) {
    const st = stOf(p);
    const rep = p.auto ? " " + ic("repeat") : "";
    const title = showClient ? esc(cname(p)) : `Due ${fmtShort(p.due_date)}`;
    const meta = `${esc(pkgText(p.package, p.programme_weeks))} · ${METH[p.method]}${rep}`;
    const row = `<div class="prow st-${st}" data-open-pay="${p.id}" role="button" tabindex="0">
      <div class="av">${showClient ? esc(initials(cname(p))) : ic("receipt")}</div>
      <div class="main">
        <div class="name">${title}</div>
        <div class="meta">${meta}</div>
        <div class="pills">${pill(p)}${chasedNote(p)}${stopNote(p)}</div>
      </div>
      <div class="right">
        <div class="amt num">${money(p.amount_pence)}</div>
        ${showClient ? `<div class="when">Due ${fmtShort(p.due_date)}</div>` : ""}
      </div>
      ${
        st === "paid"
          ? `<div class="paydone" aria-label="Paid">${ic("check")}</div>`
          : st === "missed"
          ? `<div class="paydone lost" aria-label="Didn't pay">${ic("x")}</div>`
          : `<button class="paybtn" data-pay="${p.id}" aria-label="Mark ${esc(cname(p))} as paid">${ic("check")}</button>`
      }
    </div>`;
    return !isOpen(p)
      ? `<div class="swipe" data-pid="${p.id}">${row}</div>`
      : `<div class="swipe" data-pid="${p.id}"><div class="swipe-bg chase">${ic("chat")} Chase</div><div class="swipe-bg paid">${ic("check")} Paid</div>${row}</div>`;
  }
  function ptable(ps) {
    return `<div class="table-wrap"><table class="pt">
      <thead><tr><th>Client</th><th>Package</th><th class="n">Amount</th><th>Due date</th><th>Payment method</th><th>Status</th><th>Paid date</th><th>Actions</th></tr></thead>
      <tbody>${ps
        .map((p) => {
          const st = stOf(p);
          return `<tr class="st-${st}">
          <td class="client">${esc(cname(p))}${p.auto ? ` <span title="From their plan" style="display:inline-block;vertical-align:-2px;width:13px;color:var(--muted)">${ic("repeat")}</span>` : ""}</td>
          <td>${esc(pkgText(p.package, p.programme_weeks))}</td>
          <td class="n num">${money(p.amount_pence)}</td>
          <td class="num">${fmtUK(p.due_date)}</td>
          <td>${METH_LONG[p.method]}</td>
          <td><span class="pill ${st}">${STL[st]}</span></td>
          <td class="num">${fmtUK(p.paid_date)}</td>
          <td><div class="acts">${isOpen(p) ? `<button class="mini dark" data-pay="${p.id}">Mark paid</button><button class="mini" data-chase="${p.id}">Chase</button>` : ""}<button class="mini" data-open-pay="${p.id}">Edit</button></div></td>
        </tr>`;
        })
        .join("")}</tbody></table></div>`;
  }
  const topbar = (title, right = "") => `<div class="topbar"><div class="title">${title}</div><div class="actions">${right}</div></div>`;
  const settingsBtn = () => `<button class="round" data-tab="more" aria-label="Settings">${ic("user")}</button>`;

  function decisionCard(d, i = 0) {
    const { c, p, ended } = d;
    const back = planBefore(p);
    const when = ended ? `ended ${fmtShort(p.end_date)}` : p.end_date === londonToday() ? "ends today" : `ends ${fmtShort(p.end_date)}`;
    return `<section class="decide rise" style="--i:${i}">
      <div class="dh"><span class="ico">${ic("flag")}</span><div><b>${esc(firstName(c.name))}'s ${esc(planName(p).toLowerCase())} ${when}</b><small>What's next for them?</small></div>
        <button class="x" data-dismiss="${p.id}" aria-label="Dismiss">${ic("x")}</button></div>
      <div class="da">
        ${back ? `<button class="btn sm lime" data-resume="${p.id}">Back to ${esc(KIND_SHORT[back.kind])} · ${esc(planPrice(back))}</button>` : ""}
        <button class="btn sm ghost" data-change-plan="${c.id}" data-from="${addDays(p.end_date, 1)}">Something else</button>
        <button class="btn sm ghost" data-finish="${c.id}" data-date="${p.end_date}">Finished</button>
      </div>
    </section>`;
  }

  // ---------- views ----------
  function viewMonth() {
    const mk = S.month;
    const today = londonToday();
    const cur = mKey(today);
    const st = monthStats(mk);
    const name = S.session?.name ? ", " + esc(S.session.name) : "";
    const h = londonHour();
    const greet = h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
    const range = monthRange();
    const maxBar = Math.max(1, ...range.map((k) => sum(S.data.payments.filter((p) => mKey(p.due_date) === k))));
    const idx = range.indexOf(mk);
    const pct = st.dueSum ? Math.round((st.collected / st.dueSum) * 100) : 0;
    const lostPct = st.dueSum ? Math.round((st.lostSum / st.dueSum) * 100) : 0;
    const lostWho = [...new Set(st.lost.map((p) => firstName(cname(p))))];
    const older = st.overdue.filter((p) => mKey(p.due_date) < mk);
    const noClients = !S.data.clients.length;
    const showFace = S.platformAuth && !S.session.hasPasskey && pref("hideFace", "0") !== "1";
    const decs = decisions();

    return `
      ${topbar(`<span class="coin-logo spin">£</span>`, `<a class="round" href="${API}/export?type=payments" aria-label="Export payments CSV">${ic("download")}</a>${settingsBtn()}`)}
      <h1 class="hello rise" style="--i:0">${greet}${name}. <em>Here's what's</em> coming in.</h1>
      ${noClients ? "" : todayCard()}
      ${decs.map((d, i) => decisionCard(d, i + 1)).join("")}

      <div class="monthbar rise" style="--i:1">
        <div class="m">${mLabel(mk)}${mk === cur ? "<small>this month</small>" : ""}</div>
        <div class="navs">
          <button class="round" data-month="${range[idx - 1] || ""}" ${idx > 0 ? "" : "disabled"} aria-label="Previous month">${ic("left")}</button>
          <button class="round" data-month="${range[idx + 1] || ""}" ${idx < range.length - 1 ? "" : "disabled"} aria-label="Next month">${ic("right")}</button>
        </div>
      </div>
      <div class="strip" id="strip">
        ${range
          .map((k, i) => {
            const ps = S.data.payments.filter((p) => mKey(p.due_date) === k);
            const due = sum(ps);
            const got = sum(ps.filter((p) => p.paid_date));
            const lost = sum(ps.filter(isLost));
            const hh = Math.round((due / maxBar) * 40);
            const hg = due ? Math.round((got / due) * hh) : 0;
            const hl = due && lost ? Math.max(3, Math.round((lost / due) * hh)) : 0;
            const ho = Math.max(hl ? 0 : 4, hh - hg - hl);
            return `<button class="mpill${k === mk ? " sel" : ""}${k === cur ? " now" : ""}" data-month="${k}" style="--i:${i}" aria-label="${mLabel(k)}">
              <div class="bars">
                ${hl ? `<div class="bar lost" style="height:${hl}px"></div>` : ""}
                ${ho ? `<div class="bar" style="height:${ho}px"></div>` : ""}
                ${hg ? `<div class="bar recv" style="height:${hg}px"></div>` : ""}
              </div>
              <span class="lbl">${mShort(k)}</span></button>`;
          })
          .join("")}
      </div>

      <section class="hero rise ${S.heroAnim}" style="--i:2" id="hero">
        ${rings}
        <div class="k">Due in ${mName(mk)}</div>
        <div class="big">${count("due", st.dueSum, "big")}</div>
        <div class="sub">${plural(st.due.length, "payment")} scheduled · ${money(st.collected)} of it paid${st.lostSum ? ` · ${money(st.lostSum)} lost` : ""}</div>
        <div class="progress" role="img" aria-label="${pct}% of this month's payments collected${st.lostSum ? `, ${lostPct}% lost` : ""}">
          ${lostPct ? `<div class="lostbar" style="width:${lostPct}%"></div>` : ""}
          <div class="fill" data-pct="${pct}" style="width:${S.counts.pct ?? 0}%"><span class="knob">${count("pct", pct, "pct")}</span></div>
        </div>
        <div class="progress-legend"><span>Collected ${money(st.collected)}</span><span>Left ${money(st.unpaidSum)}</span>${st.lostSum ? `<span class="lost">Lost ${money(st.lostSum)}</span>` : ""}</div>
      </section>

      <div class="tiles">
        <button class="tile lime wide rise" style="--i:3" data-scope="received" id="recvTile">
          <span class="arrow">${ic("arrow")}</span>
          <div class="k">Received in ${mName(mk)}</div>
          <div class="v">${count("recv", st.receivedSum, "big")}</div>
          <div class="s">${plural(st.received.length, "payment")} actually landed, by paid date</div>
        </button>
        <button class="tile rise" style="--i:4" data-scope="month" data-status="notpaid">
          <span class="arrow">${ic("arrow")}</span>
          <div class="k">Still unpaid</div>
          <div class="v">${count("unpaid", st.unpaidSum)}</div>
          <div class="s">${plural(st.unpaid.length, "payment")} due in ${mShort(mk)}</div>
        </button>
        <button class="tile red rise${st.overdueSum ? " has" : ""}" style="--i:5" data-action="chase-list">
          <span class="arrow">${ic("chat")}</span>
          <div class="k">Overdue now</div>
          <div class="v">${count("overdue", st.overdueSum)}</div>
          <div class="s">${st.overdue.length ? '<span class="live"></span>' + plural(st.overdue.length, "payment") + " · tap to chase" : "0 payments, all months"}</div>
        </button>
      </div>
      ${
        st.lostSum
          ? `<button class="lost-line rise" style="--i:6" data-scope="month" data-status="missed"><span class="dot">${ic("x")}</span><span><b>${money(st.lostSum)} lost in ${mName(mk)}</b><br>${esc(lostWho.join(", "))} didn't pay</span><span class="go">${ic("right")}</span></button>`
          : ""
      }
      ${mk === mKey(TRACK_START) ? `<p class="note">${ic("info")}<span>Tracking started on 28 September 2026, so September only includes payments from then on.</span></p>` : ""}
      ${mk > cur ? `<p class="note">${ic("info")}<span>Only shows payments already on the books. Monthly plans add theirs about a month ahead.</span></p>` : ""}
      ${
        older.length && S.scope === "month"
          ? `<button class="banner" data-action="chase-list"><span class="dot">${ic("alert")}</span><span><b>${plural(older.length, "older payment")} still unpaid</b><br>${money(sum(older))} from before ${mName(mk)} · chase them</span><span class="go">${ic("right")}</span></button>`
          : ""
      }
      ${
        showFace
          ? `<div class="setup-card"><div class="ico">${ic("faceid")}</div><div><div class="t">Turn on Face ID</div><div class="d">Glance to unlock instead of typing your password.</div></div><button class="btn sm lime" data-action="faceid-setup">Set up</button><button class="x" data-action="hide-face" aria-label="Not now">${ic("x")}</button></div>`
          : ""
      }

      <div class="section-head">
        <h2>Payments</h2>
        <div class="seg small icons" data-seg="listmode" aria-label="View">
          <button class="${S.listMode === "list" ? "on" : ""}" data-listmode="list" aria-label="List view">${ic("list")}</button>
          <button class="${S.listMode === "table" ? "on" : ""}" data-listmode="table" aria-label="Table view">${ic("table")}</button>
        </div>
      </div>
      ${
        noClients
          ? `<div class="empty"><b>Let's get your clients in</b><span>Add each client with their plan. Monthly plans look after their own payments.</span><button class="btn sm lime" data-action="add-client">${ic("userplus")} Add your first client</button></div>`
          : `
      <div class="filters">
        <div class="seg small full" data-seg="scope">
          <button class="${S.scope === "month" ? "on" : ""}" data-scope="month" data-status="all">Due in ${mShort(mk)}</button>
          <button class="${S.scope === "received" ? "on" : ""}" data-scope="received" data-status="all">Paid in ${mShort(mk)}</button>
          <button class="${S.scope === "unpaid" ? "on" : ""}" data-scope="unpaid" data-status="all">All unpaid</button>
          <button class="${S.scope === "all" ? "on" : ""}" data-scope="all" data-status="all">All</button>
        </div>
        <div class="filter-row">
          <label class="search">${ic("search")}<input id="q" type="search" placeholder="Search client" value="${esc(S.q)}" autocomplete="off" enterkeyhint="search"></label>
        </div>
        <div class="filter-row">
          <select class="pick${S.fStatus !== "all" ? " active" : ""}" id="fStatus" aria-label="Status">
            ${[["all", "Any status"], ["notpaid", "Unpaid + overdue"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"], ["missed", "Didn't pay"]]
              .map(([v, l]) => `<option value="${v}" ${S.fStatus === v ? "selected" : ""}>${l}</option>`)
              .join("")}
          </select>
          <select class="pick${S.fPkg !== "all" ? " active" : ""}" id="fPkg" aria-label="Package">
            <option value="all">Any package</option>
            ${Object.entries(PKG).map(([v, l]) => `<option value="${v}" ${S.fPkg === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
      </div>
      <div id="plist"></div>`
      }`;
  }

  function todayCard() {
    const today = londonToday();
    const unpaid = S.data.payments.filter(isOpen);
    const dueToday = unpaid.filter((p) => p.due_date === today);
    const week = unpaid.filter((p) => p.due_date > today && p.due_date <= addDays(today, 7));
    const overdue = unpaid.filter((p) => p.due_date < today);
    return `<section class="today-card rise" style="--i:1">
      <div class="tc-head"><b>Today <span>${fmtShort(today)}</span></b>${
        needCount() ? `<button class="tc-needs" data-action="needs">${needCount()} need${needCount() === 1 ? "s" : ""} you ${ic("right")}</button>` : ""
      }</div>
      ${
        dueToday.length
          ? `<div class="tc-list">${dueToday
              .map(
                (p) => `<div class="tc-row" data-open-pay="${p.id}" role="button" tabindex="0">
                  <span class="av sm">${esc(initials(cname(p)))}</span>
                  <span class="n">${esc(cname(p))}<small>${esc(pkgText(p.package, p.programme_weeks))} · ${METH[p.method]}</small></span>
                  <span class="a num">${money(p.amount_pence)}</span>
                  <button class="paybtn sm" data-pay="${p.id}" aria-label="Mark ${esc(cname(p))} as paid">${ic("check")}</button>
                </div>`
              )
              .join("")}</div>`
          : `<p class="tc-none">${ic("check")} Nothing due today.</p>`
      }
      <div class="tc-foot">
        <span>Next 7 days <b class="num">${week.length ? `${week.length} · ${money(sum(week))}` : "nothing due"}</b></span>
        ${overdue.length ? `<button class="tc-chase" data-action="chase-list">${ic("chat")} ${overdue.length} overdue · ${money(sum(overdue))}</button>` : ""}
      </div>
    </section>`;
  }

  // ---------- "Needs you": what the notification / app badge is about ----------
  function needsItems() {
    const today = londonToday();
    const unpaid = S.data.payments.filter(isOpen);
    return {
      dueToday: unpaid.filter((p) => p.due_date === today),
      overdue: unpaid.filter((p) => p.due_date < today).sort((a, b) => (a.due_date < b.due_date ? -1 : 1)),
      ending: decisions().filter((d) => d.p.end_date <= today),
    };
  }
  // same number as the app icon badge and the morning notification's badge
  function needCount() {
    return actionCount();
  }
  function needsHtml() {
    const today = londonToday();
    const { dueToday, overdue, ending } = needsItems();
    if (!dueToday.length && !overdue.length && !ending.length)
      return `<div class="needs-clear">${ic("check")}<b>All clear</b><p>Nothing's waiting on you. If a notification brought you here, whatever it was about has been sorted since.</p></div>`;
    const row = (p, late) => `<div class="tc-item${late ? " late" : ""}"><div class="tc-row" data-open-pay="${p.id}" role="button" tabindex="0">
        <span class="av sm">${esc(initials(cname(p)))}</span>
        <span class="n">${esc(cname(p))}<small>${
          late
            ? `Due ${fmtShort(p.due_date)} · ${plural(daysBetween(p.due_date, today), "day")} late${p.chase_count ? ` · chased ${p.chase_count}×` : " · not chased"}`
            : `${esc(pkgText(p.package, p.programme_weeks))} · ${METH[p.method]}`
        }</small></span>
        <span class="a num">${money(p.amount_pence)}</span>
        <button class="paybtn sm" data-pay="${p.id}" aria-label="Mark ${esc(cname(p))} as paid">${ic("check")}</button>
      </div>${
        late
          ? `<div class="tc-acts"><button class="chip" data-chase="${p.id}">${ic("chat")} Chase</button><button class="chip stop" data-missed="${p.id}">${ic("x")} Didn't pay</button></div>`
          : ""
      }</div>`;
    const part = (title, sub, body) => `<section class="needs-part"><h4>${title}<small>${sub}</small></h4><div class="tc-list">${body}</div></section>`;
    return `
      <p class="hint">Tick anything that's come in. It drops off here and off the app badge.</p>
      ${dueToday.length ? part("Due today", `${plural(dueToday.length, "payment")} · ${money(sum(dueToday))}`, dueToday.map((p) => row(p, false)).join("")) : ""}
      ${
        overdue.length
          ? part("Not marked paid yet", `${plural(overdue.length, "payment")} · ${money(sum(overdue))}`, overdue.map((p) => row(p, true)).join("")) +
            `<p class="hint">Not coming? Tap <b>Didn't pay</b>: their service stops and it counts as money lost, not owed.</p>` +
            (overdue.length > 1 ? `<button class="btn ghost" data-action="chase-list">${ic("chat")} Chase them all</button>` : "")
          : ""
      }
      ${
        ending.length
          ? part(
              "Plans ending",
              "Decide what's next",
              ending
                .map(
                  ({ c, p, ended }) => `<button class="tc-row" data-open-client="${c.id}" data-close-sheet>
                    <span class="av sm">${esc(initials(c.name))}</span>
                    <span class="n">${esc(c.name)}<small>${esc(planName(p))} ${ended ? `ended ${fmtShort(p.end_date)}` : "ends today"}</small></span>
                    <span class="go">${ic("right")}</span>
                  </button>`
                )
                .join("")
            )
          : ""
      }`;
  }
  function needsSheet() {
    const sh = openSheet("Needs you", needsHtml());
    sh.dataset.kind = "needs";
  }
  function refreshNeeds() {
    if (sheet && sheet.sh.dataset.kind === "needs") $(".sheet-body", sheet.sh).innerHTML = needsHtml();
  }
  // opened from the morning notification (/pay/?needs=1, or a message from the service worker)
  function openPendingNeeds() {
    if (!S.pendingNeeds || !S.data || S.locked || awayTooLong()) return;
    S.pendingNeeds = false;
    needsSheet();
  }

  function filteredPayments() {
    const mk = S.month;
    let ps = S.data.payments.slice();
    if (S.scope === "month") ps = ps.filter((p) => mKey(p.due_date) === mk);
    else if (S.scope === "received") ps = ps.filter((p) => p.paid_date && mKey(p.paid_date) === mk);
    else if (S.scope === "unpaid") ps = ps.filter(isOpen);
    if (S.fStatus === "notpaid") ps = ps.filter(isOpen);
    else if (S.fStatus !== "all") ps = ps.filter((p) => stOf(p) === S.fStatus);
    if (S.fPkg !== "all") ps = ps.filter((p) => p.package === S.fPkg);
    if (S.q.trim()) {
      const q = S.q.trim().toLowerCase();
      ps = ps.filter((p) => cname(p).toLowerCase().includes(q));
    }
    const byDue = (a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.id - b.id);
    if (S.scope === "received") ps.sort((a, b) => (a.paid_date < b.paid_date ? -1 : a.paid_date > b.paid_date ? 1 : a.id - b.id));
    else if (S.scope === "all") ps.sort((a, b) => -byDue(a, b));
    else ps.sort(byDue);
    return ps;
  }

  function renderList() {
    const el = $("#plist");
    if (!el) return;
    const ps = filteredPayments();
    if (!ps.length) {
      const msg =
        S.q || S.fStatus !== "all" || S.fPkg !== "all"
          ? "Nothing matches those filters."
          : S.scope === "received"
          ? `Nothing marked as paid in ${mName(S.month)} yet.`
          : S.scope === "unpaid"
          ? "Nobody owes you anything. Nice."
          : `Nothing scheduled for ${mName(S.month)} yet.`;
      el.innerHTML = `<div class="empty"><b>${msg}</b>${S.scope === "month" ? `<button class="btn sm" data-action="add-payment">${ic("plus")} Add payment</button>` : ""}</div>`;
      return;
    }
    const hasUnpaid = ps.some(isOpen);
    el.innerHTML =
      (S.listMode === "table" ? ptable(ps) : `<div class="list">${ps.map((p) => prow(p)).join("")}</div>`) +
      `<div class="total-line"><span>${plural(ps.length, "payment")}</span><span>Total <b class="num">${money(sum(ps))}</b></span></div>` +
      (S.listMode === "list" && hasUnpaid ? `<p class="tip">Swipe left to mark paid · swipe right to chase</p>` : "");
  }

  function viewCalendar() {
    const mk = S.calMonth;
    const today = londonToday();
    const [y, m] = nums(mk);
    const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    const n = daysIn(mk);
    const field = S.calMode === "due" ? "due_date" : "paid_date";
    const byDay = new Map();
    for (const p of S.data.payments) {
      const d = p[field];
      if (!d || mKey(d) !== mk) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(p);
    }
    const order = { overdue: 0, unpaid: 1, missed: 2, paid: 3 };
    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<div class="day out"></div>`;
    for (let d = 1; d <= n; d++) {
      const iso = `${mk}-${pad(d)}`;
      const items = (byDay.get(iso) || []).slice().sort((a, b) => order[stOf(a)] - order[stOf(b)]);
      const coins = items.slice(0, 3).map((p) => `<span class="coin ${stOf(p)}" style="--d:${d}">£</span>`).join("");
      const more = items.length > 3 ? `<span class="coin more" style="--d:${d}">+${items.length - 3}</span>` : "";
      cells += `<button class="day${iso === today ? " today" : ""}${iso === S.calDay ? " sel" : ""}${iso < TRACK_START ? " pre" : ""}" data-day="${iso}" aria-label="${fmtLong(iso)}${items.length ? ", " + plural(items.length, "payment") : ""}">
        <span class="dn">${d}</span>
        <span class="coins">${coins}${more}</span>
        ${items.length ? `<span class="dsum num">${moneyCompact(sum(items))}</span>` : ""}
      </button>`;
    }
    const dayItems = (byDay.get(S.calDay) || []).slice().sort((a, b) => order[stOf(a)] - order[stOf(b)] || a.id - b.id);
    const st = monthStats(mk);
    return `
      ${topbar("Calendar", `<div class="seg small" data-seg="calmode"><button class="${S.calMode === "due" ? "on" : ""}" data-calmode="due">Due</button><button class="${S.calMode === "paid" ? "on" : ""}" data-calmode="paid">Received</button></div>`)}
      <div class="cal-card rise" style="--i:0" id="calCard">
        <div class="cal-head">
          <div class="m">${mLabel(mk)}</div>
          <div class="navs">
            ${mk !== mKey(today) ? `<button class="mini" data-cal="today">Today</button>` : ""}
            <button class="round" data-cal="prev" aria-label="Previous month">${ic("left")}</button>
            <button class="round" data-cal="next" aria-label="Next month">${ic("right")}</button>
          </div>
        </div>
        <div class="wk"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
        <div class="grid ${S.calAnim}" id="calGrid">${cells}</div>
        <div class="cal-legend"><span><i style="background:var(--red)"></i>Overdue</span><span><i style="background:var(--amber)"></i>Unpaid</span><span><i style="background:var(--green)"></i>Paid</span>${
          S.data.payments.some(isLost) ? `<span><i class="lost"></i>Didn't pay</span>` : ""
        }</div>
      </div>
      <div class="cal-totals">
        <div class="tile rise" style="--i:1"><div class="k">Due in ${mShort(mk)}</div><div class="v">${count("cdue", st.dueSum)}</div><div class="s">${money(st.unpaidSum)} still unpaid${st.lostSum ? ` · ${money(st.lostSum)} lost` : ""}</div></div>
        <div class="tile lime rise" style="--i:2"><div class="k">Received in ${mShort(mk)}</div><div class="v" style="font-size:27px">${count("crecv", st.receivedSum)}</div><div class="s">by paid date</div></div>
      </div>
      <div class="day-head"><h3>${fmtLong(S.calDay)}</h3><span class="num">${dayItems.length ? money(sum(dayItems)) : ""}</span></div>
      ${
        dayItems.length
          ? `<div class="list">${dayItems.map((p) => prow(p)).join("")}</div>`
          : `<div class="empty"><b>${S.calMode === "due" ? "Nothing due" : "Nothing received"} on this day</b>${
              S.data.clients.length ? `<button class="btn sm" data-action="add-payment" data-date="${S.calDay}">${ic("plus")} Add payment due this day</button>` : ""
            }</div>`
      }`;
  }

  const clientPayments = (id) => S.data.payments.filter((p) => p.client_id === id);
  const clientOwes = (id) => clientPayments(id).filter((p) => stOf(p) === "overdue");
  // the didn't-pay payment behind a client's current stop (only while their plans still look the way the stop left them)
  const stopBy = (id) =>
    clientPayments(id)
      .filter((p) => isLost(p) && p.can_restart)
      .sort((a, b) => (a.due_date < b.due_date ? 1 : -1))[0] || null;
  // plans ended by a didn't-pay, and breaks it started: why they ended, for the timeline
  const stoppedBy = (planId) => {
    const cid = planOf(planId)?.client_id;
    return S.data.payments.find((p) => p.client_id === cid && isLost(p) && ((p.stop_plans || []).includes(planId) || p.stop_break === planId)) || null;
  };
  const clientNext = (id) =>
    clientPayments(id)
      .filter((p) => isOpen(p) && p.due_date >= londonToday())
      .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];

  function viewClients() {
    if (S.clientId && client(S.clientId)) return viewClient(client(S.clientId));
    S.clientId = null;
    const cs = S.data.clients;
    const counts = { active: 0, paused: 0, finished: 0 };
    cs.forEach((c) => counts[statusOf(c)]++);
    return `
      ${topbar("Clients", `<button class="round lime" data-action="add-client" aria-label="Add client">${ic("plus")}</button>`)}
      <div class="filters">
        <label class="search">${ic("search")}<input id="cq" type="search" placeholder="Search clients" value="${esc(S.cq)}" autocomplete="off"></label>
        <div class="seg small full" data-seg="cstatus">
          ${["active", "paused", "finished"].map((s) => `<button class="${S.cStatus === s ? "on" : ""}" data-cstatus="${s}">${s === "paused" ? "On a break" : CST[s]} ${counts[s]}</button>`).join("")}
          <button class="${S.cStatus === "all" ? "on" : ""}" data-cstatus="all">All ${cs.length}</button>
        </div>
      </div>
      <div id="clist"></div>`;
  }
  function renderClientList() {
    const el = $("#clist");
    if (!el) return;
    let list = S.data.clients;
    if (S.cStatus !== "all") list = list.filter((c) => statusOf(c) === S.cStatus);
    if (S.cq.trim()) list = list.filter((c) => c.name.toLowerCase().includes(S.cq.trim().toLowerCase()));
    if (!S.data.clients.length) {
      el.innerHTML = `<div class="empty"><b>No clients yet</b><span>Add your current clients and what they're on.</span><button class="btn sm lime" data-action="add-client">${ic("userplus")} Add client</button></div>`;
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="empty"><b>No ${S.cStatus === "all" ? "" : S.cStatus === "paused" ? "clients on a break" : CST[S.cStatus].toLowerCase() + " clients"}${S.cq ? " match that" : ""}</b></div>`;
      return;
    }
    el.innerHTML = `<div class="list">${list
      .map((c, i) => {
        const owes = clientOwes(c.id);
        const next = clientNext(c.id);
        const status = statusOf(c);
        const cp = curPlan(c.id);
        const stop = stopBy(c.id);
        const plan =
          stop && ((cp && cp.id === stop.stop_break) || (status === "finished" && stop.stop_mode === "finish"))
            ? `${stop.stop_mode === "finish" ? "Finished" : "Service stopped"}: didn't pay ${fmtDay(stop.due_date)}`
            : cp
            ? cp.kind === "break"
              ? `On a break${cp.end_date ? ` until ${fmtDay(cp.end_date)}` : ""}`
              : `${planName(cp)} · ${planPrice(cp)}`
            : upcomingPlan(c.id)
            ? `Starts ${fmtDay(upcomingPlan(c.id).start_date)}`
            : status === "finished"
            ? `Finished ${fmtDay(c.finished_on)}`
            : "No plan yet";
        const right = owes.length
          ? `<b class="owe num">${money(sum(owes))}</b>overdue`
          : next
          ? `<b class="num">${money(next.amount_pence)}</b>next ${fmtDay(next.due_date)}`
          : `<b>—</b>nothing due`;
        return `<button class="crow rise${status !== "active" ? " dim" : ""}" style="--i:${Math.min(i, 8)}" data-open-client="${c.id}">
          <div class="av">${esc(initials(c.name))}</div>
          <div class="main">
            <div class="name"><span class="t">${esc(c.name)}</span>${c.tenure === "new" ? `<span class="tag new">New</span>` : ""}</div>
            <div class="meta">${esc(plan)}</div>
          </div>
          <div class="right">${right}</div>
          <span class="chev">${ic("right")}</span>
        </button>`;
      })
      .join("")}</div>`;
  }

  // Client profile: read-only; changes happen in clearly-labelled sheets.
  function viewClient(c) {
    const today = londonToday();
    const ps = clientPayments(c.id).sort((a, b) => (a.due_date < b.due_date ? 1 : a.due_date > b.due_date ? -1 : b.id - a.id));
    const owes = clientOwes(c.id);
    const next = clientNext(c.id);
    const received = ps.filter((p) => p.paid_date);
    const plans = plansOf(c.id);
    const cp = curPlan(c.id);
    const status = statusOf(c);
    const dec = decisions().find((d) => d.c.id === c.id);
    const since = plans[0]?.start_date || TRACK_START;
    const months = Math.max(1, Math.round((daysBetween(since, c.finished_on && c.finished_on < today ? c.finished_on : today) + 1) / 30.44));
    const avg = Math.round(sum(received) / months);
    const hours = cp && cp.hours_per_month ? cp.hours_per_month : null;
    const rate = hours ? Math.round(monthlyValue(cp) / hours) : null;
    const stop = stopBy(c.id);
    const stopped = stop && ((cp && cp.id === stop.stop_break) || (status === "finished" && stop.stop_mode === "finish"));
    const planLine = stopped
      ? stop.stop_mode === "finish" ? "Finished: didn't pay" : "Service stopped"
      : cp ? (cp.kind === "break" ? `On a break${cp.end_date ? ` until ${fmtDay(cp.end_date)}` : ""}` : planName(cp)) : status === "finished" ? "Finished" : "No current plan";
    const phone = (c.phone || "").trim();
    return `
      <div class="topbar">
        <button class="back" data-action="back">${ic("left")} Clients</button>
        <div class="actions">
          ${phone ? `<a class="round" href="https://wa.me/${waNumber(phone)}" target="_blank" rel="noopener" aria-label="Message ${esc(c.name)}">${ic("chat")}</a>` : ""}
          <button class="btn sm ghost" data-action="edit-client" data-client="${c.id}">${ic("edit")} Edit</button>
        </div>
      </div>
      <section class="profile rise" style="--i:0">
        ${rings}
        <div class="top">
          <div class="bigav">${esc(initials(c.name))}</div>
          <div style="min-width:0">
            <h1>${esc(c.name)}</h1>
            <div class="tags"><span class="tag dark${c.tenure === "new" ? " new" : ""}">${TEN[c.tenure]}</span><span class="tag dark">${status === "paused" ? "On a break" : CST[status]}</span></div>
          </div>
        </div>
        <div class="facts">
          <div>On<b>${esc(planLine)}</b></div>
          <div>Price<b class="num">${cp && cp.kind !== "break" ? esc(planPrice(cp)) : "—"}</b></div>
          <div>Pays by<b>${cp && cp.kind !== "break" ? METH_LONG[cp.method] : "—"}</b></div>
          <div>Next payment<b class="num">${next ? `${fmtDay(next.due_date)} · ${money(next.amount_pence)}` : "None scheduled"}</b></div>
        </div>
      </section>
      ${dec ? decisionCard(dec, 1) : ""}
      ${
        stopped
          ? `<section class="decide stopped rise" style="--i:1">
              <div class="dh"><span class="ico">${ic(stop.stop_mode === "finish" ? "flag" : "pause")}</span><div><b>${stop.stop_mode === "finish" ? "Finished" : "Service stopped"} from ${fmtShort(stop.stop_from)}</b><small>They didn't pay the ${money(stop.amount_pence)} due ${fmtShort(stop.due_date)}, so it's down as lost. ${
                stop.stop_mode === "finish" ? "" : "Change plan when they're back."
              }</small></div></div>
              <div class="da"><button class="btn sm lime" data-paid-after="${stop.id}">${ic("check")} They've paid after all</button></div>
            </section>`
          : ""
      }
      <div class="quick rise" style="--i:2">
        <button class="btn lime" data-change-plan="${c.id}">${ic("swap")} Change plan</button>
        <button class="btn ghost" data-action="add-payment" data-client="${c.id}">${ic("plus")} Add payment</button>
      </div>
      <div class="tiles" style="grid-template-columns:1fr 1fr">
        <button class="tile red rise${owes.length ? " has" : ""}" style="--i:3" ${owes.length ? `data-chase-client="${c.id}"` : "disabled"}><div class="k">Overdue</div><div class="v">${count("c-owe-" + c.id, sum(owes))}</div><div class="s">${owes.length ? '<span class="live"></span>' + plural(owes.length, "payment") + " · chase" : "All square"}</div></button>
        <div class="tile lime rise" style="--i:4"><div class="k">Received</div><div class="v" style="font-size:27px">${count("c-got-" + c.id, sum(received))}</div><div class="s">${received.length ? `≈ ${money(avg)}/month over ${plural(months, "month")}` : "since tracking began"}</div></div>
        ${
          rate
            ? `<div class="tile rise wide" style="--i:5"><div class="k">What you earn per hour</div><div class="v">${count("c-rate-" + c.id, rate, "rate")}<small>/hour</small></div><div class="s">${esc(planPrice(cp))} for about ${hours} hours a month</div></div>`
            : ""
        }
      </div>
      ${(() => {
        const h = payHabit(c.id);
        return h.n ? `<div class="habit-line rise" style="--i:5"><span class="k">Pay habit</span>${habitTag(h)}<small>${esc(h.line)}</small></div>` : "";
      })()}
      <div class="section-head"><h2 class="sm">Plans</h2><span class="hint" style="padding:0">Tap one to fix it</span></div>
      ${
        plans.length
          ? `<div class="timeline">${plans
              .slice()
              .reverse()
              .map((p) => {
                const isNow = cp && p.id === cp.id;
                const future = p.start_date > today;
                const firstFuture = plans.find((x) => x.start_date > today);
                const tag = isNow ? "Now" : future ? (firstFuture && p.id === firstFuture.id ? "Next" : "Later") : "Ended";
                const why = stoppedBy(p.id);
                const whyLine = why
                  ? `<small class="tl-why">${ic("x")} ${why.stop_break === p.id ? `After they didn't pay on ${fmtDay(why.due_date)}` : `Stopped: didn't pay ${money(why.amount_pence)} due ${fmtDay(why.due_date)}`}</small>`
                  : "";
                return `<button class="tl-row${isNow ? " now" : ""}${future ? " next" : ""}${p.kind === "break" ? " brk" : ""}" data-edit-plan="${p.id}">
                  <span class="tl-dot"></span>
                  <span class="tl-main"><b>${esc(planName(p))}</b><small>${esc(p.kind === "break" ? "No payments" : planPrice(p))}${p.billing === "monthly" && p.day_of_month ? ` · on the ${ordinal(p.day_of_month)}` : ""}</small><small>${planDates(p)}${p.then_action === "decide" && p.end_date ? " · ask me when it ends" : ""}</small>${whyLine}</span>
                  <span class="tl-tag">${tag}</span>
                </button>`;
              })
              .join("")}</div>`
          : `<div class="empty"><b>No plan yet</b><span>Set what they're on and the payments look after themselves.</span><button class="btn sm lime" data-change-plan="${c.id}">Set their plan</button></div>`
      }
      ${c.notes ? `<div class="section-head"><h2 class="sm">Notes</h2></div><div class="notes-card">${esc(c.notes)}</div>` : ""}
      <div class="section-head"><h2 class="sm">Payments</h2><span style="color:var(--muted);font-size:14px">${ps.length ? plural(ps.length, "payment") : ""}</span></div>
      ${
        ps.length
          ? `<div class="list">${ps.map((p) => prow(p, { showClient: false })).join("")}</div>`
          : `<div class="empty"><b>No payments yet</b><button class="btn sm" data-action="add-payment" data-client="${c.id}">${ic("plus")} Add a payment</button></div>`
      }`;
  }

  // ---------- Growth ----------
  // ---------- pay habits: builds up as payments come in ----------
  // A payment counts once it's paid, marked as didn't pay, or more than a day past due and still not in. Paid up to a day after the due date is on time.
  const GRACE_DAYS = 1;
  function payHabit(cid) {
    const today = londonToday();
    const ps = S.data.payments
      .filter(
        (p) =>
          (cid == null || p.client_id === cid) &&
          p.due_date >= TRACK_START &&
          (p.paid_date ? p.due_date <= today : p.missed_on || daysBetween(p.due_date, today) > GRACE_DAYS)
      )
      .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.id - b.id));
    let onTime = 0;
    let lateDays = 0;
    let lateN = 0;
    let lateNow = 0;
    let missed = 0;
    let chases = 0;
    for (const p of ps) {
      chases += p.chase_count || 0;
      if (isLost(p)) {
        missed++;
        continue;
      }
      if (!p.paid_date) {
        lateNow++;
        continue;
      }
      const d = daysBetween(p.due_date, p.paid_date);
      if (d <= GRACE_DAYS) onTime++;
      else {
        lateN++;
        lateDays += d;
      }
    }
    const n = ps.length;
    const rate = n ? onTime / n : 0;
    const avgLate = lateN ? Math.round(lateDays / lateN) : 0;
    const lastMissed = n > 0 && isLost(ps[n - 1]);
    let label, tone;
    if (lateNow) (label = "Late now"), (tone = "bad");
    else if (lastMissed) (label = "Didn't pay"), (tone = "bad");
    else if (n < 2) (label = "Not enough yet"), (tone = "new");
    else if (rate >= 0.9) (label = n >= 3 ? "Always on time" : "On time so far"), (tone = "good");
    else if (chases / n >= 0.5) (label = "Needs chasing"), (tone = "bad");
    else if (rate < 0.6) (label = "Often late"), (tone = "bad");
    else (label = "Mostly on time"), (tone = "ok");
    const bits = [`${onTime} of ${plural(n, "payment")} on time`];
    if (avgLate) bits.push(`${plural(avgLate, "day")} late on average when late`);
    if (lateNow) bits.push(`${lateNow} not in yet`);
    if (missed) bits.push(`didn't pay ${missed === 1 ? "once" : missed + "×"}`);
    bits.push(chases ? `chased ${chases}×` : "never chased");
    return { n, onTime, rate, avgLate, lateN, lateNow, missed, chases, label, tone, line: bits.join(" · ") };
  }
  const habitTag = (h) => `<span class="habit ${h.tone}">${h.label}</span>`;

  // monthly income and paying clients at the end of each month since tracking began (today for this month)
  function growthByMonth() {
    const today = londonToday();
    const out = [];
    for (let k = mKey(TRACK_START); k <= mKey(today); k = addMonths(k, 1)) {
      const end = k === mKey(today) ? today : addDays(addMonths(k, 1) + "-01", -1);
      let income = 0;
      let clients = 0;
      for (const c of S.data.clients) {
        if (c.finished_on && c.finished_on <= end) continue;
        const pl = planOn(c.id, end);
        if (!pl || pl.kind === "break") continue;
        const v = monthlyValue(pl);
        income += v;
        if (v > 0) clients++;
      }
      out.push({ k, income, clients, now: k === mKey(today) });
    }
    return out;
  }

  function viewGrowth() {
    const today = londonToday();
    const cur = mKey(today);
    const set = S.data.settings || {};
    const goal = Number(set.goalMonthly) || 0;
    const clientGoal = Number(set.goalClients) || 0;
    const active = S.data.clients.filter((c) => statusOf(c) === "active");
    const current = S.data.clients.map((c) => curPlan(c.id)).filter((p) => p && p.kind !== "break");
    const runRate = current.reduce((a, p) => a + monthlyValue(p), 0);
    const payingClients = current.filter((p) => monthlyValue(p) > 0);
    const avgClient = payingClients.length ? Math.round(runRate / payingClients.length) : 0;
    const recvMonth = monthStats(cur).receivedSum;
    const pctGoal = goal ? Math.min(100, Math.round((runRate / goal) * 100)) : 0;
    const pctRecv = goal ? Math.min(100, Math.round((recvMonth / goal) * 100)) : 0;
    const gap = goal - runRate;
    const need = gap > 0 && avgClient ? Math.ceil(gap / avgClient) : 0;

    // trend
    const months = [];
    for (let k = mKey(TRACK_START); k <= addMonths(cur, 2); k = addMonths(k, 1)) months.push(k);
    const trend = months.map((k) => ({
      k,
      due: sum(S.data.payments.filter((p) => mKey(p.due_date) === k)),
      got: sum(S.data.payments.filter((p) => p.paid_date && mKey(p.paid_date) === k)),
      lost: sum(S.data.payments.filter((p) => isLost(p) && mKey(p.due_date) === k)),
      future: k > cur,
    }));
    const anyLost = trend.some((t) => t.lost);
    const tMax = Math.max(10000, ...trend.map((t) => Math.max(t.due, t.got))); // floor of £100 so an empty chart reads £100 / £50 / £0, not £0.0.5
    const niceMax = niceCeil(tMax);
    const sel = trend.find((t) => t.k === (S.trendSel || cur)) || trend[0];

    // package mix
    const mix = { pt: 0, coaching: 0, programme: 0 };
    if (S.mixMode === "plans") current.forEach((p) => (mix[p.kind] += monthlyValue(p)));
    else
      S.data.payments
        .filter((p) => p.paid_date && (S.mixMode === "all" || mKey(p.paid_date) === cur))
        .forEach((p) => (mix[p.package] += p.amount_pence));
    const mixTotal = mix.pt + mix.coaching + mix.programme;

    // clients
    const monthStart = cur + "-01";
    const firstStart = (c) => plansOf(c.id)[0]?.start_date || null;
    const joined = S.data.clients.filter((c) => c.tenure === "new" && (firstStart(c) || "").startsWith(cur));
    const finished = S.data.clients.filter((c) => c.finished_on && mKey(c.finished_on) === cur);
    const onBreak = S.data.clients.filter((c) => statusOf(c) === "paused");
    const atStart = S.data.clients.filter((c) => {
      const fs = firstStart(c);
      return fs && fs <= monthStart && !(c.finished_on && c.finished_on < monthStart);
    });
    const churn = atStart.length ? Math.round((finished.length / atStart.length) * 100) : null;
    const stays = S.data.clients.map((c) => {
      const fs = firstStart(c);
      if (!fs) return null;
      const end = c.finished_on && c.finished_on < today ? c.finished_on : today;
      return daysBetween(fs, end) / 30.44;
    }).filter((x) => x != null);
    const avgStay = stays.length ? stays.reduce((a, b) => a + b, 0) / stays.length : 0;

    // hourly
    const withHours = current.filter((p) => p.hours_per_month > 0 && monthlyValue(p) > 0);
    const hrs = withHours.reduce((a, p) => a + p.hours_per_month, 0);
    const overallRate = hrs ? Math.round(withHours.reduce((a, p) => a + monthlyValue(p), 0) / hrs) : 0;
    const rates = withHours
      .map((p) => ({ c: client(p.client_id), rate: Math.round(monthlyValue(p) / p.hours_per_month), p }))
      .sort((a, b) => a.rate - b.rate);
    const rMax = Math.max(1, ...rates.map((r) => r.rate));

    // lifetime
    const ltv = S.data.clients
      .map((c) => ({ c, got: sum(clientPayments(c.id).filter((p) => p.paid_date)) }))
      .filter((x) => x.got > 0)
      .sort((a, b) => b.got - a.got)
      .slice(0, 5);

    // paying on time
    const allHabit = payHabit(null);
    const TONE_RANK = { bad: 0, ok: 1, good: 2, new: 3 };
    const habits = S.data.clients
      .map((c) => ({ c, h: payHabit(c.id) }))
      .filter((x) => x.h.n > 0)
      .sort((a, b) => TONE_RANK[a.h.tone] - TONE_RANK[b.h.tone] || b.h.lateNow - a.h.lateNow || a.h.rate - b.h.rate || b.h.chases - a.h.chases || a.c.name.localeCompare(b.c.name));

    // growth over time
    const gm = growthByMonth();
    const gMax = Math.max(1, ...gm.map((g) => g.income));

    return `
      ${topbar("Growth", settingsBtn())}
      <section class="hero rise" style="--i:0">
        ${rings}
        <div class="k">Monthly income <button class="edit-goal" data-action="goal">${goal ? `Goal ${money(goal)}` : "Set a goal"} ${ic("edit")}</button></div>
        <div class="big">${count("g-run", runRate, "rate")}<small>/month</small></div>
        <div class="sub">What your current plans bring in each month, with programmes spread across their length.</div>
        ${
          goal
            ? `<div class="progress" role="img" aria-label="${pctGoal}% of your monthly goal">
                 <div class="fill" data-pct="${pctGoal}" style="width:${S.counts["g-pct"] ?? 0}%"><span class="knob">${count("g-pct", pctGoal, "pct")}</span></div>
               </div>
               <div class="progress-legend"><span>${money(runRate)} now</span><span>Goal ${money(goal)}</span></div>
               <p class="gap">${gap > 0 ? `${money(gap)} to go${need ? ` · about ${plural(need, "more client")} at your average ${pounds0(avgClient)}/month` : ""}` : "Goal hit. Time to raise it?"}</p>
               <div class="mini-meter"><span>Received in ${mName(cur)}</span><b class="num">${money(recvMonth)}</b><i><em style="width:${pctRecv}%"></em></i></div>`
            : `<button class="btn sm lime" data-action="goal" style="margin-top:14px">${ic("target")} Set a monthly goal</button>`
        }
      </section>

      <section class="chart-card dark rise" style="--i:1">
        <div class="cc-head"><h3>Money in by month</h3>
          <div class="legend"><span><i class="sw got"></i>Received</span><span><i class="sw due"></i>Due</span>${anyLost ? `<span><i class="sw lost"></i>Lost</span>` : ""}</div></div>
        <p class="readout" aria-live="polite"><b>${mName(sel.k)}</b> · <b class="num">${money(sel.got)}</b> received · <span class="num">${money(sel.due)}</span> ${sel.future ? "scheduled" : "due"}${
          sel.lost ? ` · <span class="num lost">${money(sel.lost)}</span> lost` : ""
        }</p>
        <div class="trend">
          <div class="grid-lines"><i style="bottom:100%"><span>${moneyCompact(niceMax)}</span></i><i style="bottom:50%"><span>${moneyCompact(niceMax / 2)}</span></i><i style="bottom:0"><span>£0</span></i></div>
          <div class="cols">${trend
            .map(
              (t, i) => `<button class="col${t.k === sel.k ? " sel" : ""}${t.future ? " future" : ""}" data-trend="${t.k}" style="--i:${i}" aria-label="${mLabel(t.k)}: ${money(t.got)} received, ${money(t.due)} due${t.lost ? `, ${money(t.lost)} lost` : ""}">
                <span class="pair"><i class="b due" style="height:${(t.due / niceMax) * 100}%">${t.lost ? `<em class="lost" style="height:${(t.lost / t.due) * 100}%"></em>` : ""}</i><i class="b got" style="height:${(t.got / niceMax) * 100}%"></i></span>
                <span class="lbl">${mShort(t.k)}</span></button>`
            )
            .join("")}</div>
        </div>
        <button class="linkish" data-action="trend-table">${S.trendTable ? "Hide table" : "Show as a table"}</button>
        ${
          S.trendTable
            ? `<table class="mini-table"><thead><tr><th>Month</th><th class="n">Due</th><th class="n">Received</th>${anyLost ? `<th class="n">Lost</th>` : ""}</tr></thead><tbody>${trend
                .map((t) => `<tr><td>${mLabel(t.k)}</td><td class="n num">${money(t.due)}</td><td class="n num">${money(t.got)}</td>${anyLost ? `<td class="n num">${t.lost ? money(t.lost) : "—"}</td>` : ""}</tr>`)
                .join("")}</tbody></table>`
            : ""
        }
        ${anyLost ? `<p class="cc-note">Lost is what was due but never came because they didn't pay. It stays in Due so you can see what you expected.</p>` : ""}
        ${trend.filter((t) => !t.future).length < 3 ? `<p class="cc-note">Builds up month by month from September 2026.</p>` : ""}
      </section>

      <section class="chart-card rise" style="--i:2">
        <div class="cc-head"><h3>Where it comes from</h3><span class="hint" style="padding:0">${S.mixMode === "plans" ? "per month, current plans" : "money received"}</span></div>
        <div class="seg small full" data-seg="mix">
          <button class="${S.mixMode === "month" ? "on" : ""}" data-mix="month">${mName(cur)}</button>
          <button class="${S.mixMode === "all" ? "on" : ""}" data-mix="all">All time</button>
          <button class="${S.mixMode === "plans" ? "on" : ""}" data-mix="plans">Plans now</button>
        </div>
        ${
          mixTotal
            ? `<div class="mixbar" role="img" aria-label="Income split by package">${["pt", "coaching", "programme"]
                .filter((k) => mix[k] > 0)
                .map((k) => `<i class="seg-${k}" style="flex-grow:${mix[k]}"></i>`)
                .join("")}</div>
               <div class="mix-legend">${["pt", "coaching", "programme"]
                 .map(
                   (k) => `<div class="ml"><i class="sw seg-${k}"></i><span>${KIND[k]}</span><b class="num">${money(mix[k])}${S.mixMode === "plans" ? "/mo" : ""}</b><em class="num">${Math.round((mix[k] / mixTotal) * 100)}%</em></div>`
                 )
                 .join("")}</div>`
            : `<p class="cc-note">${S.mixMode === "plans" ? "No current plans yet." : "Nothing received yet for this view."}</p>`
        }
      </section>

      <section class="chart-card rise" style="--i:3">
        <div class="cc-head"><h3>Clients</h3>${clientGoal ? "" : `<button class="linkish" data-action="goal">Set a client goal</button>`}</div>
        <div class="kpis">
          <div class="kpi"><span>Active</span><b>${count("k-active", active.length, "int")}${clientGoal ? `<small> of ${clientGoal}</small>` : ""}</b>${clientGoal ? `<i class="kbar"><em style="width:${Math.min(100, Math.round((active.length / clientGoal) * 100))}%"></em></i>` : ""}</div>
          <div class="kpi"><span>On a break</span><b>${count("k-break", onBreak.length, "int")}</b></div>
          <div class="kpi"><span>New this month</span><b>${count("k-new", joined.length, "int")}</b></div>
          <div class="kpi"><span>Finished this month</span><b>${count("k-fin", finished.length, "int")}</b></div>
        </div>
        <div class="kpi-lines">
          <p><span>Churn this month</span><b class="num">${churn == null ? "—" : `${churn}%`}</b></p>
          <p><span>Average time with you</span><b class="num">${avgStay < 1 ? "Under a month" : `${avgStay.toFixed(1)} months`}</b></p>
          <p class="cc-note">"New" counts clients marked New. Time with you counts from when tracking began.</p>
        </div>
      </section>

      <section class="chart-card rise" style="--i:4">
        <div class="cc-head"><h3>Growth over time</h3><span class="hint" style="padding:0">end of each month</span></div>
        <div class="gm">${gm
          .slice()
          .reverse()
          .map((g, i, arr) => {
            const prev = arr[i + 1];
            const dI = prev ? g.income - prev.income : null;
            const dC = prev ? g.clients - prev.clients : null;
            const sign = (v, f) => (v > 0 ? `up ${f(v)}` : v < 0 ? `down ${f(-v)}` : "no change");
            return `<div class="gm-row">
              <div class="gm-top"><span class="gm-m">${mLabel(g.k)}${g.now ? " <small>so far</small>" : ""}</span><b class="num">${pounds0(g.income)}<small>/mo</small></b></div>
              <span class="gm-bar"><i style="width:${(g.income / gMax) * 100}%"></i></span>
              <p class="gm-sub">${plural(g.clients, "paying client")}${
                prev ? ` · ${sign(dI, (v) => pounds0(v) + "/mo")} · ${sign(dC, (v) => plural(v, "client"))} on ${mName(prev.k)}` : " · starting point"
              }</p>
            </div>`;
          })
          .join("")}</div>
        <p class="cc-note">${gm.length < 3 ? "Adds a row every month, so the trend shows from about November. " : ""}Income here is what your plans are worth per month, same as the top of this page.</p>
      </section>

      <section class="chart-card rise" style="--i:5">
        <div class="cc-head"><h3>Paying on time</h3>${allHabit.n ? `<span class="hint" style="padding:0">since ${fmtShort(TRACK_START)}</span>` : ""}</div>
        ${
          allHabit.n
            ? `<div class="rate-hero"><b class="num">${Math.round(allHabit.rate * 100)}%</b><span>on time · ${allHabit.onTime} of ${plural(allHabit.n, "payment")}</span></div>
               <div class="kpi-lines">
                 <p><span>Late on average, when late</span><b class="num">${allHabit.lateN ? plural(allHabit.avgLate, "day") : "—"}</b></p>
                 <p><span>Not in yet</span><b class="num">${allHabit.lateNow}</b></p>
                 <p><span>Didn't pay</span><b class="num">${allHabit.missed}</b></p>
                 <p><span>Times you've had to chase</span><b class="num">${allHabit.chases}</b></p>
               </div>
               <div class="habits">${habits
                 .map(
                   ({ c, h }) => `<button class="habit-row" data-open-client="${c.id}"><span class="n">${esc(c.name)}<small>${esc(h.line)}</small></span>${habitTag(h)}</button>`
                 )
                 .join("")}</div>`
            : ""
        }
        <p class="cc-note">${
          allHabit.n ? "Worst first. " : "Nothing's been due long enough to judge yet. "
        }Counts every payment since tracking began. Up to a day late counts as on time. The more months go by, the clearer the pattern.</p>
      </section>

      <section class="chart-card rise" style="--i:6">
        <div class="cc-head"><h3>What you earn per hour</h3></div>
        ${
          rates.length
            ? `<div class="rate-hero"><b>${count("g-rate", overallRate, "rate")}</b><span>/hour across ${plural(rates.length, "client")} with times set</span></div>
               <div class="hbars">${rates
                 .map(
                   (r) => `<button class="hb" data-open-client="${r.c.id}"><span class="hn">${esc(r.c.name)}</span><span class="ht"><i style="width:${(r.rate / rMax) * 100}%"></i></span><b class="num">${pounds0(r.rate)}</b></button>`
                 )
                 .join("")}</div>
               <p class="cc-note">Lowest first. Tap a client to check their plan.</p>`
            : `<p class="cc-note">Add roughly how long each client takes (sessions a week, or hours a month) when you set or fix their plan, and this shows what you really earn per hour.</p>`
        }
      </section>

      <section class="chart-card rise" style="--i:7">
        <div class="cc-head"><h3>Most money in</h3><span class="hint" style="padding:0">since tracking began</span></div>
        ${
          ltv.length
            ? `<div class="ltv">${ltv
                .map(
                  (x, i) => `<button class="ltv-row" data-open-client="${x.c.id}"><span class="rank">${i + 1}</span><span class="n">${esc(x.c.name)}<small>${esc((curPlan(x.c.id) && planName(curPlan(x.c.id))) || CST[statusOf(x.c)])}</small></span><b class="num">${money(x.got)}</b></button>`
                )
                .join("")}</div>`
            : `<p class="cc-note">Fills up as payments come in.</p>`
        }
      </section>`;
  }
  function niceCeil(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function viewMore() {
    const s = S.session;
    const set = S.data.settings || {};
    const theme = pref("theme", "system");
    const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    return `
      <div class="topbar"><button class="back" data-action="close-settings">${ic("left")} Back</button><div class="title">Settings</div><div style="width:70px"></div></div>
      <div class="group-title">Account</div>
      <div class="group rise" style="--i:0">
        <button class="row" data-action="edit-name"><span class="ic">${ic("user")}</span><span class="l">${esc(s.name || "Add your name")}<small>${esc(s.email || "")}</small></span><span class="r">${ic("right")}</span></button>
        <button class="row" data-action="password"><span class="ic">${ic("key")}</span><span class="l">Change password</span><span class="r">${ic("right")}</span></button>
      </div>

      <div class="group-title">Goals &amp; messages</div>
      <div class="group rise" style="--i:1">
        <button class="row" data-action="goal"><span class="ic">${ic("target")}</span><span class="l">Goals<small>${set.goalMonthly ? `${money(set.goalMonthly)} a month` : "No monthly goal yet"}${set.goalClients ? ` · ${set.goalClients} clients` : ""}</small></span><span class="r">${ic("right")}</span></button>
        <button class="row" data-action="template"><span class="ic">${ic("chat")}</span><span class="l">Chase message<small>What gets sent when you chase a late payment</small></span><span class="r">${ic("right")}</span></button>
      </div>

      <div class="group-title">Morning nudge</div>
      <div class="group rise" style="--i:2">
        ${
          !pushSupported
            ? `<div class="row"><span class="ic">${ic("bell")}</span><span class="l">Not available here<small>${isIOS() && !isStandalone() ? "Open TS Pay from your Home Screen to turn this on." : "This browser can't show notifications."}</small></span></div>`
            : `<label class="row"><span class="ic">${ic("bell")}</span><span class="l">Morning nudge<small>A heads-up on days a payment's due, didn't land, or a plan ends. Also puts a count on the app icon.</small></span>
                 <span class="switch"><input type="checkbox" id="nudgeToggle" ${set.nudgeOn && S.pushHere ? "checked" : ""}><i></i></span></label>
               <label class="row"><span class="ic">${ic("clock")}</span><span class="l">Time</span>
                 <select class="pick" id="nudgeHour" style="flex:0 0 auto;width:auto">${[6, 7, 8, 9, 10]
                   .map((h) => `<option value="${h}" ${Number(set.nudgeHour) === h ? "selected" : ""}>${h}:00am</option>`)
                   .join("")}</select></label>
               ${set.nudgeOn && S.pushHere ? `<button class="row" data-action="push-test"><span class="ic">${ic("bell")}</span><span class="l">Send a test now</span><span class="r">${ic("right")}</span></button>` : ""}`
        }
      </div>

      <div class="group-title">Appearance</div>
      <div class="group rise" style="--i:3">
        <div class="row stack"><span class="ic">${ic("moon")}</span><span class="l">Theme<small>System follows your iPhone's light/dark setting</small></span>
          <div class="seg small full" data-seg="theme" style="margin-top:6px">
            ${["system", "light", "dark"].map((t) => `<button class="${theme === t ? "on" : ""}" data-theme-set="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
          </div>
        </div>
      </div>

      <div class="group-title">Face ID</div>
      <div class="group rise" style="--i:4">
        ${
          s.hasPasskey
            ? `<div class="row"><span class="ic">${ic("faceid")}</span><span class="l">Face ID is on<small>Works on any device using your iCloud Keychain</small></span></div>
               <label class="row stack"><span class="ic">${ic("lock")}</span><span class="l">Ask for Face ID<small>Only when you come back to the app, never while you're using it</small></span>
                 <select class="pick" id="lockSel" style="flex:1 1 100%;margin-top:6px">${LOCKS.map(
                   ([v, l]) => `<option value="${v}" ${Number(s.lockMinutes) === v ? "selected" : ""}>${l}</option>`
                 ).join("")}</select></label>
               <button class="row danger" data-action="faceid-remove"><span class="l">Turn off Face ID</span></button>`
            : `<button class="row" data-action="faceid-setup"><span class="ic">${ic("faceid")}</span><span class="l">Set up Face ID<small>${
                S.platformAuth ? "Unlock with a glance, sign back in without typing" : "Not available in this browser"
              }</small></span><span class="r">${ic("right")}</span></button>`
        }
      </div>

      <div class="group-title">Export</div>
      <div class="group rise" style="--i:5">
        <a class="row" href="${API}/export?type=payments"><span class="ic">${ic("download")}</span><span class="l">Payments CSV<small>Every payment, with status and paid date</small></span></a>
        <a class="row" href="${API}/export?type=clients"><span class="ic">${ic("download")}</span><span class="l">Clients CSV</span></a>
        <a class="row" href="${API}/export?type=plans"><span class="ic">${ic("download")}</span><span class="l">Plans CSV<small>Everyone's plan history</small></span></a>
      </div>

      ${
        isStandalone()
          ? ""
          : `<div class="group-title">Make it an app</div>
      <div class="group"><div class="row"><span class="ic">${ic("share")}</span><span class="l">Add to Home Screen<small>In Safari, tap Share, then "Add to Home Screen". It opens full screen like a normal app.</small></span></div></div>`
      }

      <div class="group" style="margin-top:20px">
        <button class="row danger" data-action="signout"><span class="l">Sign out of this device</span><span class="r">${ic("out")}</span></button>
      </div>
      <p class="note" style="justify-content:center">Tracking since 28 September 2026</p>`;
  }

  // ---------- shell + render ----------
  const TABS = [
    ["month", "bars", "Month"],
    ["calendar", "cal", "Calendar"],
    ["add", "plus", ""],
    ["clients", "users", "Clients"],
    ["growth", "trend", "Growth"],
  ];
  function renderShell() {
    root().innerHTML = `<div class="app">
      <div class="ptr" id="ptr"><div class="coin-logo">£</div></div>
      <main class="view" id="view"></main>
      <nav class="tabbar"><div class="tabbar-inner" id="tabs"><span class="tab-ind" id="tabInd"></span>${TABS.map(([k, i, l]) =>
        k === "add"
          ? `<button class="tab add" data-action="add" aria-label="Add"><span>${ic(i)}</span></button>`
          : `<button class="tab" data-tab="${k}">${ic(i)}<span>${l}</span></button>`
      ).join("")}</div></nav>
    </div>`;
  }
  function moveTabIndicator(instant) {
    const t = $(`.tab[data-tab="${S.tab}"]`);
    const ind = $("#tabInd");
    $$(".tab[data-tab]").forEach((x) => x.classList.toggle("on", x === t));
    if (!ind) return;
    if (!t) {
      ind.style.opacity = "0";
      return;
    }
    ind.style.opacity = "1";
    if (instant) ind.style.transition = "none";
    ind.style.width = t.offsetWidth - 8 + "px";
    ind.style.transform = `translateX(${t.offsetLeft + 4}px)`;
    if (instant) {
      void ind.offsetWidth;
      ind.style.transition = "";
    }
  }
  function layoutSegs() {
    $$(".seg[data-seg]").forEach((seg) => {
      const on = $("button.on", seg);
      if (!on) return;
      let th = $(".thumb", seg);
      if (!th) {
        th = document.createElement("span");
        th.className = "thumb";
        seg.prepend(th);
      }
      seg.classList.add("ready");
      const x = on.offsetLeft;
      const w = on.offsetWidth;
      const key = seg.dataset.seg;
      const prev = S.segPos[key];
      if (prev && (prev.x !== x || prev.w !== w) && !reduced) {
        th.style.transition = "none";
        th.style.width = prev.w + "px";
        th.style.transform = `translateX(${prev.x}px)`;
        void th.offsetWidth;
        th.style.transition = "";
      }
      th.style.width = w + "px";
      th.style.transform = `translateX(${x}px)`;
      S.segPos[key] = { x, w };
    });
  }

  // mode: "fade" (tab change), "push"/"pop" (profile / settings), or undefined (data refresh, stay put)
  function render(mode) {
    if (!S.data) return;
    let first = false;
    if (!$("#view")) {
      renderShell();
      first = true;
    }
    const v = $("#view");
    const y = window.scrollY;
    const views = { month: viewMonth, calendar: viewCalendar, clients: viewClients, growth: viewGrowth, more: viewMore };
    v.className = "view";
    v.innerHTML = views[S.tab]();
    if (mode) {
      void v.offsetWidth;
      v.className = `view ${mode} enter`;
    }
    moveTabIndicator(first);
    if (S.tab === "month") {
      renderList();
      const strip = $("#strip");
      const sel = $("#strip .sel");
      if (strip && sel) strip.scrollLeft = sel.offsetLeft - strip.clientWidth / 2 + sel.offsetWidth / 2;
    }
    if (S.tab === "clients" && !S.clientId) renderClientList();
    layoutSegs();
    const prevRecv = S.counts.recv ?? 0;
    requestAnimationFrame(() => {
      $$(".progress .fill").forEach((f) => (f.style.width = f.dataset.pct + "%"));
      const rt = $("#recvTile");
      if (rt && Number($("[data-count=recv]", rt)?.dataset.val) > prevRecv) rt.classList.add("shine");
      runCounts();
    });
    S.calAnim = "";
    S.heroAnim = "";
    if (!mode) window.scrollTo(0, y);
  }
  const rerender = () => {
    render();
    refreshNeeds();
  };

  // ---------- sheets: payments ----------
  function clientOptions(sel) {
    const cs = S.data.clients;
    const act = cs.filter((c) => statusOf(c) !== "finished");
    const rest = cs.filter((c) => statusOf(c) === "finished");
    const o = (c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? "selected" : ""}>${esc(c.name)}</option>`;
    return `<option value="" ${sel ? "" : "selected"} disabled>Choose a client</option>${act.map(o).join("")}${
      rest.length ? `<optgroup label="Finished">${rest.map(o).join("")}</optgroup>` : ""
    }`;
  }
  function paymentDefaults(c) {
    const p = c ? curPlan(c.id) || plansOf(c.id).filter((x) => x.kind !== "break").pop() : null;
    return {
      package: p && p.kind !== "break" ? p.kind : "coaching",
      programme_weeks: p?.programme_weeks || null,
      amount_pence: p && p.kind !== "break" && p.price_pence ? (p.billing === "split" ? Math.round(p.price_pence / p.instalments) : p.price_pence) : null,
      method: p?.method || "manual",
    };
  }

  function paymentSheet(p, preset = {}) {
    if (!S.data.clients.length) {
      toast("Add a client first.");
      return clientSheet(null);
    }
    const isEdit = !!p;
    const today = londonToday();
    let f;
    if (isEdit) f = { ...p };
    else {
      const c = preset.client_id ? client(preset.client_id) : null;
      f = { client_id: c?.id || "", ...paymentDefaults(c), due_date: preset.due_date || today, paid_date: null, notes: "" };
    }
    const plan = isEdit && p.plan_id ? planOf(p.plan_id) : null;
    const st = isEdit ? stOf(p) : null;
    const html = `
      <form class="form" id="payForm" novalidate>
        ${
          plan
            ? `<div class="from-plan">${ic("repeat")}<span>From ${esc(firstName(cname(p)))}'s plan: <b>${esc(planName(plan))} · ${esc(planPrice(plan))}</b><br><small>Changes here only affect this one payment.</small></span></div>`
            : !isEdit
            ? `<p class="hint">For a one-off or extra. Regular payments come from the client's plan automatically.</p>`
            : ""
        }
        <div class="field"><label for="p-client">Client</label><select id="p-client" ${plan ? "disabled" : ""}>${clientOptions(f.client_id)}</select></div>
        <div class="field"><span class="lab">Package</span>${opts("package", PKG, f.package)}</div>
        <div class="field" id="p-weeks-f" ${f.package === "programme" ? "" : "hidden"}><span class="lab">Programme length</span>${opts("weeks", WEEK_OPTS, f.programme_weeks)}</div>
        <div class="two">
          <div class="field"><label for="p-amt">Amount</label><div class="money"><span>£</span><input id="p-amt" inputmode="decimal" autocomplete="off" value="${moneyInput(f.amount_pence)}" placeholder="0"></div></div>
          <div class="field"><label for="p-due">Due date</label><input id="p-due" type="date" value="${f.due_date}"></div>
        </div>
        <div class="field"><span class="lab">Payment method</span>${opts("method", METH, f.method)}</div>
        ${
          isEdit && st === "missed"
            ? `<div class="status-card missed"><div class="l"><b>Didn't pay</b><small>${esc(missedLine(p))}</small></div><span class="paydone lost" aria-hidden="true">${ic("x")}</span></div>
               <button type="button" class="btn lime" data-paid-after="${p.id}">${ic("check")} They've paid after all</button>
               <button type="button" class="linkish center" data-unmiss="${p.id}">Undo: they didn't miss it</button>`
            : isEdit
            ? `<div class="status-card ${st}"><div class="l"><b>${STL[st]}</b><small>${
                st === "paid" ? `Received ${fmtLong(p.paid_date)}` : st === "overdue" ? `${plural(daysBetween(p.due_date, today), "day")} past due` : `Due ${fmtLong(p.due_date)}`
              }${p.chase_count && !p.paid_date ? ` · chased ${p.chase_count}× (last ${ago(p.chased_at)})` : ""}</small></div><label class="switch"><input type="checkbox" id="p-paid" ${p.paid_date ? "checked" : ""} aria-label="Paid"><i></i></label></div>
               <div class="field" id="p-paid-f" ${p.paid_date ? "" : "hidden"}><label for="p-paiddate">Date received</label><input id="p-paiddate" type="date" value="${p.paid_date || today}"></div>
               ${
                 !p.paid_date
                   ? p.due_date <= today
                     ? `<div class="btn-row"><button type="button" class="btn ghost" data-chase="${p.id}">${ic("chat")} Chase</button><button type="button" class="btn ghost stop" data-missed="${p.id}">${ic("x")} Didn't pay</button></div>`
                     : `<button type="button" class="btn ghost" data-chase="${p.id}">${ic("chat")} Chase this payment</button>`
                   : ""
               }`
            : ""
        }
        <div class="field"><label for="p-notes">Notes <span>optional</span></label><textarea id="p-notes" rows="2">${esc(f.notes)}</textarea></div>
        <div class="form-err" id="p-err"></div>
        <button class="btn lime" type="submit">${isEdit ? "Save changes" : "Add payment"}</button>
        ${isEdit ? `<button class="btn danger" type="button" id="p-del">Delete this payment</button>` : ""}
        ${plan ? `<button class="linkish center" type="button" data-open-client="${p.client_id}" data-close-sheet>View ${esc(firstName(cname(p)))}'s plans</button>` : ""}
      </form>`;
    openSheet(isEdit ? `${cname(p)} · ${money(p.amount_pence)}` : "Add payment", html, (sh) => {
      const weeksF = $("#p-weeks-f", sh);
      $('[data-name="package"]', sh).addEventListener("change", (e) => {
        weeksF.hidden = e.currentTarget.dataset.value !== "programme";
      });
      if (!isEdit) {
        $("#p-client", sh).addEventListener("change", (e) => {
          const d = paymentDefaults(client(Number(e.target.value)));
          const set = (name, v) => {
            const g = $(`[data-name="${name}"]`, sh);
            g.dataset.value = v ?? "";
            $$(".opt", g).forEach((b) => b.classList.toggle("on", b.dataset.val === String(v)));
          };
          set("package", d.package);
          set("weeks", d.programme_weeks);
          set("method", d.method);
          weeksF.hidden = d.package !== "programme";
          $("#p-amt", sh).value = moneyInput(d.amount_pence);
        });
      } else {
        const paid = $("#p-paid", sh);
        if (paid) paid.addEventListener("change", () => ($("#p-paid-f", sh).hidden = !paid.checked));
        $("#p-del", sh).onclick = async () => {
          const msg = isLost(p)
            ? `Delete the record of the ${money(p.amount_pence)} ${cname(p)} didn't pay? It stops counting as lost; their plan stays as it is. This can't be undone.`
            : `Delete this ${money(p.amount_pence)} payment from ${cname(p)}? This can't be undone.`;
          if (!confirm(msg)) return;
          try {
            const r = await api(`/payments/${p.id}`, { method: "DELETE" });
            setData(r.data);
            closeSheet();
            rerender();
            toast("Payment deleted");
          } catch (e) {
            fail(e);
          }
        };
      }
      $("#payForm", sh).onsubmit = async (e) => {
        e.preventDefault();
        const err = $("#p-err", sh);
        err.textContent = "";
        const body = {
          client_id: Number($("#p-client", sh).value),
          package: val(sh, "package"),
          programme_weeks: val(sh, "weeks") ? Number(val(sh, "weeks")) : null,
          amount_pence: parseMoney($("#p-amt", sh).value),
          due_date: $("#p-due", sh).value,
          method: val(sh, "method"),
          notes: $("#p-notes", sh).value,
        };
        if (!body.client_id) return (err.textContent = "Choose a client.");
        if (body.amount_pence == null) return (err.textContent = "Enter the amount in pounds, e.g. 160 or 42.50.");
        if (!body.due_date) return (err.textContent = "Pick a due date.");
        const paidSw = $("#p-paid", sh);
        if (isEdit) body.paid_date = paidSw && paidSw.checked ? $("#p-paiddate", sh).value || today : null;
        const btn = $("button[type=submit]", sh);
        btn.disabled = true;
        try {
          const r = isEdit ? await api(`/payments/${p.id}`, { method: "PUT", body }) : await api("/payments", { method: "POST", body });
          setData(r.data);
          closeSheet();
          rerender();
          haptic();
          toast(isEdit ? "Saved" : "Payment added");
        } catch (e2) {
          btn.disabled = false;
          if (!e2.silent) err.textContent = e2.message;
        }
      };
    });
  }

  async function quickPay(id) {
    const p = S.data.payments.find((x) => x.id === id);
    if (!p || !isOpen(p)) return;
    try {
      const r = await api(`/payments/${id}/paid`, { method: "POST", body: { paid_date: londonToday() } });
      setData(r.data);
      rerender();
      $$(`.swipe[data-pid="${id}"] .prow`).forEach((row) => row.classList.add("just-paid"));
      toast(`${cname(p)} · ${money(p.amount_pence)} paid today`, [
        { label: "Change date", fn: () => paidDateSheet(id) },
        {
          label: "Undo",
          fn: async () => {
            try {
              const r2 = await api(`/payments/${id}/paid`, { method: "POST", body: { paid_date: null } });
              setData(r2.data);
              rerender();
            } catch (e) {
              fail(e);
            }
          },
        },
      ]);
    } catch (e) {
      fail(e);
      rerender();
    }
  }

  function paidDateSheet(id) {
    const p = S.data.payments.find((x) => x.id === id);
    if (!p) return;
    openSheet(
      "When did it land?",
      `<form class="form" id="pdForm">
        <p class="hint">${esc(cname(p))} · ${money(p.amount_pence)} · due ${fmtShort(p.due_date)}</p>
        <div class="field"><label for="pd">Date received</label><input id="pd" type="date" value="${p.paid_date || londonToday()}"></div>
        <button class="btn lime" type="submit">Save</button>
      </form>`,
      (sh) => {
        $("#pdForm", sh).onsubmit = async (e) => {
          e.preventDefault();
          try {
            const r = await api(`/payments/${id}/paid`, { method: "POST", body: { paid_date: $("#pd", sh).value || londonToday() } });
            setData(r.data);
            closeSheet();
            rerender();
            toast("Paid date updated");
          } catch (e2) {
            fail(e2);
          }
        };
      }
    );
  }

  // ---------- didn't pay ----------
  // Clients pay up front, so a payment that doesn't come means their service stops and that money is lost,
  // not owed. The server does the stop; this works out the same thing first, so the sheet can say what happens.
  function missedPreview(p) {
    const plans = plansOf(p.client_id);
    const own = p.plan_id ? planOf(p.plan_id) : null;
    const cover = own || planOn(p.client_id, p.due_date);
    const before = addDays(p.due_date, -1);
    const end = cover && cover.kind !== "break" && cover.start_date > before ? cover.start_date : before;
    const reach = plans.filter((x) => !x.end_date || x.end_date > end);
    const ending = reach.filter((x) => x.start_date <= end);
    const later = reach.filter((x) => x.start_date > end);
    const off = S.data.payments
      .filter((x) => x.id !== p.id && x.auto && isOpen(x) && ((ending.some((e) => e.id === x.plan_id) && x.due_date > end) || later.some((g) => g.id === x.plan_id)))
      .sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
    return { end, from: addDays(end, 1), running: reach.some((x) => x.kind !== "break"), laterPlans: later.filter((x) => x.kind !== "break"), off };
  }
  function missedLine(p) {
    const what =
      p.stop_mode === "pause" ? `service stopped from ${fmtShort(p.stop_from)}` : p.stop_mode === "finish" ? `finished, service stopped from ${fmtShort(p.stop_from)}` : p.stop_mode === "skip" ? "their plan carried on" : "";
    return `Due ${fmtShort(p.due_date)} · lost, not owed${what ? " · " + what : ""}`;
  }
  function missedSheet(p, back) {
    if (!p || !isOpen(p)) return;
    const c = client(p.client_id);
    const first = firstName(c?.name) || "them";
    const today = londonToday();
    const pv = missedPreview(p);
    const late = daysBetween(p.due_date, today);
    let next = "pause";
    const html = `
      <form class="form" id="msForm" novalidate>
        <div class="ms-top"><span class="av">${esc(initials(c?.name))}</span><span class="n"><b>${esc(c?.name || "")}</b><small>${money(p.amount_pence)} · due ${fmtShort(p.due_date)}${late > 0 ? ` · ${plural(late, "day")} late` : " · today"}</small></span></div>
        <p class="hint">It goes down as money lost, not owed: off the overdue list, never chased, and shown against what you expected for ${mName(mKey(p.due_date))}.</p>
        <div class="field"><span class="lab">What happens to ${esc(first)} now?</span>${opts("next", { pause: "Stop service", skip: "Skip this one", finish: "Finished" }, next)}</div>
        <div class="summary" id="msSum"></div>
        <div class="form-err" id="ms-err"></div>
        <button class="btn lime" type="submit">Mark as didn't pay</button>
      </form>`;
    const offLine = (ps) =>
      ps.length ? `<li class="minus">Comes off what's expected: ${ps.slice(0, 3).map((x) => `${fmtDay(x.due_date)} ${money(x.amount_pence)}`).join(", ")}${ps.length > 3 ? "…" : ""}.</li>` : "";
    const laterLine = pv.laterPlans.length ? `<li class="minus">Their ${esc(pv.laterPlans.map((x) => planName(x).toLowerCase()).join(" and "))} from ${fmtShort(pv.laterPlans[0].start_date)} is taken off too.</li>` : "";
    const summary = (sh) => {
      const lines = [];
      if (next === "pause") {
        if (pv.running) {
          lines.push(`<li>Service stops from ${fmtShort(pv.from)}. They go on a break until you start them again.</li>`);
          lines.push(offLine(pv.off), laterLine);
        } else lines.push(`<li>They're already on a break, so nothing else changes.</li>`);
      } else if (next === "finish") {
        lines.push(`<li>Marked as finished. Last day ${fmtShort(pv.end)}.</li>`, offLine(pv.off), laterLine);
      } else {
        const nx = clientPayments(p.client_id).filter((x) => x.id !== p.id && isOpen(x) && x.due_date > p.due_date).sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
        lines.push(`<li>Their plan carries on as normal.${nx ? ` Next payment ${fmtShort(nx.due_date)} · ${money(nx.amount_pence)} stays on the books.` : ""}</li>`);
      }
      lines.push(`<li class="keep">If they pay after all, one tap puts it all back.</li>`);
      $("#msSum", sh).innerHTML = `<h4>What happens</h4><ul>${lines.join("")}</ul>`;
    };
    openSheet("Didn't pay", html, (sh) => {
      summary(sh);
      $('[data-name="next"]', sh).addEventListener("change", (e) => {
        next = e.currentTarget.dataset.value;
        summary(sh);
      });
      $("#msForm", sh).onsubmit = async (e) => {
        e.preventDefault();
        const btn = $("button[type=submit]", sh);
        btn.disabled = true;
        try {
          const r = await api(`/payments/${p.id}/missed`, { method: "POST", body: { next } });
          setData(r.data);
          closeSheet();
          haptic();
          rerender();
          const tail = next === "pause" && pv.running ? ", service stopped" : next === "finish" ? ", marked as finished" : "";
          toast(`${first} · ${money(p.amount_pence)} down as lost${tail}`, [{ label: "Undo", fn: () => unmissPayment(p.id, false) }]);
          if (back) setTimeout(back, 420);
        } catch (e2) {
          btn.disabled = false;
          if (!e2.silent) $("#ms-err", sh).textContent = e2.message;
        }
      };
    });
  }
  async function unmissPayment(id, ask = true) {
    const p = S.data.payments.find((x) => x.id === id);
    if (!p || !isLost(p)) return;
    const who = firstName(cname(p));
    const stopped = p.stop_mode === "pause" || p.stop_mode === "finish";
    if (ask) {
      const msg = !stopped
        ? `Put ${who}'s ${money(p.amount_pence)} back as not paid?`
        : p.can_restart
        ? `Put ${who}'s ${money(p.amount_pence)} back as not paid, and their plan back as it was?`
        : `Put ${who}'s ${money(p.amount_pence)} back as not paid? Their plans have changed since, so they stay as they are.`;
      if (!confirm(msg)) return;
    }
    try {
      const r = await api(`/payments/${id}/missed`, { method: "POST", body: { undo: true } });
      setData(r.data);
      if (ask && sheet) closeSheet(); // from the payment's own sheet; from the toast, whatever's open just refreshes
      rerender();
      toast(r.restored ? `Undone. ${who}'s plan is back as it was` : "Undone. It's back to not paid");
    } catch (e) {
      fail(e);
    }
  }
  function paidAfterSheet(id) {
    const p = S.data.payments.find((x) => x.id === id);
    if (!p || !isLost(p)) return;
    const who = firstName(cname(p));
    const sp = planOf((p.stop_plans || [])[0]);
    const stopped = p.stop_mode === "pause" || p.stop_mode === "finish";
    openSheet(
      "They've paid",
      `<form class="form" id="paForm" novalidate>
        <p class="hint">${esc(cname(p))} · ${money(p.amount_pence)} · due ${fmtShort(p.due_date)}</p>
        <div class="field"><label for="pa-date">Date received</label><input id="pa-date" type="date" value="${londonToday()}"></div>
        ${
          stopped && p.can_restart
            ? `<label class="switch-row"><span class="l">Restart ${esc(who)}'s plan<small>${
                sp ? `Back on ${esc(planName(sp).toLowerCase())} · ${esc(planPrice(sp))}` : "Back as it was"
              }, with the payments that came off put back</small></span><span class="switch"><input type="checkbox" id="pa-restart" checked><i></i></span></label>`
            : stopped
            ? `<p class="hint">Their plans have changed since, so they stay as they are. Use Change plan if they need restarting.</p>`
            : ""
        }
        <div class="form-err" id="pa-err"></div>
        <button class="btn lime" type="submit">${ic("check")} Mark as paid</button>
      </form>`,
      (sh) => {
        $("#paForm", sh).onsubmit = async (e) => {
          e.preventDefault();
          const btn = $("button[type=submit]", sh);
          btn.disabled = true;
          const restart = !!$("#pa-restart", sh)?.checked;
          try {
            const r = await api(`/payments/${p.id}/paid`, { method: "POST", body: { paid_date: $("#pa-date", sh).value || londonToday(), restart } });
            const rect = btn.getBoundingClientRect();
            burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
            setData(r.data);
            closeSheet();
            haptic();
            rerender();
            toast(`${who} · ${money(p.amount_pence)} paid${r.restored ? ". Plan's back on" : ""}`);
          } catch (e2) {
            btn.disabled = false;
            if (!e2.silent) $("#pa-err", sh).textContent = e2.message;
          }
        };
      }
    );
  }

  // ---------- chasing ----------
  function waNumber(phone) {
    let d = String(phone).replace(/[^\d+]/g, "");
    if (d.startsWith("+")) d = d.slice(1);
    else if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith("0")) d = "44" + d.slice(1);
    return d.replace(/\D/g, "");
  }
  function chaseMessage(p) {
    const c = client(p.client_id);
    const tpl = S.data.settings?.chaseTemplate || "";
    const plan = p.plan_id ? planOf(p.plan_id) : null;
    const pkg = (plan ? planName(plan) : pkgText(p.package, p.programme_weeks)).toLowerCase().replace(/^pt only$/, "PT");
    const vals = {
      first: firstName(c?.name) || "there",
      name: c?.name || "",
      amount: money(p.amount_pence),
      date: fmtShort(p.due_date),
      package: pkg,
      me: S.session?.name || "",
    };
    return tpl.replace(/\{(first|name|amount|date|package|me)\}/g, (_, k) => vals[k]);
  }
  function logChase(id) {
    fetch(`${API}/payments/${id}/chase`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", keepalive: true, credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        const p = S.data.payments.find((x) => x.id === id);
        if (p && j.ok) {
          p.chase_count = j.chase_count;
          p.chased_at = j.chased_at;
          const card = $(`.chase-card[data-cid="${id}"] .cc-chased`);
          if (card) card.textContent = `Chased ${j.chase_count > 1 ? j.chase_count + "× · " : ""}${ago(j.chased_at)}`;
          if (!sheet) rerender();
        }
      })
      .catch(() => {});
  }
  function chaseSheet(list) {
    const today = londonToday();
    const ps = (list || S.data.payments.filter((p) => isOpen(p) && p.due_date < today)).filter(isOpen).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
    if (!ps.length) return toast("Nothing overdue to chase.");
    const canShare = !!navigator.share;
    const html = `
      <p class="hint">${list && list.length === 1 ? "" : `${plural(ps.length, "payment")} · ${money(sum(ps))} overdue. `}Tap how you want to send it. Your message opens ready to go, you just hit send.</p>
      <div class="chase-list">${ps
        .map((p) => {
          const c = client(p.client_id);
          const phone = (c?.phone || "").trim();
          const msg = chaseMessage(p);
          const late = daysBetween(p.due_date, today);
          return `<div class="chase-card" data-cid="${p.id}">
            <div class="cc-top"><span class="av">${esc(initials(c?.name))}</span>
              <span class="cc-n"><b>${esc(c?.name || "")}</b><small>${money(p.amount_pence)} · due ${fmtShort(p.due_date)}${late > 0 ? ` · ${late}d late` : ""}</small></span>
              <button class="paybtn sm" data-pay="${p.id}" aria-label="Mark paid">${ic("check")}</button></div>
            <p class="cc-msg">${esc(msg)}</p>
            <div class="cc-foot"><p class="cc-chased">${p.chase_count ? `Chased ${p.chase_count > 1 ? p.chase_count + "× · " : ""}${ago(p.chased_at)}` : "Not chased yet"}</p>${
              p.due_date <= today ? `<button class="chip stop" data-missed="${p.id}">${ic("x")} Didn't pay</button>` : ""
            }</div>
            <div class="cc-acts">
              ${
                phone
                  ? `<a class="btn sm lime" data-log-chase="${p.id}" href="https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${ic("chat")} WhatsApp</a>
                     <a class="btn sm ghost" data-log-chase="${p.id}" href="sms:${phone.replace(/[^\d+]/g, "")}${isIOS() ? "&" : "?"}body=${encodeURIComponent(msg)}">${ic("phone")} Text</a>`
                  : `<button class="btn sm ghost" data-action="edit-client" data-client="${c?.id}">${ic("plus")} Add their number</button>`
              }
              ${canShare ? `<button class="btn sm ghost" data-share-chase="${p.id}" aria-label="Share message">${ic("share")}</button>` : `<button class="btn sm ghost" data-copy-chase="${p.id}" aria-label="Copy message">${ic("copy")}</button>`}
            </div>
          </div>`;
        })
        .join("")}</div>
      <button class="linkish center" data-action="template">Edit the message</button>`;
    openSheet(list && list.length === 1 ? "Chase payment" : "Chase list", html, (sh) => {
      sh.dataset.kind = list ? "chase-some" : "chase";
      sh.addEventListener("click", async (e) => {
        const a = e.target.closest("[data-log-chase]");
        if (a) {
          haptic();
          logChase(Number(a.dataset.logChase));
          return; // let the link open WhatsApp / Messages
        }
        const s = e.target.closest("[data-share-chase]");
        if (s) {
          const p = S.data.payments.find((x) => x.id === Number(s.dataset.shareChase));
          try {
            await navigator.share({ text: chaseMessage(p) });
            logChase(p.id);
          } catch {}
          return;
        }
        const cp = e.target.closest("[data-copy-chase]");
        if (cp) {
          const p = S.data.payments.find((x) => x.id === Number(cp.dataset.copyChase));
          try {
            await navigator.clipboard.writeText(chaseMessage(p));
            toast("Message copied");
            logChase(p.id);
          } catch {
            toast("Couldn't copy on this device");
          }
        }
      });
    });
  }

  function templateSheet() {
    const set = S.data.settings || {};
    const sample = S.data.payments.find(isOpen) || { client_id: S.data.clients[0]?.id, amount_pence: 16000, due_date: londonToday(), package: "coaching" };
    openSheet(
      "Chase message",
      `<form class="form" id="tplForm">
        <div class="field"><label for="tpl">Message</label><textarea id="tpl" rows="6">${esc(set.chaseTemplate || "")}</textarea></div>
        <p class="hint">These fill in automatically: <code>{first}</code> first name · <code>{amount}</code> · <code>{date}</code> due date · <code>{package}</code> · <code>{me}</code> your name</p>
        <div class="subcard"><h4>Preview</h4><p class="cc-msg" id="tplPrev"></p></div>
        <div class="form-err" id="tpl-err"></div>
        <button class="btn lime" type="submit">Save message</button>
      </form>`,
      (sh) => {
        const upd = () => {
          const saved = S.data.settings.chaseTemplate;
          S.data.settings.chaseTemplate = $("#tpl", sh).value;
          $("#tplPrev", sh).textContent = sample.client_id ? chaseMessage(sample) : $("#tpl", sh).value;
          S.data.settings.chaseTemplate = saved;
        };
        $("#tpl", sh).addEventListener("input", upd);
        upd();
        $("#tplForm", sh).onsubmit = async (e) => {
          e.preventDefault();
          try {
            const r = await api("/settings", { method: "POST", body: { chaseTemplate: $("#tpl", sh).value } });
            S.data.settings = r.settings;
            closeSheet();
            rerender();
            toast("Message saved");
          } catch (e2) {
            if (!e2.silent) $("#tpl-err", sh).textContent = e2.message;
          }
        };
      }
    );
  }

  function goalSheet() {
    const set = S.data.settings || {};
    openSheet(
      "Goals",
      `<form class="form" id="goalForm">
        <div class="field"><label for="g1">Monthly income goal</label><div class="money"><span>£</span><input id="g1" inputmode="decimal" value="${moneyInput(set.goalMonthly || "")}" placeholder="e.g. 3000"></div></div>
        <div class="field"><label for="g2">Client goal <span>active clients</span></label><input id="g2" inputmode="numeric" value="${set.goalClients || ""}" placeholder="e.g. 15"></div>
        <p class="hint">Leave either blank to hide it.</p>
        <div class="form-err" id="g-err"></div>
        <button class="btn lime" type="submit">Save goals</button>
      </form>`,
      (sh) => {
        $("#goalForm", sh).onsubmit = async (e) => {
          e.preventDefault();
          const g1 = $("#g1", sh).value.trim();
          const g2 = $("#g2", sh).value.trim();
          const goalMonthly = g1 ? parseMoney(g1) : 0;
          const goalClients = g2 ? Number(g2) : 0;
          if (goalMonthly == null) return ($("#g-err", sh).textContent = "Enter the goal in pounds, e.g. 3000.");
          if (!Number.isInteger(goalClients) || goalClients < 0) return ($("#g-err", sh).textContent = "Enter a whole number of clients.");
          try {
            const r = await api("/settings", { method: "POST", body: { goalMonthly, goalClients } });
            S.data.settings = r.settings;
            closeSheet();
            rerender();
            haptic();
            toast("Goals saved");
          } catch (e2) {
            if (!e2.silent) $("#g-err", sh).textContent = e2.message;
          }
        };
      }
    );
  }

  // ---------- plan form (shared by add client, change plan, fix plan) ----------
  // F holds the form's values; the form re-draws itself when "what" or "how they pay" changes.
  function planDefaults(c, kind, start) {
    const prevSame = c ? plansOf(c.id).filter((p) => p.kind === kind).pop() : null;
    const base = prevSame || (c ? plansOf(c.id).filter((p) => p.kind !== "break").pop() : null);
    const billing = prevSame ? prevSame.billing : kind === "programme" ? "upfront" : "monthly";
    const day = base?.day_of_month || null;
    const first = billing === "monthly" && day ? nextOnDay(day, start) : start;
    return {
      kind,
      billing,
      price: prevSame ? moneyInput(prevSame.price_pence) : kind === base?.kind ? moneyInput(base?.price_pence) : "",
      weeks: prevSame?.programme_weeks || (kind === "programme" ? 12 : null),
      instalments: prevSame?.instalments || 3,
      method: base?.method || "manual",
      start_date: start,
      first_due: first,
      end_date: "",
      until: false,
      sessions: prevSame?.sessions_per_week || "",
      minutes: prevSame?.session_minutes || 60,
      hours: prevSame && !prevSame.sessions_per_week ? prevSame.hours_per_month || "" : "",
    };
  }
  function planFormHTML(F, mode) {
    // mode: "add" (new client), "change" (switch from a date), "edit" (fix in place)
    if (F.kind === "break") {
      return `
        <div class="two">
          <div class="field"><label for="f-start">Break starts</label><input id="f-start" type="date" data-f="start_date" value="${F.start_date}"></div>
          <div class="field"><label for="f-end">Back on</label><input id="f-end" type="date" data-f="end_back" value="${F.end_date ? addDays(F.end_date, 1) : ""}" ${F.until ? "" : "disabled"}></div>
        </div>
        <label class="switch-row"><span class="l">They know when they're back<small>${F.until ? "Pick the date they're back" : "Leave off if it's open-ended"}</small></span><span class="switch"><input type="checkbox" data-f="until" ${F.until ? "checked" : ""}><i></i></span></label>`;
    }
    const b = F.billing;
    const priceLabel = b === "monthly" ? "Price per month" : b === "none" ? "Usual price per payment" : "Total price";
    const firstLabel = b === "monthly" ? (mode === "add" ? "Next payment" : "First payment") : b === "upfront" ? "Payment due" : "First payment";
    const showStart = mode !== "add" || F.kind === "programme";
    const endAuto = F.kind === "programme" && F.weeks && b !== "monthly" && F.start_date;
    const hoursBlock =
      F.kind === "pt"
        ? `<div class="two"><div class="field"><span class="lab">Sessions a week</span>
             <div class="stepper" data-step="sessions"><button type="button" data-step-by="-0.5">${ic("minus")}</button><b>${F.sessions || 0}</b><button type="button" data-step-by="0.5">${ic("plus")}</button></div></div>
             <div class="field"><label for="f-min">Session length</label><select id="f-min" data-f="minutes">${[30, 45, 60, 75, 90]
               .map((m) => `<option value="${m}" ${Number(F.minutes) === m ? "selected" : ""}>${m} min</option>`)
               .join("")}</select></div></div>
           <p class="hint" id="f-hours-calc">${F.sessions ? `≈ ${Math.round(((F.sessions * F.minutes * 52) / 12 / 60) * 10) / 10} hours a month` : "Used for your £/hour. Optional."}</p>`
        : `<div class="field"><label for="f-hours">Hours a month <span>check-ins, programming, messages</span></label><input id="f-hours" inputmode="decimal" data-f="hours" value="${esc(F.hours)}" placeholder="e.g. 4"></div>`;
    return `
      <div class="field"><span class="lab">How they pay</span>${
        mode === "edit" ? `<p class="static">${BILL[b]}${b === "split" ? ` · ${F.instalments} payments` : ""}<small>To change how they pay, use Change plan.</small></p>` : opts("billing", BILL, b)
      }</div>
      ${F.kind === "programme" ? `<div class="field"><span class="lab">Programme length${b === "monthly" ? " <span>optional</span>" : ""}</span>${opts("weeks", WEEK_OPTS, F.weeks)}</div>` : ""}
      <div class="${b === "split" && mode !== "edit" ? "two" : ""}">
        <div class="field"><label for="f-price">${priceLabel}${b === "none" ? " <span>optional</span>" : ""}</label><div class="money"><span>£</span><input id="f-price" inputmode="decimal" data-f="price" value="${esc(F.price)}" placeholder="0"></div></div>
        ${b === "split" && mode !== "edit" ? `<div class="field"><span class="lab">Payments</span>${opts("instalments", { 2: "2", 3: "3", 4: "4", 6: "6" }, F.instalments)}</div>` : ""}
      </div>
      ${
        b === "split" && parseMoney(F.price) && F.instalments
          ? `<p class="hint">${F.instalments} payments of about ${money(Math.round(parseMoney(F.price) / F.instalments))}, a month apart</p>`
          : ""
      }
      <div class="${showStart && b !== "none" ? "two" : ""}">
        ${showStart ? `<div class="field"><label for="f-start">${mode === "change" ? "Switches on" : "Starts"}</label><input id="f-start" type="date" data-f="start_date" value="${F.start_date}"></div>` : ""}
        ${b !== "none" ? `<div class="field"><label for="f-first">${firstLabel}</label><input id="f-first" type="date" data-f="first_due" value="${F.first_due || ""}"></div>` : ""}
      </div>
      ${b === "monthly" && F.first_due ? `<p class="hint">Then on the ${ordinal(Number(mode === "edit" && F.day ? F.day : F.first_due.slice(8, 10)))} of each month${mode === "edit" ? "" : " until you change it"}.</p>` : ""}
      ${mode === "edit" && b === "monthly" ? `<div class="field"><label for="f-day">Payment day</label><select id="f-day" data-f="day">${Array.from({ length: 31 }, (_, i) => i + 1)
        .map((d) => `<option value="${d}" ${Number(F.day) === d ? "selected" : ""}>${ordinal(d)} of the month</option>`)
        .join("")}</select></div>` : ""}
      ${endAuto ? `<p class="hint">${F.weeks} weeks · ends ${fmtShort(addDays(F.start_date, F.weeks * 7 - 1))}</p>` : ""}
      ${mode === "edit" && !endAuto ? `<div class="field"><label for="f-endd">Ends <span>optional</span></label><input id="f-endd" type="date" data-f="end_date" value="${F.end_date || ""}"></div>` : ""}
      <div class="field"><span class="lab">Payment method</span>${opts("method", METH, F.method)}</div>
      <details class="time-box" ${F.timeOpen || F.sessions || F.hours ? "open" : ""}><summary>${ic("clock")} Your time <span>for £/hour · optional</span></summary>${hoursBlock}</details>`;
  }
  function bindPlanForm(sh, F, box, mode, onChange) {
    const redraw = () => {
      box.innerHTML = planFormHTML(F, mode);
      onChange && onChange();
    };
    box.addEventListener("input", (e) => {
      const k = e.target.dataset.f;
      if (!k) return;
      if (k === "until") return;
      if (k === "end_back") F.end_date = e.target.value ? addDays(e.target.value, -1) : "";
      else F[k] = e.target.value;
      if (k === "start_date" && mode !== "edit" && F.billing !== "monthly") F.first_due = F.start_date;
      if (k === "start_date" && mode !== "edit" && F.billing === "monthly") {
        const d = Number((F.first_due || F.start_date).slice(8, 10));
        F.first_due = nextOnDay(d, F.start_date);
        const fd = $("#f-first", box);
        if (fd) fd.value = F.first_due;
      }
      onChange && onChange();
    });
    box.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.f === "until") {
        F.until = t.checked;
        if (!F.until) F.end_date = "";
        return redraw();
      }
      if (t.dataset.f === "minutes") {
        F.minutes = Number(t.value);
        return redraw();
      }
      if (t.dataset.f && ["first_due", "start_date", "day"].includes(t.dataset.f)) return redraw();
      const g = t.closest?.(".opts") || (t.classList?.contains("opts") ? t : null);
      if (g) {
        const name = g.dataset.name;
        const v = g.dataset.value;
        if (name === "billing") {
          F.billing = v;
          if (v !== "monthly" && !F.first_due) F.first_due = F.start_date;
        } else if (name === "weeks") F.weeks = Number(v);
        else if (name === "instalments") F.instalments = Number(v);
        else if (name === "method") F.method = v;
        return redraw();
      }
    });
    box.addEventListener("click", (e) => {
      const sum = e.target.closest("summary");
      if (sum) F.timeOpen = !sum.parentElement.open;
      const b = e.target.closest("[data-step-by]");
      if (!b) return;
      F.sessions = Math.max(0, Math.min(14, (Number(F.sessions) || 0) + Number(b.dataset.stepBy)));
      redraw();
    });
    redraw();
  }
  // options change fires on the .opts element itself
  function planPayload(F, mode) {
    if (F.kind === "break") return { kind: "break", start_date: F.start_date, end_date: F.until && F.end_date ? F.end_date : null };
    const price = F.billing === "none" && !String(F.price).trim() ? 0 : parseMoney(F.price);
    const out = {
      kind: F.kind,
      billing: F.billing,
      price_pence: price,
      programme_weeks: F.kind === "programme" && F.weeks ? Number(F.weeks) : null,
      instalments: F.billing === "split" ? Number(F.instalments) : null,
      method: F.method,
      start_date: F.start_date,
      first_due: F.billing === "none" ? null : F.first_due || F.start_date,
      end_date: F.end_date || null,
      notes: F.notes || "",
    };
    if (F.kind === "programme" && F.weeks && F.billing !== "monthly" && F.start_date) out.end_date = addDays(F.start_date, Number(F.weeks) * 7 - 1);
    if (F.billing === "monthly") out.day_of_month = mode === "edit" && F.day ? Number(F.day) : Number(out.first_due.slice(8, 10));
    if (F.kind === "pt" && Number(F.sessions)) {
      out.sessions_per_week = Number(F.sessions);
      out.session_minutes = Number(F.minutes) || 60;
      out.hours_per_month = null;
    } else if (F.kind !== "pt" && String(F.hours).trim()) {
      out.hours_per_month = Number(String(F.hours).replace(",", "."));
      out.sessions_per_week = null;
      out.session_minutes = null;
    } else {
      out.hours_per_month = null;
      out.sessions_per_week = null;
      out.session_minutes = null;
    }
    return out;
  }
  function planProblem(F) {
    if (F.kind === "break") {
      if (!F.start_date) return "Pick when the break starts.";
      if (F.until && !F.end_date) return "Pick when they're back, or switch that off.";
      if (F.until && F.end_date < F.start_date) return "They can't be back before the break starts.";
      return "";
    }
    if (F.billing !== "none" && !parseMoney(F.price)) return "Enter the price in pounds, e.g. 160.";
    if (F.billing === "none" && String(F.price).trim() && parseMoney(F.price) == null) return "Enter the price in pounds, e.g. 40.";
    if (F.kind === "programme" && F.billing !== "monthly" && !F.weeks) return "Pick the programme length.";
    if (!F.start_date) return "Pick a start date.";
    if (F.billing !== "none" && !F.first_due) return "Pick the payment date.";
    if (F.end_date && F.end_date < F.start_date) return "The end date is before the start date.";
    return "";
  }

  // ---------- change plan ----------
  function changePlanSheet(c, from) {
    const today = londonToday();
    const cp = curPlan(c.id);
    const start = from && from > today ? from : from || today;
    const kinds = { pt: "PT", coaching: "Full coaching", programme: "Programme", break: "Break", finish: "Finished" };
    const icons = { pt: "user", coaching: "users", programme: "list", break: "pause", finish: "flag" };
    let F = null;
    let thenMode = "decide";
    let finishDate = start;
    const html = `
      ${cp ? `<p class="now-line">Now: <b>${esc(planName(cp))}</b>${cp.kind !== "break" ? ` · ${esc(planPrice(cp))}` : ""}</p>` : `<p class="now-line">${plansOf(c.id).length ? "No plan right now" : "No plan yet"}</p>`}
      <div class="field"><span class="lab">What are they switching to?</span>
        <div class="kind-grid">${Object.entries(kinds)
          .map(([k, l]) => `<button type="button" class="kind" data-kind="${k}">${ic(icons[k])}<span>${l}</span></button>`)
          .join("")}</div></div>
      <form class="form" id="cpForm" novalidate>
        <div id="cpFields"></div>
        <div id="cpThen"></div>
        <div class="summary" id="cpSum" hidden></div>
        <div class="form-err" id="cp-err"></div>
        <button class="btn lime" type="submit" id="cpGo" disabled>Choose an option above</button>
      </form>`;
    openSheet(`Change ${firstName(c.name)}'s plan`, html, (sh) => {
      const thenBox = $("#cpThen", sh);
      const sumBox = $("#cpSum", sh);
      const go = $("#cpGo", sh);
      const prevFor = (s) => lastPaidPlanBefore(c.id, s || start);
      const drawThen = () => {
        if (!F || F.kind === "finish") return (thenBox.innerHTML = "");
        const prev = prevFor(F.start_date);
        const hasEnd = F.kind === "break" ? F.until && F.end_date : F.kind === "programme" && F.weeks && F.billing !== "monthly";
        if (!hasEnd) {
          thenBox.innerHTML = "";
          return;
        }
        if (thenMode === "resume" && !prev) thenMode = "decide";
        const label = F.kind === "break" ? "After the break" : "When it ends";
        thenBox.innerHTML = `<div class="field"><span class="lab">${label}</span>${opts(
          "then",
          prev ? { resume: `Back to ${KIND_SHORT[prev.kind]} · ${planPrice(prev)}`, decide: "Ask me then" } : { decide: "Ask me then" },
          thenMode
        )}</div>`;
      };
      const summary = () => {
        if (!F) return;
        const lines = [];
        const S0 = F.kind === "finish" ? addDays(finishDate, 1) : F.start_date;
        const E = addDays(S0, -1);
        const plans = plansOf(c.id);
        for (const p of plans.filter((x) => x.start_date < S0 && (!x.end_date || x.end_date >= S0))) {
          lines.push(`<li>${esc(planName(p))} ends ${fmtShort(E)}.</li>`);
          const gone = S.data.payments.filter((x) => x.plan_id === p.id && x.auto && isOpen(x) && x.due_date > E);
          if (gone.length) lines.push(`<li class="minus">Removes ${plural(gone.length, "upcoming payment")}: ${gone.slice(0, 3).map((g) => `${fmtDay(g.due_date)} ${money(g.amount_pence)}`).join(", ")}${gone.length > 3 ? "…" : ""}</li>`);
        }
        for (const p of plans.filter((x) => x.start_date >= S0)) lines.push(`<li class="minus">Replaces the ${esc(planName(p).toLowerCase())} planned from ${fmtShort(p.start_date)}.</li>`);
        if (F.kind === "finish") {
          lines.push(`<li>Marked as finished from ${fmtShort(finishDate)}.</li>`);
        } else if (F.kind === "break") {
          lines.push(`<li class="plus">Break from ${fmtShort(F.start_date)}${F.until && F.end_date ? `, back ${fmtShort(addDays(F.end_date, 1))}` : ", open-ended"}. No payments.</li>`);
        } else {
          const price = parseMoney(F.price) || 0;
          const b = F.billing;
          let pay = "";
          if (b === "monthly") pay = F.first_due ? `${money(price)} on ${fmtShort(F.first_due)}, then the ${ordinal(Number(F.first_due.slice(8, 10)))} of each month` : "";
          else if (b === "upfront") pay = `one payment of ${money(price)} due ${fmtShort(F.first_due || F.start_date)}`;
          else if (b === "split") pay = `${F.instalments} payments of about ${money(Math.round(price / (F.instalments || 1)))} from ${fmtShort(F.first_due || F.start_date)}`;
          else pay = "no automatic payments, you add them as they pay";
          const nm = F.kind === "programme" && F.weeks ? `${F.weeks}-week programme` : KIND[F.kind];
          lines.push(`<li class="plus">${esc(nm)} from ${fmtShort(F.start_date)}: ${pay}.</li>`);
        }
        const hasEnd = F.kind === "break" ? F.until && F.end_date : F.kind === "programme" && F.weeks && F.billing !== "monthly";
        if (hasEnd) {
          const end = F.kind === "break" ? F.end_date : addDays(F.start_date, F.weeks * 7 - 1);
          const prev = prevFor(F.start_date);
          if (thenMode === "resume" && prev) lines.push(`<li class="plus">Then back to ${esc(planName(prev))} · ${esc(planPrice(prev))} from ${fmtShort(addDays(end, 1))}.</li>`);
          else lines.push(`<li>On ${fmtShort(end)} you'll be asked what's next.</li>`);
        }
        lines.push(`<li class="keep">Anything already paid or down as didn't pay, or due before ${fmtShort(S0)}, stays as it is.</li>`);
        sumBox.hidden = false;
        sumBox.innerHTML = `<h4>What happens</h4><ul>${lines.join("")}</ul>`;
        go.disabled = false;
        go.textContent = F.kind === "finish" ? "Mark as finished" : F.kind === "break" ? "Start break" : cp || plansOf(c.id).length ? "Switch plan" : "Set plan";
      };
      const pick = (kind) => {
        $$(".kind", sh).forEach((k) => k.classList.toggle("on", k.dataset.kind === kind));
        haptic();
        if (kind === "finish") {
          F = { kind: "finish" };
          const fields = $("#cpFields", sh);
          fields.innerHTML = `<div class="field"><label for="f-fin">Last day</label><input id="f-fin" type="date" value="${finishDate}"></div>
            <p class="hint">Upcoming unpaid payments after this are removed. Anything they already owe stays, and their history is kept.</p>`;
          $("#f-fin", fields).addEventListener("input", (e) => {
            finishDate = e.target.value || today;
            summary();
          });
          drawThen();
          summary();
          return;
        }
        F = planDefaults(c, kind, start);
        if (kind === "break") {
          F.until = true;
          F.end_date = addDays(start, 29);
          thenMode = prevFor(start) ? "resume" : "decide";
        } else thenMode = "decide";
        const fresh = document.createElement("div");
        $("#cpFields", sh).replaceWith(fresh);
        fresh.id = "cpFields";
        bindPlanForm(sh, F, fresh, "change", () => {
          drawThen();
          summary();
        });
      };
      $$(".kind", sh).forEach((k) => (k.onclick = () => pick(k.dataset.kind)));
      thenBox.addEventListener("change", (e) => {
        const g = e.target.closest(".opts");
        if (g && g.dataset.name === "then") {
          thenMode = g.dataset.value;
          summary();
        }
      });
      $("#cpForm", sh).onsubmit = async (e) => {
        e.preventDefault();
        const err = $("#cp-err", sh);
        err.textContent = "";
        if (!F) return;
        go.disabled = true;
        try {
          let r;
          if (F.kind === "finish") {
            if (!confirm(`Mark ${c.name} as finished from ${fmtShort(finishDate)}?`)) return (go.disabled = false);
            r = await api(`/clients/${c.id}/finish`, { method: "POST", body: { date: finishDate } });
          } else {
            const problem = planProblem(F);
            if (problem) {
              go.disabled = false;
              return (err.textContent = problem);
            }
            const then = thenMode === "resume" ? { mode: "resume" } : { mode: "decide" };
            r = await api(`/clients/${c.id}/plan`, { method: "POST", body: { plan: planPayload(F, "change"), then } });
          }
          setData(r.data);
          closeSheet();
          haptic();
          rerender();
          toast(F.kind === "finish" ? `${firstName(c.name)} marked as finished` : F.kind === "break" ? `${firstName(c.name)}'s break is set` : "Plan updated");
        } catch (e2) {
          go.disabled = false;
          if (!e2.silent) err.textContent = e2.message;
        }
      };
    });
  }

  // ---------- fix a plan in place ----------
  function editPlanSheet(p) {
    const c = client(p.client_id);
    const F = {
      kind: p.kind,
      billing: p.billing,
      price: moneyInput(p.price_pence),
      weeks: p.programme_weeks,
      instalments: p.instalments,
      method: p.method,
      start_date: p.start_date,
      first_due: p.first_due,
      day: p.day_of_month,
      end_date: p.end_date || "",
      until: !!p.end_date,
      sessions: p.sessions_per_week || "",
      minutes: p.session_minutes || 60,
      hours: p.sessions_per_week ? "" : p.hours_per_month || "",
      notes: p.notes || "",
    };
    const paid = S.data.payments.filter((x) => x.plan_id === p.id && !isOpen(x)).length; // paid or didn't pay: kept, so no delete
    const html = `
      <form class="form" id="epForm" novalidate>
        <p class="hint">Fixes this plan in place. Its unpaid payments update to match; paid ones never change. For a change from a date onwards (new price, new package), use <b>Change plan</b> instead.</p>
        ${p.kind !== "break" ? `<div class="field"><span class="lab">What</span>${opts("kind", { pt: "PT", coaching: "Full coaching", programme: "Programme" }, p.kind)}</div>` : ""}
        <div id="epFields"></div>
        ${p.then_action === "decide" || p.end_date ? `<label class="switch-row"><span class="l">Ask me when it ends<small>Shows a "what's next?" card on the day</small></span><span class="switch"><input type="checkbox" id="ep-ask" ${p.then_action === "decide" ? "checked" : ""}><i></i></span></label>` : ""}
        <div class="form-err" id="ep-err"></div>
        <button class="btn lime" type="submit">Save plan</button>
        ${paid ? "" : `<button class="btn danger" type="button" id="ep-del">Delete this plan</button>`}
      </form>`;
    openSheet(`${firstName(c?.name)}: ${planName(p)}`, html, (sh) => {
      const box = $("#epFields", sh);
      bindPlanForm(sh, F, box, "edit");
      const kindG = $('[data-name="kind"]', sh);
      if (kindG)
        kindG.addEventListener("change", () => {
          F.kind = kindG.dataset.value;
          box.innerHTML = planFormHTML(F, "edit");
        });
      const del = $("#ep-del", sh);
      if (del)
        del.onclick = async () => {
          if (!confirm("Delete this plan and its unpaid payments?")) return;
          try {
            const r = await api(`/plans/${p.id}`, { method: "DELETE" });
            setData(r.data);
            closeSheet();
            rerender();
            toast("Plan deleted");
          } catch (e) {
            fail(e);
          }
        };
      $("#epForm", sh).onsubmit = async (e) => {
        e.preventDefault();
        const err = $("#ep-err", sh);
        err.textContent = "";
        const problem = planProblem(F);
        if (problem) return (err.textContent = problem);
        const body = planPayload(F, "edit");
        if (p.kind === "break") body.end_date = F.until && F.end_date ? F.end_date : null;
        const ask = $("#ep-ask", sh);
        body.then_action = ask && ask.checked ? "decide" : null;
        try {
          const r = await api(`/plans/${p.id}`, { method: "PUT", body });
          setData(r.data);
          closeSheet();
          haptic();
          rerender();
          toast("Plan saved");
        } catch (e2) {
          if (!e2.silent) err.textContent = e2.message;
        }
      };
    });
  }

  async function resumeFrom(planId) {
    const p = planOf(planId);
    if (!p) return;
    const c = client(p.client_id);
    const start = addDays(p.end_date, 1);
    const prev = planBefore(p);
    if (!prev) return changePlanSheet(c, start);
    const from = start > londonToday() ? start : londonToday();
    const plan = {
      kind: prev.kind,
      billing: prev.billing,
      price_pence: prev.price_pence,
      programme_weeks: prev.programme_weeks,
      instalments: prev.instalments,
      method: prev.method,
      start_date: start,
      first_due: prev.billing === "monthly" ? nextOnDay(prev.day_of_month || Number(from.slice(8, 10)), from) : prev.billing === "none" ? null : from,
      day_of_month: prev.billing === "monthly" ? prev.day_of_month : null,
      hours_per_month: prev.hours_per_month,
      sessions_per_week: prev.sessions_per_week,
      session_minutes: prev.session_minutes,
    };
    if (!confirm(`Put ${firstName(c.name)} back on ${planName(prev)} · ${planPrice(prev)} from ${fmtShort(start)}?`)) return;
    try {
      const r = await api(`/clients/${c.id}/plan`, { method: "POST", body: { plan, then: {} } });
      setData(r.data);
      haptic();
      rerender();
      toast(`${firstName(c.name)} is back on ${KIND_SHORT[prev.kind]}`);
    } catch (e) {
      fail(e);
    }
  }
  async function finishFrom(cid, date) {
    const c = client(cid);
    if (!confirm(`Mark ${c.name} as finished from ${fmtShort(date)}?`)) return;
    try {
      const r = await api(`/clients/${cid}/finish`, { method: "POST", body: { date } });
      setData(r.data);
      rerender();
      toast(`${firstName(c.name)} marked as finished`);
    } catch (e) {
      fail(e);
    }
  }
  async function dismissDecision(planId) {
    try {
      const r = await api(`/plans/${planId}/decided`, { method: "POST" });
      setData(r.data);
      rerender();
    } catch (e) {
      fail(e);
    }
  }

  // ---------- sheets: clients ----------
  function clientSheet(c) {
    const isEdit = !!c;
    const f = c || { name: "", phone: "", tenure: "new", notes: "" };
    const hasPayments = isEdit && clientPayments(c.id).length > 0;
    const today = londonToday();
    let F = isEdit ? null : planDefaults(null, "coaching", today);
    let kind = isEdit ? null : "coaching";
    const html = `
      <form class="form" id="cForm" novalidate>
        <div class="field"><label for="c-name">Name</label><input id="c-name" value="${esc(f.name)}" autocomplete="off" autocapitalize="words" placeholder="Client name"></div>
        <div class="field"><label for="c-phone">Mobile <span>optional, for chasing on WhatsApp or text</span></label><input id="c-phone" type="tel" value="${esc(f.phone || "")}" autocomplete="off" placeholder="07…"></div>
        <div class="field"><span class="lab">Tenure</span>${opts("tenure", TEN, f.tenure)}</div>
        ${
          isEdit
            ? ""
            : `<div class="field"><span class="lab">What are they on?</span>${opts("kind", { pt: "PT", coaching: "Full coaching", programme: "Programme", none: "Not sure yet" }, kind)}</div>
               <div id="c-plan"></div>`
        }
        <div class="field"><label for="c-notes">Notes <span>optional</span></label><textarea id="c-notes" rows="2" placeholder="Arrangements, reminders, anything useful">${esc(f.notes)}</textarea></div>
        ${isEdit ? `<p class="hint">Price, package and payment day live in their plan. Use <b>Change plan</b> on their profile.</p>` : ""}
        <div class="form-err" id="c-err"></div>
        <button class="btn lime" type="submit">${isEdit ? "Save changes" : "Add client"}</button>
        ${isEdit && !hasPayments ? `<button class="btn danger" type="button" id="c-del">Delete client</button>` : ""}
      </form>`;
    openSheet(isEdit ? "Edit client details" : "New client", html, (sh) => {
      if (!isEdit) {
        const box = $("#c-plan", sh);
        const draw = () => {
          const fresh = document.createElement("div");
          fresh.id = "c-plan";
          $("#c-plan", sh).replaceWith(fresh);
          if (kind === "none") {
            fresh.innerHTML = `<p class="hint">You can set their plan later from their profile.</p>`;
            return;
          }
          const keep = F;
          F = planDefaults(null, kind, today);
          if (keep) {
            F.price = keep.price;
            F.method = keep.method;
            F.first_due = keep.first_due;
          }
          bindPlanForm(sh, F, fresh, "add");
        };
        void box;
        $('[data-name="kind"]', sh).addEventListener("change", (e) => {
          kind = e.currentTarget.dataset.value;
          draw();
        });
        draw();
      }
      const del = $("#c-del", sh);
      if (del)
        del.onclick = async () => {
          if (!confirm(`Delete ${c.name}?`)) return;
          try {
            const r = await api(`/clients/${c.id}`, { method: "DELETE" });
            setData(r.data);
            closeSheet();
            S.clientId = null;
            render("pop");
            toast("Client deleted");
          } catch (e) {
            fail(e);
          }
        };
      $("#cForm", sh).onsubmit = async (e) => {
        e.preventDefault();
        const err = $("#c-err", sh);
        err.textContent = "";
        const body = {
          name: $("#c-name", sh).value.trim(),
          phone: $("#c-phone", sh).value.trim(),
          tenure: val(sh, "tenure"),
          notes: $("#c-notes", sh).value,
        };
        if (!body.name) return (err.textContent = "Add their name.");
        if (!isEdit) {
          const dup = S.data.clients.find((x) => x.name.trim().toLowerCase() === body.name.toLowerCase());
          if (dup && !confirm(`You already have a client called ${dup.name}. Add another one anyway?`)) return;
          if (kind !== "none") {
            const problem = planProblem(F);
            if (problem) return (err.textContent = problem);
            const plan = planPayload(F, "add");
            if (F.kind !== "programme") plan.start_date = plan.first_due && plan.first_due < today ? plan.first_due : today;
            body.plan = plan;
          }
        }
        const btn = $("button[type=submit]", sh);
        btn.disabled = true;
        try {
          const r = isEdit ? await api(`/clients/${c.id}`, { method: "PUT", body }) : await api("/clients", { method: "POST", body });
          setData(r.data);
          closeSheet();
          haptic();
          if (!isEdit) {
            S.tab = "clients";
            S.clientId = r.id;
            render("push");
            window.scrollTo(0, 0);
          } else rerender();
          toast(isEdit ? "Changes saved" : `${body.name} added`);
        } catch (e2) {
          btn.disabled = false;
          if (!e2.silent) err.textContent = e2.message;
        }
      };
    });
  }

  function addSheet() {
    openSheet(
      "Add",
      `<div class="action-list">
        <button class="action" data-action="add-payment"${S.tab === "clients" && S.clientId ? ` data-client="${S.clientId}"` : ""}${
        S.tab === "calendar" && S.calDay ? ` data-date="${S.calDay}"` : ""
      }><span class="ic">${ic("receipt")}</span><span><b>Add payment</b><small>A one-off or extra</small></span></button>
        <button class="action" data-action="add-client"><span class="ic">${ic("userplus")}</span><span><b>Add client</b><small>With their plan</small></span></button>
        ${S.tab === "clients" && S.clientId ? `<button class="action" data-change-plan="${S.clientId}"><span class="ic">${ic("swap")}</span><span><b>Change ${esc(firstName(client(S.clientId)?.name))}'s plan</b><small>Switch, break or finish</small></span></button>` : ""}
      </div>`
    );
  }

  // ---------- settings actions ----------
  async function setupFaceId() {
    if (!S.platformAuth) return toast("Face ID isn't available in this browser.");
    try {
      await passkeyRegister();
      S.session = await api("/session");
      rerender();
      haptic();
      toast("Face ID is on");
    } catch (e) {
      if (e.name === "InvalidStateError") toast("Face ID is already set up on this device.");
      else if (!e.silent) toast(webauthnError(e));
    }
  }
  async function removeFaceId() {
    if (!confirm("Turn off Face ID? You'll stay signed in, and the app won't lock.")) return;
    try {
      const { passkeys } = await api("/webauthn/list");
      for (const k of passkeys) await api("/webauthn/remove", { method: "POST", body: { id: k.id } });
      S.session = await api("/session");
      rerender();
      toast("Face ID turned off");
    } catch (e) {
      fail(e);
    }
  }
  function nameSheet() {
    openSheet(
      "Your name",
      `<form class="form" id="nForm"><div class="field"><label for="n">First name</label><input id="n" value="${esc(S.session.name || "")}" autocomplete="given-name"></div><button class="btn lime">Save</button></form>`,
      (sh) => {
        $("#nForm", sh).onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api("/settings", { method: "POST", body: { name: $("#n", sh).value } });
            S.session = await api("/session");
            closeSheet();
            rerender();
          } catch (e2) {
            fail(e2);
          }
        };
      }
    );
  }
  function passwordSheet() {
    openSheet(
      "Change password",
      `<form class="form" id="pwForm">
        <div class="field"><label for="pw1">Current password</label><input id="pw1" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="pw2">New password <span>10+ characters</span></label><input id="pw2" type="password" autocomplete="new-password" minlength="10"></div>
        <p class="hint">Other devices will be signed out. This one stays signed in.</p>
        <div class="form-err" id="pw-err"></div>
        <button class="btn lime">Change password</button>
      </form>`,
      (sh) => {
        $("#pwForm", sh).onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api("/password", { method: "POST", body: { current: $("#pw1", sh).value, next: $("#pw2", sh).value } });
            closeSheet();
            toast("Password changed");
          } catch (e2) {
            if (!e2.silent) $("#pw-err", sh).textContent = e2.message;
          }
        };
      }
    );
  }

  // ---------- morning nudges (web push) ----------
  async function checkPushHere() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return (S.pushHere = false);
      const reg = await navigator.serviceWorker.ready;
      S.pushHere = !!(await reg.pushManager.getSubscription());
    } catch {
      S.pushHere = false;
    }
  }
  async function enableNudges() {
    if (isIOS() && !isStandalone()) throw new Error("Open TS Pay from your Home Screen first, then turn this on.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications are blocked. Turn them on in iPhone Settings → Notifications → TS Pay.");
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api("/push/key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64.dec(key) });
    const r = await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
    S.data.settings = r.settings;
    S.pushHere = true;
    updateBadge();
  }
  async function disableNudges() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const r = await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
      S.data.settings = r.settings;
      await sub.unsubscribe().catch(() => {});
    }
    S.pushHere = false;
  }

  // ---------- navigation ----------
  function goTab(t) {
    const tabBtn = $(`.tab[data-tab="${t}"]`);
    if (tabBtn) {
      tabBtn.classList.remove("bounce");
      void tabBtn.offsetWidth;
      tabBtn.classList.add("bounce");
    }
    if (t === S.tab) {
      if (t === "clients" && S.clientId) {
        S.clientId = null;
        render("pop");
        return;
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (t === "more") {
      S.prevTab = S.tab;
      S.tab = "more";
      checkPushHere().then(() => S.tab === "more" && rerender());
      render("push");
      window.scrollTo(0, 0);
      return;
    }
    S.tab = t;
    render("fade");
    window.scrollTo(0, 0);
  }
  function setCalMonth(mk) {
    S.calMonth = mk;
    const today = londonToday();
    if (mKey(today) === mk) S.calDay = today;
    else {
      const field = S.calMode === "due" ? "due_date" : "paid_date";
      const first = S.data.payments.map((p) => p[field]).filter((d) => d && mKey(d) === mk).sort()[0];
      S.calDay = first || mk + "-01";
    }
  }
  function shiftMonth(dir) {
    const range = monthRange();
    const i = range.indexOf(S.month) + dir;
    if (i < 0 || i >= range.length) return false;
    S.month = range[i];
    S.heroAnim = dir > 0 ? "from-right" : "from-left";
    render();
    return true;
  }
  function shiftCal(dir) {
    setCalMonth(addMonths(S.calMonth, dir));
    S.calAnim = dir > 0 ? "from-right" : "from-left";
    render();
  }

  document.addEventListener(
    "click",
    (e) => {
      if (S.suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const t = e.target.closest(
        "[data-tab],[data-action],[data-month],[data-scope],[data-pay],[data-open-pay],[data-open-client],[data-day],[data-cal],[data-calmode],[data-listmode],[data-cstatus],[data-theme-set],[data-change-plan],[data-edit-plan],[data-resume],[data-finish],[data-dismiss],[data-chase],[data-chase-client],[data-trend],[data-mix],[data-missed],[data-unmiss],[data-paid-after]"
      );
      if (!t || t.disabled) return;
      const d = t.dataset;
      if (d.missed) {
        const p = S.data.payments.find((x) => x.id === Number(d.missed));
        // opened from Needs you or the chase list: go back to it afterwards if anything's left there
        const from = sheet ? sheet.sh.dataset.kind : null;
        const back =
          from === "needs"
            ? () => needCount() && needsSheet()
            : from === "chase"
            ? () => S.data.payments.some((x) => isOpen(x) && x.due_date < londonToday()) && chaseSheet()
            : null;
        return missedSheet(p, back);
      }
      if (d.unmiss) return unmissPayment(Number(d.unmiss));
      if (d.paidAfter) return paidAfterSheet(Number(d.paidAfter));
      if (d.pay) {
        e.stopPropagation();
        haptic();
        const r = t.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2);
        const card = t.closest(".chase-card");
        if (card) {
          card.classList.add("gone");
          setTimeout(() => card.remove(), 300);
        }
        return quickPay(Number(d.pay));
      }
      if (d.tab) return goTab(d.tab);
      if (d.themeSet) {
        setTheme(d.themeSet);
        return rerender();
      }
      if (d.changePlan) {
        const c = client(Number(d.changePlan));
        return c && changePlanSheet(c, d.from);
      }
      if (d.editPlan) {
        const p = planOf(Number(d.editPlan));
        return p && editPlanSheet(p);
      }
      if (d.resume) return resumeFrom(Number(d.resume));
      if (d.finish) return finishFrom(Number(d.finish), d.date);
      if (d.dismiss) return dismissDecision(Number(d.dismiss));
      if (d.chase) {
        const p = S.data.payments.find((x) => x.id === Number(d.chase));
        return p && chaseSheet([p]);
      }
      if (d.chaseClient) return chaseSheet(clientOwes(Number(d.chaseClient)));
      if (d.trend) {
        S.trendSel = d.trend;
        return rerender();
      }
      if (d.mix) {
        S.mixMode = d.mix;
        return rerender();
      }
      if (d.action) {
        switch (d.action) {
          case "add":
            return addSheet();
          case "add-payment":
            return paymentSheet(null, { due_date: d.date, client_id: d.client ? Number(d.client) : null });
          case "add-client":
            return clientSheet(null);
          case "edit-client": {
            const c = client(Number(d.client));
            return c && clientSheet(c);
          }
          case "chase-list":
            return chaseSheet();
          case "needs":
            return needsSheet();
          case "template":
            return templateSheet();
          case "goal":
            return goalSheet();
          case "trend-table":
            S.trendTable = !S.trendTable;
            return rerender();
          case "back":
            S.clientId = null;
            render("pop");
            return;
          case "close-settings":
            S.tab = S.prevTab && S.prevTab !== "more" ? S.prevTab : "month";
            render("pop");
            return;
          case "push-test":
            return api("/push/test", { method: "POST" })
              .then((r) => toast(r.ok ? "Sent. It should arrive in a few seconds." : "Couldn't reach your phone. Try turning nudges off and on again."))
              .catch(fail);
          case "faceid-setup":
            return setupFaceId();
          case "faceid-remove":
            return removeFaceId();
          case "hide-face":
            setPref("hideFace", "1");
            return rerender();
          case "edit-name":
            return nameSheet();
          case "password":
            return passwordSheet();
          case "signout":
            if (!confirm("Sign out of this device?")) return;
            return api("/logout", { method: "POST", raw: true })
              .catch(() => {})
              .then(() => {
                S.data = null;
                renderLogin();
              });
        }
        return;
      }
      if (d.month !== undefined) {
        if (!d.month || d.month === S.month) return;
        const dir = d.month > S.month ? 1 : -1;
        S.month = d.month;
        S.heroAnim = dir > 0 ? "from-right" : "from-left";
        return rerender();
      }
      if (d.scope) {
        S.scope = d.scope;
        if (d.status) S.fStatus = d.status;
        rerender();
        if (t.classList.contains("tile") || t.classList.contains("banner") || t.classList.contains("lost-line")) {
          const el = $(".section-head");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }
      if (d.openPay) {
        const p = S.data.payments.find((x) => x.id === Number(d.openPay));
        if (p) paymentSheet(p);
        return;
      }
      if (d.openClient) {
        if (t.hasAttribute("data-close-sheet")) closeSheet(true);
        S.tab = "clients";
        S.clientId = Number(d.openClient);
        render("push");
        window.scrollTo(0, 0);
        return;
      }
      if (d.day) {
        S.calDay = d.day;
        return rerender();
      }
      if (d.cal) {
        if (d.cal === "today") {
          const tk = mKey(londonToday());
          const dir = tk > S.calMonth ? 1 : -1;
          setCalMonth(tk);
          S.calAnim = dir > 0 ? "from-right" : "from-left";
          return rerender();
        }
        return shiftCal(d.cal === "prev" ? -1 : 1);
      }
      if (d.calmode) {
        S.calMode = d.calmode;
        return rerender();
      }
      if (d.listmode) {
        S.listMode = d.listmode;
        setPref("listMode", d.listmode);
        return rerender();
      }
      if (d.cstatus) {
        S.cStatus = d.cstatus;
        return rerender();
      }
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-open-pay][role=button]")) {
      e.preventDefault();
      e.target.click();
    }
    if (e.key === "Escape") closeSheet();
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "q") {
      S.q = e.target.value;
      renderList();
    }
    if (e.target.id === "cq") {
      S.cq = e.target.value;
      renderClientList();
    }
  });
  document.addEventListener("change", async (e) => {
    if (e.target.id === "fStatus") {
      S.fStatus = e.target.value;
      rerender();
    }
    if (e.target.id === "fPkg") {
      S.fPkg = e.target.value;
      rerender();
    }
    if (e.target.id === "lockSel") {
      try {
        await api("/settings", { method: "POST", body: { lockMinutes: Number(e.target.value) } });
        S.session = await api("/session");
        toast("Saved");
      } catch (err) {
        fail(err);
      }
    }
    if (e.target.id === "nudgeToggle") {
      const on = e.target.checked;
      try {
        if (on) await enableNudges();
        else await disableNudges();
        toast(on ? `Morning nudge on for ${S.data.settings.nudgeHour}:00am` : "Morning nudge off");
      } catch (err) {
        e.target.checked = !on;
        fail(err);
      }
      rerender();
    }
    if (e.target.id === "nudgeHour") {
      try {
        const r = await api("/settings", { method: "POST", body: { nudgeHour: Number(e.target.value) } });
        S.data.settings = r.settings;
        toast(`Nudge time set to ${e.target.value}:00am`);
      } catch (err) {
        fail(err);
      }
    }
  });

  // ---------- touch: swipe rows, month swipes, pull to refresh, edge-swipe back ----------
  let T = null;
  document.addEventListener(
    "touchstart",
    (e) => {
      if (sheet || !S.data || S.locked || e.touches.length > 1) return;
      const t = e.touches[0];
      const tgt = e.target;
      const sw = tgt.closest(".swipe");
      T = {
        x0: t.clientX,
        y0: t.clientY,
        dx: 0,
        dy: 0,
        mode: null,
        row: sw && $(".swipe-bg", sw) ? $(".prow", sw) : null,
        pan: tgt.closest("#hero, #calCard"),
        edge: t.clientX < 28 && ((S.tab === "clients" && S.clientId) || S.tab === "more"),
        top: window.scrollY <= 0,
        noPull: !!tgt.closest(".strip, .table-wrap, .tabbar, .trend"),
      };
      if (T.pan && T.pan.id === "hero" && S.tab !== "month") T.pan = null;
    },
    { passive: true }
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!T) return;
      const t = e.touches[0];
      T.dx = t.clientX - T.x0;
      T.dy = t.clientY - T.y0;
      if (!T.mode) {
        const ax = Math.abs(T.dx);
        const ay = Math.abs(T.dy);
        if (ax > 8 && ax > ay * 1.2) T.mode = T.edge && T.dx > 0 ? "back" : T.row ? "row" : T.pan ? "pan" : "none";
        else if (T.dy > 8 && ay > ax && T.top && window.scrollY <= 0 && !T.noPull && S.tab !== "more") T.mode = "ptr";
        else if (ay > 8) T.mode = "none";
        if (!T.mode) return;
      }
      if (T.mode === "none") return;
      e.preventDefault();
      if (T.mode === "row") {
        const d = T.dx;
        const lim = 110;
        const eased = Math.abs(d) > lim ? Math.sign(d) * (lim + (Math.abs(d) - lim) * 0.35) : d;
        const wrap = T.row.parentElement;
        const bgPaid = $(".swipe-bg.paid", wrap);
        const bgChase = $(".swipe-bg.chase", wrap);
        T.row.classList.add("dragging");
        T.row.classList.remove("snap");
        T.row.style.transform = `translateX(${eased}px)`;
        bgPaid.style.opacity = d < 0 ? Math.min(1, -d / 50) : 0;
        bgChase.style.opacity = d > 0 ? Math.min(1, d / 50) : 0;
        const armed = d < -90 ? "paid" : d > 90 ? "chase" : null;
        if (armed !== T.armed) {
          T.armed = armed;
          bgPaid.classList.toggle("armed", armed === "paid");
          bgChase.classList.toggle("armed", armed === "chase");
          if (armed) haptic();
        }
      } else if (T.mode === "pan") {
        const target = T.pan.id === "calCard" ? $("#calGrid") : T.pan;
        target.style.transition = "none";
        target.style.transform = `translateX(${T.dx * 0.35}px)`;
        target.style.opacity = String(1 - Math.min(0.5, Math.abs(T.dx) / 400));
      } else if (T.mode === "back") {
        const v = $("#view");
        v.style.transition = "none";
        v.style.transform = `translateX(${Math.max(0, T.dx) * 0.6}px)`;
      } else if (T.mode === "ptr") {
        const y = Math.min(T.dy * 0.5, 100);
        const ptr = $("#ptr");
        ptr.classList.add("show");
        ptr.style.transition = "none";
        ptr.style.transform = `translate(-50%, ${y - 60}px)`;
        $(".coin-logo", ptr).style.transform = `rotateY(${T.dy * 2}deg)`;
        if (y > 64 && !T.armed) {
          T.armed = true;
          haptic();
        } else if (y <= 64) T.armed = false;
      }
    },
    { passive: false }
  );
  document.addEventListener("touchend", async () => {
    if (!T) return;
    const s = T;
    T = null;
    if (!s.mode || s.mode === "none") return;
    S.suppressClick = true;
    setTimeout(() => (S.suppressClick = false), 350);
    if (s.mode === "row") {
      const wrap = s.row.parentElement;
      s.row.classList.remove("dragging");
      s.row.classList.add("snap");
      const id = Number(s.row.dataset.openPay);
      if (s.armed === "paid") {
        s.row.style.transform = "translateX(-110%)";
        const r = $(".swipe-bg.paid", wrap).getBoundingClientRect();
        burst(r.right - 40, r.top + r.height / 2);
        setTimeout(() => quickPay(id), 200);
      } else {
        s.row.style.transform = "";
        $$(".swipe-bg", wrap).forEach((b) => (b.style.opacity = 0));
        if (s.armed === "chase") {
          const p = S.data.payments.find((x) => x.id === id);
          if (p) setTimeout(() => chaseSheet([p]), 150);
        }
      }
    } else if (s.mode === "pan") {
      const target = s.pan.id === "calCard" ? $("#calGrid") : s.pan;
      target.style.transition = "";
      target.style.transform = "";
      target.style.opacity = "";
      if (Math.abs(s.dx) > 60) {
        haptic();
        if (s.pan.id === "calCard") shiftCal(s.dx < 0 ? 1 : -1);
        else shiftMonth(s.dx < 0 ? 1 : -1);
      }
    } else if (s.mode === "back") {
      const v = $("#view");
      v.style.transition = "transform .25s var(--ease)";
      v.style.transform = "";
      setTimeout(() => (v.style.transition = ""), 260);
      if (s.dx > 90) {
        if (S.tab === "more") {
          S.tab = S.prevTab && S.prevTab !== "more" ? S.prevTab : "month";
        } else S.clientId = null;
        render("pop");
      }
    } else if (s.mode === "ptr") {
      const ptr = $("#ptr");
      const coin = $(".coin-logo", ptr);
      ptr.style.transition = "transform .35s var(--spring)";
      coin.style.transform = "";
      if (s.armed) {
        ptr.style.transform = "translate(-50%, 8px)";
        ptr.classList.add("spin");
        try {
          const [d] = await Promise.all([api("/data"), new Promise((r) => setTimeout(r, 600))]);
          setData(d);
          render();
        } catch (e) {
          fail(e);
        }
        ptr.classList.remove("spin");
      }
      ptr.style.transform = "";
      setTimeout(() => ptr.classList.remove("show"), 250);
    }
  });
  document.addEventListener("touchcancel", () => (T = null));

  // ---------- lifecycle: lock on return, keep alive while open ----------
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden") return markHidden();
    if (!S.data) return;
    if (S.locked) return;
    if (awayTooLong()) return renderLock();
    setPref("hiddenAt", "0");
    if (Date.now() - S.lastSync < 15000) return;
    try {
      const s = await api("/session", { raw: true });
      if (!s.authed) return renderLogin();
      if (s.locked) return renderLock();
      S.session = s;
      setData(await api("/data"));
      if (!sheet) rerender();
      else refreshNeeds();
      openPendingNeeds();
    } catch {}
  });
  window.addEventListener("pagehide", markHidden);
  setInterval(async () => {
    if (document.visibilityState !== "visible" || !S.data || S.locked || !S.session?.hasPasskey) return;
    try {
      const s = await api("/session", { raw: true });
      if (s.authed && s.locked) renderLock();
    } catch {}
  }, 30000);
  window.addEventListener("resize", () => {
    moveTabIndicator(true);
    S.segPos = {};
    layoutSegs();
  });

  // ---------- boot ----------
  async function boot() {
    try {
      const s = await api("/session", { raw: true });
      S.session = s;
      if (!s.hasUser) return renderSetup();
      if (!s.authed) return renderLogin();
      if (s.locked || awayTooLong()) return renderLock();
      S.locked = false;
      setPref("hiddenAt", "0");
      setData(await api("/data"));
      const today = londonToday();
      if (!S.month) S.month = mKey(today) < mKey(TRACK_START) ? mKey(TRACK_START) : mKey(today);
      if (!S.calMonth) setCalMonth(S.month);
      root().innerHTML = "";
      render("fade");
      checkPushHere();
      openPendingNeeds();
    } catch (e) {
      if (e.silent) return;
      root().innerHTML = `<div class="lock-screen"><div class="coin-logo big">£</div><h1>Can't connect</h1><p>${esc(e.message)}</p><button class="btn lime" id="retry">Try again</button></div>`;
      $("#retry").onclick = boot;
    }
  }

  try {
    if (new URLSearchParams(location.search).has("needs")) {
      S.pendingNeeds = true;
      history.replaceState(null, "", location.pathname);
    }
  } catch {}
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type !== "needs") return;
      S.pendingNeeds = true;
      // if the app is about to lock, it opens straight after Face ID instead
      setTimeout(openPendingNeeds, 300);
    });

  (async () => {
    applyTheme(pref("theme", "system"));
    try {
      if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
        S.platformAuth = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      }
    } catch {}
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    boot();
  })();
})();
