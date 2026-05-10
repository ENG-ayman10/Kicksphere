/**
 * @file homeController.js
 * @description Home feed controller — returns live matches, top matches, recommended, and events.
 */

const db = require('../config/firebase');
const logger = require('../utils/logger');

// ==========================================
// 🔥 HELPER: format match
// ==========================================
const formatMatch = (doc) => {
  const data = doc.data();

  return {
    id: doc.id,
    matchId: data.matchId || null,
    homeTeam: data.homeTeam,
    awayTeam: data.awayTeam,
    homeScore: data.homeScore ?? 0,
    awayScore: data.awayScore ?? 0,
    league: data.league,
    status: data.status,
    team: data.team,
    createdAt: data.createdAt?.toDate?.().toISOString() || data.createdAt || null
  };
};

// ==========================================
// 🔥 HOME API
// ==========================================
exports.getHome = async (req, res) => {
  try {
    const { userId } = req.query;

    // =========================
    // 🔥 1. FETCH MATCHES ONCE (instead of 3 identical queries)
    // =========================
    const matchesSnap = await db.collection('matches')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const allMatches = matchesSnap.docs.map(formatMatch);

    // Live = first 5
    const live = allMatches.slice(0, 5);

    // Top Matches = first 5 (same data, different label for frontend)
    const topMatches = allMatches.slice(0, 5);

    // Events = first 5
    const events = allMatches.slice(0, 5);

    // =========================
    // 🔥 2. USER PREFERENCES
    // =========================
    let preferredTeams = [];

    if (userId) {
      const userDoc = await db.collection('users').doc(userId).get();

      if (userDoc.exists) {
        preferredTeams = userDoc.data().preferences?.teams || [];
      }
    }

    // =========================
    // 🔥 3. RECOMMENDED (filtered from already-fetched matches)
    // =========================
    let recommended = [];

    if (preferredTeams.length > 0) {
      recommended = allMatches
        .filter(m =>
          preferredTeams.some(team =>
            (m.homeTeam || "").toLowerCase().includes(team.toLowerCase()) ||
            (m.awayTeam || "").toLowerCase().includes(team.toLowerCase())
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
        events
      }
    });

  } catch (error) {
    logger.error(`❌ HOME ERROR: ${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};