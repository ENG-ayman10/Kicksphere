require('dotenv').config();
const sportscore = require('./services/sportscoreService.js');

async function test() {
  const matchId = '12351221'; // Real Madrid vs Betis? Let's get a real live match ID
  const matches = await sportscore.getLiveMatches();
  if (matches && matches.length > 0) {
    const liveMatch = matches[0];
    console.log(`Testing lineups for match ${liveMatch.id} (${liveMatch.homeTeam.name} vs ${liveMatch.awayTeam.name})`);
    const details = await sportscore.getMatchDetails(liveMatch.id);
    console.log("Lineups:", JSON.stringify(details.lineups, null, 2));
  } else {
    console.log("No live matches found.");
  }
}
test();
