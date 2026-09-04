const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireAdmin } = require('../middlewares/authorization');

const { syncPlayers } = require('../controllers/playerController');

// POST /api/players/sync — Protected (admin-like operation)
router.post('/sync', authMiddleware, requireAdmin, syncPlayers);

module.exports = router;
