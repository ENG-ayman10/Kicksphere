/**
 * @file pushNotificationService.js
 * @description Firebase Cloud Messaging (FCM) push notification service.
 */

const { getMessaging } = require('firebase-admin/messaging');
const logger = require('../utils/logger');

// ==========================================
// 🔥 SEND PUSH NOTIFICATION
// ==========================================
exports.sendPushNotification = async (token, title, body) => {
  try {
    if (!token) {
      logger.warn("⚠️ Push skipped: no FCM token provided");
      return;
    }

    const message = {
      notification: {
        title,
        body
      },
      token
    };

    await getMessaging().send(message);

    logger.info("📲 Push sent successfully");

  } catch (error) {
    // Handle invalid/expired tokens gracefully
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      logger.warn('⚠️ Invalid FCM token.');
    } else {
      logger.error(`❌ Push Error: ${error.message}`);
    }
  }
};
