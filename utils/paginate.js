import { plain } from '../models/index.js';

/**
 * findAndCountAll with page links that keep the current query string.
 * Returns { rows (plain objects), pager } where pager is used by the "pagination" partial.
 */
export async function paginate(Model, req, options = {}, perPage = 15) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const { rows, count } = await Model.findAndCountAll({ ...options, limit: perPage, offset: (page - 1) * perPage, distinct: true });
  return { rows: plain(rows), pager: buildPager(req, page, perPage, count) };
}

export function buildPager(req, page, perPage, total) {
  const last = Math.max(1, Math.ceil(total / perPage));
  const link = (p) => {
    const q = new URLSearchParams({ ...req.query, page: String(p) });
    return `${req.path}?${q.toString()}`;
  };
  const pages = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(last, page + 2); p++) pages.push({ num: p, url: link(p), active: p === page });
  return {
    total,
    from: total ? (page - 1) * perPage + 1 : 0,
    to: Math.min(total, page * perPage),
    pages,
    prev: page > 1 ? link(page - 1) : null,
    next: page < last ? link(page + 1) : null,
    show: total > 0,
  };
}

/** Paginate an in-memory array. */
export function paginateArray(items, req, perPage = 15) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { rows: items.slice((page - 1) * perPage, page * perPage), pager: buildPager(req, page, perPage, items.length) };
}
