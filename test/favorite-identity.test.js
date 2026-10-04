const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { favoriteTeamIds, matchTeamId, scopedTeamId } = require('../utils/teamIdentity');
const { normalizeFavoriteItem, normalizePreferences, normalizeStoredFavorite } = require('../utils/userContracts');

function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(file); } finally { Module._load = original; }
}

test('favorites distinguish namesake clubs by source-scoped identity and keep display metadata', () => {
  const chile = normalizeFavoriteItem({ type: 'team', targetId: 'sc_t_barcelona', provider: 'sportscore', name: 'Barcelona', logo: 'chile.png' });
  const spain = normalizeFavoriteItem({ type: 'team', targetId: 'ko_t_529', provider: 'kickoffapi', name: 'Barcelona', logo: 'spain.png' });
  assert.notEqual(chile.canonicalKey, spain.canonicalKey);
  assert.equal(chile.displayName, 'Barcelona');
  assert.equal(spain.imageUrl, 'spain.png');
  assert.throws(() => normalizeFavoriteItem({ type: 'team', targetId: 'sc_t_barcelona', provider: 'kickoffapi' }), /provider/);
  assert.throws(() => normalizeFavoriteItem({ type: 'team', targetId: 'sc_t_barcelona', provider: 'unknown' }), /provider/);
  assert.throws(() => normalizeFavoriteItem({ type: 'team', targetId: 'sc_t_' + 'a'.repeat(120) }), /too long/);
});

test('legacy names stay readable but never become socket or notification identifiers', () => {
  const legacy = normalizeStoredFavorite({ type: 'team', targetId: 'Barcelona', createdAt: 'old' });
  assert.equal(legacy.targetId, 'Barcelona');
  assert.equal(legacy.createdAt, 'old');
  assert.deepEqual(favoriteTeamIds(['Barcelona', 'barcelona', '529', legacy]), []);
  assert.equal(scopedTeamId('Real Madrid', 'sportscore'), null);
  assert.equal(scopedTeamId('529', 'sportscore'), null);
  assert.equal(matchTeamId({ id: '529', name: 'Barcelona' }), null);
});

test('KickOff club IDs must be positive integers and invalid scoped IDs cannot become another provider slug', () => {
  for (const id of ['0', '00', '01', '-1', 'ko_t_0', 'ko_t_01']) {
    assert.equal(scopedTeamId(id, 'kickoffapi'), null);
  }
  assert.equal(scopedTeamId('ko_t_0', 'sportscore'), null);
  assert.equal(scopedTeamId('sc_t_', 'sportscore'), null);
  assert.equal(scopedTeamId('529', 'kickoffapi'), 'ko_t_529');
  assert.equal(scopedTeamId('ko_t_529'), 'ko_t_529');
  assert.equal(scopedTeamId('sc_t_123', 'sportscore'), 'sc_t_123');
  assert.equal(scopedTeamId('1'.repeat(115), 'kickoffapi').length, 120);
  assert.equal(scopedTeamId('1'.repeat(116), 'kickoffapi'), null);
  assert.equal(scopedTeamId('a'.repeat(115), 'sportscore').length, 120);
  assert.equal(scopedTeamId('a'.repeat(116), 'sportscore'), null);
  assert.deepEqual(favoriteTeamIds(['ko_t_0', { id: 0, provider: 'kickoffapi' }]), []);
});

test('subscription records and preference index use the same exact IDs without object stringification', () => {
  const records = [{ id: 'real-madrid', provider: 'sportscore', name: 'Real Madrid' },
    { targetId: 'ko_t_541', provider: 'kickoffapi', name: 'Real Madrid' }, { id: 'real-madrid', provider: 'sportscore' }];
  assert.deepEqual(favoriteTeamIds([...records, 'Real Madrid']), ['sc_t_real-madrid', 'ko_t_541']);
  const preferences = normalizePreferences({ teams: ['Old Club', ...records], leagues: ['PL'], content: [] });
  assert.deepEqual(preferences.teams, ['Old Club']);
  assert.deepEqual(preferences.teamIds, ['sc_t_real-madrid', 'ko_t_541']);
  assert.equal(preferences.teamsV2.length, 2);
  assert.deepEqual(normalizePreferences({ teamIds: [], teamsV2: [] }).teamIds, []);
});

test('scoped SportScore profile/squad routes do not search the other provider on missing data', async () => {
  const calls = [];
  const teams = load('../services/teamService', {
    './sportscoreService': { getTeamDetails: async id => { calls.push(id); return null; } },
    './kickoffApiService': { getTeamDetails: async () => assert.fail('No fallback to a namesake at another provider'),
      getTeamSquad: async () => assert.fail('No namesake roster') },
    './searchService': { CLUBS: {} },
  });
  assert.equal(teams.resolveProviderTeamLookup('sc_t_barcelona'), 'barcelona');
  assert.equal((await teams.getTeamByIdService('sc_t_barcelona')).statusCode, 404);
  assert.deepEqual((await teams.getTeamSquadService('sc_t_barcelona')).data, []);
  assert.deepEqual(calls, ['barcelona', 'barcelona']);
});

test('deep scoped SportScore profile uses its exact slug, retains scoped ID, and refuses namesake fallback', async () => {
  let available = true;
  const controller = load('../controllers/statsController', {
    '../services/sportscoreService': { getTeamDetails: async id => { assert.equal(id, 'barcelona'); return available ?
      { info: { id, name: 'Barcelona', country: 'Chile' }, squad: [], matches: { recent: [], upcoming: [] } } : null; } },
    '../services/kickoffApiService': { getTeamDetails: async () => { assert.equal(available, true); return null; } },
    '../services/teamService': { resolveLocalTeam: () => null, resolveProviderTeamLookup: id => id.slice(5) },
    '../utils/logger': { warn() {}, error() {}, info() {} },
  });
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const success = response();
  await controller.getDeepTeamDetails({ params: { id: 'sc_t_barcelona' } }, success);
  assert.equal(success.body.data.info.id, 'sc_t_barcelona');
  assert.equal(success.body.data.info.providerId, 'barcelona');
  available = false;
  const missing = response();
  await controller.getDeepTeamDetails({ params: { id: 'sc_t_barcelona' } }, missing);
  assert.equal(missing.statusCode, 404);
});

test('legacy preference writes preserve verified identities while explicit clears remain possible', async () => {
  let stored = { preferences: { teams: ['Old Club'], teamIds: ['sc_t_real-madrid'],
    teamsV2: [{ targetId: 'sc_t_real-madrid', displayName: 'Real Madrid' }] } };
  const ref = { get: async () => ({ exists: true, data: () => stored }),
    set: async update => { stored = { ...stored, ...update }; } };
  const controller = load('../controllers/userController', {
    '../config/firebase': { collection: () => ({ doc: () => ref }) },
    '../utils/logger': { error() {} },
  });
  const res = { json(body) { this.body = body; }, status() { return this; } };
  await controller.savePreferences({ params: { userId: 'offline-fan' }, body: { teams: ['Legacy Name'], leagues: ['PL'] } }, res);
  assert.deepEqual(stored.preferences.teamIds, ['sc_t_real-madrid']);
  assert.equal(stored.preferences.teamsV2[0].displayName, 'Real Madrid');
  await controller.savePreferences({ params: { userId: 'offline-fan' }, body: { teamIds: [], teamsV2: [] } }, res);
  assert.deepEqual(stored.preferences.teamIds, []);
  assert.deepEqual(stored.preferences.teamsV2, []);
});

test('personalized home does not recommend a namesake using legacy or partial names', async () => {
  const clubMatch = (id, clubId) => ({ id, source: 'sportscore', homeTeam: { id: clubId, name: 'Barcelona' },
    awayTeam: { id: 'opponent', name: 'Opponent' }, competition: { code: 'PD' } });
  const controller = load('../controllers/homeController', {
    '../config/firebase': { collection: () => ({ doc: () => ({ get: async () => ({ exists: true,
      data: () => ({ preferences: { teams: ['Barcelona'], teamIds: ['sc_t_barcelona'] } }) }) }) }) },
    '../services/sportscoreService': { getMatchesByDate: async () => [clubMatch('chile-1', 'barcelona'),
      clubMatch('chile-2', 'barcelona'), clubMatch('spain', 'fc-barcelona')], getLiveMatches: async () => [] },
    '../utils/auth': { isAdminUser: () => false }, '../utils/logger': { info() {}, warn() {}, error() {} },
  });
  const res = { status() { return this; }, json(body) { this.body = body; } };
  await controller.getHome({ query: {}, user: { id: 'offline-fan' } }, res);
  assert.deepEqual(res.body.data.recommended.map(match => match.id), ['chile-1', 'chile-2']);
});
