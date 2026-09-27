const bcrypt = require('bcryptjs');
const { randomInt, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const db = require('../config/firebase');
const { signJwtForUser } = require('../utils/auth');
const { userRoom } = require('../utils/socketRooms');
const logger = require('../utils/logger');

const MIN_PASSWORD_LENGTH = 6;
const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 254;
const PASSWORD_FORMAT_VERSION = 2;
const isLegacyPassword = user => user.passwordFormatVersion === undefined || user.passwordFormatVersion === 1;
const legacyPasswordValue = password => password.replace(/<[^>]*>/g, '').trim();

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const normalizeName = (name) => String(name || '').trim().replace(/\s+/g, ' ');

const isValidEmail = (email) => (
  email.length <= MAX_EMAIL_LENGTH &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
);

const publicUser = (user = {}) => ({
  id: String(user.id),
  name: user.name || '',
  email: user.email || '',
  avatarUrl: user.avatarUrl || '',
  role: user.role || 'user',
  roles: Array.isArray(user.roles) && user.roles.length > 0
    ? user.roles
    : [user.role || 'user']
});

const findUserByEmail = async (email) => {
  const usersRef = db.collection('users');

  const byEmailLower = await usersRef.where('emailLower', '==', email).limit(1).get();
  if (!byEmailLower.empty) {
    const doc = byEmailLower.docs[0];
    return { id: doc.id, ...doc.data() };
  }

  const byEmail = await usersRef.where('email', '==', email).limit(1).get();
  if (!byEmail.empty) {
    const doc = byEmail.docs[0];
    return { id: doc.id, ...doc.data() };
  }

  return null;
};

exports.register = async (req, res) => {
  try {
    const name = normalizeName(req.body.name);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all fields'
      });
    }

    if (name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address'
      });
    }

    if (password.length < MIN_PASSWORD_LENGTH || Buffer.byteLength(password) > 72) {
      return res.status(400).json({
        success: false,
        message: `Password must be between ${MIN_PASSWORD_LENGTH} characters and 72 UTF-8 bytes`
      });
    }

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'User already exists'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const newUserRef = db.collection('users').doc();
    const newUser = {
      id: newUserRef.id,
      name,
      email,
      emailLower: email,
      password: hashedPassword,
      passwordFormatVersion: PASSWORD_FORMAT_VERSION,
      role: 'user',
      roles: ['user'],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await newUserRef.set(newUser);

    return res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: publicUser(newUser),
      token: signJwtForUser(newUser)
    });
  } catch (error) {
    logger.error(`Register Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Server Error'
    });
  }
};

exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    const user = await findUserByEmail(email);
    if (!user?.password) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    let isMatch = await bcrypt.compare(password, user.password);
    // Older registrations hashed the globally sanitized value. Migrate only
    // those accounts, once, after verifying their previous password semantics.
    if (!isMatch && isLegacyPassword(user)) {
      const legacyPassword = legacyPasswordValue(password);
      if (legacyPassword !== password && await bcrypt.compare(legacyPassword, user.password)) {
        if (Buffer.byteLength(password) > 72) {
          return res.status(400).json({
            success: false,
            message: 'Please reset your password to a value of 72 UTF-8 bytes or fewer'
          });
        }
        const upgradedHash = await bcrypt.hash(password, 12);
        const userRef = db.collection('users').doc(user.id);
        isMatch = await db.runTransaction(async tx => {
          const current = await tx.get(userRef);
          if (!current.exists || current.data().password !== user.password ||
              !isLegacyPassword(current.data()) ||
              (current.data().tokenVersion || 0) !== (user.tokenVersion || 0)) return false;
          tx.update(userRef, {
            password: upgradedHash,
            passwordFormatVersion: PASSWORD_FORMAT_VERSION,
            updatedAt: new Date()
          });
          return true;
        });
      }
    }
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const normalizedUser = {
      ...user,
      email: normalizeEmail(user.email || email),
      role: user.role || 'user',
      roles: Array.isArray(user.roles) && user.roles.length > 0 ? user.roles : [user.role || 'user']
    };

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      user: publicUser(normalizedUser),
      token: signJwtForUser(normalizedUser)
    });
  } catch (error) {
    logger.error(`Login Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Server Error'
    });
  }
};

const emailService = require('../services/emailService');

const resetResponse = { success: true, message: 'If this email has an account, a verification code will be sent.' };
const hashCode = (code, salt) => createHash('sha256').update(salt + ':' + code).digest('hex');

exports.forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    if (!emailService.isConfigured()) return res.status(503).json({ success: false, message: 'Password recovery is temporarily unavailable' });
    const user = await findUserByEmail(email);
    if (!user) return res.status(200).json(resetResponse);
    const code = randomInt(100000, 1000000).toString();
    const salt = randomBytes(24).toString('hex');
    const codeHash = hashCode(code, salt);
    const ref = db.collection('password_resets').doc(email);
    const reserved = await db.runTransaction(async tx => {
      const previous = await tx.get(ref);
      if (previous.exists && Date.now() - (previous.data().createdAtMs || 0) < 60000) return false;
      tx.set(ref, { email, codeHash, salt, attempts: 0, expiresAt: Date.now() + 15 * 60000, createdAtMs: Date.now() });
      return true;
    });
    if (reserved) {
      const result = await emailService.sendResetPasswordEmail(email, code, user.name || 'Fan');
      if (!result.sent) await db.runTransaction(async tx => {
        const current = await tx.get(ref);
        if (current.exists && current.data().codeHash === codeHash) tx.delete(ref);
      });
    }
    return res.status(200).json(resetResponse);
  } catch (error) {
    logger.error('Forgot password request failed');
    return res.status(500).json({ success: false, message: 'Password recovery is temporarily unavailable' });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');
    if (!isValidEmail(email) || !/^\d{6}$/.test(code) || newPassword.length < MIN_PASSWORD_LENGTH || Buffer.byteLength(newPassword) > 72) {
      return res.status(400).json({ success: false, message: 'Provide a valid email, six-digit code, and password between 6 characters and 72 UTF-8 bytes' });
    }
    const user = await findUserByEmail(email);
    if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });
    const ref = db.collection('password_resets').doc(email);
    const userRef = db.collection('users').doc(user.id);
    // Check and account for each attempt before performing expensive bcrypt
    // work. Keep locked records so a failed attempt cannot bypass resend limits.
    const verifiedRequest = await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;
      const data = doc.data();
      if (!Number.isFinite(data.expiresAt) || Date.now() >= data.expiresAt ||
          (data.attempts || 0) >= 5 || !data.codeHash || !data.salt) return null;
      tx.update(ref, { attempts: (data.attempts || 0) + 1 });
      const expected = Buffer.from(data.codeHash, 'hex');
      const actual = Buffer.from(hashCode(code, data.salt), 'hex');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      return { codeHash: data.codeHash, salt: data.salt };
    });
    if (!verifiedRequest) return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    // A resend or another successful reset may race with hashing. Compare the
    // exact challenge again and consume it atomically with the password change.
    const changed = await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      const userDoc = await tx.get(userRef);
      if (!doc.exists || !userDoc.exists) return false;
      const current = doc.data();
      if (current.codeHash !== verifiedRequest.codeHash || current.salt !== verifiedRequest.salt ||
          !Number.isFinite(current.expiresAt) || Date.now() >= current.expiresAt) return false;
      tx.update(userRef, {
        password: hashedPassword,
        passwordFormatVersion: PASSWORD_FORMAT_VERSION,
        tokenVersion: (userDoc.data().tokenVersion || 0) + 1,
        updatedAt: new Date()
      });
      tx.delete(ref);
      return true;
    });
    if (changed) {
      try {
        req.app?.get('io')?.in(userRoom(user.id)).disconnectSockets(true);
      } catch (error) {
        // The password is already committed. Keep recovery successful even if
        // the realtime adapter is temporarily unavailable.
        logger.warn('Password reset completed; realtime session disconnect failed');
      }
    }
    return res.status(changed ? 200 : 400).json({ success: changed,
      message: changed ? 'Password reset. Sign in with your new password.' : 'Invalid or expired verification code' });
  } catch (error) {
    logger.error('Password reset failed');
    return res.status(500).json({ success: false, message: 'Password recovery is temporarily unavailable' });
  }
};
