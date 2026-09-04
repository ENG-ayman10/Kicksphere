const bcrypt = require('bcryptjs');
const db = require('../config/firebase');
const { signJwtForUser } = require('../utils/auth');
const logger = require('../utils/logger');

const MIN_PASSWORD_LENGTH = 6;
const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 254;

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

    if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
      return res.status(400).json({
        success: false,
        message: `Password must be between ${MIN_PASSWORD_LENGTH} and 128 characters`
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

    const isMatch = await bcrypt.compare(password, user.password);
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

exports.forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address'
      });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email address'
      });
    }

    // Generate 6-digit random code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

    // Save to Firestore
    await db.collection('password_resets').doc(email).set({
      email,
      code,
      expiresAt,
      createdAt: new Date()
    });

    // Send email
    const emailResult = await emailService.sendResetPasswordEmail(email, code, user.name || 'Fan');

    return res.status(200).json({
      success: true,
      message: 'Verification code has been sent to your email',
      email,
      isEmailSent: emailResult.sent,
      devCode: emailResult.devCode || undefined
    });
  } catch (error) {
    logger.error(`Forgot Password Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Server Error'
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email, verification code, and new password'
      });
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 128) {
      return res.status(400).json({
        success: false,
        message: `Password must be between ${MIN_PASSWORD_LENGTH} and 128 characters`
      });
    }

    const resetDoc = await db.collection('password_resets').doc(email).get();
    if (!resetDoc.exists) {
      return res.status(400).json({
        success: false,
        message: 'No reset request found. Please request a new verification code.'
      });
    }

    const resetData = resetDoc.data();
    if (Date.now() > resetData.expiresAt) {
      await db.collection('password_resets').doc(email).delete();
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new one.'
      });
    }

    if (String(resetData.code).trim() !== code) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification code. Please check and try again.'
      });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User account not found'
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await db.collection('users').doc(user.id).update({
      password: hashedPassword,
      updatedAt: new Date()
    });

    await db.collection('password_resets').doc(email).delete();

    logger.info(`✅ Password successfully reset for user ${email}`);

    return res.status(200).json({
      success: true,
      message: 'Password has been reset successfully. You can now log in.'
    });
  } catch (error) {
    logger.error(`Reset Password Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Server Error'
    });
  }
};
