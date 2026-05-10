const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middlewares/authMiddleware');

const { syncPlayers } = require('../controllers/playerController');

// POST /api/players/sync — Protected (admin-like operation)
router.post('/sync', authMiddleware, syncPlayers);

module.exports = router;