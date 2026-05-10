const {
  getLeaguesService,
  getLeagueByIdService,
  getLeagueTeamsService,
  getLeagueMatchesService
} = require('../services/leagueService');


// 🔥 كل الدوريات
exports.getLeagues = async (req, res) => {
  try {
    const data = await getLeaguesService();

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


// 🔥 دوري واحد
exports.getLeagueById = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await getLeagueByIdService(id);

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "League not found"
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


// 🔥 فرق الدوري
exports.getLeagueTeams = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await getLeagueTeamsService(id);

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


// 🔥 مباريات الدوري
exports.getLeagueMatches = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await getLeagueMatchesService(id);

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