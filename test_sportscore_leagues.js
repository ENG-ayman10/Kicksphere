const axios = require('axios');

async function testSportScore() {
  try {
    const res = await axios.get('https://sportscore.com/api/v1/fixtures/?date=2026-09-28', { timeout: 5000 });
    const matches = res.data.matches || [];
    console.log(`Total: ${matches.length}`);
    if (res.data.pagination || res.data.meta) {
      console.log('Has Pagination/Meta:', res.data.pagination || res.data.meta);
    }
    
    // Check if we can fetch a specific league
    const res2 = await axios.get('https://sportscore.com/api/v1/fixtures/?date=2026-09-28&competition=english-premier-league', { timeout: 5000 });
    console.log(`PL Matches: ${res2.data.matches?.length || 0}`);
  } catch (e) {
    console.log(`❌ Failed: ${e.message}`);
  }
}

testSportScore();
