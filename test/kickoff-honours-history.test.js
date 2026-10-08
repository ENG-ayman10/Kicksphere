'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { normalizeKickoffHonoursHistory } = require('../utils/kickoffHonoursHistory');
const fixture = require('./fixtures/kickoff-player-honours-2026-10-08.json');
const logger = { info() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const FAILURE_TTL = 5 * 60 * 1000;
const scope = { playerId: 'ko_p_278', rawPlayerId: 278, responseComplete: true };
const trophy = (overrides = {}) => ({ playerId: 278, league: 'Actual Cup', country: 'Spain', season: '2025', place: 'Winner', ...overrides });
const envelope = (rows, playerId = 278) => ({ parameters: { player: String(playerId) }, errors: [],
  results: rows.length, paging: { current: 1, total: 1 }, response: rows });

function loadApi(read, now = () => Date.now()) {
  const cache = new Map(), calls = [];
  const cached = {
    getCached(key, override) {
      const entry = cache.get(key);
      if (!entry) return null;
      if (now() - entry.at < (override ?? entry.ttl)) return entry.value;
      cache.delete(key);
      return null;
    },
    setCache(key, value, ttl = 60000) { cache.set(key, { value, ttl, at: now() }); },
  };
  const previousKey = process.env.KICKOFF_API_KEY;
  process.env.KICKOFF_API_KEY = 'unit-test-key';
  const file = require.resolve('../services/kickoffApiService');
  delete require.cache[file];
  const original = Module._load;
  const mocks = {
    axios: { create: () => ({ get: async (path, { params }) => {
      calls.push({ path, params });
      return { data: await read(path, params) };
    } }) },
    '../utils/logger': logger,
    './cacheService': cached,
  };
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  let api;
  try { api = require(file); } finally {
    Module._load = original;
    if (previousKey === undefined) delete process.env.KICKOFF_API_KEY;
    else process.env.KICKOFF_API_KEY = previousKey;
  }
  return { api, calls, cache };
}

for (const [playerId, expectedDated, expectedOmitted] of [[154, 70, 24], [1100, 22, 16]]) {
  const player = fixture.players.find(item => item.playerId === playerId);
  test(`captured ${player.name} history omits undated summaries without claiming lifetime coverage`, () => {
    const result = normalizeKickoffHonoursHistory(player.rows, {
      playerId: 'ko_p_' + playerId, rawPlayerId: playerId, responseComplete: true,
    });
    assert.equal(result.honours.length, expectedDated);
    assert.equal(result.honoursCoverage.rawRecords, player.rows.length);
    assert.equal(result.honoursCoverage.undatedRowsOmitted, expectedOmitted);
    assert.equal(result.honoursCoverage.responseComplete, true);
    assert.equal(result.honoursCoverage.complete, false);
    assert.equal(result.honoursCoverage.partial, true);
    assert.equal(result.honoursCoverage.rejected, 0);
    assert.equal(result.honoursCoverage.reason, 'undated_honour_rows_omitted');
    assert.deepEqual(result.honours.map(row => [row.name, row.season, row.place]),
      player.rows.filter(row => row.season).map(row => [row.league, row.season, row.place]));
    assert.ok(result.honours.every(row => row.team === '' && row.count === 1));
  });

  test(`dedicated and embedded ${player.name} use the same dated history`, async () => {
    const dedicated = loadApi(() => envelope(player.rows, playerId));
    const expected = await dedicated.api.getPlayerHonours('ko_p_' + playerId);
    assert.equal(expected.honours.length, expectedDated);
    const embedded = loadApi(() => ({ response: [{ player: {
      id: playerId, name: player.name, trophies: player.rows, honours_complete: true,
    } }] }));
    const profile = await embedded.api.getPlayerDetails('ko_p_' + playerId);
    assert.deepEqual(profile.honours, expected.honours);
    assert.deepEqual(profile.honoursCoverage, expected.honoursCoverage);
    assert.equal(embedded.calls.length, 1);
  });
}

test('same competition winner and runner-up remain distinct and in source order', () => {
  const result = normalizeKickoffHonoursHistory([
    trophy({ place: '2nd Place' }), trophy(), trophy({ season: null }), trophy(),
  ], scope);
  assert.deepEqual(result.honours.map(row => [row.place, row.isWinner]), [['2nd Place', false], ['Winner', true]]);
  assert.equal(result.honoursCoverage.rawRecords, 4);
  assert.equal(result.honoursCoverage.undatedRowsOmitted, 1);
  assert.equal(result.honoursCoverage.returned, 2);
});

test('omissions count valid raw rows while foreign and malformed rows remain rejected', () => {
  const result = normalizeKickoffHonoursHistory([
    trophy({ season: null }), trophy({ season: null }),
    trophy({ season: null, playerId: 279 }), { season: null },
  ], scope);
  assert.deepEqual(result.honours, []);
  assert.equal(result.honoursCoverage.undatedRowsOmitted, 2);
  assert.equal(result.honoursCoverage.rejected, 2);
  assert.equal(result.honoursCoverage.rawRecords, 4);
  assert.equal(result.honoursCoverage.complete, false);
});

test('all-undated, empty and unavailable records have distinct honest coverage', () => {
  const undated = normalizeKickoffHonoursHistory([trophy({ season: null })], scope);
  const empty = normalizeKickoffHonoursHistory([], scope);
  const unavailable = normalizeKickoffHonoursHistory(undefined, scope);
  assert.equal(undated.honoursCoverage.reason, 'undated_honour_rows_omitted');
  assert.equal(empty.honoursCoverage.reason, 'empty_honours');
  assert.equal(unavailable.honoursCoverage.reason, 'honours_not_supplied');
  assert.equal(empty.honoursCoverage.rawRecords, 0);
  assert.equal(unavailable.honoursCoverage.rawRecords, null);
  assert.equal(empty.honoursCoverage.responseComplete, true);
  assert.equal(unavailable.honoursCoverage.responseComplete, false);
  for (const result of [undated, empty, unavailable]) {
    assert.deepEqual(result.honours, []);
    assert.equal(result.honoursCoverage.complete, false);
    assert.equal(result.honoursCoverage.partial, true);
  }
});

test('captured historical FIFA names remain exactly as supplied', () => {
  const messi = fixture.players.find(item => item.playerId === 154);
  const result = normalizeKickoffHonoursHistory(messi.rows, { playerId: 'ko_p_154', rawPlayerId: 154 });
  assert.deepEqual(result.honours.filter(row => row.name === 'FIFA Intercontinental Cup')
    .map(row => [row.season, row.place]), [['2015', 'Winner'], ['2011', 'Winner'], ['2009', 'Winner'], ['2006', '2nd Place']]);
});

test('positive honours are coalesced and cached for 24 hours', async () => {
  let now = 0;
  const { api, calls, cache } = loadApi(() => envelope([trophy()]), () => now);
  const [first, concurrent] = await Promise.all([api.getPlayerHonours('ko_p_278'), api.getPlayerHonours('ko_p_278')]);
  assert.deepEqual(first, concurrent);
  assert.equal(calls.length, 1);
  assert.equal(cache.get('kickoff:player-honours:278').ttl, DAY);
  now = DAY - 1;
  await api.getPlayerHonours('ko_p_278');
  assert.equal(calls.length, 1);
  now = DAY;
  await api.getPlayerHonours('ko_p_278');
  assert.equal(calls.length, 2);
});

test('provider errors and ignored filters are cached for five minutes before retry', async () => {
  for (const failure of [null, { ...envelope([trophy()]), errors: { token: 'expired' } },
    { ...envelope([trophy()]), parameters: { player: '279' } }]) {
    let now = 0, failed = true;
    const { api, calls, cache } = loadApi(() => failed ? failure : envelope([trophy()]), () => now);
    const unavailable = await api.getPlayerHonours('ko_p_278');
    assert.equal(unavailable.honoursCoverage.available, false);
    assert.equal(cache.get('kickoff:player-honours:278').ttl, FAILURE_TTL);
    failed = false;
    now = FAILURE_TTL - 1;
    assert.deepEqual(await api.getPlayerHonours('ko_p_278'), unavailable);
    assert.equal(calls.length, 1);
    now = FAILURE_TTL;
    assert.equal((await api.getPlayerHonours('ko_p_278')).honours.length, 1);
    assert.equal(calls.length, 2);
  }
});

test('a rejected foreign history uses the failure TTL and cannot become a title', async () => {
  const { api, cache } = loadApi(() => envelope([trophy({ playerId: 279 })]));
  const result = await api.getPlayerHonours('ko_p_278');
  assert.deepEqual(result.honours, []);
  assert.equal(result.honoursCoverage.rejected, 1);
  assert.equal(cache.get('kickoff:player-honours:278').ttl, FAILURE_TTL);
});

test('cached player profiles retry failed honours after five minutes without refetching statistics', async () => {
  let now = 0, failed = true;
  const { api, calls } = loadApi(path => path === '/api/v1/players'
    ? { response: [{ player: { id: 278, name: 'Verified Player' }, statistics: [] }] }
    : failed ? null : envelope([trophy()]), () => now);
  const first = await api.getPlayerDetails('ko_p_278');
  assert.equal(first.honoursCoverage.available, false);
  failed = false;
  now = FAILURE_TTL - 1;
  assert.equal((await api.getPlayerDetails('ko_p_278')).honoursCoverage.available, false);
  assert.equal(calls.length, 2);
  now = FAILURE_TTL;
  const repaired = await api.getPlayerDetails('ko_p_278');
  assert.equal(repaired.honours.length, 1);
  assert.equal(repaired.id, first.id);
  assert.deepEqual(repaired.seasonStats, first.seasonStats);
  assert.equal(calls.filter(call => call.path === '/api/v1/players').length, 1);
  assert.equal(calls.filter(call => call.path === '/api/v1/trophies').length, 2);
});
