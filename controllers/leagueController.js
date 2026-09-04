/**
 * @file leagueController.js
 * @description Public league facade backed by the supported sports data contract.
 */

const sportsDataService = require('../services/sportsDataService');
const { normalizeCompetitionCode } = require('../utils/sportsContracts');
const logger = require('../utils/logger');

const findCompetition = (id) => {
  const code = normalizeCompetitionCode(id);
  if (!code) return null;

  return sportsDataService
    .getSupportedCompetitions()
    .find(competition => competition.code === code) || null;
};

exports.getLeagues = async (req, res) => {
  try {
    return res.json({
      success: true,
      source: 'supported-contract',
      data: sportsDataService.getSupportedCompetitions()
    });
  } catch (error) {
    logger.error(`getLeagues Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getLeagueById = async (req, res) => {
  try {
    const competition = findCompetition(req.params.id);

    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'League not found'
      });
    }

    return res.json({
      success: true,
      source: 'supported-contract',
      data: competition
    });
  } catch (error) {
    logger.error(`getLeagueById Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getLeagueTeams = async (req, res) => {
  try {
    const result = await sportsDataService.getStandings(req.params.id);

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.message
      });
    }

    return res.json({
      success: true,
      source: result.source,
      data: result.data
    });
  } catch (error) {
    logger.error(`getLeagueTeams Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getLeagueMatches = async (req, res) => {
  try {
    const result = await sportsDataService.getCompetitionMatches(
      req.params.id,
      req.query.dateFrom,
      req.query.dateTo
    );

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.message
      });
    }

    return res.json({
      success: true,
      source: result.source,
      data: result.data
    });
  } catch (error) {
    logger.error(`getLeagueMatches Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};
