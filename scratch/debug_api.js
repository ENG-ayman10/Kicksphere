const axios = require('axios');

async function debugAPI() {
  try {
    // 1. Test raw SportScore widget matches
    console.log('=== RAW SportScore Widget Matches ===');
    const widgetRes = await axios.get('https://sportscore.com/api/widget/matches/', {
      params: { sport: 'football', limit: 5 },
      headers: { 'User-Agent': 'KickSphereApp/1.0', 'Accept': 'application/json' },
      timeout: 10000
    });
    console.log('Keys:', Object.keys(widgetRes.data));
    if (widgetRes.data?.matches?.[0]) {
      console.log('\nFirst match RAW keys:', Object.keys(widgetRes.data.matches[0]));
      console.log('\nFirst match RAW data:', JSON.stringify(widgetRes.data.matches[0], null, 2));
      console.log('\nSecond match RAW data:', JSON.stringify(widgetRes.data.matches[1], null, 2));
    } else {
      console.log('No matches in widget response');
      console.log('Full response sample:', JSON.stringify(widgetRes.data).substring(0, 3000));
    }

    // 2. Test fixtures endpoint  
    console.log('\n\n=== RAW SportScore Fixtures ===');
    const today = new Date().toISOString().split('T')[0];
    const fixturesRes = await axios.get('https://sportscore.com/api/v1/fixtures/', {
      params: { sport: 'football', date: today, limit: 5 },
      headers: { 'User-Agent': 'KickSphereApp/1.0', 'Accept': 'application/json' },
      timeout: 10000
    });
    console.log('Keys:', Object.keys(fixturesRes.data));
    if (fixturesRes.data?.matches?.[0]) {
      console.log('\nFirst fixture RAW keys:', Object.keys(fixturesRes.data.matches[0]));
      console.log('\nFirst fixture RAW data:', JSON.stringify(fixturesRes.data.matches[0], null, 2));
    } else {
      console.log('No matches in fixtures response');
      console.log('Full response sample:', JSON.stringify(fixturesRes.data).substring(0, 3000));
    }

  } catch (e) {
    console.error('Error:', e.message);
    if (e.response) {
      console.error('Status:', e.response.status);
      console.error('Data:', JSON.stringify(e.response.data).substring(0, 500));
    }
  }
}

debugAPI();
