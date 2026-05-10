/**
 * @file authMiddleware.js
 * @description Firebase Authentication middleware.
 * Verifies the Firebase ID token from the Authorization header.
 */

const admin = require('firebase-admin');
const logger = require('../utils/logger');

/**
 * Middleware to verify Firebase Auth token.
 * Expects: Authorization: Bearer <idToken>
 * Sets req.user with the decoded token (uid, email, etc.)
 */
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please provide a valid Bearer token."
      });
    }

    const idToken = authHeader.split('Bearer ')[1];

    if (!idToken) {
      return res.status(401).json({
        success: false,
        message: "Invalid token format."
      });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();

  } catch (error) {
    logger.error(`🔐 Auth Error: ${error.message}`);

    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({
        success: false,
        message: "Token expired. Please re-authenticate."
      });
    }

    return res.status(403).json({
      success: false,
      message: "Invalid or expired authentication token."
    });
  }
};

/**
 * Optional Auth — sets req.user if token exists, but doesn't block.
 * Useful for public endpoints that behave differently for logged-in users.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const idToken = authHeader.split('Bearer ')[1];
      if (idToken) {
        req.user = await admin.auth().verifyIdToken(idToken);
      }
    }
  } catch (error) {
    // Silently ignore — user just won't be authenticated
    req.user = null;
  }
  next();
};

module.exports = { authMiddleware, optionalAuth };
