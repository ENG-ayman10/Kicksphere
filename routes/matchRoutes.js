const express = require('express');
const router = express.Router();

const {
  getMatches,
  getLiveMatches,
  searchMatches,
  getMatchDetails,
  getMatchesByDate,
} = require('../controllers/matchControllers');


// ==========================================
// 📅 MATCHES BY DATE (?date=2024-03-15 or ?date=TODAY)
// ==========================================
router.get('/', getMatchesByDate);

// ==========================================
// 📅 EXPLICIT DATE ROUTE
// ==========================================
router.get('/date', getMatchesByDate);

// ==========================================
// 🔴 LIVE MATCHES
// ==========================================
router.get('/live', getLiveMatches);

// ==========================================
// 🔍 SEARCH MATCHES
// ==========================================
router.get('/search', searchMatches);

// ==========================================
// 🔍 MATCH DETAILS (must be last — catches :id)
// ==========================================
router.get('/:id', getMatchDetails);


module.exports = router;