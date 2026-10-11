/* TrueStay Timer: HIIT and circuit class timer.
   Up to 20 stations, each with its own work time (or one time for all), a move time between stations,
   rounds with rest between them, and a get-ready countdown. Beeps, spoken station names, screen kept awake.
   No sign in and no server: setups are saved on this device (localStorage). */
(() => {
  "use strict";

  const MAX_STATIONS = 20;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, w, ws) => `${n} ${n === 1 ? w : ws || w + "s"}`;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const load = (k, d) => {
    try {
      const v = localStorage.getItem("tst." + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem("tst." + k, JSON.stringify(v));
    } catch {}
  };
  // 0:40, 1:30, 10:00
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const spoken = (s) => {
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return [m ? plural(m, "minute") : "", r ? plural(r, "second") : ""].filter(Boolean).join(" ");
  };
  const longTime = (s) => {
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return m ? (r ? `${m} min ${r} sec` : plural(m, "min")) : `${r} sec`;
  };

  const P = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
    next: '<path d="M5 5v14l10-7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>',
    prev: '<path d="M19 5v14L9 12z" fill="currentColor" stroke="none"/><path d="M6 5v14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="3"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8M7 21v-7h10v7"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    sound: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    restart: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>',
  };
  const ic = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;

  // ---------- the setup ----------
  const DEFAULT = () => ({
    name: "",
    stations: Array.from({ length: 8 }, () => ({ name: "", work: 40 })),
    sameWork: true,
    work: 40,
    move: 15,
    rounds: 2,
    roundRest: 60,
    ready: 10,
    sound: true,
    voice: true,
  });
  let C = Object.assign(DEFAULT(), load("last", {}));
  if (!Array.isArray(C.stations) || !C.stations.length) C.stations = DEFAULT().stations;
  const persist = () => save("last", C);
  const workOf = (i) => (C.sameWork ? C.work : C.stations[i].work);
  const stName = (i) => (C.stations[i]?.name || "").trim() || `Station ${i + 1}`;

  // the whole class as a list of timed parts
  function timeline() {
    const out = [];
    const n = C.stations.length;
    if (C.ready > 0) out.push({ type: "ready", dur: C.ready, st: 0, round: 1 });
    for (let r = 1; r <= C.rounds; r++) {
      for (let i = 0; i < n; i++) {
        out.push({ type: "work", dur: workOf(i), st: i, round: r });
        const lastInRound = i === n - 1;
        if (!lastInRound && C.move > 0) out.push({ type: "move", dur: C.move, st: i + 1, round: r });
      }
      if (r < C.rounds && C.roundRest > 0) out.push({ type: "rest", dur: C.roundRest, st: 0, round: r + 1 });
      else if (r < C.rounds && C.move > 0) out.push({ type: "move", dur: C.move, st: 0, round: r + 1 });
    }
    return out;
  }
  const totalSecs = () => timeline().reduce((a, s) => a + s.dur, 0);

  // ---------- setup screen ----------
  const root = () => $("#root");
  function stepper(key, val, label, { sm = false, i = null } = {}) {
    return `<div class="stepper${sm ? " sm" : ""}" role="group" aria-label="${esc(label)}">
      <button data-step="${key}" data-by="-1"${i != null ? ` data-i="${i}"` : ""} aria-label="${esc(label)} down">${ic("minus")}</button>
      <span class="v num" aria-live="polite">${key === "rounds" || key === "count" ? val : mmss(val)}</span>
      <button data-step="${key}" data-by="1"${i != null ? ` data-i="${i}"` : ""} aria-label="${esc(label)} up">${ic("plus")}</button>
    </div>`;
  }
  const sw = (key, on) => `<span class="sw${on ? " on" : ""}" aria-hidden="true"></span>`;
  function renderSetup() {
    const n = C.stations.length;
    const total = totalSecs();
    root().innerHTML = `
      <main class="wrap">
        <div class="top">
          <div class="brand">TrueStay <span>Timer</span></div>
          <div class="acts">
            <button class="pill" data-act="saved">${ic("list")} Saved</button>
          </div>
        </div>
        <h1 class="title">${C.name ? esc(C.name) : `Set up <span>the class</span>`}</h1>
        <p class="lede">Stations, work time, the move between them, rounds and rest. It saves itself on this phone.</p>

        <section class="card">
          <h2>The basics</h2>
          <div class="setting"><div class="l"><b>Stations</b><small>Up to ${MAX_STATIONS}</small></div>${stepper("count", n, "Stations")}</div>
          <button class="toggle" data-act="same" aria-pressed="${C.sameWork}"><span class="l"><b>Same work time for every station</b><small>${C.sameWork ? "Turn off to set each station's time" : "Each station has its own time below"}</small></span>${sw("same", C.sameWork)}</button>
          ${C.sameWork ? `<div class="setting"><div class="l"><b>Work</b><small>At each station</small></div>${stepper("work", C.work, "Work time")}</div>` : ""}
          <div class="setting"><div class="l"><b>Move</b><small>Changeover between stations</small></div>${stepper("move", C.move, "Move time")}</div>
          <div class="setting"><div class="l"><b>Rounds</b><small>Times through all the stations</small></div>${stepper("rounds", C.rounds, "Rounds")}</div>
          ${C.rounds > 1 ? `<div class="setting"><div class="l"><b>Rest between rounds</b><small>Water and a breather</small></div>${stepper("roundRest", C.roundRest, "Rest between rounds")}</div>` : ""}
          <div class="setting"><div class="l"><b>Get ready</b><small>Countdown before the first station</small></div>${stepper("ready", C.ready, "Get ready")}</div>
        </section>

        <section class="card">
          <div class="stations-head"><h2>Stations</h2><button class="link" data-act="paste">Paste a list</button></div>
          ${C.stations
            .map(
              (s, i) => `<div class="st${C.sameWork ? " same" : ""}">
                <span class="n">${i + 1}</span>
                <input data-name="${i}" value="${esc(s.name)}" placeholder="Station ${i + 1}" maxlength="40" autocomplete="off" enterkeyhint="next" aria-label="Station ${i + 1} name">
                ${C.sameWork ? "" : stepper("swork", s.work, `Station ${i + 1} work time`, { sm: true, i })}
                <button class="more" data-more="${i}" aria-label="Station ${i + 1} options">${ic("more")}</button>
              </div>`
            )
            .join("")}
        </section>

        <section class="card">
          <h2>Sound</h2>
          <button class="toggle" data-act="sound" aria-pressed="${C.sound}"><span class="l"><b>Beeps</b><small>3, 2, 1 and a beep on every change</small></span>${sw("sound", C.sound)}</button>
          <button class="toggle" data-act="voice" aria-pressed="${C.voice}"><span class="l"><b>Say the stations</b><small>"Move. Next, kettlebell swings"</small></span>${sw("voice", C.voice)}</button>
        </section>
        <p class="note">No beeps on an iPhone? Flick the silent switch off and turn the volume up. The screen stays on while the timer runs.</p>

        <div class="summary"><span>${plural(n, "station")} × ${plural(C.rounds, "round")}</span><span>Total <b class="num">${mmss(total)}</b></span></div>
      </main>
      <div class="startbar"><div class="inner"><button class="go" data-act="start">${ic("play")} Start</button></div></div>`;
  }

  // ---------- steppers (tap, or hold to keep going) ----------
  const STEP = { work: 5, swork: 5, move: 5, roundRest: 15, ready: 5, rounds: 1, count: 1 };
  const RANGE = { work: [5, 600], swork: [5, 600], move: [0, 300], roundRest: [0, 600], ready: [0, 60], rounds: [1, 10], count: [1, MAX_STATIONS] };
  function doStep(key, by, i) {
    const [lo, hi] = RANGE[key];
    const d = by * STEP[key];
    if (key === "count") {
      const n = clamp(C.stations.length + by, lo, hi);
      while (C.stations.length < n) C.stations.push({ name: "", work: C.work });
      while (C.stations.length > n) C.stations.pop();
    } else if (key === "swork") {
      C.stations[i].work = clamp(C.stations[i].work + d, lo, hi);
    } else {
      C[key] = clamp(C[key] + d, lo, hi);
    }
    persist();
    renderSetup();
  }
  let holdT = null;
  let holdN = 0;
  function stopHold() {
    clearTimeout(holdT);
    holdT = null;
  }
  document.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("[data-step]");
    if (!b || run) return;
    e.preventDefault();
    const key = b.dataset.step;
    const by = Number(b.dataset.by);
    const i = b.dataset.i != null ? Number(b.dataset.i) : null;
    doStep(key, by, i);
    holdN = 0;
    const again = () => {
      holdN++;
      doStep(key, by, i);
      holdT = setTimeout(again, holdN > 8 ? 60 : 140);
    };
    holdT = setTimeout(again, 420);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) => document.addEventListener(t, stopHold));
  document.addEventListener("keydown", (e) => {
    const b = e.target.closest?.("[data-step]");
    if (b && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      doStep(b.dataset.step, Number(b.dataset.by), b.dataset.i != null ? Number(b.dataset.i) : null);
    }
  });

  // ---------- sheets + toast ----------
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
  }
  function closeSheet(instant) {
    if (!sheet) return;
    const { bd, sh } = sheet;
    sheet = null;
    if (instant) return bd.remove(), sh.remove();
    bd.classList.remove("show");
    sh.classList.remove("show");
    setTimeout(() => (bd.remove(), sh.remove()), 400);
  }
  let toastT;
  function toast(msg) {
    const t = $("#toast");
    t.innerHTML = `<div>${esc(msg)}</div>`;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function stationMenu(i) {
    const n = C.stations.length;
    openSheet(stName(i), `
      <div class="menu">
        <button data-m="up" ${i === 0 ? "disabled" : ""}>${ic("up")} Move up</button>
        <button data-m="down" ${i === n - 1 ? "disabled" : ""}>${ic("down")} Move down</button>
        <button data-m="dup" ${n >= MAX_STATIONS ? "disabled" : ""}>${ic("copy")} Duplicate</button>
        <button data-m="del" class="danger" ${n <= 1 ? "disabled" : ""}>${ic("trash")} Remove</button>
      </div>`, (sh) => {
      sh.onclick = (e) => {
        const b = e.target.closest("[data-m]");
        if (!b || b.disabled) return;
        const m = b.dataset.m;
        const S = C.stations;
        if (m === "up") [S[i - 1], S[i]] = [S[i], S[i - 1]];
        if (m === "down") [S[i + 1], S[i]] = [S[i], S[i + 1]];
        if (m === "dup") S.splice(i + 1, 0, { ...S[i] });
        if (m === "del") S.splice(i, 1);
        persist();
        closeSheet();
        renderSetup();
      };
    });
  }
  function pasteSheet() {
    openSheet("Paste a list", `
      <div class="field"><label for="pl">One station per line. Up to ${MAX_STATIONS}.</label>
        <textarea id="pl" placeholder="Kettlebell swings&#10;Burpees&#10;Battle ropes&#10;Box jumps">${esc(C.stations.map((s) => s.name).filter(Boolean).join("\n"))}</textarea></div>
      <button class="btn orange" id="plGo">Use these stations</button>`, (sh) => {
      $("#plGo", sh).onclick = () => {
        const lines = $("#pl", sh)
          .value.split(/\r?\n/)
          .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim())
          .filter(Boolean)
          .slice(0, MAX_STATIONS);
        if (!lines.length) return toast("Put at least one station in.");
        C.stations = lines.map((name, i) => ({ name, work: C.stations[i]?.work ?? C.work }));
        persist();
        closeSheet();
        renderSetup();
        toast(`${plural(lines.length, "station")} set`);
      };
    });
  }
  function savedSheet() {
    const list = load("saved", []);
    openSheet("Saved classes", `
      <div class="field"><label for="svName">Save this setup as</label><input id="svName" maxlength="40" placeholder="e.g. Saturday HIIT" value="${esc(C.name)}"></div>
      <button class="btn" id="svGo">${ic("save")} Save</button>
      ${
        list.length
          ? list
              .map(
                (x, k) => `<div class="saved"><div class="l"><b>${esc(x.name)}</b><small>${plural(x.cfg.stations.length, "station")} × ${plural(x.cfg.rounds, "round")} · ${mmss(totalOf(x.cfg))}</small></div><button class="load" data-load="${k}">Load</button><button class="del" data-del="${k}" aria-label="Delete ${esc(x.name)}">${ic("trash")}</button></div>`
              )
              .join("")
          : `<div class="empty">Nothing saved yet. Set a class up and save it here to use again.</div>`
      }
      <button class="btn ghost" id="svNew">${ic("restart")} Start a fresh setup</button>`, (sh) => {
      $("#svGo", sh).onclick = () => {
        const name = $("#svName", sh).value.trim();
        if (!name) return toast("Give it a name first.");
        C.name = name;
        const all = load("saved", []).filter((x) => x.name.toLowerCase() !== name.toLowerCase());
        all.unshift({ name, cfg: JSON.parse(JSON.stringify(C)) });
        save("saved", all.slice(0, 40));
        persist();
        closeSheet();
        renderSetup();
        toast(`Saved as ${name}`);
      };
      $("#svNew", sh).onclick = () => {
        C = { ...DEFAULT(), sound: C.sound, voice: C.voice };
        persist();
        closeSheet();
        renderSetup();
      };
      sh.addEventListener("click", (e) => {
        const ld = e.target.closest("[data-load]");
        const dl = e.target.closest("[data-del]");
        if (ld) {
          C = Object.assign(DEFAULT(), JSON.parse(JSON.stringify(list[Number(ld.dataset.load)].cfg)));
          persist();
          closeSheet();
          renderSetup();
          toast(`${C.name} loaded`);
        }
        if (dl) {
          const x = list[Number(dl.dataset.del)];
          if (!confirm(`Delete ${x.name}?`)) return;
          save("saved", list.filter((_, k) => k !== Number(dl.dataset.del)));
          savedSheet();
        }
      });
    });
  }
  function totalOf(cfg) {
    const keep = C;
    C = Object.assign(DEFAULT(), cfg);
    const t = totalSecs();
    C = keep;
    return t;
  }

  // ---------- sound, voice, screen ----------
  let actx = null;
  function unlockAudio() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback"; // plays with the silent switch on, where Safari allows it
    } catch {}
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const b = actx.createBuffer(1, 1, 22050);
      const s = actx.createBufferSource();
      s.buffer = b;
      s.connect(actx.destination);
      s.start(0);
    } catch {}
    if (C.voice && "speechSynthesis" in window) {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch {}
    }
  }
  function beep(freq = 880, dur = 0.12, vol = 0.5, at = 0) {
    if (!C.sound || !actx) return;
    try {
      const t = actx.currentTime + at;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    } catch {}
  }
  let enVoice = null;
  function pickVoice() {
    try {
      const vs = speechSynthesis.getVoices();
      enVoice = vs.find((v) => v.lang === "en-GB") || vs.find((v) => /^en/.test(v.lang)) || null;
    } catch {}
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }
  function say(text) {
    if (!C.voice || !("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (enVoice) u.voice = enVoice;
      u.lang = "en-GB";
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch {}
  }
  let wake = null;
  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && !wake) {
        wake = await navigator.wakeLock.request("screen");
        wake.addEventListener("release", () => (wake = null));
      }
    } catch {}
  }
  function letSleep() {
    try {
      wake && wake.release();
    } catch {}
    wake = null;
  }

  // ---------- running ----------
  // Time is worked out from the clock, not counted by a timer, so it stays right even if the phone
  // lags or the app goes into the background for a moment.
  let run = null;
  const PHASE = { ready: "Get ready", work: "Work", move: "Move", rest: "Rest", done: "Done" };
  function start() {
    unlockAudio();
    const tl = timeline();
    if (!tl.length) return;
    run = { tl, i: 0, end: 0, paused: false, left: 0, lastSec: null, raf: 0, iv: 0, total: tl.reduce((a, s) => a + s.dur, 0) };
    document.body.style.overflow = "hidden";
    const el = document.createElement("div");
    el.className = "run";
    el.id = "run";
    el.setAttribute("role", "timer");
    document.body.append(el);
    keepAwake();
    enter(0);
    run.iv = setInterval(tick, 200);
    const loop = () => {
      if (!run) return;
      tick();
      run.raf = requestAnimationFrame(loop);
    };
    run.raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (!run) return;
    clearInterval(run.iv);
    cancelAnimationFrame(run.raf);
    run = null;
    $("#run")?.remove();
    document.body.style.overflow = "";
    letSleep();
    try {
      speechSynthesis.cancel();
    } catch {}
    renderSetup();
  }
  const now = () => performance.now();
  function enter(i, quiet) {
    run.i = i;
    if (i >= run.tl.length) return finish();
    const s = run.tl[i];
    run.end = now() + s.dur * 1000;
    run.left = s.dur * 1000;
    run.lastSec = null;
    drawRun();
    if (quiet) return;
    if (s.type === "work") {
      beep(1320, 0.45, 0.6);
      const prev = run.tl[i - 1];
      if (!prev || prev.type === "ready") say(`Go. ${stName(s.st)}`);
      else if (prev.type !== "move") say(`Go. ${stName(s.st)}`);
      else say("Go");
    } else if (s.type === "move") {
      beep(660, 0.35, 0.55);
      beep(660, 0.35, 0.55, 0.45);
      say(`Move. Next, ${stName(s.st)}`);
    } else if (s.type === "rest") {
      beep(520, 0.6, 0.55);
      say(`Rest. ${spoken(s.dur)}. Round ${s.round} next`);
    } else if (s.type === "ready") {
      say(`Get ready. First up, ${stName(s.st)}`);
    }
  }
  function finish() {
    clearInterval(run.iv);
    cancelAnimationFrame(run.raf);
    beep(1320, 0.2, 0.6);
    beep(1320, 0.2, 0.6, 0.28);
    beep(1760, 0.6, 0.6, 0.56);
    say("Done. Great work.");
    run.done = true;
    const el = $("#run");
    el.className = "run done";
    el.innerHTML = `
      <div class="run-top"><div class="meta"><span>${esc(C.name || "Class")}</span></div><button class="rbtn" data-r="close" aria-label="Close">${ic("x")}</button></div>
      <div class="run-mid"><div class="done-box"><div class="big">Done</div><p>${plural(C.stations.length, "station")} × ${plural(C.rounds, "round")} · ${longTime(run.total)}</p></div></div>
      <div class="done-actions"><button class="btn" data-r="close">Back to setup</button><button class="btn orange" data-r="again">${ic("restart")} Go again</button></div>`;
    letSleep();
  }
  function remainingTotal() {
    let r = run.paused ? run.left : Math.max(0, run.end - now());
    for (let k = run.i + 1; k < run.tl.length; k++) r += run.tl[k].dur * 1000;
    return r / 1000;
  }
  function nextWorkAfter(i) {
    for (let k = i + 1; k < run.tl.length; k++) if (run.tl[k].type === "work") return run.tl[k];
    return null;
  }
  function drawRun() {
    const s = run.tl[run.i];
    const el = $("#run");
    el.className = `run ${s.type}`;
    const n = C.stations.length;
    const nw = nextWorkAfter(run.i);
    // what the big name shows: the station you're on, or during move/rest/ready, the one you're heading to
    const head = stName(s.st);
    const sub = s.type === "work" ? `Station ${s.st + 1} of ${n}` : s.type === "rest" ? `Round ${s.round} starts at` : "Up next";
    const nextLine =
      s.type === "work"
        ? nw
          ? `Next: <b>${esc(stName(nw.st))}</b>${nw.round !== s.round ? ` · round ${nw.round}` : ""}`
          : "Last one. Empty the tank"
        : s.type === "move"
        ? `Station ${s.st + 1} of ${n} · ${mmss(workOf(s.st))} of work`
        : s.type === "rest"
        ? `${plural(C.rounds - s.round + 1, "round")} to go`
        : `${plural(n, "station")} × ${plural(C.rounds, "round")}`;
    el.innerHTML = `
      <div class="run-top">
        <div class="meta"><span>Round <b class="num">${s.round}/${C.rounds}</b></span><span>Left <b class="num" id="rTotal">${mmss(Math.ceil(remainingTotal()))}</b></span></div>
        <button class="rbtn" data-r="close" aria-label="End the class">${ic("x")}</button>
      </div>
      <div class="run-mid">
        <div class="phase">${s.type === "move" ? ic("arrow") : ""}${PHASE[s.type]}</div>
        <div class="clock num" id="rClock" aria-live="off">${mmss(s.dur)}</div>
        <div class="station"><small>${esc(sub)}</small>${esc(head)}</div>
        <div class="next">${nextLine}</div>
      </div>
      <div>
        <div class="bar" aria-hidden="true"><i id="rBar"></i></div>
        <div class="run-ctrls">
          <div class="side"><button class="rbtn" data-r="prev" aria-label="Back">${ic("prev")}</button></div>
          <button class="bigbtn" data-r="pause" aria-label="${run.paused ? "Carry on" : "Pause"}">${ic(run.paused ? "play" : "pause")}</button>
          <div class="side r"><button class="rbtn" data-r="next" aria-label="Skip">${ic("next")}</button></div>
        </div>
      </div>
      ${run.paused ? `<div class="paused-tag">Paused</div>` : ""}`;
    fitClock(mmss(s.dur));
    tick(true);
  }
  // the clock is as big as the screen allows: shrink it until the longest time in this part fits across
  function fitClock(widest) {
    const c = $("#rClock");
    if (!c) return;
    const keep = c.textContent;
    c.style.fontSize = "";
    c.textContent = widest;
    let fs = parseFloat(getComputedStyle(c).fontSize);
    let guard = 0;
    while (c.scrollWidth > c.clientWidth + 1 && guard++ < 60) {
      fs *= 0.95;
      c.style.fontSize = fs + "px";
    }
    c.textContent = keep;
  }
  function tick(force) {
    if (!run || run.done) return;
    if (!run.paused) {
      // catch up if more than one part ended (e.g. the phone slept)
      // the next part starts exactly when the last one was due to end, so nothing drifts
      let guard = 0;
      while (now() >= run.end && guard++ < 200) {
        const due = run.end;
        const late = now() - due;
        const nextI = run.i + 1;
        if (nextI >= run.tl.length) return finish();
        enter(nextI, late > 1500); // stay quiet for parts that were missed while the phone slept
        run.end = due + run.tl[nextI].dur * 1000;
      }
    }
    const s = run.tl[run.i];
    const leftMs = run.paused ? run.left : Math.max(0, run.end - now());
    const sec = Math.ceil(leftMs / 1000);
    const clock = $("#rClock");
    if (clock) {
      const txt = mmss(sec);
      if (clock.textContent !== txt || force) clock.textContent = txt;
      clock.classList.toggle("last", !run.paused && sec <= 3 && sec > 0);
    }
    const bar = $("#rBar");
    if (bar) bar.style.width = `${(1 - leftMs / (s.dur * 1000)) * 100}%`;
    const tot = $("#rTotal");
    if (tot) tot.textContent = mmss(Math.ceil(remainingTotal()));
    if (!run.paused && sec !== run.lastSec) {
      if (run.lastSec != null && sec <= 3 && sec >= 1) beep(880, 0.12, 0.5);
      if (s.type === "work" && s.dur >= 30 && sec === Math.floor(s.dur / 2) && run.lastSec != null && C.voice) say("Halfway");
      if (s.type === "work" && sec === 10 && s.dur > 20 && run.lastSec != null) say("Ten seconds");
      run.lastSec = sec;
    }
  }
  function togglePause() {
    if (!run || run.done) return;
    if (run.paused) {
      run.paused = false;
      run.end = now() + run.left;
      keepAwake();
    } else {
      run.paused = true;
      run.left = Math.max(0, run.end - now());
      try {
        speechSynthesis.cancel();
      } catch {}
    }
    drawRun();
  }
  function skip(dir) {
    if (!run || run.done) return;
    const s = run.tl[run.i];
    const elapsed = s.dur * 1000 - (run.paused ? run.left : Math.max(0, run.end - now()));
    let to = run.i + dir;
    if (dir < 0 && elapsed > 2500) to = run.i; // back once restarts this part; twice goes to the one before
    to = clamp(to, 0, run.tl.length);
    const wasPaused = run.paused;
    run.paused = false;
    enter(to);
    if (wasPaused && run && !run.done) {
      run.paused = true;
      run.left = run.tl[run.i].dur * 1000;
      drawRun();
    }
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return closeSheet();
    const r = e.target.closest("[data-r]");
    if (r && run) {
      const a = r.dataset.r;
      if (a === "pause") return togglePause();
      if (a === "next") return skip(1);
      if (a === "prev") return skip(-1);
      if (a === "again") {
        stop();
        return start();
      }
      if (a === "close") {
        if (!run.done && !confirm("End the class?")) return;
        return stop();
      }
      return;
    }
    const a = e.target.closest("[data-act]");
    const m = e.target.closest("[data-more]");
    if (m) return stationMenu(Number(m.dataset.more));
    if (!a) return;
    const act = a.dataset.act;
    if (act === "start") return start();
    if (act === "saved") return savedSheet();
    if (act === "paste") return pasteSheet();
    if (act === "same" || act === "sound" || act === "voice") {
      const key = act === "same" ? "sameWork" : act;
      C[key] = !C[key];
      if (key === "sameWork" && !C.sameWork) C.stations.forEach((s) => (s.work = C.work));
      persist();
      renderSetup();
    }
  });
  document.addEventListener("input", (e) => {
    const inp = e.target.closest("[data-name]");
    if (!inp) return;
    C.stations[Number(inp.dataset.name)].name = inp.value;
    persist();
  });
  document.addEventListener("keydown", (e) => {
    const inp = e.target.closest?.("[data-name]");
    if (inp && e.key === "Enter") {
      e.preventDefault();
      const nx = $(`[data-name="${Number(inp.dataset.name) + 1}"]`);
      nx ? nx.focus() : inp.blur();
    }
    if (run && !run.done && e.target === document.body) {
      if (e.key === " ") {
        e.preventDefault();
        togglePause();
      }
      if (e.key === "ArrowRight") skip(1);
      if (e.key === "ArrowLeft") skip(-1);
    }
    if (e.key === "Escape") closeSheet();
  });
  window.addEventListener("resize", () => {
    if (run && !run.done) fitClock(mmss(run.tl[run.i].dur));
  });
  document.fonts?.ready.then(() => run && !run.done && fitClock(mmss(run.tl[run.i].dur)));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && run && !run.done) {
      keepAwake();
      if (actx && actx.state === "suspended") actx.resume().catch(() => {});
      tick(true);
    }
  });

  renderSetup();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
