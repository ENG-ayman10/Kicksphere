'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const vm = require('node:vm');

function load(file, mocks = {}) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(file); } finally { Module._load = original; }
}
const logger = { info() {}, warn() {}, error() {} };
const cache = () => {
  const rows = new Map();
  return { getCached: key => rows.get(key), setCache: (key, value) => rows.set(key, value) };
};
const primaryInfo = () => ({ id: 'real-madrid', name: 'Real Madrid', country: 'Spain',
  is_national: false, is_women: false, category: 'senior' });
const secondaryInfo = () => ({ id: 'ko_t_541', providerId: '541', provider: 'kickoffapi',
  name: 'Real Madrid', country: 'Spain', national: false, gender: 'male', category: 'senior' });
function roster(changes = {}) {
  const rows = [{ id: 'ko_p_1', provider: 'kickoffapi', name: 'Actual Player' }];
  Object.defineProperty(rows, 'coverage', { value: { source: 'kickoffapi', teamId: 'ko_t_541',
    scope: 'team_roster', available: true, complete: true, partial: false, ...changes }, configurable: true });
  return rows;
}
function setup(options = {}) {
  const calls = [], squad = options.squad || roster();
  const profile = options.profile || { info: primaryInfo(), matches: { recent: [], upcoming: [] } };
  const api = load('../services/teamService', {
    './searchService': { CLUBS: {} }, './bsdSportsService': {},
    './sportscoreService': { getTeamDetails: async id => { calls.push(['sportscore', id]); return profile; } },
    './kickoffApiService': {
      getTeamDetails: async name => { calls.push(['lookup', name]); if (options.error) throw new Error('Offline failure'); return options.candidate || secondaryInfo(); },
      getTeamSquad: async id => { calls.push(['roster', id]); return squad; },
    },
  });
  return { api, calls, squad, profile };
}

test('scoped SportScore squad recovers through verified name/country/categories and exact secondary roster owner', async () => {
  const { api, calls, squad } = setup();
  const result = await api.getTeamSquadService(' sc_t_real-madrid ');
  assert.deepEqual(calls, [['sportscore', 'real-madrid'], ['lookup', 'Real Madrid'], ['roster', 'ko_t_541']]);
  assert.equal(result.source, 'kickoffapi');
  assert.strictEqual(result.data, squad);
  assert.equal(result.data[0].id, 'ko_p_1');
  assert.equal(result.data[0].provider, 'kickoffapi');
  assert.equal(result.targetTeamId, 'sc_t_real-madrid');
  assert.equal(result.squadContext.teamId, 'sc_t_real-madrid');
  assert.equal(result.squadContext.sourceTeamId, 'ko_t_541');
  assert.equal(result.coverage.teamId, 'ko_t_541');
  assert.equal(result.coverage.targetTeamId, 'sc_t_real-madrid');
  assert.equal(result.coverage.identityVerified, true);
});

test('populated primary squad avoids secondary lookups and a verified empty primary squad may recover', async () => {
  const squad = [{ id: 'primary-player', provider: 'sportscore' }];
  const first = setup({ profile: { info: primaryInfo(), squad } });
  assert.strictEqual((await first.api.getTeamSquadService('sc_t_real-madrid')).data, squad);
  assert.deepEqual(first.calls, [['sportscore', 'real-madrid']]);
  const second = setup({ profile: { info: primaryInfo(), squad: [] } });
  assert.equal((await second.api.getTeamSquadService('sc_t_real-madrid')).source, 'kickoffapi');
});

test('confirmed national women youth category can recover without becoming a senior club roster', async () => {
  const info = { ...primaryInfo(), type: 'national_team', is_national: true, is_women: true, category: 'U19' };
  const candidate = { ...secondaryInfo(), national: true, gender: 'female', category: 'u19' };
  const { api } = setup({ profile: { info }, candidate });
  const result = await api.getTeamSquadService('sc_t_real-madrid');
  assert.equal(result.source, 'kickoffapi');
  assert.equal(result.squadContext.teamId, 'sc_t_real-madrid');
  assert.equal(result.squadContext.sourceTeamId, 'ko_t_541');
});

test('missing/foreign primary identities and unknown national status cannot trigger namesake recovery', async () => {
  for (const info of [null, { ...primaryInfo(), id: 'unrelated-club' },
    { ...primaryInfo(), is_national: undefined }, { ...primaryInfo(), is_national: false, national: true }]) {
    const { api, calls } = setup({ profile: { info } });
    const result = await api.getTeamSquadService('sc_t_real-madrid');
    assert.deepEqual(result.data, []);
    assert.equal(result.coverage.available, false);
    assert.deepEqual(calls, [['sportscore', 'real-madrid']]);
  }
});

test('country, name, club/national, gender and age-category conflicts or unknown counterparts block roster requests', async () => {
  const variations = [
    { name: 'Real Madrid U19' }, { country: 'Chile' }, { country: '' }, { national: true },
    { national: undefined }, { gender: 'female' }, { gender: undefined }, { category: 'u19' },
    { category: undefined }, { national: false, is_national: true }, { gender: 'male', isWomen: true },
  ];
  for (const variation of variations) {
    const { api, calls } = setup({ candidate: { ...secondaryInfo(), ...variation } });
    const result = await api.getTeamSquadService('sc_t_real-madrid');
    assert.deepEqual(result.data, [], JSON.stringify(variation));
    assert.ok(!calls.some(([kind]) => kind === 'roster'), JSON.stringify(variation));
  }
  const missingGender = setup({ profile: { info: { ...primaryInfo(), is_women: undefined } },
    candidate: { ...secondaryInfo(), gender: undefined } });
  assert.deepEqual((await missingGender.api.getTeamSquadService('sc_t_real-madrid')).data, []);
  assert.ok(!missingGender.calls.some(([kind]) => kind === 'roster'));
});

test('the secondary scoped identity and provider descriptor must agree before its roster is requested', async () => {
  for (const variation of [{ id: '541' }, { id: 'bsd_t_541' }, { provider: 'bsd' }, { providerId: '529' }]) {
    const { api, calls } = setup({ candidate: { ...secondaryInfo(), ...variation } });
    assert.deepEqual((await api.getTeamSquadService('sc_t_real-madrid')).data, []);
    assert.ok(!calls.some(([kind]) => kind === 'roster'));
  }
});

test('unavailable, wrong-team and missing-owner roster coverage cannot claim a verified recovery', async () => {
  for (const changes of [{ available: false }, { teamId: 'ko_t_529' }, { teamId: undefined }, { source: 'sportscore' }]) {
    const { api } = setup({ squad: roster(changes) });
    const result = await api.getTeamSquadService('sc_t_real-madrid');
    assert.deepEqual(result.data, []);
    assert.equal(result.coverage.available, false);
  }
});

test('foreign player/provider identities cannot enter the recovered squad and unavailable supplement preserves primary empty coverage', async () => {
  for (const changes of [{ id: 'bsd_p_1' }, { provider: 'bsd' }, { teamId: 'ko_t_529' },
    { source: 'bsd' }, { player: { id: 'ko_p_2' } }]) {
    const squad = roster(); Object.assign(squad[0], changes);
    assert.deepEqual((await setup({ squad }).api.getTeamSquadService('sc_t_real-madrid')).data, []);
  }
  const profile = { info: primaryInfo(), squad: [], coverage: { squad: { available: true, complete: false, reason: 'empty_squad' } } };
  const result = await setup({ profile, error: true }).api.getTeamSquadService('sc_t_real-madrid');
  assert.equal(result.source, 'sportscore');
  assert.strictEqual(result.data, profile.squad);
  assert.equal(result.coverage.reason, 'empty_squad');
});

test('SportScore team projection retains only explicit category fields without manufacturing missing flags', async () => {
  for (const fields of [{ is_national: false, is_women: false, gender: 'male', category: 'senior' }, {}]) {
    const api = load('../services/sportscoreService', {
      axios: { get: async () => ({ data: { team: { slug: 'real-madrid', name: 'Real Madrid', country: 'Spain', ...fields }, matches: [] } }) },
      '../utils/logger': logger, './cacheService': cache(),
    });
    const result = await api.getTeamDetails('real-madrid');
    for (const key of ['is_national', 'is_women', 'gender', 'category']) {
      assert.equal(result.info[key], fields[key]);
      assert.equal(Object.hasOwn(result.info, key), Object.hasOwn(fields, key));
    }
  }
});

test('KickOff team projection retains explicit false/category values and does not infer absent metadata', async () => {
  for (const fields of [{ national: false, is_women: false, gender: 'male', category: 'senior' }, {}]) {
    const file = require.resolve('../services/kickoffApiService'), module = { exports: {} };
    const mocks = { axios: { create: () => ({ get: async () => ({ data: {
      response: [{ team: { id: 541, name: 'Real Madrid', country: 'Spain', ...fields } }], errors: [], results: 1,
      paging: { current: 1, total: 1 },
    } }) }) }, '../utils/logger': logger, './cacheService': cache() };
    const requireFrom = Module.createRequire(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
      require: name => Object.hasOwn(mocks, name) ? mocks[name] : requireFrom(name),
      process: { env: { KICKOFF_API_KEY: 'unit-test-only' } }, URLSearchParams, AbortSignal, structuredClone, setTimeout, clearTimeout });
    const result = await module.exports.getTeamDetails('ko_t_541');
    for (const key of ['national', 'is_women', 'gender', 'category']) {
      assert.equal(result[key], fields[key]);
      assert.equal(Object.hasOwn(result, key), Object.hasOwn(fields, key));
    }
  }
});
