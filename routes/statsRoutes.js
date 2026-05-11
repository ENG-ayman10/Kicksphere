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

// ==========================================
// 🚀 DEEP STATS (RAPIDAPI)
// ==========================================
const {
  getDeepTeamDetails,
  getDeepPlayerDetails,
  getAllCompetitions,
  getMatchDeepStats,
} = require('../controllers/statsController');

router.get('/deep/team/:id', getDeepTeamDetails);
router.get('/deep/player/:id', getDeepPlayerDetails);
router.get('/deep/competitions', getAllCompetitions);
router.get('/deep/match/:id', getMatchDeepStats);

module.exports = router;
