'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { compactMatchStatsCases } = require('./fixtures/compactMatchStatsCases');

const logger = { info() {}, warn() {}, error() {} };
const clone = value => structuredClone(value);
const removedTop = ['timeline', 'providerStatistics', 'lineups', 'playerStatistics'];
const removedInfo = ['timeline', 'providerStatistics', 'lineups', 'head2head'];
const malformedFormats = ['stats-v2', 'STATS-V1', ' stats-v1', 'stats-v1 ', ['stats-v1'], { value: 'stats-v1' }, null];

function load(file, mocks) {
  const filename = require.resolve(file);
  delete require.cache[filename];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(filename); } finally { Module._load = original; }
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}

function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; },
    json(body) { this.body = body; return this; } };
}

async function request(controller, id, format, includeQuery = true) {
  const res = response();
  const req = { params: { id } };
  if (includeQuery) req.query = format === undefined ? {} : { format };
  await controller.getMatchDeepStats(req, res);
  return res;
}

function expectedCompact(full) {
  const result = clone(full);
  for (const key of removedTop) delete result.data[key];
  for (const key of removedInfo) delete result.data.matchInfo[key];
  return result;
}

function bsdDetails(alias = false) {
  const cases = compactMatchStatsCases();
  const rich = cases[0].full;
  const info = clone(alias ? cases[1].full.matchInfo : rich.matchInfo);
  const incidents = [
    { ...clone(rich.goals[0]), type: 'goal', label: 'Penalty Goal', goalType: 'penalty', rescinded: true },
    { id: 'card-1', type: 'yellow_card', minute: 15, side: 'away', player: 'Booked',
      playerId: 'bsd_p_10', playerImage: 'https://example.test/booked.png', source: 'bsd' },
    { id: 'sub-1', type: 'substitution', minute: 20, side: 'home', player: 'Incoming',
      playerId: 'bsd_p_9', playerOut: 'Outgoing', playerOutId: 'bsd_p_7',
      playerImage: 'https://example.test/incoming.png', playerOutImage: 'https://example.test/outgoing.png' },
  ];
  const statistics = [
    { label: 'Ball Possession', home: 60, away: 40 },
    { label: 'Total Shots', home: 3, away: 0 },
    { label: 'Expected Goals', home: 0.8, away: null, homeEstimated: true, awayEstimated: false },
  ];
  info.timeline = incidents;
  info.providerStatistics = statistics;
  info.xg = { home: 0.8, away: null, homeEstimated: true, awayEstimated: false };
  return { matchInfo: info, timeline: incidents, statistics,
    lineups: clone(rich.lineups), playerStatistics: clone(rich.playerStatistics),
    head2head: clone(rich.head2head), venue: { name: 'Example Stadium', capacity: 0 },
    shotmap: clone(rich.shotMap), pressure: clone(rich.pressure), momentum: clone(rich.momentum),
    averagePositions: clone(rich.averagePositions), tracker: { available: true },
    aiPreview: { text: 'Synthetic preview', prediction: true },
    availability: { stats: true, incidents: true, lineups: true },
    coverage: { available: true, complete: false, partial: true, matchId: info.id,
      incidents: { available: true, complete: true, scope: 'match_incidents' } },
    homeCoach: { id: 'bsd_c_1' }, awayCoach: null };
}

function fixtureHarness(branch) {
  const details = bsdDetails(branch === 'recovered');
  const sc = clone(compactMatchStatsCases()[2].initialMatch);
  sc.timeline = clone(details.timeline);
  sc.providerStatistics = clone(details.statistics);
  sc.lineups = clone(details.lineups);
  sc.head2head = { numberOfMatches: 0, matches: [] };
  sc.venue = 'SportScore Stadium';
  const ko = { ...clone(sc), id: 'ko_42', provider: 'kickoffapi', source: 'kickoffapi',
    homeTeam: { id: 'ko_t_1', name: 'Home', provider: 'kickoffapi' },
    awayTeam: { id: 'ko_t_2', name: 'Away', provider: 'kickoffapi' },
    timeline: [], providerStatistics: [], lineups: null };
  const inputs = freeze({ details, sc, ko, prediction: { mostLikelyScore: '1-0', confidence: 72 } });
  const calls = [];
  const api = load('../controllers/statsController', {
    '../services/bsdSportsService': {
      getMatchDetails: async (...args) => { calls.push(['bsdDetails', ...args]); return inputs.details; },
      getPredictionForMatch: async (...args) => { calls.push(['prediction', ...args]); return inputs.prediction; },
    },
    '../services/sportscoreService': {
      getMatchDetails: async (...args) => { calls.push(['scDetails', ...args]); return inputs.sc; },
    },
    '../services/kickoffApiService': {
      getMatchDetails: async (...args) => { calls.push(['koDetails', ...args]); return inputs.ko; },
    },
    '../services/verifiedMatchDetailsService': {
      getVerifiedBsdDetails: async match => { calls.push(['verified', match.id]); return branch === 'recovered' ? inputs.details : null; },
    },
    '../services/sportsDataService': {}, '../services/teamService': {},
    '../services/cacheService': { getCached: () => null, setCache() {} }, '../utils/logger': logger,
  });
  const id = branch === 'bsd' ? 'bsd_42' : branch === 'kickoffapi' ? 'ko_42' : sc.id;
  return { api, id, calls, inputs };
}

for (const branch of ['bsd', 'recovered', 'sportscore', 'kickoffapi']) {
  test(`${branch} deep route negotiates only unused copies without changing provider work or cached data`, async () => {
    const { api, id, calls, inputs } = fixtureHarness(branch);
    const saved = clone(inputs);
    const full = await request(api, id, undefined, false);
    assert.equal(full.statusCode, 200);
    assert.equal(full.body.success, true);
    const legacy = clone(full.body);
    const originalCalls = clone(calls);
    calls.length = 0;
    const compact = await request(api, id, 'stats-v1');
    assert.equal(compact.statusCode, 200);
    assert.deepEqual(compact.body, expectedCompact(legacy));
    assert.deepEqual(calls, originalCalls, 'Negotiation must not add, broaden or suppress provider requests');
    assert.deepEqual(inputs, saved, 'Provider/cache-owned input must remain unchanged');
    for (const key of removedTop) assert.equal(Object.hasOwn(compact.body.data, key), false, key);
    for (const key of removedInfo) assert.equal(Object.hasOwn(compact.body.data.matchInfo, key), false, key);
    for (const key of ['homeTeam', 'awayTeam', 'providerIdentities', 'canonicalMatchId', 'utcDate', 'competition', 'source', 'provider']) {
      assert.deepEqual(compact.body.data.matchInfo[key], legacy.data.matchInfo[key], key);
    }
    for (const key of ['statistics', 'goals', 'bookings', 'substitutions', 'head2head', 'coverage', 'shotMap',
      'pressure', 'momentum', 'averagePositions', 'prediction', 'aiPreview', 'venue', 'venueInfo', 'coaches', 'availability']) {
      assert.deepEqual(compact.body.data[key], legacy.data[key], key);
    }
    assert.equal(compact.body.data.statistics.team1.totalShots, branch === 'kickoffapi' ? null : 3);
    assert.equal(compact.body.data.statistics.team2.totalShots, branch === 'kickoffapi' ? null : 0);
    if (branch !== 'kickoffapi') {
      const goal = compact.body.data.goals[0];
      assert.equal(goal.playerImage, 'https://example.test/7.png');
      assert.equal(goal.assistImage, 'https://example.test/8.png');
      assert.equal(goal.goalType, 'penalty');
      assert.equal(goal.rescinded, true);
      assert.equal(compact.body.data.substitutions[0].playerOutImage, 'https://example.test/outgoing.png');
    }
    if (branch === 'recovered') {
      assert.equal(compact.body.source, 'bsd');
      assert.equal(compact.body.data.matchInfo.id, id);
      assert.equal(compact.body.data.matchInfo.canonicalMatchId, 'bsd_42');
      assert.equal(compact.body.data.matchInfo.providerIdentities.length, 2);
    }
    calls.length = 0;
    const reopened = await request(api, id);
    assert.deepEqual(reopened.body, legacy, 'A compact read must not strip the next legacy response');
    assert.deepEqual(full.body, legacy, 'A compact read must not mutate an earlier response');
    assert.deepEqual(calls, originalCalls);
    for (const format of malformedFormats) {
      calls.length = 0;
      const unknown = await request(api, id, format);
      assert.deepEqual(unknown.body, legacy, `Only the exact string stats-v1 may opt in: ${JSON.stringify(format)}`);
      assert.deepEqual(calls, originalCalls);
    }
    assert.deepEqual(inputs, saved);
  });
}

test('compact format does not make absent or invalid BSD routes successful or trigger fallback providers', async () => {
  const calls = [];
  const api = load('../controllers/statsController', {
    '../services/bsdSportsService': { getMatchDetails: async id => { calls.push(id); return null; } },
    '../services/sportscoreService': { getMatchDetails: async () => assert.fail('BSD must not query SportScore') },
    '../services/kickoffApiService': { getMatchDetails: async () => assert.fail('BSD must not query KickOff') },
    '../services/verifiedMatchDetailsService': {}, '../services/sportsDataService': {}, '../services/teamService': {},
    '../services/cacheService': {}, '../utils/logger': logger,
  });
  for (const id of ['bsd_42', 'bsd_0', 'bsd_invalid']) {
    for (const format of [undefined, 'stats-v1', 'stats-v2']) {
      const res = await request(api, id, format);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { success: false, message: 'Match details not found' });
    }
  }
  assert.deepEqual(calls, ['bsd_42', 'bsd_42', 'bsd_42']);
});

test('projection retains a foreign native fixture identity so clients can reject it', async () => {
  const id = 'bsd_42';
  const details = bsdDetails();
  // The provider-specific controller historically trusts its provider adapter.
  // Negotiation must not rewrite an invalid returned ID into the requested one.
  const foreign = { ...clone(details), matchInfo: { ...clone(details.matchInfo), id: 'bsd_43' } };
  const foreignApi = load('../controllers/statsController', {
    '../services/bsdSportsService': { getMatchDetails: async () => foreign, getPredictionForMatch: async () => null },
    '../services/sportscoreService': {}, '../services/kickoffApiService': {},
    '../services/verifiedMatchDetailsService': {}, '../services/sportsDataService': {}, '../services/teamService': {},
    '../services/cacheService': {}, '../utils/logger': logger,
  });
  const full = await request(foreignApi, id);
  const compact = await request(foreignApi, id, 'stats-v1');
  assert.equal(compact.body.data.matchInfo.id, 'bsd_43');
  assert.notEqual(compact.body.data.matchInfo.id, id);
  assert.deepEqual(compact.body, expectedCompact(full.body));
});

test('compact negotiation cannot bless a foreign detail rejected by the real verified BSD bridge', async () => {
  const native = { id: 'bsd_213588', provider: 'bsd', source: 'bsd', status: 'FINISHED',
    utcDate: '2026-09-20T19:00:00Z', competition: { code: 'PD', country: 'Spain' },
    homeTeam: { id: 'bsd_t_47', provider: 'bsd', name: 'Valencia' },
    awayTeam: { id: 'bsd_t_48', provider: 'bsd', name: 'Real Sociedad' },
    score: { fullTime: { home: 2, away: 3 } } };
  const sc = { ...clone(native), id: 'valencia-old-route', provider: 'sportscore', source: 'sportscore',
    homeTeam: { id: 'sc_t_valencia-cf', provider: 'sportscore', name: 'Valencia CF' },
    awayTeam: { id: 'sc_t_real-sociedad', provider: 'sportscore', name: 'Real Sociedad' },
    providerStatistics: [{ label: 'Total Shots', home: 12, away: 8 }], timeline: [], lineups: null };
  const calls = [], cache = new Map();
  const rows = Object.defineProperty([native], 'coverage', { value: { complete: true } });
  const bridge = load('../services/verifiedMatchDetailsService', {
    './bsdSportsService': { isConfigured: () => true,
      getMatches: async (...args) => { calls.push(['matches', ...args]); return rows; },
      getMatchDetails: async id => { calls.push(['details', id]); return { matchInfo: { ...native, id: 'bsd_999' },
        statistics: [{ label: 'Total Shots', home: 99, away: 99 }] }; } },
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
  });
  const api = load('../controllers/statsController', {
    '../services/bsdSportsService': {}, '../services/sportscoreService': { getMatchDetails: async () => sc },
    '../services/kickoffApiService': {}, '../services/verifiedMatchDetailsService': bridge,
    '../services/sportsDataService': {}, '../services/teamService': {}, '../services/cacheService': {}, '../utils/logger': logger,
  });
  const full = await request(api, sc.id);
  const compact = await request(api, sc.id, 'stats-v1');
  const after = await request(api, sc.id);
  for (const res of [full, compact, after]) {
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, 'sportscore');
    assert.equal(res.body.data.matchInfo.id, sc.id);
    assert.equal(res.body.data.matchInfo.homeTeam.id, 'sc_t_valencia-cf');
    assert.equal(res.body.data.statistics.team1.totalShots, 12);
    assert.equal(res.body.data.matchInfo.canonicalMatchId, undefined);
  }
  assert.deepEqual(compact.body, expectedCompact(full.body));
  assert.deepEqual(after.body, full.body);
  assert.deepEqual(calls.filter(row => row[0] === 'details'), [
    ['details', native.id], ['details', native.id], ['details', native.id],
  ]);
  assert.deepEqual(calls.filter(row => row[0] === 'matches'), [
    ['matches', { date: '2026-09-20', competition: 'PD', limit: 200 }, { maxPages: 1, maxRows: 200, timeoutMs: 3500 }],
  ]);
});
