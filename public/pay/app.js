/* TrueStay Pay — client payments & revenue. Vanilla JS, talks to /api/pay. */
(() => {
  "use strict";

  const API = "/api/pay";
  const TRACK_START = "2026-09-28";
  const PKG = { pt: "PT only", coaching: "Full coaching", programme: "Programme" };
  const TEN = { new: "New", newish: "New-ish", longstanding: "Longstanding" };
  const METH = { manual: "Manual", dd: "Direct debit" };
  const METH_LONG = { manual: "Manual payment", dd: "Direct debit" };
  const CST = { active: "Active", paused: "Paused", finished: "Finished" };
  const STL = { paid: "Paid", unpaid: "Unpaid", overdue: "Overdue" };
  const WEEKS = [4, 8, 12, 16];
  const LOCKS = [
    [1, "Every time I open it"],
    [5, "After 5 minutes away"],
    [15, "After 15 minutes away"],
    [60, "After an hour away"],
    [0, "Never"],
  ];
  const LOCK_GRACE_MS = 10000; // "every time": ignore quick glances at a notification
  const TAB_ORDER = { month: 0, calendar: 1, clients: 3, more: 4 };
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

  // dates — 'YYYY-MM-DD' strings in UK time
  const londonToday = () =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const londonHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(new Date()));
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
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

  // money — pence integers
  const money = (p) => {
    const s = "£" + Math.floor(p / 100).toLocaleString("en-GB");
    return p % 100 ? s + "." + pad(p % 100) : s;
  };
  const moneyBig = (p) => "£" + Math.floor(p / 100).toLocaleString("en-GB") + `<small>.${pad(p % 100)}</small>`;
  const moneyCompact = (p) => (p >= 100000 ? "£" + (p / 100000).toFixed(p >= 1000000 ? 0 : 1).replace(/\.0$/, "") + "k" : money(p));
  const parseMoney = (s) => {
    const t = String(s).replace(/[£,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(parseFloat(t) * 100);
  };
  const moneyInput = (p) => (p == null ? "" : p % 100 ? (p / 100).toFixed(2) : String(p / 100));
  const initials = (name) =>
    String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  // ---------- icons ----------
  const P = {
    bars: '<path d="M4 20V11"/><path d="M10 20V4"/><path d="M16 20v-6"/><path d="M22 20H2"/>',
    cal: '<rect x="3" y="4.5" width="18" height="17" rx="4"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.7.8 2.8 2.5 3.1 5.2"/>',
    more: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
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
    pause: '<rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/>',
    play: '<path d="M7 5.5v13l11-6.5z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
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
    smap: new Map(),
    tab: "month", // always opens on Month
    clientId: null, // open client profile
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
    platformAuth: false,
    lastSync: 0,
    locked: false,
    counts: {},
    segPos: {},
    suppressClick: false,
  };

  const client = (id) => S.cmap.get(id);
  const cname = (p) => client(p.client_id)?.name || "Deleted client";
  const stOf = (p) => (p.paid_date ? "paid" : p.due_date < londonToday() ? "overdue" : "unpaid");
  const schedActive = (id) => !!(id && S.smap.get(id)?.active);
  const pkgText = (pkg, weeks) => (pkg === "programme" && weeks ? `${weeks}-week programme` : PKG[pkg]);

  function setData(d) {
    S.data = d;
    S.cmap = new Map(d.clients.map((c) => [c.id, c]));
    S.smap = new Map(d.schedules.map((s) => [s.id, s]));
    S.lastSync = Date.now();
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
      // iOS 18+: toggling a native switch gives a light tap
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
  // The app locks when you come back after being away, never in the middle of using it.
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
      if (!b) return;
      const g = b.parentElement;
      $$(".opt", g).forEach((x) => x.classList.toggle("on", x === b));
      g.dataset.value = b.dataset.val;
      g.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // drag the top of the sheet down to close
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
    go(true); // try straight away; if iOS wants a tap first, one tap does it
  }

  // ---------- derived numbers ----------
  function monthStats(mk) {
    const ps = S.data.payments;
    const due = ps.filter((p) => mKey(p.due_date) === mk);
    const unpaid = due.filter((p) => !p.paid_date);
    const received = ps.filter((p) => p.paid_date && mKey(p.paid_date) === mk);
    const overdue = ps.filter((p) => stOf(p) === "overdue");
    const dueSum = sum(due);
    const unpaidSum = sum(unpaid);
    return { due, dueSum, unpaid, unpaidSum, received, receivedSum: sum(received), overdue, overdueSum: sum(overdue), collected: dueSum - unpaidSum };
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
  const count = (key, value, kind = "money") => {
    const from = S.counts[key] ?? 0;
    const f = kind === "big" ? moneyBig : kind === "pct" ? (v) => v + "%" : money;
    return `<span data-count="${key}" data-val="${value}" data-kind="${kind}">${f(from)}</span>`;
  };
  function runCounts() {
    $$("[data-count]").forEach((el) => {
      const key = el.dataset.count;
      const to = Number(el.dataset.val);
      const kind = el.dataset.kind;
      const f = kind === "big" ? moneyBig : kind === "pct" ? (v) => v + "%" : money;
      const from = S.counts[key] ?? 0;
      S.counts[key] = to;
      if (from === to || reduced) {
        el.innerHTML = f(to);
        return;
      }
      const t0 = performance.now();
      const dur = 800;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
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
    if (st === "overdue") return `<span class="pill overdue">Overdue · ${daysBetween(p.due_date, londonToday())}d</span>`;
    return `<span class="pill unpaid">Unpaid</span>`;
  }
  function prow(p, { showClient = true } = {}) {
    const st = stOf(p);
    const rep = schedActive(p.schedule_id) ? " " + ic("repeat") : "";
    const title = showClient ? esc(cname(p)) : `Due ${fmtShort(p.due_date)}`;
    const meta = `${esc(pkgText(p.package, p.programme_weeks))} · ${METH[p.method]}${rep}`;
    const row = `<div class="prow st-${st}" data-open-pay="${p.id}" role="button" tabindex="0">
      <div class="av">${showClient ? esc(initials(cname(p))) : ic("receipt")}</div>
      <div class="main">
        <div class="name">${title}</div>
        <div class="meta">${meta}</div>
        <div style="margin-top:6px">${pill(p)}</div>
      </div>
      <div class="right">
        <div class="amt num">${money(p.amount_pence)}</div>
        ${showClient ? `<div class="when">Due ${fmtShort(p.due_date)}</div>` : ""}
      </div>
      ${
        st === "paid"
          ? `<div class="paydone" aria-label="Paid">${ic("check")}</div>`
          : `<button class="paybtn" data-pay="${p.id}" aria-label="Mark ${esc(cname(p))} as paid">${ic("check")}</button>`
      }
    </div>`;
    return st === "paid" ? `<div class="swipe" data-pid="${p.id}">${row}</div>` : `<div class="swipe" data-pid="${p.id}"><div class="swipe-bg">${ic("check")} Paid</div>${row}</div>`;
  }
  function ptable(ps) {
    return `<div class="table-wrap"><table class="pt">
      <thead><tr><th>Client</th><th>Package</th><th class="n">Amount</th><th>Due date</th><th>Payment method</th><th>Status</th><th>Paid date</th><th>Actions</th></tr></thead>
      <tbody>${ps
        .map((p) => {
          const st = stOf(p);
          return `<tr class="st-${st}">
          <td class="client">${esc(cname(p))}${schedActive(p.schedule_id) ? ` <span title="Repeats monthly" style="display:inline-block;vertical-align:-2px;width:13px;color:var(--muted)">${ic("repeat")}</span>` : ""}</td>
          <td>${esc(pkgText(p.package, p.programme_weeks))}</td>
          <td class="n num">${money(p.amount_pence)}</td>
          <td class="num">${fmtUK(p.due_date)}</td>
          <td>${METH_LONG[p.method]}</td>
          <td><span class="pill ${st}">${STL[st]}</span></td>
          <td class="num">${fmtUK(p.paid_date)}</td>
          <td><div class="acts">${st !== "paid" ? `<button class="mini dark" data-pay="${p.id}">Mark paid</button>` : ""}<button class="mini" data-open-pay="${p.id}">Edit</button></div></td>
        </tr>`;
        })
        .join("")}</tbody></table></div>`;
  }
  const topbar = (title, right = "") => `<div class="topbar"><div class="title">${title}</div><div class="actions">${right}</div></div>`;

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
    const older = st.overdue.filter((p) => mKey(p.due_date) < mk);
    const noClients = !S.data.clients.length;
    const showFace = S.platformAuth && !S.session.hasPasskey && pref("hideFace", "0") !== "1";

    return `
      ${topbar(`<span class="coin-logo spin">£</span>`, `<a class="round" href="${API}/export?type=payments" aria-label="Export payments CSV">${ic("download")}</a><button class="round" data-tab="more" aria-label="Settings">${ic("user")}</button>`)}
      <h1 class="hello rise" style="--i:0">${greet}${name}. <em>Here's what's</em> coming in.</h1>

      <div class="monthbar rise" style="--i:1">
        <div class="m">${mLabel(mk)}${mk === cur ? "<small>this month</small>" : ""}</div>
        <div class="navs">
          <button class="round" data-month="${range[idx - 1] || ""}" data-dir="-1" ${idx > 0 ? "" : "disabled"} aria-label="Previous month">${ic("left")}</button>
          <button class="round" data-month="${range[idx + 1] || ""}" data-dir="1" ${idx < range.length - 1 ? "" : "disabled"} aria-label="Next month">${ic("right")}</button>
        </div>
      </div>
      <div class="strip" id="strip">
        ${range
          .map((k, i) => {
            const ps = S.data.payments.filter((p) => mKey(p.due_date) === k);
            const due = sum(ps);
            const got = sum(ps.filter((p) => p.paid_date));
            const hh = Math.round((due / maxBar) * 40);
            const hg = due ? Math.round((got / due) * hh) : 0;
            return `<button class="mpill${k === mk ? " sel" : ""}${k === cur ? " now" : ""}" data-month="${k}" style="--i:${i}" aria-label="${mLabel(k)}">
              <div class="bars">
                <div class="bar" style="height:${Math.max(4, hh - hg)}px;${hg ? "border-radius:8px 8px 0 0" : ""}"></div>
                ${hg ? `<div class="bar recv" style="height:${hg}px;border-radius:0 0 4px 4px"></div>` : ""}
              </div>
              <span class="lbl">${mShort(k)}</span></button>`;
          })
          .join("")}
      </div>

      <section class="hero rise ${S.heroAnim}" style="--i:2" id="hero">
        ${rings}
        <div class="k">Due in ${mName(mk)}</div>
        <div class="big num">${count("due", st.dueSum, "big")}</div>
        <div class="sub">${plural(st.due.length, "payment")} scheduled · ${money(st.collected)} of it paid</div>
        <div class="progress" role="img" aria-label="${pct}% of this month's payments collected">
          <div class="fill" data-pct="${pct}" style="width:${S.counts.pct ?? 0}%"><span class="knob">${count("pct", pct, "pct")}</span></div>
        </div>
        <div class="progress-legend"><span>Collected ${money(st.collected)}</span><span>Left ${money(st.unpaidSum)}</span></div>
      </section>

      <div class="tiles">
        <button class="tile lime wide rise" style="--i:3" data-scope="received" id="recvTile">
          <span class="arrow">${ic("arrow")}</span>
          <div class="k">Received in ${mName(mk)}</div>
          <div class="v num">${count("recv", st.receivedSum, "big")}</div>
          <div class="s">${plural(st.received.length, "payment")} actually landed, by paid date</div>
        </button>
        <button class="tile rise" style="--i:4" data-scope="month" data-status="notpaid">
          <span class="arrow">${ic("arrow")}</span>
          <div class="k">Still unpaid</div>
          <div class="v num">${count("unpaid", st.unpaidSum)}</div>
          <div class="s">${plural(st.unpaid.length, "payment")} due in ${mShort(mk)}</div>
        </button>
        <button class="tile red rise${st.overdueSum ? " has" : ""}" style="--i:5" data-scope="unpaid" data-status="overdue">
          <span class="arrow">${ic("arrow")}</span>
          <div class="k">Overdue now</div>
          <div class="v num">${count("overdue", st.overdueSum)}</div>
          <div class="s">${st.overdue.length ? '<span class="live"></span>' : ""}${plural(st.overdue.length, "payment")}, all months</div>
        </button>
      </div>
      ${mk === mKey(TRACK_START) ? `<p class="note">${ic("info")}<span>Tracking started on 28 September 2026, so September only includes payments from then on.</span></p>` : ""}
      ${mk > cur ? `<p class="note">${ic("info")}<span>Only shows payments already on the books. Monthly repeats appear about a month ahead.</span></p>` : ""}
      ${
        older.length && S.scope === "month"
          ? `<button class="banner" data-scope="unpaid" data-status="overdue"><span class="dot">${ic("alert")}</span><span><b>${plural(older.length, "older payment")} still unpaid</b><br>${money(sum(older))} from before ${mName(mk)}</span><span class="go">${ic("right")}</span></button>`
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
          ? `<div class="empty"><b>Let's get your clients in</b><span>Add each client with their next payment. Turn on "repeat monthly" for the regulars and it'll look after itself.</span><button class="btn sm lime" data-action="add-client">${ic("userplus")} Add your first client</button></div>`
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
            ${[["all", "Any status"], ["notpaid", "Unpaid + overdue"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"]]
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

  function filteredPayments() {
    const mk = S.month;
    let ps = S.data.payments.slice();
    if (S.scope === "month") ps = ps.filter((p) => mKey(p.due_date) === mk);
    else if (S.scope === "received") ps = ps.filter((p) => p.paid_date && mKey(p.paid_date) === mk);
    else if (S.scope === "unpaid") ps = ps.filter((p) => !p.paid_date);
    if (S.fStatus === "notpaid") ps = ps.filter((p) => !p.paid_date);
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
    const hasUnpaid = ps.some((p) => !p.paid_date);
    el.innerHTML =
      (S.listMode === "table" ? ptable(ps) : `<div class="list">${ps.map((p) => prow(p)).join("")}</div>`) +
      `<div class="total-line"><span>${plural(ps.length, "payment")}</span><span>Total <b class="num">${money(sum(ps))}</b></span></div>` +
      (S.listMode === "list" && hasUnpaid ? `<p class="tip">Tip: swipe a payment left to mark it paid</p>` : "");
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
    const order = { overdue: 0, unpaid: 1, paid: 2 };
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
        <div class="cal-legend"><span><i style="background:var(--red)"></i>Overdue</span><span><i style="background:var(--amber)"></i>Unpaid</span><span><i style="background:var(--green)"></i>Paid</span></div>
      </div>
      <div class="cal-totals">
        <div class="tile rise" style="--i:1"><div class="k">Due in ${mShort(mk)}</div><div class="v num">${count("cdue", st.dueSum)}</div><div class="s">${money(st.unpaidSum)} still unpaid</div></div>
        <div class="tile lime rise" style="--i:2"><div class="k">Received in ${mShort(mk)}</div><div class="v num" style="font-size:27px">${count("crecv", st.receivedSum)}</div><div class="s">by paid date</div></div>
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
  const clientNext = (id) =>
    clientPayments(id)
      .filter((p) => !p.paid_date && p.due_date >= londonToday())
      .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];

  function viewClients() {
    if (S.clientId && client(S.clientId)) return viewClient(client(S.clientId));
    S.clientId = null;
    const cs = S.data.clients;
    const counts = { active: 0, paused: 0, finished: 0 };
    cs.forEach((c) => counts[c.status]++);
    return `
      ${topbar("Clients", `<button class="round lime" data-action="add-client" aria-label="Add client">${ic("plus")}</button>`)}
      <div class="filters">
        <label class="search">${ic("search")}<input id="cq" type="search" placeholder="Search clients" value="${esc(S.cq)}" autocomplete="off"></label>
        <div class="seg small full" data-seg="cstatus">
          ${["active", "paused", "finished"].map((s) => `<button class="${S.cStatus === s ? "on" : ""}" data-cstatus="${s}">${CST[s]} ${counts[s]}</button>`).join("")}
          <button class="${S.cStatus === "all" ? "on" : ""}" data-cstatus="all">All ${cs.length}</button>
        </div>
      </div>
      <div id="clist"></div>`;
  }
  function renderClientList() {
    const el = $("#clist");
    if (!el) return;
    let list = S.data.clients;
    if (S.cStatus !== "all") list = list.filter((c) => c.status === S.cStatus);
    if (S.cq.trim()) list = list.filter((c) => c.name.toLowerCase().includes(S.cq.trim().toLowerCase()));
    if (!S.data.clients.length) {
      el.innerHTML = `<div class="empty"><b>No clients yet</b><span>Add your current clients and their next payment.</span><button class="btn sm lime" data-action="add-client">${ic("userplus")} Add client</button></div>`;
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="empty"><b>No ${S.cStatus === "all" ? "" : CST[S.cStatus].toLowerCase() + " "}clients${S.cq ? " match that" : ""}</b></div>`;
      return;
    }
    el.innerHTML = `<div class="list">${list
      .map((c, i) => {
        const owes = clientOwes(c.id);
        const next = clientNext(c.id);
        const right = owes.length
          ? `<b class="owe num">${money(sum(owes))}</b>overdue`
          : next
          ? `<b class="num">${money(next.amount_pence)}</b>next ${fmtDay(next.due_date)}`
          : `<b>—</b>nothing due`;
        return `<button class="crow rise${c.status !== "active" ? " dim" : ""}" style="--i:${Math.min(i, 8)}" data-open-client="${c.id}">
          <div class="av">${esc(initials(c.name))}</div>
          <div class="main">
            <div class="name"><span class="t">${esc(c.name)}</span><span class="tag${c.tenure === "new" ? " new" : ""}">${TEN[c.tenure]}</span>${c.status !== "active" ? `<span class="tag">${CST[c.status]}</span>` : ""}</div>
            <div class="meta">${esc(pkgText(c.package, c.programme_weeks))} · ${money(c.price_pence)} · ${METH[c.method]}</div>
          </div>
          <div class="right">${right}</div>
          <span class="chev">${ic("right")}</span>
        </button>`;
      })
      .join("")}</div>`;
  }

  // Client profile: read-only by default, edit is a separate, clearly-labelled sheet.
  function viewClient(c) {
    const ps = clientPayments(c.id).sort((a, b) => (a.due_date < b.due_date ? 1 : a.due_date > b.due_date ? -1 : b.id - a.id));
    const owes = clientOwes(c.id);
    const next = clientNext(c.id);
    const received = ps.filter((p) => p.paid_date);
    const reps = S.data.schedules.filter((s) => s.client_id === c.id && s.active);
    return `
      <div class="topbar">
        <button class="back" data-action="back">${ic("left")} Clients</button>
        <div class="actions"><button class="btn sm ghost" data-action="edit-client" data-client="${c.id}">${ic("edit")} Edit</button></div>
      </div>
      <section class="profile rise" style="--i:0">
        ${rings}
        <div class="top">
          <div class="bigav">${esc(initials(c.name))}</div>
          <div style="min-width:0">
            <h1>${esc(c.name)}</h1>
            <div class="tags"><span class="tag dark${c.tenure === "new" ? " new" : ""}">${TEN[c.tenure]}</span><span class="tag dark">${CST[c.status]}</span></div>
          </div>
        </div>
        <div class="facts">
          <div>Package<b>${esc(pkgText(c.package, c.programme_weeks))}</b></div>
          <div>Agreed price<b class="num">${money(c.price_pence)}</b></div>
          <div>Usually pays by<b>${METH_LONG[c.method]}</b></div>
          <div>Next payment<b class="num">${next ? `${fmtDay(next.due_date)} · ${money(next.amount_pence)}` : "None scheduled"}</b></div>
        </div>
      </section>
      <div class="tiles" style="grid-template-columns:1fr 1fr">
        <div class="tile red rise${owes.length ? " has" : ""}" style="--i:1"><div class="k">Overdue</div><div class="v num">${count("c-owe-" + c.id, sum(owes))}</div><div class="s">${owes.length ? '<span class="live"></span>' : ""}${plural(owes.length, "payment")}</div></div>
        <div class="tile lime rise" style="--i:2"><div class="k">Received</div><div class="v num" style="font-size:27px">${count("c-got-" + c.id, sum(received))}</div><div class="s">since tracking began</div></div>
      </div>
      <div class="quick rise" style="--i:3">
        <button class="btn lime" data-action="add-payment" data-client="${c.id}">${ic("plus")} Add payment</button>
        ${
          c.status === "active"
            ? `<button class="btn ghost" data-action="client-status" data-client="${c.id}" data-to="paused">${ic("pause")} Pause</button>`
            : `<button class="btn ghost" data-action="client-status" data-client="${c.id}" data-to="active">${ic("play")} Make active</button>`
        }
      </div>
      ${
        reps.length
          ? `<div class="section-head"><h2 class="sm">Repeats monthly</h2></div>${reps
              .map(
                (s) => `<button class="rep-card" data-sched-edit="${s.id}" style="width:100%;text-align:left">
                  <span class="ic">${ic("repeat")}</span>
                  <span class="l"><b class="num">${money(s.amount_pence)} on the ${ordinal(s.day_of_month)}</b><small>${esc(pkgText(s.package, s.programme_weeks))} · ${METH_LONG[s.method]}</small></span>
                  <span class="r" style="color:var(--muted)">${ic("right")}</span>
                </button>`
              )
              .join("")}`
          : ""
      }
      ${c.notes ? `<div class="section-head"><h2 class="sm">Notes</h2></div><div class="notes-card">${esc(c.notes)}</div>` : ""}
      <div class="section-head"><h2 class="sm">Payments</h2><span style="color:var(--muted);font-size:14px">${ps.length ? plural(ps.length, "payment") : ""}</span></div>
      ${
        ps.length
          ? `<div class="list">${ps.map((p) => prow(p, { showClient: false })).join("")}</div>`
          : `<div class="empty"><b>No payments yet</b><button class="btn sm" data-action="add-payment" data-client="${c.id}">${ic("plus")} Add their first payment</button></div>`
      }`;
  }

  function viewMore() {
    const s = S.session;
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const theme = pref("theme", "system");
    return `
      ${topbar("Settings")}
      <div class="group-title">Account</div>
      <div class="group rise" style="--i:0">
        <button class="row" data-action="edit-name"><span class="ic">${ic("user")}</span><span class="l">${esc(s.name || "Add your name")}<small>${esc(s.email || "")}</small></span><span class="r">${ic("right")}</span></button>
        <button class="row" data-action="password"><span class="ic">${ic("key")}</span><span class="l">Change password</span><span class="r">${ic("right")}</span></button>
      </div>

      <div class="group-title">Appearance</div>
      <div class="group rise" style="--i:1">
        <div class="row stack"><span class="ic">${ic("moon")}</span><span class="l">Theme<small>System follows your iPhone's light/dark setting</small></span>
          <div class="seg small full" data-seg="theme" style="margin-top:6px">
            ${["system", "light", "dark"].map((t) => `<button class="${theme === t ? "on" : ""}" data-theme-set="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
          </div>
        </div>
      </div>

      <div class="group-title">Face ID</div>
      <div class="group rise" style="--i:2">
        ${
          s.hasPasskey
            ? `<div class="row"><span class="ic">${ic("faceid")}</span><span class="l">Face ID is on<small>Works on any device using your iCloud Keychain</small></span></div>
               <label class="row stack"><span class="ic">${ic("lock")}</span><span class="l">Ask for Face ID<small>Only when you come back to the app, never while you're using it</small></span>
                 <select class="pick" id="lockSel" style="flex:1 1 100%;margin-top:6px;height:42px">${LOCKS.map(
                   ([v, l]) => `<option value="${v}" ${Number(s.lockMinutes) === v ? "selected" : ""}>${l}</option>`
                 ).join("")}</select></label>
               <button class="row danger" data-action="faceid-remove"><span class="l">Turn off Face ID</span></button>`
            : `<button class="row" data-action="faceid-setup"><span class="ic">${ic("faceid")}</span><span class="l">Set up Face ID<small>${
                S.platformAuth ? "Unlock with a glance, sign back in without typing" : "Not available in this browser"
              }</small></span><span class="r">${ic("right")}</span></button>`
        }
      </div>

      <div class="group-title">Export</div>
      <div class="group rise" style="--i:3">
        <a class="row" href="${API}/export?type=payments"><span class="ic">${ic("download")}</span><span class="l">Payments CSV<small>Every payment, with status and paid date</small></span></a>
        <a class="row" href="${API}/export?type=clients"><span class="ic">${ic("download")}</span><span class="l">Clients CSV</span></a>
      </div>

      ${
        standalone
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
    ["more", "more", "Settings"],
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
    if (!t || !ind) return;
    $$(".tab[data-tab]").forEach((x) => x.classList.toggle("on", x === t));
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

  // mode: "fade" (tab change), "push"/"pop" (client profile), or undefined (data refresh, stay put)
  function render(mode) {
    if (!S.data) return;
    let first = false;
    if (!$("#view")) {
      renderShell();
      first = true;
    }
    const v = $("#view");
    const y = window.scrollY;
    const views = { month: viewMonth, calendar: viewCalendar, clients: viewClients, more: viewMore };
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
    // progress bar + lime tile shimmer + counters
    const fill = $(".progress .fill");
    const prevRecv = S.counts.recv ?? 0;
    requestAnimationFrame(() => {
      if (fill) fill.style.width = fill.dataset.pct + "%";
      const rt = $("#recvTile");
      if (rt && Number($("[data-count=recv]", rt)?.dataset.val) > prevRecv) rt.classList.add("shine");
      runCounts();
    });
    S.calAnim = "";
    S.heroAnim = "";
    if (!mode) window.scrollTo(0, y);
  }
  const rerender = () => render();

  // ---------- sheets: payments ----------
  function clientOptions(sel) {
    const cs = S.data.clients;
    const act = cs.filter((c) => c.status === "active");
    const rest = cs.filter((c) => c.status !== "active");
    const o = (c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? "selected" : ""}>${esc(c.name)}</option>`;
    return `<option value="" ${sel ? "" : "selected"} disabled>Choose a client</option>${act.map(o).join("")}${
      rest.length ? `<optgroup label="Paused or finished">${rest.map(o).join("")}</optgroup>` : ""
    }`;
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
      f = {
        client_id: c?.id || "",
        package: c?.package || "coaching",
        programme_weeks: c?.programme_weeks || null,
        amount_pence: c ? c.price_pence : null,
        method: c?.method || "manual",
        due_date: preset.due_date || today,
        paid_date: null,
        notes: "",
      };
    }
    const sch = isEdit && p.schedule_id ? S.smap.get(p.schedule_id) : null;
    const st = isEdit ? stOf(p) : null;
    const html = `
      <form class="form" id="payForm" novalidate>
        <div class="field"><label for="p-client">Client</label><select id="p-client">${clientOptions(f.client_id)}</select></div>
        <div class="field"><span class="lab">Package</span>${opts("package", PKG, f.package)}</div>
        <div class="field" id="p-weeks-f" ${f.package === "programme" ? "" : "hidden"}><span class="lab">Programme length</span>${opts("weeks", WEEK_OPTS, f.programme_weeks)}</div>
        <div class="two">
          <div class="field"><label for="p-amt">Amount</label><div class="money"><span>£</span><input id="p-amt" inputmode="decimal" autocomplete="off" value="${moneyInput(f.amount_pence)}" placeholder="0"></div></div>
          <div class="field"><label for="p-due">Due date</label><input id="p-due" type="date" value="${f.due_date}"></div>
        </div>
        <div class="field"><span class="lab">Payment method</span>${opts("method", METH, f.method)}</div>
        ${
          !isEdit
            ? `<label class="switch-row"><span class="l">Repeat monthly<small id="p-rep-hint">Adds a new payment on the same date each month until you stop it</small></span><span class="switch"><input type="checkbox" id="p-repeat"><i></i></span></label>`
            : sch
            ? `<div class="subcard"><h4>${sch.active ? `Repeats monthly on the ${ordinal(sch.day_of_month)}` : "Monthly repeat stopped"}</h4>${
                sch.active
                  ? `<div class="hint" style="padding:0">Changes here only affect this one payment.</div><div class="btn-row"><button type="button" class="btn sm ghost" data-sched-edit="${sch.id}" style="width:100%">Edit repeat</button><button type="button" class="btn sm danger" id="p-sched-stop" style="width:100%">Stop repeating</button></div>`
                  : ""
              }</div>`
            : ""
        }
        ${
          isEdit
            ? `<div class="status-card ${st}"><div class="l"><b>${STL[st]}</b><small>${
                st === "paid" ? `Received ${fmtLong(p.paid_date)}` : st === "overdue" ? `${daysBetween(p.due_date, today)} days past due` : `Due ${fmtLong(p.due_date)}`
              }</small></div><span class="switch"><input type="checkbox" id="p-paid" ${p.paid_date ? "checked" : ""} aria-label="Paid"><i></i></span></div>
               <div class="field" id="p-paid-f" ${p.paid_date ? "" : "hidden"}><label for="p-paiddate">Date received</label><input id="p-paiddate" type="date" value="${p.paid_date || today}"></div>`
            : ""
        }
        <div class="field"><label for="p-notes">Notes <span>optional</span></label><textarea id="p-notes" rows="2">${esc(f.notes)}</textarea></div>
        <div class="form-err" id="p-err"></div>
        <button class="btn lime" type="submit">${isEdit ? "Save changes" : "Add payment"}</button>
        ${isEdit ? `<button class="btn danger" type="button" id="p-del">Delete this payment</button>` : ""}
      </form>`;
    openSheet(isEdit ? `${cname(p)} · ${money(p.amount_pence)}` : "Add payment", html, (sh) => {
      const weeksF = $("#p-weeks-f", sh);
      $('[data-name="package"]', sh).addEventListener("change", (e) => {
        weeksF.hidden = e.currentTarget.dataset.value !== "programme";
      });
      if (!isEdit) {
        $("#p-client", sh).addEventListener("change", (e) => {
          const c = client(Number(e.target.value));
          if (!c) return;
          const set = (name, v) => {
            const g = $(`[data-name="${name}"]`, sh);
            g.dataset.value = v ?? "";
            $$(".opt", g).forEach((b) => b.classList.toggle("on", b.dataset.val === String(v)));
          };
          set("package", c.package);
          set("weeks", c.programme_weeks);
          set("method", c.method);
          weeksF.hidden = c.package !== "programme";
          $("#p-amt", sh).value = moneyInput(c.price_pence);
        });
        const hint = () => {
          const d = $("#p-due", sh).value;
          $("#p-rep-hint", sh).textContent = d
            ? `Adds a payment on the ${ordinal(Number(d.slice(8, 10)))} of every month until you stop it`
            : "Adds a new payment on the same date each month until you stop it";
        };
        $("#p-due", sh).addEventListener("change", hint);
        hint();
      } else {
        const paid = $("#p-paid", sh);
        paid.addEventListener("change", () => ($("#p-paid-f", sh).hidden = !paid.checked));
        $("#p-del", sh).onclick = async () => {
          if (!confirm(`Delete this ${money(p.amount_pence)} payment from ${cname(p)}? This can't be undone.`)) return;
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
        const ss = $("#p-sched-stop", sh);
        if (ss) ss.onclick = () => stopSchedule(sch);
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
        if (body.package === "programme" && !body.programme_weeks) return (err.textContent = "Pick the programme length.");
        if (isEdit) body.paid_date = $("#p-paid", sh).checked ? $("#p-paiddate", sh).value || today : null;
        else body.repeat = $("#p-repeat", sh).checked;
        if (!isEdit && body.repeat && client(body.client_id)?.status !== "active") {
          return (err.textContent = "Repeats only run for active clients. Set the client to Active first.");
        }
        const btn = $("button[type=submit]", sh);
        btn.disabled = true;
        try {
          const r = isEdit ? await api(`/payments/${p.id}`, { method: "PUT", body }) : await api("/payments", { method: "POST", body });
          setData(r.data);
          closeSheet();
          rerender();
          haptic();
          toast(isEdit ? "Saved" : body.repeat ? "Payment added, repeating monthly" : "Payment added");
        } catch (e2) {
          btn.disabled = false;
          if (!e2.silent) err.textContent = e2.message;
        }
      };
    });
  }

  function scheduleSheet(sch) {
    const c = client(sch.client_id);
    const days = Array.from({ length: 31 }, (_, i) => i + 1);
    const html = `
      <form class="form" id="schForm">
        <p class="hint">Monthly repeat for <b>${esc(c?.name || "")}</b>. Updates this and upcoming unpaid payments. Anything already paid stays exactly as it was.</p>
        <div class="field"><span class="lab">Package</span>${opts("package", PKG, sch.package)}</div>
        <div class="field" id="s-weeks-f" ${sch.package === "programme" ? "" : "hidden"}><span class="lab">Programme length</span>${opts("weeks", WEEK_OPTS, sch.programme_weeks)}</div>
        <div class="two">
          <div class="field"><label for="s-amt">Amount</label><div class="money"><span>£</span><input id="s-amt" inputmode="decimal" value="${moneyInput(sch.amount_pence)}"></div></div>
          <div class="field"><label for="s-day">Day of month</label><select id="s-day">${days
            .map((d) => `<option value="${d}" ${d === sch.day_of_month ? "selected" : ""}>${ordinal(d)}</option>`)
            .join("")}</select></div>
        </div>
        <p class="hint">In shorter months, days like the 31st fall on the last day of the month.</p>
        <div class="field"><span class="lab">Payment method</span>${opts("method", METH, sch.method)}</div>
        <div class="form-err" id="s-err"></div>
        <button class="btn lime" type="submit">Save repeat</button>
        <button class="btn danger" type="button" id="s-stop">Stop repeating</button>
      </form>`;
    openSheet("Monthly repeat", html, (sh) => {
      $('[data-name="package"]', sh).addEventListener("change", (e) => ($("#s-weeks-f", sh).hidden = e.currentTarget.dataset.value !== "programme"));
      $("#s-stop", sh).onclick = () => stopSchedule(sch);
      $("#schForm", sh).onsubmit = async (e) => {
        e.preventDefault();
        const body = {
          package: val(sh, "package"),
          programme_weeks: val(sh, "weeks") ? Number(val(sh, "weeks")) : null,
          amount_pence: parseMoney($("#s-amt", sh).value),
          day_of_month: Number($("#s-day", sh).value),
          method: val(sh, "method"),
        };
        if (body.amount_pence == null) return ($("#s-err", sh).textContent = "Enter a valid amount.");
        try {
          const r = await api(`/schedules/${sch.id}`, { method: "PUT", body });
          setData(r.data);
          closeSheet();
          rerender();
          toast("Repeat updated");
        } catch (e2) {
          if (!e2.silent) $("#s-err", sh).textContent = e2.message;
        }
      };
    });
  }

  async function stopSchedule(sch) {
    const c = client(sch.client_id);
    if (!confirm(`Stop the monthly repeat for ${c?.name || "this client"}? Upcoming unpaid repeats are removed. Anything already due stays on the books.`)) return;
    try {
      const r = await api(`/schedules/${sch.id}/stop`, { method: "POST" });
      setData(r.data);
      closeSheet();
      rerender();
      toast("Repeat stopped");
    } catch (e) {
      fail(e);
    }
  }

  async function quickPay(id) {
    const p = S.data.payments.find((x) => x.id === id);
    if (!p || p.paid_date) return;
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

  // ---------- sheets: clients ----------
  // Used for "Add client" and for "Edit details" from a profile. Title and button make the mode obvious.
  function clientSheet(c) {
    const isEdit = !!c;
    const f = c || { name: "", tenure: "new", package: "coaching", programme_weeks: null, price_pence: null, method: "manual", status: "active", notes: "" };
    const hasPayments = isEdit && clientPayments(c.id).length > 0;
    const hasRepeat = isEdit && S.data.schedules.some((s) => s.client_id === c.id && s.active);
    const html = `
      <form class="form" id="cForm" novalidate>
        <div class="field"><label for="c-name">Name</label><input id="c-name" value="${esc(f.name)}" autocomplete="off" autocapitalize="words" placeholder="Client name"></div>
        <div class="field"><span class="lab">Tenure</span>${opts("tenure", TEN, f.tenure)}</div>
        <div class="field"><span class="lab">Package</span>${opts("package", { pt: "PT only", coaching: "Full coaching", programme: "Programme only" }, f.package)}</div>
        <div class="field" id="c-weeks-f" ${f.package === "programme" ? "" : "hidden"}><span class="lab">Programme length</span>${opts("weeks", WEEK_OPTS, f.programme_weeks)}</div>
        <div class="field"><label for="c-price">Agreed price</label><div class="money"><span>£</span><input id="c-price" inputmode="decimal" value="${moneyInput(f.price_pence)}" placeholder="0"></div></div>
        <div class="field"><span class="lab">Usual payment method</span>${opts("method", METH, f.method)}</div>
        ${
          isEdit
            ? `<div class="field"><span class="lab">Client status</span>${opts("status", CST, f.status)}<p class="hint" id="c-status-hint" ${
                f.status === "active" ? "hidden" : ""
              }>Paused and finished clients don't get new monthly charges. Anything they already owe stays on the books.</p></div>`
            : `<div class="subcard">
                <h4>Next payment <span style="font-weight:400;color:var(--muted)">optional</span></h4>
                <div class="field"><label for="c-next">Due date</label><input id="c-next" type="date" value=""></div>
                <label class="switch-row"><span class="l">Repeat monthly<small>Same date every month until you stop it</small></span><span class="switch"><input type="checkbox" id="c-repeat" ${
                  f.package === "programme" ? "" : "checked"
                }><i></i></span></label>
                <p class="hint">Uses the package, price and method above. Leave the date blank to add payments later.</p>
              </div>`
        }
        <div class="field"><label for="c-notes">Notes <span>optional</span></label><textarea id="c-notes" rows="2" placeholder="Arrangements, reminders, anything useful">${esc(f.notes)}</textarea></div>
        ${isEdit ? `<p class="hint">Changing their package or price won't rewrite past payments.${hasRepeat ? " To change the monthly amount, tap their repeat on the profile." : ""}</p>` : ""}
        <div class="form-err" id="c-err"></div>
        <button class="btn lime" type="submit">${isEdit ? "Save changes" : "Add client"}</button>
        ${isEdit && !hasPayments ? `<button class="btn danger" type="button" id="c-del">Delete client</button>` : ""}
      </form>`;
    openSheet(isEdit ? "Edit client details" : "New client", html, (sh) => {
      const pkg = $('[data-name="package"]', sh);
      pkg.addEventListener("change", () => {
        $("#c-weeks-f", sh).hidden = pkg.dataset.value !== "programme";
        const rep = $("#c-repeat", sh);
        if (rep) rep.checked = pkg.dataset.value !== "programme";
      });
      const stat = $('[data-name="status"]', sh);
      if (stat) stat.addEventListener("change", () => ($("#c-status-hint", sh).hidden = stat.dataset.value === "active"));
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
          tenure: val(sh, "tenure"),
          package: val(sh, "package"),
          programme_weeks: val(sh, "weeks") ? Number(val(sh, "weeks")) : null,
          price_pence: parseMoney($("#c-price", sh).value),
          method: val(sh, "method"),
          status: isEdit ? val(sh, "status") : "active",
          notes: $("#c-notes", sh).value,
        };
        if (!body.name) return (err.textContent = "Add their name.");
        if (body.price_pence == null) return (err.textContent = "Enter the agreed price in pounds, e.g. 160.");
        if (body.package === "programme" && !body.programme_weeks) return (err.textContent = "Pick the programme length.");
        if (!isEdit) {
          const dup = S.data.clients.find((x) => x.name.trim().toLowerCase() === body.name.toLowerCase());
          if (dup && !confirm(`You already have a client called ${dup.name}. Add another one anyway?`)) return;
          const d = $("#c-next", sh).value;
          if (d) body.next = { due_date: d, repeat: $("#c-repeat", sh).checked };
        }
        if (isEdit && c.status === "active" && body.status !== "active" && hasRepeat) {
          if (!confirm(`Set ${body.name} to ${CST[body.status]}? Their monthly repeat pauses and upcoming unpaid repeats are removed. Anything already due stays.`)) return;
        }
        const btn = $("button[type=submit]", sh);
        btn.disabled = true;
        try {
          const r = isEdit ? await api(`/clients/${c.id}`, { method: "PUT", body }) : await api("/clients", { method: "POST", body });
          setData(r.data);
          closeSheet();
          haptic();
          if (!isEdit) {
            // take you straight to the new client's profile
            S.tab = "clients";
            S.clientId = r.id;
            render("push");
            window.scrollTo(0, 0);
          } else rerender();
          toast(isEdit ? "Changes saved" : body.next ? `${body.name} added with their next payment` : `${body.name} added`);
        } catch (e2) {
          btn.disabled = false;
          if (!e2.silent) err.textContent = e2.message;
        }
      };
    });
  }

  async function setClientStatus(c, to) {
    const hasRepeat = S.data.schedules.some((s) => s.client_id === c.id && s.active);
    if (to !== "active" && hasRepeat && !confirm(`Pause ${c.name}? Their monthly repeat stops for now and upcoming unpaid repeats are removed. Anything already due stays.`)) return;
    try {
      const body = { ...c, status: to };
      const r = await api(`/clients/${c.id}`, { method: "PUT", body });
      setData(r.data);
      haptic();
      rerender();
      toast(to === "active" ? `${c.name} is active again` : `${c.name} paused`);
    } catch (e) {
      fail(e);
    }
  }

  function addSheet() {
    openSheet(
      "Add",
      `<div class="action-list">
        <button class="action" data-action="add-payment"${S.tab === "clients" && S.clientId ? ` data-client="${S.clientId}"` : ""}${
        S.tab === "calendar" && S.calDay ? ` data-date="${S.calDay}"` : ""
      }><span class="ic">${ic("receipt")}</span><span><b>Add payment</b><small>One-off or repeating monthly</small></span></button>
        <button class="action" data-action="add-client"><span class="ic">${ic("userplus")}</span><span><b>Add client</b><small>With their next payment if you like</small></span></button>
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

  document.addEventListener("click", (e) => {
    if (S.suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const t = e.target.closest(
      "[data-tab],[data-action],[data-month],[data-scope],[data-pay],[data-open-pay],[data-open-client],[data-day],[data-cal],[data-calmode],[data-listmode],[data-cstatus],[data-sched-edit],[data-theme-set]"
    );
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.pay) {
      e.stopPropagation();
      haptic();
      const r = t.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2);
      return quickPay(Number(d.pay));
    }
    if (d.tab) return goTab(d.tab);
    if (d.schedEdit) {
      const s = S.smap.get(Number(d.schedEdit));
      if (s) scheduleSheet(s);
      return;
    }
    if (d.themeSet) {
      setTheme(d.themeSet);
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
        case "client-status": {
          const c = client(Number(d.client));
          return c && setClientStatus(c, d.to);
        }
        case "back":
          S.clientId = null;
          render("pop");
          return;
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
      if (!d.month) return;
      const dir = d.month > S.month ? 1 : -1;
      if (d.month === S.month) return;
      S.month = d.month;
      S.heroAnim = dir > 0 ? "from-right" : "from-left";
      return rerender();
    }
    if (d.scope) {
      S.scope = d.scope;
      if (d.status) S.fStatus = d.status;
      rerender();
      if (t.classList.contains("tile") || t.classList.contains("banner")) {
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
  }, true);

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".prow[data-open-pay]")) {
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
  });

  // ---------- touch: swipe-to-pay, month swipes, pull to refresh, edge-swipe back ----------
  let T = null;
  document.addEventListener(
    "touchstart",
    (e) => {
      if (sheet || !S.data || S.locked || e.touches.length > 1) return;
      const t = e.touches[0];
      const tgt = e.target;
      T = {
        x0: t.clientX,
        y0: t.clientY,
        dx: 0,
        dy: 0,
        mode: null,
        row: tgt.closest(".swipe > .prow") && tgt.closest(".swipe").querySelector(".swipe-bg") ? tgt.closest(".swipe > .prow") : null,
        pan: tgt.closest("#hero, #calCard"),
        edge: t.clientX < 28 && S.tab === "clients" && S.clientId,
        top: window.scrollY <= 0,
        noPull: !!tgt.closest(".strip, .table-wrap, .tabbar"),
      };
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
        const d = Math.min(0, T.dx);
        const eased = d < -110 ? -110 + (d + 110) * 0.35 : d;
        const bg = T.row.previousElementSibling;
        T.row.classList.add("dragging");
        T.row.classList.remove("snap");
        T.row.style.transform = `translateX(${eased}px)`;
        bg.style.opacity = Math.min(1, -d / 50);
        const armed = d < -90;
        if (armed !== T.armed) {
          T.armed = armed;
          bg.classList.toggle("armed", armed);
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
      s.row.classList.remove("dragging");
      s.row.classList.add("snap");
      const bg = s.row.previousElementSibling;
      if (s.armed) {
        s.row.style.transform = "translateX(-110%)";
        const r = bg.getBoundingClientRect();
        burst(r.right - 40, r.top + r.height / 2);
        setTimeout(() => quickPay(Number(s.row.dataset.openPay)), 200);
      } else {
        s.row.style.transform = "";
        bg.style.opacity = 0;
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
        S.clientId = null;
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
    } catch (e) {
      if (e.silent) return;
      root().innerHTML = `<div class="lock-screen"><div class="coin-logo big">£</div><h1>Can't connect</h1><p>${esc(e.message)}</p><button class="btn lime" id="retry">Try again</button></div>`;
      $("#retry").onclick = boot;
    }
  }

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
