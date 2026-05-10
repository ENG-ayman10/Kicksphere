const express = require('express');
const router = express.Router();

const {
  getTeams,
  getTeamById,
  getTeamMatches,
  getTeamSquad
} = require('../controllers/teamController');

router.get('/', getTeams);
router.get('/:id', getTeamById);
router.get('/:id/matches', getTeamMatches);
router.get('/:id/squad', getTeamSquad);

module.exports = router;