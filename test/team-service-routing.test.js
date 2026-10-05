const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(file); } finally { Module._load = original; }
}

function teams(bsd) {
  return load('../services/teamService', {
    './bsdSportsService': bsd,
    './sportscoreService': { getTeamDetails: async () => assert.fail('A BSD fixture request cannot query a different provider') },
    './kickoffApiService': { getTeamFixtures: async () => assert.fail('A BSD fixture request cannot query a different provider') },
    './searchService': { CLUBS: {} },
  });
}

test('BSD club fixtures remain available independently of biography and squad feeds', async () => {
  const coverage = { source: 'bsd', available: true, complete: true, partial: false };
  const fixtures = [
    { id: 'bsd_3', status: 'TIMED', utcDate: '2099-10-01T18:00:00Z' },
    { id: 'bsd_1', status: 'FINISHED', utcDate: '2026-09-01T18:00:00Z' },
    { id: 'bsd_2', status: 'FINISHED', utcDate: '2026-09-02T18:00:00Z' },
    { id: 'bsd_4', status: 'IN_PLAY', utcDate: '2026-10-05T18:00:00Z' },
    { id: 'bsd_5', status: 'TIMED', utcDate: '2026-09-01T18:00:00Z' },
  ];
  Object.defineProperty(fixtures, 'coverage', { value: coverage });
  const api = teams({ getTeamDetails: async () => assert.fail('Roster or biography must not block the calendar'),
    getTeamFixtures: async id => { assert.equal(id, 'bsd_t_44'); return fixtures; } });
  const result = await api.getTeamMatchesService(' bsd_t_44 ');
  assert.equal(result.success, true);
  assert.equal(result.source, 'bsd');
  assert.equal(result.coverage, coverage);
  assert.deepEqual(result.data.recent.map(row => row.id), ['bsd_2', 'bsd_1']);
  assert.deepEqual(result.data.upcoming.map(row => row.id), ['bsd_3']);
  assert.deepEqual(result.data.live.map(row => row.id), ['bsd_4']);
});

test('BSD empty valid calendars and unavailable calendars remain distinguishable', async () => {
  let available = true;
  const fixtures = [];
  Object.defineProperty(fixtures, 'coverage', { value: { source: 'bsd', available: true, complete: true, partial: false } });
  const api = teams({ getTeamFixtures: async () => available ? fixtures : null });
  const empty = await api.getTeamMatchesService('bsd_t_44');
  assert.equal(empty.success, true);
  assert.equal(empty.coverage.complete, true);
  available = false;
  const unavailable = await api.getTeamMatchesService('bsd_t_44');
  assert.equal(unavailable.success, false);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.coverage.available, false);
  assert.deepEqual(unavailable.data, { recent: [], upcoming: [], live: [] });
});

function players(standings, squad) {
  return load('../services/playerService', {
    './sportsDataService': { getSupportedCompetitions: () => [{ code: 'PL' }], getStandings: async () => standings },
    './teamService': { getTeamSquadService: squad },
    '../utils/logger': { warn() {}, error() {} },
  });
}

test('league player sync recovers explicit raw provider IDs but skips names-only standings rows', async () => {
  const requested = [];
  const api = players({ success: true, source: 'bsd', data: [
    { id: 'row-1', team: { name: 'Barcelona', provider: 'sportscore' } },
    { id: '81', name: 'Unidentified standing row' },
    { id: 'row-2', team: { providerId: '529', provider: 'kickoffapi', name: 'FC Barcelona' } },
    { id: 'row-3', team: { id: 'bsd_t_44', name: 'Aruba' } },
    { id: 'row-4', team: { providerId: 'barcelona-chile', provider: 'sportscore', name: 'Barcelona' } },
  ] }, async id => {
    requested.push(id);
    return { success: true, source: 'provider', data: [{ id: 'player:' + id, name: 'Actual Player' }] };
  });
  const result = await api.fetchPlayersFromAPI({ league: 'PL' });
  assert.deepEqual(requested, ['ko_t_529', 'bsd_t_44', 'sc_t_barcelona-chile']);
  assert.deepEqual(result.map(player => player.teamId), requested);
  assert.deepEqual(result.map(player => player.team), ['FC Barcelona', 'Aruba', 'Barcelona']);
});

test('league player sync cannot save a failed or unavailable provider roster', async () => {
  const api = players({ success: true, source: 'bsd', data: [
    { team: { id: 'bsd_t_44', name: 'Club A' } }, { team: { id: 'bsd_t_45', name: 'Club B' } },
  ] }, async id => ({ success: id === 'bsd_t_45', coverage: { available: false },
    data: [{ id: 'bsd_p_100', name: 'Unverified Player' }] }));
  assert.deepEqual(await api.fetchPlayersFromAPI({ league: 'PL' }), []);
});
