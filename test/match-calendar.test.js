const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { parseMatchInterval } = require('../utils/matchCalendar');

const logger = { info() {}, warn() {}, error() {} };
function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}
function fixtures(matches = [], coverage = {}) {
  const result = matches.slice();
  Object.defineProperty(result, 'coverage', { value: {
    limit: 200, returned: matches.length, possiblyTruncated: false, ...coverage,
  } });
  return result;
}
function fixture(id, utcDate, code = 'PL') {
  return { id, utcDate, competition: { code, name: code },
    homeTeam: { id: null, name: 'Provider home' }, awayTeam: { id: null, name: 'Provider away' } };
}
function service(provider, bsd = { getMatches: async () => [] }) {
  return load('../services/sportsDataService', {
    './sportscoreService': { getMatchesByDate: provider }, './kickoffApiService': {},
    './bsdSportsService': bsd, '../utils/logger': logger,
  });
}
function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
}
function controller(dataService) {
  return load('../controllers/matchControllers', {
    '../services/sportsDataService': dataService, '../services/bsdSportsService': {}, '../utils/logger': logger,
  });
}

test('UTC+3 local midnight includes previous UTC evening and excludes the next local day', async () => {
  const requested = new Set();
  const data = {
    '2026-09-30': [fixture('before', '2026-09-30T20:59:59Z'), fixture('start', '2026-09-30T21:00:00Z')],
    '2026-10-01': [fixture('last', '2026-10-01T20:59:59Z'), fixture('end', '2026-10-01T21:00:00Z')],
  };
  const api = service(async (date, { competition }) => {
    requested.add(date);
    return fixtures(competition ? [] : data[date]);
  });
  const result = await api.getMatchesInInterval('2026-09-30T21:00:00Z', '2026-10-01T21:00:00Z');
  assert.deepEqual([...requested].sort(), ['2026-09-30', '2026-10-01']);
  assert.deepEqual(result.data.map(match => match.id), ['start', 'last']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.range.toExclusive, true);
});

test('UTC-5 local day retrieves and sorts fixtures from both overlapping UTC dates', async () => {
  const data = {
    '2026-10-01': [fixture('late', '2026-10-01T23:30:00Z'), fixture('start', '2026-10-01T05:00:00Z'),
      fixture('before', '2026-10-01T04:59:59Z')],
    '2026-10-02': [fixture('end', '2026-10-02T05:00:00Z'), fixture('last', '2026-10-02T04:59:59Z')],
  };
  const api = service(async (date, { competition }) => fixtures(competition ? [] : data[date]));
  const result = await api.getMatchesInInterval('2026-10-01T05:00:00.000Z', '2026-10-02T05:00:00.000Z');
  assert.deepEqual(result.data.map(match => match.id), ['start', 'late', 'last']);
  assert.equal(result.coverage.partial, false);
});

test('23-hour and 25-hour daylight-saving days keep the caller UTC boundaries', async () => {
  for (const [from, to, hours] of [
    ['2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 23],
    ['2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25],
  ]) {
    const api = service(async (date, { competition }) => fixtures(competition ? [] : [
      fixture(`midnight-${date}`, `${date}T00:00:00Z`),
      fixture(`end-${date}`, to),
    ]));
    const result = await api.getMatchesInInterval(from, to);
    assert.equal(Date.parse(result.range.to) - Date.parse(result.range.from), hours * 3600000);
    assert.deepEqual(result.data.map(match => match.id), [`midnight-${to.slice(0, 10)}`]);
    assert.equal(result.data.some(match => match.utcDate === to), false);
  }
});

test('a 26-hour interval may overlap three UTC dates and an exclusive UTC midnight fetches only its prior day', async () => {
  const requested = new Set();
  const api = service(async date => { requested.add(date); return fixtures(); });
  const result = await api.getMatchesInInterval('2026-10-01T23:30:00Z', '2026-10-03T01:30:00Z');
  assert.deepEqual([...requested].sort(), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(result.success, true);
  assert.equal(result.coverage.utcDays.length, 3);
  requested.clear();
  await api.getMatchesInInterval('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  assert.deepEqual([...requested], ['2026-10-01']);
});

test('malformed, missing, reversed, impossible and oversized interval bounds fail before provider reads', async () => {
  const api = service(async () => assert.fail('Invalid intervals must not query a provider'));
  for (const [from, to] of [
    [undefined, '2026-10-02T00:00:00Z'], ['2026-10-01T00:00:00Z', undefined],
    [['2026-10-01T00:00:00Z'], '2026-10-02T00:00:00Z'],
    ['2026-10-01', '2026-10-02'], ['2026-10-01T00:00:00', '2026-10-02T00:00:00Z'],
    ['2026-10-01T00:00:00+00:00', '2026-10-02T00:00:00Z'],
    ['2026-02-31T00:00:00Z', '2026-03-01T00:00:00Z'],
    ['2026-10-01T24:00:00Z', '2026-10-02T01:00:00Z'],
    ['2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z'],
    ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'],
    ['2026-10-01T00:00:00Z', '2026-10-02T02:00:00.001Z'],
  ]) {
    const result = await api.getMatchesInInterval(from, to);
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 400);
  }
  assert.equal(parseMatchInterval('2028-02-29T00:00:00Z', '2028-03-01T00:00:00Z').error, undefined);
});

test('provider timestamps with offsets use the actual instant and duplicate supplemental IDs appear once', async () => {
  const same = fixture('exact-provider-id', '2026-10-01T00:30:00+03:00');
  const second = fixture('other-provider-id', '2026-10-01T10:00:00Z');
  const api = service(async (date, { competition }) => fixtures(
    date === '2026-09-30' ? [same] : competition ? [] : [second]
  ));
  const result = await api.getMatchesInInterval('2026-09-30T21:00:00Z', '2026-10-01T21:00:00Z');
  assert.deepEqual(result.data.map(match => match.id), ['exact-provider-id', 'other-provider-id']);
  assert.equal(result.data[0], same);
});

test('one unavailable UTC day returns usable matches with explicit partial coverage', async () => {
  const api = service(async (date, { competition }) => {
    if (date === '2026-10-01') throw Error('provider offline');
    return fixtures(competition ? [] : [fixture('available-day', '2026-09-30T22:00:00Z')]);
  });
  const result = await api.getMatchesInInterval('2026-09-30T21:00:00Z', '2026-10-01T21:00:00Z');
  assert.equal(result.success, true);
  assert.deepEqual(result.data.map(match => match.id), ['available-day']);
  assert.equal(result.coverage.available, true);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.utcDays.map(day => day.available), [true, false]);
});

test('all unavailable UTC days return 503, while an authoritative empty response returns successful empty coverage', async () => {
  const offline = service(async () => { throw Error('offline'); });
  const failed = await offline.getMatchesInInterval('2026-09-30T21:00:00Z', '2026-10-01T21:00:00Z');
  assert.equal(failed.success, false);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.coverage.available, false);
  assert.deepEqual(failed.data, []);
  const available = service(async () => fixtures());
  const empty = await available.getMatchesInInterval('2026-09-30T21:00:00Z', '2026-10-01T21:00:00Z');
  assert.equal(empty.success, true);
  assert.equal(empty.coverage.available, true);
  assert.equal(empty.coverage.complete, true);
  assert.equal(empty.coverage.partial, false);
  assert.deepEqual(empty.data, []);
});

test('a capped UTC-day general feed stays possibly truncated after supplemental matches merge', async () => {
  const api = service(async (date, { competition }) => fixtures(
    date === '2026-10-01' ? [fixture(competition || 'general', '2026-10-01T10:00:00Z')] : [],
    date === '2026-10-01' && !competition ? { returned: 200, possiblyTruncated: true } : {}
  ));
  const result = await api.getMatchesInInterval('2026-09-30T21:00:00Z', '2026-10-01T21:00:00Z');
  assert.equal(result.data.length, 10);
  assert.equal(result.coverage.possiblyTruncated, true);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.utcDays[1].queries[0].returned, 200);
});

test('supplement caps and failures cannot be silently converted into complete calendar coverage', async () => {
  for (const mode of ['capped', 'failed']) {
    const api = service(async (date, { competition }) => {
      if (competition === 'PL' && mode === 'failed') throw Error('league offline');
      return fixtures([], competition === 'PL' && mode === 'capped' ? { possiblyTruncated: true, returned: 200 } : {});
    });
    const result = await api.getMatchesInInterval('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
    assert.equal(result.success, true);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.partial, true);
    assert.equal(result.coverage.possiblyTruncated, mode === 'capped');
  }
});

test('successful league reads survive a failed general feed with incomplete day coverage', async () => {
  const api = service(async (date, { competition }) => {
    if (!competition) throw Error('general offline');
    return fixtures(competition === 'PL' ? [fixture('league-only', `${date}T12:00:00Z`)] : []);
  });
  const result = await api.getMatchesInInterval('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  assert.equal(result.success, true);
  assert.deepEqual(result.data.map(match => match.id), ['league-only']);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.utcDays[0].queries[0].available, false);
});

test('unknown completeness and invalid fixture records remain incomplete and never get invented kickoffs', async () => {
  const api = service(async () => [
    fixture('real', '2026-10-01T12:00:00Z'), fixture('date-only', '2026-10-01'),
    fixture('invalid-date', '2026-02-31T12:00:00Z'), fixture(null, '2026-10-01T12:00:00Z'),
  ]);
  const result = await api.getMatchesInInterval('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  assert.deepEqual(result.data.map(match => match.id), ['real']);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.partial, true);
});

test('BSD fallback data is date-filtered and carries uncertified completeness', async () => {
  const api = service(async () => { throw Error('offline'); }, { getMatches: async () => [
    fixture('bsd_1', '2026-10-01T12:00:00Z'), fixture('bsd_2', '2026-10-02T12:00:00Z'),
  ] });
  const result = await api.getMatchesInInterval('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  assert.equal(result.source, 'bsd');
  assert.deepEqual(result.data.map(match => match.id), ['bsd_1']);
  assert.equal(result.coverage.complete, false);
});

test('controller retains date grouping and returns interval range without a misleading UTC date selector', async () => {
  const calls = [];
  const handler = controller({
    getMatchesByDate: async date => { calls.push(date); return { success: true, source: 'sportscore', data: [fixture('legacy', '2026-10-01T12:00:00Z')] }; },
    getMatchesInInterval: async (from, to) => ({ success: true, source: 'sportscore',
      range: { from, to, toExclusive: true }, coverage: { available: true, partial: false, complete: true },
      data: [fixture('range', '2026-10-01T12:00:00Z', 'PD'), fixture('first-priority', '2026-10-01T10:00:00Z', 'PL')],
    }),
  });
  const old = response();
  await handler.getMatchesByDate({ query: { date: '2026-10-01' } }, old);
  assert.deepEqual(calls, ['2026-10-01']);
  assert.equal(old.body.date, '2026-10-01');
  assert.equal(old.body.total, 1);
  assert.equal(old.body.data[0].matches[0].id, 'legacy');
  const ranged = response();
  await handler.getMatchesByDate({ query: { from: '2026-09-30T21:00:00Z', to: '2026-10-01T21:00:00Z' } }, ranged);
  assert.equal(ranged.statusCode, 200);
  assert.equal(Object.hasOwn(ranged.body, 'date'), false);
  assert.equal(ranged.body.total, 2);
  assert.deepEqual(ranged.body.data.map(group => group.competition.code), ['PL', 'PD']);
  assert.equal(ranged.body.coverage.complete, true);
});

test('controller rejects mixed date and interval and preserves 503 availability metadata', async () => {
  const handler = controller({ getMatchesInInterval: async (from, to) => ({
    success: false, statusCode: 503, source: 'unavailable', message: 'offline',
    range: { from, to, toExclusive: true }, coverage: { available: false, complete: false, partial: true }, data: [],
  }) });
  const mixed = response();
  await handler.getMatchesByDate({ query: { date: '2026-10-01', from: '2026-10-01T00:00:00Z' } }, mixed);
  assert.equal(mixed.statusCode, 400);
  const offline = response();
  await handler.getMatchesByDate({ query: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' } }, offline);
  assert.equal(offline.statusCode, 503);
  assert.equal(offline.body.total, 0);
  assert.equal(offline.body.coverage.available, false);
  assert.deepEqual(offline.body.data, []);
});
