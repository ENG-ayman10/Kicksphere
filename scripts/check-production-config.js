require('dotenv').config({ quiet: true });
const { loadRuntimeConfig } = require('../utils/runtimeConfig');

try {
  const config = loadRuntimeConfig({ ...process.env, NODE_ENV: 'production' });
  console.log(JSON.stringify({ success: true, check: 'production configuration',
    trustedOriginCount: config.allowedOrigins.length,
    proxyMode: Array.isArray(config.trustProxy) ? 'IP/CIDR allowlist' : config.trustProxy,
    providerConnectivityChecked: false, credentialsPrinted: false }));
} catch (error) {
  console.error(`Production configuration rejected: ${error.message}`);
  process.exitCode = 1;
}
