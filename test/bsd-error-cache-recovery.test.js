'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function setup(context, handler) {
  const env = { BSD_API_TOKEN: 'offline-error-test', BSD_BASE_URL: 'https://sports.bzzoiro.com' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let now = Date.parse('2026-10-15T12:00:00Z');
  context.mock.method(Date, 'now', () => now);
  delete require.cache[require.resolve('../services/cacheService')];
  const cache = require('../services/cacheService'), requests = [];
  const resolved = require.resolve('../services/bsdSportsService'); delete require.cache[resolved];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    if (name === 'axios') return { create: () => ({ get: async (path, config) => {
      requests.push({ path, params: config.params }); return { data: await handler(path) };
    } }) };
    if (name === './cacheService') return cache;
    if (name === '../utils/logger') return { info() {}, warn() {}, error() {} };
    return original.call(this, name, parent, main);
  };
  let api;
  try { api = require(resolved); } finally {
    Module._load = original;
    for (const key of Object.keys(env)) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
  return { api, requests, advance: amount => { now += amount; } };
}
const league = () => ({ id: 7, name: 'Champions League', current_season: { id: 1112, name: '26/27', is_current: true } });

test('explicit HTTP 200 failures recover after fifteen seconds rather than poisoning the one-hour league catalog', async context => {
  for (const body of [{ error: 'temporarily_unavailable' }, { errors: { access: 'unavailable' } },
    { success: false, message: 'unavailable' }, { detail: 'Temporarily unavailable', code: 'unavailable' }]) {
    let reads = 0;
    const f = setup(context, () => ++reads === 1 ? body : league());
    assert.equal(await f.api.getLeagueDetails('CL'), null);
    f.advance(14999);
    assert.equal(await f.api.getLeagueDetails('CL'), null);
    assert.equal(reads, 1, 'An explicit retry during the short negative lifetime must not hit the provider');
    f.advance(1);
    const recovered = await f.api.getLeagueDetails('CL');
    assert.equal(recovered.id, 'CL'); assert.equal(recovered.currentSeason.id, 1112);
    assert.equal(reads, 2);
    f.advance(3599999);
    assert.equal((await f.api.getLeagueDetails('CL')).id, 'CL'); assert.equal(reads, 2);
    f.advance(1);
    await f.api.getLeagueDetails('CL'); assert.equal(reads, 3);
    context.mock.restoreAll();
  }
});

test('a failed player biography recovers without freezing missing facts into the five-minute profile cache', async context => {
  let profileReads = 0;
  const f = setup(context, path => {
    if (path === '/api/v2/players/594/') return ++profileReads === 1 ? { error: 'temporary' }
      : { id: 594, name: 'Published Player', date_of_birth: '1998-12-20' };
    if (path.endsWith('/career/')) return { player_id: 594, seasons: [] };
    if (path.endsWith('/transfers/')) return { player_id: 594, transfers: [] };
    if (path === '/api/v2/leagues/') return { count: 0, next: null, results: [] };
    assert.fail('Unexpected profile fan-out ' + path);
  });
  assert.equal(await f.api.getPlayerDetails('bsd_p_594'), null);
  f.advance(14999);
  assert.equal(await f.api.getPlayerDetails('bsd_p_594'), null); assert.equal(profileReads, 1);
  f.advance(1);
  const recovered = await f.api.getPlayerDetails('bsd_p_594');
  assert.equal(recovered.id, 'bsd_p_594'); assert.equal(recovered.name, 'Published Player');
  assert.equal(profileReads, 2);
  f.advance(299999);
  assert.equal((await f.api.getPlayerDetails('bsd_p_594')).name, 'Published Player'); assert.equal(profileReads, 2);
});

test('genuine empty lists and harmless empty error markers retain normal successful catalog caching', async context => {
  const f = setup(context, path => path === '/api/v2/leagues/'
    ? { count: 0, next: null, results: [], errors: [] }
    : { ...league(), error: false, errors: {}, detail: 'A resource description' });
  const rows = await f.api.getLeagues();
  assert.deepEqual([...rows], []); assert.equal(rows.coverage.complete, true);
  assert.equal((await f.api.getLeagueDetails('CL')).id, 'CL');
  f.advance(15000);
  assert.deepEqual([...(await f.api.getLeagues())], []);
  assert.equal((await f.api.getLeagueDetails('CL')).id, 'CL');
  assert.equal(f.requests.length, 2);
});

test('concurrent failed reads coalesce and repeated callers cannot bypass the short negative cache', async context => {
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = setup(context, () => ++reads === 1 ? gate : league());
  const first = f.api.getLeagueDetails('CL'), second = f.api.getLeagueDetails('CL');
  release({ errors: ['temporary'] });
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(reads, 1);
  assert.ok((await Promise.all(Array.from({ length: 10 }, () => f.api.getLeagueDetails('CL')))).every(value => value === null));
  assert.equal(reads, 1);
  f.advance(15000);
  assert.equal((await f.api.getLeagueDetails('CL')).id, 'CL'); assert.equal(reads, 2);
});
