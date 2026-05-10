/**
 * @file matchDetailsService.js
 * @description Service for fetching detailed match information.
 * Searches by matchId field (not Firestore document ID).
 */

const db = require('../config/firebase');
const { fetchMatchStatsFromAPI, fetchLineupsFromAPI } = require('./footballApi');
const logger = require('../utils/logger');

// ==========================================
// 🔥 GET MATCH DETAILS SERVICE
// ==========================================
exports.getMatchDetailsService = async (matchId) => {
  try {
    // =========================
    // 🔥 1. GET MATCH — search by matchId field, not doc ID
    // =========================
    let match = null;

    // First try: direct doc ID lookup
    const directDoc = await db.collection('matches').doc(matchId).get();

    if (directDoc.exists) {
      match = { id: directDoc.id, ...directDoc.data() };
    } else {
      // Second try: search by matchId field
      const querySnap = await db.collection('matches')
        .where('matchId', '==', matchId)
        .limit(1)
        .get();

      if (!querySnap.empty) {
        const doc = querySnap.docs[0];
        match = { id: doc.id, ...doc.data() };
      }
    }

    if (!match) {
      return null;
    }

    const apiMatchId = match.matchId || matchId;

    // =========================
    // 🔥 2. STATS (من الـ API)
    // =========================
    let stats = null;

    try {
      const apiStats = await fetchMatchStatsFromAPI(apiMatchId);

      if (apiStats) {
        stats = apiStats;
      }
    } catch (err) {
      logger.warn(`⚠️ Stats fetch failed: ${err.message}`);
    }

    // fallback لو الـ API ما رجع شي
    if (!stats) {
      stats = {
        possession: { home: null, away: null },
        shots: { home: null, away: null },
        passes: { home: null, away: null }
      };
    }

    // =========================
    // 🔥 3. LINEUPS (من الـ API)
    // =========================
    let lineups = null;

    try {
      lineups = await fetchLineupsFromAPI(apiMatchId);
    } catch (err) {
      logger.warn(`⚠️ Lineups fetch failed: ${err.message}`);
    }

    // =========================
    // 🔥 4. EVENTS FROM FIRESTORE — search by matchId field value
    // =========================
    const eventsSnap = await db.collection('events')
      .where('matchId', '==', apiMatchId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const storedEvents = eventsSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return {
      match,
      stats,
      lineups,
      storedEvents
    };

  } catch (error) {
    logger.error(`❌ Match Details Error: ${error.message}`);
    throw new Error(error.message);
  }
};