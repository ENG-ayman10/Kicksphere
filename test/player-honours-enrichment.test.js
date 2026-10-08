'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const profile = () => ({ id: 'bsd_p_852', provider: 'bsd', name: 'Erling Haaland', dateOfBirth: '2000-07-21',
  nationality: 'Norway', image: 'https://provider.test/player.png', teamId: 'bsd_t_17',
  seasonStats: { goals: 0 }, statsContext: { season: '2026' }, careerBySeason: [{ goals: 4 }],
  honours: [], honoursCoverage: { available: false, source: 'bsd', reason: 'honours_not_supplied' },
  coverage: { source: 'bsd', profile: { complete: true }, stats: { available: true }, complete: false } });
const history = () => ({ honours: [{ name: 'Example cup', season: '2023', place: 'Winner', isWinner: true,
  playerId: 'bsd_p_852', provider: 'api-football', providerPlayerId: 1100 }],
  honoursCoverage: { source: 'api-football', sourcePlayerId: 1100, identityVerified: true, available: true,
    complete: false, partial: true, returned: 1, reason: 'provider_history_scope_not_guaranteed' } });

function load(adapter) {
  const file = '../services/playerHonoursEnrichment';
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return name === './apiFootballHonoursService' ? adapter : original.call(this, name, parent, main);
  };
  try { return require(file).enrichMissingPlayerHonours; } finally { Module._load = original; }
}
async function enabled(fn) {
  const previous = process.env.ENABLE_API_FOOTBALL_HONOURS;
  process.env.ENABLE_API_FOOTBALL_HONOURS = 'true';
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.ENABLE_API_FOOTBALL_HONOURS;
    else process.env.ENABLE_API_FOOTBALL_HONOURS = previous;
  }
}

test('enrichment is opt-in and consumes no provider quota when disabled', async () => {
  const original = profile();
  const enrich = load({ isConfigured: () => assert.fail('disabled feature must not access the provider') });
  const previous = process.env.ENABLE_API_FOOTBALL_HONOURS;
  delete process.env.ENABLE_API_FOOTBALL_HONOURS;
  try { assert.strictEqual(await enrich(original), original); } finally {
    if (previous !== undefined) process.env.ENABLE_API_FOOTBALL_HONOURS = previous;
  }
});

test('unconfigured source leaves the current profile and missing coverage intact', () => enabled(async () => {
  const original = profile();
  const enrich = load({ isConfigured: () => false, getPlayerHonoursForProfile: () => assert.fail('not configured') });
  assert.strictEqual(await enrich(original), original);
}));

test('verified enrichment adds only honours and section coverage to the original BSD identity', () => enabled(async () => {
  const original = profile(); const before = structuredClone(original);
  const enrich = load({ isConfigured: () => true, getPlayerHonoursForProfile: async input => {
    assert.strictEqual(input, original); return { ...history(), id: 'ko_p_999', name: 'Different Player', seasonStats: { goals: 99 } };
  } });
  const result = await enrich(original);
  assert.deepEqual(original, before);
  for (const key of ['id', 'provider', 'name', 'dateOfBirth', 'image', 'teamId', 'seasonStats', 'statsContext', 'careerBySeason'])
    assert.deepEqual(result[key], before[key]);
  assert.equal(result.honours[0].providerPlayerId, 1100);
  assert.equal(result.coverage.honours.source, 'api-football');
  assert.deepEqual(result.coverage.profile, before.coverage.profile);
  assert.deepEqual(result.coverage.stats, before.coverage.stats);
  assert.equal(result.coverage.complete, false);
}));

test('existing native honours and authoritative empty histories are preserved', () => enabled(async () => {
  const enrich = load({ isConfigured: () => true, getPlayerHonoursForProfile: () => assert.fail('native history exists') });
  for (const extra of [{ honours: [{ name: 'Native cup' }] }, { trophies: [{ name: 'Native alias' }] },
    { honoursCoverage: { available: true, complete: true } }]) {
    const original = { ...profile(), ...extra };
    assert.strictEqual(await enrich(original), original);
  }
}));

test('enrichment never substitutes another scoped provider or malformed BSD identifier', () => enabled(async () => {
  const enrich = load({ isConfigured: () => true, getPlayerHonoursForProfile: () => assert.fail('unverified provider') });
  for (const extra of [{ provider: 'sportscore' }, { id: 'ko_p_852' }, { id: 'bsd_p_0' }, { id: 'bsd_p_852/other' }]) {
    const original = { ...profile(), ...extra };
    assert.strictEqual(await enrich(original), original);
  }
}));

test('unavailable, empty, unverified or foreign honour sections cannot overwrite source data', () => enabled(async () => {
  for (const change of [value => { value.honoursCoverage.available = false; },
    value => { value.honours = []; }, value => { value.honoursCoverage.identityVerified = false; },
    value => { value.honoursCoverage.source = 'kickoffapi'; },
    value => { value.honoursCoverage.sourcePlayerId = '0'; },
    value => { value.honours[0].playerId = 'bsd_p_999'; },
    value => { value.honours[0].provider = 'bsd'; },
    value => { value.honours[0].providerPlayerId = 999; }]) {
    const supplement = history(); change(supplement);
    const enrich = load({ isConfigured: () => true, getPlayerHonoursForProfile: async () => supplement });
    const original = profile();
    assert.strictEqual(await enrich(original), original);
  }
}));

test('a supplementary timeout or auth error does not fail the original player profile', () => enabled(async () => {
  const enrich = load({ isConfigured: () => true, getPlayerHonoursForProfile: async () => { throw new Error('upstream timeout'); } });
  const original = profile(); assert.strictEqual(await enrich(original), original);
}));

test('a complete resource is never presented as a complete career honours history', () => enabled(async () => {
  const supplement = history(); supplement.honoursCoverage.complete = true; supplement.honoursCoverage.partial = false;
  const enrich = load({ isConfigured: () => true, getPlayerHonoursForProfile: async () => supplement });
  const result = await enrich(profile());
  assert.equal(result.honoursCoverage.complete, false); assert.equal(result.honoursCoverage.partial, true);
}));

function controller(baseProfile, enrich) {
  const file = '../controllers/statsController';
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  const mocks = {
    '../services/bsdSportsService': { getPlayerDetails: async () => baseProfile },
    '../services/playerHonoursEnrichment': { enrichMissingPlayerHonours: enrich },
    '../services/sportscoreService': {}, '../services/kickoffApiService': {}, '../services/sportsDataService': {},
    '../services/teamService': {}, '../services/cacheService': {}, '../utils/logger': { warn() {}, error() {} },
  };
  Module._load = function (name, parent, main) { return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main); };
  try { return require(file); } finally { Module._load = original; }
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('deep player route preserves scoped identity and statistics while projecting verified honours', () => enabled(async () => {
  const original = profile();
  const enrich = load({ isConfigured: () => true, getPlayerHonoursForProfile: async () => history() });
  const api = controller(original, enrich), res = response();
  await api.getDeepPlayerDetails({ params: { id: original.id }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'bsd');
  assert.equal(res.body.data.info.id, original.id);
  assert.equal(res.body.data.info.provider, 'bsd');
  assert.equal(res.body.data.honours[0].playerId, original.id);
  assert.equal(res.body.data.honoursCoverage.source, 'api-football');
  assert.deepEqual(res.body.data.coverage.honours, res.body.data.honoursCoverage);
  assert.deepEqual(res.body.coverage.honours, res.body.data.honoursCoverage);
  assert.deepEqual(res.body.data.seasonStats, original.seasonStats);
  assert.deepEqual(res.body.data.careerBySeason, original.careerBySeason);
}));

test('deep route rejects a mismatched base identity before asking another source for trophies', async () => {
  const api = controller({ ...profile(), id: 'bsd_p_999' }, () => assert.fail('base identity mismatch'));
  const res = response();
  await api.getDeepPlayerDetails({ params: { id: 'bsd_p_852' }, query: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.coverage.reason, 'provider_identity_mismatch');
});
