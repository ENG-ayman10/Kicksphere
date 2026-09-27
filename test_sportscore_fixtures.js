const axios = require('axios');

async function testSportScore() {
  try {
    const res = await axios.get('https://sportscore.com/api/v1/fixtures/?date=2024-05-15', { timeout: 5000 });
    console.log(`✅ Success: ${res.status}`);
  } catch (e) {
    console.log(`❌ Failed: ${e.response?.status || e.message}`);
  }
}

testSportScore();
