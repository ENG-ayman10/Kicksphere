/**
 * @file chatService.js
 * @description Service for saving chat messages.
 * Uses 'chat_rooms/{matchId}/messages' path (unified with chatController).
 */

const db = require('../config/firebase');

// ==========================================
// 🔥 SAVE MESSAGE (unified path: chat_rooms)
// ==========================================
exports.saveMessage = async (matchId, messageData) => {
  const ref = db
    .collection('chat_rooms')
    .doc(matchId)
    .collection('messages')
    .doc();

  const payload = {
    ...messageData,
    timestamp: new Date()
  };

  await ref.set(payload);

  return {
    id: ref.id,
    ...payload
  };
};