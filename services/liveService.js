/**
 * @file liveService.js
 * @description Emits live match data to all connected Socket.io clients.
 * Retains the same provider identities used by the REST match facades.
 */

const sportscoreService = require('./sportscoreService');
const sportsDataService = require('./sportsDataService');
const bsdSportsService = require('./bsdSportsService');
const logger = require('../utils/logger');
const { createHash } = require('node:crypto');
let running = false;
const broadcasts = new WeakMap();
const HEARTBEAT_MS = 30000;

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
      const signature = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      const previous = broadcasts.get(io);
      const now = Date.now();
      // Five-second score checks share a cached provider feed. Avoid making
      // every handset decode/rebuild that identical scoreboard each cycle.
      // A bounded heartbeat still lets connected clients retain fresh state.
      if (!previous || signature !== previous.signature || now - previous.at >= HEARTBEAT_MS) {
        io.emit('liveMatches', data);
        broadcasts.set(io, { signature, at: now });
      }
    }
    // The transition detector consumes exactly the scoreboard snapshot. It must
    // not start a second broad provider read on an unrelated event timer.
    return result;
  } catch (error) {
    logger.error(`❌ Live Error: ${error.message}`);
  } finally { running = false; }
};
