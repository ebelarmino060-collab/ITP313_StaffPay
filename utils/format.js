import { parseDate, pad } from './time.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const number = (v, digits = 2) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const money = (v, symbol = '₱') => `${symbol}${number(v, 2)}`;

export function formatDate(value, style = 'medium') {
  const d = parseDate(value);
  if (!d) return '—';
  switch (style) {
    case 'short': return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    case 'long': return `${DAYS_LONG[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    case 'month': return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
    case 'weekday': return DAYS[d.getDay()];
    case 'weekdayLong': return DAYS_LONG[d.getDay()];
    case 'day': return String(d.getDate());
    case 'year': return String(d.getFullYear());
    default: return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
}

export function formatTime(value) {
  const d = parseDate(value);
  if (!d) return '—';
  const h = d.getHours();
  return `${((h + 11) % 12) + 1}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

export const formatDateTime = (v) => (parseDate(v) ? `${formatDate(v)} ${formatTime(v)}` : '—');

/** "06:00:00" -> "6:00 AM" */
export function formatClock(hms) {
  if (!hms) return '—';
  const [h, m] = hms.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

export function minutesToHours(minutes) {
  const m = Number(minutes || 0);
  if (!m) return '0h';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`;
}

export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const initials = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
