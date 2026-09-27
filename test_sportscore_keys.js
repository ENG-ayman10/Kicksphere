const axios = require('axios');

async function testSportScore() {
  try {
    const res = await axios.get('https://sportscore.com/api/v1/fixtures/?date=2026-09-28', { timeout: 5000 });
    console.log(`Keys:`, Object.keys(res.data));
    console.log(`Meta:`, res.data.meta || res.data.pagination);
  } catch (e) {
    console.log(`❌ Failed: ${e.message}`);
  }
}

testSportScore();
