/**
 * @file liveService.js
 * @description Emits live match data to all connected Socket.io clients.
 * Retains the same provider identities used by the REST match facades.
 */

const sportscoreService = require('./sportscoreService');
const sportsDataService = require('./sportsDataService');
const bsdSportsService = require('./bsdSportsService');
const logger = require('../utils/logger');
let running = false;

// ==========================================
// 🔥 EMIT LIVE MATCHES
// ==========================================
exports.emitLiveMatches = async (io) => {
  if (running) return;
  running = true;
  try {
    const provider = bsdSportsService.isConfigured?.() ? sportsDataService : sportscoreService;
    const result = await provider.getLiveMatches();
    const data = Array.isArray(result) ? result : result?.success === true &&
      result.source !== 'unavailable' && result.coverage?.available !== false ? result.data : null;
    // An outage cannot clear a usable live scoreboard. A verified empty feed can.
    // A partial/temporarily unavailable zero-row snapshot cannot certify that
    // every match ended. Keep the current board until a verified empty feed.
    if (Array.isArray(data) && (data.length > 0 || Array.isArray(result) || result.coverage?.complete === true)) {
      io.emit('liveMatches', data);
    }
    // The transition detector consumes exactly the scoreboard snapshot. It must
    // not start a second broad provider read on an unrelated event timer.
    return result;
  } catch (error) {
    logger.error(`❌ Live Error: ${error.message}`);
  } finally { running = false; }
};
