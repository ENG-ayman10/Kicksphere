const axios = require('axios');

async function testDirect() {
  const target = 'https://api.sofascore.com/api/v1/config/unique-tournaments/EN';
  
  try {
    const res = await axios.get(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.sofascore.com',
        'Referer': 'https://www.sofascore.com/'
      }
    });
    console.log(`✅ Direct Success: ${res.status}`);
  } catch (e) {
    console.log(`❌ Direct Failed: ${e.response?.status || e.message}`);
  }
}

testDirect();
