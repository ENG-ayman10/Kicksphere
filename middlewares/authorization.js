const { isAdminUser } = require('../utils/auth');

const getAuthenticatedUserId = (req) => {
  if (!req.user || !req.user.id) {
    return null;
  }

  return String(req.user.id);
};

const requireSelfOrAdmin = (paramName = 'userId') => (req, res, next) => {
  const authenticatedUserId = getAuthenticatedUserId(req);
  const targetUserId = req.params[paramName] ? String(req.params[paramName]) : null;

  if (!authenticatedUserId) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.'
    });
  }

  if (!targetUserId) {
    return res.status(400).json({
      success: false,
      message: `${paramName} is required`
    });
  }

  if (authenticatedUserId === targetUserId || isAdminUser(req.user)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'You are not allowed to access this user resource.'
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user && isAdminUser(req.user)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Admin privileges required.'
  });
};

module.exports = {
  requireAdmin,
  requireSelfOrAdmin
};
