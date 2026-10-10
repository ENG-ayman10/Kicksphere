'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const logger = { info() {}, warn() {}, error() {} };
function load(file, stubs = {}) {
  const resolved = require.resolve(file); delete require.cache[resolved];
  const original = Module._load;
  Module._load = function(name, parent, isMain) { return Object.hasOwn(stubs, name) ? stubs[name] : original.call(this, name, parent, isMain); };
  try { return require(resolved); } finally { Module._load = original; }
}
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
const roles = ['G', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'M', 'F', 'F'];
const grids = ['1:1', '2:1', '2:2', '2:3', '2:4', '3:1', '3:2', '3:3', '3:4', '4:1', '4:2'];
function rawXi(start) { return roles.map((position, index) => ({ id: start + index, name: 'Player ' + (start + index), position, grid: grids[index] })); }
const match = { id: 'bsd_1', rawId: 1, status: 'IN_PLAY', homeTeam: { id: 'bsd_t_57', rawId: 57 }, awayTeam: { id: 'bsd_t_44', rawId: 44 } };
function bsdRaw() { return { event_id: 1, lineup_status: 'confirmed', lineups: {
  home: { team_id: 57, formation: '4-4-2', players: rawXi(1).reverse(), substitutes: [] },
  away: { team_id: 44, formation: '4-4-2', players: rawXi(101).reverse(), substitutes: [] } } }; }
function bsd() { return load('../services/bsdSportsService', { '../utils/logger': logger }); }
function sc() { return load('../services/sportscoreService', { '../utils/logger': logger }); }
function sportscoreRaw() { return { slug: 'fixture-slug', home: 'Home', away: 'Away', status: 'live', time: '2026-10-07T12:00:00Z', lineups: {
  confirmed: true, home_formation: '4-4-2', away_formation: '4-4-2',
  home_xi: rawXi(1).map(row => ({ ...row, slug: 'home-player-' + row.id })).reverse(),
  away_xi: rawXi(101).map(row => ({ ...row, slug: 'away-player-' + row.id })).reverse() } }; }
function controller(stubs = {}, cache = { getCached: () => null, setCache() {} }) { return load('../controllers/statsController', {
  '../services/sportscoreService': {}, '../services/sportsDataService': {}, '../services/kickoffApiService': {}, '../services/bsdSportsService': {},
  '../services/teamService': {}, '../services/cacheService': cache, '../utils/logger': logger, ...stubs }); }
async function request(api, id = 'bsd_1', query = {}) { const res = response(); await api.getMatchLineups({ params: { id }, query }, res); return res; }

test('BSD normalization and the public controller preserve verified grids from shuffled provider rows', async () => {
  const raw = bsdRaw(), before = structuredClone(raw);
  const lineups = bsd().normalizeLineups(raw, match);
  assert.equal(lineups.homeLayout.mode, 'grid');
  assert.deepEqual(lineups.homeLayout.rows[1], ['bsd_p_2', 'bsd_p_3', 'bsd_p_4', 'bsd_p_5']);
  const api = controller({ '../services/bsdSportsService': { getMatchDetails: async () => ({ matchInfo: match, lineups }) } });
  const res = await request(api);
  assert.equal(res.body.coverage.complete, true); assert.equal(res.body.data.homeLayout.mode, 'grid');
  assert.deepEqual(res.body.data.homeLayout.rows, lineups.homeLayout.rows);
  assert.deepEqual(raw, before);
});

test('SportScore normalization retains its own opaque player IDs and explicit shuffled grids', () => {
  const raw = sportscoreRaw(), before = structuredClone(raw);
  const lineups = sc().normalizeMatchDetail(raw, 'fixture-slug').lineups;
  assert.equal(lineups.home[0].id, 'home-player-11'); assert.equal(lineups.home[0].provider, 'sportscore');
  assert.deepEqual(lineups.homeLayout.rows[1], ['home-player-2', 'home-player-3', 'home-player-4', 'home-player-5']);
  assert.equal(lineups.homeLayout.mode, 'grid'); assert.equal(lineups.integrity.complete, true);
  assert.deepEqual(raw, before);
});

test('cross-side and XI/bench duplicates are excluded through both provider adapters before delivery', async () => {
  const raw = bsdRaw(); raw.lineups.home.substitutes.push(raw.lineups.home.players[0]);
  raw.lineups.away.players[0] = { ...raw.lineups.home.players[1] };
  const normalized = bsd().normalizeLineups(raw, match);
  const api = controller({ '../services/bsdSportsService': { getMatchDetails: async () => ({ matchInfo: match, lineups: normalized }) } });
  const res = await request(api);
  const duplicated = 'bsd_p_' + raw.lineups.home.players[1].id;
  assert.ok(!res.body.data.home.some(row => row.id === duplicated));
  assert.ok(!res.body.data.away.some(row => row.id === duplicated));
  assert.equal(res.body.data.homeBench.length, 0); assert.equal(res.body.coverage.complete, false);
  assert.ok(res.body.coverage.integrity.reasons.includes('cross_team_player_conflict'));
  const sr = sportscoreRaw(); sr.lineups.away_xi[0] = { ...sr.lineups.home_xi[0] };
  const sl = sc().normalizeMatchDetail(sr, 'fixture-slug').lineups;
  assert.ok(!sl.home.some(row => row.id === sr.lineups.home_xi[0].slug));
  assert.ok(!sl.away.some(row => row.id === sr.lineups.home_xi[0].slug));
  assert.ok(sl.integrity.reasons.includes('cross_team_player_conflict'));
});

test('a source name without a profile ID is retained for display but never gets a generated profile or tactical slot', () => {
  const raw = bsdRaw(); delete raw.lineups.home.players[0].id;
  raw.lineups.home.players[0].name = 'Provider name without identity';
  raw.lineups.home.players[0].photo = 'https://example.test/supplied.png';
  const lineups = bsd().normalizeLineups(raw, match);
  const row = lineups.home.find(row => row.name === 'Provider name without identity');
  assert.ok(row); assert.equal(row.id, null); assert.equal(row.player?.id ?? null, null);
  assert.equal(row.image, 'https://example.test/supplied.png');
  assert.equal(lineups.homeLayout.reason, 'unverified_player_identity');
  assert.ok(lineups.integrity.reasons.includes('player_identity_missing'));
  const sr = sportscoreRaw(); delete sr.lineups.home_xi[0].id; delete sr.lineups.home_xi[0].slug;
  sr.lineups.home_xi[0].name = 'SportScore name only';
  const sl = sc().normalizeMatchDetail(sr, 'fixture-slug').lineups;
  assert.equal(sl.home.find(row => row.name === 'SportScore name only').id, null);
  assert.equal(sl.homeLayout.reason, 'unverified_player_identity');
});

test('query hints and matching team names cannot override a different fixture ID or lineup owner', async () => {
  for (const [id, stubs] of [
    ['bsd_1', { '../services/bsdSportsService': { getMatchDetails: async () => ({ matchInfo: { ...match, id: 'bsd_2' }, lineups: bsd().normalizeLineups(bsdRaw(), match) }) } }],
    ['fixture-slug', { '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'sportscore', data: { ...match, id: 'other-fixture', lineups: bsd().normalizeLineups(bsdRaw(), match) } }) } }],
    ['bsd_1', { '../services/bsdSportsService': { getMatchDetails: async () => ({ matchInfo: match, lineups: { ...bsd().normalizeLineups(bsdRaw(), match), matchId: 'bsd_2' } }) } }],
  ]) {
    const api = controller({ ...stubs, '../services/kickoffApiService': { safeFetch: async () => assert.fail('No namesake fallback') } });
    const res = await request(api, id, { home: 'Home', away: 'Away', date: '2026-10-07' });
    assert.equal(res.statusCode, 200); assert.equal(res.body.source, 'unavailable');
    assert.equal(res.body.coverage.available, false); assert.deepEqual(res.body.data.home, []);
  }
  const raw = bsdRaw(); raw.event_id = 2; assert.equal(bsd().normalizeLineups(raw, match), null);
});

const koMatch = { id: 'ko_10', status: 'IN_PLAY', homeTeam: { id: 'ko_t_1' }, awayTeam: { id: 'ko_t_2' } };
function koSides() { return [
  { team: { id: 2 }, formation: '4-4-2', startXI: rawXi(101).map(player => ({ player: { ...player, pos: player.position } })).reverse(), substitutes: [] },
  { team: { id: 1 }, formation: '4-4-2', startXI: rawXi(1).map(player => ({ player: { ...player, pos: player.position } })).reverse(), substitutes: [] } ]; }

test('Kickoff exact fixture and side IDs preserve grid regardless of side-array order', async () => {
  const api = controller({ '../services/sportsDataService': { getMatchDetails: async id => ({ source: 'kickoffapi', data: koMatch }) },
    '../services/kickoffApiService': { safeFetch: async (path, params) => { assert.equal(path, '/api/v1/fixtures/lineups'); assert.equal(params.fixture, 10); return { parameters: { fixture: '10' }, response: koSides() }; } } });
  const res = await request(api, 'ko_10');
  assert.equal(res.body.source, 'kickoffapi'); assert.equal(res.body.data.home[0].id, 'ko_p_11');
  assert.equal(res.body.data.away[0].id, 'ko_p_111');
  assert.deepEqual(res.body.data.homeLayout.rows[1], ['ko_p_2', 'ko_p_3', 'ko_p_4', 'ko_p_5']);
  assert.equal(res.body.coverage.complete, true);
});

test('Kickoff rejects an explicit different fixture filter and malformed envelopes before caching', async () => {
  for (const raw of [{ parameters: { fixture: '11' }, response: koSides() },
    { parameters: { fixture: '10' }, response: {} }]) {
    let cached = false;
    const api = controller({ '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'kickoffapi', data: koMatch }) },
      '../services/kickoffApiService': { safeFetch: async () => raw } }, { getCached: () => null, setCache: () => { cached = true; } });
    const res = await request(api, 'ko_10');
    assert.equal(res.statusCode, 200); assert.equal(res.body.source, 'unavailable'); assert.equal(cached, false);
  }
});

test('provider adapter labels cannot disguise a player ID from a different namespace', async () => {
  const sr = sportscoreRaw(); sr.lineups.home_xi[0].slug = 'bsd_p_594';
  const sl = sc().normalizeMatchDetail(sr, 'fixture-slug').lineups;
  assert.ok(!sl.home.some(row => row.id === 'bsd_p_594'));
  assert.equal(sl.integrity.complete, false);
  const sides = koSides(); sides[1].startXI[0].player.id = 'bsd_p_594';
  const api = controller({ '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'kickoffapi', data: koMatch }) },
    '../services/kickoffApiService': { safeFetch: async () => ({ parameters: { fixture: '10' }, response: sides }) } });
  const res = await request(api, 'ko_10');
  assert.ok(!res.body.data.home.some(row => row.id === 'ko_p_bsd_p_594'));
  assert.equal(res.body.coverage.complete, false);
});

test('controller lineup caching expires active confirmed lists at 30 seconds, predicted at 15 seconds, finished confirmed at 15 minutes', async () => {
  for (const [status, confirmed, expectedTtl] of [['TIMED', true, 30000], ['IN_PLAY', true, 30000], ['PAUSED', true, 30000],
    ['TIMED', false, 15000], ['IN_PLAY', false, 15000], ['FINISHED', false, 15000], ['FINISHED', true, 900000]]) {
    let now = 0, calls = 0;
    const entries = new Map(), writes = [];
    const cache = { getCached: key => {
      const entry = entries.get(key); return entry && now < entry.expires ? entry.value : null;
    }, setCache: (key, value, ttl) => { writes.push({ key, ttl }); entries.set(key, { value, expires: now + ttl }); } };
    const normal = bsd().normalizeLineups(bsdRaw(), match);
    for (const side of ['home', 'away']) normal[side] = normal[side].map(player => ({ ...player, rating: 7.2 }));
    const api = controller({ '../services/bsdSportsService': { getMatchDetails: async () => { calls++; return {
      matchInfo: { ...match, status }, lineups: { ...normal, confirmed, predicted: !confirmed, lineupStatus: confirmed ? 'confirmed' : 'predicted' } }; } } }, cache);
    const first = await request(api); assert.equal(first.body.source, 'bsd'); assert.equal(calls, 1);
    assert.equal(writes[0].ttl, expectedTtl, status + ':' + confirmed);
    now = expectedTtl - 1; const second = await request(api); assert.equal(second.body.source, 'bsd_cached'); assert.equal(calls, 1);
    now = expectedTtl; await request(api); assert.equal(calls, 2, 'An expired announcement must be fetched again');
  }
});

test('finished XI with late match ratings refreshes in sixty seconds and uses only lineup detail sections', async () => {
  let now = 0, calls = 0;
  const entries = new Map(), writes = [];
  const cache = { getCached: key => {
    const entry = entries.get(key); return entry && now < entry.expires ? entry.value : null;
  }, setCache: (key, value, ttl) => { writes.push(ttl); entries.set(key, { value, expires: now + ttl }); } };
  const normal = bsd().normalizeLineups(bsdRaw(), match);
  const api = controller({ '../services/bsdSportsService': {
    getMatchDetails: async (id, options) => {
      assert.equal(id, 'bsd_1'); assert.deepEqual(options, { lineupsOnly: true }); calls++;
      const lineups = { ...normal, home: normal.home.map(player => ({ ...player, rating: calls === 1 ? null : 8.2 })),
        away: normal.away.map(player => ({ ...player, rating: calls === 1 ? null : 7.2 })) };
      return { matchInfo: { ...match, status: 'FINISHED' }, lineups };
    } } }, cache);
  assert.equal((await request(api)).body.data.home[0].rating, null);
  assert.equal(writes[0], 60000);
  now = 59999; assert.equal((await request(api)).body.source, 'bsd_cached');
  now = 60000; assert.equal((await request(api)).body.data.home[0].rating, 8.2);
  assert.equal(writes[1], 900000); assert.equal(calls, 2);
});

test('an unlinked original lineup is retried shortly instead of freezing names-only recovery for fifteen minutes', async () => {
  const writes = [], normal = bsd().normalizeLineups(bsdRaw(), match);
  const original = { id: 'old-public-fixture', status: 'FINISHED', homeTeam: { id: 'sc_t_home' }, awayTeam: { id: 'sc_t_away' },
    lineups: { confirmed: true, homeFormation: '4-4-2', awayFormation: '4-4-2',
      home: normal.home.map(player => ({ name: player.name, position: player.position, id: null, provider: 'sportscore' })),
      away: normal.away.map(player => ({ name: player.name, position: player.position, id: null, provider: 'sportscore' })),
      homeBench: [], awayBench: [] } };
  const api = controller({ '../services/sportsDataService': {
    getMatchDetails: async () => ({ source: 'sportscore', data: original }) } },
  { getCached: () => null, setCache: (_key, _value, ttl) => writes.push(ttl) });
  const res = await request(api, original.id);
  assert.equal(res.body.data.home.length, 11);
  assert.equal(res.body.data.home[0].id, null);
  assert.equal(writes[0], 15000);
});
