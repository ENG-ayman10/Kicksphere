const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareRenderEnvironment } = require('../scripts/start-render');

const environment = () => ({
  RENDER: 'true',
  RENDER_EXTERNAL_URL: 'https://render-startup-test.onrender.com',
  PORT: '10000',
  JWT_SECRET: 'synthetic-render-test-secret-longer-than-32-bytes',
  FIREBASE_PROJECT_ID: 'render-startup-test',
  FIREBASE_CLIENT_EMAIL: 'test-account@render-startup-test.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: 'synthetic-key-for-config-validation-only',
});

test('Render startup uses its assigned HTTPS origin without mutating input or process environment', () => {
  const input = environment();
  const before = { ...process.env };
  const prepared = prepareRenderEnvironment(input);
  assert.equal(prepared.NODE_ENV, 'production');
  assert.equal(prepared.PUBLIC_BASE_URL, input.RENDER_EXTERNAL_URL);
  assert.equal(prepared.ALLOWED_ORIGINS, input.RENDER_EXTERNAL_URL);
  assert.equal(prepared.PORT, '10000');
  assert.equal(prepared.JWT_SECRET, input.JWT_SECRET);
  assert.equal(input.NODE_ENV, undefined);
  assert.equal(input.PUBLIC_BASE_URL, undefined);
  assert.deepEqual({ ...process.env }, before);
});

test('Render startup preserves explicit public domain and browser origin list', () => {
  const input = { ...environment(), PUBLIC_BASE_URL: 'https://api.kicksphere.test',
    ALLOWED_ORIGINS: 'https://app.kicksphere.test,https://admin.kicksphere.test' };
  const prepared = prepareRenderEnvironment(input);
  assert.equal(prepared.PUBLIC_BASE_URL, input.PUBLIC_BASE_URL);
  assert.equal(prepared.ALLOWED_ORIGINS, input.ALLOWED_ORIGINS);
});

test('Render startup requires Render metadata and a public origin', () => {
  for (const renderValue of [undefined, '', 'false', 'TRUE']) {
    assert.throws(() => prepareRenderEnvironment({ ...environment(), RENDER: renderValue }), /Render only/);
  }
  assert.throws(() => prepareRenderEnvironment({ ...environment(), RENDER_EXTERNAL_URL: undefined }), /ALLOWED_ORIGINS|PUBLIC_BASE_URL/);
});

test('Render startup rejects unsafe platform URLs instead of allowing arbitrary origins', () => {
  for (const url of ['http://render-startup-test.onrender.com', 'https://localhost',
    'https://127.0.0.1', 'https://10.0.0.1', 'https://user:pass@render-startup-test.onrender.com',
    'https://render-startup-test.onrender.com/api', 'https://render-startup-test.onrender.com?key=value']) {
    assert.throws(() => prepareRenderEnvironment({ ...environment(), RENDER_EXTERNAL_URL: url }));
  }
  assert.throws(() => prepareRenderEnvironment({ ...environment(), ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS/);
});

test('Render startup enforces real production credentials and bounded proxy trust', () => {
  for (const name of ['JWT_SECRET', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {
    assert.throws(() => prepareRenderEnvironment({ ...environment(), [name]: '' }), new RegExp(name));
  }
  assert.throws(() => prepareRenderEnvironment({ ...environment(), TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.equal(prepareRenderEnvironment({ ...environment(), TRUST_PROXY: '1' }).TRUST_PROXY, '1');
});
