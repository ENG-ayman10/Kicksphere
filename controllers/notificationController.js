/**
 * @file notificationController.js
 * @description Controller for user notification operations.
 */

const db = require('../config/firebase');
const logger = require('../utils/logger');

// ==========================================
// 🔥 GET USER NOTIFICATIONS
// ==========================================
exports.getNotifications = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required"
      });
    }

    const snapshot = await db
      .collection('users')
      .doc(userId)
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const data = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      data
    });

  } catch (error) {
    logger.error(`❌ GET NOTIFICATIONS ERROR: ${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ==========================================
// 🔥 MARK AS READ
// ==========================================
exports.markAsRead = async (req, res) => {
  try {
    const { userId, notificationId } = req.params;

    if (!userId || !notificationId) {
      return res.status(400).json({
        success: false,
        message: "userId and notificationId are required"
      });
    }

    // Verify notification exists before updating
    const notifRef = db
      .collection('users')
      .doc(userId)
      .collection('notifications')
      .doc(notificationId);

    const notifDoc = await notifRef.get();

    if (!notifDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Notification not found"
      });
    }

    await notifRef.update({ isRead: true });

    res.json({
      success: true,
      message: "Notification marked as read"
    });

  } catch (error) {
    logger.error(`❌ MARK READ ERROR: ${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};