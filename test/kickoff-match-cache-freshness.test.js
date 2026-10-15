'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function setup(context, read) {
  const previous = process.env.KICKOFF_API_KEY;
  process.env.KICKOFF_API_KEY = 'unit-test-only';
  const resolved = require.resolve('../services/kickoffApiService');
  delete require.cache[resolved];
  delete require.cache[require.resolve('../services/cacheService')];
  const cache = require('../services/cacheService');
  let now = Date.parse('2026-10-15T12:00:00Z');
  context.mock.method(Date, 'now', () => now);
  const calls = [], writes = [];
  const stubs = {
    axios: { create: () => ({ get: async (path, options) => {
      calls.push({ path, params: options.params });
      return { data: await read(calls.length) };
    } }) },
    '../utils/logger': { info() {}, warn() {}, error() {} },
    './cacheService': { getCached: cache.getCached, setCache: (key, value, ttl) => {
      writes.push(ttl); cache.setCache(key, value, ttl);
    } },
  };
  const original = Module._load;
  Module._load = function(name, parent, main) {
    return Object.hasOwn(stubs, name) ? stubs[name] : original.call(this, name, parent, main);
  };
  let service;
  try { service = require(resolved); }
  finally {
    Module._load = original;
    if (previous === undefined) delete process.env.KICKOFF_API_KEY;
    else process.env.KICKOFF_API_KEY = previous;
  }
  return { service, calls, writes, advance: amount => { now += amount; } };
}
function fixture(status, homeScore = 0) {
  return { parameters: { id: 10 }, errors: [], response: [{
    fixture: { id: 10, date: '2026-10-15T11:30:00Z', status: { short: status } },
    teams: { home: { id: 44, name: 'Home' }, away: { id: 57, name: 'Away' } },
    league: { id: 140, name: 'La Liga', country: 'Spain' }, goals: { home: homeScore, away: 0 },
  }] };
}

test('opened live Kickoff summaries refresh at the existing 60-second live interval rather than five minutes', async context => {
  for (const status of ['1H', 'HT', '2H', 'ET', 'P', 'BT', 'LIVE', 'SUSP', 'INT']) {
    const f = setup(context, count => fixture(status, count - 1));
    assert.equal((await f.service.getMatchDetails('ko_10')).score.fullTime.home, 0);
    f.advance(59999);
    assert.equal((await f.service.getMatchDetails('ko_10')).score.fullTime.home, 0);
    assert.equal(f.calls.length, 1);
    f.advance(1);
    const updated = await f.service.getMatchDetails('ko_10');
    assert.equal(updated.score.fullTime.home, 1, status);
    assert.equal(updated.id, 'ko_10');
    assert.deepEqual([updated.homeTeam.id, updated.awayTeam.id], ['ko_t_44', 'ko_t_57']);
    assert.deepEqual(f.writes, [60000, 60000]);
    assert.deepEqual(f.calls, [{ path: '/api/v1/fixtures', params: { id: 10 } }, { path: '/api/v1/fixtures', params: { id: 10 } }]);
    context.mock.restoreAll();
  }
});

test('scheduled and terminal Kickoff summaries retain the five-minute cache and do not start background reads', async context => {
  for (const status of ['NS', 'FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD']) {
    const f = setup(context, () => fixture(status));
    await f.service.getMatchDetails('ko_10');
    f.advance(299999);
    await f.service.getMatchDetails('ko_10');
    assert.equal(f.calls.length, 1, status);
    assert.deepEqual(f.writes, [300000]);
    f.advance(1);
    assert.equal(f.calls.length, 1, 'Clock advancement alone must not poll the provider');
    await f.service.getMatchDetails('ko_10');
    assert.equal(f.calls.length, 2);
    context.mock.restoreAll();
  }
});

test('concurrent expired live summaries share one upstream read and a final result regains the stable cache', async context => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = setup(context, count => count === 1 ? fixture('2H') : gate);
  await f.service.getMatchDetails('ko_10');
  f.advance(60000);
  const first = f.service.getMatchDetails('ko_10');
  const second = f.service.getMatchDetails('ko_10');
  release(fixture('FT', 1));
  const results = await Promise.all([first, second]);
  assert.equal(f.calls.length, 2);
  assert.ok(results.every(result => result.status === 'FINISHED' && result.score.fullTime.home === 1));
  f.advance(299999);
  assert.equal((await f.service.getMatchDetails('ko_10')).status, 'FINISHED');
  assert.equal(f.calls.length, 2);
  f.advance(1);
  await f.service.getMatchDetails('ko_10');
  assert.equal(f.calls.length, 3);
});
