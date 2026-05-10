const express = require('express');
const router = express.Router();
const {
  getTopPlayers,
  getTopTeams,
  getLeaguesStandings,
  getMatchTimeline,
  getMatchLineups,
} = require('../controllers/statsController');

// ==========================================
// 📊 STATS ROUTES
// ==========================================
router.get('/players', getTopPlayers);       // Top scorers
router.get('/teams', getTopTeams);           // Team standings
router.get('/leagues', getLeaguesStandings); // Leagues overview

// ==========================================
// ⚽ MATCH EXTENDED DATA
// ==========================================
router.get('/matches/:id/timeline', getMatchTimeline);  // Match events
router.get('/matches/:id/lineups', getMatchLineups);    // Team lineups

module.exports = router;
