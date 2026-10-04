const db = require('../config/firebase');
const { createHash } = require('node:crypto');

// ==========================================
// 🔥 SAVE NOTIFICATION
// ==========================================
exports.saveNotification = async (userId, data) => {
  const notifications = db
    .collection('users')
    .doc(userId)
    .collection('notifications');
  const ref = data.eventId
    ? notifications.doc(createHash('sha256').update(String(data.eventId)).digest('hex'))
    : notifications.doc();

  const payload = {
    ...data,
    isRead: false,
    createdAt: new Date()
  };

  if (data.eventId) {
    return db.runTransaction(async transaction => {
      const previous = await transaction.get(ref);
      if (previous.exists) return { id: ref.id, ...previous.data(), duplicate: true };
      transaction.set(ref, payload);
      return { id: ref.id, ...payload, duplicate: false };
    });
  }
  await ref.set(payload);

  return {
    id: ref.id,
    ...payload
  };
};
