/**
 * @file pushNotificationService.js
 * @description Firebase Cloud Messaging (FCM) push notification service.
 */

const admin = require('firebase-admin');
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

    await admin.messaging().send(message);

    logger.info("📲 Push sent successfully");

  } catch (error) {
    // Handle invalid/expired tokens gracefully
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      logger.warn(`⚠️ Invalid FCM token: ${token.substring(0, 10)}...`);
    } else {
      logger.error(`❌ Push Error: ${error.message}`);
    }
  }
};