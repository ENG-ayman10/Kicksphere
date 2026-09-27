const axios = require('axios');

async function testSportScore() {
  try {
    const res = await axios.get('https://sportscore.com/api/v1/fixtures/?date=' + new Date().toISOString().slice(0, 10), { timeout: 5000 });
    const matches = res.data.matches || [];
    if (matches.length > 0) {
      console.log(JSON.stringify(matches[0], null, 2));
    }
  } catch (e) {
    console.log(`❌ Failed: ${e.message}`);
  }
}

testSportScore();
