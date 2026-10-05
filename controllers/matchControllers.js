/**
 * @file matchControllers.js
 * @description Controllers for match-related endpoints.
 * Uses football-data.org v4 API via footballApi service.
 */

const sportsDataService = require('../services/sportsDataService');
const bsdSportsService = require('../services/bsdSportsService');
const { normalizeLimit } = require('../utils/sportsContracts');
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
    const query = req.query || {};
    const hasInterval = Object.hasOwn(query, 'from') || Object.hasOwn(query, 'to');
    if (hasInterval && Object.hasOwn(query, 'date')) {
      return res.status(400).json({ success: false, message: 'Use either date or from/to, not both' });
    }
    const date = query.date || 'TODAY';
    const result = hasInterval ? await sportsDataService.getMatchesInInterval(query.from, query.to) :
      await sportsDataService.getMatchesByDate(date);

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.message,
        ...(result.range ? { source: result.source, range: result.range, total: 0, coverage: result.coverage, data: [] } : {}),
      });
    }

    const matches = result.data;

    // Group by competition
    const grouped = Object.create(null);
    for (const m of matches) {
      const key = m.competition?.code || 'OTHER';
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
      const aIdx = COMP_PRIORITY.indexOf(a.competition?.code);
      const bIdx = COMP_PRIORITY.indexOf(b.competition?.code);
      const aPrio = aIdx !== -1 ? aIdx : 999;
      const bPrio = bIdx !== -1 ? bIdx : 999;
      return aPrio - bPrio;
    });

    res.json({
      success: true,
      ...(hasInterval ? { range: result.range } : { date }),
      source: result.source,
      total: matches.length,
      coverage: result.coverage,
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
    if (!result.success) {
      return res.status(result.statusCode || 503).json({ success: false, message: result.message });
    }
    const matches = result.data;

    res.json({
      success: true,
      source: result.source,
      count: matches.length,
      coverage: result.coverage,
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
        message: result.message,
        source: result.source,
        coverage: result.coverage,
        data: result.data || []
      });
    }

    res.json({
      success: true,
      source: result.source,
      count: result.data.length,
      coverage: result.coverage,
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
    let data = result?.data;
    let source = result?.source || 'sportsdata';

    // Request hints are not proof a fixture exists.

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Match not found',
      });
    }

    res.json({ success: true, source, coverage: result.coverage, data });
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
    if (!result.success || result.coverage?.available === false) {
      return res.status(result.statusCode || 503).json({
        success: false,
        message: result.message || 'Match provider unavailable',
        source: result.source,
        coverage: result.coverage,
        data: []
      });
    }
    const today = result.data;
    
    const data = today.filter(m => searchableMatchText(m).includes(query));

    res.json({ success: true, source: result.source, coverage: result.coverage,
      count: data.length, data });
  } catch (error) {
    logger.error(`❌ SEARCH MATCHES ERROR: ${error.message}`);
    serverError(res);
  }
};

// Keep backward compat
exports.getMatches = exports.getMatchesByDate;

// ==========================================
// 🔮 ML & AI PREDICTIONS (Powered by CatBoost & BSD)
// ==========================================
exports.getPredictions = async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 50, 100);
    const predictions = await bsdSportsService.getPredictions({ limit });
    if (!Array.isArray(predictions)) return res.status(503).json({ success: false, source: 'unavailable',
      message: 'Predictions provider unavailable', data: [] });
    res.json({
      success: true,
      source: 'bsd_catboost_ml',
      total: predictions.length,
      coverage: predictions.coverage,
      data: predictions
    });
  } catch (error) {
    logger.error(`❌ GET PREDICTIONS ERROR: ${error.message}`);
    serverError(res);
  }
};

exports.getMatchPrediction = async (req, res) => {
  try {
    const { id } = req.params;
    const homeTeam = req.query.home || '';
    const awayTeam = req.query.away || '';
    const prediction = await bsdSportsService.getPredictionForMatch(id, homeTeam, awayTeam);
    if (!prediction) {
      return res.status(404).json({ success: false, message: 'Prediction not found for this match' });
    }
    res.json({
      success: true,
      source: 'bsd_catboost_ml',
      data: prediction
    });
  } catch (error) {
    logger.error(`❌ GET MATCH PREDICTION ERROR: ${error.message}`);
    serverError(res);
  }
};
