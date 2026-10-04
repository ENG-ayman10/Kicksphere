const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadService(sendMail, created) {
  const resolved = require.resolve('../services/emailService');
  delete require.cache[resolved];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    if (name === 'nodemailer') return { createTransport(options) { created.push(options); return { sendMail }; } };
    if (name === '../utils/logger') return { info() {}, warn() {}, error() {} };
    return original.call(this, name, parent, main);
  };
  try { return require('../services/emailService'); } finally { Module._load = original; }
}

async function withSmtp(settings, action) {
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { delete process.env[key]; if (settings[key] !== undefined) process.env[key] = settings[key]; }
  try { await action(); } finally {
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
}

test('password recovery keeps SMTP options/recipient and escapes untrusted display names after dependency upgrade', async () => {
  await withSmtp({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'offline@example.test',
    SMTP_PASS: 'offline-only', SMTP_FROM: 'KickSphere <offline@example.test>' }, async () => {
    const created = []; let payload;
    const service = loadService(async options => { payload = options; return { messageId: 'offline-message-id' }; }, created);
    assert.equal(service.isConfigured(), true);
    assert.deepEqual(await service.sendResetPasswordEmail('fan@example.test', '123456', '<script>&"Fan"'),
      { sent: true, messageId: 'offline-message-id' });
    assert.deepEqual(created, [{ host: 'smtp.example.test', port: 465, secure: true,
      auth: { user: 'offline@example.test', pass: 'offline-only' } }]);
    assert.equal(payload.to, 'fan@example.test');
    assert.equal(payload.html.includes('<script>'), false);
    assert.ok(payload.html.includes('&lt;script&gt;&amp;&quot;Fan&quot;'));
    assert.ok(payload.html.includes('123456'));
  });
});

test('missing SMTP or a mocked delivery failure never pretends a password email was delivered', async () => {
  await withSmtp({}, async () => {
    const created = [];
    const service = loadService(async () => assert.fail('No SMTP transport may be used'), created);
    assert.equal(service.isConfigured(), false);
    assert.deepEqual(await service.sendResetPasswordEmail('fan@example.test', '123456'), { sent: false, reason: 'SMTP_NOT_CONFIGURED' });
    assert.deepEqual(created, []);
  });
  await withSmtp({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'offline@example.test', SMTP_PASS: 'offline-only' }, async () => {
    const service = loadService(async () => { throw new Error('offline simulated failure'); }, []);
    assert.deepEqual(await service.sendResetPasswordEmail('fan@example.test', '123456'), { sent: false, reason: 'DELIVERY_FAILED' });
  });
});
