const db = require('../config/firebase');
const { fetchMatchesFromAPI, fetchLineupsFromAPI } = require('./footballApi');
const logger = require('../utils/logger');

// 🔥 جلب اللاعبين (حقيقي من الـ API)
exports.fetchPlayersFromAPI = async () => {
  try {
    const liveMatches = await fetchMatchesFromAPI();
    
    // نكتفي بـ 2 مباريات فقط عشان ما نستهلك الـ API Quota
    const matchesToProcess = liveMatches.slice(0, 2);
    let players = [];

    for (const match of matchesToProcess) {
      if (!match.id) continue;
      
      const lineups = await fetchLineupsFromAPI(match.id);
      
      if (lineups && lineups.length > 0) {
        // Lineups array usually has 2 teams
        for (const teamLineup of lineups) {
          const teamName = teamLineup.team?.name || 'Unknown';
          const startingXI = teamLineup.startXI || [];
          
          for (const playerItem of startingXI) {
            if (playerItem.player) {
              players.push({
                name: playerItem.player.name,
                position: playerItem.player.pos || "Unknown",
                team: teamName
              });
            }
          }
        }
      }
    }
    
    return players;
  } catch (error) {
    logger.error(`❌ Players fetch error: ${error.message}`);
    return [];
  }
};