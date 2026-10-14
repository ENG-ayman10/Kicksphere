'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const logger = { info() {}, warn() {}, error() {} };
function loadProvider(read, overrides = {}) {
  const cache = new Map(), calls = [];
  const mocks = {
    axios: { get: async value => {
      const request = new URL(value);
      calls.push(request);
      return { data: await read(request) };
    } },
    '../utils/logger': logger,
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
    ...overrides,
  };
  delete require.cache[require.resolve('../services/sportscoreService')];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let api;
  try { api = require('../services/sportscoreService'); }
  finally { Module._load = original; }
  return { api, calls, cache };
}

async function withScope(mode, work) {
  const original = process.env.SPORTS_COMPETITION_SCOPE;
  if (mode === undefined) delete process.env.SPORTS_COMPETITION_SCOPE;
  else process.env.SPORTS_COMPETITION_SCOPE = mode;
  try { return await work(); }
  finally {
    if (original === undefined) delete process.env.SPORTS_COMPETITION_SCOPE;
    else process.env.SPORTS_COMPETITION_SCOPE = original;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const fixture = (id, competition = 'Premier League', extra = {}) => ({
  slug: id, home: 'Home', away: 'Away', home_slug: 'home-club', away_slug: 'away-club',
  competition, time: `${today()}T12:00:00Z`, status: 'upcoming', ...extra,
});
const mixed = () => [
  fixture('premier'),
  fixture('international', 'UEFA Champions League', { away: 'Israeli club' }),
  fixture('qatar', 'Qatar Stars League'),
  fixture('israel', 'Israel B League'),
  fixture('regional', 'Guatemala Division 2'),
];

test('focused calendar retains major, Arab and international scopes without turning exclusions into invalid data', async () => {
  await withScope('focused', async () => {
    const { api, calls } = loadProvider(request => {
      assert.equal(request.pathname, '/api/v1/fixtures/');
      return { matches: mixed() };
    });
    const rows = await api.getMatchesByDate(today());
    assert.deepEqual(rows.map(row => row.id), ['premier', 'international', 'qatar']);
    assert.equal(calls.length, 1, 'Filtering the mixed feed does not invent per-league requests');
    assert.equal(rows.coverage.upstreamReturned, 5);
    assert.equal(rows.coverage.returned, 3);
    assert.equal(rows.coverage.accepted, 3);
    assert.equal(rows.coverage.competitionScope, 'focused');
    assert.equal(rows.coverage.excludedByScope, 2);
    assert.equal(rows.coverage.invalidRecords, 0);
    assert.equal(rows.coverage.complete, true);
    assert.equal(rows.coverage.partial, false);
  });
});

test('focused live feed omits excluded fixtures before score caching and leaves real malformed coverage visible', async () => {
  await withScope('focused', async () => {
    const { api, cache } = loadProvider(() => ({ matches: [...mixed().map(row => ({ ...row, status: 'live' })), null] }));
    const rows = await api.getLiveMatches();
    assert.deepEqual(rows.map(row => row.id), ['premier', 'international', 'qatar']);
    assert.equal(cache.has('sportscore:fixture:israel'), false);
    assert.equal(cache.has('sportscore:fixture:regional'), false);
    assert.equal(rows.coverage.excludedByScope, 2);
    assert.equal(rows.coverage.invalidRecords, 1);
    assert.equal(rows.coverage.complete, false);
    assert.equal(rows.coverage.reason, 'rejected_provider_records');
  });
});

test('explicit Israeli competition country overrides a generic Premier League label without using participant country', async () => {
  await withScope('focused', async () => {
    const { api } = loadProvider(() => ({ matches: [
      fixture('israeli-generic', 'Premier League', { competition_country: 'Israel' }),
      fixture('israeli-code', 'Premier League', { competition_country_code: 'IL' }),
      fixture('participant-country', 'Premier League', {
        country: 'Israel', home_country: 'Israel', away_country: 'Israel', nationality: 'Israel',
      }),
    ] }));
    const rows = await api.getMatchesByDate(today());
    assert.deepEqual(rows.map(row => row.id), ['participant-country']);
    assert.equal(rows[0].competition.country, 'England');
    assert.equal(rows.coverage.excludedByScope, 2);
    const normalized = api.normalizeMatch(fixture('israeli-generic', 'Premier League', { competition_country: 'Israel' }));
    assert.equal(normalized.competition.country, 'Israel');
    assert.equal(normalized.id, 'israeli-generic');
  });
});

test('explicit Morocco competition metadata retains an Arab second division with its exact source scope', async () => {
  const raw = fixture('morocco-second', 'Botola 2', {
    competition_slug: 'morocco-botola-2', competition_country: 'Morocco', competition_country_code: 'MA',
  });
  await withScope('focused', async () => {
    const { api } = loadProvider(() => ({ matches: [raw] }));
    const rows = await api.getMatchesByDate(today());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'morocco-second');
    assert.equal(rows[0].competition.code, 'SC:morocco-botola-2');
    assert.equal(rows[0].competition.country, 'Morocco');
    assert.equal(rows[0].competition.countryCode, 'MA');
    assert.equal(rows.coverage.excludedByScope, 0);
  });
  await withScope(undefined, async () => {
    const { api } = loadProvider(() => assert.fail('Normalization does not request data'));
    const match = api.normalizeMatch(raw);
    assert.equal(match.id, 'morocco-second');
    assert.equal(match.competition.code, 'SC:morocco-botola-2');
    assert.equal(match.competition.country, 'Morocco');
  });
});

test('disabled scope preserves wider calendar behavior and existing coverage shape', async () => {
  await withScope(undefined, async () => {
    const { api } = loadProvider(() => ({ matches: mixed() }));
    const rows = await api.getMatchesByDate(today());
    assert.equal(rows.length, 5);
    assert.equal(Object.hasOwn(rows.coverage, 'competitionScope'), false);
    assert.equal(Object.hasOwn(rows.coverage, 'excludedByScope'), false);
  });
});

test('a capped excluded primary batch still recovers an important status-partition fixture with honest partial coverage', async () => {
  await withScope('focused', async () => {
    const { api, calls } = loadProvider(request => {
      const status = request.searchParams.get('status');
      return { matches: status === 'live' ? [fixture('recovered', 'Premier League', { status: 'live' })]
        : status === 'finished' ? [fixture('excluded-finished', 'Israel B League', { status: 'finished' })]
          : status === 'upcoming' ? [] : Array.from({ length: 200 }, (_, index) => fixture(`excluded-${index}`, 'Israel B League')) };
    });
    const rows = await api.getMatchesByDate(today());
    assert.deepEqual(rows.map(row => row.id), ['recovered']);
    assert.equal(calls.length, 4);
    assert.equal(rows.coverage.upstreamReturned, 202);
    assert.equal(rows.coverage.excludedByScope, 201);
    assert.equal(rows.coverage.recovered, 1);
    assert.equal(rows.coverage.possiblyTruncated, true);
    assert.equal(rows.coverage.complete, false);
    assert.equal(rows.coverage.reason, 'provider_result_limit');
    assert.equal(rows.coverage.invalidRecords, 0);
  });
});

test('excluded explicit competition request makes no upstream request', async () => {
  await withScope('focused', async () => {
    const { api, calls } = loadProvider(() => assert.fail('Excluded scope cannot request fixtures'));
    const rows = await api.getMatchesByDate(today(), { competition: 'SC:israel b league' });
    assert.deepEqual(rows, []);
    assert.equal(calls.length, 0);
    assert.equal(rows.coverage.available, true);
    assert.equal(rows.coverage.complete, true);
    assert.equal(rows.coverage.competitionScope, 'focused');
  });
});

test('focus filtering precedes optional team identity enrichment rather than merely hiding an enriched row', async () => {
  const policy = {
    competitionScopeEnabled: () => true,
    isCompetitionAllowed: competition => competition?.code === 'PL',
    isMatchAllowed: match => match?.competition?.code === 'PL',
    scopeCoverage: (coverage, total, accepted) => ({ ...coverage, competitionScope: 'focused', excludedByScope: total - accepted }),
  };
  const { api, calls } = loadProvider(request => {
    assert.equal(request.pathname, '/api/v1/fixtures/', 'Blocked BL1 must not request its standings membership');
    return { matches: [fixture('allowed'), fixture('blocked', 'Bundesliga', { home_slug: null, away_slug: null })] };
  }, { '../utils/competitionScope': policy });
  const rows = await api.getMatchesByDate(today());
  assert.deepEqual(rows.map(row => row.id), ['allowed']);
  assert.equal(calls.length, 1);
  assert.equal(rows.coverage.excludedByScope, 1);
});

test('league search obeys competition scope while teams and players retain their actual identities', async () => {
  await withScope('focused', async () => {
    const { api } = loadProvider(() => ({
      teams: [{ slug: 'israel-national', name: 'Israel', country: 'Israel', is_national: true }],
      players: [{ slug: 'franco-israel', name: 'Franco Israel', nationality: 'Uruguay' }],
      competitions: [
        { slug: 'english-premier-league', name: 'Premier League', country: 'England' },
        { slug: 'qatar-stars-league', name: 'Qatar Stars League', country: 'Qatar' },
        { slug: 'israel-b-league', name: 'Israel B League', country: 'Israel' },
        { slug: 'guatemala-division-2', name: 'Guatemala Division 2', country: 'Guatemala' },
      ],
    }));
    const result = await api.searchEntities('League');
    assert.deepEqual(result.competitions.map(row => row.name).sort(), ['Premier League', 'Qatar Stars League']);
    assert.equal(result.teams[0].id, 'israel-national');
    assert.equal(result.players[0].id, 'franco-israel');
    assert.equal(result.coverage.excludedByScope, 2);
  });
});

test('a previously cached excluded fixture cannot cause a widget or identity lookup after focus activation', async () => {
  await withScope(undefined, async () => {
    const { api, calls } = loadProvider(() => ({ matches: [fixture('old-excluded', 'Israel B League', {
      url: '/football/match/old-excluded/k82rekh2z4yvrep/',
    })] }));
    const rows = await api.getMatchesByDate(today());
    assert.equal(rows.length, 1);
    await withScope('focused', async () => {
      assert.equal(await api.getMatchDetails(rows[0].id), null);
      assert.equal(calls.length, 1, 'Existing cached classification denies before fetching details');
    });
  });
});

test('cold excluded widget details are classified before optional identity enrichment', async () => {
  await withScope('focused', async () => {
    const url = '/football/match/old-regional/k82rekh2z4yvrep/';
    const { api, calls } = loadProvider(request => {
      assert.equal(request.pathname, '/api/widget/match/');
      return { match: fixture('old-regional', 'Israel B League', { url, home_slug: null, away_slug: null }) };
    });
    assert.equal(await api.getMatchDetails(url), null);
    assert.equal(calls.length, 1);
  });
});
