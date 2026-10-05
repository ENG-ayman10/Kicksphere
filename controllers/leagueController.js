/**
 * @file leagueController.js
 * @description Public league facade backed by the supported sports data contract.
 */

const sportsDataService = require('../services/sportsDataService');
const { normalizeCompetitionCode } = require('../utils/sportsContracts');
const logger = require('../utils/logger');

const findCompetition = async (id) => {
  const code = normalizeCompetitionCode(id);
  if (!code) return null;

  return (await sportsDataService.getCompetitionCatalog())
    .find(competition => competition.code === code) || null;
};

exports.getLeagues = async (req, res) => {
  try {
    const catalog = await sportsDataService.getCompetitionCatalog();
    return res.json({
      success: true,
      source: catalog.source || 'supported-contract',
      coverage: catalog.coverage,
      data: catalog
    });
  } catch (error) {
    logger.error(`getLeagues Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getLeagueById = async (req, res) => {
  try {
    const catalog = await sportsDataService.getCompetitionCatalog();
    const code = normalizeCompetitionCode(req.params.id);
    const competition = code ? catalog.find(item => item.code === code) : null;

    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'League not found'
      });
    }

    return res.json({
      success: true,
      source: catalog.source || 'supported-contract',
      coverage: catalog.coverage,
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
      coverage: result.coverage,
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
      coverage: result.coverage,
      data: result.data
    });
  } catch (error) {
    logger.error(`getLeagueMatches Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};
