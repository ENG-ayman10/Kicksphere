const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireSelfOrAdmin } = require('../middlewares/authorization');
const { requireParams, requireFields } = require('../middlewares/validate');

const {
  savePreferences,
  getPreferences,
  addFavorite,
  getFavorites,
  removeFavorite,
  uploadAvatar
} = require('../controllers/userController');

const upload = require('../middlewares/uploadMiddleware');

// ==========================================
// 🔥 USER PREFERENCES (Protected)
// ==========================================

// GET /api/users/:userId/preferences
router.get('/:userId/preferences', authMiddleware, requireParams(['userId']), requireSelfOrAdmin(), getPreferences);

// POST /api/users/:userId/preferences
router.post('/:userId/preferences', authMiddleware, requireParams(['userId']), requireSelfOrAdmin(), savePreferences);


// ==========================================
// 🔥 USER FAVORITES (Protected)
// ==========================================

// GET /api/users/:userId/favorites
router.get('/:userId/favorites', authMiddleware, requireParams(['userId']), requireSelfOrAdmin(), getFavorites);

// POST /api/users/:userId/favorites
router.post('/:userId/favorites', authMiddleware, requireParams(['userId']), requireSelfOrAdmin(), requireFields(['item']), addFavorite);

// DELETE /api/users/:userId/favorites/:favoriteId
router.delete('/:userId/favorites/:favoriteId', authMiddleware, requireParams(['userId', 'favoriteId']), requireSelfOrAdmin(), removeFavorite);

// ==========================================
// 🔥 USER AVATAR (Protected)
// ==========================================

// POST /api/users/:userId/avatar
router.post('/:userId/avatar', authMiddleware, requireParams(['userId']), requireSelfOrAdmin(), upload.single('image'), uploadAvatar);

module.exports = router;
