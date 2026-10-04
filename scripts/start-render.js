const { loadRuntimeConfig } = require('../utils/runtimeConfig');

// Render assigns the public URL on creation. Explicit domains/origins still
// take precedence; this helper does not change the generic production rules.
function prepareRenderEnvironment(env) {
  if (env.RENDER !== 'true') throw new Error('This startup command is for Render only');
  const prepared = { ...env, NODE_ENV: 'production' };
  if (!String(prepared.PUBLIC_BASE_URL || '').trim()) {
    prepared.PUBLIC_BASE_URL = env.RENDER_EXTERNAL_URL || '';
  }
  if (!String(prepared.ALLOWED_ORIGINS || '').trim()) {
    prepared.ALLOWED_ORIGINS = prepared.PUBLIC_BASE_URL;
  }
  const config = loadRuntimeConfig(prepared);
  prepared.PUBLIC_BASE_URL = config.publicBaseUrl;
  return prepared;
}

if (require.main === module) {
  try {
    Object.assign(process.env, prepareRenderEnvironment(process.env));
    // Keep one process so the server's existing graceful shutdown handles it.
    require('../server');
  } catch (error) {
    console.error(`Render startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { prepareRenderEnvironment };
