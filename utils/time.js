/*
 * Date helpers. All calculations use the process timezone (APP_TIMEZONE, default Asia/Manila).
 * Date-only values are "YYYY-MM-DD" strings; date-times are Date objects.
 */
export const pad = (n) => String(n).padStart(2, '0');

/** Parse "YYYY-MM-DD", "YYYY-MM-DD HH:MM[:SS]", "YYYY-MM-DDTHH:MM" or a Date as local time. */
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return new Date(value.getTime());
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value).trim());
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const toDateStr = (d = new Date()) => {
  const x = parseDate(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

export const toDateTimeStr = (d) => {
  const x = parseDate(d);
  return x ? `${toDateStr(x)} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}` : null;
};

/** Value for <input type="datetime-local">. */
export const toDateTimeInput = (d) => {
  const x = parseDate(d);
  return x ? `${toDateStr(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}` : '';
};

export const today = () => toDateStr(new Date());

/** Combine a date string with "HH:MM[:SS]". */
export const at = (dateStr, hms) => parseDate(`${dateStr} ${hms.length === 5 ? `${hms}:00` : hms}`);

export const addDays = (d, n) => { const x = parseDate(d); x.setDate(x.getDate() + n); return x; };
export const addMinutes = (d, n) => new Date(parseDate(d).getTime() + n * 60000);
export const addHours = (d, n) => addMinutes(d, n * 60);
export const addDaysStr = (s, n) => toDateStr(addDays(s, n));

/** Whole minutes from a to b (negative when b is earlier). */
export const minutesBetween = (a, b) => Math.trunc((parseDate(b) - parseDate(a)) / 60000);

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export const isoWeekday = (d) => ((parseDate(d).getDay() + 6) % 7) + 1;

export function dateRange(from, to) {
  const out = [];
  let cur = parseDate(from);
  const end = parseDate(to);
  let guard = 0;
  while (cur <= end && guard++ < 1000) {
    out.push(toDateStr(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

export const startOfMonth = (d = new Date()) => { const x = parseDate(d); return new Date(x.getFullYear(), x.getMonth(), 1); };
export const endOfMonth = (d = new Date()) => { const x = parseDate(d); return new Date(x.getFullYear(), x.getMonth() + 1, 0); };
export const startOfWeek = (d = new Date()) => addDays(d, -(isoWeekday(d) - 1));
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
export const monthStr = (d = new Date()) => toDateStr(d).slice(0, 7);
