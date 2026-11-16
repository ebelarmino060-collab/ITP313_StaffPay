import { parseDate, toDateStr } from './time.js';

/**
 * Small form validator.
 *   const { data, errors } = validate(req.body, {
 *     name: 'required|string|max:100',
 *     email: 'nullable|email',
 *     salary: 'required|number|min:0',
 *     status: 'required|in:active,resigned',
 *     date_hired: 'required|date',
 *     days: 'array|each:int',
 *   }, { name: 'Full name' })
 * Returns cleaned values (numbers parsed, dates normalised to YYYY-MM-DD, booleans) and an errors map.
 */
export function validate(input, rules, labels = {}) {
  const data = {};
  const errors = {};

  for (const [field, ruleString] of Object.entries(rules)) {
    const rs = ruleString.split('|');
    const label = labels[field] || field.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    let value = input[field];
    if (typeof value === 'string') value = value.trim();
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

    if (rs.includes('boolean')) {
      data[field] = ['1', 'true', 'on', 'yes', true, 1].includes(value);
      continue;
    }
    if (rs.includes('array')) {
      let arr = value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value];
      if (rs.includes('each:int')) arr = arr.map((v) => parseInt(v, 10)).filter((v) => !Number.isNaN(v));
      if (rs.includes('required') && arr.length === 0) errors[field] = `${label} is required.`;
      data[field] = arr;
      continue;
    }
    if (empty) {
      if (rs.includes('required')) errors[field] = `${label} is required.`;
      data[field] = null;
      continue;
    }

    let err = null;
    for (const r of rs) {
      const [name, arg] = r.split(':');
      if (err) break;
      switch (name) {
        case 'string': value = String(value); break;
        case 'email': if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) err = `${label} must be a valid email address.`; break;
        case 'number': case 'int': {
          const n = Number(value);
          if (Number.isNaN(n)) err = `${label} must be a number.`;
          else value = name === 'int' ? Math.trunc(n) : n;
          break;
        }
        case 'min':
          if (typeof value === 'number' ? value < Number(arg) : String(value).length < Number(arg)) {
            err = typeof value === 'number' ? `${label} must be at least ${arg}.` : `${label} must be at least ${arg} characters.`;
          }
          break;
        case 'max':
          if (typeof value === 'number' ? value > Number(arg) : String(value).length > Number(arg)) {
            err = typeof value === 'number' ? `${label} may not be greater than ${arg}.` : `${label} may not be longer than ${arg} characters.`;
          }
          break;
        case 'in': if (!arg.split(',').includes(String(value))) err = `${label} is invalid.`; break;
        case 'date': {
          const d = parseDate(value);
          if (!d) err = `${label} must be a valid date.`;
          else value = toDateStr(d);
          break;
        }
        case 'datetime': {
          const d = parseDate(value);
          if (!d) err = `${label} must be a valid date and time.`;
          else value = d;
          break;
        }
        case 'time': if (!/^\d{2}:\d{2}(:\d{2})?$/.test(value)) err = `${label} must be a valid time (HH:MM).`; break;
        case 'phone': if (!/^[0-9+\-\s()]{7,20}$/.test(value)) err = `${label} must contain digits, spaces, +, - and parentheses only.`; break;
        default: break;
      }
    }
    if (err) errors[field] = err;
    data[field] = value;
  }

  return { data, errors, ok: Object.keys(errors).length === 0 };
}
