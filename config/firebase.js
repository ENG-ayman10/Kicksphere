/**
 * @file firebase.js
 * @description Firebase Admin SDK initialization.
 * Supports both JSON file and environment variables for credentials.
 */

const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

if (!getApps().length) {
  let credential;

  // Priority 1: Environment variables (recommended for production)
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    credential = cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });
    logger.info('🔥 Firebase initialized from environment variables.');
  }
  // Priority 2: Service Account JSON file (development only)
  else if (process.env.NODE_ENV === 'production') {
    throw new Error('Firebase environment credentials are required in production');
  }
  else {
    const keyPath = path.resolve(__dirname, '../serviceAccountKey.json');
    if (fs.existsSync(keyPath)) {
      const serviceAccount = require(keyPath);
      credential = cert(serviceAccount);
      logger.info('🔥 Firebase initialized from serviceAccountKey.json (dev mode).');
    } else {
      throw new Error('Firebase credentials not found. Set FIREBASE_* env vars or provide serviceAccountKey.json');
    }
  }

  initializeApp({ credential });
}

const db = getFirestore();

module.exports = db;
