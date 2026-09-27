const axios = require('axios');

async function testSportScore() {
  try {
    const res = await axios.get('https://sportscore.com/api/v1/fixtures/?date=2026-09-28&competition=uefa-nations-league', { timeout: 5000 });
    console.log(`UNL Matches: ${res.data.matches?.length || 0}`);
  } catch (e) {
    console.log(`❌ Failed: ${e.message}`);
  }
}

testSportScore();
