'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { publicFixture } = require('../services/verifiedMatchDetailsService');

const oldId = 'valencia-old-route';
const fixture = (provider, id, score) => ({ id, provider, source: provider,
  utcDate: '2026-09-20T19:00:00Z', status: 'IN_PLAY', minute: score ? 25 : 12,
  competition: { code: 'PD', country: 'Spain' },
  homeTeam: { id: provider === 'bsd' ? 'bsd_t_47' : 'sc_t_valencia-cf',
    provider, name: provider === 'bsd' ? 'Valencia' : 'Valencia CF' },
  awayTeam: { id: provider === 'bsd' ? 'bsd_t_48' : 'sc_t_real-sociedad', provider, name: 'Real Sociedad' },
  score: { fullTime: { home: score, away: 0 } },
});
function service(summary) {
  const original = fixture('sportscore', oldId, 1);
  const calendar = fixture('bsd', 'bsd_213588', 0);
  const calls = [];
  const path = require.resolve('../services/sportsDataService');
  delete require.cache[path];
  const load = Module._load;
  Module._load = function(name, parent, main) {
    if (name === './sportscoreService') return { getMatchDetails: async () => original };
    if (name === './bsdSportsService') return { getMatchSummary: async (...args) => {
      calls.push(args); if (summary instanceof Error) throw summary; return summary;
    } };
    if (name === './verifiedMatchDetailsService') return { resolveVerifiedBsdFixture: async () => calendar, publicFixture };
    return load.call(this, name, parent, main);
  };
  let api;
  try { api = require(path); } finally { Module._load = load; }
  return { api, original, calls };
}

test('legacy match header reads current summary instead of publishing the cached calendar score', async () => {
  const fresh = fixture('bsd', 'bsd_213588', 2);
  const { api, calls } = service(fresh);
  const result = await api.getMatchDetails(oldId);
  assert.equal(result.data.id, oldId);
  assert.equal(result.data.canonicalMatchId, 'bsd_213588', JSON.stringify({ result, calls }));
  assert.equal(result.data.score.fullTime.home, 2);
  assert.equal(result.data.minute, 25);
  assert.equal(result.data.homeTeam.id, 'bsd_t_47');
  assert.equal(result.data.providerIdentities.length, 2);
  assert.equal(calls[0][0], 'bsd_213588');
  assert.ok(calls[0][1].timeoutMs > 0 && calls[0][1].timeoutMs <= 3500);
  assert.equal(calls[0][1].maxPages, 1);
});

test('missing or changed optional current summary retains the published original match', async () => {
  for (const summary of [null, new Error('temporary provider outage'),
    { ...fixture('bsd', 'bsd_213588', 2), utcDate: '2026-09-21T19:00:00Z' },
    { ...fixture('bsd', 'bsd_213588', 2), homeTeam: { id: 'bsd_t_999', provider: 'bsd', name: 'Valencia' } }]) {
    const { api, original } = service(summary);
    const result = await api.getMatchDetails(oldId);
    assert.equal(result.source, 'sportscore');
    assert.deepEqual(result.data, original);
    assert.equal(result.data.canonicalMatchId, undefined);
  }
});
