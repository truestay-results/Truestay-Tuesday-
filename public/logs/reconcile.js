/* TrueStay Logs: putting one day together from its screenshots, and saying how sure we are.
   Shared by the app (day cards, averages) and the PDF. No DOM, no network.

   Where a day's food comes from, best first:
   1. A whole-day total the app shows (dashboard, diary total, day view). Meal screenshots from the same day
      are only used to check it; they're never added on top.
   2. Otherwise the day is added up from its meal screenshots: one per meal, repeats dropped, a meal sent
      twice counted once (the later one).
   3. Nothing else. A single meal is never promoted to the day's total, and nothing is guessed.

   Every day then gets a confidence for calories, for macros and for steps:
   - high: a whole-day total that hangs together (and matches the meals when both were sent)
   - medium: added up from clearly named meals, or a day total with one meal section empty
   - low: a partial day (sections empty and the total well short of normal), a running total taken early,
     meals missing, screenshots that disagree, food logged without macros, or a number we couldn't be sure of.
   Averages only use high and medium days, and say how many they left out and why. Shan can overrule a day
   ("Count it" / "Leave it out"), and numbers he types on a screenshot always win. */
(function (root) {
  "use strict";

  const MAIN = ["breakfast", "lunch", "dinner"];
  const SLOTS = ["breakfast", "lunch", "dinner", "snacks"];
  const SLOT_NAME = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snacks: "Snacks" };
  const RANK = { low: 0, medium: 1, high: 2 };
  const lower = (a, b) => (RANK[a] <= RANK[b] ? a : b);

  const ALC = /\b(wine|prosecco|champagne|cava|cr[eé]mant|beer|ale|ipa|lager|stout|porter|pilsner|bitter|cider|gin|vodka|rum|whisk(?:e)?y|bourbon|scotch|tequila|mezcal|brandy|cognac|liqueur|schnapps|sambuca|baileys|port|sherry|vermouth|aperol|spritz|cocktail|margarita|mojito|martini|negroni|daiquiri|pimm'?s|rioja|merlot|shiraz|malbec|sauvignon|pinot|chardonnay|ros[eé]|riesling|tempranillo|cabernet|grenache|zinfandel|moscato|sangria|alcohol|alcoholic)\b/i;
  const NOT_ALC = /vinegar|gum\b|sauce|jelly|gravy|reduction|cooking|non[- ]?alcoholic|alcohol[- ]free|\b0(?:\.[05])?\s*%|\bzero\b|\b0\.0\b/i;
  const isAlcohol = (name) => !!name && ALC.test(name) && !NOT_ALC.test(name);

  const energy = (p, c, f) => (p == null || c == null || f == null ? null : 4 * p + 4 * c + 9 * f);
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const fmt = (v) => Math.round(v).toLocaleString("en-GB");
  const listAnd = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const isFood = (it) => it.kind === "food" || it.kind === "food_steps";
  const v2 = (it) => !!(it.r && it.r.v >= 2);

  // Shan's word on a screenshot beats the reader's: numbers he typed, or "these are the whole day's" / "one meal's"
  const override = (it) => !!(it.edited || it.scope);
  function roleOf(it) {
    if (it.scope === "day" || it.scope === "meal") return it.scope;
    if (v2(it)) return it.r.screen === "day_summary" ? "day" : ["meal", "diary_part", "food_item"].includes(it.r.screen) ? "meal" : "day";
    return "day";
  }

  // A meal's total as printed; if it isn't printed, its foods added up, but only when the meal's name shows (so the
  // list starts at the top) and nothing runs off the screen.
  function mealKcal(m) {
    if (m.kcal != null) return { kcal: m.kcal, derived: false };
    const foods = m.foods || [];
    if ((m.slot || m.name) && m.full !== false && foods.length && foods.every((f) => f.kcal != null)) return { kcal: r1(foods.reduce((a, f) => a + f.kcal, 0)), derived: true };
    return { kcal: null, derived: false };
  }
  const mealLabel = (m) => (m.slot && SLOT_NAME[m.slot]) || m.name || "A meal";
  const sameNums = (a, b) => a.kcal != null && b.kcal != null && Math.abs(a.kcal - b.kcal) <= 1 && (a.protein == null || b.protein == null || Math.abs(a.protein - b.protein) <= 0.6);

  // ---------- dates (UK) ----------
  const UKF = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function ukParts(t) {
    const p = Object.fromEntries(UKF.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute, hour: +p.hour % 24 };
  }
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
  const dObj = (iso) => new Date(iso + "T12:00:00Z");
  const daysBetween = (a, b) => Math.round((dObj(b) - dObj(a)) / 86400000);
  const WD_LONG = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  // ---------- which day a screenshot belongs to ----------
  // Priority: set by you > a date printed on the screenshot > when it was sent (from the file name or the photo)
  // > when you shared it (only for small, nightly shares; a big batch shared later can't be dated that way).
  function sessionSizes(items) {
    const by = new Map();
    for (const it of items) {
      const k = it.batch || it.source;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(it);
    }
    const size = new Map();
    for (const list of by.values()) {
      list.sort((a, b) => a.received_at - b.received_at || a.id - b.id);
      let start = 0;
      for (let i = 1; i <= list.length; i++) {
        if (i === list.length || list[i].received_at - list[i - 1].received_at > 600) {
          for (let j = start; j < i; j++) size.set(list[j].id, i - start);
          start = i;
        }
      }
    }
    return size;
  }
  function withYear(s, refT) {
    const ref = ukParts(refT).date;
    let iso = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && validISO(s) && Math.abs(daysBetween(s, ref)) <= 60) iso = s;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = s.slice(5);
    if (!iso && /^\d{2}-\d{2}$/.test(s)) {
      const y = +ref.slice(0, 4);
      iso = `${y}-${s}`;
      if (validISO(iso) && iso > addDays(ref, 2)) iso = `${y - 1}-${s}`;
    }
    if (!iso || !validISO(iso)) return null;
    if (iso > addDays(ref, 2) || iso < addDays(ref, -400)) return null;
    return iso;
  }
  // Also works out when it was taken, for putting a day together: t (for ordering), clockMin (the time on the
  // phone when it was taken) and lag (0 = taken on the day it's for, 1 = the next day, e.g. last night's log
  // sent after midnight, or a "Yesterday" screen).
  function effDay(it, sizes) {
    const r = it.r || {};
    const m = String(r.clock || "").match(/^(\d{2}):(\d{2})$/);
    const clock = m ? +m[1] * 60 + +m[2] : null;
    const t = it.sent_at || it.received_at;
    if (it.day && it.day_src === "manual") return { day: it.day, src: "manual", t, clockMin: clock, lag: null };
    let ref = null;
    if (it.sent_at) ref = { t: it.sent_at, src: it.sent_src === "photo" ? "photo" : it.sent_src === "name_day" ? "sentday" : "sent" };
    else if (it.source === "share" && (sizes.get(it.id) || 1) <= 4) ref = { t: it.received_at, src: "shared" };
    const p = ref ? ukParts(ref.t) : null;
    // the day the picture was taken: the day it was sent, or the day before if the phone's clock says it was taken before midnight
    let taken = p ? p.date : null;
    if (p && ref.src !== "sentday" && clock != null && clock > p.min + 180) taken = addDays(taken, -1);
    const lagFrom = (day) => (taken && day ? Math.max(0, daysBetween(day, taken)) : null);
    if (r.date) {
      const d = withYear(r.date, ref ? ref.t : it.received_at);
      if (d) return { day: d, src: "screen", t, clockMin: clock, lag: lagFrom(d) };
    }
    if (!ref) return { day: null, src: null, t, clockMin: clock, lag: null };
    let day = taken;
    const shown = String(r.date_shown || "").toLowerCase();
    const yesterday = /\byesterday\b/.test(shown);
    // taken in the small hours (before 4am) of a screen still showing "today": that's last night's log.
    // Not for "Yesterday" screens: the app has already moved on to the new day.
    if (ref.src !== "sentday" && !yesterday) {
      const takenMin = clock != null ? clock : p.min;
      if (taken === p.date && takenMin < 240) day = addDays(day, -1);
    }
    if (yesterday) day = addDays(day, -1);
    else if (!/\btoday\b/.test(shown)) {
      const wd = WD_LONG.findIndex((w) => new RegExp(`\\b(${w}|${w.slice(0, 3)})\\b`).test(shown));
      if (wd >= 0) {
        const cur = dObj(day).getUTCDay();
        day = addDays(day, -((cur - wd + 7) % 7));
      }
    }
    return { day, src: ref.src, t, clockMin: clock != null ? clock : ref.src === "sentday" ? null : p.min, lag: lagFrom(day) };
  }

  // ---------- one day ----------
  // items: that day's screenshots, each { id, kind, kcal, protein, carbs, fat, steps, edited, scope, extras, r (parsed reading), t (capture time, epoch s),
  //   clockMin (minutes past midnight it was taken, or null), lag (0 = taken on the day itself, 1+ = later, null = unknown) }
  // opts: { refKcal (a normal day for this client), verdict ('count' | 'omit' | undefined) }
  function reconcileDay(day, items, opts = {}) {
    const ref = opts.refKcal || null;
    const notes = []; // plain words for the app and the PDF, most important first
    const info = []; // worth knowing, not a problem
    const food = { kcal: null, protein: null, carbs: null, fat: null, src: null, conf: null, macroConf: null, floor: false, missingMacroKcal: 0, alcoholKcal: 0, meals: [], empty: [] };
    const ordered = items.slice().sort((a, b) => (a.t || 0) - (b.t || 0) || a.id - b.id);

    // --- numbers typed by Shan ---
    const typedDay = ordered.filter((it) => override(it) && isFood(it) && roleOf(it) === "day" && [it.kcal, it.protein, it.carbs, it.fat].some((v) => v != null));
    // --- whole-day totals and meals from the new reader ---
    const allSummaries = ordered.filter((it) => !override(it) && isFood(it) && v2(it) && it.r.screen === "day_summary" && it.r.day && it.r.day.kcal != null);
    // Is a "day total" really one meal's? A dashboard shows goals, what's left, eaten/goal pairs or several meal
    // sections. A meal's own screen scrolled past its title shows none of those. If a real dashboard came in too,
    // or the day's meal screenshots add up to more than it, it's counted as a meal, never as the day.
    const dayLike = (it) => {
      const d = it.r.day;
      const pairs = [d.protein_text, d.carbs_text, d.fat_text].some((t) => /\d\s*(?:\/|\bof\b)\s*\d/i.test(t || ""));
      return d.kcal_goal != null || d.kcal_left != null || d.kcal_over != null || pairs || (it.r.meals || []).filter((m) => m.slot).length >= 2;
    };
    const demoted = new Set();
    if (allSummaries.some(dayLike)) for (const it of allSummaries) if (!dayLike(it)) demoted.add(it.id);

    let entries;
    let chosen;
    let dupNotes;
    const build = () => {
      entries = [];
      for (const it of ordered) {
        if (!isFood(it)) continue;
        if (override(it) && roleOf(it) === "meal") {
          const m0 = v2(it) && (it.r.meals || []).length === 1 ? it.r.meals[0] : {};
          entries.push({ slot: m0.slot || null, name: m0.name || null, logged: true, kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat, foods: m0.foods || [], full: true, t: it.t || 0, itemId: it.id, typed: true, fromDay: false });
          continue;
        }
        if (override(it) || !v2(it)) continue;
        if (demoted.has(it.id)) {
          const d = it.r.day;
          const m0 = (it.r.meals || [])[0] || {};
          entries.push({ slot: m0.slot || null, name: m0.name || null, logged: true, kcal: d.kcal, protein: d.protein, carbs: d.carbs, fat: d.fat, foods: m0.foods || [], full: true, t: it.t || 0, itemId: it.id, fromDay: false, demoted: true });
          continue;
        }
        for (const m of it.r.meals || []) entries.push({ ...m, t: it.t || 0, itemId: it.id, fromDay: it.r.screen === "day_summary" });
      }
      // one entry per meal: the latest with a total; repeats of the same meal dropped
      chosen = [];
      dupNotes = [];
      for (const slot of SLOTS) {
        const es = entries.filter((e) => e.slot === slot && e.logged !== false);
        const withK = es.filter((e) => mealKcal(e).kcal != null && mealKcal(e).kcal > 0);
        if (!withK.length) {
          if (es.some((e) => !e.fromDay)) chosen.push({ ...es[es.length - 1], kcal: null, unknownTotal: true });
          continue;
        }
        const best = withK[withK.length - 1];
        const differs = withK.filter((e) => !e.fromDay && e.itemId !== best.itemId && !sameNums({ kcal: mealKcal(e).kcal, protein: e.protein }, { kcal: mealKcal(best).kcal, protein: best.protein }));
        if (differs.length && !best.fromDay) dupNotes.push(`${SLOT_NAME[slot]} was sent twice with different totals; used the later one`);
        chosen.push({ ...best, kcal: mealKcal(best).kcal, derived: mealKcal(best).derived });
      }
      // meals whose name is cut off or isn't one of the four: kept unless they repeat one already counted
      for (const e of entries.filter((x) => !SLOTS.includes(x.slot) && x.logged !== false && !x.fromDay)) {
        const k = mealKcal(e);
        if (k.kcal == null || k.kcal <= 0) continue;
        const cand = { ...e, kcal: k.kcal, derived: k.derived };
        if (chosen.some((c) => sameNums(c, cand))) continue;
        chosen.push(cand);
      }
    };
    build();
    // a lone "day total" with no dashboard signs that's smaller than the meals sent alongside it is one meal
    for (const it of allSummaries) {
      if (demoted.has(it.id) || dayLike(it)) continue;
      const others = chosen.filter((m) => !m.fromDay && m.kcal != null && m.itemId !== it.id).reduce((a, m) => a + m.kcal, 0);
      if (others > it.r.day.kcal + Math.max(40, it.r.day.kcal * 0.03)) demoted.add(it.id);
    }
    if (demoted.size) build();
    const summaries = allSummaries.filter((it) => !demoted.has(it.id));
    const legacy = ordered.filter((it) => isFood(it) && !override(it) && !v2(it) && (it.kcal != null || it.protein != null));

    // empty sections: the latest word on each slot
    const state = {};
    for (const e of entries) {
      if (!SLOTS.includes(e.slot)) continue;
      const k = mealKcal(e).kcal;
      const logged = e.logged !== false && !(k === 0 && !(e.foods || []).length);
      if (!state[e.slot] || e.t >= state[e.slot].t) state[e.slot] = { logged: logged || (state[e.slot] && state[e.slot].logged && state[e.slot].t === e.t), t: e.t };
    }
    food.empty = SLOTS.filter((s) => state[s] && !state[s].logged);

    food.meals = chosen.filter((m) => m.kcal != null).map((m) => ({ label: mealLabel(m), slot: m.slot || null, kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, fromDay: !!m.fromDay, derived: !!m.derived }));
    const mealShots = chosen.filter((m) => !m.fromDay);
    const mealSum = r1(mealShots.filter((m) => m.kcal != null).reduce((a, m) => a + m.kcal, 0));

    // alcohol and meals logged without macros
    let alcohol = 0;
    const noMacro = [];
    for (const m of chosen) {
      if (m.kcal == null) continue;
      const alc = (m.foods || []).filter((f) => isAlcohol(f.name) && f.kcal != null).reduce((a, f) => a + f.kcal, 0);
      alcohol += alc;
      const e = energy(m.protein, m.carbs, m.fat);
      const solid = m.kcal - alc;
      if (e != null && solid >= 60 && e < 0.35 * solid) {
        const foods = (m.foods || []).filter((f) => !isAlcohol(f.name));
        noMacro.push({ label: mealLabel(m), kcal: Math.round(solid - e), food: foods.length === 1 ? foods[0].name : null });
      }
    }
    food.alcoholKcal = Math.round(alcohol);

    // --- the day's food numbers ---
    let conf = null;
    let macroConf = null;
    if (typedDay.length) {
      const it = typedDay[typedDay.length - 1];
      Object.assign(food, { kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat, src: "typed" });
      conf = "high";
      notes.push(it.edited ? "Numbers typed by you" : "Marked by you as the day's total");
    } else if (summaries.length) {
      // a "day total" that's the same as the calorie goal on the day's screenshots is probably the goal
      const goals = ordered.map((x) => (v2(x) ? goalOf(x.r) : x.kcal_goal)).filter((g) => g != null);
      const isGoal = (x) => goals.some((g) => Math.abs(g - x.r.day.kcal) <= 1);
      const good = summaries.filter((x) => !isGoal(x));
      const pool = good.length ? good : summaries;
      const likes = pool.filter(dayLike);
      const it = (likes.length ? likes : pool)[(likes.length ? likes : pool).length - 1];
      const d = it.r.day;
      Object.assign(food, { kcal: d.kcal, protein: d.protein, carbs: d.carbs, fat: d.fat, src: "total" });
      Object.defineProperty(food, "fromItem", { value: it, enumerable: false });
      conf = "high";
      if (demoted.size) info.push(`${demoted.size === 1 ? "One screenshot looked like a day total but was a single meal, so it's counted as that meal" : `${demoted.size} screenshots looked like day totals but were single meals, so they're counted as meals`}`);
      const unsure = it.r.unsure || [];
      if (unsure.includes("kcal")) {
        conf = "low";
        notes.push("Couldn't be sure of the calories on the screenshot");
      }
      if (!good.length) {
        conf = "low";
        notes.push(`The day total (${fmt(d.kcal)}) is the same as the calorie goal, so it may be the goal`);
      } else if (good.length < summaries.length) info.push(`Ignored a screenshot whose "total" is the calorie goal`);
      // two day totals: the later one should be the same or higher
      const prev = pool.filter((s) => s !== it && s.t <= it.t && s.r.day.kcal != null);
      if (prev.length) {
        const p = prev[prev.length - 1].r.day.kcal;
        if (p > d.kcal + Math.max(30, d.kcal * 0.03)) {
          conf = lower(conf, "medium");
          notes.push(`Two day totals that don't agree (${fmt(p)} and ${fmt(d.kcal)}); used the later one`);
        }
      }
      // a running total: taken on the day itself, well before evening
      if (it.lag === 0 && it.clockMin != null && it.clockMin < 16 * 60) {
        conf = "low";
        notes.push(`Taken at ${hhmm(it.clockMin)}, before the day was over`);
      }
      // meal screenshots are a check on the total, never added to it
      if (mealShots.length && mealSum > 0) {
        if (mealSum > d.kcal + Math.max(40, d.kcal * 0.03)) {
          conf = lower(conf, "medium");
          notes.push(`The meal screenshots add up to ${fmt(mealSum)}, more than the day total of ${fmt(d.kcal)}`);
        } else if (Math.abs(mealSum - d.kcal) <= Math.max(15, d.kcal * 0.02)) info.push("Day total matches the meal screenshots");
      }
      // sections left empty
      const emptyMain = MAIN.filter((s) => food.empty.includes(s));
      const loggedNames = SLOTS.filter((s) => state[s] && state[s].logged).map((s) => SLOT_NAME[s]);
      if (emptyMain.length) {
        const what = loggedNames.length === 1 ? `Only ${loggedNames[0]} logged` : `${listAnd(emptyMain.map((s) => SLOT_NAME[s]))} not logged`;
        if ((ref && d.kcal < 0.6 * ref) || (!ref && emptyMain.length >= 2)) {
          conf = "low";
          food.partial = true;
          notes.push(what);
        } else if (!ref || d.kcal < 0.85 * ref) {
          conf = lower(conf, "medium");
          notes.push(what);
        } else info.push(what);
      } else if (ref && d.kcal < 0.45 * ref) {
        conf = "low";
        food.partial = true;
        notes.push(`Much lower than usual (${fmt(d.kcal)}); maybe not everything was logged`);
      }
    } else if (chosen.length) {
      const known = chosen.filter((m) => m.kcal != null);
      const unknownTotals = chosen.filter((m) => m.kcal == null);
      const sum = (k) => (known.length && known.every((m) => m[k] != null) ? r1(known.reduce((a, m) => a + m[k], 0)) : null);
      Object.assign(food, { kcal: known.length ? r1(known.reduce((a, m) => a + m.kcal, 0)) : null, protein: sum("protein"), carbs: sum("carbs"), fat: sum("fat"), src: "meals" });
      conf = "medium";
      const named = new Set(known.map((m) => m.slot).filter(Boolean));
      const unnamed = known.filter((m) => !SLOTS.includes(m.slot)).length;
      const missing = MAIN.filter((s) => !named.has(s) && !food.empty.includes(s));
      const missingCount = Math.max(0, missing.length - unnamed);
      notes.push(`Added up from ${known.length} meal screenshot${known.length === 1 ? "" : "s"} (no day total sent)`);
      if (unknownTotals.length) {
        conf = "low";
        food.partial = true;
        notes.push(`${listAnd(unknownTotals.map(mealLabel))} total not on the screenshot`);
      } else if (missingCount >= 2) {
        conf = "low";
        food.partial = true;
        notes.push(`Only ${listAnd(known.map(mealLabel))} sent`);
      } else if (missingCount === 1) {
        const miss = missing.length === 1 ? `No ${SLOT_NAME[missing[0]]} screenshot` : `No screenshot for ${listAnd(missing.map((m) => SLOT_NAME[m]))} (one meal's name was cut off)`;
        if (ref && food.kcal < 0.6 * ref) {
          conf = "low";
          food.partial = true;
          notes.push(miss);
        } else if (!ref || food.kcal < 0.85 * ref) notes.push(miss);
        else info.push(`${miss}, but the total looks like a full day`);
      }
      if (conf !== "low" && ref && food.kcal != null && food.kcal < 0.45 * ref) {
        conf = "low";
        food.partial = true;
        notes.push(`Much lower than usual (${fmt(food.kcal)}); maybe not everything was sent`);
      }
    } else if (legacy.length) {
      // read by the first version of the reader: shown, but not trusted until it's read again
      const mx = (k) => legacy.reduce((a, it) => (it[k] == null ? a : a == null ? it[k] : Math.max(a, it[k])), null);
      Object.assign(food, { kcal: mx("kcal"), protein: mx("protein"), carbs: mx("carbs"), fat: mx("fat"), src: "old" });
      conf = "low";
      notes.push("Read by the old reader; being read again");
    }
    if (dupNotes.length) {
      notes.push(...dupNotes);
      if (conf === "high") conf = "medium";
    }

    // --- macros ---
    if (food.kcal != null && [food.protein, food.carbs, food.fat].some((v) => v != null)) {
      macroConf = conf;
      const e = energy(food.protein, food.carbs, food.fat);
      let missingKcal = 0;
      let where = "";
      if (noMacro.length) {
        missingKcal = noMacro.reduce((a, m) => a + m.kcal, 0);
        where = ` (${noMacro.map((m) => m.label + (m.food ? `: ${m.food}` : "")).join("; ")})`;
      } else if (e != null && food.src !== "typed") {
        const gap = food.kcal - e - alcohol;
        if (gap > 0) missingKcal = Math.round(gap);
      }
      if (food.src !== "typed" && missingKcal >= Math.max(150, 0.12 * food.kcal)) {
        macroConf = "low";
        food.floor = true;
        food.missingMacroKcal = Math.round(missingKcal);
        notes.push(`${fmt(missingKcal)} kcal logged with no macros${where}, so protein, carbs and fat are too low`);
      }
      if (e != null && food.kcal >= 100 && e > food.kcal * 1.3 + 60 && food.src !== "typed") {
        macroConf = "low";
        notes.push("Protein, carbs and fat add up to more calories than the day, so one of them was misread");
      }
      const sum = food.src === "total" ? food.fromItem : null;
      const unsure = (sum && sum.r.unsure) || [];
      if (unsure.some((f) => ["protein", "carbs", "fat", "macros"].includes(f))) {
        macroConf = "low";
        notes.push("Couldn't be sure of the macros on the screenshot (goal and eaten)");
      }
    }
    if (food.alcoholKcal >= 100) info.push(`About ${fmt(food.alcoholKcal)} kcal from drinks`);

    // --- steps ---
    const steps = { value: null, approx: false, conf: null, note: "" };
    const cands = [];
    for (const it of ordered) {
      if (it.edited && it.steps != null) cands.push({ value: it.steps, approx: false, typed: true, t: it.t || 0, it });
      else if (!it.edited && v2(it) && it.r.steps && it.r.steps.count != null) cands.push({ value: it.r.steps.count, approx: !!it.r.steps.approx, t: it.t || 0, it });
      else if (!it.edited && !v2(it) && it.steps != null) cands.push({ value: it.steps, approx: it.kind === "food_steps" && it.steps % 100 === 0, t: it.t || 0, it, old: true });
    }
    // A day's steps only go up, and apps sync at different times, so the highest count is the most complete one
    // (a lower figure is an earlier or stale sync). An exact count beats a rounded one (11.2k) that agrees with it.
    const typedSteps = cands.filter((c) => c.typed);
    let pick = typedSteps.length ? typedSteps[typedSteps.length - 1] : cands.slice().sort((a, b) => b.value - a.value || (a.approx ? 1 : 0) - (b.approx ? 1 : 0))[0];
    if (pick && pick.approx) {
      const exact = cands.filter((c) => !c.approx && Math.abs(c.value - pick.value) <= 50);
      if (exact.length) pick = exact.sort((a, b) => b.value - a.value)[0];
    }
    if (pick) {
      steps.value = pick.value;
      steps.approx = pick.approx;
      steps.conf = pick.typed ? "high" : pick.approx ? "medium" : "high";
      if (pick.approx) steps.note = "Rounded on the screenshot";
      const lower = cands.filter((c) => !c.typed && c !== pick && c.value < pick.value - 500 && Math.abs((c.t || 0) - (pick.t || 0)) < 3600);
      if (!pick.typed && lower.length) info.push(`Steps: used ${fmt(pick.value)}; another app showed ${fmt(lower[0].value)}, which hadn't caught up`);
      if (!pick.typed && pick.it.lag === 0 && pick.it.clockMin != null && pick.it.clockMin < 17 * 60) {
        steps.conf = "low";
        steps.note = `Taken at ${hhmm(pick.it.clockMin)}, before the day was over`;
      }
    }

    // --- weight and other extras (a week's summary only gives its weight, never its averages) ---
    const extras = [];
    for (const it of ordered) {
      const week = v2(it) && it.r.screen === "period_summary";
      const stepsShot = v2(it) && it.r.screen === "steps";
      for (const e of it.extras || []) {
        if (week && !/weight/i.test(e.label)) continue;
        if (stepsShot && /^burned$/i.test(e.label)) continue;
        if (/average|avg/i.test(e.label + " " + e.value)) continue;
        if (!extras.some((x) => x.label.toLowerCase() === e.label.toLowerCase())) extras.push(e);
      }
    }

    // --- Shan's call on the day ---
    food.conf = conf;
    food.macroConf = macroConf;
    const counts = (c) => c === "high" || c === "medium";
    const include = {
      kcal: food.kcal != null && counts(conf),
      protein: food.protein != null && counts(macroConf),
      carbs: food.carbs != null && counts(macroConf),
      fat: food.fat != null && counts(macroConf),
      steps: steps.value != null && counts(steps.conf),
    };
    if (opts.verdict === "count") {
      include.kcal = food.kcal != null;
      for (const k of ["protein", "carbs", "fat"]) include[k] = food[k] != null && !food.floor && !(macroConf === "low" && notes.some((n) => /misread|Couldn't be sure of the macros/.test(n)));
      include.steps = steps.value != null;
    } else if (opts.verdict === "omit") {
      for (const k of Object.keys(include)) include[k] = false;
    }
    const level = food.kcal == null ? steps.conf : conf;
    // what the averages leave out, in words
    const kOut = food.kcal != null && !include.kcal;
    const pOut = food.protein != null && !include.protein;
    const sOut = steps.value != null && !include.steps;
    const leftOut =
      kOut && sOut ? "Food and steps left out of the averages"
      : kOut ? "Left out of the averages"
      : pOut && sOut ? "Protein, carbs, fat and steps left out of the averages"
      : pOut ? "Protein, carbs and fat left out of the averages"
      : sOut ? "Steps left out of the averages"
      : "";
    // counting the day can't fix macros that are missing food: only offer it where it would change something
    const canCount = !opts.verdict && (kOut || sOut || (pOut && !food.floor));
    return {
      day,
      food,
      steps,
      extras,
      demoted: [...demoted], // screenshots the reader took for a day total that are one meal's
      mealIds: chosen.filter((m) => !m.fromDay && m.kcal != null).map((m) => m.itemId),
      notes,
      info,
      include,
      verdict: opts.verdict || null,
      level,
      leftOut,
      canCount,
      // what needs a look: anything the averages leave out
      flagged: (food.kcal != null && !include.kcal) || (food.protein != null && !include.protein) || (steps.value != null && !include.steps),
    };
  }

  // ---------- a normal day for this client ----------
  // Their calorie goal read off the screenshots, else the target set in the app, else the middle of their
  // whole-day totals once there are a few.
  function refKcal(itemsAll, target) {
    const goals = itemsAll.map((it) => (it.r && it.r.v >= 2 ? goalOf(it.r) : it.kcal_goal)).filter((g) => g >= 800 && g <= 6000);
    if (goals.length) return median(goals);
    if (target && target.kcal) return target.kcal;
    const totals = itemsAll.filter((it) => it.r && it.r.v >= 2 && it.r.screen === "day_summary" && it.r.day && it.r.day.kcal >= 500).map((it) => it.r.day.kcal);
    return totals.length >= 5 ? median(totals) : null;
  }
  function goalOf(r) {
    const d = r.day;
    if (!d) return null;
    if (d.kcal_goal) return d.kcal_goal;
    if (d.kcal != null && d.kcal_left != null) return d.kcal + d.kcal_left;
    if (d.kcal != null && d.kcal_over != null) return d.kcal - d.kcal_over;
    return null;
  }
  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // ---------- averages that only use days we trust ----------
  function summarize(days) {
    const out = {};
    const val = (d, k) => (k === "steps" ? d.steps.value : d.food[k]);
    for (const k of ["kcal", "protein", "carbs", "fat", "steps"]) {
      const used = days.filter((d) => d.include && d.include[k] && val(d, k) != null);
      const left = days.filter((d) => val(d, k) != null && !(d.include && d.include[k]));
      const xs = used.map((d) => val(d, k));
      out[k] = { avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, n: used.length, left: left.map((d) => ({ day: d.day, why: whyLeft(d, k) })) };
    }
    return out;
  }
  function whyLeft(d, k) {
    if (d.verdict === "omit") return "left out by you";
    if (k === "steps") return (d.steps.note || "not sure of it").replace(/^./, (c) => c.toLowerCase());
    const n = d.notes.find((x) => (k === "kcal" ? !/macros|protein, carbs/i.test(x) : true)) || d.notes[0] || "not sure of it";
    return n.replace(/^./, (c) => c.toLowerCase());
  }

  const api = { reconcileDay, summarize, refKcal, isAlcohol, goalOf, median, effDay, sessionSizes, ukParts };
  root.TSReconcile = api;
})(typeof window !== "undefined" ? window : globalThis);
