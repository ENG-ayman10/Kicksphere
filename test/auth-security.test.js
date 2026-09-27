const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createHash } = require('node:crypto');

const email = 'fan@example.com';
const userKey = 'users/u1';
const resetKey = `password_resets/${email}`;
const codeHash = (code, salt) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

// A serialized in-memory transaction store; never initialize Firebase or SMTP.
function fixture({ password = 'hashed:old-password', passwordFormatVersion, hash } = {}) {
  const records = new Map([[userKey, {
    id: 'u1', email, emailLower: email, password, tokenVersion: 0,
    ...(passwordFormatVersion === undefined ? {} : { passwordFormatVersion })
  }]]);
  let queue = Promise.resolve();
  const snapshot = key => ({ exists: records.has(key), data: () => ({ ...records.get(key) }) });
  const db = {
    collection(name) {
      return {
        doc: (id = 'u2') => ({ id, key: `${name}/${id}`, set: async data => records.set(`${name}/${id}`, data) }),
        where: (field, _, value) => ({ limit: () => ({ get: async () => {
          const rows = [...records].filter(([key, data]) => key.startsWith(`${name}/`) && data[field] === value);
          return { empty: rows.length === 0, docs: rows.map(([key, data]) => ({ id: key.split('/')[1], data: () => ({ ...data }) })) };
        } }) })
      };
    },
    runTransaction(fn) {
      const work = queue.then(async () => {
        const writes = [];
        const result = await fn({
          get: async ref => snapshot(ref.key),
          update: (ref, values) => writes.push(() => records.set(ref.key, { ...records.get(ref.key), ...values })),
          set: (ref, values) => writes.push(() => records.set(ref.key, values)),
          delete: ref => writes.push(() => records.delete(ref.key))
        });
        writes.forEach(write => write());
        return result;
      });
      queue = work.catch(() => {});
      return work;
    }
  };
  let hashes = 0;
  const compared = [];
  const mocks = {
    '../config/firebase': db,
    '../utils/auth': { signJwtForUser: user => `session:${user.tokenVersion || 0}` },
    '../utils/logger': { info() {}, warn() {}, error() {} },
    '../services/emailService': {},
    bcryptjs: {
      hash: async value => { hashes++; return hash ? hash(value, records) : `hashed:${value}`; },
      compare: async (value, stored) => { compared.push(value); return `hashed:${value}` === stored; }
    }
  };
  const original = Module._load;
  const resolved = require.resolve('../controllers/authController');
  delete require.cache[resolved];
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  let auth;
  try { auth = require('../controllers/authController'); } finally { Module._load = original; }

  return {
    records, compared, hashes: () => hashes,
    challenge(code = '123456', overrides = {}) {
      records.set(resetKey, { codeHash: codeHash(code, 'salt'), salt: 'salt', attempts: 0, expiresAt: Date.now() + 60000, ...overrides });
    },
    async call(method, body, context = {}) {
      const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
      await auth[method]({ ...context, body: { email, ...body } }, res);
      return res;
    }
  };
}

test('new registrations mark the exact password format', async () => {
  const f = fixture();
  const result = await f.call('register', { email: 'new@example.com', name: 'Fan', password: '  literal <secret>  ' });
  assert.equal(result.statusCode, 201);
  assert.equal(f.records.get('users/u2').passwordFormatVersion, 2);
  assert.equal(f.records.get('users/u2').password, 'hashed:  literal <secret>  ');
});

test('legacy sanitized passwords migrate once to the original login input', async () => {
  const f = fixture({ password: 'hashed:secret' });
  const originalPassword = '  secret<tag>  ';
  assert.equal((await f.call('login', { password: originalPassword })).statusCode, 200);
  assert.equal(f.records.get(userKey).password, `hashed:${originalPassword}`);
  assert.equal(f.records.get(userKey).passwordFormatVersion, 2);
  assert.equal((await f.call('login', { password: 'secret' })).statusCode, 401);
  assert.equal((await f.call('login', { password: originalPassword })).statusCode, 200);
  assert.equal(f.hashes(), 1);
});

test('current accounts never accept a sanitized variant of their password', async () => {
  const f = fixture({ password: 'hashed:secret', passwordFormatVersion: 2 });
  assert.equal((await f.call('login', { password: '  secret<tag>  ' })).statusCode, 401);
  assert.deepEqual(f.compared, ['  secret<tag>  ']);
  assert.equal(f.hashes(), 0);
});

test('legacy migration never silently truncates passwords at the bcrypt byte limit', async () => {
  const f = fixture({ password: 'hashed:secret' });
  const result = await f.call('login', { password: `secret<${'x'.repeat(80)}>` });
  assert.equal(result.statusCode, 400);
  assert.match(result.body.message, /reset.*72/);
  assert.equal(f.records.get(userKey).password, 'hashed:secret');
  assert.equal(f.hashes(), 0);
});

test('legacy migration cannot overwrite a concurrent password reset', async () => {
  const f = fixture({ password: 'hashed:secret', hash: async (value, records) => {
    records.set(userKey, { ...records.get(userKey), password: 'hashed:reset-password', passwordFormatVersion: 2, tokenVersion: 1 });
    return `hashed:${value}`;
  } });
  assert.equal((await f.call('login', { password: 'secret<tag>' })).statusCode, 401);
  assert.equal(f.records.get(userKey).password, 'hashed:reset-password');
});

test('missing, expired, and incorrect reset requests never run bcrypt', async () => {
  const f = fixture();
  const body = { code: '123456', newPassword: 'new-password' };
  assert.equal((await f.call('resetPassword', body)).statusCode, 400);
  f.challenge('123456', { expiresAt: Date.now() - 1 });
  assert.equal((await f.call('resetPassword', body)).statusCode, 400);
  f.challenge();
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.call('resetPassword', { ...body, code: '654321' })).statusCode, 400);
  }
  assert.equal(f.records.get(resetKey).attempts, 5);
  assert.equal((await f.call('resetPassword', body)).statusCode, 400);
  assert.equal(f.hashes(), 0);
});

test('the fifth correct reset attempt succeeds and consumes the challenge once', async () => {
  const f = fixture();
  f.challenge('123456', { attempts: 4 });
  assert.equal((await f.call('resetPassword', { code: '123456', newPassword: '  exact <password>  ' })).statusCode, 200);
  assert.equal(f.records.has(resetKey), false);
  assert.equal(f.records.get(userKey).password, 'hashed:  exact <password>  ');
  assert.equal(f.records.get(userKey).passwordFormatVersion, 2);
  assert.equal(f.records.get(userKey).tokenVersion, 1);
});

test('resending a code while hashing prevents the old challenge from changing a password', async () => {
  const f = fixture({ hash: async (value, records) => {
    records.set(resetKey, { codeHash: codeHash('654321', 'new-salt'), salt: 'new-salt', attempts: 0, expiresAt: Date.now() + 60000 });
    return `hashed:${value}`;
  } });
  f.challenge();
  assert.equal((await f.call('resetPassword', { code: '123456', newPassword: 'new-password' })).statusCode, 400);
  assert.equal(f.records.get(userKey).password, 'hashed:old-password');
  assert.equal(f.records.get(resetKey).salt, 'new-salt');
});

test('concurrent valid resets can change the password only once', async () => {
  const f = fixture();
  f.challenge();
  const results = await Promise.all([
    f.call('resetPassword', { code: '123456', newPassword: 'new-password-a' }),
    f.call('resetPassword', { code: '123456', newPassword: 'new-password-b' })
  ]);
  assert.deepEqual(results.map(res => res.statusCode).sort(), [200, 400]);
  assert.equal(f.records.get(userKey).tokenVersion, 1);
  assert.equal(f.records.has(resetKey), false);
});

test('a successful password reset disconnects existing authenticated sockets', async () => {
  const f = fixture();
  f.challenge();
  const disconnected = [];
  const context = { app: { get(name) {
    assert.equal(name, 'io');
    return { in: room => ({ disconnectSockets: close => disconnected.push({ room, close }) }) };
  } } };
  assert.equal((await f.call('resetPassword', { code: '654321', newPassword: 'new-password' }, context)).statusCode, 400);
  assert.deepEqual(disconnected, []);
  assert.equal((await f.call('resetPassword', { code: '123456', newPassword: 'new-password' }, context)).statusCode, 200);
  assert.deepEqual(disconnected, [{ room: 'user:u1', close: true }]);
});

test('JWTs issued before a password reset are rejected and new sessions are accepted', async () => {
  const originalLoad = Module._load;
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-only-secret-material-with-more-than-32-bytes';
  let tokenVersion = 0;
  Module._load = function (name, parent, isMain) {
    if (name === '../config/firebase') return {
      collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ tokenVersion }) }) }) })
    };
    if (name === 'firebase-admin/auth') return { getAuth: () => ({ verifyIdToken: async () => { throw new Error('Not a Firebase token'); } }) };
    return originalLoad.call(this, name, parent, isMain);
  };
  const resolved = require.resolve('../utils/auth');
  delete require.cache[resolved];
  try {
    const auth = require('../utils/auth');
    const before = auth.signJwtForUser({ id: 'u1', tokenVersion: 0 });
    assert.equal((await auth.verifyAuthToken(before)).id, 'u1');
    tokenVersion = 1;
    await assert.rejects(() => auth.verifyAuthToken(before), /Invalid or expired/);
    const after = auth.signJwtForUser({ id: 'u1', tokenVersion: 1 });
    assert.equal((await auth.verifyAuthToken(after)).tokenVersion, 1);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
