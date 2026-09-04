/**
 * @file authMiddleware.js
 * @description Verifies custom JWT tokens or Firebase ID tokens.
 */

const logger = require('../utils/logger');
const { verifyAuthToken } = require('../utils/auth');

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.slice('Bearer '.length).trim();
};

const authMiddleware = async (req, res, next) => {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please provide a valid Bearer token.'
      });
    }

    try {
      req.user = await verifyAuthToken(token);
      if (!req.user?.id) {
        return res.status(403).json({
          success: false,
          message: 'Authentication token is missing a user id.'
        });
      }
      return next();
    } catch (authError) {
      logger.error(`Auth Error: ${authError.message}`);

      if (authError.jwtError?.name === 'TokenExpiredError' || authError.firebaseError?.code === 'auth/id-token-expired') {
        return res.status(401).json({
          success: false,
          message: 'Token expired. Please re-authenticate.'
        });
      }

      return res.status(403).json({
        success: false,
        message: 'Invalid or expired authentication token.'
      });
    }
  } catch (error) {
    logger.error(`Auth Middleware Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Server authentication error.'
    });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const token = getBearerToken(req);

    if (token) {
      req.user = await verifyAuthToken(token);
    }
  } catch (error) {
    req.user = null;
  }

  next();
};

module.exports = { authMiddleware, optionalAuth };
