const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
function load(file, mocks) {
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    return original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}

function database() {
  const records = new Map([['users/u1', { id: 'u1', name: 'Fan', email: 'fan@example.com', emailLower: 'fan@example.com', password: 'old', tokenVersion: 0 }]]);
  const snapshot = key => ({ exists: records.has(key), data: () => records.get(key) });
  let queue = Promise.resolve();
  return {
    records,
    collection(collection) {
      return {
        doc: id => ({ key: `${collection}/${id}`, get: async () => snapshot(`${collection}/${id}`) }),
        where: (field, op, value) => ({ limit: () => ({ get: async () => {
          const rows = [...records].filter(([key, data]) => key.startsWith(collection + '/') && data[field] === value);
          return { empty: rows.length === 0, docs: rows.map(([key, data]) => ({ id: key.split('/')[1], data: () => data })) };
        } }) }),
      };
    },
    runTransaction(fn) {
      const work = queue.then(async () => {
        const writes = [];
        const result = await fn({ get: async ref => snapshot(ref.key),
          set: (ref, data) => writes.push(() => records.set(ref.key, data)),
          update: (ref, data) => writes.push(() => records.set(ref.key, { ...records.get(ref.key), ...data })),
          delete: ref => writes.push(() => records.delete(ref.key)),
        });
        writes.forEach(write => write());
        return result;
      });
      queue = work.catch(() => {});
      return work;
    },
  };
}

function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

test('production refuses missing or known JWT secrets', () => {
  for (const secret of ['', 'kicksphere_super_secret_key_CHANGE_IN_PRODUCTION']) {
    const result = spawnSync(process.execPath, ['-e', "require('./utils/auth')"], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: secret }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JWT_SECRET must/);
  }
});

test('sanitization preserves passwords byte for byte', () => {
  const { sanitizeObject } = load('../middlewares/validate', { '../utils/logger': quietLogger });
  const password = '  <p> A&b </p>  ';
  assert.deepEqual(sanitizeObject({ password, newPassword: password, name: '<b> Fan </b>' }),
    { password, newPassword: password, name: 'Fan' });
});

test('Firebase environment credentials do not fall through to a local key file', () => {
  const previous = { ...process.env };
  let initialized = false;
  Object.assign(process.env, { NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'test', FIREBASE_CLIENT_EMAIL: 'test@example.com', FIREBASE_PRIVATE_KEY: 'test' });
  try {
    load('../config/firebase', {
      'firebase-admin/app': { getApps: () => [], cert: value => value, initializeApp: () => { initialized = true; } },
      'firebase-admin/firestore': { getFirestore: () => ({}) },
      fs: { existsSync: () => false }, '../utils/logger': quietLogger,
    });
    assert.equal(initialized, true);
  } finally { process.env = previous; }
});

test('reset codes stay private, expire after five failed attempts, and are single use', async () => {
  const db = database();
  let sentCode;
  const auth = load('../controllers/authController', {
    '../config/firebase': db, '../utils/auth': { signJwtForUser() {} }, '../utils/logger': quietLogger,
    bcryptjs: { hash: async value => 'hashed:' + value },
    '../services/emailService': { isConfigured: () => true, sendResetPasswordEmail: async (_, code) => { sentCode = code; return { sent: true }; } },
  });
  const request = response();
  await auth.forgotPassword({ body: { email: 'fan@example.com' } }, request);
  assert.equal(request.statusCode, 200);
  assert.equal(JSON.stringify(request.body).includes(sentCode), false);
  const stored = db.records.get('password_resets/fan@example.com');
  assert.equal(stored.code, undefined);
  assert.equal(stored.codeHash.length, 64);
  const unknown = response();
  await auth.forgotPassword({ body: { email: 'absent@example.com' } }, unknown);
  assert.deepEqual(unknown.body, request.body);
  for (let i = 0; i < 5; i++) {
    const result = response();
    await auth.resetPassword({ body: { email: 'fan@example.com', code: '000000', newPassword: 'valid-password' } }, result);
    assert.equal(result.statusCode, 400);
  }
  const locked = response();
  await auth.resetPassword({ body: { email: 'fan@example.com', code: sentCode, newPassword: 'valid-password' } }, locked);
  assert.equal(locked.statusCode, 400);
  const lockedRequest = db.records.get('password_resets/fan@example.com');
  await auth.forgotPassword({ body: { email: 'fan@example.com' } }, response());
  assert.equal(db.records.get('password_resets/fan@example.com'), lockedRequest);
  lockedRequest.createdAtMs = Date.now() - 60001;
  await auth.forgotPassword({ body: { email: 'fan@example.com' } }, response());
  const a = response(); const b = response();
  const req = { body: { email: 'fan@example.com', code: sentCode, newPassword: '  literal <secret>  ' } };
  await Promise.all([auth.resetPassword(req, a), auth.resetPassword(req, b)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 400]);
  assert.equal(db.records.get('users/u1').tokenVersion, 1);
  assert.equal(db.records.get('users/u1').passwordFormatVersion, 2);
  assert.equal(db.records.get('users/u1').password, 'hashed:  literal <secret>  ');
});

test('live status, red cards, and missing scores retain their meaning', () => {
  const provider = load('../services/sportscoreService', { '../utils/logger': quietLogger });
  for (const status of ['first_half', 'second_half', 'extra_time', 'ht']) {
    assert.equal(provider.normalizeMatch({ status, home: 'A', away: 'B' }).status, 'IN_PLAY');
  }
  assert.equal(provider.normalizeMatch({ status: 'scheduled' }).score.fullTime.home, null);
  const detail = provider.normalizeMatchDetail({ home: 'A', away: 'B', incidents: [{ type: 'red_card', is_card: true }] }, 'a-b');
  assert.equal(detail.timeline[0].type, 'red_card');
});

test('SportScore league slugs remain provider-accurate and unknown competitions stay distinct', () => {
  const provider = load('../services/sportscoreService', { '../utils/logger': quietLogger });
  assert.equal(provider.COMPETITION_SLUGS.SPL.slug, 'saudi-professional-league');
  assert.equal(provider.COMPETITION_SLUGS.PPL.slug, 'portuguese-primera-liga');
  assert.equal(provider.COMPETITION_SLUGS.MLS.slug, 'united-states-major-league-soccer');
  assert.equal(provider.normalizeMatch({
    competition: 'Saudi Professional League', status: 'scheduled', home: 'A', away: 'B'
  }).competition.code, 'SPL');
  assert.match(provider.normalizeMatch({
    competition: 'Some Regional Cup', status: 'scheduled', home: 'A', away: 'B'
  }).competition.code, /^SC:/);
});

test('competition ranges request the selected dates and never invent standings', async () => {
  const requested = [];
  const service = load('../services/sportsDataService', {
    './sportscoreService': {
      getMatchesByDate: async date => { requested.push(date); return [{ id: date, utcDate: date, competition: { code: 'PL' } }]; },
      getStandings: async () => [], getTopScorers: async () => [],
    }, '../utils/logger': quietLogger,
  });
  const result = await service.getCompetitionMatches('PL', '2026-09-24', '2026-09-26');
  assert.equal(result.data.length, 3);
  assert.deepEqual(requested, ['2026-09-24', '2026-09-25', '2026-09-26']);
  assert.equal((await service.getCompetitionMatches('PL', '2026-01-01', '2026-12-31')).statusCode, 400);
  assert.deepEqual((await service.getStandings('PL')).data, []);
  assert.deepEqual((await service.getTopScorers('PL', 10)).data, []);
});
