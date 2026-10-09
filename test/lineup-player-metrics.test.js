'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { enrichLineupMetrics, playerFacts } = require('../utils/lineupPlayerMetrics');
const logger = { info() {}, warn() {}, error() {} };
function load(file, stubs = {}) {
  const resolved = require.resolve(file); delete require.cache[resolved];
  const original = Module._load;
  Module._load = function(name, parent, isMain) { return Object.hasOwn(stubs, name) ? stubs[name] : original.call(this, name, parent, isMain); };
  try { return require(resolved); } finally { Module._load = original; }
}
function bsd(handler) {
  const previous = process.env.BSD_API_TOKEN; process.env.BSD_API_TOKEN = 'test-token';
  const requests = [], cache = new Map();
  const service = load('../services/bsdSportsService', {
    axios: { create: () => ({ get: async (path, options) => {
      requests.push({ path, params: options.params }); return { data: await handler(path, options.params) };
    } }) }, './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
    '../utils/logger': logger,
  });
  if (previous === undefined) delete process.env.BSD_API_TOKEN; else process.env.BSD_API_TOKEN = previous;
  return { service, requests };
}
function roster(rows, coverage = {}) {
  Object.defineProperty(rows, 'coverage', { value: { teamId: 'bsd_t_44', scope: 'team_roster', available: true,
    complete: true, reportedTotal: rows.length, ...coverage } }); return rows;
}
const xi = () => ({ homeTeamId: 'bsd_t_44', awayTeamId: 'bsd_t_57', homeFormation: '4-4-2',
  home: [{ id: 'bsd_p_1', name: 'Starter', number: 7, grid: '2:1', position: 'D', rating: 7.1,
    player: { id: 'bsd_p_1', name: 'Starter', number: 7 } }],
  homeBench: [{ id: 'bsd_p_2', name: 'Reserve', number: 10 }], away: [], awayBench: [] });

test('market values cover the complete exact roster including bench and players outside the match; tactical evidence is unchanged', () => {
  const before = xi(), clone = structuredClone(before);
  const squad = roster([
    { id: 'bsd_p_1', provider: 'bsd', name: 'Starter', number: 99, position: 'F', grid: '4:1', rating: 92,
      dateOfBirth: '2000-01-01', height: 180, heightUnit: 'cm', nationality: 'France', marketValue: 5000000, marketValueCurrency: 'EUR' },
    { id: 'bsd_p_2', provider: 'bsd', marketValue: 3000000, marketValueCurrency: 'EUR' },
    { id: 'bsd_p_3', provider: 'bsd', marketValue: 2000000, marketValueCurrency: 'EUR' },
  ]);
  const result = enrichLineupMetrics(before, { home: squad }, { home: 'bsd_t_44', away: 'bsd_t_57' }, 'bsd');
  assert.deepEqual(before, clone);
  assert.equal(result.home[0].number, 7); assert.equal(result.home[0].position, 'D');
  assert.equal(result.home[0].grid, '2:1'); assert.equal(result.home[0].rating, 7.1);
  assert.deepEqual(result.home[0].player, before.home[0].player);
  assert.equal(result.home[0].marketValue, 5000000); assert.equal(result.homeBench[0].marketValue, 3000000);
  assert.equal(result.home[0].height, 180); assert.equal(result.home[0].nationality, 'France');
  assert.equal(result.squadValuation.home.totalEUR, 10000000);
  assert.equal(result.squadValuation.home.scope, 'team_roster'); assert.equal(result.squadValuation.home.totalPlayers, 3);
  assert.equal(result.squadValuation.home.complete, true); assert.equal(result.squadCoverage.home.temporalScope, 'current');
});

test('missing and non-EUR values stay unknown, explicit zero remains a known value', () => {
  const squad = roster([
    { id: 'bsd_p_1', marketValue: 0, marketValueCurrency: 'EUR' },
    { id: 'bsd_p_2', marketValue: null, marketValueCurrency: 'EUR' },
    { id: 'bsd_p_3', marketValue: 5000000, marketValueCurrency: 'USD' },
  ]);
  const result = enrichLineupMetrics(xi(), { home: squad }, { home: 'bsd_t_44' }, 'bsd');
  assert.equal(result.squadValuation.home.totalEUR, 0); assert.equal(result.squadValuation.home.knownPlayers, 1);
  assert.equal(result.squadValuation.home.missingPlayers, 2); assert.equal(result.squadValuation.home.complete, false);
  const none = enrichLineupMetrics(xi(), { home: roster([{ id: 'bsd_p_1', marketValue: null }]) }, { home: 'bsd_t_44' }, 'bsd');
  assert.equal(none.squadValuation.home.totalEUR, null);
});

test('wrong owners, conflicting nested IDs, duplicate and foreign provider rows cannot claim complete total or contaminate the XI', () => {
  for (const bad of [
    roster([{ id: 'bsd_p_1', marketValue: 999, marketValueCurrency: 'EUR' }], { teamId: 'bsd_t_57' }),
    roster([{ id: 'bsd_p_1', player: { id: 'bsd_p_2' }, marketValue: 999, marketValueCurrency: 'EUR' }]),
    roster([{ id: 'ko_p_1', provider: 'kickoffapi', marketValue: 999, marketValueCurrency: 'EUR' }]),
    roster([{ id: 'bsd_p_1', rosterTeamId: 'bsd_t_57', marketValue: 999, marketValueCurrency: 'EUR' }]),
  ]) {
    const result = enrichLineupMetrics(xi(), { home: bad }, { home: 'bsd_t_44' }, 'bsd');
    assert.equal(result.home[0].marketValue, undefined); assert.equal(result.squadCoverage.home.complete, false);
    assert.equal(result.squadValuation.home.scope, 'match_squad'); assert.equal(result.squadValuation.home.totalEUR, null);
  }
  const dup = roster([{ id: 'bsd_p_1', marketValue: 100, marketValueCurrency: 'EUR' },
    { id: 'bsd_p_1', marketValue: 100, marketValueCurrency: 'EUR' }]);
  const result = enrichLineupMetrics(xi(), { home: dup }, { home: 'bsd_t_44' }, 'bsd');
  assert.equal(result.squadCoverage.home.complete, false); assert.equal(result.squadValuation.home.totalEUR, 100);
});

test('metric normalization validates dates and explicit height/currency units without inventing values', () => {
  const valid = playerFacts({ birth: { date: '2000-01-01' }, nationality: 'Norway', height: '195 cm', market_value_eur: 0 });
  assert.equal(valid.dateOfBirth, '2000-01-01'); assert.equal(valid.height, 195);
  assert.equal(valid.marketValue, 0); assert.equal(valid.marketValueCurrency, 'EUR');
  const bad = playerFacts({ date_of_birth: '2000-02-30', age: 101, height: 1.95, marketValue: 2000000 });
  assert.equal(bad.dateOfBirth, null); assert.equal(bad.age, null); assert.equal(bad.height, null); assert.equal(bad.marketValue, null);
  assert.equal(playerFacts({ height_cm: 195, marketValue: 2000000, marketValueCurrency: 'EUR' }).marketValue, 2000000);
});

test('BSD full roster profile retrieval is one cached and coalesced batched request, not per-player profile reads', async () => {
  const profiles = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, name: 'Player ' + (index + 1),
    current_team_id: 44, nationality: 'Spain', date_of_birth: '2000-01-01', height_cm: 180,
    market_value_eur: index === 0 ? 0 : 1000000 }));
  const { service, requests } = bsd((path, params) => {
    assert.equal(path, '/api/v2/players/'); assert.deepEqual(params, { limit: 200, team_id: 44 });
    return { count: 30, next: null, results: profiles };
  });
  const [a, b] = await Promise.all([service.getTeamLineupSquad('bsd_t_44'), service.getTeamLineupSquad('bsd_t_44')]);
  const c = await service.getTeamLineupSquad('bsd_t_44');
  assert.equal(requests.length, 1); assert.equal(a.length, 30); assert.deepEqual(a, b); assert.deepEqual(a, c);
  assert.equal(a.coverage.complete, true); assert.equal(a[0].marketValue, 0);
  assert.equal(a[0].heightUnit, 'cm'); assert.equal(a[0].rosterTeamId, 'bsd_t_44');
  assert.equal(a.coverage.scope, 'team_roster'); assert.equal(a.coverage.teamId, 'bsd_t_44');
});

test('national team enrichment uses explicit national membership while retaining each player club identity separately', async () => {
  const { service, requests } = bsd((path, params) => params.team_id
    ? { count: 0, next: null, results: [] }
    : { count: 2, next: null, results: [{ id: 852, name: 'Haaland', current_team_id: 12, national_team_id: 488, market_value_eur: 240000000 },
      { id: 774, name: 'Sorloth', current_team_id: 54, national_team_id: 488, market_value_eur: 18600000 }] });
  const rows = await service.getTeamLineupSquad('bsd_t_488');
  assert.equal(requests.length, 2); assert.equal(requests[1].params.national_team_id, 488);
  assert.equal(rows.coverage.teamType, 'national'); assert.equal(rows.coverage.complete, true);
  assert.equal(rows[0].rosterTeamId, 'bsd_t_488'); assert.equal(rows[0].marketValue, 240000000);
});

test('a provider ignoring the team filter is rejected; pagination and duplicate IDs remain partial without unbounded traversal', async () => {
  for (const profile of [{ id: 1, name: 'Wrong club', current_team_id: 57 }, { id: 1, name: 'Unverified club' }]) {
    const { service } = bsd(() => ({ count: 1, results: [profile], next: null }));
    const result = await service.getTeamLineupSquad('bsd_t_44');
    assert.equal(result.length, 0); assert.equal(result.coverage.reason, 'roster_team_identity_mismatch');
  }
  const { service, requests } = bsd(() => ({ count: 220, results: [{ id: 1, name: 'Member', current_team_id: 44 }], next: 'https://sports.bzzoiro.com/api/v2/players/?offset=200' }));
  const rows = await service.getTeamLineupSquad('bsd_t_44');
  assert.equal(rows.length, 1); assert.equal(rows.coverage.complete, false); assert.equal(rows.coverage.possiblyTruncated, true);
  assert.equal(requests.length, 1);
});

test('BSD goal images use exact scorer IDs and the uniquely marked assist sequence identity; conflicts do not guess by name', async () => {
  const incidents = [
    { type: 'goal', player: 'Scorer', player_id: 1752, assist: 'Assistant', sequence: [{ pid: 1752, event: 'goal' }, { pid: 1747, assist: true, player: 'Assistant' }] },
    { type: 'goal', player: 'Scorer', player_id: 1752, assist: 'Name only' },
    { type: 'goal', player_id: 1752, assist: 'Assistant', assist_id: 1742, sequence: [{ pid: 1747, assist: true }] },
    { type: 'goal', player_id: 1752, sequence: [{ pid: 1747, assist: true }, { pid: 1742, assist: true }] },
  ];
  const { service } = bsd(() => ({ event_id: 1, incidents }));
  const rows = await service.getMatchTimeline('bsd_1');
  assert.equal(rows[0].playerId, 'bsd_p_1752'); assert.equal(rows[0].playerImage, 'https://sports.bzzoiro.com/img/player/1752/');
  assert.equal(rows[0].assistId, 'bsd_p_1747'); assert.equal(rows[0].assistImage, 'https://sports.bzzoiro.com/img/player/1747/');
  for (const row of rows.slice(1)) { assert.equal(row.assistId, null); assert.equal(row.assistImage, ''); }
});

test('BSD conflicting assist identity aliases suppress navigation and portraits while a scorer portrait stays bound to its explicit ID', async () => {
  const incidents = [
    { type: 'goal', player_id: 1752, player: { id: 1747, name: 'Reported name', photo: 'https://example.test/wrong-person.png' },
      assist: { id: 1747, name: 'Reported assistant' }, assist_id: 1742 },
    { type: 'goal', player_id: 1752, assist: 'Reported assistant', assist_id: 1742, assist_player_id: 1747 },
    { type: 'goal', player_id: 1752, assist_id: 1747, assist_player_id: '1747', assist: { id: 1747, name: 'Verified assistant' } },
  ];
  const { service } = bsd(() => ({ event_id: 1, incidents }));
  const rows = await service.getMatchTimeline('bsd_1');
  assert.equal(rows[0].playerId, 'bsd_p_1752'); assert.equal(rows[0].playerImage, 'https://sports.bzzoiro.com/img/player/1752/');
  assert.equal(rows[0].player, 'Reported name'); assert.equal(rows[0].assist, 'Reported assistant');
  for (const row of rows.slice(0, 2)) { assert.equal(row.assistId, null); assert.equal(row.assistImage, ''); }
  assert.equal(rows[2].assistId, 'bsd_p_1747'); assert.equal(rows[2].assistImage, 'https://sports.bzzoiro.com/img/player/1747/');
});

test('SportScore events retain opaque explicit IDs and only share portraits by the same exact lineup identity', () => {
  const sc = load('../services/sportscoreService', { '../utils/logger': logger });
  const details = sc.normalizeMatchDetail({ slug: 'fixture', home: 'Home', away: 'Away', status: 'finished', time: '2026-10-09T12:00:00Z',
    incidents: [{ type: 'goal', player: 'Scorer', player_id: 'scorer-token', assist: { name: 'Assistant', slug: 'assistant-token' } },
      { type: 'goal', player: 'Same name only', assist: 'Assistant' }],
    lineups: { home_xi: [{ slug: 'scorer-token', name: 'Scorer', photo: 'https://example.test/scorer.png' },
      { slug: 'assistant-token', name: 'Assistant', photo: 'https://example.test/assist.png', height_cm: 180, market_value_eur: 1000 }], away_xi: [] },
  }, 'fixture');
  assert.equal(details.timeline[0].playerId, 'scorer-token'); assert.equal(details.timeline[0].playerImage, 'https://example.test/scorer.png');
  assert.equal(details.timeline[0].assistId, 'assistant-token'); assert.equal(details.timeline[0].assistImage, 'https://example.test/assist.png');
  assert.equal(details.timeline[1].assistId, null); assert.equal(details.timeline[1].assistImage, '');
  assert.equal(details.lineups.home[1].height, 180); assert.equal(details.lineups.home[1].marketValueCurrency, 'EUR');
});

test('SportScore conflicting root and nested person IDs retain the reported names without a mismatched face or profile link', () => {
  const sc = load('../services/sportscoreService', { '../utils/logger': logger });
  const details = sc.normalizeMatchDetail({ slug: 'fixture', home: 'Home', away: 'Away', status: 'finished', time: '2026-10-09T12:00:00Z',
    incidents: [{ type: 'goal', player_id: 'scorer-token', player: { id: 'different-person', name: 'Reported scorer', photo: 'https://example.test/wrong.png' },
      assist_id: 'assistant-token', assist_player_id: 'different-assistant', assist: { name: 'Reported assistant', photo: 'https://example.test/wrong-assist.png' } }],
  }, 'fixture');
  const event = details.timeline[0];
  assert.equal(event.player, 'Reported scorer'); assert.equal(event.assist, 'Reported assistant');
  assert.equal(event.playerId, null); assert.equal(event.playerImage, '');
  assert.equal(event.assistId, null); assert.equal(event.assistImage, '');
});

test('Kickoff lineup wrapper photos with a contradictory player owner cannot become the canonical player portrait', async () => {
  const controller = load('../controllers/statsController', {
    '../services/sportscoreService': {}, '../services/bsdSportsService': {}, '../services/teamService': {}, '../utils/logger': logger,
    '../services/cacheService': { getCached: () => null, setCache() {} },
    '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'kickoffapi',
      data: { id: 'ko_1', status: 'FINISHED', homeTeam: { id: 'ko_t_44' }, awayTeam: { id: 'ko_t_57' } } }) },
    '../services/kickoffApiService': { safeFetch: async () => ({ parameters: { fixture: '1' }, response: [
      { team: { id: 44 }, startXI: [{ id: 22, photo: 'https://example.test/wrong.png', player: { id: 1, name: 'Scorer', pos: 'F' } }], substitutes: [] },
      { team: { id: 57 }, startXI: [{ player: { id: 2, name: 'Opponent', pos: 'F', photo: 'https://example.test/right.png' } }], substitutes: [] },
    ] }) },
  });
  const response = { status(code) { return this; }, json(body) { this.body = body; return this; } };
  await controller.getMatchLineups({ params: { id: 'ko_1' }, query: {} }, response);
  assert.equal(response.body.data.home[0].id, 'ko_p_1'); assert.equal(response.body.data.home[0].image, '');
  assert.equal(response.body.data.away[0].image, 'https://example.test/right.png');
});

test('public lineup endpoint enriches only its two verified owners and caches the enriched result; timeline/summary reads do not fan out', async () => {
  let squadCalls = [], detailsCalls = 0;
  const cache = new Map();
  const controller = load('../controllers/statsController', {
    '../services/sportscoreService': {}, '../services/sportsDataService': {}, '../services/kickoffApiService': {},
    '../services/teamService': {}, '../utils/logger': logger,
    '../services/bsdSportsService': {
      getMatchDetails: async () => { detailsCalls++; return { matchInfo: { id: 'bsd_1', status: 'IN_PLAY', homeTeam: { id: 'bsd_t_44' }, awayTeam: { id: 'bsd_t_57' } },
        lineups: xi(), timeline: [], coverage: { fields: { incidents: true } } }; },
      getTeamLineupSquad: async id => { squadCalls.push(id); return roster([{ id: 'bsd_p_1', marketValue: 1000000, marketValueCurrency: 'EUR' }], { teamId: id }); },
    }, '../services/cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
  });
  const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const a = response(); await controller.getMatchLineups({ params: { id: 'bsd_1' }, query: {} }, a);
  assert.deepEqual(squadCalls.sort(), ['bsd_t_44', 'bsd_t_57']); assert.equal(detailsCalls, 1);
  assert.equal(a.body.data.home[0].marketValue, 1000000);
  const b = response(); await controller.getMatchLineups({ params: { id: 'bsd_1' }, query: {} }, b);
  assert.equal(b.body.source, 'bsd_cached'); assert.equal(squadCalls.length, 2); assert.equal(detailsCalls, 1);
  await controller.getMatchTimeline({ params: { id: 'bsd_1' } }, response());
  assert.equal(squadCalls.length, 2); assert.equal(detailsCalls, 2);
});
