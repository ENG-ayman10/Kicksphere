/**
 * @file authMiddleware.js
 * @description Firebase Authentication middleware.
 * Verifies the Firebase ID token from the Authorization header.
 */

const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'kicksphere_super_secret_key_CHANGE_IN_PRODUCTION';

/**
 * Middleware to verify token (JWT or Firebase ID token).
 * Expects: Authorization: Bearer <token>
 * Sets req.user with the decoded token (id, email, etc.)
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

    const token = authHeader.split('Bearer ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Invalid token format."
      });
    }

    // 1. Try verifying as custom JWT first
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (jwtError) {
      // 2. Fallback: Try verifying as Firebase ID token
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        // Normalize uid to match custom JWT schema where user ID is 'id'
        req.user = {
          id: decodedToken.uid,
          email: decodedToken.email,
          ...decodedToken
        };
        return next();
      } catch (firebaseError) {
        logger.error(`🔐 Auth Error: JWT verification failed (${jwtError.message}) and Firebase verification failed (${firebaseError.message})`);
        
        if (firebaseError.code === 'auth/id-token-expired') {
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
    }

  } catch (error) {
    logger.error(`🔐 Auth Middleware Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Server authentication error."
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
      const token = authHeader.split('Bearer ')[1];
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          req.user = decoded;
        } catch (jwtError) {
          try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = {
              id: decodedToken.uid,
              email: decodedToken.email,
              ...decodedToken
            };
          } catch (firebaseError) {
            req.user = null;
          }
        }
      }
    }
  } catch (error) {
    // Silently ignore — user just won't be authenticated
    req.user = null;
  }
  next();
};

module.exports = { authMiddleware, optionalAuth };
