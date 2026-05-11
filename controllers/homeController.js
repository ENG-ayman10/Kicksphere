/**
 * @file homeController.js
 * @description Home feed controller — returns live/today matches from football-data.org.
 */

const db = require('../config/firebase');
const { fetchMatchesByDate, fetchLiveMatches } = require('../services/footballApi');
const logger = require('../utils/logger');

// ==========================================
// 🔥 HOME API
// ==========================================
exports.getHome = async (req, res) => {
  try {
    const { userId } = req.query;

    // =========================
    // 🔥 1. FETCH TODAY'S MATCHES FROM API
    // =========================
    const todayMatches = await fetchMatchesByDate('TODAY');
    const liveMatches = await fetchLiveMatches();

    // Live = actually live matches, or today's if none live
    const live = liveMatches.length > 0 ? liveMatches : todayMatches.slice(0, 5);

    // Top Matches = today's matches
    const topMatches = todayMatches.slice(0, 10);

    // Events = today's matches
    const events = todayMatches;

    // =========================
    // 🔥 2. USER PREFERENCES
    // =========================
    let preferredTeams = [];

    if (userId) {
      try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
          preferredTeams = userDoc.data().preferences?.teams || [];
        }
      } catch (e) {
        logger.warn(`⚠️ Could not fetch user preferences: ${e.message}`);
      }
    }

    // =========================
    // 🔥 3. RECOMMENDED
    // =========================
    let recommended = [];

    if (preferredTeams.length > 0) {
      recommended = todayMatches
        .filter(m =>
          preferredTeams.some(team =>
            (m.homeTeam?.name || '').toLowerCase().includes(team.toLowerCase()) ||
            (m.awayTeam?.name || '').toLowerCase().includes(team.toLowerCase())
          )
        )
        .slice(0, 5);
    }

    // =========================
    // 🔥 RESPONSE
    // =========================
    res.json({
      success: true,
      data: {
        live,
        topMatches,
        recommended,
        events,
      },
    });
  } catch (error) {
    logger.error(`❌ HOME ERROR: ${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};