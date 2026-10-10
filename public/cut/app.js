/* TrueStay Cut: Shan's fat loss phase. Daily weigh-in, steps, calories and a workout tick,
   weekly and monthly averages, and a weekly front / side / back photo set.
   Vanilla JS. Talks to /api/pay/cut/* with the same sign-in as TrueStay Pay. */
(() => {
  "use strict";

  const API = "/api/pay";
  const PHOTO_MAX = 1400; // longest side after resizing on the phone
  const POSES = ["front", "side", "back"];
  const POSE = { front: "Front", side: "Side", back: "Back" };

  // ---------- tiny utils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, w, ws) => `${n} ${n === 1 ? w : ws || w + "s"}`;
  const pref = (k, d) => {
    try {
      return localStorage.getItem("tsc." + k) ?? d;
    } catch {
      return d;
    }
  };
  const setPref = (k, v) => {
    try {
      localStorage.setItem("tsc." + k, v);
    } catch {}
  };
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const kg = (v) => (v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1));
  const kgSigned = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 10) / 10).toFixed(1)}`);
  const nfmt = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-GB"));
  const numFrom = (s) => {
    const n = Number(String(s ?? "").replace(/[^0-9.]/g, ""));
    return String(s ?? "").trim() === "" || !Number.isFinite(n) ? null : n;
  };
  // "down 0.6 kg" / "up 0.2 kg" / "no change": words, never colour alone
  function chg(v, unit = "kg") {
    if (v == null) return "";
    const r = Math.round(v * 10) / 10;
    if (r === 0) return `<span class="chg flat">no change</span>`;
    return `<span class="chg ${r < 0 ? "down" : "up"}">${r < 0 ? "down" : "up"} ${Math.abs(r).toFixed(1)} ${unit}</span>`;
  }

  // ---------- dates (UK) ----------
  const todayUK = () =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const addDays = (s, n) => {
    const d = new Date(s + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const dObj = (iso) => new Date(iso + "T12:00:00Z");
  const daysBetween = (a, b) => Math.round((dObj(b) - dObj(a)) / 86400000);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayLabel = (iso) => {
    const d = dObj(iso);
    return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  };
  const shortDay = (iso) => {
    const d = dObj(iso);
    return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  };
  const weekOf = (iso) => addDays(iso, -((dObj(iso).getUTCDay() + 6) % 7)); // Monday
  const weekRange = (w) => {
    const e = addDays(w, 6);
    const A = dObj(w);
    const B = dObj(e);
    return A.getUTCMonth() === B.getUTCMonth() ? `${A.getUTCDate()}–${B.getUTCDate()} ${MON[B.getUTCMonth()]}` : `${shortDay(w)} – ${shortDay(e)}`;
  };
  const monthKey = (iso) => iso.slice(0, 7);
  const monthLabel = (mk) => `${MONTH[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}`;

  // ---------- icons ----------
  const P = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6"/>',
    today: '<rect x="3" y="4.5" width="18" height="17" rx="4"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/><circle cx="12" cy="15.5" r="2"/>',
    trend: '<path d="m3 7 6 6 4-4 8 8"/><path d="M21 11v6h-6"/>',
    camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v9A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
    swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    out: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9"/>',
    faceid:
      '<path d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2"/><path d="M8.5 9v1.5M15.5 9v1.5M12 9v4.5h-1"/><path d="M8.8 16.3c1.9 1.4 4.5 1.4 6.4 0"/>',
  };
  const ic = (n) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
  const LOGO =
    '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="2" y="2" width="44" height="44" rx="13" fill="#1B1C19"/><path d="M10 17l10 6 7-3 11 10" fill="none" stroke="#D7F54A" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="38" cy="30" r="4.4" fill="#D7F54A"/><path d="M10 38h28" stroke="#76862C" stroke-width="2" stroke-linecap="round"/></svg>';

  // ---------- state ----------
  const S = {
    session: null,
    data: null,
    tab: "today",
    day: null,
    range: pref("range", "4w"),
    pose: "front",
    cmpA: null,
    cmpB: null,
    chartSel: null,
    uploading: {}, // "week:pose" -> true
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
    t.classList.toggle("high", !!S.data);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actions.length ? 6000 : 2800);
  }
  const hideToast = () => $("#toast").classList.remove("show");
  function haptic() {
    try {
      if (navigator.vibrate) navigator.vibrate(10);
    } catch {}
  }

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

  // ---------- reading the data ----------
  let dayMap = new Map();
  const today = () => S.data?.today || todayUK();
  const setts = () => S.data?.settings || null;
  function setData(d) {
    S.data = d;
    dayMap = new Map(d.days.map((r) => [r.day, r]));
    if (!S.day || S.day > d.today) S.day = d.today;
  }
  const rowOf = (day) => dayMap.get(day) || null;
  function targetOn(day) {
    const ts = S.data.targets;
    let t = ts[0] || { steps: null, kcal: null, workouts: null };
    for (const x of ts) if (x.from_day <= day) t = x;
    return t;
  }
  // a tick you set wins; otherwise the number decides (steps at or over target, calories at or under)
  function stepsHit(r, t) {
    if (!r) return null;
    if (r.steps_hit != null) return !!r.steps_hit;
    if (r.steps != null && t.steps) return r.steps >= t.steps;
    return null;
  }
  function kcalHit(r, t) {
    if (!r) return null;
    if (r.kcal_hit != null) return !!r.kcal_hit;
    if (r.kcal != null && t.kcal) return r.kcal <= t.kcal;
    return null;
  }
  const weights = () => S.data.days.filter((r) => r.weight != null);
  function avgBetween(from, to) {
    const xs = weights().filter((r) => r.day >= from && r.day <= to).map((r) => r.weight);
    return { avg: avg(xs), n: xs.length };
  }
  const last7 = (day) => avgBetween(addDays(day, -6), day);
  const lastWeight = (before) => {
    const ws = weights().filter((r) => !before || r.day <= before);
    return ws.length ? ws[ws.length - 1] : null;
  };
  // kg per week from a straight line through the last 28 days of weigh-ins (needs a fortnight of data)
  function rate(endDay) {
    const from = addDays(endDay, -27);
    const pts = weights().filter((r) => r.day >= from && r.day <= endDay);
    if (pts.length < 6 || daysBetween(pts[0].day, pts[pts.length - 1].day) < 10) return null;
    const xs = pts.map((p) => daysBetween(from, p.day));
    const ys = pts.map((p) => p.weight);
    const mx = avg(xs);
    const my = avg(ys);
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    if (!den) return null;
    const perWeek = (num / den) * 7;
    return { perWeek, pct: (perWeek / my) * 100, days: daysBetween(pts[0].day, pts[pts.length - 1].day) + 1 };
  }
  function phase(day) {
    const s = setts();
    if (!s) return null;
    const total = Math.max(1, Math.ceil((daysBetween(s.start_date, s.end_date) + 1) / 7));
    const d = daysBetween(s.start_date, day);
    const week = d < 0 ? 0 : Math.min(total, Math.floor(d / 7) + 1);
    const left = Math.max(0, daysBetween(day, s.end_date));
    return { total, week, left, pct: Math.max(0, Math.min(100, (d / Math.max(1, daysBetween(s.start_date, s.end_date))) * 100)) };
  }
  function weekStats(w) {
    const td = today();
    const end = addDays(w, 6);
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(w, i));
    const past = days.filter((d) => d <= td);
    const t = targetOn(end < td ? end : td);
    let workouts = 0;
    let stepDays = 0;
    let kcalDays = 0;
    const steps = [];
    const kcals = [];
    for (const d of past) {
      const r = rowOf(d);
      const tt = targetOn(d);
      if (r?.workout === 1) workouts++;
      if (stepsHit(r, tt)) stepDays++;
      if (kcalHit(r, tt)) kcalDays++;
      if (r?.steps != null) steps.push(r.steps);
      if (r?.kcal != null) kcals.push(r.kcal);
    }
    const wa = avgBetween(w, end);
    return { w, end, days, past: past.length, t, workouts, stepDays, kcalDays, avgSteps: avg(steps), avgKcal: avg(kcals), avgW: wa.avg, nW: wa.n };
  }
  function phaseWeeks() {
    const s = setts();
    const td = today();
    const first = [s?.start_date, S.data.days[0]?.day, S.data.photos[0]?.day].filter(Boolean).sort()[0] || td;
    const out = [];
    for (let w = weekOf(first); w <= weekOf(td); w = addDays(w, 7)) out.push(w);
    return out;
  }
  const photoOf = (week, pose) => S.data.photos.find((p) => p.week === week && p.pose === pose) || null;
  const photoUrl = (p) => `${API}/cut/photos/${p.id}`;

  // ---------- waist: one a week, stored in cm, shown in cm or inches ----------
  const wUnit = () => (setts()?.waist_unit === "in" ? "in" : "cm");
  const toUnit = (cm) => (cm == null ? null : wUnit() === "in" ? cm / 2.54 : cm);
  const fromUnit = (v) => (v == null ? null : wUnit() === "in" ? v * 2.54 : v);
  const waistTxt = (cm) => (cm == null ? "—" : (Math.round(toUnit(cm) * 10) / 10).toFixed(1));
  const waistOf = (week) => (S.data.waist || []).find((x) => x.week === week) || null;
  const waistBefore = (week) => (S.data.waist || []).filter((x) => x.week < week).pop() || null;
  const waistChg = (cmDiff) => chg(toUnit(cmDiff), wUnit());

  // ---------- saving a day ----------
  async function saveDay(day, patch) {
    try {
      const r = await api(`/cut/days/${day}`, { method: "PUT", body: patch });
      setData(r.state);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  // ---------- rendering ----------
  function render(anim = "fade") {
    if (!S.data) return;
    if (!setts()) return renderSetup();
    const views = { today: viewToday, progress: viewProgress, photos: viewPhotos };
    root().innerHTML = `<main class="view has-tabs ${anim ? anim + " enter" : ""}" id="view">${views[S.tab]()}</main>${tabbar()}`;
    after();
  }
  const rerender = () => render("");
  function tabbar() {
    const T = [
      ["today", "today", "Today"],
      ["progress", "trend", "Progress"],
      ["photos", "camera", "Photos"],
    ];
    return `<nav class="tabbar"><div class="tabbar-inner">${T.map(
      ([k, i, l]) => `<button class="tab${S.tab === k ? " on" : ""}" data-tab="${k}" aria-current="${S.tab === k ? "page" : "false"}">${ic(i)}<span>${l}</span></button>`
    ).join("")}</div></nav>`;
  }
  const topbar = (title, extra = "") =>
    `<div class="topbar"><div class="title"><span>${title}</span></div><div class="actions">${extra}<button class="round" data-action="settings" aria-label="Settings">${ic("user")}</button></div></div>`;

  // ----- Today -----
  function viewToday() {
    const td = today();
    const day = S.day;
    const isToday = day === td;
    const r = rowOf(day);
    const t = targetOn(day);
    const ph = phase(day);
    const lw = lastWeight(addDays(day, -1));
    const a7 = last7(day);
    const prev7 = avgBetween(addDays(day, -13), addDays(day, -7));
    const sh = stepsHit(r, t);
    const kh = kcalHit(r, t);
    const ws = weekStats(weekOf(day));
    const wk = weekOf(day);
    const shots = POSES.filter((p) => photoOf(wk, p)).length;
    const pd = dObj(day);
    return `
      ${topbar("TrueStay Cut")}
      <div class="datebar rise" style="--i:0">
        <button class="round" data-day="${addDays(day, -1)}" aria-label="Day before">${ic("left")}</button>
        <div class="d"><b>${isToday ? "Today" : day === addDays(td, -1) ? "Yesterday" : WD_LONG[pd.getUTCDay()]}</b><small>${dayLabel(day)}${ph && ph.week ? ` · Week ${ph.week} of ${ph.total}` : ""}</small></div>
        <button class="round" data-day="${addDays(day, 1)}" ${isToday ? "disabled" : ""} aria-label="Day after">${ic("right")}</button>
      </div>

      <section class="hero rise" style="--i:1">
        <div class="k">${isToday ? "This morning's weigh-in" : "Weigh-in"}</div>
        <div class="weigh">
          <button class="stepbtn" data-wstep="-0.1" aria-label="Down 0.1 kg">${ic("minus")}</button>
          <div class="wv"><input id="wIn" inputmode="decimal" autocomplete="off" enterkeyhint="done" aria-label="Weight in kg" value="${r?.weight != null ? kg(r.weight) : ""}" placeholder="${lw ? kg(lw.weight) : "0.0"}"><span class="unit">kg${r?.weight == null && lw ? ` · last was ${kg(lw.weight)} on ${shortDay(lw.day)}` : ""}</span></div>
          <button class="stepbtn" data-wstep="0.1" aria-label="Up 0.1 kg">${ic("plus")}</button>
        </div>
        <div class="weigh-sub">${
          a7.avg != null
            ? `7-day average <b class="num">${kg(a7.avg)}</b>${prev7.avg != null ? ` · ${chg(a7.avg - prev7.avg)} on the week before` : ""}`
            : "Weigh in each morning. The averages do the talking, not one day."
        }</div>
        <div class="saved" id="wSaved"></div>
        ${
          ph
            ? `<div class="phase"><div class="pl"><span>${ph.week ? `Week ${ph.week} of ${ph.total}` : `Starts ${dayLabel(setts().start_date)}`}</span><span>${ph.left ? `${plural(ph.left, "day")} to go` : "Last day"}</span></div><div class="bar"><i style="width:${ph.pct}%"></i></div></div>`
            : ""
        }
      </section>

      <div class="ticks">
        ${tickCard("workout", "Trained", r?.workout === 1, ws.t.workouts ? `${ws.workouts} of ${ws.t.workouts} this week` : `${plural(ws.workouts, "session")} this week`)}
        ${tickCard("steps", t.steps ? `Hit ${nfmt(t.steps)} steps` : "Hit my steps", sh === true, r?.steps != null ? `${nfmt(r.steps)} steps logged` : "Tick it, or put the number in", {
          field: "steps",
          value: r?.steps,
          label: "Steps",
          step: 1000,
          ph: t.steps ? nfmt(t.steps) : "e.g. 10,000",
        })}
        ${tickCard("kcal", t.kcal ? `On ${nfmt(t.kcal)} calories` : "On my calories", kh === true, r?.kcal != null ? `${nfmt(r.kcal)} kcal logged${t.kcal ? ` · ${r.kcal <= t.kcal ? `${nfmt(t.kcal - r.kcal)} under` : `${nfmt(r.kcal - t.kcal)} over`}` : ""}` : "Tick it, or put the number in", {
          field: "kcal",
          value: r?.kcal,
          label: "Calories",
          step: 100,
          ph: t.kcal ? nfmt(t.kcal) : "e.g. 2,200",
        })}
      </div>

      ${weekCard(ws, day)}

      ${checkinCard(wk, shots)}`;
  }
  function checkinCard(wk, shots) {
    const w = waistOf(wk);
    const prev = waistBefore(wk);
    const first = (S.data.waist || [])[0];
    const sub = w
      ? prev
        ? `${waistChg(w.cm - prev.cm)} on last time${first && first.week !== wk && first.week !== prev.week ? ` · ${waistChg(w.cm - first.cm)} since you started` : ""}`
        : "Your first one. Next week's goes against it."
      : prev
      ? `Last time ${waistTxt(prev.cm)} ${wUnit()} on ${shortDay(prev.day)}`
      : "Tape level at your belly button, breathe out normally, don't suck in.";
    return `<section class="card rise" style="--i:4">
      <div class="ch"><h3>Weekly check-in</h3><span>${weekRange(wk)}</span></div>
      <div class="tk-num" style="border-top:0;padding-top:0;margin-top:12px">
        <label for="waistIn">Waist</label>
        <button class="mini-step" data-waiststep="-0.5" aria-label="Waist down 0.5 ${wUnit()}">${ic("minus")}</button>
        <input id="waistIn" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${w ? waistTxt(w.cm) : ""}" placeholder="${prev ? waistTxt(prev.cm) : wUnit() === "in" ? "e.g. 36.0" : "e.g. 92.0"}" aria-label="Waist in ${wUnit() === "in" ? "inches" : "cm"}">
        <span class="w-unit">${wUnit()}</span>
        <button class="mini-step" data-waiststep="0.5" aria-label="Waist up 0.5 ${wUnit()}">${ic("plus")}</button>
      </div>
      <p class="w-sub">${sub}</p>
      <button class="ci-photos" data-tab="photos">
        <span class="ico">${ic("camera")}</span>
        <span class="l"><b>${shots === 3 ? "Photos done" : `Photos · ${shots} of 3`}</b><small>${shots === 3 ? "Front, side and back are in." : "Front, side and back. Same spot, same light."}</small></span>
        <span class="chev">${ic("right")}</span>
      </button>
    </section>`;
  }
  function tickCard(key, title, on, sub, num) {
    return `<div class="tk rise" style="--i:2">
      <div class="tk-top">
        <div class="l"><b>${esc(title)}</b><small>${esc(sub)}</small></div>
        <button class="tickbtn${on ? " on" : ""}" data-tick="${key}" aria-pressed="${on}" aria-label="${esc(title)}">${ic("check")}</button>
      </div>
      ${
        num
          ? `<div class="tk-num">
              <label for="n-${num.field}">${num.label}</label>
              <button class="mini-step" data-nstep="${num.field}" data-by="-${num.step}" aria-label="${num.label} down ${num.step}">${ic("minus")}</button>
              <input id="n-${num.field}" data-num="${num.field}" inputmode="numeric" autocomplete="off" enterkeyhint="done" value="${num.value != null ? nfmt(num.value) : ""}" placeholder="${esc(num.ph)}">
              <button class="mini-step" data-nstep="${num.field}" data-by="${num.step}" aria-label="${num.label} up ${num.step}">${ic("plus")}</button>
            </div>`
          : ""
      }
    </div>`;
  }
  function weekCard(ws, sel) {
    const td = today();
    const t = ws.t;
    const cell = (d, hit) => {
      if (d > td || (d === td && !hit)) return `<div class="c future"${d === td ? ` data-goday="${d}" role="button" tabindex="0" aria-label="${dayLabel(d)}: not done yet"` : ""}><i></i></div>`;
      const label = `${dayLabel(d)}: ${hit ? "done" : "not done"}`;
      return `<div class="c ${hit ? "hit" : "miss"}" data-goday="${d}" role="button" tabindex="0" aria-label="${label}"><i>${hit ? ic("check") : ""}</i></div>`;
    };
    const rows = [
      ["Train", (d) => rowOf(d)?.workout === 1],
      ["Steps", (d) => stepsHit(rowOf(d), targetOn(d)) === true],
      ["Cals", (d) => kcalHit(rowOf(d), targetOn(d)) === true],
    ];
    return `<section class="card rise" style="--i:3">
      <div class="ch"><h3>This week</h3><span>${weekRange(ws.w)}</span></div>
      <div class="wk">
        <span></span>${ws.days.map((d) => `<span class="h${d === sel ? " today" : ""}">${WD[dObj(d).getUTCDay()].slice(0, 1)}</span>`).join("")}
        ${rows.map(([l, f]) => `<span class="rl">${l}</span>${ws.days.map((d) => cell(d, f(d))).join("")}`).join("")}
      </div>
      <div class="wk-sum">
        <div>Workouts<b class="num">${ws.workouts}${t.workouts ? `<small style="font-size:13px;color:var(--muted)"> / ${t.workouts}</small>` : ""}</b></div>
        <div>Step days<b class="num">${ws.stepDays}<small style="font-size:13px;color:var(--muted)"> / ${ws.past}</small></b></div>
        <div>Avg weight<b class="num">${ws.avgW != null ? kg(ws.avgW) : "—"}</b></div>
      </div>
    </section>`;
  }

  // ----- Progress -----
  function viewProgress() {
    const td = today();
    const s = setts();
    const ws = weights();
    const now7 = last7(td);
    const weeks = phaseWeeks();
    const firstWeek = weeks.map((w) => weekStats(w)).find((x) => x.avgW != null);
    const base = firstWeek ? firstWeek.avgW : ws[0]?.weight ?? null;
    const lost = now7.avg != null && base != null ? now7.avg - base : null;
    const rt = rate(td);
    const ph = phase(td);
    const toGoal = s.goal_kg && now7.avg != null ? now7.avg - s.goal_kg : null;
    const months = [];
    for (const r of ws) {
      const k = monthKey(r.day);
      if (!months.length || months[months.length - 1].k !== k) months.push({ k, xs: [] });
      months[months.length - 1].xs.push(r.weight);
    }
    return `
      ${topbar("Progress")}
      <section class="hero rise" style="--i:0">
        <div class="k">Last 7 days average</div>
        <div class="big num">${now7.avg != null ? kg(now7.avg) : "—"}<small> kg</small></div>
        <div class="sub">${
          lost != null && firstWeek && firstWeek.w !== weekOf(td)
            ? `${Math.round(lost * 10) / 10 <= 0 ? `Down ${kg(-lost)} kg` : `Up ${kg(lost)} kg`} on your first week (${kg(base)}) · ${Math.abs((lost / base) * 100).toFixed(1)}%`
            : ws.length
            ? "Your first week sets the starting point."
            : "Weigh in each morning and this fills in."
        }</div>
        <div class="stats">
          <div>Rate<b class="num">${rt ? `${kgSigned(rt.perWeek)}` : "—"}</b><small>${rt ? `kg a week · ${Math.abs(rt.pct).toFixed(1)}% of you` : "after 2 weeks"}</small></div>
          ${(() => {
            const wl = S.data.waist || [];
            const lastW = wl[wl.length - 1];
            const d = wl.length > 1 ? lastW.cm - wl[0].cm : null;
            return `<div>Waist<b class="num">${lastW ? waistTxt(lastW.cm) : "—"}</b><small>${d != null ? `${wUnit()} · ${d <= 0 ? "down" : "up"} ${Math.abs(Math.round(toUnit(d) * 10) / 10).toFixed(1)} since ${shortDay(wl[0].day)}` : lastW ? `${wUnit()} · first one in` : "weekly, on Today"}</small></div>`;
          })()}
          <div>${s.goal_kg ? "To rough goal" : "Phase"}<b class="num">${s.goal_kg ? (toGoal != null ? (toGoal > 0 ? kg(toGoal) : "Hit") : "—") : ph ? `${ph.week}/${ph.total}` : "—"}</b><small>${s.goal_kg ? `goal ${kg(s.goal_kg)} kg` : "weeks"}</small></div>
        </div>
      </section>

      <section class="chart-card rise" style="--i:1">
        <div class="cc-head"><h3>Weight</h3><span class="legend-row" style="margin:0"><span><i class="k-dot"></i>Daily</span><span><i class="k-line"></i>7-day avg</span>${s.goal_kg ? `<span><i class="k-goal"></i>Goal</span>` : ""}</span></div>
        <div class="seg" role="tablist">
          ${[["4w", "4 weeks"], ["3m", "3 months"], ["all", "Whole phase"]].map(([k, l]) => `<button class="${S.range === k ? "on" : ""}" data-range="${k}">${l}</button>`).join("")}
        </div>
        <p class="readout" id="readout" aria-live="polite"></p>
        <div class="chart" id="chart"></div>
      </section>
      ${rt ? `<p class="hint" style="margin-top:8px">Rate is a straight line through your weigh-ins over the last 4 weeks, so one salty day doesn't swing it. Around 0.5 to 1% of bodyweight a week is the usual sweet spot for keeping muscle.</p>` : ""}

      <section class="chart-card rise" style="--i:2">
        <div class="cc-head"><h3>Waist</h3><span class="legend-row" style="margin:0"><span>weekly, ${wUnit() === "in" ? "inches" : "cm"}</span></span></div>
        <p class="readout" id="wReadout" aria-live="polite"></p>
        <div class="chart" id="wChart"></div>
      </section>
      ${(S.data.waist || []).length > 1 ? `<p class="hint" style="margin-top:8px">If the scale stalls but your waist keeps coming down, it's working. That's often muscle holding on while fat comes off.</p>` : ""}

      <div class="section-head"><h2>Weeks</h2><span>${plural(weeks.length, "week")}</span></div>
      ${weeks
        .slice()
        .reverse()
        .map((w, i, arr) => weekRow(weekStats(w), arr[i + 1] ? weekStats(arr[i + 1]) : null))
        .join("")}

      ${
        months.length
          ? `<div class="section-head"><h2>Months</h2><span>average weight</span></div>
             <div class="card" style="margin-top:0">${months
               .map((m, i) => {
                 const a = avg(m.xs);
                 const p = months[i - 1] ? avg(months[i - 1].xs) : null;
                 return `<div class="mrow"><span>${monthLabel(m.k)}<small>${plural(m.xs.length, "weigh-in")}</small></span><span class="r"><b class="num">${kg(a)} kg</b><small>${p != null ? chg(a - p) + " on " + MONTH[Number(months[i - 1].k.slice(5, 7)) - 1] : "starting month"}</small></span></div>`;
               })
               .reverse()
               .join("")}</div>`
          : ""
      }`;
  }
  function weekRow(x, prev) {
    const ph = phase(x.w) || { week: 0 };
    const wn = setts() ? Math.floor(daysBetween(setts().start_date, x.w) / 7) + 1 : null;
    const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
    const change = x.avgW != null && prev?.avgW != null ? x.avgW - prev.avgW : null;
    return `<div class="wrow">
      <div class="wt">
        <div><b>${wn && wn > 0 ? `Week ${wn}` : "Before the phase"}${x.past < 7 ? " · so far" : ""}</b><small>${weekRange(x.w)}</small>${(() => {
          const w = waistOf(x.w);
          if (!w) return "";
          const pv = waistBefore(x.w);
          return `<span class="wwaist">Waist <b class="num">${waistTxt(w.cm)} ${wUnit()}</b>${pv ? ` · ${waistChg(w.cm - pv.cm)}` : ""}</span>`;
        })()}</div>
        <div class="r"><b class="num">${x.avgW != null ? kg(x.avgW) : "—"}</b><small>${x.avgW != null ? (change != null ? chg(change) : `avg of ${plural(x.nW, "weigh-in")}`) : "no weigh-ins"}</small></div>
      </div>
      <div class="meters">
        <div class="meter"><span>Trained<b class="num">${x.workouts}${x.t.workouts ? `/${x.t.workouts}` : ""}</b></span><i><em style="width:${pct(x.workouts, x.t.workouts || 7)}%"></em></i></div>
        <div class="meter"><span>Steps<b class="num">${x.stepDays}/${x.past}</b></span><i><em style="width:${pct(x.stepDays, x.past)}%"></em></i><small>${x.avgSteps != null ? `avg ${nfmt(x.avgSteps)}` : ""}</small></div>
        <div class="meter"><span>Cals<b class="num">${x.kcalDays}/${x.past}</b></span><i><em style="width:${pct(x.kcalDays, x.past)}%"></em></i><small>${x.avgKcal != null ? `avg ${nfmt(x.avgKcal)}` : ""}</small></div>
      </div>
    </div>`;
  }

  // weight chart: daily dots, 7-day average line, optional goal line. Tap or drag to read a day.
  function drawChart() {
    const el = $("#chart");
    if (!el) return;
    const td = today();
    const s = setts();
    const from = S.range === "4w" ? addDays(td, -27) : S.range === "3m" ? addDays(td, -90) : [s.start_date, weights()[0]?.day].filter(Boolean).sort()[0] || td;
    const pts = weights().filter((r) => r.day >= from && r.day <= td);
    if (pts.length < 2) {
      el.innerHTML = `<div class="chart-empty">${pts.length ? "One weigh-in so far. The line starts with the second." : "No weigh-ins in this range yet."}</div>`;
      $("#readout").innerHTML = "";
      return;
    }
    const avgPts = pts.map((p) => ({ day: p.day, v: last7(p.day).avg }));
    const W = el.clientWidth || 320;
    const H = 220;
    const padL = 36;
    const padR = 8;
    const padT = 10;
    const padB = 24;
    const start = from < pts[0].day ? pts[0].day : from;
    const span = Math.max(1, daysBetween(start, td));
    const vals = pts.map((p) => p.weight).concat(s.goal_kg && S.range === "all" ? [s.goal_kg] : []);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (s.goal_kg && s.goal_kg >= lo - 3 && s.goal_kg <= hi + 3) {
      lo = Math.min(lo, s.goal_kg);
      hi = Math.max(hi, s.goal_kg);
    }
    const stepK = hi - lo > 8 ? 2 : hi - lo > 4 ? 1 : 0.5;
    lo = Math.floor((lo - 0.2) / stepK) * stepK;
    hi = Math.ceil((hi + 0.2) / stepK) * stepK;
    const x = (d) => padL + (daysBetween(start, d) / span) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const ticks = [];
    const nT = Math.round((hi - lo) / stepK);
    const every = Math.ceil(nT / 4);
    for (let i = 0; i <= nT; i += every) ticks.push(lo + i * stepK);
    const xl = [start, addDays(start, Math.round(span / 2)), td];
    const line = avgPts.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const goal = s.goal_kg && s.goal_kg >= lo && s.goal_kg <= hi ? s.goal_kg : null;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight from ${dayLabel(start)} to ${dayLabel(td)}: ${kg(pts[0].weight)} kg to ${kg(pts[pts.length - 1].weight)} kg">
      ${ticks.map((v) => `<line class="gl" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="gt" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${stepK < 1 ? v.toFixed(1) : v}</text>`).join("")}
      ${xl.map((d, i) => `<text class="gt" x="${x(d)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}">${shortDay(d)}</text>`).join("")}
      ${goal ? `<line class="goal" x1="${padL}" x2="${W - padR}" y1="${y(goal)}" y2="${y(goal)}"/><text class="gt" x="${W - padR}" y="${y(goal) - 5}" text-anchor="end">Goal ${kg(goal)}</text>` : ""}
      ${pts.map((p) => `<circle class="dot" cx="${x(p.day).toFixed(1)}" cy="${y(p.weight).toFixed(1)}" r="${pts.length > 60 ? 3 : 4}"/>`).join("")}
      <path class="avg" d="${line}"/>
      <line class="cross" id="cx" y1="${padT}" y2="${H - padB}" x1="-10" x2="-10"/>
      <circle class="sel" id="cs" r="5" cx="-10" cy="-10"/>
    </svg>`;
    const show = (i) => {
      const p = pts[i];
      const a = avgPts[i];
      S.chartSel = p.day;
      $("#readout").innerHTML = `<b>${dayLabel(p.day)}</b> · <b class="num">${kg(p.weight)} kg</b> · 7-day avg <span class="num">${kg(a.v)}</span>`;
      const cx = x(p.day);
      $("#cx").setAttribute("x1", cx);
      $("#cx").setAttribute("x2", cx);
      $("#cs").setAttribute("cx", cx);
      $("#cs").setAttribute("cy", y(p.weight));
    };
    const nearest = (clientX) => {
      const r = el.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      let best = 0;
      let bd = Infinity;
      pts.forEach((p, i) => {
        const d = Math.abs(x(p.day) - px);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    };
    const keep = pts.findIndex((p) => p.day === S.chartSel);
    show(keep >= 0 ? keep : pts.length - 1);
    const svg = $("svg", el);
    svg.addEventListener("pointerdown", (e) => show(nearest(e.clientX)));
    svg.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" || e.buttons) show(nearest(e.clientX));
    });
  }

  // ----- Photos -----
  function viewPhotos() {
    const td = today();
    const wk = weekOf(td);
    const weeks = phaseWeeks();
    const withPose = weeks.filter((w) => photoOf(w, S.pose));
    let A = S.cmpA && photoOf(S.cmpA, S.pose) ? S.cmpA : withPose[0] || null;
    let B = S.cmpB && photoOf(S.cmpB, S.pose) ? S.cmpB : withPose[withPose.length - 1] || null;
    const wName = (w) => {
      const n = setts() ? Math.floor(daysBetween(setts().start_date, w) / 7) + 1 : null;
      return n && n > 0 ? `Week ${n}` : "Before";
    };
    const fig = (w) => {
      const p = w && photoOf(w, S.pose);
      const a = w ? avgBetween(w, addDays(w, 6)).avg : null;
      return `<figure>
        ${p ? `<button class="ph" data-photo="${p.id}" aria-label="Open ${POSE[S.pose]} photo, ${wName(w)}"><img src="${photoUrl(p)}" alt="${POSE[S.pose]}, ${wName(w)}" loading="lazy"></button>` : `<div class="ph">No ${POSE[S.pose].toLowerCase()} photo yet</div>`}
        <figcaption>${w ? `<b>${wName(w)}</b>${p ? shortDay(p.day) : weekRange(w)}${a != null ? ` · avg ${kg(a)} kg` : ""}${waistOf(w) ? ` · waist ${waistTxt(waistOf(w).cm)} ${wUnit()}` : ""}` : ""}</figcaption>
      </figure>`;
    };
    const opt = (sel) => withPose.map((w) => `<option value="${w}" ${w === sel ? "selected" : ""}>${wName(w)}</option>`).join("");
    const past = weeks.filter((w) => w !== wk && POSES.some((p) => photoOf(w, p))).reverse();
    return `
      ${topbar("Photos")}
      <section class="card rise" style="--i:0;margin-top:4px">
        <div class="ch"><h3>This week</h3><span>${weekRange(wk)}</span></div>
        ${slots(wk)}
        <ul class="tips"><li>Same spot, same light, same time. Morning, before food, works best.</li><li>Tap a photo to see it big, swap it or delete it.</li></ul>
      </section>

      <section class="chart-card rise" style="--i:1">
        <div class="cc-head"><h3>Compare</h3></div>
        <div class="seg">${POSES.map((p) => `<button class="${S.pose === p ? "on" : ""}" data-pose="${p}">${POSE[p]}</button>`).join("")}</div>
        ${
          withPose.length >= 2
            ? `<div class="cmp-pick"><select id="cmpA" aria-label="First week">${opt(A)}</select><select id="cmpB" aria-label="Second week">${opt(B)}</select></div>
               <div class="cmp">${fig(A)}${fig(B)}</div>`
            : `<p class="readout">${withPose.length ? `One ${POSE[S.pose].toLowerCase()} photo so far. Next week's goes side by side with it.` : `Your first ${POSE[S.pose].toLowerCase()} photo starts the comparison.`}</p>
               ${withPose.length ? `<div class="cmp">${fig(withPose[0])}<figure><div class="ph">Next week</div></figure></div>` : ""}`
        }
      </section>

      ${
        past.length
          ? `<div class="section-head"><h2>Earlier weeks</h2><span>${plural(past.length, "week")}</span></div>
             ${past.map((w) => `<div class="pweek"><div class="ch" style="display:flex;justify-content:space-between;align-items:baseline"><b>${wName(w)}</b><span style="font-size:13px;color:var(--muted)">${weekRange(w)}</span></div>${slots(w)}</div>`).join("")}`
          : ""
      }`;
  }
  function slots(w) {
    return `<div class="slots">${POSES.map((pose) => {
      const p = photoOf(w, pose);
      const busy = S.uploading[`${w}:${pose}`];
      if (busy) return `<div class="slot"><span class="spin" aria-label="Uploading"></span><span class="sl">${POSE[pose]}</span></div>`;
      if (p) return `<button class="slot has" data-photo="${p.id}" aria-label="${POSE[pose]} photo, ${shortDay(p.day)}"><img src="${photoUrl(p)}" alt="" loading="lazy"><span class="sl">${POSE[pose]}</span></button>`;
      return `<button class="slot" data-addphoto="${pose}" data-week="${w}" aria-label="Add ${POSE[pose].toLowerCase()} photo"><span class="add">${ic("plus")}${POSE[pose]}</span></button>`;
    }).join("")}</div>`;
  }

  // ---------- after each render ----------
  function after() {
    if (S.tab === "progress") {
      drawChart();
      drawWaist();
    }
    const wi = $("#waistIn");
    if (wi) {
      wi.addEventListener("keydown", (e) => {
        if (e.key === "Enter") wi.blur();
      });
      wi.addEventListener("change", () => saveWaist(wi.value));
    }
    const w = $("#wIn");
    if (w) {
      w.addEventListener("keydown", (e) => {
        if (e.key === "Enter") w.blur();
      });
      w.addEventListener("change", () => saveWeight(w.value));
    }
    $$("[data-num]").forEach((inp) => {
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.blur();
      });
      inp.addEventListener("change", () => saveNum(inp.dataset.num, numFrom(inp.value)));
    });
    const a = $("#cmpA");
    const b = $("#cmpB");
    if (a) a.onchange = () => ((S.cmpA = a.value), rerender());
    if (b) b.onchange = () => ((S.cmpB = b.value), rerender());
  }

  // ---------- day actions ----------
  let wTimer;
  async function saveWeight(v) {
    clearTimeout(wTimer);
    const n = numFrom(v);
    if (n != null && (n < 30 || n > 300)) return toast("That weight doesn't look right. It's in kg.");
    const day = S.day;
    const before = rowOf(day)?.weight ?? null;
    if (n === before) return;
    if (await saveDay(day, { weight: n == null ? null : Math.round(n * 100) / 100 })) {
      rerender();
      const s = $("#wSaved");
      if (s) s.textContent = n == null ? "Cleared" : "Saved";
    }
  }
  function stepWeight(by) {
    const w = $("#wIn");
    const cur = numFrom(w.value) ?? numFrom(w.placeholder) ?? lastWeight()?.weight ?? 80;
    const next = Math.round((cur + by) * 10) / 10;
    w.value = next.toFixed(1);
    haptic();
    const s = $("#wSaved");
    if (s) s.textContent = "";
    clearTimeout(wTimer);
    wTimer = setTimeout(() => saveWeight(w.value), 900);
  }
  async function saveNum(field, n) {
    const day = S.day;
    const t = targetOn(day);
    const r = rowOf(day);
    if ((r?.[field] ?? null) === (n == null ? null : Math.round(n))) return;
    const patch = { [field]: n == null ? null : Math.round(n) };
    // typing the number sets the tick for you; you can still change the tick after
    if (field === "steps") patch.steps_hit = n == null ? null : t.steps ? (n >= t.steps ? 1 : 0) : r?.steps_hit ?? null;
    if (field === "kcal") patch.kcal_hit = n == null ? null : t.kcal ? (n <= t.kcal ? 1 : 0) : r?.kcal_hit ?? null;
    if (await saveDay(day, patch)) rerender();
  }
  let nTimer;
  function stepNum(field, by) {
    const inp = $(`#n-${field}`);
    const t = targetOn(S.day);
    const cur = numFrom(inp.value) ?? (field === "steps" ? t.steps : t.kcal) ?? 0;
    const next = Math.max(0, Math.round((cur + by) / Math.abs(by)) * Math.abs(by));
    inp.value = nfmt(next);
    haptic();
    clearTimeout(nTimer);
    nTimer = setTimeout(() => saveNum(field, next), 900);
  }
  async function toggleTick(key) {
    const day = S.day;
    const r = rowOf(day);
    const t = targetOn(day);
    const cur = key === "workout" ? r?.workout === 1 : key === "steps" ? stepsHit(r, t) === true : kcalHit(r, t) === true;
    const field = key === "workout" ? "workout" : key === "steps" ? "steps_hit" : "kcal_hit";
    haptic();
    if (await saveDay(day, { [field]: cur ? 0 : 1 })) {
      rerender();
      if (!cur && key === "workout") {
        const ws = weekStats(weekOf(day));
        if (ws.t.workouts && ws.workouts === ws.t.workouts) toast(`That's ${ws.workouts} of ${ws.t.workouts} this week. Target hit.`);
      }
    }
  }

  // ---------- waist ----------
  let waistTimer;
  async function saveWaist(v) {
    clearTimeout(waistTimer);
    const n = numFrom(v);
    const cm = n == null ? null : Math.round(fromUnit(n) * 10) / 10;
    if (cm != null && (cm < 40 || cm > 200)) return toast(`That waist doesn't look right. It's in ${wUnit() === "in" ? "inches" : "cm"}.`);
    const wk = weekOf(S.day);
    const old = waistOf(wk);
    if ((old?.cm ?? null) === cm) return;
    try {
      const r = await api(`/cut/waist/${S.day}`, { method: "PUT", body: { cm } });
      setData(r.state);
      rerender();
      if (cm != null) toast(old ? "Waist updated" : "Waist saved for this week");
    } catch (e) {
      fail(e);
    }
  }
  function stepWaist(by) {
    const inp = $("#waistIn");
    const cur = numFrom(inp.value) ?? numFrom(inp.placeholder.replace(/^e\.g\. /, "")) ?? (wUnit() === "in" ? 36 : 92);
    inp.value = (Math.round((cur + by) * 2) / 2).toFixed(1);
    haptic();
    clearTimeout(waistTimer);
    waistTimer = setTimeout(() => saveWaist(inp.value), 900);
  }
  // waist chart: one point a week, joined by a line. One measure, one axis.
  function drawWaist() {
    const el = $("#wChart");
    if (!el) return;
    const pts = (S.data.waist || []).map((x) => ({ day: x.day, week: x.week, v: toUnit(x.cm) }));
    const ro = $("#wReadout");
    if (pts.length < 2) {
      el.innerHTML = `<div class="chart-empty">${pts.length ? "One measurement so far. The line starts with next week's." : "Add your waist in the weekly check-in on Today."}</div>`;
      ro.innerHTML = "";
      return;
    }
    const W = el.clientWidth || 320;
    const H = 170;
    const padL = 36;
    const padR = 8;
    const padT = 10;
    const padB = 24;
    const start = pts[0].day;
    const end = pts[pts.length - 1].day;
    const span = Math.max(1, daysBetween(start, end));
    let lo = Math.min(...pts.map((p) => p.v));
    let hi = Math.max(...pts.map((p) => p.v));
    const stepK = hi - lo > 8 ? 2 : hi - lo > 3 ? 1 : 0.5;
    lo = Math.floor((lo - 0.2) / stepK) * stepK;
    hi = Math.ceil((hi + 0.2) / stepK) * stepK;
    const x = (d) => padL + (daysBetween(start, d) / span) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const ticks = [];
    const nT = Math.round((hi - lo) / stepK);
    const every = Math.ceil(nT / 3);
    for (let i = 0; i <= nT; i += every) ticks.push(lo + i * stepK);
    const xl = pts.length > 2 ? [start, pts[Math.floor(pts.length / 2)].day, end] : [start, end];
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="height:${H}px" role="img" aria-label="Waist from ${waistTxt(fromUnit(pts[0].v))} to ${waistTxt(fromUnit(pts[pts.length - 1].v))} ${wUnit()}">
      ${ticks.map((v) => `<line class="gl" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="gt" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${stepK < 1 ? v.toFixed(1) : v}</text>`).join("")}
      ${xl.map((d, i) => `<text class="gt" x="${x(d)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === xl.length - 1 ? "end" : "middle"}">${shortDay(d)}</text>`).join("")}
      <path class="avg" d="${pts.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}"/>
      ${pts.map((p) => `<circle class="wdot" cx="${x(p.day).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4.5"/>`).join("")}
      <line class="cross" id="wcx" y1="${padT}" y2="${H - padB}" x1="-10" x2="-10"/>
      <circle class="sel" id="wcs" r="6" cx="-10" cy="-10"/>
    </svg>`;
    const show = (i) => {
      const p = pts[i];
      const pv = pts[i - 1];
      const n = setts() ? Math.floor(daysBetween(setts().start_date, p.week) / 7) + 1 : null;
      ro.innerHTML = `<b>${n && n > 0 ? `Week ${n}` : shortDay(p.day)}</b> · <b class="num">${p.v.toFixed(1)} ${wUnit()}</b>${pv ? ` · ${chg(p.v - pv.v, wUnit())} on the week before` : ""}`;
      $("#wcx").setAttribute("x1", x(p.day));
      $("#wcx").setAttribute("x2", x(p.day));
      $("#wcs").setAttribute("cx", x(p.day));
      $("#wcs").setAttribute("cy", y(p.v));
    };
    const nearest = (cx) => {
      const r = el.getBoundingClientRect();
      const px = ((cx - r.left) / r.width) * W;
      let best = 0;
      let bd = Infinity;
      pts.forEach((p, i) => {
        const d = Math.abs(x(p.day) - px);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    };
    show(pts.length - 1);
    const svg = $("svg", el);
    svg.addEventListener("pointerdown", (e) => show(nearest(e.clientX)));
    svg.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" || e.buttons) show(nearest(e.clientX));
    });
  }

  // ---------- photos ----------
  let addTo = null;
  function startPhoto(week, pose) {
    addTo = { week, pose };
    const p = $("#picker");
    p.value = "";
    p.click();
  }
  function decodeImage(file) {
    if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => decodeViaImg(file));
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
        rej(new Error("Couldn't open that photo"));
      };
      img.src = url;
    });
  }
  async function toJpeg(file) {
    const src = await decodeImage(file);
    const w0 = src.width || src.naturalWidth;
    const h0 = src.height || src.naturalHeight;
    const s = Math.min(1, PHOTO_MAX / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * s));
    const h = Math.max(1, Math.round(h0 * s));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.84));
    c.width = c.height = 0;
    if (!blob) throw new Error("Couldn't prepare that photo");
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).replace(/^data:[^,]*,/, ""));
      fr.onerror = () => rej(new Error("Couldn't read that photo"));
      fr.readAsDataURL(blob);
    });
    return { b64, w, h };
  }
  async function uploadPhoto(file, target) {
    return sendPhoto(() => toJpeg(file), target);
  }
  // prep() returns { b64, w, h }: from a picked file, or straight from the camera
  async function sendPhoto(prep, { week, pose }) {
    const key = `${week}:${pose}`;
    S.uploading[key] = true;
    rerender();
    try {
      const { b64, w, h } = await prep();
      const td = today();
      const day = week === weekOf(td) ? td : addDays(week, 6) < td ? addDays(week, 6) : td;
      const r = await api("/cut/photos", { method: "POST", body: { pose, day, data: b64, mime: "image/jpeg", w, h } });
      setData(r.state);
      haptic();
      toast(r.replaced ? `${POSE[pose]} photo swapped` : `${POSE[pose]} photo saved`);
    } catch (e) {
      fail(e);
    } finally {
      delete S.uploading[key];
      rerender();
    }
  }
  // ---------- camera with a ghost of an earlier photo ----------
  // The live picture and the ghost sit in the same 3:4 frame, both cropped the same way, so lining up
  // with the ghost means the saved photo lines up with the old one. The front camera shows mirrored
  // (like a mirror) with the ghost mirrored to match, and saves the right way round.
  let cam = null;
  const camPref = () => ({
    facing: pref("facing", "user"),
    ghost: Number(pref("ghost", "35")),
    timer: Number(pref("timer", "3")),
    ghostFrom: pref("ghostFrom", "last"),
  });
  function ghostFor(week, pose, from) {
    const earlier = S.data.photos.filter((p) => p.pose === pose && p.week < week).sort((a, b) => (a.week < b.week ? -1 : 1));
    if (!earlier.length) return null;
    return from === "first" ? earlier[0] : earlier[earlier.length - 1];
  }
  const weekName = (w) => {
    const n = setts() ? Math.floor(daysBetween(setts().start_date, w) / 7) + 1 : null;
    return n && n > 0 ? `Week ${n}` : weekRange(w);
  };
  async function openCamera(week, pose) {
    if (!navigator.mediaDevices?.getUserMedia) return startPhoto(week, pose);
    closeSheet(true);
    const P = camPref();
    cam = { week, pose, facing: P.facing, stream: null, shot: null, counting: null };
    const el = document.createElement("div");
    el.className = "cam";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", `${POSE[pose]} photo camera`);
    document.body.append(el);
    document.body.classList.add("cam-open");
    cam.el = el;
    drawCamera();
    await startStream();
  }
  function drawCamera() {
    const P = camPref();
    const g = ghostFor(cam.week, cam.pose, P.ghostFrom);
    const hasFirst = ghostFor(cam.week, cam.pose, "first");
    const multi = hasFirst && g && hasFirst.id !== ghostFor(cam.week, cam.pose, "last").id;
    const mirror = cam.facing === "user";
    cam.el.innerHTML = `
      <div class="cam-top">
        <button class="cam-btn" data-cam="close" aria-label="Close camera">${ic("x")}</button>
        <div class="cam-title"><b>${POSE[cam.pose]}</b><small>${weekName(cam.week)}${g ? ` · ghost of ${weekName(g.week)}` : ""}</small></div>
        <button class="cam-btn" data-cam="flip" aria-label="Switch camera" ${cam.shot ? "disabled" : ""}>${ic("swap")}</button>
      </div>
      <div class="cam-frame">
        ${cam.shot ? `<img class="cam-shot" src="${cam.shot.url}" alt="The photo you just took">` : `<video id="camVideo" class="${mirror ? "mirror" : ""}" playsinline muted autoplay></video>`}
        ${g ? `<img class="cam-ghost${mirror && !cam.shot ? " mirror" : ""}" src="${photoUrl(g)}" alt="" style="opacity:${P.ghost / 100}">` : ""}
        <i class="cam-line" aria-hidden="true"></i>
        <div class="cam-count" id="camCount" aria-live="assertive"></div>
        <div class="cam-msg" id="camMsg">${g ? "" : `Your first ${POSE[cam.pose].toLowerCase()} photo. Next week's lines up with this one.`}</div>
      </div>
      <div class="cam-ctrls">
        ${
          g
            ? `<label class="cam-ghost-ctl"><span>Ghost</span><input type="range" id="camGhost" min="0" max="70" step="5" value="${P.ghost}" aria-label="Ghost strength"><span class="num" id="camGhostV">${P.ghost}%</span></label>
               ${multi ? `<div class="seg cam-seg" aria-label="Ghost from">${[["last", "Last time"], ["first", "First week"]].map(([k, l]) => `<button class="${P.ghostFrom === k ? "on" : ""}" data-cam="from-${k}">${l}</button>`).join("")}</div>` : ""}`
            : ""
        }
        ${
          cam.shot
            ? `<div class="cam-review">
                 <button class="btn ghost on-dark" data-cam="retake">Retake</button>
                 <button class="btn lime" data-cam="use">${ic("check")} Use photo</button>
               </div>`
            : `<div class="seg cam-seg" aria-label="Timer">${[[0, "No timer"], [3, "3 sec"], [10, "10 sec"]].map(([k, l]) => `<button class="${P.timer === k ? "on" : ""}" data-cam="timer-${k}">${l}</button>`).join("")}</div>
               <div class="cam-shoot">
                 <button class="cam-lib" data-cam="library">Library</button>
                 <button class="shutter" data-cam="shoot" aria-label="Take photo"><i></i></button>
                 <span class="cam-lib-sp"></span>
               </div>`
        }
      </div>`;
    const v = $("#camVideo", cam.el);
    if (v && cam.stream) {
      v.srcObject = cam.stream;
      v.play().catch(() => {});
    }
    const gr = $("#camGhost", cam.el);
    if (gr)
      gr.oninput = () => {
        setPref("ghost", gr.value);
        $("#camGhostV", cam.el).textContent = gr.value + "%";
        const gi = $(".cam-ghost", cam.el);
        if (gi) gi.style.opacity = gr.value / 100;
      };
  }
  async function startStream() {
    stopStream();
    const msg = () => $("#camMsg", cam?.el);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: cam.facing, width: { ideal: 1920 }, height: { ideal: 1920 } },
        audio: false,
      });
      if (!cam) return stream.getTracks().forEach((t) => t.stop());
      cam.stream = stream;
      const v = $("#camVideo", cam.el);
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => {});
      }
    } catch (e) {
      if (!cam) return;
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      const m = msg();
      if (m) {
        m.classList.add("show");
        m.innerHTML = `${denied ? "Camera access is off for this app." : "The camera didn't start."} <button class="linkish on-dark" data-cam="library">Pick from your photos instead</button>${denied ? "<br><small>To turn it on: Settings, Safari (or the app), Camera, Allow.</small>" : ""}`;
      }
    }
  }
  function stopStream() {
    if (cam?.stream) cam.stream.getTracks().forEach((t) => t.stop());
    if (cam) cam.stream = null;
  }
  function closeCamera() {
    if (!cam) return;
    clearInterval(cam.counting);
    stopStream();
    if (cam.shot) URL.revokeObjectURL(cam.shot.url);
    cam.el.remove();
    document.body.classList.remove("cam-open");
    cam = null;
  }
  function shoot() {
    const P = camPref();
    if (!cam?.stream || cam.counting) return;
    if (!P.timer) return capture();
    let n = P.timer;
    const c = $("#camCount", cam.el);
    c.textContent = n;
    c.classList.add("show");
    haptic();
    cam.counting = setInterval(() => {
      n -= 1;
      if (!cam) return;
      if (n <= 0) {
        clearInterval(cam.counting);
        cam.counting = null;
        c.classList.remove("show");
        return capture();
      }
      c.textContent = n;
      haptic();
    }, 1000);
  }
  async function capture() {
    const v = $("#camVideo", cam.el);
    if (!v || !v.videoWidth) return toast("The camera isn't ready yet.");
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    // the same centre crop to 3:4 that the frame shows
    let sw = vw;
    let sh = vh;
    if (vw / vh > 3 / 4) sw = Math.round(vh * 0.75);
    else sh = Math.round(vw / 0.75);
    const sx = Math.round((vw - sw) / 2);
    const sy = Math.round((vh - sh) / 2);
    const scale = Math.min(1, PHOTO_MAX / sh);
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, w, h); // saved the right way round, not mirrored
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
    c.width = c.height = 0;
    if (!blob) return toast("Couldn't take that photo. Try again.");
    haptic();
    const fl = document.createElement("div");
    fl.className = "cam-flash";
    cam.el.append(fl);
    setTimeout(() => fl.remove(), 400);
    stopStream();
    cam.shot = { blob, w, h, url: URL.createObjectURL(blob) };
    drawCamera();
  }
  async function useShot() {
    const { blob, w, h } = cam.shot;
    const target = { week: cam.week, pose: cam.pose };
    closeCamera();
    await sendPhoto(async () => {
      const b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).replace(/^data:[^,]*,/, ""));
        fr.onerror = () => rej(new Error("Couldn't read that photo"));
        fr.readAsDataURL(blob);
      });
      return { b64, w, h };
    }, target);
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cam]");
    if (!b || !cam || b.disabled) return;
    e.stopPropagation();
    const a = b.dataset.cam;
    if (a === "close") return closeCamera();
    if (a === "flip") {
      cam.facing = cam.facing === "user" ? "environment" : "user";
      setPref("facing", cam.facing);
      drawCamera();
      return startStream();
    }
    if (a.startsWith("timer-")) {
      setPref("timer", a.slice(6));
      $$('[data-cam^="timer-"]', cam.el).forEach((x) => x.classList.toggle("on", x === b));
      return;
    }
    if (a.startsWith("from-")) {
      setPref("ghostFrom", a.slice(5));
      return drawCamera();
    }
    if (a === "shoot") return shoot();
    if (a === "retake") {
      URL.revokeObjectURL(cam.shot.url);
      cam.shot = null;
      drawCamera();
      return startStream();
    }
    if (a === "use") return useShot();
    if (a === "library") {
      const { week, pose } = cam;
      closeCamera();
      return startPhoto(week, pose);
    }
  }, true);
  document.addEventListener("visibilitychange", () => {
    // iOS stops the camera when the app goes to the background; start it again on return
    if (document.visibilityState === "visible" && cam && !cam.shot) startStream();
  });

  function openPhoto(id) {
    const p = S.data.photos.find((x) => x.id === id);
    if (!p) return;
    const n = setts() ? Math.floor(daysBetween(setts().start_date, p.week) / 7) + 1 : null;
    const a = avgBetween(p.week, addDays(p.week, 6)).avg;
    openSheet(`${POSE[p.pose]} · ${n && n > 0 ? `Week ${n}` : weekRange(p.week)}`, `
      <div class="viewer"><img src="${photoUrl(p)}" alt="${POSE[p.pose]} photo, ${dayLabel(p.day)}"></div>
      <p class="hint" style="margin:10px 0 14px">Taken ${dayLabel(p.day)}${a != null ? ` · that week's average ${kg(a)} kg` : ""}</p>
      <div class="btn-row">
        <button class="btn ghost" id="phSwap">${ic("swap")} Swap it</button>
        <button class="btn danger" id="phDel">${ic("trash")} Delete</button>
      </div>`, (sh) => {
      $("#phSwap", sh).onclick = () => {
        closeSheet();
        openCamera(p.week, p.pose);
      };
      $("#phDel", sh).onclick = async () => {
        if (!confirm(`Delete this ${POSE[p.pose].toLowerCase()} photo?`)) return;
        try {
          const r = await api(`/cut/photos/${p.id}`, { method: "DELETE" });
          setData(r.state);
          closeSheet();
          rerender();
          toast("Photo deleted");
        } catch (e) {
          fail(e);
        }
      };
    });
  }

  // ---------- setup and settings ----------
  const LENGTHS = [12, 16, 20, 24, 26];
  function renderSetup() {
    const td = today();
    const lw = lastWeight();
    root().innerHTML = `
      <main class="view fade enter">
        <div class="topbar"><div class="title"><div class="logo-mark">${LOGO}</div><span>TrueStay Cut</span></div></div>
        <h1 class="hello rise" style="--i:0">Let's set up <em>the cut.</em></h1>
        <form class="form rise" style="--i:1" id="setupForm" novalidate>
          <div class="two">
            <div class="field"><label for="s-start">Starts</label><input id="s-start" type="date" value="${td}"></div>
            <div class="field"><label for="s-wt">Today's weight <span>kg</span></label><input id="s-wt" inputmode="decimal" autocomplete="off" placeholder="e.g. 92.4" value="${lw ? kg(lw.weight) : ""}"></div>
          </div>
          <div class="field"><span class="lab">How long</span><div class="opts" data-name="len">${LENGTHS.map((n) => `<button type="button" class="opt${n === 24 ? " on" : ""}" data-val="${n}">${n} wks</button>`).join("")}</div></div>
          <p class="hint" id="s-end-l"></p>
          <div class="three">
            <div class="field"><label for="s-steps">Steps a day</label><input id="s-steps" inputmode="numeric" value="10,000"></div>
            <div class="field"><label for="s-kcal">Calories</label><input id="s-kcal" inputmode="numeric" placeholder="2,200"></div>
            <div class="field"><label for="s-wo">Workouts/wk</label><input id="s-wo" inputmode="numeric" value="4"></div>
          </div>
          <div class="field"><label for="s-waist">Waist today <span>optional</span></label>
            <div class="tk-num" style="border-top:0;margin-top:0;padding-top:0">
              <input id="s-waist" inputmode="decimal" autocomplete="off" placeholder="Tape at your belly button">
              <div class="opts" data-name="wunit" style="flex:0 0 auto;flex-wrap:nowrap"><button type="button" class="opt on" data-val="cm">cm</button><button type="button" class="opt" data-val="in">in</button></div>
            </div>
          </div>
          <div class="field"><label for="s-goal">Rough goal weight <span>optional</span></label><input id="s-goal" inputmode="decimal" autocomplete="off" placeholder="Leave it blank if it's about the mirror"></div>
          <p class="hint">Targets can change any time. Changing one only counts from that day on, so earlier weeks keep their scores.</p>
          <div class="form-err" id="s-err"></div>
          <button class="btn lime" type="submit">Start the cut</button>
        </form>
      </main>`;
    const len = $('[data-name="len"]');
    let weeks = 24;
    const endFor = () => addDays($("#s-start").value || td, weeks * 7 - 1);
    const showEnd = () => ($("#s-end-l").textContent = `Ends ${dayLabel(endFor())}`);
    len.onclick = (e) => {
      const b = e.target.closest(".opt");
      if (!b) return;
      weeks = Number(b.dataset.val);
      $$(".opt", len).forEach((x) => x.classList.toggle("on", x === b));
      showEnd();
    };
    $("#s-start").onchange = showEnd;
    showEnd();
    const wu = $('[data-name="wunit"]');
    let unit = "cm";
    wu.onclick = (e) => {
      const b = e.target.closest(".opt");
      if (!b) return;
      unit = b.dataset.val;
      $$(".opt", wu).forEach((x) => x.classList.toggle("on", x === b));
    };
    $("#setupForm").onsubmit = async (e) => {
      e.preventDefault();
      const err = $("#s-err");
      err.textContent = "";
      const start = $("#s-start").value;
      if (!start) return (err.textContent = "Pick when it starts.");
      const wt = numFrom($("#s-wt").value);
      try {
        const r = await api("/cut/settings", {
          method: "POST",
          body: {
            start_date: start,
            end_date: endFor(),
            goal_kg: numFrom($("#s-goal").value),
            waist_unit: unit,
            targets: { steps: numFrom($("#s-steps").value), kcal: numFrom($("#s-kcal").value), workouts: numFrom($("#s-wo").value) },
          },
        });
        setData(r.state);
        if (wt != null && start <= td) await saveDay(td, { weight: wt });
        const wv = numFrom($("#s-waist").value);
        if (wv != null && start <= td) {
          try {
            const r2 = await api(`/cut/waist/${td}`, { method: "PUT", body: { cm: Math.round((unit === "in" ? wv * 2.54 : wv) * 10) / 10 } });
            setData(r2.state);
          } catch (x) {
            fail(x);
          }
        }
        S.tab = "today";
        render("fade");
        toast("You're set. Weigh in each morning.");
      } catch (x) {
        err.textContent = x.message;
      }
    };
  }
  function openSettings() {
    const s = setts();
    const td = today();
    const t = targetOn(td);
    const ph = phase(td);
    const theme = pref("theme", "system");
    openSheet("Settings", `
      <div class="group-title" style="margin-top:4px">Targets from today</div>
      <form class="form" id="tForm" novalidate>
        <div class="three">
          <div class="field"><label for="t-steps">Steps a day</label><input id="t-steps" inputmode="numeric" value="${t.steps != null ? nfmt(t.steps) : ""}"></div>
          <div class="field"><label for="t-kcal">Calories</label><input id="t-kcal" inputmode="numeric" value="${t.kcal != null ? nfmt(t.kcal) : ""}"></div>
          <div class="field"><label for="t-wo">Workouts/wk</label><input id="t-wo" inputmode="numeric" value="${t.workouts ?? ""}"></div>
        </div>
        <div class="form-err" id="t-err"></div>
        <button class="btn lime" type="submit">Save targets</button>
      </form>
      ${
        S.data.targets.length > 1
          ? `<div class="group-title">Target history</div><div class="card target-hist" style="margin-top:0;padding:4px 14px">${S.data.targets
              .slice()
              .reverse()
              .map(
                (x, i, arr) => `<div class="mrow"><span>From ${dayLabel(x.from_day)}<small>${[x.steps != null ? `${nfmt(x.steps)} steps` : null, x.kcal != null ? `${nfmt(x.kcal)} kcal` : null, x.workouts != null ? `${x.workouts} workouts` : null].filter(Boolean).join(" · ") || "No targets"}</small></span>${i < arr.length - 1 ? `<button class="linkish" data-deltarget="${x.id}">Remove</button>` : `<span class="r"><small>start</small></span>`}</div>`
              )
              .join("")}</div>`
          : ""
      }

      <div class="group-title">The phase</div>
      <form class="form" id="pForm" novalidate>
        <div class="two">
          <div class="field"><label for="p-start">Started</label><input id="p-start" type="date" value="${s.start_date}"></div>
          <div class="field"><label for="p-end">Ends</label><input id="p-end" type="date" value="${s.end_date}"></div>
        </div>
        <div class="field"><label for="p-goal">Rough goal weight <span>optional, kg</span></label><input id="p-goal" inputmode="decimal" autocomplete="off" value="${s.goal_kg != null ? kg(s.goal_kg) : ""}" placeholder="It's about the mirror"></div>
        <p class="hint">${ph ? `${ph.total} weeks in all${ph.week ? `, you're in week ${ph.week}` : ""}.` : ""}</p>
        <div class="form-err" id="p-err"></div>
        <button class="btn" type="submit">Save the phase</button>
      </form>

      <div class="group-title">Waist in</div>
      <div class="seg" style="margin-bottom:6px">${[["cm", "Centimetres"], ["in", "Inches"]].map(([k, l]) => `<button class="${wUnit() === k ? "on" : ""}" data-wunit="${k}">${l}</button>`).join("")}</div>
      <p class="hint" style="margin-bottom:6px">Saved in cm either way, so switching never changes your numbers.</p>

      <div class="group-title">Look</div>
      <div class="seg" style="margin-bottom:14px">${[["system", "Phone"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => `<button class="${theme === k ? "on" : ""}" data-theme-set="${k}">${l}</button>`).join("")}</div>

      <div class="group" style="margin-top:6px">
        <a class="row" href="/pay/"><span class="ic">${ic("faceid")}</span><span class="l">Face ID and sign in<small>Shared with TrueStay Pay. Change them there.</small></span><span class="r">${ic("right")}</span></a>
        <button class="row danger" data-action="logout"><span class="ic">${ic("out")}</span><span class="l">Sign out</span></button>
      </div>`, (sh) => {
      $("#tForm", sh).onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api("/cut/targets", {
            method: "POST",
            body: { from_day: td, steps: numFrom($("#t-steps", sh).value), kcal: numFrom($("#t-kcal", sh).value), workouts: numFrom($("#t-wo", sh).value) },
          });
          setData(r.state);
          closeSheet();
          rerender();
          toast("Targets saved from today");
        } catch (x) {
          $("#t-err", sh).textContent = x.message;
        }
      };
      $("#pForm", sh).onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api("/cut/settings", {
            method: "POST",
            body: { start_date: $("#p-start", sh).value, end_date: $("#p-end", sh).value, goal_kg: numFrom($("#p-goal", sh).value) },
          });
          setData(r.state);
          closeSheet();
          rerender();
          toast("Saved");
        } catch (x) {
          $("#p-err", sh).textContent = x.message;
        }
      };
    });
  }

  // ---------- data ----------
  async function refresh(quiet) {
    try {
      setData(await api("/cut/state"));
      rerender();
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
          <h1>The cut, <em>tracked.</em></h1>
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
    const el = e.target.closest(
      "[data-tab],[data-day],[data-goday],[data-tick],[data-wstep],[data-waiststep],[data-wunit],[data-nstep],[data-range],[data-pose],[data-addphoto],[data-photo],[data-theme-set],[data-deltarget],[data-action]"
    );
    if (!el || el.disabled) return;
    const d = el.dataset;
    if (d.tab) {
      if (d.tab === S.tab) return window.scrollTo({ top: 0, behavior: "smooth" });
      S.tab = d.tab;
      render("fade");
      return window.scrollTo(0, 0);
    }
    if (d.day) {
      if (d.day > today()) return;
      S.day = d.day;
      return rerender();
    }
    if (d.goday) {
      S.day = d.goday;
      rerender();
      return window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (d.tick) return toggleTick(d.tick);
    if (d.wstep) return stepWeight(Number(d.wstep));
    if (d.waiststep) return stepWaist(Number(d.waiststep));
    if (d.wunit) {
      if (d.wunit === wUnit()) return;
      try {
        const r = await api("/cut/settings", { method: "POST", body: { waist_unit: d.wunit } });
        setData(r.state);
        $$("[data-wunit]").forEach((b) => b.classList.toggle("on", b === el));
        rerender();
      } catch (x) {
        fail(x);
      }
      return;
    }
    if (d.nstep) return stepNum(d.nstep, Number(d.by));
    if (d.range) {
      S.range = d.range;
      setPref("range", d.range);
      return rerender();
    }
    if (d.pose) {
      S.pose = d.pose;
      S.cmpA = S.cmpB = null;
      return rerender();
    }
    if (d.addphoto) return openCamera(d.week, d.addphoto);
    if (d.photo) return openPhoto(Number(d.photo));
    if (d.themeSet) {
      setPref("theme", d.themeSet);
      applyTheme(d.themeSet);
      $$("[data-theme-set]").forEach((b) => b.classList.toggle("on", b === el));
      return;
    }
    if (d.deltarget) {
      if (!confirm("Remove this change to your targets? The days it covered go back to the targets before it.")) return;
      try {
        const r = await api(`/cut/targets/${d.deltarget}`, { method: "DELETE" });
        setData(r.state);
        closeSheet();
        rerender();
        toast("Removed");
      } catch (x) {
        fail(x);
      }
      return;
    }
    if (d.action === "settings") return openSettings();
    if (d.action === "logout") {
      try {
        await api("/logout", { method: "POST", raw: true });
      } catch {}
      S.data = null;
      renderLogin();
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-goday][role=button]")) {
      e.preventDefault();
      e.target.click();
    }
    if (e.key === "Escape") {
      if (cam) return closeCamera();
      closeSheet();
    }
  });
  $("#picker").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f && addTo) uploadPhoto(f, addTo);
  });
  window.addEventListener("resize", () => S.tab === "progress" && drawChart());

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
      const wasToday = S.day === S.data.today;
      setData(await api("/cut/state"));
      if (wasToday) S.day = S.data.today; // a new morning moves you on to the new day
      if (!sheet && !document.activeElement?.matches("input")) rerender();
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
        root().innerHTML = `<div class="lock-screen"><div class="logo-mark big">${LOGO}</div><h1>Set up TrueStay Pay first</h1><p>Cut uses the same sign in.</p><a class="btn lime" href="/pay/">Open TrueStay Pay</a></div>`;
        return;
      }
      if (!s.authed) return renderLogin();
      if (s.locked) return renderLock();
      S.locked = false;
      setData(await api("/cut/state"));
      S.lastSync = Date.now();
      render("fade");
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
