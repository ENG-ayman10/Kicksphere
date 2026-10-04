const { isIP } = require('node:net');

const invalid = (name, reason) => { throw new Error(`${name} ${reason}`); };
function isLocalHost(host) {
  const clean = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (clean.startsWith('::ffff:')) {
    const mapped = clean.slice(7);
    // URL canonicalizes IPv4-mapped IPv6 literals to two hexadecimal groups.
    const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (groups) {
      const first = parseInt(groups[1], 16); const second = parseInt(groups[2], 16);
      return isLocalHost(`${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
    }
    return isLocalHost(mapped);
  }
  if (clean === 'localhost' || clean.endsWith('.localhost') || clean.endsWith('.local') ||
      clean === '::' || clean === '::1' || /^(fc|fd)[0-9a-f]*:/.test(clean) || clean.startsWith('fe80:')) return true;
  if (isIP(clean) !== 4) return false;
  const [first, second] = clean.split('.').map(Number);
  return first === 0 || first === 127 || first === 10 ||
    (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254);
}

function normalizeOrigin(value, name, production) {
  let url;
  try { url = new URL(value); } catch { invalid(name, 'must contain valid HTTP(S) origins'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || value.includes('*')) {
    invalid(name, 'must contain origins only (no wildcard, credentials, path, query, or fragment)');
  }
  if (production && (url.protocol !== 'https:' || isLocalHost(url.hostname))) {
    invalid(name, 'must use public HTTPS origins in production');
  }
  return url.origin;
}

function parseTrustProxy(value, production) {
  const raw = String(value || '').trim();
  // Retain the prior single-hop production deployment assumption. It must be
  // confirmed against the actual ingress topology before publishing.
  if (!raw) return production ? 1 : false;
  if (raw === 'false' || raw === '0') return false;
  if (/^[1-5]$/.test(raw)) return Number(raw);
  const ranges = raw.split(',').map(item => item.trim()).filter(Boolean);
  if (!ranges.length || ranges.some(range => {
    const [address, prefix, extra] = range.split('/');
    const version = isIP(address);
    return !version || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 0 || Number(prefix) > (version === 4 ? 32 : 128)));
  })) invalid('TRUST_PROXY', 'must be false, 0–5 trusted hops, or explicit IP/CIDR ranges; true is not permitted');
  if (ranges.some(range => /\/0$/.test(range))) invalid('TRUST_PROXY', 'must not trust the entire internet');
  return ranges;
}

function loadRuntimeConfig(env = process.env) {
  const environment = String(env.NODE_ENV || 'development').trim();
  if (!['development', 'test', 'production'].includes(environment)) invalid('NODE_ENV', 'must be development, test, or production');
  const production = environment === 'production';
  const rawOrigins = String(env.ALLOWED_ORIGINS || '').trim();
  if (production && (!rawOrigins || rawOrigins.split(',').some(origin => !origin.trim() || origin.trim() === '*'))) {
    invalid('ALLOWED_ORIGINS', 'requires an explicit trusted HTTPS origin list in production');
  }
  const allowedOrigins = [...new Set(rawOrigins.split(',').map(origin => origin.trim()).filter(Boolean)
    .filter(origin => origin !== '*').map(origin => normalizeOrigin(origin, 'ALLOWED_ORIGINS', production)))];
  const allowAllOrigins = !production && (!rawOrigins || rawOrigins === '*');
  if (!production && rawOrigins.includes('*') && rawOrigins !== '*') invalid('ALLOWED_ORIGINS', 'must not mix wildcard and explicit origins');
  const publicBaseUrl = String(env.PUBLIC_BASE_URL || '').trim();
  if (production && !publicBaseUrl) invalid('PUBLIC_BASE_URL', 'is required in production');
  const publicOrigin = publicBaseUrl ? normalizeOrigin(publicBaseUrl, 'PUBLIC_BASE_URL', production) : null;
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('PORT', 'must be an integer from 1 to 65535');
  for (const name of ['ENABLE_LIVE_POLLING', 'ENABLE_RAPIDAPI_PROXY', 'ENABLE_SOFASCORE_PROXY']) {
    if (env[name] && !['true', 'false'].includes(env[name])) invalid(name, 'must be true or false');
  }
  if (production) {
    const secret = env.JWT_SECRET || '';
    if (Buffer.byteLength(secret) < 32 || secret === 'kicksphere_super_secret_key_CHANGE_IN_PRODUCTION') {
      invalid('JWT_SECRET', 'must contain at least 32 bytes of unpredictable secret material');
    }
    for (const name of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {
      const value = String(env[name] || '').trim();
      if (!value || /replace-me|your-firebase-project-id|firebase-adminsdk@example/i.test(value)) {
        invalid(name, 'requires a real environment credential in production');
      }
    }
    if (env.ENABLE_RAPIDAPI_PROXY === 'true' && (!env.RAPID_API_KEY || !env.RAPID_API_HOST)) {
      invalid('RAPID_API_KEY / RAPID_API_HOST', 'are required when the proxy is enabled');
    }
  }
  const trustProxy = parseTrustProxy(env.TRUST_PROXY, production);
  const pollingInterval = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !Number.isInteger(value) || value < 30000 || value > 900000) {
      invalid(name, 'must be an integer from 30000 to 900000 milliseconds');
    }
    return value;
  };
  return Object.freeze({ environment, production, allowedOrigins, allowAllOrigins, publicBaseUrl: publicOrigin,
    trustProxy, port, livePollingEnabled: env.ENABLE_LIVE_POLLING === 'true',
    liveMatchesPollIntervalMs: pollingInterval('LIVE_MATCHES_POLL_INTERVAL_MS', 60000),
    liveEventsPollIntervalMs: pollingInterval('LIVE_EVENTS_POLL_INTERVAL_MS', 90000) });
}

function isOriginAllowed(config, origin) {
  // Native clients have no Origin; authenticated routes and user rooms still
  // apply their own auth checks. CORS is never a substitute for authorization.
  return !origin || config.allowAllOrigins || config.allowedOrigins.includes(origin);
}

function createOriginPolicy(config) {
  return {
    corsOrigin: (origin, callback) => callback(null, isOriginAllowed(config, origin)),
    allowSocketRequest: (req, callback) => callback(null, isOriginAllowed(config, req.headers.origin)),
    middleware: (req, res, next) => {
      if (!isOriginAllowed(config, req.get('origin'))) {
        return res.status(403).json({ success: false, message: 'Request origin is not permitted.' });
      }
      return next();
    }
  };
}

module.exports = { loadRuntimeConfig, isOriginAllowed, parseTrustProxy, createOriginPolicy };
