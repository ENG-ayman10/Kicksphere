const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function provider(read) {
  const values = new Map(), calls = [];
  const mocks = {
    axios: { get: async value => {
      const url = new URL(value); calls.push(url);
      return { data: await read(url) };
    } },
    '../utils/logger': { info() {}, warn() {}, error() {} },
    './cacheService': { getCached: key => values.get(key), setCache: (key, value) => values.set(key, value) },
  };
  const file = '../services/sportscoreService';
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let api;
  try { api = require(file); } finally { Module._load = original; }
  return { api, calls, values };
}

const fixture = (slug, overrides = {}) => ({ slug, home: 'Home Club', away: 'Away Club',
  competition: 'Local League', time: '2026-10-07T12:00:00Z', status: 'upcoming', ...overrides });
const capped = () => Array.from({ length: 200 }, (_, index) => fixture(`base-${index}`));
const exact = overrides => fixture(undefined, {
  url: '/football/match/home-club-vs-away-club/token1/', ...overrides,
});

test('rows supplied beyond the requested 200 survive normalization with no additional recovery requests', async () => {
  const primary = Array.from({ length: 276 }, (_, index) => fixture(`source-${index}`, {
    home_slug: `home-${index}`, away_slug: `away-${index}`,
  }));
  const { api, calls } = provider(url => {
    assert.equal(url.searchParams.get('limit'), '200');
    assert.equal(url.searchParams.has('page') || url.searchParams.has('cursor') || url.searchParams.has('offset'), false);
    return { matches: url.searchParams.has('status') ? [] : primary };
  });
  const rows = await api.getMatchesByDate('2026-10-07');
  assert.equal(rows.length, 276);
  assert.equal(rows.at(-1).id, 'source-275');
  assert.equal(rows.at(-1).homeTeam.id, 'sc_t_home-275');
  assert.equal(rows.coverage.upstreamReturned, 276);
  assert.equal(rows.coverage.locallyDiscarded, 0);
  assert.equal(rows.coverage.partial, true);
  assert.equal(rows.coverage.reason, 'provider_result_limit');
  assert.equal(calls.length, 4);
  await api.getMatchesByDate('2026-10-07');
  assert.equal(calls.length, 4, 'The four existing batch requests remain cached');
});

test('oversized malformed responses stay bounded and explicitly report local row loss', async () => {
  const { api, calls } = provider(url => ({ matches: url.searchParams.has('status') ? [] :
    Array.from({ length: 1003 }, (_, index) => fixture(`source-${index}`)) }));
  const rows = await api.getMatchesByDate('2026-10-07');
  assert.equal(rows.length, 1000);
  assert.equal(rows.coverage.upstreamReturned, 1003);
  assert.equal(rows.coverage.locallyDiscarded, 3);
  assert.equal(rows.coverage.complete, false);
  assert.equal(rows.coverage.reason, 'local_processing_limit');
  assert.equal(calls.length, 4);
});

test('public daily query coverage preserves reported local row loss and its partial reason', async () => {
  const { api: sportscore } = provider(url => ({ matches:
    url.searchParams.has('status') || url.searchParams.has('competition') ? [] :
      Array.from({ length: 1003 }, (_, index) => fixture(`source-${index}`)) }));
  const mocks = { './sportscoreService': sportscore,
    './bsdSportsService': { isConfigured: () => false }, './kickoffApiService': {},
    '../utils/logger': { info() {}, warn() {}, error() {} } };
  const file = '../services/sportsDataService';
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let api;
  try { api = require(file); } finally { Module._load = original; }
  const result = await api.getMatchesByDate('2026-10-07');
  assert.equal(result.data.length, 1000);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.complete, false);
  const query = result.coverage.queries.find(row => row.provider === 'sportscore' && row.competition === null);
  assert.equal(query.locallyDiscarded, 3);
  assert.equal(query.upstreamReturned, 1003);
  assert.equal(query.complete, false);
  assert.equal(query.reason, 'local_processing_limit');
});

test('a status partition retains explicit team identities from the exact duplicate and keeps its new score', async () => {
  const primary = capped();
  primary[0] = exact({ home_slug: 'home-club', away_team_url: '/football/team/away-club/',
    home_score: 0, away_score: 0 });
  const { api, calls, values } = provider(url => ({ matches: url.searchParams.get('status') === 'finished' ?
    [exact({ status: 'finished', home_score: 2, away_score: 1 })] :
    url.searchParams.has('status') ? [] : primary }));
  const rows = await api.getMatchesByDate('2026-10-07');
  const row = rows.find(match => match.id === 'home-club-vs-away-clubtoken1');
  assert.equal(rows.length, 200);
  assert.equal(row.status, 'FINISHED');
  assert.deepEqual(row.score.fullTime, { home: 2, away: 1 });
  assert.equal(row.homeTeam.id, 'sc_t_home-club');
  assert.equal(row.awayTeam.id, 'sc_t_away-club');
  assert.equal(row.homeTeam.identityBasis, 'provider_slug_or_url');
  assert.equal(row.matchLocator.token, 'token1');
  assert.equal(values.get(`sportscore:fixture:${row.id}`).homeTeam.id, 'sc_t_home-club');
  assert.equal(calls.length, 4, 'Retaining source identity does not fetch teams or details');
});

test('duplicate identity retention also works within a batch and from a later equally ranked row', async () => {
  const { api, calls } = provider(() => ({ matches: [
    exact({ home_score: 1, away_score: 0 }),
    exact({ home_slug: 'home-club', away_id: 321, home_score: 0, away_score: 0 }),
  ] }));
  const [row] = await api.getMatchesByDate('2026-10-07');
  assert.equal(row.homeTeam.id, 'sc_t_home-club');
  assert.equal(row.awayTeam.id, 'sc_t_321');
  assert.deepEqual(row.score.fullTime, { home: 1, away: 0 }, 'Identity enrichment does not select another score');
  assert.equal(calls.length, 1);
});

test('same concatenated fixture ID cannot transfer identity across contradictory URL tokens, teams or scope', async () => {
  const cases = [
    [exact({ url: '/football/match/home-club-vs-away-cluba/bc/', home_slug: 'home-club' }),
      exact({ url: '/football/match/home-club-vs-away-clubab/c/', status: 'finished' })],
    [exact({ home_slug: 'home-club' }), exact({ home: 'Other Club', status: 'finished' })],
    [exact({ home_slug: 'home-club' }), exact({ competition: 'Other Local League', status: 'finished' })],
    [exact({ home_slug: 'home-club' }), fixture('home-club-vs-away-clubtoken1', { status: 'finished' })],
  ];
  for (const [identified, selected] of cases) {
    const { api, calls } = provider(() => ({ matches: [identified, selected] }));
    const [row] = await api.getMatchesByDate('2026-10-07');
    assert.equal(row.status, 'FINISHED');
    assert.equal(row.homeTeam.id, null);
    assert.equal(calls.length, 1);
  }
});

test('contradictory explicit team IDs and conflict evidence stay unresolved through further duplicates', async () => {
  for (const conflicting of [
    exact({ status: 'finished', home_slug: 'other-club' }),
    exact({ status: 'finished', home_slug: 'home-club', home_url: '/football/team/other-club/' }),
  ]) {
    const { api } = provider(() => ({ matches: [
      exact({ home_slug: 'home-club' }), conflicting, exact({ home_slug: 'home-club' }),
    ] }));
    const [row] = await api.getMatchesByDate('2026-10-07');
    assert.equal(row.homeTeam.id, null);
    assert.equal(row.homeTeam.identityConflict, true);
    assert.equal(row.homeTeam.identityBasis, null);
  }
});

test('extra-row retention still respects provider 429 backoff without retrying new date scopes', async () => {
  const { api, calls } = provider(url => {
    if (url.searchParams.get('status') === 'finished') {
      const error = new Error('limited');
      error.response = { status: 429, headers: { 'retry-after': '60' } };
      throw error;
    }
    return { matches: url.searchParams.has('status') ? [] :
      Array.from({ length: 201 }, (_, index) => fixture(`source-${index}`)) };
  });
  const rows = await api.getMatchesByDate('2026-10-07');
  assert.equal(rows.length, 201);
  assert.equal(rows.coverage.partitions.find(partition => partition.status === 'finished').available, false);
  const requests = calls.length;
  await assert.rejects(api.getMatchesByDate('2026-10-08'), /Fixture provider unavailable/);
  assert.equal(calls.length, requests);
});
