/**
 * @file matchControllers.js
 * @description Controllers for match-related endpoints.
 * Uses football-data.org v4 API via footballApi service.
 */

const {
  fetchMatchesByDate,
  fetchLiveMatches,
  fetchMatchDetails,
} = require('../services/footballApi');
const logger = require('../utils/logger');

// ==========================================
// 📅 GET MATCHES BY DATE
// ==========================================
exports.getMatchesByDate = async (req, res) => {
  try {
    const date = req.query.date || 'TODAY';
    const matches = await fetchMatchesByDate(date);

    // Group by competition
    const grouped = {};
    for (const m of matches) {
      const key = m.competition.code || 'OTHER';
      if (!grouped[key]) {
        grouped[key] = {
          competition: m.competition,
          matches: [],
        };
      }
      grouped[key].matches.push(m);
    }

    res.json({
      success: true,
      date,
      total: matches.length,
      data: Object.values(grouped),
    });
  } catch (error) {
    logger.error(`❌ GET MATCHES BY DATE ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 🔴 LIVE MATCHES
// ==========================================
exports.getLiveMatches = async (req, res) => {
  try {
    const matches = await fetchLiveMatches();

    res.json({
      success: true,
      count: matches.length,
      data: matches,
    });
  } catch (error) {
    logger.error(`❌ LIVE MATCHES ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 🔍 MATCH DETAILS
// ==========================================
exports.getMatchDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await fetchMatchDetails(id);

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Match not found',
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    logger.error(`❌ MATCH DETAILS ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 🔍 SEARCH MATCHES (by team name in today's matches)
// ==========================================
exports.searchMatches = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim() === '') {
      return res.status(400).json({ success: false, message: 'Search query is required' });
    }

    const query = q.toLowerCase();
    const today = await fetchMatchesByDate('TODAY');
    
    const data = today.filter(m =>
      m.homeTeam.name.toLowerCase().includes(query) ||
      m.awayTeam.name.toLowerCase().includes(query) ||
      m.homeTeam.fullName.toLowerCase().includes(query) ||
      m.awayTeam.fullName.toLowerCase().includes(query) ||
      m.competition.name.toLowerCase().includes(query)
    );

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    logger.error(`❌ SEARCH MATCHES ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Keep backward compat
exports.getMatches = exports.getMatchesByDate;