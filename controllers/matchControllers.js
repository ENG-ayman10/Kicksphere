/**
 * @file matchControllers.js
 * @description Controllers for match-related endpoints.
 * Uses football-data.org v4 API via footballApi service.
 */

const sportsDataService = require('../services/sportsDataService');
const logger = require('../utils/logger');

const serverError = (res) => res.status(500).json({ success: false, message: 'Server Error' });

const searchableMatchText = (match) => [
  match.homeTeam?.name,
  match.homeTeam?.fullName,
  match.homeTeam?.shortName,
  match.awayTeam?.name,
  match.awayTeam?.fullName,
  match.awayTeam?.shortName,
  match.competition?.name
].filter(Boolean).join(' ').toLowerCase();

// ==========================================
// 📅 GET MATCHES BY DATE
// ==========================================

// Priority order for competitions
const COMP_PRIORITY = ['CL', 'EL', 'ECL', 'WC', 'EC', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'SPL', 'PPL', 'DED', 'BSA', 'ELC', 'TSL', 'MLS', 'LMX', 'CLI'];

exports.getMatchesByDate = async (req, res) => {
  try {
    const date = req.query.date || 'TODAY';
    const result = await sportsDataService.getMatchesByDate(date);

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.message
      });
    }

    const matches = result.data;

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

    // Sort groups by priority (known leagues first, then unknown)
    const sortedGroups = Object.values(grouped).sort((a, b) => {
      const aIdx = COMP_PRIORITY.indexOf(a.competition.code);
      const bIdx = COMP_PRIORITY.indexOf(b.competition.code);
      const aPrio = aIdx !== -1 ? aIdx : 999;
      const bPrio = bIdx !== -1 ? bIdx : 999;
      return aPrio - bPrio;
    });

    res.json({
      success: true,
      date,
      source: result.source,
      total: matches.length,
      data: sortedGroups,
    });
  } catch (error) {
    logger.error(`❌ GET MATCHES BY DATE ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// 🔴 LIVE MATCHES
// ==========================================
exports.getLiveMatches = async (req, res) => {
  try {
    const result = await sportsDataService.getLiveMatches();
    const matches = result.data;

    res.json({
      success: true,
      source: result.source,
      count: matches.length,
      data: matches,
    });
  } catch (error) {
    logger.error(`❌ LIVE MATCHES ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// 🏆 COMPETITION MATCHES
// ==========================================
exports.getCompetitionMatches = async (req, res) => {
  try {
    const { code } = req.params;
    const { dateFrom, dateTo } = req.query;

    const result = await sportsDataService.getCompetitionMatches(code, dateFrom, dateTo);

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.message
      });
    }

    res.json({
      success: true,
      source: result.source,
      count: result.data.length,
      data: result.data,
    });
  } catch (error) {
    logger.error(`❌ COMPETITION MATCHES ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// 🔍 MATCH DETAILS
// ==========================================
exports.getMatchDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await sportsDataService.getMatchDetails(id);
    const data = result.data;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Match not found',
      });
    }

    res.json({ success: true, source: result.source, data });
  } catch (error) {
    logger.error(`❌ MATCH DETAILS ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// 🔍 SEARCH MATCHES (by team name in today's matches)
// ==========================================
exports.searchMatches = async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      return res.status(400).json({ success: false, message: 'Search query is required' });
    }
    if (q.length > 120) {
      return res.status(400).json({ success: false, message: 'Search query is too long' });
    }

    const query = q.toLowerCase();
    const result = await sportsDataService.getMatchesByDate('TODAY');
    const today = result.success ? result.data : [];
    
    const data = today.filter(m => searchableMatchText(m).includes(query));

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    logger.error(`❌ SEARCH MATCHES ERROR: ${error.message}`);
    serverError(res);
  }
};

// Keep backward compat
exports.getMatches = exports.getMatchesByDate;
