const {
  getTeamsService,
  getTeamByIdService,
  getTeamMatchesService,
  getTeamSquadService
} = require('../services/teamService');

const logger = require('../utils/logger');

const sendResult = (res, result) => {
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
};

exports.getTeams = async (req, res) => {
  try {
    const result = await getTeamsService(req.query.league);
    return sendResult(res, result);
  } catch (error) {
    logger.error(`getTeams Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getTeamById = async (req, res) => {
  try {
    const result = await getTeamByIdService(req.params.id);
    return sendResult(res, result);
  } catch (error) {
    logger.error(`getTeamById Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getTeamMatches = async (req, res) => {
  try {
    const result = await getTeamMatchesService(req.params.id);
    return sendResult(res, result);
  } catch (error) {
    logger.error(`getTeamMatches Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getTeamSquad = async (req, res) => {
  try {
    const result = await getTeamSquadService(req.params.id);
    return sendResult(res, result);
  } catch (error) {
    logger.error(`getTeamSquad Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};
