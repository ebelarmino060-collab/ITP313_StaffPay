/** A user-facing error (shown as a flash message / JSON 422). */
export class AppError extends Error {
  constructor(message, status = 422, fields = null) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export const fail = (message, status = 422) => { throw new AppError(message, status); };
export const assert = (condition, message, status = 422) => { if (!condition) throw new AppError(message, status); };

/** Wrap async route handlers so rejected promises reach the error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
