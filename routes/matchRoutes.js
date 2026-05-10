const express = require('express');
const router = express.Router();

const {
  getMatches,
  getLiveMatches,
  searchMatches,
  getMatchDetails
} = require('../controllers/matchControllers');


// ==========================================
// 🔥 GET ALL MATCHES (filter + pagination)
// ==========================================
router.get('/', getMatches);


// ==========================================
// 🔥 LIVE MATCHES
// ==========================================
router.get('/live', getLiveMatches);


// ==========================================
// 🔥 SEARCH MATCHES
// ==========================================
router.get('/search', searchMatches);


// ==========================================
// 🔥 MATCH DETAILS (لازم يكون آخر شيء)
// ==========================================
router.get('/:id', getMatchDetails);


module.exports = router;