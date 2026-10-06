const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { searchQuery, normalizeTerm, sortByRelevance } = require('../utils/searchQueries');

const logger = { info() {}, warn() {}, error() {} };
const complete = { available: true, complete: true, partial: false };
const empty = () => ({ teams: [], players: [], competitions: [], coverage: complete });
const cache = () => {
  const rows = new Map();
  return { getCached: key => rows.get(key), setCache: (key, value) => rows.set(key, value) };
};

// Execute only this service with mocked HTTP/cache and a test-only environment.
// This never reads a .env file or starts the server, pollers, or notifications.
function loadService(relative, mocks, env = {}) {
  const file = require.resolve(relative);
  const localRequire = createRequire(file);
  const module = { exports: {} };
  const compiled = vm.runInThisContext(`(function(require, module, exports, process) {\n${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  compiled(name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name), module, module.exports, { env });
  return module.exports;
}

const leagues = { PL: { slug: 'england-premier-league', name: 'Premier League', country: 'England' } };
function facade(bsd, sc) {
  return loadService('../services/searchService', {
    '../utils/logger': logger,
    './bsdSportsService': { isConfigured: () => true, searchEntities: bsd },
    './sportscoreService': { COMPETITION_SLUGS: leagues, searchEntities: sc },
  });
}
function bsdProvider(handler) {
  const requests = [];
  const api = loadService('../services/bsdSportsService', {
    axios: { create: () => ({ get: async (path, options) => {
      const url = new URL(path, 'https://provider.test');
      for (const [key, value] of Object.entries(options.params || {})) url.searchParams.set(key, value);
      requests.push(url);
      return { data: await handler(url) };
    } }) },
    '../utils/logger': logger, './cacheService': cache(), './teamTabCoverageService': {},
  }, { BSD_API_TOKEN: 'test-only-token', BSD_BASE_URL: 'https://provider.test' });
  return { api, requests };
}
function scProvider(handler) {
  const requests = [];
  const api = loadService('../services/sportscoreService', {
    axios: { get: async url => { requests.push(new URL(url)); return { data: await handler(new URL(url)) }; } },
    '../utils/logger': logger, './cacheService': cache(),
  });
  return { api, requests };
}
const page = (results, next = null, count = results.length) => ({ results, count, next });

test('Arabic diacritics, tatweel, alef and ya variants share canonical English query aliases', () => {
  for (const [arabic, english] of [
    ['بَرْشَلُـونَة', 'Barcelona'], ['مِيسِي', 'Messi'],
    ['الدَّوْرِي الإِنْجِلِيزِي', 'Premier League'], ['الدوري الانجليزي', 'Premier League'],
    ['الأرجنتين', 'Argentina'], ['الارجنتين', 'Argentina'], ['مبابى', 'Mbappé'],
    ['كِيلِيَان مَبَابِي', 'Kylian Mbappe'], ['إيثان مبابي', 'Ethan Mbappe'],
  ]) assert.equal(searchQuery(arabic).key, searchQuery(english).key, arabic);
  assert.equal(normalizeTerm('أ إ آ ٱ ى ی'), 'ا ا ا ا ي ي');
});

test('name relevance orders exact, whole word, prefix, then substring and preserves ties', () => {
  const rows = [
    { id: 'substring', name: 'Alessio Amessina' },
    { id: 'prefix', name: 'Messias' },
    { id: 'whole', name: 'Lionel Messi' },
    { id: 'exact', name: 'Messi' },
  ];
  assert.deepEqual(sortByRelevance(rows, 'Messi').map(row => row.id), ['exact', 'whole', 'prefix', 'substring']);
  const siblings = [{ id: 'ethan', name: 'Ethan Mbappé' }, { id: 'kylian', name: 'Kylian Mbappé' }];
  assert.deepEqual(sortByRelevance(siblings, 'Mbappe').map(row => row.id), ['ethan', 'kylian']);
  assert.deepEqual(sortByRelevance(siblings, 'كيليان مبابي').map(row => row.id), ['kylian', 'ethan']);
});

test('facade ranks both providers before capping and retains provider identities and context', async () => {
  const calls = [];
  const api = facade(async (term, limit) => {
    calls.push(['bsd', term, limit]);
    return { ...empty(), players: Array.from({ length: 50 }, (_, index) => ({
      id: `bsd_p_${index + 1}`, provider: 'bsd', name: `Alessio Messina ${index}`
    })) };
  }, async (term, limit) => {
    calls.push(['sc', term, limit]);
    return { ...empty(), players: [{ slug: 'actual-lionel', name: 'Lionel Messi', country: 'Argentina',
      team: 'Inter Miami', league: 'MLS', gender: 'male' }] };
  });
  const result = await api.searchAll('ميسي');
  assert.equal(result.players.length, 10);
  assert.equal(result.players[0].id, 'actual-lionel');
  assert.equal(result.players[0].providerId, 'actual-lionel');
  assert.equal(result.players[0].country, 'Argentina');
  assert.equal(result.players[0].league, 'MLS');
  assert.equal(result.players[0].gender, 'male');
  assert.equal(result.coverage.resultLimit, true);
  assert.equal(result.coverage.complete, false);
  assert.ok(calls.every(call => call[1] === 'Messi' && call[2] > 10));
  assert.equal(await api.searchAll('MESSI'), result);
  assert.equal(calls.length, 2);
});

test('FC club abbreviations outrank extended names while ambiguous clubs remain distinct', async () => {
  const api = facade(async () => ({ ...empty(), teams: [
    { id: 'bsd_t_4766', provider: 'bsd', name: 'Barcelona Atlètic', country: 'Spain' },
    { id: 'bsd_t_44', provider: 'bsd', name: 'FC Barcelona', country: 'Spain', league: 'La Liga', isWomen: false },
    { id: 'bsd_t_45', provider: 'bsd', name: 'FC Barcelona', country: 'Spain', league: 'Liga F', isWomen: true },
  ] }), async () => ({ ...empty(), teams: [{ slug: 'barcelona', name: 'Barcelona', country: '' }] }));
  const result = await api.searchAll('بَرْشَلُونَة');
  assert.equal(result.teams[0].id, 'bsd_t_44');
  assert.equal(result.teams[1].id, 'bsd_t_45');
  assert.equal(result.teams.find(row => row.id === 'sc_t_barcelona').country, '');
  assert.equal(result.teams.find(row => row.id === 'bsd_t_45').isWomen, true);
  assert.equal(result.teams.length, 4);
});

test('Arabic and English aliases share local fallback semantics and in-flight provider reads', async () => {
  let calls = 0, resolve;
  const pending = new Promise(done => { resolve = done; });
  const api = facade(() => { calls++; return pending; }, () => { calls++; return pending; });
  const english = api.searchAll('Premier League');
  const arabic = api.searchAll('الدوري الإنجليزي');
  resolve(empty());
  assert.equal(await english, await arabic);
  assert.equal(calls, 2);
  for (const [ar, en] of [['برشلونة', 'Barcelona'], ['الدوري الانجليزي', 'Premier League'], ['الارجنتين', 'Argentina']]) {
    const a = await api.searchAll(ar, { useProvider: false });
    const b = await api.searchAll(en, { useProvider: false });
    assert.deepEqual(a, b);
    assert.ok(a.teams.length || a.players.length || a.leagues.length);
  }
});

test('BSD larger and paginated candidates are ranked before the requested display cap', async () => {
  const { api, requests } = bsdProvider(url => {
    if (url.pathname === '/api/v2/players/' && url.searchParams.get('name') === 'Lionel Messi') return page([]);
    if (url.pathname === '/api/v2/players/' && url.searchParams.get('offset')) return page([{ id: 999, name: 'Lionel Messi' }], null, 51);
    if (url.pathname === '/api/v2/players/') return page(Array.from({ length: 50 }, (_, index) => ({ id: index + 1, name: `Messina ${index}` })),
      'https://provider.test/api/v2/players/?name=Messi&limit=50&offset=50', 51);
    return page([]);
  });
  const result = await api.searchPlayers('ميسي', 10);
  assert.equal(result.length, 10);
  assert.equal(result[0].id, 'bsd_p_999');
  assert.equal(result.coverage.resultLimit, true);
  assert.ok(requests.every(url => url.searchParams.get('limit') === '50'));
  assert.equal(requests.length, 3);
});

test('BSD supplemental full-name query returns only actual rows and canonical aliases reuse provider cache', async () => {
  const { api, requests } = bsdProvider(url => url.pathname === '/api/v2/players/'
    ? page(url.searchParams.get('name') === 'Lionel Messi' ? [{ id: 777, name: 'Lionel Messi', nationality: 'Argentina' }]
      : [{ id: 1, name: 'Alessio Messina' }]) : page([]));
  const result = await api.searchEntities('مِـيسي', 10);
  assert.equal(result.players[0].id, 'bsd_p_777');
  assert.equal(result.players[0].country, 'Argentina');
  const count = requests.length;
  assert.equal((await api.searchEntities('Messi', 10)).players[0].id, 'bsd_p_777');
  assert.equal(requests.length, count);
  const absent = bsdProvider(() => page([]));
  assert.equal((await absent.api.searchEntities('Messi')).players.length, 0);
});

test('BSD invalid and bounded candidate pages retain incomplete coverage', async () => {
  const invalid = bsdProvider(() => page([{ name: 'Missing provider ID' }, { id: 1, name: 'Valid Player' }]));
  const rows = await invalid.api.searchPlayers('Valid');
  assert.equal(rows.length, 1);
  assert.equal(rows.coverage.complete, false);
  assert.equal(rows.coverage.queries[0].invalidRows, 1);
  const capped = bsdProvider(url => page(Array.from({ length: 50 }, (_, index) => ({
    id: Number(url.searchParams.get('offset') || 0) + index + 1, name: `Valid ${index}`
  })), `https://provider.test/api/v2/players/?name=valid&limit=50&offset=${Number(url.searchParams.get('offset') || 0) + 50}`, 200));
  const candidates = await capped.api.searchPlayers('Valid', 50);
  assert.equal(capped.requests.length, 2);
  assert.equal(candidates.coverage.complete, false);
  assert.equal(candidates.coverage.possiblyTruncated, true);
});

test('facade keeps provider competition IDs without requiring a guessed league code', async () => {
  const api = facade(async () => empty(), async () => ({ ...empty(), competitions: [
    { id: 'exact-provider-competition', name: 'Test Competition', country: 'Argentina' }
  ] }));
  const result = await api.searchAll('Test Competition');
  assert.equal(result.leagues[0].id, 'exact-provider-competition');
  assert.equal(result.leagues[0].providerId, 'exact-provider-competition');
  assert.equal(result.leagues[0].country, 'Argentina');
});

test('BSD search retains returned country, competition and gender and ranks FC Barcelona first', async () => {
  const { api, requests } = bsdProvider(url => url.pathname === '/api/v2/teams/' ? page([
    { id: 10, name: 'Barcelona Atlètic', country: 'Spain' },
    { id: 44, name: 'FC Barcelona', country: 'Spain', is_women: false, competition: { name: 'La Liga', code: 'PD' } },
  ]) : page([]));
  const result = await api.searchEntities('بَرْشَلُونَة', 1);
  assert.equal(result.teams[0].id, 'bsd_t_44');
  assert.equal(result.teams[0].leagueCode, 'PD');
  assert.equal(result.teams[0].isWomen, false);
  assert.equal(result.coverage.resultLimit, true);
  assert.ok(requests.filter(url => url.pathname === '/api/v2/teams/').every(url => url.searchParams.get('limit') === '50'));
});

test('SportScore uses larger candidates and full-name retrieval, query relevance beats portrait presence', async () => {
  const { api, requests } = scProvider(url => url.searchParams.get('q') === 'Lionel Messi' ? {
    players: [{ slug: 'verified-lionel', name: 'Lionel Messi', nationality: { name: 'Argentina' }, team: { name: 'Inter Miami' } }]
  } : { teams: [{ slug: 'barcelona-other', name: 'Barcelona', country: { name: 'Ecuador', code: 'EC' },
    competition: { name: 'Serie A', code: 'EC1' }, is_women: true }],
    players: Array.from({ length: 20 }, (_, index) => ({ slug: `messina-${index}`, name: `Messina ${index}`, logo: 'https://provider.test/portrait.png' })) });
  const result = await api.searchEntities('ميسي', 10);
  assert.equal(result.players[0].id, 'verified-lionel');
  assert.equal(result.players[0].nationality, 'Argentina');
  assert.equal(result.players[0].team, 'Inter Miami');
  assert.equal(result.teams[0].country, 'Ecuador');
  assert.equal(result.teams[0].leagueCode, 'EC1');
  assert.equal(result.teams[0].isWomen, true);
  assert.equal(result.coverage.possiblyTruncated, true);
  assert.equal(result.coverage.complete, false);
  assert.ok(requests.every(url => url.searchParams.get('limit') === '20'));
  assert.equal(requests.length, 2);
  const count = requests.length;
  await api.searchEntities('Messi', 10);
  assert.equal(requests.length, count);
});
