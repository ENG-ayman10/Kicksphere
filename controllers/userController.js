const db = require('../config/firebase');
const logger = require('../utils/logger');


// ==========================================
// 🔥 1. SAVE USER PREFERENCES
// ==========================================
exports.savePreferences = async (req, res) => {
  try {
    const { userId } = req.params;
    const { teams, leagues, content, fcmToken } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required"
      });
    }

    await db.collection('users').doc(userId).set({
      preferences: {
        teams: teams || [],
        leagues: leagues || [],
        content: content || []
      },
      fcmToken: fcmToken || null,
      updatedAt: new Date()
    }, { merge: true });

    res.json({
      success: true,
      message: "Preferences saved successfully"
    });

  } catch (error) {
    logger.error("❌ SAVE PREF ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ==========================================
// 🔥 2. GET USER PREFERENCES
// ==========================================
exports.getPreferences = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required"
      });
    }

    const doc = await db.collection('users').doc(userId).get();

    if (!doc.exists) {
      return res.json({
        success: true,
        data: {}
      });
    }

    res.json({
      success: true,
      data: doc.data().preferences || {}
    });

  } catch (error) {
    logger.error("❌ GET PREF ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ==========================================
// 🔥 3. ADD FAVORITE
// ==========================================
exports.addFavorite = async (req, res) => {
  try {
    const { userId } = req.params;
    const { item } = req.body;

    if (!userId || !item) {
      return res.status(400).json({
        success: false,
        message: "userId and item are required"
      });
    }

    const docRef = await db
      .collection('users')
      .doc(userId)
      .collection('favorites')
      .add({
        ...item,
        createdAt: new Date()
      });

    res.json({
      success: true,
      id: docRef.id
    });

  } catch (error) {
    logger.error("❌ ADD FAVORITE ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ==========================================
// 🔥 4. GET FAVORITES
// ==========================================
exports.getFavorites = async (req, res) => {
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
      .collection('favorites')
      .orderBy('createdAt', 'desc')
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
    logger.error("❌ GET FAVORITES ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ==========================================
// 🔥 5. REMOVE FAVORITE
// ==========================================
exports.removeFavorite = async (req, res) => {
  try {
    const { userId, favoriteId } = req.params;

    if (!userId || !favoriteId) {
      return res.status(400).json({
        success: false,
        message: "userId and favoriteId are required"
      });
    }

    await db
      .collection('users')
      .doc(userId)
      .collection('favorites')
      .doc(favoriteId)
      .delete();

    res.json({
      success: true,
      message: "Favorite removed"
    });

  } catch (error) {
    logger.error("❌ REMOVE FAVORITE ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ==========================================
// 🔥 6. UPLOAD AVATAR
// ==========================================
exports.uploadAvatar = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ success: false, message: "userId is required" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file provided" });
    }

    // Host should be dynamic in production
    const host = req.get('host');
    const protocol = req.protocol;
    const imageUrl = `${protocol}://${host}/uploads/avatars/${req.file.filename}`;

    await db.collection('users').doc(userId).set({
      avatarUrl: imageUrl,
      updatedAt: new Date()
    }, { merge: true });

    res.json({
      success: true,
      message: "Avatar uploaded successfully",
      avatarUrl: imageUrl
    });

  } catch (error) {
    logger.error("❌ UPLOAD AVATAR ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};