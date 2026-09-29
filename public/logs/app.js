/* TrueStay Logs: clients' food and step screenshots, sorted by client and day, into one PDF each.
   Vanilla JS. Talks to /api/pay/logs/* with the same sign-in as TrueStay Pay. */
(() => {
  "use strict";

  const API = "/api/pay";
  const MAX_UPLOAD_W = 1000; // app uploads are re-encoded to this width (screenshots stay sharp, storage stays small)
  const PDF_IMG_W = 700;

  // ---------- tiny utils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, w, ws) => `${n} ${n === 1 ? w : ws || w + "s"}`;
  const pref = (k, d) => {
    try {
      return localStorage.getItem("tsl." + k) ?? d;
    } catch {
      return d;
    }
  };
  const setPref = (k, v) => {
    try {
      localStorage.setItem("tsl." + k, v);
    } catch {}
  };
  const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";
  const initials = (n) =>
    String(n || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase() || "?";
  const fmtN = (v) => (v == null ? "" : Math.round(v).toLocaleString("en-GB"));
  const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  // ---------- dates (UK) ----------
  const UKF = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function ukParts(t) {
    const p = Object.fromEntries(UKF.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute, hour: +p.hour % 24 };
  }
  const todayUK = () => ukParts(Date.now() / 1000).date;
  const addDays = (s, n) => {
    const d = new Date(s + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const validISO = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + "T12:00:00Z");
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WD_LONG = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dObj = (iso) => new Date(iso + "T12:00:00Z");
  const dayLabel = (iso) => {
    const d = dObj(iso);
    return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  };
  function rangeShort(a, b) {
    if (!a) return "";
    if (!b || a === b) return dayLabel(a);
    const A = dObj(a);
    const B = dObj(b);
    if (A.getUTCMonth() === B.getUTCMonth() && A.getUTCFullYear() === B.getUTCFullYear()) return `${WD[A.getUTCDay()]} ${A.getUTCDate()} to ${dayLabel(b)}`;
    return `${dayLabel(a)} to ${dayLabel(b)}`;
  }
  const daysBetween = (a, b) => Math.round((dObj(b) - dObj(a)) / 86400000);

  // ---------- icons ----------
  const P = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9.5"/>',
    info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5V8"/>',
    share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="3"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6"/>',
    cal: '<rect x="3" y="4.5" width="18" height="17" rx="4"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    inbox: '<path d="M22 13h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 13v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    move: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    more: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.5 11.5 9-9M17 6l3 3M14.5 8.5l2 2"/>',
    out: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    faceid:
      '<path d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2"/><path d="M8.5 9v1.5M15.5 9v1.5M12 9v4.5h-1"/><path d="M8.8 16.3c1.9 1.4 4.5 1.4 6.4 0"/>',
  };
  const ic = (n) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
  const LOGO =
    '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="17" y="5" width="21" height="31" rx="5" fill="#76862C"/><rect x="10" y="11" width="21" height="31" rx="5" fill="#D7F54A"/>' +
    '<path d="M15 18h9M15 22.5h11M15 27h7" stroke="#1B1C19" stroke-width="2.4" stroke-linecap="round"/><path d="m15 34 3 3 6-6" fill="none" stroke="#1B1C19" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const KIND = { food: "Food", steps: "Steps", food_steps: "Food and steps", weight: "Weight", other: "Other" };
  const SRC = {
    manual: "Day set by you",
    screen: "Day from the date on the screenshot",
    sent: "Day from when it was sent",
    sentday: "Day from the date it was sent",
    photo: "Day from the photo's date. Worth a check",
    shared: "Day from when you shared it. Worth a check",
  };
  const GUESSY = new Set(["photo", "shared"]);

  // ---------- state ----------
  const S = {
    session: null,
    data: null,
    eff: new Map(),
    view: "home",
    clientId: null, // number, or "later" for the sort pile
    sel: null, // Set of item ids while selecting
    up: null, // upload progress
    reading: new Set(),
    sig: "",
    locked: false,
    lastSync: 0,
  };
  const root = () => $("#root");

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

  // ---------- Face ID (passkeys shared with Pay) ----------
  const b64u = {
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
  async function passkeyAuth() {
    const o = await api("/webauthn/auth/options", { method: "POST", raw: true });
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64u.dec(o.challenge),
        rpId: o.rpId,
        userVerification: "required",
        timeout: 60000,
        allowCredentials: (o.allow || []).map((id) => ({ type: "public-key", id: b64u.dec(id) })),
      },
    });
    const r = cred.response;
    return api("/webauthn/auth", {
      method: "POST",
      raw: true,
      body: {
        challengeId: o.challengeId,
        id: b64u.enc(cred.rawId),
        clientDataJSON: b64u.enc(r.clientDataJSON),
        authenticatorData: b64u.enc(r.authenticatorData),
        signature: b64u.enc(r.signature),
      },
    });
  }
  const isCancel = (e) => e && (e.name === "NotAllowedError" || e.name === "AbortError");
  const webauthnError = (e) => (isCancel(e) ? "Face ID was cancelled." : e?.message || "Face ID didn't work.");

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, actions = []) {
    const t = $("#toast");
    t.innerHTML = `<div class="toast-inner"><span class="msg">${esc(msg)}</span>${actions.map((a, i) => `<button data-t="${i}">${esc(a.label)}</button>`).join("")}</div>`;
    actions.forEach((a, i) => {
      $(`[data-t="${i}"]`, t).onclick = () => {
        hideToast();
        a.fn();
      };
    });
    t.classList.toggle("high", !!S.sel);
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
    sh.setAttribute("aria-label", title);
    sh.innerHTML = `<div class="grab"></div><div class="sheet-head"><h3>${esc(title)}</h3><button class="round" data-close aria-label="Close">${ic("x")}</button></div><div class="sheet-body">${html}</div>`;
    $("#sheet-root").append(bd, sh);
    bd.onclick = () => closeSheet();
    sheet = { bd, sh };
    requestAnimationFrame(() => {
      bd.classList.add("show");
      sh.classList.add("show");
    });
    if (onMount) onMount(sh);
    return sh;
  }
  function closeSheet(instant) {
    if (!sheet) return;
    const { bd, sh } = sheet;
    sheet = null;
    if (sh.onclose) sh.onclose();
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
    }, 420);
  }

  // ---------- which day a screenshot belongs to ----------
  // Worked out in reconcile.js (shared with the tests): set by you > a date printed on the screenshot > when it was
  // sent (from the file name or the photo) > when you shared it (only for small, nightly shares).
  const sessionSizes = (items) => window.TSReconcile.sessionSizes(items);
  const effDay = (it, sizes) => window.TSReconcile.effDay(it, sizes);

  function parseReadings(items) {
    for (const it of items) {
      if (it.rj !== undefined && !it._rp) {
        try {
          it.r = it.rj ? JSON.parse(it.rj) : null;
        } catch {
          it.r = null;
        }
        it._rp = true;
      }
    }
  }
  function recompute() {
    parseReadings(S.data.items);
    const sizes = sessionSizes(S.data.items);
    const safe = (it) => {
      try {
        return effDay(it, sizes);
      } catch {
        return { day: it.day_src === "manual" ? it.day : null, src: it.day_src === "manual" ? "manual" : null, t: it.received_at, clockMin: null, lag: null };
      }
    };
    S.eff = new Map(S.data.items.map((it) => [it.id, safe(it)]));
    S.recCache = new Map();
  }

  // ---------- grouping ----------
  const openItems = () => S.data.items.filter((i) => !i.filed_at);
  const clientOf = (id) => S.data.clients.find((c) => c.id === id) || null;
  const nameOf = (id) => {
    if (id === "later") return "To sort";
    const c = clientOf(id);
    if (c) return c.name;
    const it = S.data.items.find((i) => i.client_id === id);
    return it?.client_name || "Client";
  };
  const itemsFor = (cid, filed = false) =>
    S.data.items.filter((i) => (filed ? !!i.filed_at : !i.filed_at) && (cid === "later" ? i.client_id == null : i.client_id === cid));
  // A day's numbers come from TSReconcile (reconcile.js): the app's own day total when one was sent, else the
  // meals added up, with a confidence and plain-words notes. The averages only use days it trusts.
  const R = window.TSReconcile;
  function refFor(cid) {
    if (cid == null || cid === "later") return null;
    const key = "ref:" + cid;
    if (!S.recCache.has(key)) S.recCache.set(key, R.refKcal(S.data.items.filter((i) => i.client_id === cid), targetsFor(cid)));
    return S.recCache.get(key);
  }
  const verdictsFor = (cid) => (cid != null && cid !== "later" && S.data.days && S.data.days[cid]) || {};
  function totalsOf(rec) {
    return { kcal: rec.food.kcal, protein: rec.food.protein, carbs: rec.food.carbs, fat: rec.food.fat, steps: rec.steps.value, extras: rec.extras };
  }
  function byDay(items) {
    const m = new Map();
    const undated = [];
    for (const it of items) {
      const d = S.eff.get(it.id)?.day;
      if (!d) undated.push(it);
      else {
        if (!m.has(d)) m.set(d, []);
        m.get(d).push(it);
      }
    }
    const cid = items.length ? items[0].client_id : null;
    const ref = refFor(cid);
    const verdicts = verdictsFor(cid);
    const days = [...m.keys()].sort().map((day) => {
      const list = m.get(day).sort((a, b) => kindOrder(a) - kindOrder(b) || a.received_at - b.received_at || a.id - b.id);
      const withCap = list.map((it) => {
        const e = S.eff.get(it.id) || {};
        return { ...it, t: e.t, clockMin: e.clockMin, lag: e.lag };
      });
      const rec = R.reconcileDay(day, withCap, { refKcal: ref, verdict: verdicts[day] });
      return { day, items: list, rec, totals: totalsOf(rec) };
    });
    return { days, undated };
  }
  const kindOrder = (it) => ({ food: 0, food_steps: 1, steps: 2, weight: 3, other: 4 })[it.kind] ?? 5;
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const targetsFor = (cid) => (cid && cid !== "later" && S.data.targets[cid]) || {};
  const hit = {
    kcal: (v, t) => t && v != null && Math.abs(v - t) <= t * 0.1,
    protein: (v, t) => t && v != null && v >= t,
    steps: (v, t) => t && v != null && v >= t,
  };

  // ---------- rendering ----------
  function greeting() {
    const h = ukParts(Date.now() / 1000).hour;
    return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  }
  function render(anim = "fade") {
    if (!S.data) return;
    const scroll = window.scrollY;
    const html = S.view === "settings" ? viewSettings() : S.view === "client" ? viewClient() : viewHome();
    root().innerHTML = `<div class="view ${anim} enter${S.sel ? " has-bar" : ""}">${html}</div>${S.sel ? selBar() : ""}`;
    if (!anim) window.scrollTo(0, scroll);
    S.sig = signature();
  }
  const rerender = () => render("");
  function signature() {
    return JSON.stringify([S.view, S.clientId, S.sel ? [...S.sel] : 0, S.up && [S.up.done, S.up.total], S.data.key ? 1 : 0, S.data.items.map((i) => [i.id, i.status, i.client_id, i.day, i.kind, i.kcal, i.protein, i.carbs, i.fat, i.steps, i.filed_at]), S.data.targets]);
  }

  const imgUrl = (it) => `${API}/logs/img/${it.id}?v=${encodeURIComponent(it.v || it.id)}`;
  const TAGK = { food: "Food", steps: "Steps", food_steps: "Food, steps", weight: "Weight", other: "Other" };
  // what a screenshot is, in a word or two (the new reader knows a day's total from one meal)
  function shotWhat(it, rec) {
    const r = it.r;
    if (!r || !(r.v >= 2)) return null;
    if (rec && rec.demoted.includes(it.id)) return "A meal";
    if (r.screen === "day_summary") return "Day total";
    if (r.screen === "meal") {
      const m = (r.meals || [])[0];
      return m && m.name ? m.name.replace(/^./, (c) => c.toUpperCase()) : "A meal";
    }
    if (r.screen === "diary_part") return "Meals";
    if (r.screen === "food_item") return "One food";
    if (r.screen === "period_summary") return "Week";
    return null;
  }
  const thumbTag = (it, rec) => {
    if (it.status === "new") return `<span class="tag">Reading…</span>`;
    if (it.status === "failed") return `<span class="tag red">Not read</span>`;
    const what = shotWhat(it, rec);
    if (what && (it.kind === "food" || it.kind === "food_steps")) return `<span class="tag"><small>${esc(what)}</small>${it.kcal != null ? fmtN(it.kcal) + " kcal" : "no total"}</span>`;
    if (what) return `<span class="tag">${esc(what)}</span>`;
    const k = TAGK[it.kind] || "Picture";
    if ((it.kind === "food" || it.kind === "food_steps") && it.kcal != null) return `<span class="tag"><small>${k}</small>${fmtN(it.kcal)} kcal</span>`;
    if (it.kind === "steps" && it.steps != null) return `<span class="tag"><small>${k}</small>${fmtN(it.steps)}</span>`;
    return `<span class="tag">${k}</span>`;
  };
  function thumb(it, rec) {
    const sel = S.sel && S.sel.has(it.id);
    const reading = it.status === "new" || S.reading.has(it.id);
    const label = `${KIND[it.kind] || "Screenshot"}${S.eff.get(it.id)?.day ? ", " + dayLabel(S.eff.get(it.id).day) : ""}`;
    return `<button class="thumb${sel ? " sel" : ""}" data-item="${it.id}" aria-label="${esc(label)}"${S.sel ? ` aria-pressed="${sel}"` : ""}>
      <img src="${imgUrl(it)}" loading="lazy" decoding="async" alt="">
      ${thumbTag(it, rec)}${reading ? `<span class="state"><i></i></span>` : ""}${S.sel ? `<span class="check">${ic("check")}</span>` : ""}
    </button>`;
  }
  // A day's numbers. Anything the averages leave out gets a "?" and the reason underneath, in words.
  function numsLine(d, tg) {
    const rec = d.rec;
    const f = rec.food;
    const inc = rec.include;
    const parts = [];
    const mark = (k, v) => (inc[k] && hit[k] && hit[k](v, tg[k]) ? ` <span class="tgt-hit" aria-label="on target">✓</span>` : "");
    const q = (k) => (inc[k] ? "" : ` <span class="q" aria-label="left out of the averages">?</span>`);
    const cls = (k) => (inc[k] ? "" : ' class="out"');
    if (f.kcal != null) parts.push(`<span${cls("kcal")}><b class="num">${fmtN(f.kcal)}</b> kcal${mark("kcal", f.kcal)}${q("kcal")}</span>`);
    const plus = f.floor ? "+" : "";
    if (f.protein != null) parts.push(`<span${cls("protein")}>P <b class="num">${fmtN(f.protein)}${plus}</b> g${mark("protein", f.protein)}${q("protein")}</span>`);
    if (f.carbs != null) parts.push(`<span${cls("carbs")}>C <b class="num">${fmtN(f.carbs)}${plus}</b> g</span>`);
    if (f.fat != null) parts.push(`<span${cls("fat")}>F <b class="num">${fmtN(f.fat)}${plus}</b> g</span>`);
    const st = rec.steps;
    if (st.value != null) parts.push(`<span${cls("steps")}>${st.approx ? "about " : ""}<b class="num">${fmtN(st.value)}</b> steps${mark("steps", st.value)}${q("steps")}</span>`);
    for (const e of (rec.extras || []).slice(0, 3)) parts.push(`<span>${esc(e.label)} <b>${esc(e.value)}</b></span>`);
    return parts.length ? `<div class="nums">${parts.join("")}</div>` : `<div class="nums"><span class="none">No numbers read yet</span></div>`;
  }
  // How the day was put together, what's wrong with it, and Shan's say on whether it counts.
  function dayStatus(d, cid) {
    const rec = d.rec;
    if (cid === "later" || cid == null) return "";
    const lines = [];
    for (const n of rec.notes) lines.push(`<li class="${rec.flagged ? "warn" : ""}">${ic(rec.flagged ? "alert" : "info")}<span>${esc(n)}</span></li>`);
    if (rec.steps.note && rec.steps.conf === "low") lines.push(`<li class="warn">${ic("alert")}<span>Steps: ${esc(rec.steps.note)}</span></li>`);
    for (const n of rec.info) lines.push(`<li class="muted">${ic("info")}<span>${esc(n)}</span></li>`);
    let chip = "";
    let act = "";
    if (rec.verdict === "count") {
      chip = `<span class="flag ok">Counted by you</span>`;
      act = `<button class="linkish" data-verdict="" data-day="${d.day}">Undo</button>`;
    } else if (rec.verdict === "omit") {
      chip = `<span class="flag">Left out by you</span>`;
      act = `<button class="linkish" data-verdict="" data-day="${d.day}">Undo</button>`;
    } else if (rec.flagged) {
      chip = `<span class="flag">${esc(rec.leftOut || "Left out of the averages")}</span>`;
      if (rec.food.src !== "old" && rec.canCount) act = `<button class="linkish" data-verdict="count" data-day="${d.day}">Count it anyway</button>`;
    } else if (rec.food.src === "meals") chip = `<span class="flag ok">Added up from meals</span>`;
    else if (rec.food.src === "typed") chip = `<span class="flag ok">Typed by you</span>`;
    if (!act && !rec.verdict && !rec.flagged && rec.food.kcal != null && (rec.notes.length || rec.food.src === "meals")) act = `<button class="linkish" data-verdict="omit" data-day="${d.day}">Leave it out</button>`;
    if (!chip && !lines.length) return "";
    return `<div class="daystat">${chip || act ? `<div class="ds-top">${chip}${act}</div>` : ""}${lines.length ? `<ul class="day-notes">${lines.join("")}</ul>` : ""}</div>`;
  }
  function uploadBanner() {
    if (!S.up) return "";
    const u = S.up;
    const pct = u.total ? Math.round((u.done / u.total) * 100) : 0;
    return `<div class="banner" id="upBanner"><span class="spin"></span><div class="bar"><div style="margin-bottom:6px">Adding <b class="num" id="upDone">${u.done}</b> of ${u.total}${u.clientName ? ` for ${esc(firstName(u.clientName))}` : ""}</div><div class="progress"><i id="upBar" style="width:${pct}%"></i></div></div></div>`;
  }
  function readingBanner(items) {
    const paused = items.filter((i) => limitPaused(i) && (i.status === "new" || needsRereadAny(i))).length;
    if (paused || S.limitHit)
      return `<div class="banner warn">${ic("alert")}<div>Reading is paused: today's free reading allowance is used up. It carries on by itself after 1am${paused ? ` (${plural(paused, "screenshot")} to go)` : ""}.</div></div>`;
    const n = items.filter((i) => i.status === "new").length;
    const old = items.filter((i) => needsReread(i)).length;
    if (n) return `<div class="banner"><span class="spin"></span><div>Reading ${plural(n, "screenshot")}. You can carry on.</div></div>`;
    if (old) return `<div class="banner"><span class="spin"></span><div>Checking ${plural(old, "screenshot")} again with the new reader. Days marked "being read again" update as it goes.</div></div>`;
    return "";
  }
  const needsRereadAny = (i) => i.status === "read" && (i.rv || 1) < (S.data.reader || 1) && !i.filed_at;

  function viewHome() {
    const open = openItems();
    const later = open.filter((i) => i.client_id == null);
    const ids = [...new Set(open.filter((i) => i.client_id != null).map((i) => i.client_id))];
    const rows = ids
      .map((id) => ({ id, items: open.filter((i) => i.client_id === id), last: Math.max(...open.filter((i) => i.client_id === id).map((i) => i.received_at)) }))
      .sort((a, b) => b.last - a.last);
    const name = firstName(S.session?.name);
    const doneRecently = S.data.items.filter((i) => i.filed_at).length;
    return `
      <div class="topbar">
        <div class="title"><div class="logo-mark">${LOGO}</div><span>Logs</span></div>
        <div class="actions"><button class="round" data-action="settings" aria-label="Settings">${ic("more")}</button></div>
      </div>
      <h1 class="hello">${greeting()}${name ? `, ${esc(name)}` : ""}. <em>Here's what's come in.</em></h1>
      <button class="btn lime" data-action="add">${ic("plus")} Add screenshots</button>
      ${uploadBanner()}
      ${readingBanner(open)}
      ${
        !S.data.key
          ? `<button class="setup-card" data-action="setup"><span class="ico">${ic("share")}</span><span><span class="t">Set up the WhatsApp share button</span><span class="d" style="display:block">Send screenshots straight from a chat. A couple of minutes, once.</span></span><span class="chev">${ic("right")}</span></button>`
          : ""
      }
      ${
        later.length
          ? `<button class="setup-card" data-client="later"><span class="ico">${ic("inbox")}</span><span><span class="t">${plural(later.length, "screenshot")} to sort</span><span class="d" style="display:block">Pick which client they belong to.</span></span><span class="chev">${ic("right")}</span></button>`
          : ""
      }
      <div class="section-head"><h2>Waiting for a PDF</h2>${rows.length ? `<span>${plural(rows.length, "client")}</span>` : ""}</div>
      ${
        rows.length
          ? rows.map((r, i) => clientRow(r.id, r.items, i)).join("")
          : `<div class="empty"><b>Nothing waiting</b><span>Share screenshots from WhatsApp, or tap Add screenshots to pick them from Photos.</span></div>`
      }
      ${doneRecently ? `<p class="hint" style="margin-top:14px">${plural(doneRecently, "screenshot")} already in PDFs, kept for ${S.data.keep.filedDays} days in case you need them again. Open a client to see them.</p>` : ""}
    `;
  }
  function clientRow(id, items, i) {
    const { days, undated } = byDay(items);
    const reading = items.filter((x) => x.status === "new").length;
    const failed = items.filter((x) => x.status === "failed").length;
    const range = days.length ? rangeShort(days[0].day, days[days.length - 1].day) : "";
    const flags = [];
    if (undated.length) flags.push(`<span class="flag">${plural(undated.length, "needs a day", "need a day")}</span>`);
    if (failed) flags.push(`<span class="flag red">${failed} couldn't be read</span>`);
    if (reading) flags.push(`<span class="flag ok">${reading} reading</span>`);
    return `<button class="crow rise" style="--i:${i}" data-client="${id}">
      <span class="av">${esc(initials(nameOf(id)))}</span>
      <span class="main"><span class="name">${esc(nameOf(id))}</span>
        <span class="meta" style="display:block">${plural(items.length, "screenshot")}${range ? ` · ${range}` : ""}</span>
        ${flags.length ? `<span class="flags">${flags.join("")}</span>` : ""}</span>
      <span class="right"><b class="num">${days.length}</b>${days.length === 1 ? "day" : "days"}</span>
      <span class="chev">${ic("right")}</span>
    </button>`;
  }

  function viewClient() {
    const cid = S.clientId;
    const isLater = cid === "later";
    const items = itemsFor(cid);
    const { days, undated } = byDay(items);
    const tg = targetsFor(cid);
    const done = itemsFor(cid, true);
    const top = `
      <div class="topbar">
        <button class="back" data-action="home">${ic("left")} Logs</button>
        <div class="actions">
          ${items.length ? `<button class="round${S.sel ? " on" : ""}" data-action="select" aria-label="${S.sel ? "Stop selecting" : "Select screenshots"}" aria-pressed="${!!S.sel}">${ic("check")}</button>` : ""}
          ${isLater ? "" : `<button class="round" data-action="targets" aria-label="Targets">${ic("target")}</button>`}
          <button class="round lime" data-action="add-here" aria-label="Add screenshots for ${esc(nameOf(cid))}">${ic("plus")}</button>
        </div>
      </div>
      <h1 class="hello" style="margin-bottom:14px">${esc(nameOf(cid))}</h1>`;
    if (!items.length) {
      return `${top}${uploadBanner()}
        <div class="empty"><b>${isLater ? "All sorted" : "Nothing waiting"}</b><span>${isLater ? "Everything has a client." : `New screenshots for ${esc(firstName(nameOf(cid)))} will show up here.`}</span></div>
        ${doneBlock(cid, done)}`;
    }
    // averages only over the days the checks trust (or you counted); the rest are listed as left out
    const sum = R.summarize(days.map((d) => d.rec));
    const stat = (label, k, unit) => {
      const a = sum[k].avg;
      const n = sum[k].n;
      const left = sum[k].left.length;
      const val = (d) => (k === "steps" ? d.rec.steps.value : d.rec.food[k]);
      const hits = tg[k] ? days.filter((d) => d.rec.include[k] && hit[k](val(d), tg[k])).length : null;
      const out = left ? `<small class="warn">${left} left out</small>` : "";
      const sub = tg[k]
        ? `<small>Target ${fmtN(tg[k])}${unit}</small><small>Hit ${hits} of ${n}</small>${out}`
        : `<small>${a == null ? (left ? "No days to trust yet" : "Not read yet") : `Avg of ${plural(n, "day")}`}</small>${out}`;
      return `<div>${label}<b class="num">${a == null ? "–" : fmtN(a) + unit}</b>${sub}</div>`;
    };
    const range = days.length ? rangeShort(days[0].day, days[days.length - 1].day) : "No days yet";
    return `${top}
      ${
        isLater
          ? `<p class="hint" style="margin-bottom:12px">Tap the tick button, pick screenshots, then choose the client they belong to.</p>`
          : !days.length
          ? `<section class="hero rise" style="--i:0">
              <div class="k">Waiting for a PDF</div>
              <div class="big">Days to set</div>
              <div class="sub">${plural(items.length, "screenshot")}, none with a day yet. Set the days below and the totals show here.</div>
            </section>
            <div class="actions-row rise" style="--i:1">
              <button class="btn lime" data-action="pdf">${ic("doc")} Make PDF</button>
              <button class="btn ghost sm" data-action="add-here" aria-label="Add screenshots">${ic("plus")} Add</button>
            </div>`
          : `<section class="hero rise" style="--i:0">
              <div class="k">Waiting for a PDF</div>
              <div class="big">${esc(range)}</div>
              <div class="sub">${plural(items.length, "screenshot")} over ${plural(days.length, "day")}${undated.length ? `, ${undated.length} with no day yet` : ""}</div>
              <div class="stats">${stat("Calories", "kcal", "")}${stat("Protein", "protein", " g")}${stat("Steps", "steps", "")}</div>
            </section>
            <div class="actions-row rise" style="--i:1">
              <button class="btn lime" data-action="pdf">${ic("doc")} Make PDF</button>
              <button class="btn ghost sm" data-action="add-here" aria-label="Add screenshots">${ic("plus")} Add</button>
            </div>`
      }
      ${uploadBanner()}
      ${readingBanner(items)}
      ${
        undated.length
          ? `<section class="daycard warn rise" style="--i:2;margin-top:12px">
              <div class="dh"><b>${isLater ? "Screenshots" : "Needs a day"}</b><span class="src">${plural(undated.length, "screenshot")}</span></div>
              <p class="hint" style="padding:6px 0 12px">${
                isLater ? "" : "The date isn't on these and they came in as a batch. Tap one to set its day, or select several and set the day in one go."
              }</p>
              <div class="thumbs">${undated.map((it) => thumb(it)).join("")}</div>
            </section>`
          : ""
      }
      <div style="margin-top:12px">
      ${days
        .map((d, i) => {
          const srcs = [...new Set(d.items.map((it) => S.eff.get(it.id)?.src))];
          const guessy = srcs.some((s) => GUESSY.has(s));
          return `<section class="daycard rise${d.rec.flagged && !d.rec.verdict ? " flagged" : ""}" style="--i:${Math.min(i + 2, 8)}">
            <div class="dh"><b>${dayLabel(d.day)}</b><span class="src">${plural(d.items.length, "screenshot")}</span></div>
            ${guessy ? `<div class="flags"><span class="flag">Day guessed, worth a check</span></div>` : ""}
            ${numsLine(d, tg)}
            ${dayStatus(d, cid)}
            <div class="thumbs">${d.items.map((it) => thumb(it, d.rec)).join("")}</div>
          </section>`;
        })
        .join("")}
      </div>
      ${doneBlock(cid, done)}`;
  }
  function doneBlock(cid, done) {
    if (!done.length || cid === "later") return "";
    const { days } = byDay(done);
    const range = days.length ? rangeShort(days[0].day, days[days.length - 1].day) : "";
    return `<div class="section-head"><h2>Already in a PDF</h2></div>
      <div class="crow" style="cursor:default">
        <span class="av">${ic("doc")}</span>
        <span class="main"><span class="name">${plural(done.length, "screenshot")}</span><span class="meta" style="display:block">${range ? esc(range) + ". " : ""}Deleted ${S.data.keep.filedDays} days after the PDF.</span></span>
        <button class="btn ghost sm" data-action="unfile">Put back</button>
      </div>`;
  }

  function selBar() {
    const n = S.sel.size;
    const isLater = S.clientId === "later";
    return `<div class="selbar"><div class="selbar-inner">
      <div class="count">${n ? `${plural(n, "screenshot")} selected` : "Tap screenshots to select them"}</div>
      <div class="acts">
        <button data-action="sel-day" ${n ? "" : "disabled"}>${ic("cal")}Set day</button>
        <button data-action="sel-move" class="${isLater ? "lime" : ""}" ${n ? "" : "disabled"}>${ic("move")}${isLater ? "Client" : "Move"}</button>
        <button data-action="sel-delete" class="red" ${n ? "" : "disabled"}>${ic("trash")}Delete</button>
        <button data-action="select">${ic("x")}Done</button>
      </div>
    </div></div>`;
  }

  function viewSettings() {
    const theme = pref("theme", "system");
    const u = S.data.usage;
    return `
      <div class="topbar"><button class="back" data-action="home">${ic("left")} Logs</button><div class="title">Settings</div><div style="width:44px"></div></div>
      <div class="group-title">WhatsApp share button</div>
      <div class="group">
        ${
          S.data.key
            ? `<button class="row" data-action="setup"><span class="ic">${ic("share")}</span><span class="l">How to set it up<small>Step by step, with your two links</small></span><span class="r">${ic("right")}</span></button>
               <button class="row" data-action="newkey"><span class="ic">${ic("key")}</span><span class="l">Make new links<small>The old ones stop working, so you'd update the Shortcut</small></span><span class="r">${ic("right")}</span></button>`
            : `<button class="row" data-action="setup"><span class="ic">${ic("share")}</span><span class="l">Set it up<small>A couple of minutes on your iPhone, once</small></span><span class="r">${ic("right")}</span></button>`
        }
      </div>
      <div class="group-title">Look</div>
      <div class="group"><div class="row stack">
        <span class="ic">${ic("moon")}</span><span class="l">Appearance</span>
        <div class="seg" role="group" aria-label="Appearance">
          ${[["system", "Match iPhone"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => `<button data-theme-set="${k}" class="${theme === k ? "on" : ""}" aria-pressed="${theme === k}">${l}</button>`).join("")}
        </div>
      </div></div>
      <div class="group-title">Storage</div>
      <div class="group"><div class="row"><span class="ic">${ic("image")}</span><span class="l">${plural(u.count, "screenshot")} held, ${mb(u.stored || u.bytes)} of ${mb(u.limit || 524288000)}<small${
        u.limit && u.stored > u.limit * 0.7 ? ' class="warn" style="color:var(--amber-ink)"' : ""
      }>${u.limit && u.stored > u.limit * 0.7 ? "Getting full. Make PDFs and tap Done with these, so older ones get cleared. " : ""}Deleted ${S.data.keep.filedDays} days after they go in a PDF, and after ${S.data.keep.anyDays} days either way.</small></span></div></div>
      <div class="group-title">Account</div>
      <div class="group">
        <div class="row"><span class="ic">${ic("user")}</span><span class="l">${esc(S.session?.email || "")}<small>Same sign in as TrueStay Pay</small></span></div>
        <button class="row danger" data-action="logout"><span class="ic">${ic("out")}</span><span class="l">Sign out on this device</span></button>
      </div>`;
  }

  // ---------- item sheet ----------
  function openItem(id) {
    const it = S.data.items.find((i) => i.id === id);
    if (!it) return;
    const e = S.eff.get(id) || {};
    const reading = it.status === "new" || S.reading.has(id);
    let status;
    if (reading) status = `<div class="status-line">${ic("refresh")}<span>Reading it now. The numbers appear here when it's done.</span></div>`;
    else if (it.status === "failed")
      status = `<div class="status-line red">${ic("alert")}<span>Couldn't read this one. Try again, or type the numbers in.</span></div>`;
    else {
      const r = it.r || {};
      const newer = r.v >= 2;
      const what = !newer
        ? ""
        : r.screen === "day_summary"
        ? " as the day's total"
        : r.screen === "meal"
        ? ` as one meal${(r.meals || [])[0] && r.meals[0].name ? ` (${esc(r.meals[0].name)})` : ""}, not the day's total`
        : r.screen === "diary_part"
        ? ` as part of the diary (${esc((r.meals || []).filter((m) => m.logged !== false).map((m) => m.name || "a meal").join(", ") || "meals")}), not the day's total`
        : r.screen === "period_summary"
        ? " as a summary of several days, so it isn't used for any one day's numbers"
        : r.screen === "steps"
        ? " as steps"
        : "";
      const bits = [];
      bits.push(it.edited ? "Numbers edited by you." : `Read${it.app ? ` from ${esc(it.app)}` : ""}${what}.`);
      if (it.note) bits.push(esc(it.note));
      if (newer && r.fixes && r.fixes.length) bits.push(`Put right while reading: ${esc(r.fixes.slice(0, 2).join("; "))}.`);
      if (!newer && it.status === "read") bits.push("Read by the old reader; it's being read again.");
      status = `<div class="status-line">${ic("info")}<span>${bits.join(" ")}</span></div>`;
      if (newer && r.unsure && r.unsure.length)
        status += `<div class="status-line red">${ic("alert")}<span>Not sure of ${esc(r.unsure.map((f) => ({ kcal: "the calories", macros: "the macros", protein: "protein", carbs: "carbs", fat: "fat", steps: "steps" })[f] || "a number").join(" or "))}: the goal and what was eaten may be mixed up. Check the picture and type the right number.</span></div>`;
      if (limitPaused(it)) status += `<div class="status-line">${ic("info")}<span>${esc(it.read_error)}</span></div>`;
    }
    const v = (k) => (it[k] == null ? "" : it[k]);
    const clients = S.data.clients.filter((c) => !c.finished || c.id === it.client_id);
    const autoScope = it.r && it.r.v >= 2 && ["meal", "diary_part", "food_item"].includes(it.r.screen) ? "meal" : "day";
    const curScope = it.scope || autoScope;
    openSheet(
      e.day ? dayLabel(e.day) : "Screenshot",
      `<div class="form">
        <div class="shot"><img src="${imgUrl(it)}" alt="Screenshot"></div>
        ${status}
        <form class="form" id="itForm">
          <div class="field"><label for="it-day">Day it's for</label><input id="it-day" name="day" type="date" value="${e.day || ""}">
            <p class="hint${!e.day || GUESSY.has(e.src) ? " warn" : ""}">${e.day ? esc(SRC[e.src] || "") : "No date on it. Pick the day it's for."}</p></div>
          <div class="field"><span class="lab">What it shows</span><div class="opts" id="kindOpts">
            ${Object.entries(KIND).map(([k, l]) => `<button type="button" class="opt${it.kind === k ? " on" : ""}" data-kind="${k}" aria-pressed="${it.kind === k}">${l}</button>`).join("")}
          </div></div>
          <div class="field" id="scopeField"${it.kind === "food" || it.kind === "food_steps" ? "" : " hidden"}><span class="lab">These food numbers are for</span><div class="opts" id="scopeOpts">
            ${[["day", "The whole day"], ["meal", "One meal"]].map(([k, l]) => `<button type="button" class="opt${curScope === k ? " on" : ""}" data-scope="${k}" aria-pressed="${curScope === k}">${l}</button>`).join("")}
          </div><p class="hint">Meals are added up for days with no day-total screenshot. They're never added on top of a day's total.</p></div>
          <div class="two">
            <div class="field"><label for="it-kcal">Calories</label><input id="it-kcal" name="kcal" inputmode="numeric" value="${v("kcal")}" placeholder="None"></div>
            <div class="field"><label for="it-protein">Protein g</label><input id="it-protein" name="protein" inputmode="decimal" value="${v("protein")}" placeholder="None"></div>
          </div>
          <div class="two">
            <div class="field"><label for="it-carbs">Carbs g</label><input id="it-carbs" name="carbs" inputmode="decimal" value="${v("carbs")}" placeholder="None"></div>
            <div class="field"><label for="it-fat">Fat g</label><input id="it-fat" name="fat" inputmode="decimal" value="${v("fat")}" placeholder="None"></div>
          </div>
          <div class="field"><label for="it-steps">Steps</label><input id="it-steps" name="steps" inputmode="numeric" value="${v("steps")}" placeholder="None"></div>
          ${it.extras && it.extras.length ? `<div class="chips">${it.extras.map((x) => `<span class="chip">${esc(x.label)} ${esc(x.value)}</span>`).join("")}</div>` : ""}
          <div class="field"><label for="it-client">Client</label><select id="it-client" name="client">
            <option value="later"${it.client_id == null ? " selected" : ""}>Sort later</option>
            ${clients.map((c) => `<option value="${c.id}"${c.id === it.client_id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
          </select></div>
          <div class="form-err" id="itErr"></div>
          <button class="btn lime" type="submit">Save</button>
          <div class="btn-row">
            <button class="btn ghost" type="button" id="itRead">${ic("refresh")} Read again</button>
            <button class="btn danger" type="button" id="itDel">${ic("trash")} Delete</button>
          </div>
        </form>
      </div>`,
      (sh) => {
        let kind = it.kind;
        let scope = curScope;
        $("#kindOpts", sh).onclick = (ev) => {
          const b = ev.target.closest("[data-kind]");
          if (!b) return;
          kind = b.dataset.kind;
          $$("[data-kind]", sh).forEach((x) => {
            x.classList.toggle("on", x === b);
            x.setAttribute("aria-pressed", x === b);
          });
          $("#scopeField", sh).hidden = !(kind === "food" || kind === "food_steps");
        };
        $("#scopeOpts", sh).onclick = (ev) => {
          const b = ev.target.closest("[data-scope]");
          if (!b) return;
          scope = b.dataset.scope;
          $$("[data-scope]", sh).forEach((x) => {
            x.classList.toggle("on", x === b);
            x.setAttribute("aria-pressed", x === b);
          });
        };
        $("#itForm", sh).onsubmit = async (ev) => {
          ev.preventDefault();
          const f = new FormData(ev.target);
          const body = {};
          const day = f.get("day") || "";
          if (day !== (e.day || "")) body.day = day || null;
          for (const k of ["kcal", "protein", "carbs", "fat", "steps"]) {
            const raw = String(f.get(k) || "").replace(/[, ]/g, "");
            const nv = raw === "" ? null : Number(raw);
            if (raw !== "" && !Number.isFinite(nv)) {
              $("#itErr", sh).textContent = "Numbers only, please.";
              return;
            }
            if ((nv ?? null) !== (it[k] ?? null)) body[k] = nv;
          }
          if (kind !== it.kind && kind) body.kind = kind;
          if (scope !== curScope) body.scope = scope === autoScope && !it.scope ? null : scope;
          const cv = f.get("client");
          const newClient = cv === "later" ? null : Number(cv);
          if (newClient !== (it.client_id ?? null)) body.client_id = newClient ?? "later";
          if (!Object.keys(body).length) return closeSheet();
          try {
            const r = await api(`/logs/items/${id}`, { method: "POST", body });
            replaceItem(r.item);
            closeSheet();
            rerender();
            toast("Saved");
          } catch (err) {
            $("#itErr", sh).textContent = err.message;
          }
        };
        $("#itRead", sh).onclick = async () => {
          closeSheet();
          await readNow(it, true);
        };
        $("#itDel", sh).onclick = async () => {
          if (!confirm("Delete this screenshot?")) return;
          try {
            const r = await api("/logs/bulk", { method: "POST", body: { action: "delete", ids: [id] } });
            setData(r.state);
            closeSheet();
            rerender();
            toast("Deleted");
          } catch (err) {
            fail(err);
          }
        };
      }
    );
  }

  // ---------- targets ----------
  function openTargets() {
    const cid = S.clientId;
    const t = targetsFor(cid);
    const goals = itemsFor(cid).concat(itemsFor(cid, true)).map((i) => i.kcal_goal).filter((g) => g);
    const goal = goals.length ? goals[goals.length - 1] : null;
    openSheet(
      `Targets for ${firstName(nameOf(cid))}`,
      `<form class="form" id="tgForm">
        <p class="hint">Used to tick the days they hit, in the app and on the PDF. Leave any blank to skip it.</p>
        <div class="field"><label for="tg-kcal">Calories a day</label><input id="tg-kcal" name="kcal" inputmode="numeric" value="${t.kcal ?? ""}" placeholder="e.g. 1800"></div>
        ${goal && goal !== t.kcal ? `<button type="button" class="linkish" id="useGoal">Use ${fmtN(goal)}, the goal on their screenshots</button>` : ""}
        <div class="field"><label for="tg-protein">Protein a day, g</label><input id="tg-protein" name="protein" inputmode="numeric" value="${t.protein ?? ""}" placeholder="e.g. 130"></div>
        <div class="field"><label for="tg-steps">Steps a day</label><input id="tg-steps" name="steps" inputmode="numeric" value="${t.steps ?? ""}" placeholder="e.g. 10000"></div>
        <p class="hint">A day counts as on target for calories within 10% either way, and for protein and steps at or above the number.</p>
        <div class="form-err" id="tgErr"></div>
        <button class="btn lime" type="submit">Save targets</button>
      </form>`,
      (sh) => {
        const ug = $("#useGoal", sh);
        if (ug) ug.onclick = () => ($("#tg-kcal", sh).value = Math.round(goal));
        $("#tgForm", sh).onsubmit = async (ev) => {
          ev.preventDefault();
          const f = new FormData(ev.target);
          const val = (k) => {
            const s = String(f.get(k) || "").replace(/[, ]/g, "");
            return s === "" ? null : Number(s);
          };
          try {
            const r = await api("/logs/targets", { method: "POST", body: { client_id: cid, kcal: val("kcal"), protein: val("protein"), steps: val("steps") } });
            setData(r.state);
            closeSheet();
            rerender();
            toast("Targets saved");
          } catch (err) {
            $("#tgErr", sh).textContent = err.message;
          }
        };
      }
    );
  }

  // ---------- picking a client / a day ----------
  function pickClient(title, onPick, { allowLater = true, current } = {}) {
    const list = S.data.clients.filter((c) => !c.finished);
    openSheet(
      title,
      `<div class="pick-list">
        ${list.map((c) => `<button data-pick="${c.id}" class="${c.id === current ? "on" : ""}"><span class="av">${esc(initials(c.name))}</span>${esc(c.name)}</button>`).join("")}
        ${allowLater ? `<button data-pick="later"><span class="av">${ic("inbox")}</span>Sort later</button>` : ""}
        ${!list.length ? `<p class="hint">No clients yet. Add them in TrueStay Pay.</p>` : ""}
      </div>`,
      (sh) => {
        sh.querySelector(".pick-list").onclick = (ev) => {
          const b = ev.target.closest("[data-pick]");
          if (!b) return;
          closeSheet();
          onPick(b.dataset.pick === "later" ? null : Number(b.dataset.pick));
        };
      }
    );
  }
  function pickDay(title, value, onPick) {
    openSheet(
      title,
      `<form class="form" id="dayForm">
        <div class="field"><label for="pd-day">Day</label><input id="pd-day" type="date" value="${value || todayUK()}" max="${addDays(todayUK(), 1)}"></div>
        <div class="opts">${[0, 1, 2, 3, 4, 5, 6]
          .map((k) => addDays(todayUK(), -k))
          .map((d) => `<button type="button" class="opt" data-quick="${d}">${k2(d)}</button>`)
          .join("")}</div>
        <button class="btn lime" type="submit">Set day</button>
      </form>`,
      (sh) => {
        sh.querySelector(".opts").onclick = (ev) => {
          const b = ev.target.closest("[data-quick]");
          if (b) $("#pd-day", sh).value = b.dataset.quick;
        };
        $("#dayForm", sh).onsubmit = (ev) => {
          ev.preventDefault();
          const v = $("#pd-day", sh).value;
          if (!v) return;
          closeSheet();
          onPick(v);
        };
      }
    );
  }
  const k2 = (d) => (d === todayUK() ? "Today" : d === addDays(todayUK(), -1) ? "Yesterday" : dayLabel(d).replace(/ \w+$/, ""));

  // ---------- bulk actions ----------
  async function bulk(action, extra = {}) {
    const ids = [...S.sel];
    if (!ids.length) return;
    try {
      const r = await api("/logs/bulk", { method: "POST", body: { action, ids, ...extra } });
      setData(r.state);
      S.sel = new Set();
      rerender();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  // ---------- adding screenshots ----------
  let addFor; // undefined: ask; null: sort later; number: that client
  function startAdd(clientId) {
    addFor = clientId;
    const p = $("#picker");
    p.value = "";
    p.click();
  }
  function decodeImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).catch(() => decodeViaImg(file));
    }
    return decodeViaImg(file);
  }
  function decodeViaImg(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        res(img);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        rej(new Error("Couldn't open that picture"));
      };
      img.src = url;
    });
  }
  async function toJpeg(file, maxW, quality) {
    const src = await decodeImage(file);
    const w0 = src.width || src.naturalWidth;
    const h0 = src.height || src.naturalHeight;
    const s = Math.min(1, maxW / w0, 3200 / h0);
    const w = Math.max(1, Math.round(w0 * s));
    const h = Math.max(1, Math.round(h0 * s));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
    c.width = c.height = 0;
    if (!blob) throw new Error("Couldn't prepare that picture");
    return { blob, w, h };
  }
  const blobToB64 = (blob) =>
    new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).replace(/^data:[^,]*,/, ""));
      fr.onerror = () => rej(new Error("Couldn't read that picture"));
      fr.readAsDataURL(blob);
    });

  async function upload(files, clientId) {
    const c = clientId ? clientOf(clientId) : null;
    const U = (S.up = { total: files.length, done: 0, added: 0, dup: 0, failed: 0, err: "", clientName: c ? c.name : "" });
    if (S.view !== "client" || S.clientId !== (clientId ?? "later")) {
      S.view = "client";
      S.clientId = clientId ?? "later";
      S.sel = null;
    }
    render("push");
    let i = 0;
    const one = async () => {
      while (i < files.length) {
        const f = files[i++];
        try {
          const { blob } = await toJpeg(f, MAX_UPLOAD_W, 0.85);
          const data = await blobToB64(blob);
          const r = await api("/logs/upload", { method: "POST", body: { client_id: clientId ?? null, name: f.name || "", lm: f.lastModified || 0, data } });
          if (r.dup) U.dup++;
          else {
            U.added++;
            if (r.item) addItem(r.item);
            softRender();
          }
        } catch (e) {
          if (e.silent) throw e;
          U.failed++;
          U.err = e.message;
        }
        U.done++;
        const d = $("#upDone");
        const b = $("#upBar");
        if (d) d.textContent = U.done;
        if (b) b.style.width = `${Math.round((U.done / U.total) * 100)}%`;
      }
    };
    try {
      await Promise.all([one(), one()]);
    } catch (e) {
      S.up = null;
      return;
    }
    S.up = null;
    await refresh();
    const parts = [`${plural(U.added, "screenshot")} added`];
    if (U.dup) parts.push(`${U.dup} already there`);
    if (U.failed) parts.push(`${U.failed} didn't go: ${U.err}`);
    toast(parts.join(". ") + ".");
    readLoop();
  }
  let lastSoft = 0;
  function softRender() {
    // show new thumbnails while a big batch is still going up, without redrawing on every single one
    if (Date.now() - lastSoft < 1200) return;
    lastSoft = Date.now();
    rerender();
  }
  function addItem(item) {
    if (!S.data.items.some((i) => i.id === item.id)) S.data.items.push(item);
    recompute();
  }
  function replaceItem(item) {
    const i = S.data.items.findIndex((x) => x.id === item.id);
    if (i >= 0) S.data.items[i] = item;
    else S.data.items.push(item);
    recompute();
  }

  // ---------- reading ----------
  // The server reads each screenshot as it arrives. Anything still waiting after a bit gets read from here, and so
  // does anything read by an older version of the reader (the numbers stay as they were until the new reading is in).
  const limitPaused = (i) => /allowance/i.test(i.read_error || "");
  const needsReread = (i) => i.status === "read" && (i.rv || 1) < (S.data.reader || 1) && !i.filed_at && !limitPaused(i) && (i.read_tries || 0) < 6;
  let readTimer = null;
  let readSince = 0;
  function readLoop() {
    clearTimeout(readTimer);
    readSince = Date.now();
    const tick = async () => {
      if (!S.data || S.limitHit) return;
      const skew = S.data.now - S.syncedAt / 1000;
      const now = Date.now() / 1000 + skew;
      const waiting = openItems().filter((i) => i.status === "new" && !limitPaused(i));
      const old = S.clientId && S.clientId !== "later" ? openItems().filter((i) => needsReread(i) && i.client_id === S.clientId) : [];
      const others = openItems().filter((i) => needsReread(i) && i.client_id !== S.clientId);
      if ((!waiting.length && !old.length && !others.length) || Date.now() - readSince > 25 * 60000) return rerender();
      const next = waiting.filter((i) => now - i.received_at > 40 && !S.reading.has(i.id)).slice(0, 2);
      if (!next.length) next.push(...old.concat(others).filter((i) => !S.reading.has(i.id)).slice(0, 2));
      await Promise.all(next.map((it) => readNow(it, false)));
      if (next.some((it) => limitPaused(S.data.items.find((x) => x.id === it.id) || {}))) S.limitHit = true;
      await refresh(true);
      readTimer = setTimeout(tick, next.length ? 1500 : 4000);
    };
    readTimer = setTimeout(tick, 2500);
  }
  async function readNow(it, loud) {
    S.reading.add(it.id);
    if (loud) rerender();
    try {
      const r = await api(`/logs/read/${it.id}`, { method: "POST" });
      replaceItem(r.item);
      if (loud) toast(r.item.status === "read" ? "Read it again" : "Still couldn't read it. Type the numbers in instead.");
    } catch (e) {
      if (loud) fail(e);
    } finally {
      S.reading.delete(it.id);
      if (loud) rerender();
    }
  }

  // ---------- PDF ----------
  async function pdfImage(it) {
    try {
      const res = await fetch(imgUrl(it), { credentials: "same-origin" });
      if (!res.ok) return null;
      const { blob, w, h } = await toJpeg(await res.blob(), PDF_IMG_W, 0.82);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
    } catch {
      return null;
    }
  }
  function openPdf() {
    const cid = S.clientId;
    const items = itemsFor(cid);
    const { days, undated } = byDay(items);
    if (!items.length) return toast("Nothing waiting for this client.");
    const from0 = days.length ? days[0].day : todayUK();
    const to0 = days.length ? days[days.length - 1].day : todayUK();
    let blob = null;
    let url = null;
    let included = [];
    const name = nameOf(cid);
    openSheet(
      `PDF for ${firstName(name)}`,
      `<div class="form" id="pdfForm">
        <div class="two">
          <div class="field"><label for="pf-from">From</label><input id="pf-from" type="date" value="${from0}"></div>
          <div class="field"><label for="pf-to">To</label><input id="pf-to" type="date" value="${to0}"></div>
        </div>
        ${
          undated.length
            ? `<label class="setup-card" style="margin:0;cursor:pointer"><span class="l" style="flex:1"><span class="t">Add the ${plural(undated.length, "screenshot")} with no day</span><span class="d" style="display:block">They go at the end</span></span>
               <span class="switch-wrap"><input type="checkbox" id="pf-undated" checked style="width:24px;height:24px;accent-color:#1B1C19"></span></label>`
            : ""
        }
        <p class="hint" id="pf-sum"></p>
        <div class="form-err" id="pf-err"></div>
        <button class="btn lime" id="pf-go">${ic("doc")} Make PDF</button>
        <div id="pf-prog" hidden><p class="hint" id="pf-msg" style="margin-bottom:8px">Starting…</p><div class="progress"><i id="pf-bar"></i></div></div>
        <div id="pf-done" hidden class="form">
          <div class="status-line">${ic("check")}<span id="pf-ready">Your PDF is ready.</span></div>
          <div class="btn-row">
            <button class="btn lime" id="pf-share">${ic("share")} Share</button>
            <a class="btn ghost" id="pf-open" target="_blank" rel="noopener">${ic("doc")} Open</a>
          </div>
          <button class="btn ghost" id="pf-file">${ic("check")} Done with these screenshots</button>
          <p class="hint">Moves them out of the waiting list. They're deleted ${S.data.keep.filedDays} days later, so you can make the PDF again until then.</p>
        </div>
      </div>`,
      (sh) => {
        const sel = () => {
          const a = $("#pf-from", sh).value;
          const b = $("#pf-to", sh).value;
          const inc = !!($("#pf-undated", sh) || {}).checked;
          const ds = days.filter((d) => (!a || d.day >= a) && (!b || d.day <= b));
          return { a, b, inc, ds };
        };
        const sum = () => {
          const { a, b, inc, ds } = sel();
          const n = ds.reduce((x, d) => x + d.items.length, 0) + (inc ? undated.length : 0);
          const span = a && b && b >= a ? daysBetween(a, b) + 1 : 0;
          $("#pf-sum", sh).textContent = a && b && b >= a ? `${plural(span, "day")}, ${plural(n, "screenshot")}.` : "Pick the days to include.";
          $("#pf-go", sh).disabled = !(a && b && b >= a && n) || span > 62;
          if (span > 62) $("#pf-sum", sh).textContent = "Pick 62 days or fewer.";
        };
        ["pf-from", "pf-to", "pf-undated"].forEach((idn) => {
          const el = $("#" + idn, sh);
          if (el) el.addEventListener("change", sum);
        });
        sum();
        sh.onclose = () => {
          if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
        };
        $("#pf-go", sh).onclick = async () => {
          const { a, b, inc, ds } = sel();
          const map = new Map(ds.map((d) => [d.day, d]));
          const all = [];
          for (let d = a; d <= b; d = addDays(d, 1)) all.push(map.get(d) || { day: d, items: [], totals: {} });
          included = ds.flatMap((d) => d.items.map((i) => i.id)).concat(inc ? undated.map((i) => i.id) : []);
          $("#pf-go", sh).hidden = true;
          $("#pf-err", sh).textContent = "";
          $("#pf-prog", sh).hidden = false;
          try {
            blob = await window.TSLogPDF.build({
              clientName: name,
              from: a,
              to: b,
              days: all,
              undated: inc ? undated : [],
              targets: targetsFor(cid),
              madeOn: dayLabel(todayUK()),
              loadImage: pdfImage,
              onProgress: (n, t) => {
                $("#pf-msg", sh).textContent = `Adding screenshot ${n} of ${t}`;
                $("#pf-bar", sh).style.width = `${Math.round((n / t) * 100)}%`;
              },
            });
          } catch (e) {
            $("#pf-prog", sh).hidden = true;
            $("#pf-go", sh).hidden = false;
            $("#pf-err", sh).textContent = "Couldn't make the PDF. Try again.";
            console.error(e);
            return;
          }
          const fname = window.TSLogPDF.fileName(name, a, b);
          url = URL.createObjectURL(blob);
          const open = $("#pf-open", sh);
          open.href = url;
          open.download = fname;
          $("#pf-ready", sh).textContent = `${fname.replace(/\.pdf$/, "")} is ready (${mb(blob.size)}).`;
          $("#pf-prog", sh).hidden = true;
          $("#pf-done", sh).hidden = false;
          $("#pf-share", sh).onclick = async () => {
            const file = new File([blob], fname, { type: "application/pdf" });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              try {
                await navigator.share({ files: [file], title: fname.replace(/\.pdf$/, "") });
              } catch (e) {
                if (!isCancel(e)) toast("Couldn't share it. Use Open instead.");
              }
            } else open.click();
          };
          $("#pf-file", sh).onclick = async () => {
            try {
              const r = await api("/logs/bulk", { method: "POST", body: { action: "file", ids: included } });
              setData(r.state);
              closeSheet();
              rerender();
              const ids = included;
              toast(`Moved ${plural(ids.length, "screenshot")} to done.`, [
                {
                  label: "Undo",
                  fn: async () => {
                    try {
                      const r2 = await api("/logs/bulk", { method: "POST", body: { action: "unfile", ids } });
                      setData(r2.state);
                      rerender();
                    } catch (e) {
                      fail(e);
                    }
                  },
                },
              ]);
            } catch (e) {
              fail(e);
            }
          };
        };
      }
    );
  }

  // ---------- choosing where screenshots come from ----------
  function chooseSource(clientId) {
    openSheet(
      "Add screenshots",
      `<div class="action-list">
        <button class="action" data-src="photos"><span class="ic">${ic("image")}</span><span><b>Pick from Photos</b><small>Screenshots saved on your phone. Pick as many as you like.</small></span></button>
        <button class="action" data-src="chat"><span class="ic">${ic("inbox")}</span><span><b>Import a WhatsApp chat</b><small>Every screenshot a client sent, each on the day it was sent. Best for catching up.</small></span></button>
      </div>`,
      (sh) => {
        sh.querySelector(".action-list").onclick = (ev) => {
          const b = ev.target.closest("[data-src]");
          if (!b) return;
          if (b.dataset.src === "photos") {
            closeSheet(true);
            startAdd(clientId);
          } else openImport(clientId);
        };
      }
    );
  }

  // ---------- WhatsApp chat export (.zip) ----------
  // WhatsApp's Export Chat names each picture with when it was sent, e.g. 00000045-PHOTO-2026-09-21-21-34-12.jpg,
  // and _chat.txt says who sent it. The zip is read on the phone; only the chosen pictures are sent up.
  const u16 = (v, o) => v.getUint16(o, true);
  const u32 = (v, o) => v.getUint32(o, true);
  async function readZip(file) {
    const size = file.size;
    const tailLen = Math.min(size, 65557);
    const tail = new DataView(await file.slice(size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("That file isn't a WhatsApp export (.zip).");
    let count = u16(tail, eocd + 10);
    let cdSize = u32(tail, eocd + 12);
    let cdOff = u32(tail, eocd + 16);
    if (cdOff === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
        const z64off = Number(tail.getBigUint64(loc + 8, true));
        const z = new DataView(await file.slice(z64off, z64off + 56).arrayBuffer());
        count = Number(z.getBigUint64(32, true));
        cdSize = Number(z.getBigUint64(40, true));
        cdOff = Number(z.getBigUint64(48, true));
      }
    }
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const td = new TextDecoder();
    const entries = [];
    let p = 0;
    for (let k = 0; k < count && p + 46 <= cd.byteLength; k++) {
      if (u32(cd, p) !== 0x02014b50) break;
      const method = u16(cd, p + 10);
      let comp = u32(cd, p + 20);
      let full = u32(cd, p + 24);
      const nLen = u16(cd, p + 28);
      const xLen = u16(cd, p + 30);
      const cLen = u16(cd, p + 32);
      let off = u32(cd, p + 42);
      const name = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nLen));
      // zip64 sizes and offsets live in the extra field
      let x = p + 46 + nLen;
      const xEnd = x + xLen;
      while (x + 4 <= xEnd) {
        const id = u16(cd, x);
        const len = u16(cd, x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (full === 0xffffffff) { full = Number(cd.getBigUint64(q, true)); q += 8; }
          if (comp === 0xffffffff) { comp = Number(cd.getBigUint64(q, true)); q += 8; }
          if (off === 0xffffffff) { off = Number(cd.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + len;
      }
      if (!name.endsWith("/")) entries.push({ name, base: name.split("/").pop(), method, comp, full, off });
      p += 46 + nLen + xLen + cLen;
    }
    return entries;
  }
  async function entryBytes(file, e) {
    const h = new DataView(await file.slice(e.off, e.off + 30).arrayBuffer());
    if (u32(h, 0) !== 0x04034b50) throw new Error("Couldn't read part of the export");
    const start = e.off + 30 + u16(h, 26) + u16(h, 28);
    const raw = file.slice(start, start + e.comp);
    if (e.method === 0) return new Uint8Array(await raw.arrayBuffer());
    if (e.method === 8) {
      if (!window.DecompressionStream) throw new Error("This phone can't open zip files here. Update iOS.");
      const out = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(out).arrayBuffer());
    }
    throw new Error("That export uses a zip format this can't open");
  }
  const IMG_RE = /\.(jpe?g|png|webp|heic)$/i;
  function sentFromName(n) {
    let m = n.match(/(20\d\d)-(\d\d)-(\d\d)[-_ T](\d\d)[-.:](\d\d)[-.:](\d\d)/) || n.match(/(20\d\d)(\d\d)(\d\d)[-_](\d\d)(\d\d)(\d\d)/);
    if (m) return { day: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
    m = n.match(/IMG-(20\d\d)(\d\d)(\d\d)-WA/i) || n.match(/(20\d\d)-(\d\d)-(\d\d)/);
    return m ? { day: `${m[1]}-${m[2]}-${m[3]}`, time: null } : null;
  }
  function parseChat(txt) {
    // file name -> who sent it. iPhone: "[21/09/2026, 21:34:12] Sarah: <attached: 0000-PHOTO-....jpg>"; Android: "21/09/2026, 21:34 - Sarah: IMG-...jpg (file attached)"
    const who = new Map();
    for (let line of txt.split(/\r?\n/)) {
      line = line.replace(/[‎‏‪-‮]/g, "").trim();
      let m = line.match(/^\[[^\]]+\]\s(.+?):\s.*?<attached:\s*([^>]+?)\s*>/i);
      if (m) {
        who.set(m[2].trim(), m[1].trim());
        continue;
      }
      m = line.match(/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s[\d:]+(?:\s?[ap]\.?m\.?)?\s[-–]\s(.+?):\s(.+?)\s\(file attached\)/i);
      if (m) who.set(m[2].trim(), m[1].trim());
    }
    return who;
  }
  const normName = (n) => String(n || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  function matchClient(title) {
    const t = normName(title);
    if (!t) return null;
    const list = S.data.clients.filter((c) => !c.finished);
    let c = list.find((x) => normName(x.name) === t);
    if (c) return c.id;
    const tw = t.split(" ");
    c = list.filter((x) => {
      const w = normName(x.name).split(" ");
      return w[0] === tw[0] && (w.length < 2 || tw.length < 2 || w[w.length - 1][0] === tw[tw.length - 1][0]);
    });
    return c.length === 1 ? c[0].id : null;
  }
  const isShotShaped = (u8) => {
    // screenshots are tall (phone shaped); camera photos aren't
    const n = u8.length;
    if (u8[0] === 0x89 && u8[1] === 0x50) {
      const w = (u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19];
      const h = (u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23];
      return h / w >= 1.6;
    }
    if (u8[0] === 0xff && u8[1] === 0xd8) {
      let i = 2;
      while (i + 9 < n) {
        if (u8[i] !== 0xff) { i++; continue; }
        const m = u8[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          const h = (u8[i + 5] << 8) | u8[i + 6];
          const w = (u8[i + 7] << 8) | u8[i + 8];
          return h / w >= 1.6;
        }
        i += 2 + ((u8[i + 2] << 8) | u8[i + 3]);
      }
    }
    return true;
  };

  function openImport(clientId) {
    openSheet(
      "Import a WhatsApp chat",
      `<div class="form" id="imp">
        <div class="steps">
          <div class="step"><div>In WhatsApp, open the client's chat and tap their name at the top.</div></div>
          <div class="step"><div>Tap <b>Export Chat</b>, then <b>Attach Media</b>.</div></div>
          <div class="step"><div>Choose <b>Save to Files</b> and save it.</div></div>
          <div class="step"><div>Come back here and pick that file.</div></div>
        </div>
        <input type="file" id="zipPick" accept=".zip,application/zip,application/x-zip-compressed" hidden>
        <button class="btn lime" id="zipGo">${ic("inbox")} Choose the export</button>
        <div class="form-err" id="impErr"></div>
        <p class="hint">The export is opened on your phone. Only the screenshots you pick get sent to Logs.</p>
      </div>`,
      (sh) => {
        const pick = $("#zipPick", sh);
        $("#zipGo", sh).onclick = () => {
          pick.value = "";
          pick.click();
        };
        pick.onchange = async () => {
          const f = pick.files[0];
          if (!f) return;
          $("#zipGo", sh).disabled = true;
          $("#zipGo", sh).textContent = "Opening…";
          $("#impErr", sh).textContent = "";
          try {
            await importPlan(sh, f, clientId);
          } catch (e) {
            $("#impErr", sh).textContent = e.message || "Couldn't open that file.";
            $("#zipGo", sh).disabled = false;
            $("#zipGo", sh).innerHTML = `${ic("inbox")} Choose the export`;
          }
        };
      }
    );
  }

  async function importPlan(sh, file, clientId) {
    const entries = await readZip(file);
    const chatEntry = entries.find((e) => /(^|\/)_chat\.txt$/i.test(e.name)) || entries.find((e) => /\.txt$/i.test(e.name));
    const who = chatEntry ? parseChat(new TextDecoder().decode(await entryBytes(file, chatEntry))) : new Map();
    const pics = entries
      .filter((e) => IMG_RE.test(e.base) && !/sticker|STK-/i.test(e.base))
      .map((e) => ({ ...e, sent: sentFromName(e.base), from: who.get(e.base) || null }))
      .filter((e) => e.sent);
    if (!pics.length) throw new Error("No dated pictures in that export. Make sure you chose Attach Media.");
    const title = (file.name.match(/WhatsApp Chat (?:-|with)\s*(.+?)\.zip$/i) || [])[1] || "";
    const cid = clientId != null ? clientId : matchClient(title);
    const senders = [...pics.reduce((m, e) => m.set(e.from || "", (m.get(e.from || "") || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
    const me = normName(S.session?.name);
    const t = normName(title);
    let chosen = new Set(senders.map(([n]) => n).filter((n) => n && (normName(n) === t || (t && normName(n).startsWith(t.split(" ")[0])))));
    if (!chosen.size) chosen = new Set(senders.map(([n]) => n).filter((n) => !me || !normName(n).startsWith(me)));
    if (!chosen.size) chosen = new Set(senders.map(([n]) => n));
    const lastDay = S.data.items.filter((i) => cid && i.client_id === cid && i.sent_at).map((i) => ukParts(i.sent_at).date).sort().pop();
    const days = pics.map((e) => e.sent.day).sort();
    const to0 = days[days.length - 1];
    const from0 = lastDay && lastDay >= days[0] ? lastDay : [addDays(to0, -6), days[0]].sort()[1];
    const clients = S.data.clients.filter((c) => !c.finished);
    const body = $("#imp", sh);
    body.innerHTML = `
      <div class="status-line">${ic("info")}<span>${esc(title || file.name)}: ${plural(pics.length, "dated picture")}, ${dayLabel(days[0])} to ${dayLabel(to0)}.</span></div>
      <div class="field"><label for="im-client">Client</label><select id="im-client">
        <option value="">Pick the client</option>
        ${clients.map((c) => `<option value="${c.id}"${c.id === cid ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
        <option value="later">Sort later</option>
      </select></div>
      <div class="two">
        <div class="field"><label for="im-from">From</label><input id="im-from" type="date" value="${from0}"></div>
        <div class="field"><label for="im-to">To</label><input id="im-to" type="date" value="${to0}"></div>
      </div>
      ${
        senders.length > 1 || (senders[0] && senders[0][0])
          ? `<div class="field"><span class="lab">Sent by</span><div class="opts" id="im-who">${senders
              .map(([n, c]) => `<button type="button" class="opt${chosen.has(n) ? " on" : ""}" data-who="${esc(n)}" aria-pressed="${chosen.has(n)}">${esc(n || "Unknown")} · ${c}</button>`)
              .join("")}</div></div>`
          : ""
      }
      <label class="switch-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1.5px solid var(--line);border-radius:14px;padding:12px 14px">
        <span class="l">Screenshots only<small style="display:block;color:var(--muted);font-size:13px">Skips camera photos, like selfies and progress pics</small></span>
        <input type="checkbox" id="im-shots" checked style="width:24px;height:24px;accent-color:#1B1C19">
      </label>
      <p class="hint" id="im-sum"></p>
      <div class="form-err" id="im-err"></div>
      <button class="btn lime" id="im-go">Import</button>
      <div id="im-prog" hidden><p class="hint" id="im-msg" style="margin-bottom:8px"></p><div class="progress"><i id="im-bar"></i></div></div>`;
    const sel = () => {
      const a = $("#im-from", sh).value;
      const b = $("#im-to", sh).value;
      return pics.filter((e) => (!a || e.sent.day >= a) && (!b || e.sent.day <= b) && (senders.length < 2 || chosen.has(e.from || "")));
    };
    const sum = () => {
      const n = sel().length;
      $("#im-sum", sh).textContent = n ? `${plural(n, "picture")} to look at. Screenshots already in Logs are spotted and left out.` : "Nothing in those dates.";
      $("#im-go", sh).disabled = !n || !$("#im-client", sh).value;
      $("#im-go", sh).textContent = $("#im-client", sh).value ? `Import ${n || ""}`.trim() : "Pick the client first";
    };
    const whoBox = $("#im-who", sh);
    if (whoBox)
      whoBox.onclick = (ev) => {
        const b = ev.target.closest("[data-who]");
        if (!b) return;
        const n = b.dataset.who;
        if (chosen.has(n)) chosen.delete(n);
        else chosen.add(n);
        b.classList.toggle("on", chosen.has(n));
        b.setAttribute("aria-pressed", chosen.has(n));
        sum();
      };
    ["im-from", "im-to", "im-client"].forEach((i) => $("#" + i, sh).addEventListener("change", sum));
    sum();
    $("#im-go", sh).onclick = async () => {
      const list = sel();
      const cv = $("#im-client", sh).value;
      const target = cv === "later" ? null : Number(cv);
      const onlyShots = $("#im-shots", sh).checked;
      $("#im-go", sh).hidden = true;
      $("#im-prog", sh).hidden = false;
      const U = { total: list.length, done: 0, added: 0, dup: 0, skipped: 0, failed: 0, err: "" };
      let i = 0;
      const one = async () => {
        while (i < list.length) {
          const e = list[i++];
          try {
            const bytes = await entryBytes(file, e);
            if (onlyShots && !isShotShaped(bytes)) U.skipped++;
            else {
              const ext = e.base.split(".").pop().toLowerCase();
              const blob = new Blob([bytes], { type: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "heic" ? "image/heic" : "image/jpeg" });
              const { blob: jpg } = await toJpeg(blob, MAX_UPLOAD_W, 0.85);
              const r = await api("/logs/upload", { method: "POST", body: { client_id: target, name: e.base, lm: 0, data: await blobToB64(jpg) } });
              if (r.dup) U.dup++;
              else {
                U.added++;
                if (r.item) addItem(r.item);
              }
            }
          } catch (err) {
            if (err.silent) throw err;
            U.failed++;
            U.err = err.message;
          }
          U.done++;
          $("#im-msg", sh).textContent = `Importing ${U.done} of ${U.total}`;
          $("#im-bar", sh).style.width = `${Math.round((U.done / U.total) * 100)}%`;
        }
      };
      try {
        await Promise.all([one(), one()]);
      } catch {
        return;
      }
      closeSheet();
      S.view = "client";
      S.clientId = target ?? "later";
      S.sel = null;
      await refresh();
      window.scrollTo(0, 0);
      const parts = [`${plural(U.added, "screenshot")} imported`];
      if (U.dup) parts.push(`${U.dup} already there`);
      if (U.skipped) parts.push(`${plural(U.skipped, "photo")} skipped`);
      if (U.failed) parts.push(`${U.failed} didn't go: ${U.err}`);
      toast(parts.join(". ") + ".");
      readLoop();
    };
  }

  // ---------- share button setup ----------
  function copyText(t, msg = "Link copied") {
    const done = () => toast(msg);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, msg));
    else fallbackCopy(t, msg);
  }
  function fallbackCopy(t, msg = "Link copied") {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(msg);
    } catch {
      toast("Couldn't copy. Press and hold the link instead.");
    }
    ta.remove();
  }
  async function openSetup() {
    if (!S.data.key) {
      try {
        const r = await api("/logs/key", { method: "POST" });
        S.data.key = r.key;
        rerender();
      } catch (e) {
        return fail(e);
      }
    }
    const k = encodeURIComponent(S.data.key);
    const clientsUrl = `${location.origin}/api/logs/clients?k=${k}`;
    const uploadUrl = `${location.origin}/api/logs/upload?k=${k}`;
    // iOS 27: tapping + in Shortcuts opens "Describe a Shortcut" (Apple Intelligence builds it from this)
    const desc =
      `Make a shortcut called Send to Logs that shows in the share sheet and takes images. ` +
      `First, get contents of URL ${clientsUrl}, split the text by new lines, and choose from the list with the prompt "Who are these for?". ` +
      `Then repeat with each item in the shortcut input: convert the image to JPEG, then get contents of URL ${uploadUrl} ` +
      `with method POST and request body Form, with a text field named client set to the chosen item and a file field named photo set to the converted image. ` +
      `After the repeat, show a notification with the contents of URL.`;
    const box = (u, id) => `<div class="copybox"><code>${esc(u)}</code><button class="btn sm lime" data-copy="${id}">${ic("copy")} Copy</button></div>`;
    openSheet(
      "WhatsApp share button",
      `<div class="form">
        <p class="hint">Once it's set up: in WhatsApp, pick the screenshots, tap Share, tap <b>Send to Logs</b>, pick the client. Works for 1 or 50.</p>
        <div class="steps">
          <div class="step"><div><b>Copy the description.</b> Your private links are already in it.
            <button class="btn lime" data-copy="d" style="margin-top:10px">${ic("copy")} Copy the description</button></div></div>
          <div class="step"><div>Open the <b>Shortcuts</b> app and tap <b>+</b>. Paste into <b>Describe a Shortcut</b> and let it build.</div></div>
          <div class="step"><div>Check it has these steps. If one's off, tap <b>Describe a change</b> and say what to fix, or tap the step and fix it by hand.
            <ol class="mini-list">
              <li>Takes <b>Images</b> from the Share Sheet</li>
              <li>Get Contents of URL, the clients link</li>
              <li>Split Text by New Lines</li>
              <li>Choose from List, "Who are these for?"</li>
              <li>Repeat with each item in Shortcut Input</li>
              <li>Inside the repeat: Convert Image to JPEG</li>
              <li>Inside the repeat: Get Contents of URL, the upload link. Method <b>POST</b>, Request Body <b>Form</b>, with <b>client</b> set to Chosen Item and <b>photo</b> (a File) set to Converted Image</li>
              <li>After the repeat: Show Notification with Contents of URL</li>
            </ol></div></div>
          <div class="step"><div>In the shortcut's details, make sure <b>Show in Share Sheet</b> is on.</div></div>
          <div class="step"><div>Try it: in a client's WhatsApp chat, press and hold a screenshot, tap <b>Share</b>, pick <b>Send to Logs</b>, then the client. You should get a notification saying <b>Saved for</b> them.
            <div class="sub">For lots at once, open the chat's Media, tap Select, tick them, then Share.</div></div></div>
        </div>
        <details class="manual">
          <summary>Build it by hand instead</summary>
          <div class="steps">
            <div class="step"><div>In Shortcuts, tap <b>+</b>, skip Describe a Shortcut to build it yourself, and name it <b>Send to Logs</b>.</div></div>
            <div class="step"><div>In its details, switch on <b>Show in Share Sheet</b>, and set it to receive <b>Images</b>.</div></div>
            <div class="step"><div>Add <b>Get Contents of URL</b> with this link:${box(clientsUrl, "c")}</div></div>
            <div class="step"><div>Add <b>Split Text</b>, split by <b>New Lines</b>.</div></div>
            <div class="step"><div>Add <b>Choose from List</b>, prompt <b>Who are these for?</b></div></div>
            <div class="step"><div>Add <b>Repeat with Each</b>, repeating with <b>Shortcut Input</b>.</div></div>
            <div class="step"><div>Inside the repeat, add <b>Convert Image</b>: <b>Repeat Item</b> to <b>JPEG</b>.</div></div>
            <div class="step"><div>Inside the repeat, add <b>Get Contents of URL</b> with this link:${box(uploadUrl, "u")}
              <div class="sub" style="margin-top:8px">Method <b>POST</b>, Request Body <b>Form</b>. A <b>Text</b> field <b>client</b> set to <b>Chosen Item</b>, and a <b>File</b> field <b>photo</b> set to <b>Converted Image</b>.</div></div></div>
            <div class="step"><div>After <b>End Repeat</b>, add <b>Show Notification</b> with <b>Contents of URL</b>.</div></div>
          </div>
        </details>
        <div class="status-line warn">${ic("key")}<span>Keep the description and links to yourself. Anyone with them could add pictures to your Logs. If they get out, make new links in Settings.</span></div>
        <p class="hint">No time for this? <b>Add screenshots</b>, then <b>Import a WhatsApp chat</b>, needs no setup at all.</p>
      </div>`,
      (sh) => {
        sh.addEventListener("click", (ev) => {
          const b = ev.target.closest("[data-copy]");
          if (!b) return;
          const which = b.dataset.copy;
          copyText(which === "d" ? desc : which === "c" ? clientsUrl : uploadUrl, which === "d" ? "Description copied. Now paste it in Shortcuts." : "Link copied");
        });
      }
    );
  }

  // ---------- data ----------
  function setData(d) {
    S.data = d;
    S.syncedAt = Date.now();
    recompute();
  }
  async function refresh(quiet) {
    try {
      const d = await api("/logs/state");
      setData(d);
      if (!quiet || signature() !== S.sig) rerender();
    } catch (e) {
      if (!quiet) fail(e);
    }
  }

  // ---------- auth screens ----------
  function renderLogin() {
    closeSheet(true);
    S.locked = false;
    root().innerHTML = `
      <div class="auth">
        <div class="auth-hero">
          <div class="logo-mark big">${LOGO}</div>
          <h1>Client logs, <em>sorted.</em></h1>
          <p>Sign in with your TrueStay Pay email and password. You'll stay signed in on this phone.</p>
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
        S.locked = false;
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

  // ---------- theme ----------
  function applyTheme(t) {
    const r = document.documentElement;
    if (t === "light" || t === "dark") r.dataset.theme = t;
    else delete r.dataset.theme;
  }

  // ---------- events ----------
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close]")) return closeSheet();
    const th = e.target.closest("[data-theme-set]");
    if (th) {
      setPref("theme", th.dataset.themeSet);
      applyTheme(th.dataset.themeSet);
      return rerender();
    }
    const item = e.target.closest("[data-item]");
    if (item && root().contains(item)) {
      const id = Number(item.dataset.item);
      if (S.sel) {
        if (S.sel.has(id)) S.sel.delete(id);
        else S.sel.add(id);
        return rerender();
      }
      return openItem(id);
    }
    const vd = e.target.closest("[data-verdict]");
    if (vd && root().contains(vd)) {
      const day = vd.dataset.day;
      const verdict = vd.dataset.verdict || null;
      try {
        const r = await api("/logs/days", { method: "POST", body: { client_id: S.clientId, day, verdict } });
        setData(r.state);
        rerender();
        toast(verdict === "count" ? `${dayLabel(day)} now counts in the averages` : verdict === "omit" ? `${dayLabel(day)} left out of the averages` : "Back to how it was read");
      } catch (err) {
        fail(err);
      }
      return;
    }
    const cl = e.target.closest("[data-client]");
    if (cl && root().contains(cl)) {
      S.view = "client";
      S.clientId = cl.dataset.client === "later" ? "later" : Number(cl.dataset.client);
      S.sel = S.clientId === "later" ? new Set() : null;
      window.scrollTo(0, 0);
      return render("push");
    }
    const a = e.target.closest("[data-action]");
    if (!a) return;
    const act = a.dataset.action;
    if (act === "home") {
      S.view = "home";
      S.sel = null;
      render("pop");
      window.scrollTo(0, 0);
    } else if (act === "settings") {
      S.view = "settings";
      S.sel = null;
      render("push");
      window.scrollTo(0, 0);
    } else if (act === "add") chooseSource(undefined);
    else if (act === "add-here") chooseSource(S.clientId === "later" ? null : S.clientId);
    else if (act === "select") {
      S.sel = S.sel ? null : new Set();
      rerender();
    } else if (act === "targets") openTargets();
    else if (act === "pdf") openPdf();
    else if (act === "setup") openSetup();
    else if (act === "newkey") {
      if (!confirm("Make new links? Your current Shortcut will stop working until you paste the new ones in.")) return;
      try {
        const r = await api("/logs/key", { method: "POST" });
        S.data.key = r.key;
        openSetup();
      } catch (err) {
        fail(err);
      }
    } else if (act === "logout") {
      try {
        await api("/logout", { method: "POST", raw: true });
      } catch {}
      S.data = null;
      renderLogin();
    } else if (act === "unfile") {
      const ids = itemsFor(S.clientId, true).map((i) => i.id);
      try {
        const r = await api("/logs/bulk", { method: "POST", body: { action: "unfile", ids } });
        setData(r.state);
        rerender();
        toast(`${plural(ids.length, "screenshot")} back in the waiting list`);
      } catch (err) {
        fail(err);
      }
    } else if (act === "sel-day") {
      pickDay(S.sel.size === 1 ? "Which day is it for?" : `Which day are these ${S.sel.size} for?`, null, async (day) => {
        const n = S.sel.size;
        if (await bulk("day", { day })) toast(`${plural(n, "screenshot")} set to ${dayLabel(day)}`);
      });
    } else if (act === "sel-move") {
      pickClient(`Whose ${S.sel.size === 1 ? "is this" : "are these"}?`, async (cid) => {
        const n = S.sel.size;
        if (await bulk("client", { client_id: cid ?? "later" })) toast(`${plural(n, "screenshot")} moved to ${cid ? firstName(nameOf(cid)) : "Sort later"}`);
      });
    } else if (act === "sel-delete") {
      const n = S.sel.size;
      if (!confirm(`Delete ${plural(n, "screenshot")}? This can't be undone.`)) return;
      if (await bulk("delete")) toast(`${plural(n, "screenshot")} deleted`);
    }
  });
  $("#picker").addEventListener("change", (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    if (addFor !== undefined) return upload(files, addFor);
    pickClient(`Who ${files.length === 1 ? "is this" : `are these ${files.length}`} for?`, (cid) => upload(files, cid));
  });

  // ---------- lifecycle ----------
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !S.data || S.locked) return;
    if (Date.now() - S.lastSync < 10000) return;
    S.lastSync = Date.now();
    try {
      const s = await api("/session", { raw: true });
      if (!s.authed) return renderLogin();
      if (s.locked) return renderLock();
      S.session = s;
      await refresh(true);
      if (openItems().some((i) => i.status === "new" || needsReread(i))) readLoop();
    } catch {}
  });
  setInterval(async () => {
    if (document.visibilityState !== "visible" || !S.data || S.locked || !S.session?.hasPasskey) return;
    try {
      const s = await api("/session", { raw: true });
      if (s.authed && s.locked) renderLock();
    } catch {}
  }, 30000);

  // ---------- boot ----------
  async function boot() {
    try {
      const s = await api("/session", { raw: true });
      S.session = s;
      if (!s.hasUser) {
        root().innerHTML = `<div class="lock-screen"><div class="logo-mark big">${LOGO}</div><h1>Set up TrueStay Pay first</h1><p>Logs uses the same sign in.</p><a class="btn lime" href="/pay/">Open TrueStay Pay</a></div>`;
        return;
      }
      if (!s.authed) return renderLogin();
      if (s.locked) return renderLock();
      S.locked = false;
      setData(await api("/logs/state"));
      S.lastSync = Date.now();
      render("fade");
      if (openItems().some((i) => i.status === "new" || needsReread(i))) readLoop();
    } catch (e) {
      if (e.silent) return;
      root().innerHTML = `<div class="lock-screen"><div class="logo-mark big">${LOGO}</div><h1>Can't connect</h1><p>${esc(e.message)}</p><button class="btn lime" id="retry">Try again</button></div>`;
      $("#retry").onclick = boot;
    }
  }

  applyTheme(pref("theme", "system"));
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  boot();
})();
