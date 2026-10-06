const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { normalizeCareerCompetitionLabels } = require('../utils/careerCompetitionLabels');
const { canonicalMatchStatus } = require('../utils/matchStatus');
const logger = { info() {}, warn() {}, error() {} };

function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}
function cache() {
  const values = new Map();
  return { getCached: key => values.get(key), setCache: (key, value) => values.set(key, value) };
}
function kickoff(read) {
  const previous = process.env.KICKOFF_API_KEY;
  process.env.KICKOFF_API_KEY = 'offline-test-key';
  const calls = [];
  try {
    const api = load('../services/kickoffApiService', {
      axios: { create: () => ({ get: async (path, { params }) => {
        calls.push({ path, params }); return { data: await read(path, params) };
      } }) }, '../utils/logger': logger, './cacheService': cache(),
    });
    return { api, calls };
  } finally {
    previous === undefined ? delete process.env.KICKOFF_API_KEY : process.env.KICKOFF_API_KEY = previous;
  }
}
const statistics = (teamId, team, leagueId, league, season, goals = 0) => ({
  team: { id: teamId, name: team }, league: { id: leagueId, name: league, season },
  games: { appearences: 3, minutes: 270, position: 'Attacker' }, goals: { total: goals, assists: 0 },
});
const playerResponse = blocks => ({ response: [{
  player: { id: 278, name: 'Verified Player', honours: [{ name: 'Source trophy' }] }, statistics: blocks,
}] });
const rosterResponse = (id = 529, changes = {}) => ({ parameters: { team: String(id) },
  errors: [], results: 1, paging: { current: 1, total: 1 },
  response: [{ team: { id }, players: [{ id: 765, name: 'Verified Roster Player' }] }], ...changes });

test('SportScore terminal and unknown states cannot become forthcoming fixtures', () => {
  const sc = load('../services/sportscoreService', { axios: {}, '../utils/logger': logger, './cacheService': cache() });
  for (const [status, expected, label] of [
    ['cancelled', 'CANCELLED', 'Cancelled'], ['canceled', 'CANCELLED', 'Cancelled'],
    ['abandoned', 'CANCELLED', 'Cancelled'], [' SUSPENDED ', 'SUSPENDED', 'Suspended'],
    ['susp', 'SUSPENDED', 'Suspended'], ['postponed', 'POSTPONED', 'Postponed'],
    ['unknown_status', 'UNKNOWN', 'Unavailable'], ['', 'UNKNOWN', 'Unavailable'],
  ]) {
    const row = sc.normalizeMatch({ slug: 'fixture', home: 'Home', away: 'Away', status, status_text: 'Upcoming' });
    assert.equal(row.status, expected);
    assert.equal(row.statusText, label);
    assert.equal(row.sourceStatus, status);
  }
});

test('shared known state controls retain finished, live, halftime and scheduled semantics', () => {
  for (const [status, expected] of [['ft', 'FINISHED'], ['1h', 'IN_PLAY'], ['ht', 'PAUSED'],
    ['upcoming', 'TIMED'], ['not_started', 'TIMED'], ['NS', 'TIMED']]) {
    assert.equal(canonicalMatchStatus(status), expected);
  }
  const bsd = load('../services/bsdSportsService', {
    axios: { create: () => ({}) }, '../utils/logger': logger, './cacheService': cache(),
  });
  assert.equal(bsd.normalizeStatus('unknown_status'), null, 'BSD still rejects unrecognized fixture rows');
  assert.equal(bsd.normalizeStatus('canceled'), 'CANCELLED');
});

test('a cancelled or suspended duplicate cannot lose its state to an upcoming source row', async () => {
  for (const terminal of ['cancelled', 'suspended']) {
    for (const states of [['upcoming', terminal], [terminal, 'upcoming']]) {
      const sc = load('../services/sportscoreService', {
        axios: { get: async () => ({ data: { matches: states.map(status => ({ slug: 'fixture',
          home: 'Home', away: 'Away', time: '2026-10-06T12:00:00Z', status })) } }) },
        '../utils/logger': logger, './cacheService': cache(),
      });
      const rows = await sc.getMatchesByDate('2026-10-06');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, terminal.toUpperCase());
    }
  }
});

test('Kickoff retains actual team, competition and season for every block independent of order', async () => {
  const blocks = [statistics(999, 'National Team', 1, 'International Cup', 2025, 2),
    statistics(529, 'Current Club', 140, 'Domestic League', 2026, 7)];
  const first = await kickoff(() => playerResponse(blocks)).api.getPlayerDetails('ko_p_278', { season: 2026 });
  const reversed = await kickoff(() => playerResponse(blocks.slice().reverse())).api.getPlayerDetails('ko_p_278', { season: 2026 });
  assert.equal(first.seasonStats.goals, 7);
  assert.equal(first.seasonStats.season, '2026');
  assert.equal(first.statsContext.teamId, 'ko_t_529');
  assert.equal(first.statsContext.competitionId, 'PD');
  assert.equal(first.statsContext.competition, 'Domestic League');
  assert.equal(first.statsContext.seasonId, null, 'No unprovided opaque season ID is manufactured');
  assert.deepEqual(reversed.seasonStats, first.seasonStats);
  assert.deepEqual(reversed.statsContext, first.statsContext);
  assert.deepEqual(first.careerBySeason.map(row => [row.teamId, row.leagueId, row.season, row.goals]),
    [['ko_t_999', 1, '2025', 2], ['ko_t_529', 140, '2026', 7]]);
});

test('multiple current club/national scopes leave default totals unavailable and explicit selection separate', async () => {
  const blocks = [statistics(999, 'National Team', 1, 'International Cup', 2026, 2),
    statistics(529, 'Current Club', 140, 'Domestic League', 2026, 7)];
  const { api, calls } = kickoff(() => playerResponse(blocks));
  const ambiguous = await api.getPlayerDetails('ko_p_278', { season: 2026 });
  assert.deepEqual(ambiguous.seasonStats, {});
  assert.equal(ambiguous.statsContext, null);
  assert.equal(ambiguous.team, '');
  assert.equal(ambiguous.statsCoverage.available, false);
  assert.equal(ambiguous.statsCoverage.reason, 'ambiguous_statistics_scope');
  assert.equal(ambiguous.careerBySeason.length, 2);
  const club = await api.getPlayerDetails('ko_p_278', { season: 2026, competition: 'PD', teamId: 'ko_t_529' });
  const national = await api.getPlayerDetails('ko_p_278', { season: 2026, competition: 'WC', teamId: 'ko_t_999' });
  assert.equal(club.seasonStats.goals, 7);
  assert.equal(national.seasonStats.goals, 2);
  assert.equal(calls.length, 3, 'Caches remain separate for distinct requested scopes');
});

test('a historical or unidentified statistics season is retained without claiming requested current totals', async () => {
  for (const declared of [2025, undefined]) {
    const { api } = kickoff(() => playerResponse([statistics(529, 'Club', 140, 'League', declared, 7)]));
    const profile = await api.getPlayerDetails('ko_p_278', { season: 2026 });
    assert.deepEqual(profile.seasonStats, {});
    assert.equal(profile.statsContext, null);
    assert.equal(profile.careerBySeason[0].season, declared ? '2025' : '');
    assert.equal(profile.careerBySeason[0].goals, 7);
    assert.equal(profile.statsCoverage.available, false);
  }
});

test('unverified team/league blocks and malformed numeric statistics never become verified current totals', async () => {
  const block = statistics(-1, 'Foreign Club', 'invalid', 'Unknown League', 2026, 'unknown');
  block.games.minutes = {};
  const { api } = kickoff(() => playerResponse([null, block]));
  const profile = await api.getPlayerDetails('ko_p_278', { season: 2026 });
  assert.deepEqual(profile.seasonStats, {});
  assert.equal(profile.careerBySeason[0].teamId, null);
  assert.equal(profile.careerBySeason[0].competitionId, null);
  assert.equal(profile.careerBySeason[0].goals, null);
  assert.equal(profile.careerBySeason[0].minutes, null);
  assert.equal(profile.statsCoverage.rejectedRows, 1);
});

test('exact player and scope contracts keep zero values and unavailable pass percentages honest', async () => {
  const block = statistics(529, 'Club', 140, 'League', 2026);
  block.league.season_id = 12345;
  block.passes = { accuracy: 51, total: 153 };
  const profile = await kickoff(() => playerResponse([block])).api.getPlayerDetails('ko_p_278', { season: 2026 });
  assert.equal(profile.seasonStats.goals, 0);
  assert.equal(profile.seasonStats.assists, 0);
  assert.equal(profile.seasonStats.seasonId, 12345);
  assert.equal(profile.seasonStats.passAccuracy, null);
  assert.equal(profile.seasonStats.passesAccuracyRaw, 51);
  assert.equal(profile.statsCoverage.complete, false);
  const wrong = kickoff(() => ({ ...playerResponse([block]), parameters: { id: 279 } }));
  assert.equal(await wrong.api.getPlayerDetails('ko_p_278', { season: 2026 }), null);
});

test('explicit foreign roster filters and descriptors are rejected before cache admission', async () => {
  for (const data of [rosterResponse(999),
    rosterResponse(529, { parameters: { team: '999' } }),
    rosterResponse(999, { parameters: { team: '529' } })]) {
    const { api, calls } = kickoff(() => data);
    for (let i = 0; i < 2; i++) {
      const roster = await api.getTeamSquad('ko_t_529');
      assert.deepEqual(roster, []);
      assert.equal(roster.coverage.available, false);
      assert.equal(roster.coverage.reason, 'provider_team_identity_mismatch');
    }
    assert.equal(calls.length, 2, 'Rejected foreign roster is never reused from the requested team cache');
  }
});

test('a verified exact-team roster is cached with usable identities and accurate coverage', async () => {
  const { api, calls } = kickoff(() => rosterResponse());
  const roster = await api.getTeamSquad('ko_t_529');
  assert.equal(roster[0].id, 'ko_p_765');
  assert.equal(roster.coverage.teamId, 'ko_t_529');
  assert.equal(roster.coverage.scope, 'team_roster');
  assert.equal(roster.coverage.available, true);
  assert.equal(roster.coverage.complete, true);
  assert.deepEqual(await api.getTeamSquad('ko_t_529'), roster);
  assert.equal(calls.length, 1);
});

test('missing roster owner, malformed arrays and bad player IDs cannot masquerade as complete squads', async () => {
  for (const data of [{ response: [{ players: [{ id: 765 }] }] },
    rosterResponse(529, { response: [{ team: { id: 529 }, players: {} }] }),
    rosterResponse(529, { response: {} })]) {
    const roster = await kickoff(() => data).api.getTeamSquad('ko_t_529');
    assert.deepEqual(roster, []);
    assert.equal(roster.coverage.available, false);
  }
  const response = rosterResponse();
  response.response[0].players.push({ id: 0 }, { id: 'wrong' });
  const roster = await kickoff(() => response).api.getTeamSquad('ko_t_529');
  assert.equal(roster.length, 1);
  assert.equal(roster.coverage.complete, false);
  assert.equal(roster.coverage.invalidRows, 2);
});

function worldCup(year, id, competitionId = 'WC') {
  return { source: 'bsd', teamId: 'bsd_t_2308', leagueId: 27, competitionId,
    competition: 'World Cup 2026', league: 'World Cup 2026', season: `World Cup ${year}`,
    seasonId: id, seasonInfo: { id, name: `World Cup ${year}`, year, start_date: `${year}-01-01` }, goals: 7 };
}

test('verified World Cup 2022 and 2026 options use neutral context with their own unchanged seasons', () => {
  for (const row of [worldCup(2022, 1320), worldCup(2026, 1319), worldCup(2022, 1320, 'BSD:27')]) {
    const before = structuredClone(row);
    const result = normalizeCareerCompetitionLabels(row);
    assert.equal(result.competition, 'World Cup');
    assert.equal(result.league, 'World Cup');
    assert.equal(result.season, row.season);
    assert.equal(result.seasonId, row.seasonId);
    assert.equal(result.goals, 7);
    assert.equal(result.competitionLabelProvenance.originalLabels.competition, 'World Cup 2026');
    assert.equal(result.competitionLabelProvenance.seasonYear, row.seasonInfo.year);
    assert.deepEqual(row, before);
    assert.deepEqual(normalizeCareerCompetitionLabels(result), result);
  }
});

test('World Cup labels require exact tournament identity and matching verified historical metadata', () => {
  for (const change of [{ competitionId: 'BSD:69' }, { leagueId: 28 }, { provider: 'kickoffapi' },
    { competition: 'World Cup Qualification 2026', league: 'World Cup Qualification 2026' },
    { competition: 'Club World Cup 2026', league: 'Club World Cup 2026' },
    { seasonInfo: null }, { seasonInfo: { id: 1320, name: 'World Cup 2026', year: 2022 } }]) {
    const row = { ...worldCup(2022, 1320), ...change };
    assert.deepEqual(normalizeCareerCompetitionLabels(row), row);
  }
});

test('BSD player career applies neutral World Cup names after historical season enrichment', async () => {
  const previous = process.env.BSD_API_TOKEN;
  process.env.BSD_API_TOKEN = 'offline-test-token';
  let bsd;
  try {
    bsd = load('../services/bsdSportsService', {
      axios: { create: () => ({ get: async path => ({ data:
        path.endsWith('/career/') ? { player_id: 852, seasons: [
          { team_id: 2308, league_id: 27, season_id: 1320, goals: 7 },
          { team_id: 2308, league_id: 27, season_id: 1319, goals: 0 },
        ] } : path.endsWith('/transfers/') ? { player_id: 852, transfers: [] }
          : { id: 852, name: 'Verified Player', current_team_id: 12,
            current_team: { id: 12, name: 'Club' }, national_team: { id: 2308, name: 'National Team' } },
      }) }) }, '../utils/logger': logger, './cacheService': cache(),
    });
  } finally {
    previous === undefined ? delete process.env.BSD_API_TOKEN : process.env.BSD_API_TOKEN = previous;
  }
  const catalog = { rawId: 27, name: 'World Cup 2026', currentSeason: worldCup(2026, 1319).seasonInfo };
  bsd.getLeagues = async () => [catalog];
  bsd.getLeagueSeasons = async id => {
    assert.equal(id, 27); return [worldCup(2022, 1320).seasonInfo];
  };
  const profile = await bsd.getPlayerDetails('bsd_p_852');
  assert.deepEqual(profile.careerBySeason.map(row => [row.competition, row.season, row.team]), [
    ['World Cup', 'World Cup 2022', 'National Team'], ['World Cup', 'World Cup 2026', 'National Team'],
  ]);
  assert.equal(profile.careerBySeason[0].competitionLabelProvenance.originalLabels.competition, 'World Cup 2026');
  assert.equal(catalog.name, 'World Cup 2026', 'The current competition catalog retains its actual edition label');
});

test('team squad and deep-team routes retain unavailable foreign-roster reason and requested context', async () => {
  const { api } = kickoff(() => rosterResponse(999));
  const teams = load('../services/teamService', { './kickoffApiService': api, './sportscoreService': {},
    './bsdSportsService': {}, './searchService': { CLUBS: {} }, '../utils/logger': logger });
  const roster = await teams.getTeamSquadService('ko_t_529');
  assert.equal(roster.coverage.available, false);
  assert.equal(roster.coverage.reason, 'provider_team_identity_mismatch');
  assert.equal(roster.coverage.teamId, 'ko_t_529');
  const controller = load('../controllers/statsController', {
    '../services/kickoffApiService': { ...api, getTeamDetails: async () => ({ id: 'ko_t_529', name: 'Requested Club' }),
      getTeamFixtures: async () => ({ recent: [], upcoming: [] }) },
    '../services/bsdSportsService': {}, '../services/sportscoreService': {}, '../services/sportsDataService': {},
    '../services/teamService': { resolveLocalTeam: () => null, resolveProviderTeamLookup: id => id },
    '../utils/logger': logger, '../services/cacheService': cache(),
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.getDeepTeamDetails({ params: { id: 'ko_t_529' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.squad, []);
  assert.equal(res.body.data.coverage.squad.available, false);
  assert.equal(res.body.data.coverage.squad.reason, 'provider_team_identity_mismatch');
  assert.equal(res.body.data.squadContext.teamId, 'ko_t_529');
  assert.equal(res.body.coverage.squad.available, false);
});

test('deep player controller exposes all retained Kickoff scopes and forwards explicit selection', async () => {
  let suppliedOptions;
  const profile = { id: 'ko_p_278', name: 'Verified Player', team: '', seasonStats: {}, statsContext: null,
    careerBySeason: [statistics(529, 'Club', 140, 'League', 2026)], statsCoverage: { available: false, reason: 'ambiguous_statistics_scope' } };
  const controller = load('../controllers/statsController', {
    '../services/kickoffApiService': { getPlayerDetails: async (id, options) => {
      assert.equal(id, 'ko_p_278'); suppliedOptions = options; return profile;
    } }, '../services/bsdSportsService': {}, '../services/sportscoreService': {},
    '../services/sportsDataService': {}, '../services/teamService': {}, '../utils/logger': logger,
    '../services/cacheService': cache(),
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.getDeepPlayerDetails({ params: { id: 'ko_p_278' }, query: { season: '2026', competition: 'PD', teamId: 'ko_t_529' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(suppliedOptions, { season: '2026', competition: 'PD', teamId: 'ko_t_529' });
  assert.deepEqual(res.body.data.careerBySeason, profile.careerBySeason);
  assert.deepEqual(res.body.data.seasonStats, {});
  assert.deepEqual(res.body.data.statsContext, {});
  assert.deepEqual(res.body.data.statsCoverage, profile.statsCoverage);
});
