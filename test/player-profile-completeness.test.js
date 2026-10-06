'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { selectBsdPlayerScope, aggregateBsdPlayerStatistics } = require('../utils/playerStatisticsScope');

const season = { id: 1307, name: 'LaLiga 26/27', year: 2026, start_date: '2026-07-01', end_date: '2027-06-30', is_current: true };
const historical = { id: 294, name: 'LaLiga 25/26', year: 2025, start_date: '2025-07-01', end_date: '2026-06-30', is_current: false };
const international = { id: 1320, name: 'World Cup 2022', year: 2022, start_date: '2022-11-20', end_date: '2022-12-18', is_current: false };
const leagues = [{ id: 3, name: 'La Liga', current_season: season },
  { id: 27, name: 'World Cup 2026', current_season: { ...international, id: 1319, name: 'World Cup 2026', year: 2026, is_current: true } }];
const row = (teamId = 57, leagueId = 3, seasonId = 1307, changes = {}) => ({ team_id: teamId, league_id: leagueId, season_id: seasonId, matches: 1, minutes: 90, goals: 0, assists: 0, avg_rating: 7, ...changes });
const page = rows => ({ count: rows.length, next: null, results: rows });
const profile = { id: 594, name: 'Kylian Mbappé', position: 'F', specific_position: 'ST', jersey_number: 10,
  date_of_birth: '1998-12-20', height_cm: 180, weight_kg: null, preferred_foot: 'R', nationality: 'France',
  current_team_id: 57, national_team_id: 485, current_team: { id: 57, name: 'Real Madrid' },
  national_team: { id: 485, name: 'France' }, market_value_eur: 212000000, contract_until: '2029-06-30',
  attributes: null, strengths: [], weaknesses: [], potential: 'Almost Reached', injury_risk: 'Unlikely', wage_eur_annual: 30495920 };
// Keys and nullability match BSD v2's sampled /players/594/stats/ schema.
const statistics = { id: 7745838, player_id: 594, team_id: 57, event_id: 213581, minutes_played: 90,
  rating: 7, goals: 0, goal_assist: 0, total_shots: 1, shots_on_target: 0, key_pass: 0,
  total_pass: 25, accurate_pass: 21, total_tackle: 1, interception: 0, yellow_card: 0, red_card: 0,
  saves: 0, goals_conceded: 2 };

function load(file, stubs) {
  const resolved = require.resolve(file); delete require.cache[resolved];
  const original = Module._load;
  Module._load = function(name, parent, isMain) { return Object.hasOwn(stubs, name) ? stubs[name] : original.call(this, name, parent, isMain); };
  try { return require(resolved); } finally { Module._load = original; }
}
const logger = { warn() {}, error() {}, info() {} };
function setup(changes = {}) {
  const requests = [], cache = new Map(), previous = process.env.BSD_API_TOKEN;
  process.env.BSD_API_TOKEN = 'offline-fixture-only';
  let api;
  try {
    api = load('../services/bsdSportsService', {
      axios: { create: () => ({ get: async (path, config) => {
        const url = new URL(path, 'https://sports.bzzoiro.com');
        for (const [key, value] of Object.entries(config.params || {})) url.searchParams.set(key, value);
        requests.push(url);
        if (url.pathname === '/api/v2/leagues/') return { data: page(leagues) };
        if (url.pathname === '/api/v2/players/594/') return { data: { ...profile, ...changes.profile } };
        if (url.pathname.endsWith('/career/')) return { data: changes.career ?? { player_id: 594, seasons: [row(), row(57, 3, 294), row(485, 27, 1320)] } };
        if (url.pathname.endsWith('/transfers/')) return { data: changes.transfers ?? { player_id: 594, transfers: [] } };
        if (url.pathname.endsWith('/seasons/')) return { data: { league_id: Number(url.pathname.split('/')[4]), seasons: [season, historical, international] } };
        if (url.pathname.endsWith('/stats/')) return { data: page([{ ...statistics, team_id: Number(url.searchParams.get('team_id')), ...changes.statistics }]) };
        if (url.pathname === '/api/v2/events/') return { data: page([{ id: 213581, event_date: '2022-11-20T18:00:00Z', status: 'finished',
          home_team_id: Number(url.searchParams.get('team_id')), away_team_id: 44,
          home_team: 'Verified Team', away_team: 'FC Barcelona', home_score: 0, away_score: 0,
          league_id: Number(url.searchParams.get('league_id')), season_id: Number(url.searchParams.get('season_id')) }]) };
        throw new Error('Unexpected fixture endpoint ' + url.pathname);
      } }) }, './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) }, '../utils/logger': logger,
    });
  } finally { previous === undefined ? delete process.env.BSD_API_TOKEN : process.env.BSD_API_TOKEN = previous; }
  return { api, requests };
}

test('historical and national scopes request the exact career team and edition, retain each other and avoid current club leakage', async () => {
  for (const scope of [{ teamId: 'bsd_t_57', competition: 'PD', seasonId: '294' },
    { teamId: 'bsd_t_485', competition: 'WC', seasonId: '1320' }]) {
    const { api, requests } = setup();
    // Fixture dates are intentionally in the requested historical edition.
    api.getMatches = async input => {
      const events = [{ rawId: 213581 }]; events.coverage = { available: true, complete: true };
      assert.equal(input.team_id, Number(scope.teamId.slice(6))); assert.equal(input.season_id, Number(scope.seasonId)); return events;
    };
    const value = await api.getPlayerDetails('bsd_p_594', scope);
    assert.equal(value.statsContext.teamId, scope.teamId);
    assert.equal(value.statsContext.seasonId, Number(scope.seasonId));
    assert.equal(value.statsContext.competitionId, scope.competition);
    assert.equal(value.seasonStats.shots, 1);
    assert.equal(value.seasonStats.passesAccuracy, 84);
    assert.equal(value.seasonStats.saves, 0);
    assert.equal(value.seasonStats.yellowCards, 0);
    assert.equal(value.statsCoverage.complete, true);
    assert.equal(value.teamId, 'bsd_t_57', 'The current club remains biography, separate from selected statistics');
    assert.equal(value.careerBySeason.length, 3);
    const match = value.careerBySeason.find(row => row.seasonId === Number(scope.seasonId));
    assert.equal(match.shots, 1); assert.strictEqual(match.statsCoverage, value.statsCoverage);
    const request = requests.find(url => url.pathname.endsWith('/stats/'));
    assert.equal(request.searchParams.get('team_id'), scope.teamId.slice(6));
    assert.equal(request.searchParams.get('season_id'), scope.seasonId);
  }
});

test('an unverified or malformed selection never silently falls back to unrelated current statistics', async () => {
  for (const scope of [{ teamId: 'ko_t_57', seasonId: '294', competition: 'PD' },
    { teamId: 'bsd_t_999', seasonId: '294', competition: 'PD' },
    { teamId: 'bsd_t_485', seasonId: '294', competition: 'WC' },
    { seasonId: ['1307', '294'], competition: 'PD' }, { seasonId: '0' }, { season: '1307' }]) {
    const { api, requests } = setup();
    const value = await api.getPlayerDetails('bsd_p_594', scope);
    assert.equal(value.id, 'bsd_p_594'); assert.equal(value.statsContext, null);
    assert.deepEqual(value.seasonStats, {}); assert.equal(value.goals, null);
    assert.equal(value.statsCoverage.available, false);
    assert.ok(!requests.some(url => url.pathname.endsWith('/stats/')));
  }
});

test('ambiguous career team/competition/season scopes require a more precise selection', () => {
  const career = [{ teamId: 'bsd_t_57', leagueId: 3, seasonId: 1307, seasonInfo: season },
    { teamId: 'bsd_t_57', leagueId: 3, seasonId: 1307, seasonInfo: season }];
  const result = selectBsdPlayerScope(career, { seasonId: '1307', competition: 'PD' }, 57, () => 3, new Set([3]));
  assert.equal(result.row, null); assert.equal(result.reason, 'ambiguous_statistics_scope');
});

test('secondary failures and malformed career/transfers preserve the real player and signal unavailable coverage', async () => {
  for (const changes of [{ career: { player_id: 595, seasons: [row()] }, transfers: { player_id: 595, transfers: [] } },
    { career: { player_id: 594, seasons: {} }, transfers: { player_id: 594, transfers: {} } }]) {
    const value = await setup(changes).api.getPlayerDetails('bsd_p_594');
    assert.equal(value.name, 'Kylian Mbappé'); assert.deepEqual(value.careerBySeason, []); assert.deepEqual(value.transfers, []);
    assert.equal(value.coverage.profile.available, true); assert.equal(value.coverage.career.available, false);
    assert.equal(value.coverage.transfers.available, false); assert.equal(value.coverage.complete, false);
  }
  const value = await setup({ career: { player_id: 594, seasons: [] } }).api.getPlayerDetails('bsd_p_594');
  assert.equal(value.coverage.career.available, true); assert.equal(value.coverage.career.complete, true);
  assert.equal(value.coverage.transfers.available, true); assert.equal(value.coverage.transfers.complete, true);
});

test('biography fields supplied by BSD survive while unsupplied weight, attributes and honours stay explicitly unknown', async () => {
  const value = await setup({ career: { player_id: 594, seasons: [] } }).api.getPlayerDetails('bsd_p_594');
  assert.equal(value.nationalTeam.name, 'France'); assert.equal(value.contractUntil, '2029-06-30');
  assert.equal(value.wageAnnual, 30495920); assert.equal(value.potential, 'Almost Reached');
  assert.equal(value.weight, null); assert.deepEqual(value.attributes, {});
  assert.equal(value.coverage.profile.fields.weight, false); assert.equal(value.coverage.profile.fields.preferredFoot, true);
  assert.equal(value.honoursCoverage.available, false);
  const wrongNational = await setup({ profile: { national_team_id: 999 }, career: { player_id: 594, seasons: [] } }).api.getPlayerDetails('bsd_p_594');
  assert.equal(wrongNational.nationalTeam, null);
});

test('an invalid preferred image cannot hide another valid portrait supplied for the same exact player', async () => {
  const value = await setup({ profile: { image: 'javascript:invalid', photo: 'https://provider.example/594.png' }, career: { player_id: 594, seasons: [] } }).api.getPlayerDetails('bsd_p_594');
  assert.equal(value.image, 'https://provider.example/594.png'); assert.equal(value.photo, value.image);
  assert.equal(value.player.id, value.id); assert.equal(value.player.photo, value.photo);
});

function aggregate(rows, selectedChanges = {}, fixturesCoverage = { complete: true }) {
  const stats = rows; stats.coverage = { available: true, complete: true, source: 'bsd' };
  const fixtures = [{ rawId: 213581 }]; fixtures.coverage = fixturesCoverage;
  return aggregateBsdPlayerStatistics(stats, fixtures, { teamId: 'bsd_t_57', matches: 1, minutes: 90, goals: 0, assists: 0, ...selectedChanges }, 594,
    { shots: 'total_shots', passes: 'total_pass', yellowCards: 'yellow_card', saves: 'saves' });
}

test('foreign identities, duplicate event rows, missing minutes, scope holes and core-count contradictions cannot create complete season totals', () => {
  for (const rows of [[{ ...statistics, player_id: 595 }], [{ ...statistics, team_id: 485 }],
    [{ ...statistics, event_id: 999 }], [{ ...statistics, minutes_played: null }],
    [{ ...statistics }, { ...statistics, id: 2, total_shots: 99 }], [{ ...statistics, goals: 4 }]]) {
    const value = aggregate(rows);
    assert.equal(value.coverage.complete, false); assert.equal(value.metrics.shots, null);
  }
  assert.equal(aggregate([{ ...statistics }], {}, { complete: false }).metrics.shots, null);
  assert.equal(aggregate([{ ...statistics }], { matches: 2 }).metrics.shots, null);
});

test('missing counters, negative and blank values never become invented zeros or impossible pass percentages', () => {
  for (const invalid of [undefined, null, ' ', -1, true, {}, 1.5]) {
    const value = aggregate([{ ...statistics, total_shots: invalid }]);
    assert.equal(value.metrics.shots, null); assert.equal(value.metrics.yellowCards, 0);
  }
  assert.equal(aggregate([{ ...statistics, accurate_pass: 26 }]).metrics.passesAccuracy, null);
  assert.equal(aggregate([{ ...statistics, accurate_pass: null }]).metrics.passesAccuracy, null);
});

test('source zero-minute match records preserve verified season counters with an explicit appearance-count caveat', () => {
  const value = aggregate([{ ...statistics, minutes_played: 0, total_shots: 0, total_pass: 0, accurate_pass: 0 }], { minutes: 0 });
  assert.equal(value.metrics.shots, 0); assert.equal(value.metrics.passes, 0);
  assert.equal(value.metrics.passesAccuracy, null);
  assert.equal(value.coverage.metricsComplete, true); assert.equal(value.coverage.complete, false);
  assert.equal(value.coverage.observedAppearances, 0); assert.equal(value.coverage.reportedAppearances, 1);
  assert.equal(value.coverage.verifiedStatisticsRecords, 1); assert.equal(value.coverage.zeroMinuteRecords, 1);
  assert.equal(value.coverage.reason, 'provider_appearance_count_includes_zero_minute_records');
});

function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function controller(stubs) { return load('../controllers/statsController', {
  '../services/sportscoreService': {}, '../services/sportsDataService': {}, '../services/kickoffApiService': {}, '../services/bsdSportsService': {},
  '../services/teamService': {}, '../services/cacheService': {}, '../utils/logger': logger, ...stubs }); }

test('BSD deep route forwards exact on-demand scope and preserves section availability in its public payload', async () => {
  let options;
  const player = { id: 'bsd_p_594', name: 'Verified Player', statsContext: { seasonId: 294, competitionId: 'PD', teamId: 'bsd_t_57' },
    seasonStats: { goals: 0, shots: 3 }, coverage: { career: { available: false, complete: false } },
    careerCoverage: { available: false }, transfersCoverage: { available: true, complete: true }, career: [], transfers: [] };
  const api = controller({ '../services/bsdSportsService': { getPlayerDetails: async (id, input) => { assert.equal(id, player.id); options = input; return player; } } });
  const res = response(); await api.getDeepPlayerDetails({ params: { id: player.id }, query: { seasonId: '294', competition: 'PD', teamId: 'bsd_t_57', ignored: 'no' } }, res);
  assert.deepEqual(options, { seasonId: '294', competition: 'PD', teamId: 'bsd_t_57' });
  assert.deepEqual(res.body.data.seasonStats, player.seasonStats); assert.deepEqual(res.body.data.coverage, player.coverage);
  assert.equal(res.body.data.transfersCoverage.complete, true);
});

test('the non-BSD deep projection retains actual nationality, foot, team identity, biography, transfers and career fields', async () => {
  const player = { id: 'ko_p_278', name: 'Verified Player', nationality: 'France', dateOfBirth: '1998-12-20',
    preferredFoot: 'Right', teamId: 'ko_t_541', currentTeam: { id: 'ko_t_541' }, nationalTeam: { id: 'ko_t_2' },
    contractUntil: '2029-06-30', attributes: { passing: 88 }, transfers: [{ fromTeamId: 'ko_t_85' }], careerBySeason: [{ season: '2025', goals: 0 }],
    seasonStats: {}, statsCoverage: { available: false } };
  const api = controller({ '../services/kickoffApiService': { getPlayerDetails: async () => player } });
  const res = response(); await api.getDeepPlayerDetails({ params: { id: player.id }, query: {} }, res);
  for (const key of ['nationality', 'preferredFoot', 'teamId', 'nationalTeam', 'contractUntil']) assert.deepEqual(res.body.data.info[key], player[key]);
  assert.equal(res.body.data.info.dateBorn, player.dateOfBirth);
  assert.deepEqual(res.body.data.attributes, player.attributes); assert.deepEqual(res.body.data.transfers, player.transfers);
  assert.deepEqual(res.body.data.careerBySeason, player.careerBySeason);
});
