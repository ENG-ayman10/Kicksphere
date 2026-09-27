const axios = require('axios');

async function testProxies() {
  const target = 'https://api.sofascore.com/api/v1/config/unique-tournaments/EN';
  
  const proxies = [
    'https://thingproxy.freeboard.io/fetch/',
    'https://api.allorigins.win/get?url='
  ];

  for (const proxy of proxies) {
    try {
      const url = proxy + encodeURIComponent(target);
      const res = await axios.get(url, { timeout: 8000 });
      console.log(`✅ Success with ${proxy}: ${res.status}`);
      return;
    } catch (e) {
      console.log(`❌ Failed with ${proxy}: ${e.message}`);
    }
  }
}

testProxies();
