'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(file); } finally { Module._load = original; }
}
const logger = { info() {}, warn() {}, error() {} };
const fixture = { id: 1, league_id: 3, home_team_id: 57, home_team: 'Home', away_team_id: 44,
  away_team: 'Away', event_date: '2026-10-01T18:00:00Z', status: 'inprogress', home_score: 0, away_score: 0 };
function service(incidentPayload) {
  const prior = process.env.BSD_API_TOKEN; process.env.BSD_API_TOKEN = 'offline-incident-coverage';
  const cache = new Map();
  try {
    return load('../services/bsdSportsService', {
      axios: { create: () => ({ get: async path => ({ data:
        path === '/api/v2/events/1/' ? fixture : path === '/api/v2/leagues/' ? { count: 0, next: null, results: [] }
          : path.endsWith('/incidents/') ? incidentPayload : null }) }) },
      './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
      '../utils/logger': logger,
    });
  } finally { prior === undefined ? delete process.env.BSD_API_TOKEN : process.env.BSD_API_TOKEN = prior; }
}
const response = () => ({ status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });

test('BSD explicit empty incidents are complete independently of unavailable optional match sections and reach REST', async () => {
  const api = service({ event_id: 1, incidents: [] }), details = await api.getMatchDetails('bsd_1');
  assert.equal(details.coverage.complete, false);
  assert.equal(details.coverage.incidents.available, true);
  assert.equal(details.coverage.incidents.complete, true);
  assert.equal(details.coverage.incidents.matchId, 'bsd_1');
  const controller = load('../controllers/statsController', {
    '../services/bsdSportsService': { getMatchDetails: async () => details },
    '../services/sportscoreService': {}, '../services/kickoffApiService': {}, '../services/sportsDataService': {},
    '../services/teamService': {}, '../utils/logger': logger,
  });
  const res = response(); await controller.getMatchTimeline({ params: { id: 'bsd_1' } }, res);
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.coverage.complete, true);
  assert.equal(res.body.coverage.scope, 'match_incidents');
});

test('missing, malformed, mismatched or partially normalized incidents cannot certify authoritative emptiness', async () => {
  for (const [payload, available] of [
    [{ event_id: 1 }, false], [{ event_id: 1, incidents: {} }, false],
    [{ event_id: 2, incidents: [] }, false], [{ event_id: 1, incidents: [null, {}] }, true],
    [{ event_id: 1, incidents: [{ type: 'goal', event_id: 2 }] }, true],
    [{ event_id: 1, incidents: [{ type: '' }] }, true],
    [{ event_id: 1, incidents: [], complete: false }, true],
  ]) {
    const details = await service(payload).getMatchDetails('bsd_1');
    assert.deepEqual(details.timeline, []);
    assert.equal(details.coverage.incidents.available, available);
    assert.equal(details.coverage.incidents.complete, false);
  }
});

test('verified alias REST timeline coverage retains the public ID and exact canonical incident owner', async () => {
  const controller = load('../controllers/statsController', {
    '../services/bsdSportsService': {},
    '../services/verifiedMatchDetailsService': { getVerifiedBsdDetails: async () => ({
      matchInfo: { id: 'legacy-match' }, timeline: [],
      coverage: { fields: { incidents: true }, incidents: { available: true, complete: true, scope: 'match_incidents', matchId: 'bsd_1' } },
    }) },
    '../services/sportscoreService': { getMatchDetails: async () => ({ id: 'legacy-match' }) },
    '../services/kickoffApiService': {}, '../services/sportsDataService': {},
    '../services/teamService': {}, '../utils/logger': logger,
  });
  const res = response(); await controller.getMatchTimeline({ params: { id: 'legacy-match' } }, res);
  assert.equal(res.body.coverage.matchId, 'legacy-match');
  assert.equal(res.body.coverage.canonicalMatchId, 'bsd_1');
  assert.equal(res.body.coverage.complete, true);
});

test('a partial incident feed retains reported rows and the direct and detail readers share its coverage', async () => {
  const api = service({ event_id: 1, incidents: [{ type: 'goal', id: 3, minute: 9, rescinded: true }, null] });
  const details = await api.getMatchDetails('bsd_1'), rows = await api.getMatchTimeline('bsd_1');
  assert.equal(details.timeline.length, 1); assert.equal(details.timeline[0].rescinded, true);
  assert.equal(details.coverage.incidents.available, true);
  assert.equal(details.coverage.incidents.complete, false);
  assert.equal(details.coverage.incidents.invalidRows, 1);
  assert.deepEqual(rows.coverage, details.coverage.incidents);
});
