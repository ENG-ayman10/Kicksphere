const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/firebase');

// Helper to generate token
const JWT_SECRET = process.env.JWT_SECRET || 'kicksphere_super_secret_key_CHANGE_IN_PRODUCTION';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '30d';

const generateToken = (user) => {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide all fields' });
    }

    // Check if user exists
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('email', '==', email).get();

    if (!snapshot.empty) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user in Firestore
    const newUserRef = usersRef.doc();
    const newUser = {
      id: newUserRef.id,
      name,
      email,
      password: hashedPassword,
      createdAt: new Date()
    };

    await newUserRef.set(newUser);

    res.status(201).json({
      message: 'User registered successfully',
      user: { id: newUser.id, name: newUser.name, email: newUser.email, avatarUrl: '' },
      token: generateToken(newUser)
    });
  } catch (error) {
    res.status(500).json({ message: 'Server Error: ' + error.message });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('email', '==', email).get();

    if (snapshot.empty) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const userDoc = snapshot.docs[0];
    const user = userDoc.data();

    // Compare hashed password
    const isMatch = await bcrypt.compare(password, user.password);

    if (isMatch) {
      res.status(200).json({
        message: 'Login successful',
        user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl || '' },
        token: generateToken(user)
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error: ' + error.message });
  }
};
