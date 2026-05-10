const {
  getTeamsService,
  getTeamByIdService,
  getTeamMatchesService,
  getTeamSquadService
} = require('../services/teamService');


// ==========================================
// 🔥 GET ALL TEAMS
// ==========================================
exports.getTeams = async (req, res) => {
  try {
    const data = await getTeamsService();

    res.json({
      success: true,
      data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ==========================================
// 🔥 GET TEAM BY ID
// ==========================================
exports.getTeamById = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await getTeamByIdService(id);

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Team not found"
      });
    }

    res.json({
      success: true,
      data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ==========================================
// 🔥 GET TEAM MATCHES
// ==========================================
exports.getTeamMatches = async (req, res) => {
  try {
    const { id } = req.params;

    const team = await getTeamByIdService(id);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: "Team not found"
      });
    }

    const matches = await getTeamMatchesService(team.name);

    res.json({
      success: true,
      data: matches
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ==========================================
// 🔥 GET TEAM SQUAD
// ==========================================
exports.getTeamSquad = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await getTeamSquadService(id);

    res.json({
      success: true,
      data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};