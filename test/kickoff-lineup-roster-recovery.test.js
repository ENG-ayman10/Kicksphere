'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function setup(read) {
  const previous = process.env.KICKOFF_API_KEY;
  process.env.KICKOFF_API_KEY = 'unit-test-only';
  const resolved = require.resolve('../services/kickoffApiService');
  delete require.cache[resolved];
  const entries = new Map(), calls = [], writes = [];
  const stubs = {
    axios: { create: () => ({ get: async (path, options) => {
      calls.push({ path, params: options.params });
      return { data: read(calls.length) };
    } }) },
    '../utils/logger': { info() {}, warn() {}, error() {} },
    './cacheService': {
      getCached(key, customTtl) {
        const entry = entries.get(key);
        if (!entry) return null;
        if (Date.now() - entry.at < (customTtl ?? entry.ttl)) return entry.value;
        entries.delete(key); return null;
      },
      setCache(key, value, ttl) {
        writes.push(ttl); entries.set(key, { value, ttl, at: Date.now() });
      },
    },
  };
  const original = Module._load;
  Module._load = function(name, parent, isMain) {
    return Object.hasOwn(stubs, name) ? stubs[name] : original.call(this, name, parent, isMain);
  };
  let service;
  try { service = require(resolved); }
  finally {
    Module._load = original;
    if (previous === undefined) delete process.env.KICKOFF_API_KEY;
    else process.env.KICKOFF_API_KEY = previous;
  }
  return { service, calls, writes };
}

const member = id => ({ id, name: 'Member ' + id, nationality: 'Spain', height: '180 cm',
  marketValue: 1000000, marketValueCurrency: 'EUR' });
const envelope = () => ({ parameters: { team: '44' }, errors: [], results: 1,
  paging: { current: 1, total: 1 }, response: [{ team: { id: 44 }, players: [member(1), member(2)] }] });

test('partial KickOff roster retries at 15 seconds, preserves exact members, then keeps the complete two-hour cache', async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    for (const reason of ['pagination', 'invalid_member', 'inconsistent_results', 'empty_roster', 'duplicate_member']) {
      now = 100000;
      const { service, calls, writes } = setup(index => {
        const data = envelope();
        if (index === 1) {
          if (reason === 'pagination') data.paging.total = 2;
          if (reason === 'invalid_member') data.response[0].players.push({ name: 'Unidentified member' });
          if (reason === 'inconsistent_results') data.results = 2;
          if (reason === 'empty_roster') data.response[0].players = [];
          if (reason === 'duplicate_member') data.response[0].players.push(member(1));
        }
        return data;
      });
      const partial = await service.getTeamSquad('ko_t_44');
      assert.equal(partial.coverage.complete, false, reason);
      assert.deepEqual(partial.map(row => row.id), reason === 'empty_roster' ? [] : reason === 'duplicate_member'
        ? ['ko_p_1', 'ko_p_2', 'ko_p_1'] : ['ko_p_1', 'ko_p_2']);
      if (reason !== 'empty_roster') assert.equal(partial[0].marketValue, 1000000);
      assert.equal(writes[0], 15000);
      now = 114999;
      await service.getTeamSquad('ko_t_44');
      assert.equal(calls.length, 1, reason);
      now = 115000;
      const recovered = await service.getTeamSquad('ko_t_44');
      assert.equal(calls.length, 2, reason);
      assert.equal(recovered.coverage.complete, true);
      assert.deepEqual(recovered.map(row => row.id), ['ko_p_1', 'ko_p_2']);
      assert.equal(recovered[0].height, 180);
      assert.equal(writes[1], 7200000);
      now = 7314999;
      await service.getTeamSquad('ko_t_44');
      assert.equal(calls.length, 2, reason);
      now = 7315000;
      await service.getTeamSquad('ko_t_44');
      assert.equal(calls.length, 3, reason);
      assert.ok(calls.every(call => call.path === '/api/v1/players/squads' && call.params.team === 44));
    }
  } finally { Date.now = originalNow; }
});
