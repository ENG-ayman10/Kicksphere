const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireParams } = require('../middlewares/validate');

const {
  getNotifications,
  markAsRead
} = require('../controllers/notificationController');


// ==========================================
// 🔥 GET USER NOTIFICATIONS (Protected)
// ==========================================
router.get('/:userId', authMiddleware, requireParams(['userId']), getNotifications);


// ==========================================
// 🔥 MARK AS READ (Protected)
// ==========================================
router.patch('/:userId/:notificationId', authMiddleware, requireParams(['userId', 'notificationId']), markAsRead);


module.exports = router;