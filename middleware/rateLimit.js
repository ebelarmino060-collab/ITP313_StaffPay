/** Tiny in-memory rate limiter (per IP + route). */
export function rateLimit({ windowMs = 60000, max = 10, message = 'Too many attempts. Please wait a minute and try again.' } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    hits.set(key, entry);
    if (entry.count > max) {
      if (req.accepts('html')) {
        req.flash('error_msg', message);
        return res.redirect(req.get('Referer') || '/login');
      }
      return res.status(429).json({ message });
    }
    return next();
  };
}
