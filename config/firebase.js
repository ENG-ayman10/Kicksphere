/**
 * @file firebase.js
 * @description Firebase Admin SDK initialization.
 * Supports both JSON file and environment variables for credentials.
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

if (!admin.apps.length) {
  let credential;

  // Priority 1: Environment variables (recommended for production)
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });
    logger.info('🔥 Firebase initialized from environment variables.');
  }
  // Priority 2: Service Account JSON file (development only)
  else {
    const keyPath = path.resolve(__dirname, '../serviceAccountKey.json');
    if (fs.existsSync(keyPath)) {
      const serviceAccount = require(keyPath);
      credential = admin.credential.cert(serviceAccount);
      logger.info('🔥 Firebase initialized from serviceAccountKey.json (dev mode).');
    } else {
      throw new Error('Firebase credentials not found. Set FIREBASE_* env vars or provide serviceAccountKey.json');
    }
  }

  admin.initializeApp({ credential });
}

const db = admin.firestore();

module.exports = db;