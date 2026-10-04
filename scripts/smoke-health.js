const { isIP } = require('node:net');

async function main() {
  const args = process.argv.slice(2);
  const rawUrl = args.find(arg => !arg.startsWith('--'));
  if (!rawUrl || args.some(arg => arg.startsWith('--') && arg !== '--allow-local')) {
    throw new Error('Usage: node scripts/smoke-health.js https://backend.example.com [--allow-local]');
  }
  const url = new URL(rawUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol !== 'https:' && !(local && args.includes('--allow-local')))) {
    throw new Error('Use an HTTPS backend origin; HTTP is permitted only for explicit local smoke tests');
  }
  if (url.pathname !== '/' || (isIP(url.hostname) && !local && args.includes('--allow-local'))) {
    throw new Error('Pass the backend origin without an API path');
  }
  for (const endpoint of ['/api/health', '/api/ready']) {
    const response = await fetch(new URL(endpoint, url.origin), { signal: AbortSignal.timeout(10000), redirect: 'error' });
    const result = await response.json();
    if (response.status !== 200 || result.success !== true || (endpoint.endsWith('/ready') && result.status !== 'ready')) {
      throw new Error(`${endpoint} did not pass the health gate (HTTP ${response.status})`);
    }
    console.log(`${endpoint}: passed`);
  }
  console.log('Startup readiness passed. Upstream data completeness/reachability was not tested.');
}

main().catch(error => { console.error(`Health gate failed: ${error.message}`); process.exitCode = 1; });
