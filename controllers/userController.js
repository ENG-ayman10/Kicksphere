const db = require('../config/firebase');
const logger = require('../utils/logger');
const {
  normalizeFavoriteItem,
  normalizePreferences,
  normalizeStoredFavorite
} = require('../utils/userContracts');

const getPublicBaseUrl = (req) => {
  const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configuredBaseUrl) return configuredBaseUrl;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_BASE_URL is required in production for uploaded asset URLs');
  }

  return `${req.protocol}://${req.get('host')}`;
};

// ==========================================
// 🔥 1. SAVE USER PREFERENCES
// ==========================================
exports.savePreferences = async (req, res) => {
  try {
    const { userId } = req.params;
    const { fcmToken } = req.body;
    const preferences = normalizePreferences(req.body);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required"
      });
    }

    const update = {
      preferences,
      updatedAt: new Date()
    };

    if (typeof fcmToken === 'string' && fcmToken.trim()) {
      update.fcmToken = fcmToken.trim();
    } else if (fcmToken === null) {
      update.fcmToken = null;
    }

    await db.collection('users').doc(userId).set(update, { merge: true });

    res.json({
      success: true,
      message: "Preferences saved successfully"
    });

  } catch (error) {
    logger.error("❌ SAVE PREF ERROR:", error);

    res.status(500).json({
      success: false,
      message: 'Server Error'
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
      message: 'Server Error'
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

    const favorite = normalizeFavoriteItem(item);
    const favoritesRef = db
      .collection('users')
      .doc(userId)
      .collection('favorites');
    const existing = await favoritesRef
      .where('canonicalKey', '==', favorite.canonicalKey)
      .limit(1)
      .get();

    if (!existing.empty) {
      const existingDoc = existing.docs[0];
      await existingDoc.ref.set({
        ...favorite,
        updatedAt: new Date()
      }, { merge: true });

      return res.json({
        success: true,
        id: existingDoc.id,
        data: {
          id: existingDoc.id,
          ...favorite
        },
        created: false
      });
    }

    const docRef = await favoritesRef.add({
      ...favorite,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({
      success: true,
      id: docRef.id,
      data: {
        id: docRef.id,
        ...favorite
      },
      created: true
    });

  } catch (error) {
    logger.error("❌ ADD FAVORITE ERROR:", error);

    const statusCode = error.statusCode || 500;

    res.status(statusCode).json({
      success: false,
      message: statusCode >= 500 ? 'Server Error' : error.message
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

    const data = snapshot.docs.map(doc => {
      const favorite = normalizeStoredFavorite(doc.data());
      return {
        id: doc.id,
        ...favorite
      };
    });

    res.json({
      success: true,
      data
    });

  } catch (error) {
    logger.error("❌ GET FAVORITES ERROR:", error);

    res.status(500).json({
      success: false,
      message: 'Server Error'
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
      message: 'Server Error'
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

    const imageUrl = `${getPublicBaseUrl(req)}/uploads/avatars/${req.file.filename}`;

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
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
