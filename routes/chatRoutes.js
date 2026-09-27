const express = require('express');
const { rateLimit } = require('express-rate-limit');
const chatLimit = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: true, legacyHeaders: false });
const router = express.Router();
const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireParams, requireFields } = require('../middlewares/validate');
const chatController = require('../controllers/chatController');

// مسار لجلب الرسائل (GET) - public
router.get('/:matchId/messages', requireParams(['matchId']), chatController.getMatchMessages);

// مسار لإرسال رسالة جديدة (POST) - protected
router.post('/:matchId/send', authMiddleware, chatLimit, requireParams(['matchId']), requireFields(['text']), chatController.sendMessage);

module.exports = router;
