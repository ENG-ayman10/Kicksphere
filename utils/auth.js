const { getAuth } = require('firebase-admin/auth');
const jwt = require('jsonwebtoken');

const { randomBytes } = require('node:crypto');
const JWT_EXPIRY = process.env.JWT_EXPIRY || '30d';

const resolveJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (secret && Buffer.byteLength(secret) >= 32 && secret !== 'kicksphere_super_secret_key_CHANGE_IN_PRODUCTION') return secret;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must contain at least 32 bytes of unpredictable secret material');
  console.warn('JWT_SECRET is missing or weak. Development sessions will expire when this process restarts.');
  return randomBytes(48).toString('hex');
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
    tokenVersion: user.tokenVersion || 0,
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
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const db = require('../config/firebase');
    const user = await db.collection('users').doc(String(decoded.id)).get();
    if (!user.exists || (user.data().tokenVersion || 0) !== (decoded.tokenVersion || 0)) {
      throw new Error('Session revoked');
    }
    return normalizeUser(decoded);
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
