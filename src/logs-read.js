// TrueStay Logs: reading a screenshot, version 2.
//
// Version 1 asked for "the day's calories" and trusted whatever came back, so a meal's total, a target
// (the 81 in "16/81 g") or a running total could land in a client's report as the day's figure.
// Version 2 asks the model what each number IS, then checks it here in plain code:
//  - what kind of screen it is: a whole-day total, one meal, part of a diary, steps, a week's summary...
//  - for "eaten / goal" pairs like "16/81 g", the exact text as printed, so the first number is taken as
//    eaten and the second as the goal, whatever the model said
//  - every meal section it can see, whether it's empty, its own totals and its foods (drinks are
//    spotted from their names, so wine isn't mistaken for food with missing macros)
//  - sums that can't be right (macros worth more calories than the day, a "day total" that equals one
//    meal, eaten equal to the goal) get a second, focused look. Anything still wrong is marked unsure
//    rather than guessed.
// How the screenshots of one day are put together (day total vs meals, partial days, confidence) is in
// public/logs/reconcile.js, which the app and the PDF share.

export const READER_V = 2;

export const SYSTEM = `You read screenshots that a personal trainer's clients send him each night: food diaries and food dashboards (MyFitnessPal, Nutracheck, Fastic, MacroFactor, Cronometer, Lose It, Carb Manager, Samsung Health and others) and step or activity screens (Apple Health, Apple Fitness, Garmin Connect, Google Fit, Samsung Health, Fitbit, Strava, pedometer apps).
Your job is to say exactly what each number on the screen IS: a whole day's total, one meal's total, a goal, an amount remaining, a weekly average. Read only what is printed. Never guess, estimate or add numbers up yourself. Reply with one JSON object and nothing else.`;

export const PROMPT = `Fill in this JSON for the screenshot. Use null for anything that is not on the screen.

"screen" is one of:
- "day_summary": shows totals for the WHOLE DAY, e.g. a dashboard with calories consumed and macros like "50/81 g", or a diary for one date with the day's calories in a ring, circle or big number at the top (meals may follow below it).
- "meal": ONE meal only (Breakfast, Lunch, Dinner, Snacks or similar) with that meal's totals and its foods.
- "diary_part": a diary scrolled so you see some meals but NOT the whole day's total.
- "food_item": one food's details.
- "steps": steps or activity for a day (even if an average for the week is also shown).
- "weight": body weight.
- "period_summary": a week, a month or several days (averages, charts, labels like "Sep 6–12" or "Last 7 days").
- "other".

{
  "screen": "...",
  "app": "the app's name if you can tell, else null",
  "date_shown": "the date label exactly as written: Today, Yesterday, Mon 21 Sep, Sep 26, 2026, Sep 6–12. Not the status bar clock",
  "clock": "the status bar time at the very top, HH:MM",
  "day": {
    "calories": {"eaten": 0, "goal": 0, "remaining": 0, "over": 0, "text": "exact text by the eaten number, e.g. 1,729 Consumed"},
    "protein": {"eaten": 0, "goal": 0, "text": "exact text, e.g. 16/81 g"},
    "carbs": {"eaten": 0, "goal": 0, "text": "exact text"},
    "fat": {"eaten": 0, "goal": 0, "text": "exact text"}
  },
  "meals": [
    {"name": "Breakfast", "logged": true, "totals_text": "this meal's own totals exactly as printed, e.g. 53.0 g Carbs 21.3 g Protein 14.3 g Fat 443.9 kcal, or 558/406 kcal", "calories": 0, "calorie_target": 0, "protein": 0, "carbs": 0, "fat": 0, "foods": [{"name": "Porridge oats", "calories": 157}], "all_foods_visible": true}
  ],
  "steps": {"count": 0, "goal": 0, "text": "exact text, e.g. 11.2k / 10.0k or 13,681", "for": "today, yesterday, week_average or other"},
  "exercise_kcal": 0,
  "weight_kg": 0,
  "extras": [{"label": "Water", "value": "2.1 L"}],
  "cut_off": false,
  "note": ""
}

Rules:
- "day" is only for numbers that cover the whole day. Use null for "day" on meal, diary_part, food_item and period_summary screens.
- In a pair like "16/81 g", "11.2k / 10.0k" or "558/406 kcal" the FIRST number is what was eaten or done and the SECOND is the goal. Copy the pair into "text".
- Never put a goal, target, budget, remaining, over or burned number in "eaten" or "count".
- "meals": every meal section you can see. "name" is the meal's name as printed (Breakfast, Lunch, Dinner, Snacks...), or null if it's scrolled out of view; never a heading like Components or Foods.
- "logged" is true if the section has a tick, foods or calories; false if it only has a + / Add / Log food button or shows 0 kcal.
- "totals_text", "calories", "protein", "carbs", "fat": only this meal's own totals as printed on the screen. If no totals are printed for the meal, use null for all of them, even if you could add up the foods. Macros printed as 0.0 g are 0.
- "foods": the foods you can see with their calories, up to 12. "all_foods_visible" is false if the list runs off the screen.
- "steps" is ONE day's steps. If the screen also shows an average over several days, give the day's steps, not the average. "for" is "yesterday" when they're labelled Yesterday. Use null if no step count is printed.
- "cut_off" is true if the screen is scrolled so the day's or a meal's totals are out of view.
- "extras": up to 4 other daily numbers worth a coach seeing, e.g. water, fibre, distance, sleep. Not goals.
- "note": empty, unless something stands out for a coach, e.g. a warning from the app.
- Numbers are plain numbers with no units or commas, except inside "text", "extras" and "note".`;

// A focused second look, used only when the first reading doesn't add up.
export const VERIFY = `Look at this screenshot again, carefully. Copy the text exactly as printed for the numbers below, then split each one.
In a pair like "16/81 g" the FIRST number is what was eaten and the SECOND is the goal. For calories use the number labelled Consumed, Eaten or Food, never Remaining, Over, Burned or the goal.
Only fill "day" if the screen shows the whole day's totals. Fill "meals" for each meal whose own totals are printed.
{
  "day": {
    "calories": {"text": "", "eaten": 0},
    "protein": {"text": "", "eaten": 0, "goal": 0},
    "carbs": {"text": "", "eaten": 0, "goal": 0},
    "fat": {"text": "", "eaten": 0, "goal": 0}
  },
  "meals": [{"name": "", "text": "the meal's totals exactly as printed", "calories": 0, "protein": 0, "carbs": 0, "fat": 0}]
}
Use null for anything not on the screen. Reply with the JSON only.`;

// ---------- small parsers ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const two = (n) => String(n).padStart(2, "0");
function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function mkDate(y, mo, d) {
  mo = +mo;
  d = +d;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  if (y) {
    const iso = `${String(y).length === 2 ? "20" + y : y}-${two(mo)}-${two(d)}`;
    return isDate(iso) ? iso : null;
  }
  return isDate(`2024-${two(mo)}-${two(d)}`) ? `${two(mo)}-${two(d)}` : null; // 2024 allows 29 Feb
}

// "Sep 6–12", "6-12 Sep", "20 – 26 September", "Last 7 days", "This week", "Week 38": a span of days, not a day
export function isRangeLabel(label) {
  if (!label) return false;
  const t = String(label).toLowerCase();
  if (/\b(week|month|year|last \d+ days|past \d+ days|\d+ days|average|avg)\b/.test(t)) return true;
  if (/\d\s*(?:–|—|-|to)\s*\d/.test(t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""))) return true; // but not 2026-09-21
  return false;
}

// "Mon 21 Sep", "21st September 2026", "Sep 21", "Sep 26, 2026", "21/09/2026", "21/09" (UK order). Returns YYYY-MM-DD or MM-DD.
export function dateFromShown(label) {
  if (!label || isRangeLabel(label)) return null;
  const t = String(label).toLowerCase();
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
  let m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}(?:,?\\s+(\\d{4}))?`));
  if (m) return mkDate(m[3], MONTHS[m[2]], m[1]);
  m = t.match(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`));
  if (m) return mkDate(m[3], MONTHS[m[1]], m[2]);
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return mkDate(m[1], m[2], m[3]);
  m = t.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}|\d{2}))?\b/);
  if (m) return mkDate(m[3], m[2], m[1]);
  return null;
}
export function cleanDate(v) {
  if (typeof v !== "string") return null;
  let m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return mkDate(m[1], m[2], m[3]);
  m = v.trim().match(/^(\d{2})-(\d{2})$/);
  return m ? mkDate(null, m[1], m[2]) : null;
}

// "1,729" -> 1729, "11.2k" -> 11200, "850.0 kcal" -> 850. Null if there's no number.
export function kNum(s) {
  if (s == null) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const m = String(s).replace(/(\d),(?=\d{3}\b)/g, "$1").match(/(-?\d+(?:\.\d+)?)\s*(k)?\b/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}
const hasK = (s) => /\d(?:\.\d+)?\s*k\b/i.test(String(s || ""));
// every number in a piece of copied text ("1,729 Consumed" -> [1729], "53.0 g Carbs 21.3 g Protein" -> [53, 21.3])
export const numsIn = (text) => (String(text || "").replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) || []).map(Number);
// a number the model gave is only kept if it's in the text it copied from the screen
const backed = (v, text) => v == null || numsIn(text).some((n) => Math.abs(n - v) <= 0.15 + Math.abs(v) * 0.002);

// "16/81 g", "11.2k / 10.0k", "558/406 kcal", "1,254 of 1,500": first is eaten or done, second the goal
export function parsePair(text) {
  if (text == null) return null;
  const t = String(text).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const m = t.match(/(\d+(?:\.\d+)?)\s*(k(?![a-z]))?\s*(?:[a-z%]+\s*)?(?:\/|\bof\b)\s*(\d+(?:\.\d+)?)\s*(k(?![a-z]))?/i);
  if (!m) return null;
  const a = Number(m[1]) * (m[2] ? 1000 : 1);
  const b = Number(m[3]) * (m[4] ? 1000 : 1);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { a, b, approx: !!(m[2] || m[4]) };
}

export function slotOf(name) {
  const t = String(name || "").toLowerCase();
  if (!t.trim()) return null;
  if (/breakfast|brekkie|morning/.test(t)) return "breakfast";
  if (/lunch|midday/.test(t)) return "lunch";
  if (/dinner|supper|evening meal|\btea\b|main meal/.test(t)) return "dinner";
  if (/snack/.test(t)) return "snacks";
  return "other";
}

// Drinks with alcohol: their calories come mostly from alcohol, which isn't protein, carbs or fat.
const ALC = /\b(wine|prosecco|champagne|cava|cr[eé]mant|beer|ale|ipa|lager|stout|porter|pilsner|bitter|cider|gin|vodka|rum|whisk(?:e)?y|bourbon|scotch|tequila|mezcal|brandy|cognac|liqueur|schnapps|sambuca|baileys|port|sherry|vermouth|aperol|spritz|cocktail|margarita|mojito|martini|negroni|daiquiri|pimm'?s|rioja|merlot|shiraz|malbec|sauvignon|pinot|chardonnay|ros[eé]|riesling|tempranillo|cabernet|grenache|zinfandel|moscato|sangria|alcohol|alcoholic)\b/i;
const NOT_ALC = /vinegar|gum\b|sauce|jelly|gravy|reduction|cooking|non[- ]?alcoholic|alcohol[- ]free|\b0(?:\.[05])?\s*%|\bzero\b|\b0\.0\b/i;
export const isAlcohol = (name) => !!name && ALC.test(name) && !NOT_ALC.test(name);

// ---------- cleaning the model's answer ----------
const SCREENS = ["day_summary", "meal", "diary_part", "food_item", "steps", "weight", "period_summary", "other"];
const SCREEN_ALIASES = {
  dashboard: "day_summary", day: "day_summary", daily_summary: "day_summary", summary: "day_summary", day_total: "day_summary", diary: "diary_part",
  meal_detail: "meal", meal_summary: "meal", food: "food_item", food_detail: "food_item", activity: "steps", step: "steps",
  week: "period_summary", weekly: "period_summary", weekly_summary: "period_summary", period: "period_summary", progress: "period_summary", trend: "period_summary",
};
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, max) => (typeof v === "string" && v.trim() && !/^(null|none|n\/a)$/i.test(v.trim()) ? v.trim().slice(0, max) : null);
const num = (v, min, max, dp = 0) => {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  let n = typeof v === "number" ? v : kNum(String(v).replace(/\s+/g, " "));
  if (n == null || !Number.isFinite(n) || n < min || n > max) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const fmtKcal = (n) => `${Math.round(n).toLocaleString("en-GB")} kcal`;
const LIM = { kcal: [0, 12000], protein: [0, 700], carbs: [0, 1500], fat: [0, 600] };

// One nutrient on a day screen: the model's split, corrected by the pair it copied when there is one.
function cleanNutrient(v, key, fixes) {
  const [lo, hi] = LIM[key];
  let eaten, goal, text;
  if (v && typeof v === "object") {
    eaten = num(v.eaten ?? v.consumed ?? v.value, lo, hi, 1);
    goal = num(v.goal ?? v.target, lo, hi, 1);
    text = str(v.text, 40);
  } else {
    eaten = num(v, lo, hi, 1);
  }
  const pair = key === "kcal" ? null : parsePair(text);
  if (pair && pair.a >= lo && pair.a <= hi) {
    if (eaten !== pair.a) {
      if (eaten != null) fixes.push(`${key}: ${eaten} was the ${eaten === pair.b ? "goal" : "wrong number"}, eaten is ${pair.a} ("${text}")`);
      eaten = pair.a;
    }
    if (pair.b >= lo && pair.b <= hi) goal = pair.b;
  } else if (key !== "kcal" && text && eaten != null && !backed(eaten, text)) {
    const n = numsIn(text);
    if (n.length === 1 && n[0] >= lo && n[0] <= hi) {
      fixes.push(`${key}: ${eaten} didn't match the text "${text}"`);
      eaten = n[0];
    }
  } else if (key === "kcal" && text) {
    // calories: the copied text should be the eaten number, not remaining, over, burned or the goal
    const n = kNum(text);
    const wrongLabel = /remaining|left|over\b|burn|goal|budget|target/i.test(text) && !/consum|eaten|food|intake/i.test(text);
    if (n != null && !wrongLabel && eaten != null && Math.abs(n - eaten) > 1) {
      fixes.push(`kcal: ${eaten} didn't match the text "${text}"`);
      eaten = num(n, lo, hi, 1);
    }
    if (wrongLabel) fixes.push(`kcal: the copied text "${text}" isn't the eaten number`);
  }
  return { eaten, goal, text };
}

export function cleanReading(o) {
  o = obj(o);
  const fixes = [];
  let screen = String(o.screen || o.kind || "").toLowerCase().replace(/[^a-z_]/g, "");
  screen = SCREEN_ALIASES[screen] || screen;
  if (!SCREENS.includes(screen)) screen = "other";

  const date_shown = str(o.date_shown, 40);
  // a label covering several days ("Sep 6–12", "Last 7 days") is never one day's food, whatever else the screen says
  const range = isRangeLabel(date_shown);
  if (range && ["day_summary", "diary_part", "meal", "food_item"].includes(screen)) {
    fixes.push(`"${date_shown}" covers several days, so it's a summary, not a day`);
    screen = "period_summary";
  }
  const date = screen === "period_summary" || range ? null : dateFromShown(date_shown) || cleanDate(o.date);
  let clock = str(o.clock, 8);
  if (clock) {
    const m = clock.match(/^(\d{1,2})[:.](\d{2})/);
    clock = m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
  }

  // the whole day's totals
  let day = null;
  const d = obj(o.day);
  if (Object.keys(d).length && !["meal", "food_item", "period_summary"].includes(screen)) {
    const c = obj(d.calories);
    const kc = cleanNutrient(d.calories, "kcal", fixes);
    const p = cleanNutrient(d.protein, "protein", fixes);
    const cb = cleanNutrient(d.carbs, "carbs", fixes);
    const f = cleanNutrient(d.fat, "fat", fixes);
    day = {
      kcal: kc.eaten,
      kcal_goal: num(c.goal ?? c.target ?? c.budget, 300, 9000),
      kcal_left: num(c.remaining ?? c.left, 0, 9000),
      kcal_over: num(c.over, 0, 9000),
      kcal_text: kc.text,
      protein: p.eaten,
      protein_goal: p.goal,
      protein_text: p.text,
      carbs: cb.eaten,
      carbs_goal: cb.goal,
      carbs_text: cb.text,
      fat: f.eaten,
      fat_goal: f.goal,
      fat_text: f.text,
    };
    if ([day.kcal, day.protein, day.carbs, day.fat].every((v) => v == null)) day = null;
  }
  if (screen === "diary_part" && day && day.kcal != null) screen = "day_summary"; // a diary that does show the day's total
  if (screen === "day_summary" && !day) screen = arr(o.meals).length ? "diary_part" : "other";

  // meal sections
  const meals = [];
  for (const m of screen === "period_summary" ? [] : arr(o.meals).slice(0, 8)) {
    const mm = obj(m);
    const name = str(mm.name, 30);
    const foods = arr(mm.foods)
      .slice(0, 14)
      .map((f) => ({ name: str(obj(f).name, 40), kcal: num(obj(f).calories ?? obj(f).kcal, 0, 5000, 1) }))
      .filter((f) => f.name);
    const ttext = str(mm.totals_text, 90);
    const meal = {
      name: name && /^(components|foods?|items|ingredients|meal|totals?)$/i.test(name) ? null : name,
      slot: null,
      logged: mm.logged === false || mm.logged === "false" ? false : true,
      kcal: num(mm.calories ?? mm.kcal, 0, 6000, 1),
      kcal_target: num(mm.calorie_target ?? mm.target, 0, 6000),
      protein: num(mm.protein, 0, 400, 1),
      carbs: num(mm.carbs, 0, 800, 1),
      fat: num(mm.fat, 0, 400, 1),
      foods,
      full: !(mm.all_foods_visible === false || mm.all_foods_visible === "false"),
      text: ttext,
    };
    meal.slot = slotOf(meal.name);
    // a meal's totals count only if they were copied off the screen: no text, no numbers (zeros for unprinted
    // totals would look like food with no macros)
    if (!ttext) {
      meal.kcal = meal.protein = meal.carbs = meal.fat = meal.kcal_target = null;
    } else {
      const pair = parsePair(ttext);
      if (pair && /kcal|cal\b/i.test(ttext) && !/g\b/.test(ttext.split("/")[0])) {
        meal.kcal = pair.a;
        meal.kcal_target = pair.b;
      }
      for (const k of ["kcal", "protein", "carbs", "fat"]) {
        if (meal[k] != null && !backed(meal[k], ttext)) {
          fixes.push(`${meal.name || "meal"} ${k}: ${meal[k]} isn't in "${ttext}"`);
          meal[k] = null;
        }
      }
      if (meal.kcal === 0 && !foods.length) meal.logged = false;
    }
    if (meal.kcal > 0 || foods.some((f) => f.kcal > 0)) meal.logged = true;
    if (!meal.name && meal.kcal == null && !foods.length) continue;
    meals.push(meal);
  }
  // a single meal screen says which meal in its name; a nameless one (scrolled past the title) stays unnamed

  // steps
  const so = typeof o.steps === "object" && o.steps ? o.steps : { count: o.steps };
  let steps = null;
  const stepsFor = String(so.for || "").toLowerCase();
  const stext = str(so.text, 40);
  let scount = num(so.count ?? so.value, 0, 150000);
  let sgoal = num(so.goal, 100, 100000);
  const spair = parsePair(stext);
  if (spair) {
    if (scount !== spair.a && spair.a <= 150000) {
      if (scount != null) fixes.push(`steps: ${scount} was the ${scount === spair.b ? "goal" : "wrong number"}, done is ${spair.a} ("${stext}")`);
      scount = spair.a;
    }
    sgoal = spair.b;
  } else if (scount == null && stext) scount = num(kNum(stext), 0, 150000);
  if (scount === 0) scount = null; // "0" is what's there before anything syncs, not a day's steps
  if (scount != null && !/week|average|avg/.test(stepsFor) && !(screen === "period_summary" && !/today|yesterday/.test(stepsFor))) {
    steps = { count: scount, goal: sgoal, text: stext, approx: hasK(String(stext || "").split(/\/|\bof\b/i)[0]), yesterday: /yesterday/.test(stepsFor) };
  }

  const extras = [];
  for (const e of arr(o.extras).slice(0, 6)) {
    const label = str(obj(e).label, 24);
    const value = str(obj(e).value != null ? String(obj(e).value) : null, 24);
    if (!label || !value || /goal|target|remaining|budget|steps/i.test(label)) continue;
    if (!extras.some((x) => x.label.toLowerCase() === label.toLowerCase())) extras.push({ label, value });
  }
  const weight = num(o.weight_kg, 25, 350, 1);
  if (weight != null && !extras.some((x) => /weight/i.test(x.label))) extras.unshift({ label: "Weight", value: `${weight} kg` });
  const ex = num(o.exercise_kcal, 1, 6000);
  if (ex != null && !extras.some((x) => /kcal|cal\b/i.test(x.value))) extras.unshift({ label: "Burned", value: fmtKcal(ex) });

  return {
    v: 2,
    screen,
    app: str(o.app, 40),
    date_shown,
    date,
    clock,
    day,
    meals,
    steps,
    exercise_kcal: ex,
    weight_kg: weight,
    extras: extras.slice(0, 4),
    cut_off: o.cut_off === true || o.cut_off === "true",
    note: str(o.note, 160) || "",
    fixes,
  };
}

// ---------- does it add up? ----------
const energy = (p, c, f) => (p == null || c == null || f == null ? null : 4 * p + 4 * c + 9 * f);
export function checkReading(r) {
  const out = [];
  const d = r.day;
  if (d) {
    for (const k of ["protein", "carbs", "fat"]) {
      if (d[k] != null && d[k + "_goal"] != null && d[k] === d[k + "_goal"] && d[k] > 0 && !parsePair(d[k + "_text"])) out.push({ field: k, issue: "eaten_is_goal" });
    }
    if (d.kcal != null && d.kcal_goal != null && d.kcal === d.kcal_goal) out.push({ field: "kcal", issue: "eaten_is_goal" });
    if (d.kcal != null && d.kcal_left != null && d.kcal_left > 0 && d.kcal === d.kcal_left) out.push({ field: "kcal", issue: "eaten_is_remaining" });
    if (d.kcal != null && d.kcal_left != null && d.kcal_goal != null) {
      const gap = Math.abs(d.kcal + d.kcal_left - d.kcal_goal);
      const exk = r.exercise_kcal || 0;
      if (gap > 40 && Math.abs(gap - exk) > 40) out.push({ field: "kcal", issue: "goal_maths" });
    }
    const e = energy(d.protein, d.carbs, d.fat);
    if (d.kcal != null && d.kcal >= 100 && e != null && e > d.kcal * 1.3 + 60) out.push({ field: "macros", issue: "macros_exceed_kcal" });
    if (d.kcal != null && d.kcal >= 150 && d.protein != null && d.protein * 4 > d.kcal * 0.85) out.push({ field: "protein", issue: "protein_too_high" });
    const mk = r.meals.filter((m) => m.logged && m.kcal != null && m.kcal > 0);
    if (d.kcal != null && mk.length >= 2 && mk.some((m) => Math.abs(m.kcal - d.kcal) <= 1)) out.push({ field: "kcal", issue: "day_equals_one_meal" });
  }
  r.meals.forEach((m, i) => {
    const e = energy(m.protein, m.carbs, m.fat);
    if (m.kcal != null && m.kcal >= 100 && e != null && e > m.kcal * 1.3 + 60) out.push({ field: `meal${i}`, issue: "macros_exceed_kcal" });
  });
  if (r.steps && r.steps.goal != null && r.steps.count === r.steps.goal && !parsePair(r.steps.text)) out.push({ field: "steps", issue: "count_is_goal" });
  return out;
}

// Merge the focused second look into the first reading. Values it confirms or corrects are kept only if
// they add up; anything still failing its check is listed in r.unsure and never treated as definite.
export function applyVerify(r, v, issues) {
  const fixes = [];
  v = obj(v);
  const out = JSON.parse(JSON.stringify(r));
  const vd = obj(v.day);
  if (out.day && Object.keys(vd).length) {
    const kc = cleanNutrient(vd.calories, "kcal", fixes);
    const p = cleanNutrient(vd.protein, "protein", fixes);
    const cb = cleanNutrient(vd.carbs, "carbs", fixes);
    const f = cleanNutrient(vd.fat, "fat", fixes);
    const take = (key, n) => {
      if (n.eaten == null) return;
      if (out.day[key] !== n.eaten) fixes.push(`${key}: second look says ${n.eaten}, not ${out.day[key] ?? "nothing"}`);
      out.day[key] = n.eaten;
      if (n.goal != null) out.day[key + "_goal"] = n.goal;
      if (n.text) out.day[key + "_text"] = n.text;
    };
    take("kcal", kc);
    take("protein", p);
    take("carbs", cb);
    take("fat", f);
  }
  const vm = arr(v.meals);
  if (vm.length) {
    for (const m of vm) {
      const mm = obj(m);
      const slot = slotOf(mm.name);
      const target = out.meals.find((x) => (slot && x.slot === slot) || (!slot && out.meals.length === 1));
      if (!target) continue;
      for (const [k, max] of [["kcal", 6000], ["protein", 400], ["carbs", 800], ["fat", 400]]) {
        const nv = num(k === "kcal" ? mm.calories : mm[k], 0, max, 1);
        if (nv != null && nv !== target[k]) {
          fixes.push(`${target.name || "meal"} ${k}: second look says ${nv}, not ${target[k] ?? "nothing"}`);
          target[k] = nv;
        }
      }
    }
  }
  const left = checkReading(out);
  out.fixes = (out.fixes || []).concat(fixes);
  out.checked = { asked: issues.map((i) => i.issue), still: left.map((i) => i.issue) };
  out.unsure = [...new Set(left.map((i) => i.field))];
  return out;
}

// ---------- the flat columns (thumbnails, editing, older app versions) ----------
export function flatFields(r) {
  const sumOf = (ms, k) => (ms.length && ms.every((m) => m[k] != null) ? Math.round(ms.reduce((a, m) => a + m[k], 0) * 10) / 10 : null);
  let kind = "other";
  let kcal = null;
  let protein = null;
  let carbs = null;
  let fat = null;
  if (r.screen === "day_summary" && r.day) {
    ({ kcal, protein, carbs, fat } = r.day);
    kind = r.steps ? "food_steps" : "food";
  } else if (["meal", "diary_part", "food_item"].includes(r.screen)) {
    const ms = r.meals.filter((m) => m.logged && m.kcal != null);
    kcal = sumOf(ms, "kcal");
    protein = sumOf(ms, "protein");
    carbs = sumOf(ms, "carbs");
    fat = sumOf(ms, "fat");
    kind = "food";
  } else if (r.screen === "steps") kind = "steps";
  else if (r.screen === "weight" || (r.screen === "period_summary" && r.weight_kg != null)) kind = "weight";
  if (kind === "other" && r.steps && r.steps.count != null) kind = "steps";
  const d = r.day || {};
  const goal = d.kcal_goal ?? (d.kcal != null && d.kcal_left != null ? d.kcal + d.kcal_left : d.kcal != null && d.kcal_over != null ? d.kcal - d.kcal_over : null);
  return {
    kind,
    app: r.app,
    kcal,
    protein,
    carbs,
    fat,
    steps: r.steps ? r.steps.count : null,
    kcal_goal: goal != null && goal >= 500 && goal <= 8000 ? Math.round(goal) : null,
    partial: kind === "food" && r.screen !== "day_summary" ? 1 : 0,
    extras: r.extras,
    note: r.note,
  };
}

// What's kept in logs_items.reading: everything the app needs to put a day together, kept small.
export function compactReading(r, model) {
  const out = {
    v: r.v,
    screen: r.screen,
    date_shown: r.date_shown,
    date: r.date,
    clock: r.clock,
    model,
    day: r.day,
    meals: r.meals.map((m) => ({ ...m, foods: m.foods.slice(0, 12).map((f) => ({ name: f.name, kcal: f.kcal })) })),
    steps: r.steps,
    cut_off: r.cut_off || undefined,
    fixes: r.fixes && r.fixes.length ? r.fixes.slice(0, 6) : undefined,
    checked: r.checked,
    unsure: r.unsure && r.unsure.length ? r.unsure : undefined,
  };
  return JSON.stringify(out);
}
