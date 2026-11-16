import { Notification } from '../models/index.js';
import { wrap } from '../utils/errors.js';
import { formatDateTime } from '../utils/format.js';

export const list = wrap(async (req, res) => {
  const rows = await Notification.findAll({ where: { user_id: req.user.id }, order: [['created_at', 'DESC']], limit: 20 });
  const unread = await Notification.count({ where: { user_id: req.user.id, read_at: null } });
  res.json({
    unread,
    data: rows.map((n) => ({ id: n.id, title: n.title, message: n.message, type: n.type, link: n.link, read_at: n.read_at, created_label: formatDateTime(n.createdAt) })),
  });
});

export const markRead = wrap(async (req, res) => {
  await Notification.update({ read_at: new Date() }, { where: { id: req.params.id, user_id: req.user.id } });
  res.json({ message: 'Marked as read.' });
});

export const markAllRead = wrap(async (req, res) => {
  await Notification.update({ read_at: new Date() }, { where: { user_id: req.user.id, read_at: null } });
  res.json({ message: 'All notifications marked as read.' });
});
