const axios = require('axios');

async function testDirect() {
  const target = 'https://api.sofascore.app/api/v1/config/unique-tournaments/EN';
  
  try {
    const res = await axios.get(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-N975U1 Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json'
      }
    });
    console.log(`✅ Direct Success: ${res.status}`);
  } catch (e) {
    console.log(`❌ Direct Failed: ${e.response?.status || e.message}`);
  }
}

testDirect();
