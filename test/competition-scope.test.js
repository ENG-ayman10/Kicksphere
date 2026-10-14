'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const policy = require('../utils/competitionScope');
async function focused(work) {
  const previous = process.env.SPORTS_COMPETITION_SCOPE;
  process.env.SPORTS_COMPETITION_SCOPE = 'focused';
  try { return await work(); } finally {
    if (previous === undefined) delete process.env.SPORTS_COMPETITION_SCOPE;
    else process.env.SPORTS_COMPETITION_SCOPE = previous;
  }
}
function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(file); } finally { Module._load = original; }
}
const log = { warn() {}, info() {}, error() {} };
const catalog = [
  { id: 1, name: 'Premier League', country: 'England', country_code: 'GB' },
  { id: 100, name: 'Premier League', country: 'Israel', country_code: 'IL' },
  { id: 101, name: 'Premier League', country: 'Egypt', country_code: 'EG' },
  { id: 102, name: 'Super League', country: 'India', country_code: 'IN' },
  { id: 103, name: 'International Friendly Games', country: 'World' },
];
const rawMatch = (id, league = 100, overrides = {}) => ({ id, league_id: league,
  event_date: '2026-10-14T18:00:00Z', status: 'live', current_minute: 25,
  home_team_id: id * 2 + 1, home_team: `Home ${id}`, away_team_id: id * 2 + 2,
  away_team: `Away ${id}`, home_score: 0, away_score: 0, ...overrides });
function bsd(read) {
  const previous = process.env.BSD_API_TOKEN;
  process.env.BSD_API_TOKEN = 'offline_competition_scope_test';
  const calls = [];
  try {
    const api = load('../services/bsdSportsService', {
      axios: { create: () => ({ get: async (path, config) => {
        calls.push(path);
        return { data: path === '/api/v2/leagues/' ? { count: catalog.length, results: catalog, next: null } : await read(path, config) };
      } }) },
      './cacheService': { getCached: () => null, setCache() {} }, '../utils/logger': log,
    });
    return { api, calls };
  } finally {
    if (previous === undefined) delete process.env.BSD_API_TOKEN;
    else process.env.BSD_API_TOKEN = previous;
  }
}
const rows = data => Object.defineProperty(data.slice(), 'coverage', { value: {
  available: true, complete: true, partial: false, possiblyTruncated: false,
} });

test('focused coverage retains major, all Arab countries and international competitions using competition metadata', () => focused(() => {
  for (const code of ['PL', 'PD', 'SA', 'BL1', 'FL1', 'PPL', 'DED', 'BSA', 'ARG', 'TSL', 'MLS', 'ELC', 'SPL', 'FAC', 'CDR', 'CIT', 'DFB', 'CL', 'EL', 'ECL', 'WC', 'EC', 'UNL', 'ACL', 'CAF', 'CLI']) {
    assert.equal(policy.isCompetitionAllowed({ code }), true, code);
  }
  for (const countryCode of ['DZ', 'BH', 'KM', 'DJ', 'EG', 'IQ', 'JO', 'KW', 'LB', 'LY', 'MR', 'MA', 'OM', 'PS', 'QA', 'SA', 'SO', 'SD', 'SY', 'TN', 'AE', 'YE']) {
    assert.equal(policy.isCompetitionAllowed({ code: 'BSD:999', name: 'Local competition', countryCode }), true, countryCode);
  }
  for (const competition of [{ name: 'Qatar Stars League' }, { name: 'Egyptian Second Division' },
    { name: 'Yemen Division 1' }, { name: 'Carabao Cup', country: 'England' },
    { name: 'Coupe de France', country: 'France' }, { name: 'CAF Confederation Cup' },
    { name: 'World Cup Qualification' }, { name: 'U17 continental tournament', country: 'Asia' },
    { name: 'InternationalFriendlyGames' }, { name: 'دوري أبطال أوروبا' }]) {
    assert.equal(policy.isCompetitionAllowed(competition), true, competition.name);
  }
}));

test('domestic Israel, minor leagues, unqualified names and senior-name youth copies cannot borrow the allowlist', () => focused(() => {
  for (const competition of [{ code: 'PL', name: 'Premier League', countryCode: 'IL' },
    { code: 'SC:israel b league' }, { name: 'Israel Leumit League' }, { name: 'Ligat HaAl' },
    { name: 'الدوري الإسرائيلي الممتاز', code: 'PL' }, { name: 'India Super League', country: 'India' },
    { name: 'Premier League' }, { name: 'Premier League', country: 'Namibia' },
    { name: 'Premier League', code: 'PL', country: 'Namibia' },
    { name: 'Bundesliga', country: 'Austria' }, { name: 'Champions Cup', country: 'India' },
    { name: 'Ligue 1', country: 'Cambodia' }, { name: 'Youth Premier League U21', code: 'PL', country: 'England' }]) {
    assert.equal(policy.isCompetitionAllowed(competition), false, JSON.stringify(competition));
  }
}));

test('a retained international fixture ignores participant country and player name while preserving identity', () => focused(() => {
  const match = { id: 'exact_fixture', competition: { code: 'WC', country: 'World' },
    homeTeam: { name: 'Israel', country: 'Israel' }, awayTeam: { name: 'Egypt' },
    player: { name: 'Franco Israel', nationality: 'Israel' } };
  assert.equal(policy.isMatchAllowed(match), true);
  assert.equal(policy.filterMatchesToScope([match])[0], match);
  assert.equal(policy.isEventAllowed({ type: 'systemTest', eventId: 'own_test' }), true);
}));

test('intentional scope exclusions preserve existing outage/truncation flags and upstream counts', () => focused(() => {
  const coverage = { available: true, complete: false, partial: true, possiblyTruncated: true,
    upstreamReturned: 200, excludedByScope: 3, invalidRows: 2 };
  const value = policy.scopeCoverage(coverage, 10, 4);
  assert.equal(value.excludedByScope, 9);
  assert.equal(value.upstreamReturned, 200);
  assert.equal(value.complete, false);
  assert.equal(value.invalidRows, 2);
  assert.equal(coverage.excludedByScope, 3);
}));

test('BSD matchday/live filter country metadata while internal biography history and catalog stay complete', () => focused(async () => {
  const list = [rawMatch(1, 1), rawMatch(2, 100), rawMatch(3, 101), rawMatch(4, 102), rawMatch(5, 103)];
  const { api } = bsd(path => {
    if (path === '/api/v2/events/') return { count: list.length, next: null, results: list };
    if (path === '/api/v2/events/live/') return { events: list };
    assert.fail('Unexpected request ' + path);
  });
  assert.equal((await api.getLeagues()).length, 5);
  assert.equal((await api.getMatches({ date: '2026-10-14' })).length, 5, 'Internal career/history reads must not lose source competitions');
  const day = await api.getMatches({ date: '2026-10-14', applyCompetitionScope: true });
  assert.deepEqual(day.map(match => match.id), ['bsd_1', 'bsd_3', 'bsd_5']);
  assert.equal(day[1].competition.countryCode, 'EG');
  assert.equal(day.coverage.excludedByScope, 2);
  assert.equal(day.coverage.complete, true);
  assert.deepEqual((await api.getLiveMatches()).map(match => match.id), ['bsd_1', 'bsd_3', 'bsd_5']);
}));

test('excluded BSD alert/deep match stops before timeline, lineup, availability, statistics and player fanout', () => focused(async () => {
  const { api, calls } = bsd(path => {
    if (path === '/api/v2/events/21/') return rawMatch(21);
    assert.fail('Excluded optional request ' + path);
  });
  assert.equal(await api.getMatchAlertDetails('bsd_21', { includeTimeline: true, includeLineups: true }), null);
  assert.equal(await api.getMatchDetails('bsd_21'), null);
  assert.equal(await api.getMatchTimeline('bsd_21'), null);
  assert.ok(calls.every(path => ['/api/v2/events/21/', '/api/v2/leagues/'].includes(path)));
}));

test('internal club profile season standings remain verified even when its domestic competition is hidden from public discovery', () => focused(async () => {
  const { api, calls } = bsd(path => {
    if (path === '/api/v2/leagues/100/') return { ...catalog[1], current_season: { id: 42 } };
    if (path === '/api/v2/leagues/100/standings/') return { league_id: 100, season: { id: 42 },
      standings: [{ team_id: 51, team_name: 'Club', position: 2, played: 20, won: 14,
        drawn: 5, lost: 1, pts: 47, gf: 40, ga: 12, gd: 28 }] };
    assert.fail('Unexpected source history request ' + path);
  });
  const standings = await api.getStandings('BSD:100');
  assert.equal(standings[0].playedGames, 20);
  assert.equal(standings[0].points, 47);
  assert.equal(standings.coverage.complete, true);
  assert.ok(calls.includes('/api/v2/leagues/100/standings/'));
}));

test('public catalog and excluded competition endpoints stop fixture/standing/scorer reads without remapping Arab IDs', () => focused(async () => {
  const leagues = catalog.map(row => ({ ...row, id: row.id === 1 ? 'PL' : `BSD:${row.id}`,
    code: row.id === 1 ? 'PL' : `BSD:${row.id}`, providerId: String(row.id), countryCode: row.country_code }));
  const api = load('../services/sportsDataService', {
    './sportscoreService': { COMPETITION_SLUGS: { PL: { name: 'Premier League', country: 'England' } },
      getMatchesByDate: () => assert.fail('Excluded league must not read SportScore'),
      getStandings: () => assert.fail('Excluded standings'), getTopScorers: () => assert.fail('Excluded scorers') },
    './bsdSportsService': { isConfigured: () => true, getLeagues: async () => rows(leagues),
      getMatches: () => assert.fail('Excluded league fixtures'), getStandings: () => assert.fail('Excluded standings'),
      getTopScorers: () => assert.fail('Excluded scorers') },
    './kickoffApiService': {}, '../utils/logger': log,
  });
  const selected = await api.getCompetitionCatalog();
  assert.deepEqual(selected.map(row => row.code), ['PL', 'BSD:101', 'BSD:103']);
  assert.equal(selected.coverage.excludedByScope, 2);
  for (const result of [await api.getCompetitionMatches('BSD:100'), await api.getStandings('BSD:100'),
    await api.getTopScorers('BSD:100'), await api.getCompetitionMatches('BSD:102')]) {
    assert.equal(result.statusCode, 404);
    assert.equal(result.coverage.reason, 'competition_outside_scope');
  }
}));

test('unified calendar defensively filters mocked provider rows before returning scope coverage', () => focused(async () => {
  const fixture = (id, competition) => ({ id, provider: 'sportscore', source: 'sportscore',
    utcDate: '2026-10-14T18:00:00Z', status: 'TIMED', competition,
    homeTeam: { id: 'sc_t_home', name: 'Home', provider: 'sportscore' },
    awayTeam: { id: 'sc_t_away', name: 'Away', provider: 'sportscore' } });
  const api = load('../services/sportsDataService', {
    './sportscoreService': { getMatchesByDate: async (_, options) => rows(options.competition ? [] : [
      fixture('important', { code: 'PL' }), fixture('excluded', { code: 'SC:israel b league' })]) },
    './bsdSportsService': { isConfigured: () => false }, './kickoffApiService': {}, '../utils/logger': log,
  });
  const value = await api.getMatchesByDate('2026-10-14');
  assert.deepEqual(value.data.map(match => match.id), ['important']);
  assert.equal(value.coverage.excludedByScope, 1);
  assert.equal(value.coverage.complete, true);
}));

test('competition scope config defaults to all, explicitly enables focused and refuses misspelled settings', () => {
  const { loadRuntimeConfig } = require('../utils/runtimeConfig');
  assert.equal(loadRuntimeConfig({ NODE_ENV: 'test' }).competitionScope, 'all');
  assert.equal(loadRuntimeConfig({ NODE_ENV: 'test', SPORTS_COMPETITION_SCOPE: 'focused' }).competitionScope, 'focused');
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: 'test', SPORTS_COMPETITION_SCOPE: 'focus' }), /SPORTS_COMPETITION_SCOPE/);
});
