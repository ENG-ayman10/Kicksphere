const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireParams, requireFields } = require('../middlewares/validate');
const chatController = require('../controllers/chatController');

// مسار لجلب الرسائل (GET) - public
router.get('/:matchId/messages', requireParams(['matchId']), chatController.getMatchMessages);

// مسار لإرسال رسالة جديدة (POST) - protected
router.post('/:matchId/send', authMiddleware, requireParams(['matchId']), requireFields(['text', 'username']), chatController.sendMessage);

module.exports = router;
