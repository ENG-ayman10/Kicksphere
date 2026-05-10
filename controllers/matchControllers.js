/**
 * @file matchControllers.js
 * @description Controllers for match-related endpoints.
 * Delegates business logic to matchService and matchDetailsService.
 */

const { getMatchesService } = require('../services/matchService');
const { getMatchDetailsService } = require('../services/matchDetailsService');
const logger = require('../utils/logger');

// ==========================================
// 🔥 GET MATCHES (delegates to service)
// ==========================================
exports.getMatches = async (req, res) => {
  try {
    const result = await getMatchesService(req.query);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error(`❌ GET MATCHES ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 🔥 LIVE MATCHES (from football engine)
// ==========================================
exports.getLiveMatches = async (req, res) => {
  try {
    const { fetchMatchesFromAPI } = require('../services/footballApi');
    const matches = await fetchMatchesFromAPI();

    const data = matches.map(m => ({
      id: m.id,
      homeTeam: m.home.name,
      awayTeam: m.away.name,
      homeScore: m.home.score,
      awayScore: m.away.score,
      league: m.leagueId,
      status: m.status?.liveTime?.short || 'Live',
      home: m.home,
      away: m.away,
      leagueId: m.leagueId,
    }));

    res.json({ success: true, data });

  } catch (error) {
    logger.error(`❌ LIVE MATCHES ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 🔥 SEARCH MATCHES
// ==========================================
exports.searchMatches = async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim() === '') {
      return res.status(400).json({
        success: false,
        message: "Search query is required"
      });
    }

    const db = require('../config/firebase');
    const snapshot = await db.collection('matches')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const query = q.toLowerCase();

    const data = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(m =>
        (m.homeTeam || '').toLowerCase().includes(query) ||
        (m.awayTeam || '').toLowerCase().includes(query)
      );

    res.json({
      success: true,
      count: data.length,
      data
    });

  } catch (error) {
    logger.error(`❌ SEARCH MATCHES ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 🔥 MATCH DETAILS
// ==========================================
exports.getMatchDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await getMatchDetailsService(id);

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Match not found"
      });
    }

    res.json({
      success: true,
      data
    });

  } catch (error) {
    logger.error(`❌ MATCH DETAILS ERROR: ${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};