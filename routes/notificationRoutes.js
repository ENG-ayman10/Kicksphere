const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireSelfOrAdmin } = require('../middlewares/authorization');
const { requireParams } = require('../middlewares/validate');

const {
  getNotifications,
  markAsRead
} = require('../controllers/notificationController');


// ==========================================
// 🔥 GET USER NOTIFICATIONS (Protected)
// ==========================================
router.get('/:userId', authMiddleware, requireParams(['userId']), requireSelfOrAdmin(), getNotifications);


// ==========================================
// 🔥 MARK AS READ (Protected)
// ==========================================
router.patch('/:userId/:notificationId', authMiddleware, requireParams(['userId', 'notificationId']), requireSelfOrAdmin(), markAsRead);


module.exports = router;
