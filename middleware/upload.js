import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { AppError } from '../utils/errors.js';
import { verifyCsrf } from './csrf.js';

export const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(process.cwd(), 'public', 'uploads');

/** Image upload middleware (max 2 MB) saving to public/uploads/<folder>, followed by CSRF verification. */
export function imageUpload(field, folder) {
  const dir = path.join(UPLOAD_ROOT, folder);
  fs.mkdirSync(dir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => (/^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)
      ? cb(null, true)
      : cb(new AppError('Please upload a PNG, JPG, GIF or WEBP image.'))),
  }).single(field);

  return [
    (req, res, next) => upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'The image may not be larger than 2 MB.' : err.message));
      return next(err);
    }),
    (req, res, next) => verifyCsrf(req, res, (err) => {
      if (err && req.file) fs.unlink(req.file.path, () => {});
      next(err);
    }),
  ];
}

/**
 * Attendance file upload (TXT/CSV/DAT/LOG, max 5 MB) kept in memory – never written to a public folder –
 * followed by CSRF verification.
 */
export function textUpload(field) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (/\.(txt|csv|dat|log)$/i.test(file.originalname)
      ? cb(null, true)
      : cb(new AppError('Please upload a .txt attendance file (.csv, .dat and .log are also accepted).'))),
  }).single(field);
  return [
    (req, res, next) => upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'The file may not be larger than 5 MB.' : err.message));
      return next(err);
    }),
    verifyCsrf,
  ];
}

/** Path relative to public/uploads, e.g. "photos/123.jpg". */
export const storedPath = (file, folder) => (file ? `${folder}/${file.filename}` : null);

export function removeUpload(relPath) {
  if (!relPath) return;
  const full = path.join(UPLOAD_ROOT, relPath);
  if (full.startsWith(UPLOAD_ROOT)) fs.unlink(full, () => {});
}
