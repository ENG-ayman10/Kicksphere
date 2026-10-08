const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup(read) {
  const previousKey = process.env.KICKOFF_API_KEY;
  process.env.KICKOFF_API_KEY = 'unit-test-only';
  const file = require.resolve('../services/kickoffApiService');
  delete require.cache[file];
  const calls = [], cache = new Map();
  const original = Module._load;
  const mocks = {
    axios: { create: () => ({ get: async (endpoint, { params }) => {
      calls.push({ endpoint, params });
      return { data: await read(endpoint, params, calls.length) };
    } }) },
    '../utils/logger': { info() {}, warn() {}, error() {} },
    './cacheService': {
      getCached(key, customTtl) {
        const entry = cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.at < (customTtl ?? entry.ttl)) return entry.value;
        cache.delete(key); return null;
      },
      setCache(key, value, ttl = 60000) { cache.set(key, { value, ttl, at: Date.now() }); },
    },
  };
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  let api;
  try { api = require(file); }
  finally {
    Module._load = original;
    if (previousKey === undefined) delete process.env.KICKOFF_API_KEY;
    else process.env.KICKOFF_API_KEY = previousKey;
  }
  return { api, calls, cache };
}

const envelope = rows => ({ response: rows, errors: [], results: rows.length, paging: { current: 1, total: 1 } });
const fixture = (id = 700, changes = {}) => ({ fixture: { id, date: '2026-10-08T20:00:00Z', status: { short: 'FT' } },
  teams: { home: { id: 42, name: 'Home' }, away: { id: 50, name: 'Away' } }, goals: { home: 1, away: 0 }, ...changes });

test('eight cold profile requests use one upstream biography and one honours read', async () => {
  const gate = deferred();
  const { api, calls } = setup(async endpoint => {
    if (endpoint === '/api/v1/trophies') return envelope([]);
    await gate.promise;
    return envelope([{ player: { id: 1100, name: 'Verified Player' }, statistics: [] }]);
  });
  const reads = Array.from({ length: 8 }, () => api.getPlayerDetails('ko_p_1100', { season: 2026 }));
  assert.equal(calls.length, 1);
  gate.resolve();
  const results = await Promise.all(reads);
  assert.ok(results.every(result => result.id === 'ko_p_1100'));
  assert.equal(calls.filter(call => call.endpoint === '/api/v1/players').length, 1);
  assert.equal(calls.filter(call => call.endpoint === '/api/v1/trophies').length, 1);
  await api.getPlayerDetails('ko_p_1100', { season: 2026 });
  assert.equal(calls.length, 2);
});

test('request coalescing sorts parameters while preserving endpoint and full season scope', async () => {
  const gate = deferred();
  const { api, calls } = setup(async (endpoint, params) => { await gate.promise; return { endpoint, params, response: [{ name: 'Original' }] }; });
  const a = api.safeFetch('/api/v1/players', { id: 1100, season: 2026 });
  const b = api.safeFetch('/api/v1/players', { season: 2026, id: 1100 });
  const c = api.safeFetch('/api/v1/players', { id: 1100, season: 2025 });
  const d = api.safeFetch('/api/v1/teams', { id: 1100, season: 2026 });
  assert.equal(calls.length, 3);
  gate.resolve();
  const results = await Promise.all([a, b, c, d]);
  results[0].response[0].name = 'Changed by one consumer';
  assert.equal(results[1].response[0].name, 'Original');
  assert.equal(results[2].params.season, 2025);
  assert.equal(results[3].endpoint, '/api/v1/teams');
});

test('provider pending requests stay bounded and release capacity after completion', async () => {
  const gate = deferred();
  const { api, calls } = setup(async () => { await gate.promise; return envelope([]); });
  const reads = Array.from({ length: 65 }, (_, id) => api.safeFetch('/api/v1/players', { id: id + 1, season: 2026 }));
  assert.equal(calls.length, 64);
  assert.equal(await reads[64], null);
  gate.resolve();
  assert.ok((await Promise.all(reads.slice(0, 64))).every(Boolean));
  assert.ok(await api.safeFetch('/api/v1/players', { id: 65, season: 2026 }));
  assert.equal(calls.length, 65);
});

const lists = [
  ['live', api => api.getLiveMatches()],
  ['day fixtures', api => api.getMatchesByDate('2026-10-08')],
  ['league fixtures', api => api.getLeagueFixtures('PL', 15)],
  ['standings', api => api.getStandings('PL', 2026)],
  ['scorers', api => api.getTopScorers('PL', 20, 2026)],
];
for (const [label, read] of lists) {
  for (const failure of ['transport', 'access error', 'malformed response']) {
    test(`${label} does not cache ${failure} as a successful empty list`, async () => {
      const { api, calls } = setup((_endpoint, _params, count) => {
        if (count > 1) return envelope([]);
        if (failure === 'transport') throw new Error('temporarily unavailable');
        if (failure === 'access error') return { response: [], errors: { access: 'Unavailable account' } };
        return { response: {} };
      });
      const failed = await read(api);
      assert.deepEqual(failed, []);
      assert.equal(failed.coverage.available, false);
      assert.equal(calls.length, 1);
      const recovered = await read(api);
      assert.deepEqual(recovered, []);
      assert.notEqual(recovered.coverage?.available, false);
      assert.equal(calls.length, 2);
      await read(api);
      assert.equal(calls.length, 2, 'A provider-confirmed empty result remains cacheable');
    });
  }
}

test('standings for a different declared season or competition cannot populate the requested cache', async () => {
  for (const wrong of [{ id: 39, season: 2025 }, { id: 140, season: 2026 }]) {
    const { api, calls } = setup((_endpoint, _params, count) => envelope([{ league: {
      ...(count === 1 ? wrong : { id: 39, season: 2026 }), standings: [[{ rank: 1, team: { id: 42, name: 'Verified Club' }, points: 21 }]],
    } }]));
    const failed = await api.getStandings('PL', 2026);
    assert.equal(failed.coverage.available, false);
    assert.equal(failed.coverage.reason, 'provider_statistics_scope_mismatch');
    const current = await api.getStandings('PL', 2026);
    assert.equal(current[0].team.id, 'ko_t_42');
    assert.equal(current[0].season, 2026);
    await api.getStandings('PL', 2026);
    assert.equal(calls.length, 2);
  }
});

test('a declared league without its standings table stays unavailable and retries', async () => {
  const { api, calls } = setup((_endpoint, _params, count) => count === 1
    ? envelope([{ league: { id: 39, season: 2026 } }]) : envelope([]));
  assert.equal((await api.getStandings('PL', 2026)).coverage.available, false);
  assert.deepEqual(await api.getStandings('PL', 2026), []);
  assert.equal(calls.length, 2);
});

test('standings preserve every declared cup group instead of only the first table', async () => {
  const { api } = setup(() => envelope([{ league: { id: 1, season: 2026, standings: [
    [{ rank: 1, group: 'Group A', team: { id: 26, name: 'Argentina' }, points: 9 }],
    [{ rank: 1, group: 'Group B', team: { id: 6, name: 'Brazil' }, points: 7 }],
  ] } }]));
  const rows = await api.getStandings('WC', 2026);
  assert.deepEqual(rows.map(row => [row.team.id, row.group, row.points]),
    [['ko_t_26', 'Group A', 9], ['ko_t_6', 'Group B', 7]]);
});

test('standings reject mismatched echoed query scope even when table metadata looks correct', async () => {
  for (const parameters of [{ league: 140, season: 2026 }, { league: 39, season: 2025 }]) {
    const { api, calls } = setup((_endpoint, _params, count) => count === 1 ? {
      ...envelope([{ league: { id: 39, season: 2026, standings: [[]] } }]), parameters,
    } : envelope([]));
    assert.equal((await api.getStandings('PL', 2026)).coverage.available, false);
    assert.deepEqual(await api.getStandings('PL', 2026), []);
    assert.equal(calls.length, 2);
  }
});

const scorer = (changes = {}) => ({ player: { id: 1100, name: 'Verified Player' },
  statistics: [{ team: { id: 50, name: 'Verified Club', logo: 'https://provider.test/club.png' },
    league: { id: 39, season: 2026 }, games: { appearances: 8 }, goals: { total: 10, assists: 2 } }], ...changes });

test('scorers preserve supplied nested club and select only requested league-season metrics', async () => {
  const source = scorer();
  source.statistics.unshift({ team: { id: 529, name: 'Foreign Club' }, league: { id: 140, season: 2025 },
    games: { appearences: 22 }, goals: { total: 99, assists: 80 } });
  const { api } = setup(() => envelope([source]));
  const rows = await api.getTopScorers('PL', 20, 2026);
  assert.deepEqual(rows[0].team, { id: 'ko_t_50', provider: 'kickoffapi', providerId: '50',
    name: 'Verified Club', crest: 'https://provider.test/club.png' });
  assert.equal(rows[0].goals, 10);
  assert.equal(rows[0].assists, 2);
  assert.equal(rows[0].playedMatches, 8);
  assert.equal(rows.coverage.complete, false);
});

test('foreign scorers are excluded while valid rows remain partial and recover on next read', async () => {
  let repaired = false;
  const { api, calls } = setup(() => envelope(repaired ? [scorer()] : [scorer(), scorer({ statistics: [{
    team: { id: 529, name: 'Foreign' }, league: { id: 140, season: 2026 }, goals: { total: 99 },
  }] })]));
  const partial = await api.getTopScorers('PL', 20, 2026);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].goals, 10);
  assert.equal(partial.coverage.rejectedRows, 1);
  assert.equal(partial.coverage.partial, true);
  repaired = true;
  assert.equal((await api.getTopScorers('PL', 20, 2026)).coverage.rejectedRows, 0);
  await api.getTopScorers('PL', 20, 2026);
  assert.equal(calls.length, 2);
});

test('scorer query contradictions and foreign-only bodies cannot masquerade as requested rankings', async () => {
  for (const first of [{ ...envelope([scorer()]), parameters: { league: 39, season: 2025 } },
    envelope([scorer({ statistics: [{ league: { id: 140, season: 2026 }, goals: { total: 99 } }] })]),
    envelope([scorer({ team: { id: 529, name: 'Conflicting Club' } })])]) {
    const { api, calls } = setup((_endpoint, _params, count) => count === 1 ? first : envelope([scorer()]));
    assert.equal((await api.getTopScorers('PL', 20, 2026)).coverage.available, false);
    assert.equal((await api.getTopScorers('PL', 20, 2026))[0].goals, 10);
    assert.equal(calls.length, 2);
  }
});

test('two eligible scorer scopes never borrow arbitrary first-block statistics or team', async () => {
  const source = scorer();
  source.statistics.push({ team: { id: 42, name: 'Other Eligible Club' }, league: { id: 39, season: 2026 },
    goals: { total: 4, assists: 1 } });
  const { api } = setup(() => envelope([source]));
  const row = (await api.getTopScorers('PL', 20, 2026))[0];
  assert.equal(row.goals, null);
  assert.equal(row.assists, null);
  assert.equal(row.team.id, '');
});

test('partial team fixture responses preserve their available side and retry the missing side', async () => {
  let failedUpcoming = true;
  const { api, calls } = setup((_endpoint, params) => params.next && failedUpcoming
    ? { errors: { access: 'temporarily unavailable' }, response: [] }
    : envelope(params.last ? [fixture()] : [fixture(701)]));
  const partial = await api.getTeamFixtures('ko_t_42');
  assert.equal(partial.recent[0].id, 'ko_700');
  assert.deepEqual(partial.upcoming, []);
  assert.equal(partial.coverage.partial, true);
  assert.equal(partial.coverage.recentAvailable, true);
  assert.equal(partial.coverage.upcomingAvailable, false);
  failedUpcoming = false;
  const current = await api.getTeamFixtures('ko_t_42');
  assert.equal(current.upcoming[0].id, 'ko_701');
  assert.equal(current.coverage.complete, true);
  await api.getTeamFixtures('ko_t_42');
  assert.equal(calls.length, 4);
});

test('both failed team fixture sides return unavailable instead of a cached successful empty object', async () => {
  let fail = true;
  const { api, calls } = setup(() => fail ? null : envelope([]));
  assert.equal(await api.getTeamFixtures('ko_t_42'), null);
  fail = false;
  const current = await api.getTeamFixtures('ko_t_42');
  assert.deepEqual(current.recent, []);
  assert.deepEqual(current.upcoming, []);
  assert.equal(current.coverage.available, true);
  await api.getTeamFixtures('ko_t_42');
  assert.equal(calls.length, 4);
});

test('foreign team fixture records are dropped without losing valid same-team fixtures or caching partial results', async () => {
  let repaired = false;
  const foreign = fixture(800, { teams: { home: { id: 529, name: 'Foreign' }, away: { id: 541, name: 'Other' } } });
  const { api, calls } = setup(() => envelope(repaired ? [fixture()] : [fixture(), foreign]));
  const partial = await api.getTeamFixtures('ko_t_42');
  assert.deepEqual(partial.recent.map(row => row.id), ['ko_700']);
  assert.deepEqual(partial.upcoming.map(row => row.id), ['ko_700']);
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.rejectedRows, 2);
  assert.equal(partial.coverage.reason, 'provider_fixture_scope_mismatch');
  repaired = true;
  assert.equal((await api.getTeamFixtures('ko_t_42')).coverage.complete, true);
  await api.getTeamFixtures('ko_t_42');
  assert.equal(calls.length, 4);
});

test('foreign-only team fixtures and contradictory echoed team filters stay unavailable until recovery', async () => {
  const foreign = fixture(800, { teams: { home: { id: 529, name: 'Foreign' }, away: { id: 541, name: 'Other' } } });
  for (const first of [envelope([foreign]), { ...envelope([fixture()]), parameters: { team: 529 } }]) {
    let repaired = false;
    const { api, calls } = setup(() => repaired ? envelope([fixture()]) : first);
    assert.equal(await api.getTeamFixtures('ko_t_42'), null);
    repaired = true;
    assert.equal((await api.getTeamFixtures('ko_t_42')).coverage.complete, true);
    assert.equal(calls.length, 4);
  }
});

test('single fixture reads reject a foreign first record and retry the requested identity', async () => {
  const { api, calls } = setup((_endpoint, _params, count) => envelope(count === 1 ? [fixture(999)] : [fixture(999), fixture(700)]));
  assert.equal(await api.getMatchDetails('ko_700'), null);
  assert.equal((await api.getMatchDetails('ko_700')).id, 'ko_700');
  assert.equal((await api.getMatchDetails('ko_700')).id, 'ko_700');
  assert.equal(calls.length, 2);
});

test('a shared 429 failure clears pending reads and keeps the existing quota backoff', async () => {
  const originalNow = Date.now;
  let clock = 1791470000000;
  Date.now = () => clock;
  try {
    const { api, calls } = setup((_endpoint, _params, count) => {
      if (count > 1) return envelope([]);
      const error = new Error('rate limited'); error.response = { status: 429 }; throw error;
    });
    const [a, b] = await Promise.all([api.safeFetch('/api/v1/players', { id: 1100 }), api.safeFetch('/api/v1/players', { id: 1100 })]);
    assert.equal(a, null); assert.equal(b, null);
    assert.equal(calls.length, 1);
    assert.equal(await api.safeFetch('/api/v1/players', { id: 1101 }), null);
    assert.equal(calls.length, 1);
    clock += 60 * 60 * 1000;
    assert.ok(await api.safeFetch('/api/v1/players', { id: 1100 }));
    assert.equal(calls.length, 2);
  } finally { Date.now = originalNow; }
});
