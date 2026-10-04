const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createLiveSnapshotReader } = require('../services/liveSnapshotReader');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function covered(rows) {
  Object.defineProperty(rows, 'coverage', { value: { available: true, complete: true, partial: false,
    possiblyTruncated: false, returned: rows.length } });
  return rows;
}
function loadFacade(mocks) {
  delete require.cache[require.resolve('../services/sportsDataService')];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require('../services/sportsDataService'); } finally { Module._load = original; }
}
const fixture = (id, home = 'A') => ({ id, utcDate: '2026-10-02T12:00:00Z', status: 'IN_PLAY',
  homeTeam: { id: id.startsWith('bsd_') ? 'bsd_t_1' : 'sc_t_a', name: home },
  awayTeam: { id: id.startsWith('bsd_') ? 'bsd_t_2' : 'sc_t_b', name: 'B' },
  competition: { code: 'PL' }, score: { fullTime: { home: 1, away: 0 } } });

test('a healthy provider completes without waiting for its slow peer and late completion is reused', async () => {
  const slow = deferred(); let scReads = 0; let bsdReads = 0;
  const read = createLiveSnapshotReader();
  const sources = [{ name: 'sportscore', read: () => { scReads++; return slow.promise; } },
    { name: 'bsd', read: async () => { bsdReads++; return covered([fixture('bsd_1')]); } }];
  let timer;
  try {
    const initial = await Promise.race([read(sources), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('A healthy live source waited for its secondary')), 200);
    })]);
    assert.equal(initial[0].available, false); assert.equal(initial[0].pending, true);
    assert.equal(initial[1].data[0].id, 'bsd_1');
    const simultaneous = await Promise.all(Array.from({ length: 6 }, () => read(sources)));
    assert.ok(simultaneous.every(rows => rows[1].available));
    assert.equal(scReads, 1); assert.equal(bsdReads, 1);
    slow.resolve(covered([fixture('other-match', 'C')]));
    await flush();
    const later = await read(sources);
    assert.equal(later[0].data[0].id, 'other-match'); assert.equal(later[0].pending, false);
    assert.equal(scReads, 1); assert.equal(bsdReads, 1);
  } finally { clearTimeout(timer); slow.resolve(covered([])); }
});

test('retained snapshots disclose their age and expire while an in-flight refresh never overlaps', async () => {
  let time = Date.parse('2026-10-02T12:00:00Z'); let calls = 0;
  const next = deferred();
  const read = createLiveSnapshotReader({ now: () => time, waitMs: 1 });
  const sources = [{ name: 'bsd', read: () => ++calls === 1 ? covered([fixture('bsd_1')]) : next.promise }];
  assert.equal((await read(sources))[0].stale, false);
  time += 15001;
  const stale = (await read(sources))[0];
  assert.equal(stale.available, true); assert.equal(stale.stale, true);
  assert.equal(stale.pending, true); assert.equal(stale.ageMs, 15001);
  time += 45001;
  const expired = (await read(sources))[0];
  assert.equal(expired.available, false); assert.equal(expired.data, null); assert.equal(calls, 2);
  next.resolve(covered([])); await flush();
  const currentEmpty = (await read(sources))[0];
  assert.equal(currentEmpty.available, true); assert.equal(currentEmpty.stale, false);
  assert.deepEqual(currentEmpty.data, []);
});

test('failed refreshes have a bounded retry cadence and never fabricate an empty successful feed', async () => {
  let time = Date.parse('2026-10-02T12:00:00Z'); let calls = 0;
  const read = createLiveSnapshotReader({ now: () => time });
  const sources = [{ name: 'sportscore', read: async () => { calls++; throw new Error('Offline'); } }];
  for (let i = 0; i < 4; i++) {
    const snapshot = (await read(sources))[0];
    assert.equal(snapshot.available, false); assert.equal(snapshot.data, null); assert.equal(snapshot.failed, true);
  }
  assert.equal(calls, 1);
  time += 15000; await read(sources); assert.equal(calls, 2);
});

test('live facade returns fast BSD data with honest partial coverage and later includes distinct SportScore identities', async () => {
  const slow = deferred(); let calls = 0;
  const facade = loadFacade({ './sportscoreService': { getLiveMatches: () => { calls++; return slow.promise; } },
    './kickoffApiService': {}, './bsdSportsService': { isConfigured: () => true,
      getLiveMatches: async () => covered([fixture('bsd_1')]) } });
  const initial = await facade.getLiveMatches();
  assert.equal(initial.success, true); assert.equal(initial.source, 'bsd');
  assert.equal(initial.coverage.complete, false); assert.equal(initial.coverage.partial, true);
  assert.equal(initial.coverage.queries.find(row => row.provider === 'sportscore').pending, true);
  assert.equal(initial.data[0].id, 'bsd_1'); assert.equal(initial.data[0].liveSnapshotStale, false);
  slow.resolve(covered([fixture('sportscore-distinct', 'C')])); await flush();
  const later = await facade.getLiveMatches();
  assert.equal(later.coverage.complete, true);
  assert.deepEqual(later.data.map(row => row.id), ['bsd_1', 'sportscore-distinct']);
  assert.equal(calls, 1);
});

test('live facade preserves successful complete empty feeds and distinguishes total unavailability', async () => {
  const facade = loadFacade({ './sportscoreService': { getLiveMatches: async () => covered([]) },
    './kickoffApiService': {}, './bsdSportsService': { isConfigured: () => true, getLiveMatches: async () => covered([]) } });
  const empty = await facade.getLiveMatches();
  assert.equal(empty.success, true); assert.equal(empty.coverage.complete, true); assert.deepEqual(empty.data, []);
  const failed = loadFacade({ './sportscoreService': { getLiveMatches: async () => { throw new Error('Offline'); } },
    './kickoffApiService': {}, './bsdSportsService': { isConfigured: () => true, getLiveMatches: async () => null } });
  const unavailable = await failed.getLiveMatches();
  assert.equal(unavailable.success, false); assert.equal(unavailable.statusCode, 503); assert.equal(unavailable.source, 'unavailable');
});

test('the BSD core match endpoint uses summary without waiting for rich metadata or changing identity', async () => {
  let richCalls = 0;
  const metadata = deferred();
  const facade = loadFacade({ './sportscoreService': {}, './kickoffApiService': {}, './bsdSportsService': {
    isConfigured: () => true, getMatchSummary: async id => fixture(id),
    getMatchDetails: () => { richCalls++; return metadata.promise; } } });
  const core = await facade.getMatchDetails('bsd_123');
  assert.equal(core.success, true); assert.equal(core.data.id, 'bsd_123');
  assert.equal(core.coverage.scope, 'summary'); assert.equal(core.coverage.complete, false);
  assert.equal(richCalls, 0); metadata.resolve(null);
  const mismatch = loadFacade({ './sportscoreService': {}, './kickoffApiService': {}, './bsdSportsService': {
    getMatchSummary: async () => fixture('bsd_999'), getMatchDetails: () => assert.fail('No rich fallback for wrong identity') } });
  assert.equal((await mismatch.getMatchDetails('bsd_123')).success, false);
});
