const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const logger = { warn() {}, error() {}, info() {} };
function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}
const completeRows = (rows = [], extra = {}) => Object.defineProperty(rows.slice(), 'coverage', {
  value: { available: true, complete: true, partial: false, possiblyTruncated: false, ...extra },
});
const fixture = (id, source = 'bsd', code = 'PL', home = 'A', away = 'B', date = '2026-10-01T12:00:00Z') => ({
  id, source, provider: source, utcDate: date, competition: { code, name: code },
  homeTeam: { id: source === 'bsd' ? 'bsd_t_1' : 'sc_t_a', provider: source, name: home },
  awayTeam: { id: source === 'bsd' ? 'bsd_t_2' : 'sc_t_b', provider: source, name: away },
  status: 'FINISHED', score: { fullTime: { home: 1, away: 0 } },
});
const bsd = overrides => ({ isConfigured: () => true,
  LEAGUE_CODE_TO_BSD_ID: { PL: 1 }, BSD_ID_TO_LEAGUE_CODE: { 1: 'PL' }, ...overrides });
function service(sc, bs) {
  return load('../services/sportsDataService', { './sportscoreService': sc, './bsdSportsService': bs,
    './kickoffApiService': {}, '../utils/logger': logger });
}
function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
}
function controller(bs) {
  return load('../controllers/statsController', { '../services/bsdSportsService': bs,
    '../services/sportscoreService': { getMatchDetails: async () => assert.fail('BSD fixture cannot query SportScore'),
      getTeamDetails: async () => assert.fail('BSD club cannot query SportScore'),
      getPlayerDetails: async () => assert.fail('BSD player cannot query SportScore') },
    '../services/kickoffApiService': { getTeamDetails: async () => assert.fail('BSD club cannot query KickOff'),
      getPlayerDetails: async () => assert.fail('BSD player cannot query KickOff') },
    '../services/sportsDataService': {}, '../services/teamService': {}, '../utils/logger': logger,
    '../services/cacheService': { getCached: () => null, setCache() {} } });
}

test('calendar exposes source-quality rejections and official evidence without claiming total coverage', async () => {
  const sourceConflicts = [{ id: 'bsd_223136', reason: 'official_schedule_conflict',
    sourceUrl: 'https://www.concacaf.com/competitions/nations-league/', checkedAt: '2026-10-05T01:10:00Z' }];
  const api = service({ getMatchesByDate: async () => completeRows() }, bsd({ getMatches: async () => completeRows([], {
    complete: false, partial: true, rejectedRows: 1, invalidRows: 0, sourceConflictRows: 1,
    sourceConflicts, reason: 'official_schedule_conflict' }) }));
  const result = await api.getMatchesByDate('2026-10-05');
  const query = result.coverage.queries.find(row => row.provider === 'bsd');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.partial, true);
  assert.equal(query.rejectedRows, 1);
  assert.equal(query.sourceConflictRows, 1);
  assert.deepEqual(query.sourceConflicts, sourceConflicts);
});

test('BSD preferred fixture keeps its own child IDs and exact duplicate SportScore fixture is replaced', async () => {
  const preferred = fixture('bsd_10');
  const sc = fixture('old-score-slug', 'sportscore');
  let active = 0, peak = 0;
  const api = service({ getMatchesByDate: async (_, { competition }) => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return completeRows(competition ? [] : [sc, fixture('global-extra', 'sportscore', 'SC:regional', 'C', 'D')]);
  } }, bsd({ getMatches: async () => completeRows([preferred]) }));
  const result = await api.getMatchesByDate('2026-10-01');
  assert.equal(result.source, 'bsd+sportscore');
  assert.equal(result.data.length, 2);
  const retained = result.data.find(row => row.id === 'bsd_10');
  assert.equal(retained.homeTeam, preferred.homeTeam);
  assert.equal(retained.awayTeam, preferred.awayTeam);
  assert.equal(retained.score, preferred.score);
  assert.deepEqual(retained.providerIdentities.map(row => row.id), ['bsd_10', 'old-score-slug']);
  assert.equal(result.data.some(row => row.id === 'old-score-slug'), false);
  assert.equal(result.data[0].homeTeam.id, 'bsd_t_1');
  assert.equal(sc.homeTeam.id, 'sc_t_a');
  assert.equal(peak, 3);
  assert.equal(result.coverage.complete, true);
});

test('deduplication requires both oriented teams, league and exact kickoff, and keeps IDs from one provider distinct', () => {
  const api = service({}, bsd({}));
  const preferred = fixture('bsd_10');
  const others = [fixture('reversed', 'sportscore', 'PL', 'B', 'A'),
    fixture('opponent', 'sportscore', 'PL', 'A', 'C'),
    fixture('league', 'sportscore', 'PD'),
    fixture('time', 'sportscore', 'PL', 'A', 'B', '2026-10-01T12:01:00Z'),
    fixture('unknown-1', 'sportscore', 'SC:cup'), fixture('unknown-2', 'sportscore', 'SC:cup')];
  assert.equal(api.mergeProviderFixtures([preferred], others).length, 7);
  assert.equal(api.mergeProviderFixtures([], [fixture('same-1'), fixture('same-2')]).length, 2);
});

test('BSD failure remains visible while wider fixtures survive, and valid empty BSD is an available source', async () => {
  let unavailable = true;
  const api = service({ getMatchesByDate: async () => completeRows() }, bsd({
    getMatches: async () => unavailable ? null : completeRows(),
  }));
  const partial = await api.getMatchesByDate('2026-10-01');
  assert.equal(partial.source, 'sportscore');
  assert.equal(partial.coverage.partial, true);
  assert.equal(partial.coverage.queries.at(-1).available, false);
  unavailable = false;
  const empty = await api.getMatchesByDate('2026-10-01');
  assert.equal(empty.source, 'bsd+sportscore');
  assert.equal(empty.coverage.available, true);
  assert.equal(empty.coverage.complete, true);
  assert.deepEqual(empty.data, []);
});

test('BSD calendar cannot certify global completeness when SportScore is capped or unavailable', async () => {
  const api = service({ getMatchesByDate: async (_, { competition }) => completeRows([], competition ? {} :
    { possiblyTruncated: true, complete: false }) }, bsd({ getMatches: async () => completeRows([fixture('bsd_10')]) }));
  const result = await api.getMatchesByDate('2026-10-01');
  assert.equal(result.coverage.possiblyTruncated, true);
  assert.equal(result.coverage.complete, false);
});

test('BSD valid empty standings and scorers do not fall through; outage can use the mapped provider', async () => {
  let unavailable = false, fallbackCalls = 0;
  const api = service({ COMPETITION_SLUGS: { PL: {} }, getStandings: async () => { fallbackCalls++; return [{ position: 1 }]; },
    getTopScorers: async () => { fallbackCalls++; return [{ goals: 1 }]; } }, bsd({
    getStandings: async () => unavailable ? null : completeRows(),
    getTopScorers: async () => unavailable ? null : completeRows(),
  }));
  assert.equal((await api.getStandings('PL')).source, 'bsd');
  assert.equal((await api.getTopScorers('PL', 20)).source, 'bsd');
  assert.equal(fallbackCalls, 0);
  unavailable = true;
  assert.equal((await api.getStandings('PL')).source, 'sportscore');
  assert.equal((await api.getTopScorers('PL', 20)).source, 'sportscore');
  assert.equal(fallbackCalls, 2);
});

test('BSD-only competition must exist in the catalog and can never query another default league', async () => {
  const calls = [];
  const api = service({ COMPETITION_SLUGS: { PL: { name: 'Premier League' } },
    getMatchesByDate: async () => assert.fail('BSD competition cannot query SportScore'),
    getStandings: async () => assert.fail('BSD competition cannot query SportScore') }, bsd({
    getLeagues: async () => [{ id: 1, name: 'Premier League' }, { id: 87, name: 'Specific cup' }],
    getMatches: async params => { calls.push(params); return completeRows(); }, getStandings: async () => null,
  }));
  const result = await api.getCompetitionMatches('BSD:87', '2026-10-01', '2026-10-01');
  assert.equal(result.source, 'bsd');
  assert.deepEqual(result.data, []);
  assert.equal(calls[0].competition, 'BSD:87');
  assert.equal((await api.getCompetitionMatches('BSD:9999', '2026-10-01', '2026-10-01')).statusCode, 400);
  assert.equal((await api.getStandings('BSD:87')).statusCode, 503);
  const catalog = await api.getCompetitionCatalog();
  assert.deepEqual(catalog.map(row => row.code), ['PL', 'BSD:87']);
});

test('BSD deep match, timeline and lineup routes keep prediction status and real incident/player data', async () => {
  const match = fixture('bsd_10');
  const lineups = { home: [{ id: 'bsd_p_20', name: 'Player' }], away: [], confirmed: false,
    predicted: true, lineupStatus: 'predicted' };
  const details = { matchInfo: match, timeline: [{ type: 'goal', minute: 12, side: 'home', player: 'Player' }],
    statistics: [{ label: 'Shots on Target', home: 3, away: 1 },
      { label: 'Expected Goals (xG)', home: 1.23, away: 0.8, homeEstimated: true, awayEstimated: false, estimated: true }], lineups,
    playerStatistics: [{ playerId: 'bsd_p_20', rating: 7.1 }],
    h2h: [fixture('bsd_9')], shotmap: [{ player_id: 20, x: 80 }], momentum: [{ minute: 1 }],
    coverage: { available: true }, availability: { statistics: true } };
  const api = controller({ getMatchDetails: async () => details, getPredictionForMatch: async () => null });
  const deep = response(); await api.getMatchDeepStats({ params: { id: 'bsd_10' } }, deep);
  assert.equal(deep.body.source, 'bsd');
  assert.equal(deep.body.data.goals[0].scorer, 'Player');
  assert.equal(deep.body.data.statistics.team1.shotsOnTarget, 3);
  assert.equal(deep.body.data.statistics.team1.ballPossession, null);
  assert.equal(deep.body.data.statistics.team1.expectedGoals, 1.23);
  assert.equal(deep.body.data.statistics.xgEstimated, true);
  assert.equal(deep.body.data.statistics.team1.xgEstimated, true);
  assert.equal(deep.body.data.statistics.team2.xgEstimated, false);
  assert.equal(deep.body.data.shotMap[0].player_id, 20);
  assert.equal(deep.body.data.pressure[0].minute, 1);
  assert.equal(deep.body.data.lineups.lineupStatus, 'predicted');
  assert.equal(deep.body.data.playerStatistics[0].playerId, 'bsd_p_20');
  assert.equal(deep.body.data.head2head.numberOfMatches, 1);
  const timeline = response(); await api.getMatchTimeline({ params: { id: 'bsd_10' } }, timeline);
  assert.equal(timeline.body.data[0].team, 'A');
  const lineup = response(); await api.getMatchLineups({ params: { id: 'bsd_10' }, query: {} }, lineup);
  assert.equal(lineup.body.data.confirmed, false);
  assert.equal(lineup.body.data.home[0].id, 'bsd_p_20');
});

test('BSD club and player details never join another provider by human-readable name', async () => {
  const api = controller({ getTeamDetails: async () => ({ info: { id: 'bsd_t_1', name: 'Barcelona', country: 'Chile' },
    squad: [{ id: 'bsd_p_20', name: 'Current player' }], matches: { recent: [], upcoming: [] } }),
    getPlayerDetails: async () => ({ id: 'bsd_p_20', name: 'Player', team: 'Barcelona', country: 'Chile',
      goals: 0, statsContext: { competition: 'Known league', season: '2026' } }) });
  const team = response(); await api.getDeepTeamDetails({ params: { id: 'bsd_t_1' } }, team);
  assert.equal(team.body.source, 'bsd');
  assert.equal(team.body.data.info.country, 'Chile');
  const player = response(); await api.getDeepPlayerDetails({ params: { id: 'bsd_p_20' } }, player);
  assert.equal(player.body.data.info.id, 'bsd_p_20');
  assert.equal(player.body.data.seasonStats.goals, 0);
  assert.equal(player.body.data.seasonStats.rating, null);
});

test('unavailable BSD player or fixture does not become an unrelated provider entity', async () => {
  const api = controller({ getPlayerDetails: async () => null, getMatchDetails: async () => null });
  const player = response(); await api.getDeepPlayerDetails({ params: { id: 'bsd_p_20' } }, player);
  assert.equal(player.statusCode, 404);
  const match = response(); await api.getMatchDeepStats({ params: { id: 'bsd_10' } }, match);
  assert.equal(match.statusCode, 404);
});

test('BSD search preserves namesake identities and prefers canonical provider entities over static suggestions', async () => {
  const api = load('../services/searchService', { '../utils/logger': logger,
    './bsdSportsService': bsd({ searchEntities: async () => ({ teams: [
      { id: 'bsd_t_1', targetId: 'bsd_t_1', provider: 'bsd', name: 'Barcelona', country: 'Spain' },
      { id: 'bsd_t_2', targetId: 'bsd_t_2', provider: 'bsd', name: 'Barcelona', country: 'Chile' }], players: [], competitions: [] }) }),
    './sportscoreService': { COMPETITION_SLUGS: {}, searchEntities: async () => ({ teams: [], players: [], competitions: [] }) } });
  const result = await api.searchAll('Barcelona');
  assert.deepEqual(result.teams.map(team => team.id), ['bsd_t_1', 'bsd_t_2']);
  assert.equal(result.teams.some(team => team.id === '81'), false);
  assert.equal(result.source, 'bsd');
});

test('estimated shot flags do not relabel measured team xG or include a withdrawn booking', async () => {
  const api = controller({ getMatchDetails: async () => ({ matchInfo: fixture('bsd_10'),
    statistics: [{ label: 'Expected Goals (xG)', home: 1.57, away: 1.59,
      homeEstimated: false, awayEstimated: false, estimated: false }],
    timeline: [{ type: 'red_card', rescinded: true, minute: 60, side: 'home', player: 'Withdrawn card' }],
    xgEstimated: true, shotmap: [{ estimated: true }], coverage: { available: true } }),
    getPredictionForMatch: async () => null });
  const res = response(); await api.getMatchDeepStats({ params: { id: 'bsd_10' } }, res);
  assert.equal(res.body.data.statistics.xgEstimated, false);
  assert.equal(res.body.data.statistics.xgClassification, 'actual');
  assert.equal(res.body.data.shotMapEstimated, true);
  assert.deepEqual(res.body.data.bookings, []);
  assert.equal(res.body.data.timeline[0].rescinded, true);
});
