// TrueStay Pay — shared helpers (dates, validation, errors)

export const TRACK_START = "2026-09-28";
export const PACKAGES = ["pt", "coaching", "programme"];
export const KINDS = ["pt", "coaching", "programme", "break"];
export const BILLINGS = ["monthly", "upfront", "split", "none"];
export const TENURES = ["new", "newish", "longstanding"];
export const METHODS = ["manual", "dd"];
export const WEEKS = [4, 8, 12, 16];

export const KIND_LABEL = { pt: "Personal training", coaching: "Full coaching", programme: "Programme", break: "Break" };
export const PKG_LABEL = { pt: "Personal training only", coaching: "Full coaching", programme: "Programme only" };
export const TEN_LABEL = { new: "New", newish: "New-ish", longstanding: "Longstanding" };
export const METHOD_LABEL = { manual: "Manual payment", dd: "Direct debit" };
export const STATUS_LABEL = { active: "Active", paused: "Paused", finished: "Finished" };
export const BILLING_LABEL = { monthly: "Monthly", upfront: "Upfront", split: "Split payments", none: "Pay as they go" };

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (msg) => {
  throw new HttpError(400, msg);
};

export const nowS = () => Math.floor(Date.now() / 1000);

// ---------- dates: 'YYYY-MM-DD' strings in UK time ----------
export const londonToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const londonHour = () =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(new Date())) % 24;
export const londonWeekday = () =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(new Date());
export const isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};
export const addDays = (s, n) => {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const occurrence = (y, m, day) =>
  `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, "0")}`;
// same day-of-month, k months later (clamped to month end)
export const addMonthsKeepDay = (iso, k, day) => {
  let [y, m, d] = iso.split("-").map(Number);
  m += k;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return occurrence(y, m, day || d);
};
// first date on/after `from` that falls on `day` of a month
export const nextOnDay = (day, from) => {
  const [y, m] = from.split("-").map(Number);
  const d = occurrence(y, m, day);
  return d >= from ? d : addMonthsKeepDay(`${y}-${String(m).padStart(2, "0")}-01`, 1, day);
};
export const endOfNextMonth = (today) => addMonthsKeepDay(today.slice(0, 8) + "01", 1, 31);
export const ukDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
export const shortDate = (iso) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(iso + "T00:00:00Z"));

// ---------- validation ----------
export function pence(v, label = "amount") {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) bad(`Enter a valid ${label}`);
  return n;
}
export const oneOf = (v, list, msg) => (list.includes(v) ? v : bad(msg));
export const text = (v, max) => String(v ?? "").trim().slice(0, max);
export const idFrom = (s) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) bad("Bad id");
  return n;
};
export const numOrNull = (v, min, max) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) bad("One of the numbers isn't valid");
  return Math.round(n * 100) / 100;
};
export const money = (p) => {
  const s = "£" + Math.floor(p / 100).toLocaleString("en-GB");
  return p % 100 ? s + "." + String(p % 100).padStart(2, "0") : s;
};
