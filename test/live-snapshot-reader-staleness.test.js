const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createLiveSnapshotReader } = require('../services/liveSnapshotReader');

test('the facade labels retained source data as partial and prefers a current peer over a stale snapshot', async () => {
  let time = Date.parse('2026-10-02T12:00:00Z');
  let scCalls = 0; let bsdCalls = 0; let resolveSc; let resolveBsd;
  const scPending = new Promise(resolve => { resolveSc = resolve; });
  const bsdPending = new Promise(resolve => { resolveBsd = resolve; });
  const match = id => ({ id, utcDate: '2026-10-02T12:00:00Z', homeTeam: { name: id },
    awayTeam: { name: 'B' }, competition: { code: 'PL' }, status: 'IN_PLAY' });
  const covered = id => {
    const rows = [match(id)];
    Object.defineProperty(rows, 'coverage', { value: { available: true, complete: true, possiblyTruncated: false } });
    return rows;
  };
  const mocks = {
    './liveSnapshotReader': { createLiveSnapshotReader: () => createLiveSnapshotReader({ now: () => time, waitMs: 1 }) },
    './sportscoreService': { getLiveMatches: () => ++scCalls === 1 ? covered('sc-match') : scPending },
    './bsdSportsService': { isConfigured: () => true, getLiveMatches: () => ++bsdCalls === 1 ? covered('bsd_1') : bsdPending },
    './kickoffApiService': {}
  };
  delete require.cache[require.resolve('../services/sportsDataService')];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let facade;
  try { facade = require('../services/sportsDataService'); } finally { Module._load = original; }
  assert.equal((await facade.getLiveMatches()).coverage.complete, true);
  time += 15001;
  const stale = await facade.getLiveMatches();
  assert.equal(stale.coverage.complete, false); assert.equal(stale.coverage.partial, true);
  assert.ok(stale.coverage.queries.every(query => query.pending && query.stale && query.snapshotAgeMs === 15001));
  assert.ok(stale.data.every(row => row.liveSnapshotStale && row.liveSnapshotAgeMs === 15001));
  resolveSc(covered('sc-match')); await new Promise(resolve => setImmediate(resolve));
  const currentPeer = await facade.getLiveMatches();
  assert.equal(currentPeer.data[0].id, 'sc-match'); assert.equal(currentPeer.data[0].liveSnapshotStale, false);
  assert.equal(currentPeer.coverage.queries.find(query => query.provider === 'bsd').stale, true);
  assert.equal(scCalls, 2); assert.equal(bsdCalls, 2);
  resolveBsd(covered('bsd_1'));
});
