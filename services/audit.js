import { AuditLog, Notification, User } from '../models/index.js';

/** Record an important administrative or payroll action. */
export async function audit(req, action, description, entity = null, changes = null) {
  try {
    await AuditLog.create({
      user_id: req?.user?.id ?? null,
      action,
      entity_type: entity ? entity.constructor?.name : null,
      entity_id: entity?.id ?? null,
      description,
      changes,
      ip_address: req?.ip ?? null,
    });
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

/** Send an in-app notification to one or more user ids. */
export async function notify(userIds, title, message, type = 'info', link = null) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (ids.length) await Notification.bulkCreate(ids.map((user_id) => ({ user_id, title, message, type, link })));
}

/** Notify every active administrator and HR user. */
export async function notifyManagement(title, message, type = 'info', link = null) {
  const users = await User.findAll({ where: { role: ['admin', 'hr'], is_active: true }, attributes: ['id'] });
  await notify(users.map((u) => u.id), title, message, type, link);
}
