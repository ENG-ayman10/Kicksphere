const axios = require('axios');

async function checkBigLeagues() {
  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`Checking matches for date: ${today}`);
    
    const res = await axios.get('https://sportscore.com/api/v1/fixtures/', {
      params: { sport: 'football', date: today, limit: 500 },
      headers: { 'User-Agent': 'KickSphereApp/1.0', 'Accept': 'application/json' },
      timeout: 15000
    });
    
    const matches = res.data?.matches || [];
    console.log(`Total matches: ${matches.length}`);
    
    // List all unique competitions
    const competitions = {};
    for (const m of matches) {
      const comp = m.competition || 'Unknown';
      if (!competitions[comp]) competitions[comp] = 0;
      competitions[comp]++;
    }
    
    console.log('\n=== ALL COMPETITIONS TODAY ===');
    const sorted = Object.entries(competitions).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`  ${name}: ${count} matches`);
    }

    // Check for big leagues
    const bigLeagues = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League', 'Saudi'];
    console.log('\n=== BIG LEAGUES CHECK ===');
    for (const league of bigLeagues) {
      const found = matches.filter(m => (m.competition || '').toLowerCase().includes(league.toLowerCase()));
      console.log(`${league}: ${found.length} matches`);
    }
    
  } catch (e) {
    console.error('Error:', e.message);
  }
}

checkBigLeagues();
