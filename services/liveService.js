/**
 * @file liveService.js
 * @description Emits live match data to all connected Socket.io clients.
 */

const db = require('../config/firebase');
const { fetchMatchesFromAPI } = require('./footballApi');
const logger = require('../utils/logger');

// ==========================================
// 🔥 EMIT LIVE MATCHES
// ==========================================
exports.emitLiveMatches = async (io) => {
  try {
    let data = [];

    // =========================
    // 🔥 1. جلب من الـ API أولاً
    // =========================
    try {
      const apiData = await fetchMatchesFromAPI();

      if (apiData.length > 0) {
        data = apiData.map(match => ({
          matchId: match.id,
          homeTeam: match.home.name,
          awayTeam: match.away.name,
          homeScore: match.home.score ?? 0,
          awayScore: match.away.score ?? 0,
          league: match.leagueId,
          status: match.status?.liveTime?.short || ""
        }));
      }
    } catch (err) {
      logger.warn("⚠️ Live API failed → using cache");
    }

    // =========================
    // 🔥 2. Fallback للكاش
    // =========================
    if (data.length === 0) {
      const snapshot = await db.collection('matches')
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get();

      data = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    }

    // 🔥 إرسال لكل العملاء
    io.emit('liveMatches', data);

  } catch (error) {
    logger.error(`❌ Live Error: ${error.message}`);
  }
};