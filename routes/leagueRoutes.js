const express = require('express');
const router = express.Router();

const {
  getLeagues,
  getLeagueById,
  getLeagueTeams,
  getLeagueMatches
} = require('../controllers/leagueController');

router.get('/', getLeagues);
router.get('/:id', getLeagueById);
router.get('/:id/teams', getLeagueTeams);
router.get('/:id/matches', getLeagueMatches);

module.exports = router;