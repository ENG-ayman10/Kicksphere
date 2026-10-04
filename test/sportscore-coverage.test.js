const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const logger = { info() {}, warn() {}, error() {} };
function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}
function provider(read, { cached = true } = {}) {
  const cache = new Map();
  const calls = [];
  const api = load('../services/sportscoreService', {
    axios: { get: async value => { const url = new URL(value); calls.push(url); return { data: await read(url) }; } },
    '../utils/logger': logger,
    './cacheService': { getCached: key => cached ? cache.get(key) : null,
      setCache: (key, value) => { if (cached) cache.set(key, value); } },
  });
  return { api, calls };
}
const fixture = (id, overrides = {}) => ({ slug: id, home: 'Home', away: 'Away',
  home_slug: 'home-club', away_slug: 'away-club', competition: 'Premier League',
  time: '2026-10-01T19:00:00Z', status: 'upcoming', ...overrides });
const capped = () => Array.from({ length: 200 }, (_, index) => fixture(`base-${index}`));

test('a capped daily read recovers status-partition fixtures, updates exact IDs and never certifies a complete day', async () => {
  const primary = capped();
  const { api, calls } = provider(url => {
    assert.equal(url.searchParams.get('date'), '2026-10-01');
    assert.equal(url.searchParams.get('competition'), 'english-premier-league');
    assert.equal(url.searchParams.get('limit'), '200');
    assert.equal(url.searchParams.has('page') || url.searchParams.has('offset') || url.searchParams.has('cursor'), false);
    const status = url.searchParams.get('status');
    return { matches: status === 'live' ? [fixture('live-1', { status }), fixture('live-2', { status })] :
      status === 'finished' ? [fixture('base-0', { status }), fixture('finished-extra', { status })] :
      status === 'upcoming' ? [primary[1], fixture('upcoming-extra'), fixture('next-day', { time: '2026-10-02T00:00:00Z' })] : primary };
  });
  const rows = await api.getMatchesByDate('2026-10-01', { competition: 'PL' });
  assert.equal(rows.length, 204);
  assert.equal(new Set(rows.map(row => row.id)).size, 204);
  assert.equal(rows.find(row => row.id === 'base-0').status, 'FINISHED');
  assert.equal(rows.some(row => row.id === 'next-day'), false);
  assert.equal(calls.length, 4);
  assert.equal(rows.coverage.recovered, 4);
  assert.equal(rows.coverage.returned, rows.length);
  assert.equal(rows.coverage.upstreamReturned, 207);
  assert.equal(rows.coverage.outsideDate, 1);
  assert.equal(rows.coverage.complete, false);
  assert.equal(rows.coverage.partial, true);
  assert.equal(rows.coverage.possiblyTruncated, true);
  assert.equal(rows.coverage.reason, 'provider_result_limit');
  assert.deepEqual(rows.coverage.partitions.map(partition => partition.status), ['live', 'finished', 'upcoming']);
});

test('a failed or capped status partition retains the usable general fixtures with explicit diagnostics', async () => {
  const { api } = provider(url => {
    const status = url.searchParams.get('status');
    if (status === 'finished') throw new Error('offline');
    return { matches: status === 'upcoming' ? capped().map((row, index) => ({ ...row, slug: `extra-${index}` })) :
      status === 'live' ? [fixture('live', { status }), fixture('wrong-status'), null] : capped() };
  });
  const rows = await api.getMatchesByDate('2026-10-01');
  assert.equal(rows.length, 401);
  assert.equal(rows.coverage.complete, false);
  assert.equal(rows.coverage.partitions.find(row => row.status === 'finished').available, false);
  assert.equal(rows.coverage.partitions.find(row => row.status === 'upcoming').possiblyTruncated, true);
  assert.equal(rows.coverage.outsideStatus, 1);
  assert.equal(rows.coverage.invalidRecords, 1);
});

test('uncapped reads filter provider date/competition mistakes and malformed rows without inventing IDs or kickoffs', async () => {
  const { api, calls } = provider(() => ({ matches: [
    fixture('correct', { time: '2026-10-01T20:00:00+03:00' }),
    fixture('previous-utc-day', { time: '2026-10-01T00:30:00+03:00' }),
    fixture('exclusive-end', { time: '2026-10-02T00:00:00Z' }),
    fixture('different-league', { competition: 'La Liga' }),
    fixture('conflicting-scope', { competition_slug: 'spanish-la-liga' }),
    fixture('impossible-day', { time: '2026-02-31T12:00:00Z' }),
    fixture('date-only', { time: '2026-10-01' }),
    fixture(undefined), null,
  ] }));
  const rows = await api.getMatchesByDate('2026-10-01', { competition: 'PL' });
  assert.deepEqual(rows.map(row => row.id), ['correct']);
  assert.equal(calls.length, 1);
  assert.equal(rows.coverage.invalidRecords, 4);
  assert.equal(rows.coverage.outsideDate, 2);
  assert.equal(rows.coverage.outsideCompetition, 2);
  assert.equal(rows.coverage.possiblyTruncated, false);
  assert.equal(rows.coverage.complete, false);
  assert.equal(rows.coverage.reason, 'rejected_provider_records');
});

test('authoritative empty and uncapped scoped reads remain complete; invalid calendar dates never read upstream', async () => {
  const { api, calls } = provider(() => ({ matches: [] }));
  const rows = await api.getMatchesByDate('2026-10-01');
  assert.equal(rows.coverage.available, true);
  assert.equal(rows.coverage.complete, true);
  assert.equal(rows.coverage.partial, false);
  assert.deepEqual(rows.coverage.partitions, []);
  assert.equal(calls.length, 1);
  for (const date of ['2026-02-31', '2026-13-01', 'garbage', ['2026-10-01']]) {
    await assert.rejects(api.getMatchesByDate(date), /Invalid fixture date/);
  }
  assert.equal(calls.length, 1);
});

test('simultaneous capped reads share all four upstream requests and subsequent reads use cached partitions', async () => {
  const { api, calls } = provider(async url => {
    await new Promise(resolve => setImmediate(resolve));
    return { matches: url.searchParams.has('status') ? [] : capped() };
  });
  const rows = await Promise.all(Array.from({ length: 12 }, () => api.getMatchesByDate('2026-10-01')));
  assert.equal(calls.length, 4);
  assert.ok(rows.every(row => row.length === 200 && row.coverage.partial));
  await api.getMatchesByDate('2026-10-01');
  assert.equal(calls.length, 4);
});

test('status partitions across distinct date scopes share a global maximum of three active upstream reads', async () => {
  let active = 0, peak = 0;
  const { api, calls } = provider(async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { matches: url.searchParams.has('status') ? [] :
      capped().map(row => ({ ...row, time: `${url.searchParams.get('date')}T12:00:00Z` })) };
  });
  const rows = await Promise.all(Array.from({ length: 8 }, (_, index) => api.getMatchesByDate(`2026-10-${String(index + 1).padStart(2, '0')}`)));
  assert.equal(peak, 3);
  assert.equal(calls.length, 32);
  assert.ok(rows.every(row => row.length === 200 && row.coverage.partial));
});

test('distinct pending reads are bounded and queue saturation cannot become a successful empty day', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { api, calls } = provider(async () => { await gate; return { matches: [] }; });
  const reads = Promise.allSettled(Array.from({ length: 129 }, (_, index) =>
    api.getMatchesByDate(new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10))));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
  release();
  const settled = await reads;
  assert.equal(settled.filter(row => row.status === 'rejected').length, 1);
  assert.equal(settled.filter(row => row.status === 'fulfilled').length, 128);
  assert.equal(calls.length, 128);
});

test('a failed shared upstream read clears its in-flight entry and a later call can recover', async () => {
  let unavailable = true;
  const { api, calls } = provider(async () => {
    await new Promise(resolve => setImmediate(resolve));
    if (unavailable) throw new Error('offline');
    return { matches: [] };
  }, { cached: false });
  const failed = await Promise.allSettled([api.getMatchesByDate('2026-10-01'), api.getMatchesByDate('2026-10-01')]);
  assert.ok(failed.every(row => row.status === 'rejected'));
  assert.equal(calls.length, 1);
  unavailable = false;
  assert.equal((await api.getMatchesByDate('2026-10-01')).coverage.complete, true);
  assert.equal(calls.length, 2);
});

test('live coverage reports dropped nonlive/other-day records and shares the daily live partition request', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const priorDay = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const { api, calls } = provider(async url => {
    await new Promise(resolve => setImmediate(resolve));
    const status = url.searchParams.get('status');
    return { matches: status === 'live' ? [fixture('real-live', { status, time: `${date}T12:00:00Z` }),
      fixture('carryover-live', { status, time: `${priorDay}T23:59:00Z` }),
      fixture('finished', { status: 'finished', time: `${date}T12:00:00Z` }),
      fixture('old-live', { status, time: '2000-01-01T12:00:00Z' })] : status ? [] :
      capped().map(row => ({ ...row, time: `${date}T12:00:00Z` })) };
  });
  const [daily, live] = await Promise.all([api.getMatchesByDate(date), api.getLiveMatches()]);
  assert.deepEqual(live.map(row => row.id), ['carryover-live', 'real-live']);
  assert.equal(live.coverage.partial, true);
  assert.equal(live.coverage.outsideDate, 1);
  assert.equal(live.coverage.outsideStatus, 1);
  assert.equal(daily.length, 201);
  assert.equal(daily.some(row => row.id === 'carryover-live'), false);
  assert.equal(calls.filter(url => url.searchParams.get('status') === 'live').length, 1);
});

test('documented active statuses survive live filtering including halftime and penalty shootouts', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const statuses = ['live', 'in_progress', '1h', '2h', 'ht', 'first_half', 'second_half',
    'extra_time', 'halftime', 'penalty_shootout'];
  const { api } = provider(() => ({ matches: statuses.map((status, index) =>
    fixture(`live-${index}`, { status, time: `${date}T12:00:00Z` })) }));
  const live = await api.getLiveMatches();
  assert.equal(live.length, statuses.length);
  assert.ok(live.every(row => row.status === 'IN_PLAY'));
  assert.equal(live.coverage.complete, true);
});

test('public calendar coverage retains rejected-record counts and partition diagnostics after scoped adapter filtering', async () => {
  const { api: sc } = provider(url => ({ matches: url.searchParams.has('competition') ? [] :
    [fixture('correct'), fixture('wrong-day', { time: '2026-10-02T00:00:00Z' }), null] }));
  const api = load('../services/sportsDataService', { './sportscoreService': sc,
    './bsdSportsService': { isConfigured: () => false }, './kickoffApiService': {}, '../utils/logger': logger });
  const result = await api.getMatchesByDate('2026-10-01');
  assert.deepEqual(result.data.map(row => row.id), ['correct']);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.invalidRecords, 1);
  assert.equal(result.coverage.outsideDate, 1);
  assert.equal(result.coverage.queries[0].upstreamReturned, 3);
  assert.equal(result.coverage.queries[0].reason, 'rejected_provider_records');
  assert.deepEqual(result.coverage.queries[0].partitions, []);
});
