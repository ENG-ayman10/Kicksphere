const axios = require('axios');

async function testProxy() {
  const target = 'https://api.sofascore.com/api/v1/config/unique-tournaments/EN';
  
  const proxies = [
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
    'https://corsproxy.io/?'
  ];

  for (const proxy of proxies) {
    console.log(`Testing ${proxy}...`);
    try {
      const url = proxy + encodeURIComponent(target);
      const res = await axios.get(url, { timeout: 8000 });
      console.log(`✅ Success with ${proxy}: ${res.status}`);
      break;
    } catch (e) {
      console.log(`❌ Failed with ${proxy}: ${e.message}`);
    }
  }
}

testProxy();
