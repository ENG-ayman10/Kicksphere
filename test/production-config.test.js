const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuntimeConfig, isOriginAllowed, parseTrustProxy } = require('../utils/runtimeConfig');
// Synthetic values are confined to offline validation; no SDK initialization,
// real private key, token, database access, or provider call occurs here.
const production = overrides => ({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
  PUBLIC_BASE_URL: 'https://api.example.com', JWT_SECRET: 'offline-config-test-secret-at-least-32-bytes',
  FIREBASE_PROJECT_ID: 'offline-test-project', FIREBASE_CLIENT_EMAIL: 'test@test.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: 'offline-configuration-test-only', ...overrides });

test('production refuses absent/wildcard or malformed browser origins before starting', () => {
  for (const origins of ['', '*', 'https://app.example.com,*', 'https://app.example.com,',
    'http://app.example.com', 'https://localhost', 'https://app.example.com/path',
    'https://user:password@app.example.com', 'https://*.example.com']) {
    assert.throws(() => loadRuntimeConfig(production({ ALLOWED_ORIGINS: origins })), /ALLOWED_ORIGINS/);
  }
});

test('HTTP and socket origin decisions are exact, while native requests keep auth-independent access policy', () => {
  const config = loadRuntimeConfig(production());
  assert.equal(isOriginAllowed(config, 'https://app.example.com'), true);
  assert.equal(isOriginAllowed(config, undefined), true);
  for (const origin of ['https://app.example.com.evil.test', 'http://app.example.com', 'null', 'https://evil.test']) {
    assert.equal(isOriginAllowed(config, origin), false);
  }
});

test('production browser and public backend origins reject private/internal hosts including canonical mapped IPv6', () => {
  const hosts = ['localhost.', 'app.localhost', 'app.local', '0.0.0.0', '127.0.0.1', '10.0.0.1',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '[::]', '[::1]', '[fc00::1]',
    '[fd12::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:c0a8:1]', '[::ffff:ac1f:ffff]'];
  for (const host of hosts) {
    const origin = `https://${host}`;
    assert.throws(() => loadRuntimeConfig(production({ ALLOWED_ORIGINS: origin })), /ALLOWED_ORIGINS/);
    assert.throws(() => loadRuntimeConfig(production({ PUBLIC_BASE_URL: origin })), /PUBLIC_BASE_URL/);
  }
  for (const host of ['172.15.255.255', '172.32.0.1', '192.0.2.1', '[2001:db8::1]', '[::ffff:8.8.8.8]']) {
    assert.equal(loadRuntimeConfig(production({ PUBLIC_BASE_URL: `https://${host}` })).production, true);
  }
  assert.equal(loadRuntimeConfig({ NODE_ENV: 'development', ALLOWED_ORIGINS: 'http://192.168.1.1:8082' }).production, false);
});

test('proxy trust is bounded or explicit and does not trust arbitrary forwarded headers in development', () => {
  assert.equal(parseTrustProxy('', false), false);
  assert.equal(parseTrustProxy('', true), 1);
  assert.equal(parseTrustProxy('false', true), false);
  assert.equal(parseTrustProxy('2', true), 2);
  assert.deepEqual(parseTrustProxy('127.0.0.1,10.20.0.0/16,2001:db8::/32', true), ['127.0.0.1', '10.20.0.0/16', '2001:db8::/32']);
  for (const value of ['true', '*', '6', '-1', '1.5', 'untrusted-host', '192.0.2.1/33', '0.0.0.0/0', '::/0']) {
    assert.throws(() => parseTrustProxy(value, true), /TRUST_PROXY/);
  }
});

test('production configuration enforces Firebase/JWT/public URL and validates enabled proxy credentials', () => {
  for (const name of ['PUBLIC_BASE_URL', 'JWT_SECRET', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {
    assert.throws(() => loadRuntimeConfig(production({ [name]: '' })), new RegExp(name));
  }
  assert.throws(() => loadRuntimeConfig(production({ PUBLIC_BASE_URL: 'http://localhost:3000' })), /PUBLIC_BASE_URL/);
  assert.throws(() => loadRuntimeConfig(production({ ENABLE_RAPIDAPI_PROXY: 'true' })), /RAPID_API_KEY/);
  assert.throws(() => loadRuntimeConfig(production({ PORT: '0' })), /PORT/);
  assert.throws(() => loadRuntimeConfig(production({ ENABLE_LIVE_POLLING: 'yes' })), /ENABLE_LIVE_POLLING/);
  assert.equal(loadRuntimeConfig(production()).production, true);
});

test('development wildcard is explicit or empty and is not allowed alongside trusted origins', () => {
  assert.equal(loadRuntimeConfig({ NODE_ENV: 'development' }).allowAllOrigins, true);
  assert.equal(loadRuntimeConfig({ NODE_ENV: 'development', ALLOWED_ORIGINS: '*' }).allowAllOrigins, true);
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: 'development', ALLOWED_ORIGINS: '*,http://localhost:8082' }), /ALLOWED_ORIGINS/);
});

test('live poll intervals remain explicit and bounded to protect provider quotas', () => {
  const defaults = loadRuntimeConfig({ NODE_ENV: 'test' });
  assert.equal(defaults.livePollingEnabled, false);
  assert.equal(defaults.liveMatchesPollIntervalMs, 60000);
  assert.equal(defaults.liveEventsPollIntervalMs, 90000);
  const enabled = loadRuntimeConfig({ NODE_ENV: 'test', ENABLE_LIVE_POLLING: 'true',
    LIVE_MATCHES_POLL_INTERVAL_MS: '45000', LIVE_EVENTS_POLL_INTERVAL_MS: '30000' });
  assert.equal(enabled.livePollingEnabled, true);
  assert.equal(enabled.liveMatchesPollIntervalMs, 45000);
  assert.equal(enabled.liveEventsPollIntervalMs, 30000);
  for (const name of ['LIVE_MATCHES_POLL_INTERVAL_MS', 'LIVE_EVENTS_POLL_INTERVAL_MS']) {
    for (const value of ['0', '-1', '29999', '900001', 'NaN', '30s', '30000.5']) {
      assert.throws(() => loadRuntimeConfig({ NODE_ENV: 'test', [name]: value }), new RegExp(name));
    }
  }
});
