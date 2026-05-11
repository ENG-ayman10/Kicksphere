/**
 * @file liveService.js
 * @description Emits live match data to all connected Socket.io clients.
 * Uses football-data.org v4 API.
 */

const { fetchLiveMatches, fetchMatchesByDate } = require('./footballApi');
const logger = require('../utils/logger');

// ==========================================
// 🔥 EMIT LIVE MATCHES
// ==========================================
exports.emitLiveMatches = async (io) => {
  try {
    // Try live matches first
    let data = await fetchLiveMatches();

    // If no live matches, send today's matches
    if (!data || data.length === 0) {
      data = await fetchMatchesByDate('TODAY');
    }

    io.emit('liveMatches', data);
  } catch (error) {
    logger.error(`❌ Live Error: ${error.message}`);
  }
};