const { getAuth } = require('firebase-admin/auth');
const jwt = require('jsonwebtoken');

const DEFAULT_DEV_JWT_SECRET = 'kicksphere_super_secret_key_CHANGE_IN_PRODUCTION';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '30d';

const resolveJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️ JWT_SECRET is not set in production. Using fallback secret.');
  }

  return DEFAULT_DEV_JWT_SECRET;
};

const JWT_SECRET = resolveJwtSecret();

const normalizeRoles = (user = {}) => {
  const roles = [];

  if (Array.isArray(user.roles)) {
    roles.push(...user.roles);
  }

  if (typeof user.role === 'string') {
    roles.push(user.role);
  }

  if (user.admin === true || user.isAdmin === true) {
    roles.push('admin');
  }

  return [...new Set(roles.map(role => String(role).toLowerCase()))];
};

const normalizeUser = (decoded = {}) => {
  const id = decoded.id || decoded.uid || decoded.user_id || decoded.sub;

  return {
    ...decoded,
    id: id ? String(id) : undefined,
    uid: decoded.uid || id,
    roles: normalizeRoles(decoded)
  };
};

const isAdminUser = (user = {}) => {
  const roles = normalizeRoles(user);
  return roles.includes('admin') || roles.includes('superadmin') || roles.includes('owner');
};

const signJwtForUser = (user = {}) => {
  const role = user.role || 'user';
  const roles = Array.isArray(user.roles) && user.roles.length > 0
    ? user.roles
    : [role];

  const payload = {
    id: String(user.id),
    email: user.email,
    name: user.name,
    role,
    roles
  };

  if (user.admin === true || user.isAdmin === true) {
    payload.admin = true;
  }

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
};

const verifyAuthToken = async (token) => {
  let jwtError;

  try {
    return normalizeUser(jwt.verify(token, JWT_SECRET));
  } catch (error) {
    jwtError = error;
  }

  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    return normalizeUser({
      ...decodedToken,
      id: decodedToken.uid
    });
  } catch (firebaseError) {
    const error = new Error('Invalid or expired authentication token');
    error.jwtError = jwtError;
    error.firebaseError = firebaseError;
    throw error;
  }
};

module.exports = {
  JWT_EXPIRY,
  isAdminUser,
  normalizeUser,
  signJwtForUser,
  verifyAuthToken
};
