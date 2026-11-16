/** Redirect target: the referring page on this site, or a fallback. */
export function back(req, fallback = '/') {
  const ref = req.get('Referer');
  if (!ref) return fallback;
  try {
    const url = new URL(ref);
    return url.host === req.get('host') ? url.pathname + url.search : fallback;
  } catch {
    return fallback;
  }
}

/** Flash a success message and redirect. */
export function done(req, res, message, to = null) {
  if (message) req.flash('success_msg', message);
  return res.redirect(to || back(req));
}

/**
 * Validation failed: flash the first error, remember the submitted values so the
 * page can reopen the modal form with them, and redirect back.
 */
export function invalid(req, res, errors, { modal = null, to = null } = {}) {
  const messages = Object.values(errors);
  req.flash('error_msg', messages[0] || 'Please check the form.');
  const values = { ...req.body };
  delete values._csrf;
  delete values.password;
  delete values.new_password;
  delete values.password_confirmation;
  delete values.current_password;
  req.flash('form', { modal, errors, values, action: req.originalUrl });
  return res.redirect(to || back(req));
}
