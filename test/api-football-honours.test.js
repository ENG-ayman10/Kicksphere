'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const profile = (extra = {}) => ({ id: 'bsd_p_9063', provider: 'bsd', source: 'bsd',
  name: 'Kylian Mbappé', fullName: 'Kylian Mbappé', shortName: 'K. Mbappé',
  dateOfBirth: '1998-12-20', nationality: 'France', ...extra });
const player = (extra = {}) => ({ id: 999, name: 'K. Mbappe', firstname: 'Kylian', lastname: 'Mbappe',
  birth: { date: '1998-12-20' }, nationality: 'France', ...extra });
const trophy = (extra = {}) => ({ league: 'World Cup', country: 'World', season: 'Russia 2018', place: 'Winner', ...extra });
const envelope = (get, parameters, rows) => ({ get, parameters, errors: [], results: rows.length,
  paging: { current: 1, total: 1 }, response: rows });
const profiles = rows => envelope('players/profiles', { search: 'mbappe', page: '1' }, rows.map(item => ({ player: item })));
const trophies = rows => envelope('trophies', { player: '999' }, rows);
const response = (data, headers = {}) => ({ status: 200, data, headers });
const auditedPlayers = [
  { input: { id: 'bsd_p_9063', provider: 'bsd', name: 'Lionel Messi',
      dateOfBirth: '1987-06-24', nationality: 'Argentina' }, search: 'messi',
    candidate: { id: 78001, name: 'L. Messi', firstname: 'Lionel Andrés', lastname: 'Messi Cuccittini',
      birth: { date: '1987-06-24' }, nationality: 'Argentina' } },
  { input: { id: 'bsd_p_852', provider: 'bsd', name: 'Erling Haaland',
      dateOfBirth: '2000-07-21', nationality: 'Norway' }, search: 'haaland',
    candidate: { id: 78002, name: 'E. Haaland', firstname: 'Erling', lastname: 'Braut Haaland',
      birth: { date: '2000-07-21' }, nationality: 'Norway' } },
];
function auditedAdapter(sample, candidates = [sample.candidate]) {
  return adapter(path => response(path === '/players/profiles'
    ? envelope('players/profiles', { search: sample.search, page: 1 }, candidates.map(item => ({ player: item })))
    : envelope('trophies', { player: String(sample.candidate.id) }, [trophy()])));
}
function adapter(read = path => response(path === '/players/profiles' ? profiles([player()]) : trophies([trophy()])), key = 'mock-api-football-key') {
  const previous = process.env.API_FOOTBALL_KEY;
  process.env.API_FOOTBALL_KEY = key;
  const calls = [], cache = new Map(), writes = [];
  let config;
  const original = Module._load;
  delete require.cache[require.resolve('../services/apiFootballHonoursService')];
  Module._load = function (name, parent, isMain) {
    if (name === 'axios') return { create: options => {
      config = options;
      return { get: async (path, options) => { calls.push({ path, options }); return read(path, options.params, options); } };
    } };
    if (name === './cacheService') return {
      getCached: cacheKey => { const entry = cache.get(cacheKey); return entry && Date.now() - entry.time < entry.ttl ? entry.value : null; },
      setCache: (cacheKey, value, ttl) => { writes.push({ cacheKey, ttl }); cache.set(cacheKey, { value, ttl, time: Date.now() }); },
    };
    return original.call(this, name, parent, isMain);
  };
  try { return { service: require('../services/apiFootballHonoursService'), calls, writes, get config() { return config; } }; }
  finally {
    Module._load = original;
    if (previous === undefined) delete process.env.API_FOOTBALL_KEY;
    else process.env.API_FOOTBALL_KEY = previous;
  }
}
async function clock(run) {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  try { await run(ms => { now += ms; }); } finally { Date.now = original; }
}

test('unconfigured or placeholder keys never consume requests', async () => {
  for (const key of ['', 'replace-me', 'your-api-key', 'changeme']) {
    const { service, calls } = adapter(undefined, key);
    assert.equal(service.isConfigured(), false);
    assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.reason, 'provider_unconfigured');
    assert.equal(calls.length, 0);
  }
});

test('only correctly scoped BSD profiles can request enrichment', async () => {
  const { service, calls } = adapter();
  for (const input of [null, {}, profile({ id: '9063' }), profile({ id: 'ko_p_9063' }), profile({ provider: 'kickoffapi' }), profile({ source: 'sportscore' })]) {
    assert.equal((await service.getPlayerHonoursForProfile(input)).honoursCoverage.available, false);
  }
  assert.equal(calls.length, 0);
});

test('missing or conflicting DOB, name and nationality evidence does not trigger search', async () => {
  const { service, calls } = adapter();
  for (const input of [profile({ dateOfBirth: null }), profile({ dateOfBirth: '1998-02-30' }),
    profile({ dateBorn: '1999-12-20' }), profile({ nationality: '' }), profile({ name: '', fullName: '', shortName: '' })]) {
    assert.equal((await service.getPlayerHonoursForProfile(input)).honoursCoverage.available, false);
  }
  assert.equal(calls.length, 0);
});

test('profile surname searches meet the documented four-character minimum', async () => {
  const { service, calls } = adapter();
  await service.getPlayerHonoursForProfile(profile({ name: 'Someone Lee', fullName: 'Someone Lee' }));
  assert.equal(calls.length, 0);
});

test('verified identity uses exact DOB, accent-normalized full name and nationality', async () => {
  const { service, calls } = adapter();
  const input = Object.freeze(profile());
  const before = JSON.stringify(input);
  const result = await service.getPlayerHonoursForProfile(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(calls.map(call => [call.path, call.options.params]), [
    ['/players/profiles', { search: 'mbappe', page: 1 }], ['/trophies', { player: 999 }],
  ]);
  assert.equal(result.honours[0].playerId, 'bsd_p_9063');
  assert.equal(result.honours[0].provider, 'api-football');
  assert.equal(result.honours[0].providerPlayerId, '999');
  assert.equal(result.honours[0].season, 'Russia 2018');
  assert.equal(result.honours[0].team, '');
  assert.deepEqual({ ...result.honoursCoverage, reason: undefined }, {
    available: true, complete: false, partial: true, source: 'api-football', returned: 1,
    rejected: 0, identityVerified: true, sourcePlayerId: '999', responseComplete: true,
    rawRecords: 1, undatedRowsOmitted: 0, reason: undefined,
  });
});

test('undated summaries do not duplicate dated wins or runner-up editions', async () => {
  const rows = [trophy(), trophy({ season: null }), trophy({ season: '2022', place: '2' }),
    trophy({ season: null, place: '2' }), trophy({ season: '2024', place: 'Unspecified' })];
  const { service } = adapter(path => response(path === '/players/profiles' ? profiles([player()]) : trophies(rows)));
  const result = await service.getPlayerHonoursForProfile(profile());
  assert.deepEqual(result.honours.map(row => [row.season, row.isWinner]),
    [['Russia 2018', true], ['2022', false], ['2024', null]]);
  assert.equal(result.honoursCoverage.rawRecords, 5);
  assert.equal(result.honoursCoverage.returned, 3);
  assert.equal(result.honoursCoverage.undatedRowsOmitted, 2);
  assert.equal(result.honoursCoverage.reason, 'undated_honour_rows_omitted');
  assert.equal(result.honoursCoverage.complete, false);
});

test('an undated-only provider record cannot establish no lifetime titles', async () => {
  const { service } = adapter(path => response(path === '/players/profiles' ? profiles([player()]) : trophies([trophy({ season: null })])));
  const result = await service.getPlayerHonoursForProfile(profile());
  assert.deepEqual(result.honours, []);
  assert.equal(result.honoursCoverage.available, true);
  assert.equal(result.honoursCoverage.complete, false);
  assert.equal(result.honoursCoverage.partial, true);
  assert.equal(result.honoursCoverage.undatedRowsOmitted, 1);
});

test('invalid undated rows stay rejected before summary filtering', async () => {
  const { service } = adapter(path => response(path === '/players/profiles' ? profiles([player()]) : trophies([trophy(), { season: null }])));
  const result = await service.getPlayerHonoursForProfile(profile());
  assert.deepEqual(result.honours, []);
  assert.equal(result.honoursCoverage.available, false);
  assert.equal(result.honoursCoverage.reason, 'invalid_honour_rows');
  assert.equal(result.honoursCoverage.rejected, 1);
});

test('audited provider full names resolve source IDs independently of known numeric IDs', async () => {
  for (const sample of auditedPlayers) {
    const { service, calls } = auditedAdapter(sample, [{ ...sample.candidate, name: '' }]);
    const input = Object.freeze({ ...sample.input });
    const result = await service.getPlayerHonoursForProfile(input);
    assert.equal(result.honoursCoverage.identityVerified, true);
    assert.equal(result.honoursCoverage.sourcePlayerId, String(sample.candidate.id));
    assert.equal(result.honours[0].playerId, input.id);
    assert.equal(result.honours[0].providerPlayerId, String(sample.candidate.id));
    assert.deepEqual(calls.map(call => [call.path, call.options.params]), [
      ['/players/profiles', { search: sample.search, page: 1 }],
      ['/trophies', { player: sample.candidate.id }],
    ]);
  }
});

test('only the captured abbreviations are accepted for audited BSD identities', async () => {
  for (const sample of auditedPlayers) {
    const { service } = auditedAdapter(sample, [{ ...sample.candidate, firstname: null, lastname: null }]);
    const result = await service.getPlayerHonoursForProfile(sample.input);
    assert.equal(result.honoursCoverage.identityVerified, true);
    assert.equal(result.honoursCoverage.available, true);
  }
});

test('audited aliases require the original BSD ID, canonical name, DOB and nationality', async () => {
  for (const sample of auditedPlayers) {
    for (const extra of [{ id: 'bsd_p_1000' }, { name: 'Another ' + sample.search },
      { dateOfBirth: '1990-01-01' }, { nationality: 'England' }]) {
      const { service, calls } = auditedAdapter(sample, [{ ...sample.candidate,
        birth: { date: extra.dateOfBirth || sample.input.dateOfBirth },
        nationality: extra.nationality || sample.input.nationality }]);
      const result = await service.getPlayerHonoursForProfile({ ...sample.input, ...extra });
      assert.equal(result.honoursCoverage.identityVerified, false);
      assert.equal(result.honoursCoverage.available, false);
      assert.equal(result.honoursCoverage.reason, 'player_identity_unverified');
      assert.equal(calls.length, 1);
    }
  }
});

test('audited aliases still reject provider DOB and nationality mismatches', async () => {
  for (const sample of auditedPlayers) {
    for (const extra of [{ birth: { date: '1990-01-01' } }, { nationality: 'England' }]) {
      const { service, calls } = auditedAdapter(sample, [{ ...sample.candidate, ...extra }]);
      const result = await service.getPlayerHonoursForProfile(sample.input);
      assert.equal(result.honoursCoverage.identityVerified, false);
      assert.equal(result.honoursCoverage.reason, 'player_identity_unverified');
      assert.equal(calls.length, 1);
    }
  }
});

test('audited aliases do not allow arbitrary initials or subset name matches', async () => {
  for (const sample of auditedPlayers) {
    for (const name of ['A. ' + sample.search, sample.search, 'X ' + sample.input.name]) {
      const { service, calls } = auditedAdapter(sample, [{ ...sample.candidate, name, firstname: null, lastname: null }]);
      const result = await service.getPlayerHonoursForProfile(sample.input);
      assert.equal(result.honoursCoverage.identityVerified, false);
      assert.equal(result.honoursCoverage.reason, 'player_identity_unverified');
      assert.equal(calls.length, 1);
    }
  }
});

test('matching audited aliases on distinct provider IDs remain ambiguous', async () => {
  for (const sample of auditedPlayers) {
    const { service, calls } = auditedAdapter(sample, [
      { ...sample.candidate, firstname: null, lastname: null },
      { ...sample.candidate, id: sample.candidate.id + 100, name: '' },
    ]);
    const result = await service.getPlayerHonoursForProfile(sample.input);
    assert.equal(result.honoursCoverage.reason, 'ambiguous_player_identity');
    assert.equal(result.honoursCoverage.identityVerified, false);
    assert.deepEqual(result.honours, []);
    assert.equal(calls.length, 1);
  }
});

test('same name with a different birth date cannot borrow trophies', async () => {
  const { service, calls } = adapter(() => response(profiles([player({ birth: { date: '1999-12-20' } })])));
  assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.identityVerified, false);
  assert.equal(calls.length, 1);
});

test('same birth date with a different name cannot establish identity', async () => {
  const { service, calls } = adapter(() => response(profiles([player({ name: 'Different Player', firstname: 'Different', lastname: 'Player' })])));
  assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.available, false);
  assert.equal(calls.length, 1);
});

test('candidate nationality must be present and match the BSD profile', async () => {
  for (const nationality of ['', 'England', null]) {
    const { service, calls } = adapter(() => response(profiles([player({ nationality })])));
    assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.identityVerified, false);
    assert.equal(calls.length, 1);
  }
});

test('two verified source IDs remain ambiguous instead of selecting the first', async () => {
  const { service, calls } = adapter(() => response(profiles([player(), player({ id: 1000 })])));
  assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.reason, 'ambiguous_player_identity');
  assert.equal(calls.length, 1);
});

test('conflicting profiles for the same source ID prevent enrichment', async () => {
  const { service, calls } = adapter(() => response(profiles([player(), player({ birth: { date: '2000-01-01' } })])));
  assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.reason, 'provider_player_identity_conflict');
  assert.equal(calls.length, 1);
});

test('identical duplicate profiles for one ID do not create false ambiguity', async () => {
  const { service } = adapter(path => response(path === '/players/profiles' ? profiles([player(), player()]) : trophies([trophy()])));
  assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.identityVerified, true);
});

test('profile envelopes must echo the search and include a complete valid page', async () => {
  for (const data of [
    { ...profiles([player()]), get: 'players' },
    { ...profiles([player()]), parameters: {} },
    { ...profiles([player()]), parameters: { search: 'different' } },
    { ...profiles([player()]), parameters: { search: 'mbappe', page: 2 } },
    { ...profiles([player()]), errors: { plan: 'Restricted' } },
    { ...profiles([player()]), results: 0 },
    { ...profiles([player()]), response: {} },
    { ...profiles([player()]), paging: { current: 1, total: 2 } },
    { ...profiles([player()]), paging: { current: 2, total: 2 } },
    { ...profiles([player()]), paging: undefined },
  ]) {
    const { service, calls } = adapter(() => response(data));
    assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.available, false);
    assert.equal(calls.length, 1);
  }
});

test('trophy envelopes cannot attach ignored filters, errors or incomplete history pages', async () => {
  for (const data of [
    { ...trophies([trophy()]), get: 'players' },
    { ...trophies([trophy()]), parameters: {} },
    { ...trophies([trophy()]), parameters: { player: '9063' } },
    { ...trophies([trophy()]), errors: { token: 'Invalid' } },
    { ...trophies([trophy()]), results: 0 },
    { ...trophies([trophy()]), paging: { current: 1, total: 2 } },
  ]) {
    const { service, calls } = adapter(path => response(path === '/players/profiles' ? profiles([player()]) : data));
    const result = await service.getPlayerHonoursForProfile(profile());
    assert.equal(result.honoursCoverage.available, false);
    assert.equal(result.honoursCoverage.identityVerified, true);
    assert.equal(result.honoursCoverage.responseComplete, false);
    assert.equal(calls.length, 2);
  }
});

test('foreign source IDs in trophy rows are rejected even if they equal the BSD target', async () => {
  for (const playerId of ['1000', 'bsd_p_9063']) {
    const { service } = adapter(path => response(path === '/players/profiles' ? profiles([player()]) : trophies([trophy({ playerId })])));
    assert.equal((await service.getPlayerHonoursForProfile(profile())).honoursCoverage.reason, 'provider_identity_mismatch');
  }
});

test('a verified empty trophy response does not certify zero lifetime titles', async () => {
  const { service } = adapter(path => response(path === '/players/profiles' ? profiles([player()]) : trophies([])));
  const result = await service.getPlayerHonoursForProfile(profile());
  assert.deepEqual(result.honours, []);
  assert.equal(result.honoursCoverage.available, true);
  assert.equal(result.honoursCoverage.responseComplete, true);
  assert.equal(result.honoursCoverage.complete, false);
  assert.equal(result.honoursCoverage.partial, true);
});

test('malformed trophy records cannot be presented as a complete provider response', async () => {
  const { service } = adapter(path => response(path === '/players/profiles' ? profiles([player()]) : trophies([trophy(), { league: {} }])));
  const result = await service.getPlayerHonoursForProfile(profile());
  assert.equal(result.honoursCoverage.available, false);
  assert.equal(result.honoursCoverage.rejected, 1);
});

test('authentication and timeout failures return safe coverage without exposing credentials', async () => {
  for (const [error, reason] of [[{ response: { status: 401 } }, 'provider_auth_failed'],
    [{ response: { status: 403 } }, 'provider_auth_failed'], [{ code: 'ECONNABORTED' }, 'provider_timeout']]) {
    const { service, calls } = adapter(() => { throw { ...error, message: 'mock-api-football-key', config: { headers: { 'x-apisports-key': 'mock-api-football-key' } } }; });
    const result = await service.getPlayerHonoursForProfile(profile());
    assert.equal(result.honoursCoverage.reason, reason);
    assert.equal(JSON.stringify(result).includes('mock-api-football-key'), false);
    assert.equal(calls.length, 1);
  }
});

test('HTTP 200 account suspension stops lookups across players and can recover after backoff', async () => clock(async advance => {
  let suspended = true;
  const { service, calls } = adapter(path => response(suspended
    ? { ...profiles([]), errors: { access: 'Your account is suspended, check on https://dashboard.api-football.com.' } }
    : path === '/players/profiles' ? profiles([player()]) : trophies([trophy()])));
  const first = await service.getPlayerHonoursForProfile(profile());
  assert.equal(first.honoursCoverage.reason, 'provider_account_suspended');
  assert.equal(first.honoursCoverage.available, false);
  assert.equal(first.honoursCoverage.identityVerified, false);
  assert.deepEqual(first.honours, []);
  const other = await service.getPlayerHonoursForProfile(profile({ id: 'bsd_p_852' }));
  assert.equal(other.honoursCoverage.reason, 'provider_account_suspended');
  assert.equal(calls.length, 1);
  advance(5 * 60 * 1000 - 1);
  await service.getPlayerHonoursForProfile(profile({ id: 'bsd_p_100' }));
  assert.equal(calls.length, 1);
  suspended = false;
  advance(1);
  const recovered = await service.getPlayerHonoursForProfile(profile());
  assert.equal(recovered.honoursCoverage.available, true);
  assert.equal(recovered.honoursCoverage.identityVerified, true);
  assert.equal(calls.length, 3);
}));

test('suspension during trophy lookup preserves verified identity and blocks other lookups', async () => {
  const { service, calls } = adapter(path => response(path === '/players/profiles'
    ? profiles([player()])
    : { ...trophies([]), errors: { access: 'Your account is suspended, check on https://dashboard.api-football.com.' } }));
  const result = await service.getPlayerHonoursForProfile(profile());
  assert.equal(result.honoursCoverage.reason, 'provider_account_suspended');
  assert.equal(result.honoursCoverage.identityVerified, true);
  assert.equal(result.honoursCoverage.sourcePlayerId, '999');
  assert.equal(result.honoursCoverage.available, false);
  assert.deepEqual(result.honours, []);
  await service.getPlayerHonoursForProfile(profile({ id: 'bsd_p_852' }));
  assert.equal(calls.length, 2);
});

test('positive results cache for 24 hours and caller mutation does not alter cached data', async () => clock(async advance => {
  const { service, calls, writes } = adapter();
  const first = await service.getPlayerHonoursForProfile(profile());
  first.honours[0].name = 'Changed by caller';
  advance(24 * 60 * 60 * 1000 - 1);
  assert.equal((await service.getPlayerHonoursForProfile(profile())).honours[0].name, 'World Cup');
  assert.equal(calls.length, 2);
  assert.equal(writes[0].ttl, 24 * 60 * 60 * 1000);
  advance(1);
  await service.getPlayerHonoursForProfile(profile());
  assert.equal(calls.length, 4);
}));

test('negative results cache for five minutes and identity changes require revalidation', async () => clock(async advance => {
  const { service, calls, writes } = adapter(() => response(profiles([])));
  await service.getPlayerHonoursForProfile(profile());
  advance(5 * 60 * 1000 - 1);
  await service.getPlayerHonoursForProfile(profile());
  assert.equal(calls.length, 1);
  assert.equal(writes[0].ttl, 5 * 60 * 1000);
  advance(1);
  await service.getPlayerHonoursForProfile(profile());
  assert.equal(calls.length, 2);
  for (const extra of [{ id: 'bsd_p_852' }, { name: 'Different name' }, { dateOfBirth: '2000-01-01' }, { nationality: 'Brazil' }]) {
    await service.getPlayerHonoursForProfile(profile(extra));
  }
  assert.equal(calls.length, 6);
  assert.equal(writes.every(write => !write.cacheKey.includes('Mbapp') && !write.cacheKey.includes('1998-12-20')), true);
}));

test('concurrent requests for the same identity coalesce to one two-call lookup', async () => {
  const { service, calls } = adapter();
  const results = await Promise.all([service.getPlayerHonoursForProfile(profile()), service.getPlayerHonoursForProfile(profile())]);
  assert.equal(calls.length, 2);
  assert.deepEqual(results[0], results[1]);
  assert.notEqual(results[0], results[1]);
});

test('429 Retry-After blocks other profiles without retries until the window ends', async () => clock(async advance => {
  const { service, calls } = adapter(() => { throw { response: { status: 429, headers: { 'retry-after': '120' } } }; });
  await service.getPlayerHonoursForProfile(profile());
  await service.getPlayerHonoursForProfile(profile({ id: 'bsd_p_852' }));
  assert.equal(calls.length, 1);
  advance(120000);
  await service.getPlayerHonoursForProfile(profile({ id: 'bsd_p_100' }));
  assert.equal(calls.length, 2);
}));

test('daily quota exhaustion prevents the second request and respects supplied daily reset', async () => clock(async advance => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const { service, calls } = adapter(() => response(profiles([player()]), {
    'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-reset': String(reset),
  }));
  const result = await service.getPlayerHonoursForProfile(profile());
  assert.equal(result.honoursCoverage.reason, 'provider_daily_quota_exhausted');
  assert.equal(calls.length, 1);
  await service.getPlayerHonoursForProfile(profile({ id: 'bsd_p_852' }));
  assert.equal(calls.length, 1);
  advance(3600000);
  await service.getPlayerHonoursForProfile(profile({ id: 'bsd_p_100' }));
  assert.equal(calls.length, 2);
}));

test('fixed provider origin, short timeouts and disabled redirects keep keys out of URLs', async () => {
  const loaded = adapter();
  await loaded.service.getPlayerHonoursForProfile(profile());
  assert.equal(loaded.config.baseURL, 'https://v3.football.api-sports.io');
  assert.equal(loaded.config.headers['x-apisports-key'], 'mock-api-football-key');
  assert.equal(loaded.config.maxRedirects, 0);
  assert.ok(loaded.config.timeout > 0 && loaded.config.timeout <= 4000);
  for (const call of loaded.calls) {
    assert.equal(call.options.maxRedirects, 0);
    assert.ok(call.options.timeout <= 4000);
    assert.equal(call.path.includes('mock-api-football-key'), false);
    assert.equal(JSON.stringify(call.options.params).includes('mock-api-football-key'), false);
  }
  assert.strictEqual(loaded.calls[0].options.signal, loaded.calls[1].options.signal);
  const redirected = adapter(() => { throw { response: { status: 302 } }; });
  assert.equal((await redirected.service.getPlayerHonoursForProfile(profile())).honoursCoverage.reason, 'provider_redirect_refused');
  assert.equal(redirected.calls.length, 1);
});

test('the shared lookup deadline aborts transport and returns the original source as unavailable', async () => {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let budget;
  AbortSignal.timeout = ms => { budget = ms; return controller.signal; };
  try {
    const { service, calls } = adapter((_path, _params, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' }), { once: true });
    }));
    const request = service.getPlayerHonoursForProfile(profile());
    controller.abort();
    const result = await request;
    assert.equal(budget, 4500);
    assert.equal(result.honoursCoverage.reason, 'provider_timeout');
    assert.equal(result.honoursCoverage.available, false);
    assert.deepEqual(result.honours, []);
    assert.equal(calls.length, 1);
  } finally { AbortSignal.timeout = originalTimeout; }
});
