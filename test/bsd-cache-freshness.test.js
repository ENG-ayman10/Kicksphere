'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function clockAndCache(context) {
  let time = Date.parse('2026-10-14T12:00:00Z');
  context.mock.method(Date, 'now', () => time);
  delete require.cache[require.resolve('../services/cacheService')];
  const cache = require('../services/cacheService');
  return { cache, now: () => time, advance: amount => { time += amount; } };
}

const rawEvent = overrides => ({ id: 1, league_id: 3, season_id: 1307,
  home_team_id: 57, home_team: 'Home', away_team_id: 44, away_team: 'Away',
  event_date: '2026-10-14T18:00:00Z', status: 'notstarted', ...overrides });
const lineup = status => ({ event_id: 1, lineup_status: status, lineups: {
  home: { team_id: 57, players: Array.from({ length: 11 }, (_, i) => ({ id: i + 1, name: `Home ${i + 1}` })) },
  away: { team_id: 44, players: Array.from({ length: 11 }, (_, i) => ({ id: i + 12, name: `Away ${i + 1}` })) },
} });
function setup(cache, handler) {
  const env = { BSD_API_TOKEN: 'offline_cache_test_token', BSD_BASE_URL: 'https://sports.bzzoiro.com' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const requests = [];
  const file = '../services/bsdSportsService';
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    if (name === 'axios') return { create: () => ({ get: async (path, config) => {
      requests.push(path);
      if (path === '/api/v2/leagues/') return { data: { count: 1, next: null,
        results: [{ id: 3, name: 'League' }] } };
      return { data: await handler(path, config) };
    } }) };
    if (name === './cacheService') return cache;
    if (name === '../utils/logger') return { warn() {}, info() {}, error() {} };
    return original.call(this, name, parent, main);
  };
  try { return { service: require(file), requests }; }
  finally {
    Module._load = original;
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('caller freshness caps a long cache without renewing its age or changing the default lifetime', context => {
  const f = clockAndCache(context);
  f.cache.setCache('strict', 'cached', 300000);
  f.cache.setCache('default', 'cached', 300000);
  f.advance(14999);
  assert.equal(f.cache.getCached('strict', 15000), 'cached');
  f.advance(1);
  assert.equal(f.cache.getCached('strict', 15000), null);
  assert.equal(f.cache.getCached('default'), 'cached');
  f.advance(285000);
  assert.equal(f.cache.getCached('default'), null);
});

test('a longer caller TTL never prolongs a short partial-response cache', context => {
  const f = clockAndCache(context);
  f.cache.setCache('partial', { complete: false }, 15000);
  f.advance(14999);
  assert.deepEqual(f.cache.getCached('partial', 300000), { complete: false });
  f.advance(1);
  assert.equal(f.cache.getCached('partial', 300000), null);
});

test('omitted or invalid caller age preserves the stored cache policy', context => {
  const f = clockAndCache(context);
  for (const value of [undefined, null, 0, -1, NaN, Infinity, '300000']) {
    const key = String(value);
    f.cache.setCache(key, 'value', 1000);
    f.advance(999);
    assert.equal(f.cache.getCached(key, value), 'value');
    f.advance(1);
    assert.equal(f.cache.getCached(key, value), null);
  }
});

test('alert reads refetch five-minute lineup data at their stricter age and concurrent refetches remain coalesced', async context => {
  const f = clockAndCache(context);
  let lineupReads = 0;
  let release;
  const updated = new Promise(resolve => { release = resolve; });
  const { service, requests } = setup(f.cache, async path => {
    if (path === '/api/v2/events/1/') return rawEvent();
    if (path === '/api/v2/events/1/lineups/') return ++lineupReads === 1 ? lineup('predicted') : updated;
    assert.fail('Unexpected alert resource ' + path);
  });
  const roster = await service.getTeamMatchLineups('bsd_1');
  assert.equal(roster.lineups.predicted, true);
  f.advance(14999);
  assert.equal((await service.getMatchAlertDetails('bsd_1', { includeLineups: true })).lineups.predicted, true);
  assert.equal(lineupReads, 1);
  f.advance(1);
  const first = service.getMatchAlertDetails('bsd_1', { includeLineups: true });
  const second = service.getMatchAlertDetails('bsd_1', { includeLineups: true });
  release(lineup('confirmed'));
  const results = await Promise.all([first, second]);
  assert.equal(lineupReads, 2);
  assert.ok(results.every(result => result.lineups.confirmed && result.lineups.integrity.complete));
  assert.equal(requests.filter(path => path === '/api/v2/events/1/').length, 2);
  assert.equal(requests.filter(path => path === '/api/v2/events/1/lineups/').length, 2);
  assert.equal(requests.filter(path => path === '/api/v2/leagues/').length, 1);
  assert.ok(results.every(result => result.id === 'bsd_1' && result.homeTeam.id === 'bsd_t_57' && result.awayTeam.id === 'bsd_t_44'));
});

test('BSD stream eligibility uses only explicit provider booleans and retains fixture source clocks', context => {
  const f = clockAndCache(context);
  const { service } = setup(f.cache, () => assert.fail('Normalization must not issue an HTTP request'));
  for (const value of [undefined, null, false, 0, 1, 'true', 'false', {}, []]) {
    const match = service.normalizeMatch(rawEvent({ live_websocket: value, websocket_plus: value }));
    assert.equal(match.liveWebsocket, false);
    assert.equal(match.websocketPlus, false);
  }
  const match = service.normalizeMatch(rawEvent({ live_websocket: true, websocket_plus: true,
    updated_at: '2026-10-14T11:58:00Z' }));
  assert.equal(match.liveWebsocket, true);
  assert.equal(match.websocketPlus, true);
  assert.equal(match.id, 'bsd_1');
  assert.equal(match.homeTeam.id, 'bsd_t_57');
  assert.equal(match.awayTeam.id, 'bsd_t_44');
  assert.equal(match.lastUpdated, '2026-10-14T11:58:00.000Z');
});
