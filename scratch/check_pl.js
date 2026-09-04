const axios = require('axios');

async function checkPLmatches() {
  const today = new Date().toISOString().split('T')[0];
  const res = await axios.get('https://sportscore.com/api/v1/fixtures/', {
    params: { sport: 'football', date: today, limit: 500 },
    headers: { 'User-Agent': 'KickSphereApp/1.0', 'Accept': 'application/json' },
    timeout: 15000
  });
  
  const matches = res.data?.matches || [];
  const plMatches = matches.filter(m => (m.competition || '').toLowerCase().includes('premier league'));
  
  console.log('=== "Premier League" matches ===');
  for (const m of plMatches) {
    console.log(`  ${m.competition}: ${m.home} vs ${m.away}`);
  }
}

checkPLmatches();
