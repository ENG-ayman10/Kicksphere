const db = require('../config/firebase');

// ==========================================
// 🔥 SAVE NOTIFICATION
// ==========================================
exports.saveNotification = async (userId, data) => {
  const ref = db
    .collection('users')
    .doc(userId)
    .collection('notifications')
    .doc();

  const payload = {
    ...data,
    isRead: false,
    createdAt: new Date()
  };

  await ref.set(payload);

  return {
    id: ref.id,
    ...payload
  };
};