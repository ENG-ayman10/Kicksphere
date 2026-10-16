'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const vm = require('node:vm');
const { sameVerifiedTeam } = require('../services/teamService');

function setup(profile, candidate = null) {
  const requested = [], resolved = require.resolve('../controllers/statsController');
  delete require.cache[resolved];
  const stubs = {
    '../services/sportscoreService': { getTeamDetails: async slug => { requested.push(['sportscore', slug]); return profile; } },
    '../services/kickoffApiService': { getTeamDetails: async name => { requested.push(['kickoffapi', name]); return candidate; },
      getTeamSquad: async id => { requested.push(['kickoff-squad', id]); return [{ id: 'ko_p_900', name: 'Secondary Player' }]; },
      getTeamFixtures: async id => { requested.push(['kickoff-fixtures', id]); return { recent: [], upcoming: [] }; } },
    '../services/bsdSportsService': { getTeamDetails: async id => { requested.push(['bsd', id]); return null; } },
    '../services/sportsDataService': {}, '../services/verifiedMatchDetailsService': {},
    '../services/teamService': { resolveLocalTeam: () => null, resolveProviderTeamLookup: value => value.slice(5), sameVerifiedTeam },
    '../utils/logger': { info() {}, warn() {}, error() {} },
  };
  const original = Module._load;
  Module._load = function(name, parent, main) { return Object.hasOwn(stubs, name) ? stubs[name] : original.call(this, name, parent, main); };
  let api;
  try { api = require(resolved); } finally { Module._load = original; }
  return { api, requested };
}
function profile() {
  return { source: 'sportscore', info: { id: 'requested-club', slug: 'requested-club',
    provider: 'sportscore', name: 'Requested Club', country: 'Spain' },
  squad: [{ id: 'source-player', name: 'Published Player' }],
  matches: { recent: [{ id: 'published-match' }], upcoming: [] } };
}
async function request(api) {
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
  await api.getDeepTeamDetails({ params: { id: 'sc_t_requested-club' }, query: {} }, res);
  return res;
}

test('an explicitly wrong team ID or slug returns unavailable before any secondary lookup or profile relabelling', async () => {
  const changes = [
    row => { row.info.id = row.info.slug = 'other-club'; },
    row => { row.info.id = 'other-club'; },
    row => { row.info.slug = 'other-club'; },
    row => { row.info.id = 'ko_t_44'; },
    row => { row.info.id = 'bsd_t_44'; },
    row => { delete row.info.id; delete row.info.slug; },
    row => { row.provider = 'kickoffapi'; },
    row => { row.source = 'bsd'; },
    row => { row.info.provider = 'bsd'; },
    row => { row.info.source = 'kickoffapi'; },
  ];
  for (const change of changes) {
    const supplied = profile(); change(supplied);
    const before = structuredClone(supplied), { api, requested } = setup(supplied);
    const res = await request(api);
    assert.equal(res.statusCode, 404, change.toString());
    assert.equal(res.body.success, false); assert.equal(res.body.data, null);
    assert.equal(res.body.coverage.reason, 'provider_identity_mismatch');
    assert.deepEqual(requested, [['sportscore', 'requested-club']]);
    assert.deepEqual(supplied, before);
  }
});

test('an exact source team retains public favourite ID, native profile rows and explicit cohort metadata', async () => {
  for (const ids of [{ id: 'requested-club', slug: 'requested-club' },
    { id: 'sc_t_requested-club', slug: 'requested-club' }, { slug: 'requested-club' }]) {
    const supplied = profile();
    delete supplied.info.id; delete supplied.info.slug;
    Object.assign(supplied.info, ids, { isWomen: true, gender: 'female', ageGroup: 'U21', type: 'club' });
    const before = structuredClone(supplied), { api } = setup(supplied);
    const res = await request(api);
    assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
    assert.equal(res.body.data.info.id, 'sc_t_requested-club');
    assert.equal(res.body.data.info.provider, 'sportscore');
    assert.equal(res.body.data.info.isWomen, true); assert.equal(res.body.data.info.gender, 'female');
    assert.equal(res.body.data.info.ageGroup, 'U21'); assert.equal(res.body.data.info.type, 'club');
    assert.deepEqual(res.body.data.squad, supplied.squad);
    assert.deepEqual(res.body.data.matches, supplied.matches);
    assert.deepEqual(supplied, before);
  }
});

test('a missing scoped profile keeps the existing unavailable response without searching a namesake', async () => {
  const { api, requested } = setup(null), res = await request(api);
  assert.equal(res.statusCode, 404); assert.equal(res.body.success, false);
  assert.deepEqual(requested, [['sportscore', 'requested-club']]);
});

function compatibleProfile() {
  const supplied = profile(); supplied.squad = [];
  Object.assign(supplied.info, { national: false, gender: 'female', ageGroup: 'U21', type: 'club' });
  const candidate = { id: 'ko_t_44', provider: 'kickoffapi', providerId: '44', name: 'Requested Club',
    country: 'Spain', national: false, gender: 'female', ageGroup: 'U21', type: 'club' };
  return { supplied, candidate };
}

test('deep team never borrows a roster or fixtures from a contradictory or unverified secondary cohort', async () => {
  const changes = [
    (s, c) => { c.gender = 'male'; },
    (s, c) => { c.isWomen = false; },
    (s, c) => { c.national = true; },
    (s, c) => { c.ageGroup = 'U19'; },
    (s, c) => { c.category = 'reserves'; },
    (s, c) => { c.isReserve = true; },
    (s, c) => { c.squadType = 'reserves'; },
    (s, c) => { s.info.isReserve = false; c.isReserve = true; },
    (s, c) => { c.type = 'national'; },
    (s, c) => { delete c.gender; },
    (s, c) => { delete c.national; c.type = 'team'; },
    (s, c) => { delete c.ageGroup; },
    (s, c) => { delete s.info.gender; },
    (s, c) => { c.country = 'Mexico'; },
    (s, c) => { c.id = 'sc_t_requested-club'; },
    (s, c) => { c.provider = 'bsd'; },
    (s, c) => { c.providerId = '45'; },
  ];
  for (const change of changes) {
    const { supplied, candidate } = compatibleProfile(); change(supplied, candidate);
    const { api, requested } = setup(supplied, candidate), res = await request(api);
    assert.equal(res.statusCode, 200, change.toString());
    assert.equal(res.body.source, 'sportscore');
    assert.deepEqual(res.body.data.squad, []);
    assert.ok(!requested.some(([source]) => ['kickoff-squad', 'kickoff-fixtures'].includes(source)), change.toString());
  }
});

test('explicit compatible secondary identity may enrich the roster and keeps its own provider IDs', async () => {
  const { supplied, candidate } = compatibleProfile();
  const { api, requested } = setup(supplied, candidate), res = await request(api);
  assert.equal(res.statusCode, 200); assert.equal(res.body.source, 'sportscore+kickoffapi');
  assert.equal(res.body.data.info.id, 'sc_t_requested-club');
  assert.equal(res.body.data.info.gender, 'female'); assert.equal(res.body.data.info.ageGroup, 'U21');
  assert.deepEqual(res.body.data.squad, [{ id: 'ko_p_900', name: 'Secondary Player' }]);
  assert.ok(requested.some(([source, id]) => source === 'kickoff-squad' && id === 'ko_t_44'));
});

async function projectProviderTeams(primaryFields, secondaryFields) {
  const cache = () => {
    const entries = new Map();
    return { getCached: key => entries.get(key), setCache: (key, value) => entries.set(key, value) };
  };
  const loadProvider = (path, mocks, env = {}) => {
    const file = require.resolve(path), module = { exports: {} }, requireFrom = Module.createRequire(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
      require: name => Object.hasOwn(mocks, name) ? mocks[name] : requireFrom(name),
      process: { env }, URLSearchParams, AbortSignal, structuredClone, setTimeout, clearTimeout });
    return module.exports;
  };
  const identity = { name: 'Requested Club', country: 'Spain', national: false, gender: 'male', ageGroup: 'senior' };
  const logger = { info() {}, warn() {}, error() {} };
  const primary = loadProvider('../services/sportscoreService', {
    axios: { get: async () => ({ data: { team: { slug: 'requested-club', ...identity, ...primaryFields }, matches: [] } }) },
    '../utils/logger': logger, './cacheService': cache(),
  });
  const secondary = loadProvider('../services/kickoffApiService', {
    axios: { create: () => ({ get: async () => ({ data: {
      response: [{ team: { id: 44, ...identity, ...secondaryFields } }], errors: [], results: 1,
      paging: { current: 1, total: 1 },
    } }) }) }, '../utils/logger': logger, './cacheService': cache(),
  }, { KICKOFF_API_KEY: 'offline-reserve-projection-test' });
  return { supplied: await primary.getTeamDetails('requested-club'), candidate: await secondary.getTeamDetails('ko_t_44') };
}

test('raw reserve cohort metadata survives both adapters and blocks contradictory or unconfirmed roster joins', async () => {
  for (const [primaryFields, secondaryFields] of [
    [{ isReserve: false }, { isReserve: true }],
    [{ is_reserve: false }, { is_reserve: true }],
    [{ isReserves: false }, { isReserves: true }],
    [{ squadType: 'first team' }, { squadType: 'reserves' }],
    [{ squad_type: 'first team' }, { squad_type: 'reserve team' }],
    [{ isReserve: true }, {}],
    [{}, { isReserve: true }],
    [{ is_reserve: false }, { squadType: 'reserves' }],
    [{ isReserve: true, squadType: 'first' }, { isReserve: true }],
    [{ isReserve: true }, { isReserve: true, squadType: 'first' }],
  ]) {
    const { supplied, candidate } = await projectProviderTeams(primaryFields, secondaryFields);
    const { api, requested } = setup(supplied, candidate), res = await request(api);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, 'sportscore', JSON.stringify([primaryFields, secondaryFields]));
    assert.deepEqual(res.body.data.squad, []);
    assert.ok(!requested.some(([source]) => ['kickoff-squad', 'kickoff-fixtures'].includes(source)));
    for (const [key, value] of Object.entries(primaryFields)) assert.equal(supplied.info[key], value);
    for (const [key, value] of Object.entries(secondaryFields)) assert.equal(candidate[key], value);
  }
});

test('raw compatible first and reserve cohorts may enrich without manufacturing absent reserve flags', async () => {
  for (const [primaryFields, secondaryFields] of [
    [{ isReserve: false }, { isReserve: false }],
    [{ is_reserve: true }, { squad_type: 'reserve team' }],
    [{ squadType: 'first team' }, { isReserves: false }],
  ]) {
    const { supplied, candidate } = await projectProviderTeams(primaryFields, secondaryFields);
    const { api, requested } = setup(supplied, candidate), res = await request(api);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, 'sportscore+kickoffapi');
    assert.equal(res.body.data.info.id, 'sc_t_requested-club');
    assert.equal(res.body.data.squad[0].id, 'ko_p_900');
    assert.ok(requested.some(([source, id]) => source === 'kickoff-squad' && id === 'ko_t_44'));
    for (const [key, value] of Object.entries(primaryFields)) assert.equal(supplied.info[key], value);
    for (const [key, value] of Object.entries(secondaryFields)) assert.equal(candidate[key], value);
  }
  const { supplied, candidate } = await projectProviderTeams({}, {});
  for (const key of ['isReserve', 'is_reserve', 'isReserves', 'squadType', 'squad_type']) {
    assert.equal(Object.hasOwn(supplied.info, key), false);
    assert.equal(Object.hasOwn(candidate, key), false);
  }
});
