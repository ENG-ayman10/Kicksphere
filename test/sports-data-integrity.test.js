const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const logger = { info() {}, warn() {}, error() {} };
function load(file, mocks = {}) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}
function cacheMock() {
  const map = new Map();
  return { getCached: key => map.get(key), setCache: (key, value) => map.set(key, value) };
}
function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}
function statsController(mocks = {}) {
  return load('../controllers/statsController', {
    '../utils/logger': logger,
    '../services/sportscoreService': {}, '../services/kickoffApiService': {},
    '../services/sportsDataService': {}, '../services/bsdSportsService': {},
    '../services/teamService': { resolveLocalTeam: () => null },
    '../services/cacheService': cacheMock(), ...mocks,
  });
}

test('scores do not fabricate possession, xG, shots, passes, tackles, or missing incident totals', () => {
  const stats = statsController().buildBasicMatchStatistics({
    status: 'FINISHED', score: { fullTime: { home: 3, away: 0 } },
    homeTeam: { name: 'A' }, awayTeam: { name: 'B' },
    timeline: [{ type: 'goal', side: 'home' }],
  });
  assert.deepEqual(stats.goals, { home: 3, away: 0 });
  assert.equal(stats.hasAdvancedStats, false);
  assert.deepEqual(stats.yellowCards, { home: null, away: null });
  assert.deepEqual(stats.substitutions, { home: null, away: null });
  for (const side of [stats.team1, stats.team2]) {
    assert.equal(side.ballPossession, null);
    assert.equal(side.expectedGoals, null);
    assert.equal(side.totalShots, null);
    assert.equal(side.passesTotal, null);
    assert.equal(side.tackles, null);
  }
});

test('actual provider statistics preserve decimal xG and real zeros while unknown fields stay null', () => {
  const stats = statsController().buildBasicMatchStatistics({ providerStatistics: [
    { label: 'Ball Possession', home: '43%', away: '57%' },
    { label: 'Shots on Target', home: 0, away: 5 },
    { label: 'Expected Goals (xG)', home: '0.00', away: '1.74' },
    { label: 'Corner Kicks', home: null, away: 4 },
  ] });
  assert.equal(stats.team1.ballPossession, 43);
  assert.equal(stats.team1.shotsOnTarget, 0);
  assert.equal(stats.team1.expectedGoals, 0);
  assert.equal(stats.team2.expectedGoals, 1.74);
  assert.equal(stats.team1.corners, null);
  assert.equal(stats.hasAdvancedStats, true);
});

test('zero goals retain the exact provider competition and cannot be replaced by stale catalog statistics', async () => {
  const controller = statsController({
    '../services/sportscoreService': { getPlayerDetails: async () => ({
      id: 'mohamed-salah', name: 'Mohamed Salah', team: 'Egypt', competition: 'CAF Africa Cup of Nations',
      matches: 1, goals: 0, assists: 0, minutes: 90, rating: null, ratingRaw: 635, passesAccuracy: 10,
      statsContext: { team: 'Egypt', competition: 'CAF Africa Cup of Nations', season: null },
    }) },
    '../services/kickoffApiService': { getPlayerDetails: async () => assert.fail('Do not mix another competition') },
  });
  const res = response();
  await controller.getDeepPlayerDetails({ params: { id: 'mohamed-salah' } }, res);
  assert.equal(res.body.source, 'sportscore');
  assert.equal(res.body.data.info.team, 'Egypt');
  assert.equal(res.body.data.seasonStats.goals, 0);
  assert.equal(res.body.data.seasonStats.season, null);
  assert.equal(res.body.data.seasonStats.competition, 'CAF Africa Cup of Nations');
  assert.equal(res.body.data.seasonStats.passesAccuracy, null);
  assert.equal(res.body.data.seasonStats.passesAccuracyRaw, 10);
  assert.deepEqual(res.body.data.careerTotals, {});
  assert.deepEqual(res.body.data.honours, []);
  assert.equal(res.body.data.info.age, null);
});

test('arbitrary teams and slug query parameters cannot create a fixture or invented lineup', async () => {
  const controller = statsController({
    '../services/sportscoreService': { getMatchDetails: async () => null },
    '../services/sportsDataService': { getMatchDetails: async () => ({ data: null }) },
    '../services/bsdSportsService': { getMatchDetails: async () => null },
    '../services/kickoffApiService': { getMatchDetails: async () => null, safeFetch: async () => assert.fail('Unknown fixture') },
  });
  const req = { params: { id: 'real-madrid-vs-barcelona-made-up' }, query: { home: 'Real Madrid', away: 'Barcelona' } };
  const detail = response();
  await controller.getMatchDeepStats(req, detail);
  assert.equal(detail.statusCode, 404);
  const lineups = response();
  await controller.getMatchLineups(req, lineups);
  assert.equal(lineups.body.source, 'unavailable');
  assert.deepEqual(lineups.body.data.home, []);
  assert.deepEqual(lineups.body.data.formation, { home: '', away: '' });
});

test('an unavailable SportScore player ID never searches a second provider for a namesake', async () => {
  const controller = statsController({
    '../services/sportscoreService': { getPlayerDetails: async () => null },
    '../services/kickoffApiService': { getPlayerDetails: async () => assert.fail('ID cannot authorize a name search') },
  });
  const res = response();
  await controller.getDeepPlayerDetails({ params: { id: 'carlos-mora' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.data, null);
  assert.equal(res.body.coverage.available, false);
});

test('a returned player must retain the exact requested provider identity', async () => {
  for (const [id, provider, wrong] of [
    ['carlos-mora', 'sportscore', 'carlos-mora-other'],
    ['ko_p_7', 'kickoffapi', 'ko_p_8'],
    ['bsd_p_7', 'bsd', 'bsd_p_8'],
  ]) {
    const controller = statsController({
      '../services/sportscoreService': { getPlayerDetails: async () => provider === 'sportscore' ? { id: wrong, name: 'Carlos Mora' } : null },
      '../services/kickoffApiService': { getPlayerDetails: async () => provider === 'kickoffapi' ? { id: wrong, name: 'Carlos Mora' } : null },
      '../services/bsdSportsService': { getPlayerDetails: async () => provider === 'bsd' ? { id: wrong, name: 'Carlos Mora' } : null },
    });
    const res = response();
    await controller.getDeepPlayerDetails({ params: { id } }, res);
    assert.equal(res.statusCode, 404, id);
    assert.equal(res.body.data, null, id);
    assert.equal(res.body.coverage.reason, 'provider_identity_mismatch', id);
  }
});

test('cached feed identity survives a missing or unrelated widget detail including misleading slug orientation', async () => {
  let unrelated = false;
  const provider = load('../services/sportscoreService', {
    '../utils/logger': logger, './cacheService': cacheMock(),
    axios: { get: async url => ({ data: url.includes('/fixtures/') ? { matches: [{
      slug: 'away-name-vs-home-name-opaque', home: 'Home Name', away: 'Away Name', time: '2026-09-30T02:00:00Z',
      home_score: 0, away_score: 1, status: 'live', competition: 'UEFA Nations League',
    }] } : unrelated ? { match: { home: 'Different A', away: 'Different B', time: '2026-09-30T02:00:00Z' } } : { error: 'not_found' } }) },
  });
  const matches = await provider.getMatchesByDate('2026-09-30');
  const absent = await provider.getMatchDetails(matches[0].id);
  assert.equal(absent.homeTeam.name, 'Home Name');
  assert.equal(absent.awayTeam.name, 'Away Name');
  assert.equal(absent.status, 'IN_PLAY');
  assert.equal(absent.utcDate, '2026-09-30T02:00:00Z');
  assert.equal(absent.score.fullTime.home, 0);
  assert.equal(absent.detailsAvailable, false);
  assert.equal(absent.lineups, null);
  unrelated = true;
  const mismatch = await provider.getMatchDetails(matches[0].id);
  assert.equal(mismatch.homeTeam.name, 'Home Name');
  assert.equal(mismatch.detailsAvailable, false);
});

test('explicit empty league dates never turn into unrelated upcoming fixtures and ranges include every selected day', async () => {
  const requested = [];
  const service = load('../services/sportsDataService', {
    '../utils/logger': logger,
    './sportscoreService': { getMatchesByDate: async date => { requested.push(date); return []; } },
    './kickoffApiService': { getLeagueFixtures: async () => assert.fail('Do not escape requested dates') },
    './bsdSportsService': {},
  });
  const result = await service.getCompetitionMatches('PL', '2026-09-01', '2026-09-09');
  assert.deepEqual(result.data, []);
  assert.equal(requested.length, 9);
  assert.equal(requested.at(-1), '2026-09-09');
});

test('daily BSD fallback filters the requested date even when the provider ignores its filter', async () => {
  const service = load('../services/sportsDataService', {
    '../utils/logger': logger,
    './sportscoreService': { getMatchesByDate: async () => { throw Error('offline'); } },
    './kickoffApiService': {},
    './bsdSportsService': { getMatches: async () => [
      { id: 'bsd_1', utcDate: '2026-09-30T20:00:00Z' }, { id: 'bsd_2', utcDate: '2026-10-01T20:00:00Z' },
    ] },
  });
  const result = await service.getMatchesByDate('2026-09-30');
  assert.deepEqual(result.data.map(value => value.id), ['bsd_1']);
});

test('same home team with a different opponent is never used to attach xG or suppress a live fixture', async () => {
  const primary = { id: 'sportscore-match', homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, competition: { code: 'PL' }, utcDate: '2026-09-30T20:00:00Z' };
  const service = load('../services/sportsDataService', {
    '../utils/logger': logger,
    './sportscoreService': { getLiveMatches: async () => [primary] }, './kickoffApiService': {},
    './bsdSportsService': { getLiveMatches: async () => [{ ...primary, id: 'bsd_1', awayTeam: { name: 'C' }, xg: { liveHome: 2.1 } }] },
  });
  const result = await service.getLiveMatches();
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].xg, undefined);
});

test('provider scoped IDs never fall through to another numeric provider', async () => {
  const seen = [];
  const service = load('../services/sportsDataService', {
    '../utils/logger': logger,
    './sportscoreService': { getMatchDetails: async () => assert.fail('Foreign provider ID') },
    './kickoffApiService': { getMatchDetails: async id => { seen.push(id); return { id }; } },
    './bsdSportsService': { getMatchDetails: async id => { seen.push(id); return { matchInfo: { id } }; } },
  });
  assert.equal((await service.getMatchDetails('ko_123')).data.id, 'ko_123');
  assert.equal((await service.getMatchDetails('bsd_123')).data.id, 'bsd_123');
  assert.equal((await service.getMatchDetails('123')).success, false);
  assert.deepEqual(seen, ['ko_123', 'bsd_123']);
});

test('BSD missing statistics are absent and decimal xG is not truncated or guessed', () => {
  const provider = load('../services/bsdSportsService', { '../utils/logger': logger });
  assert.deepEqual(provider.normalizeStatistics({ home: {}, away: {} }), []);
  assert.deepEqual(provider.normalizeStatistics({ home: { xg: '0.24', shots_on_target: 0 }, away: { xg: '1.97' } }), [
    { label: 'Expected Goals (xG)', home: 0.24, away: 1.97, suffix: '' },
    { label: 'Shots on Target', home: 0, away: null, suffix: '' },
  ]);
});

test('KickOff fixture IDs are scoped, live scores do not establish a winner, and unknown fixtures are not generated', () => {
  const provider = load('../services/kickoffApiService', { '../utils/logger': logger });
  const match = provider.normalizeFixture({ fixture: { id: 123, date: '2026-09-30T20:00:00Z', status: { short: '1H' } },
    teams: { home: { id: 86, name: 'A' }, away: { id: 64, name: 'B' } }, goals: { home: 1, away: 0 } });
  assert.equal(match.id, 'ko_123');
  assert.equal(match.homeTeam.id, 'ko_t_86');
  assert.equal(match.awayTeam.id, 'ko_t_64');
  assert.equal(match.status, 'IN_PLAY');
  assert.equal(match.score.winner, null);
  assert.equal(provider.normalizeFixture({ teams: { home: { name: 'A' }, away: { name: 'B' } } }), null);
});

test('KickOff current season zero appearances stays current and missing player stats stay null', async () => {
  const previous = process.env.KICKOFF_API_KEY;
  process.env.KICKOFF_API_KEY = 'offline-test-key';
  const calls = [];
  try {
    const provider = load('../services/kickoffApiService', {
      '../utils/logger': logger, './cacheService': cacheMock(),
      axios: { create: () => ({ get: async (_endpoint, { params }) => {
        calls.push(params);
        return { data: { response: [{ player: { id: 123, name: 'Test Player' }, statistics: [{
          team: { name: 'Current Team' }, games: { appearences: 0, minutes: 0 }, goals: { total: 0, assists: null },
        }] }] } };
      } }) },
    });
    const player = await provider.getPlayerDetails('ko_p_123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 123);
    assert.equal(player.id, 'ko_p_123');
    assert.equal(player.seasonStats.matches, 0);
    assert.equal(player.seasonStats.goals, 0);
    assert.equal(player.seasonStats.assists, null);
    assert.equal(player.seasonStats.yellowCards, null);
    assert.equal(player.seasonStats.season, `${provider.currentFootballSeason()}/${provider.currentFootballSeason() + 1}`);
  } finally {
    if (previous === undefined) delete process.env.KICKOFF_API_KEY;
    else process.env.KICKOFF_API_KEY = previous;
  }
});

test('lineup provider array order cannot reverse teams or establish a lineup for another kickoff', async () => {
  const home = { id: 'ko_t_1', provider: 'kickoffapi', providerId: '1', name: 'A' };
  const away = { id: 'ko_t_2', provider: 'kickoffapi', providerId: '2', name: 'B' };
  const controller = statsController({
    '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'kickoffapi', data: {
      id: 'ko_10', homeTeam: home, awayTeam: away, utcDate: '2026-09-30T20:00:00Z',
    } }) },
    '../services/kickoffApiService': { safeFetch: async () => ({ response: [
      { team: { id: 2, name: 'B' }, formation: '4-4-2', startXI: [{ player: { id: 200, name: 'Away Player' } }] },
      { team: { id: 1, name: 'A' }, formation: '3-4-3', startXI: [{ player: { id: 100, name: 'Home Player', photo: 'https://example.test/100.png' } }] },
    ] }) },
  });
  const res = response();
  await controller.getMatchLineups({ params: { id: 'ko_10' }, query: {} }, res);
  assert.equal(res.body.data.home[0].name, 'Home Player');
  assert.equal(res.body.data.away[0].id, 'ko_p_200');
  assert.equal(res.body.data.homeFormation, '3-4-3');
  assert.equal(res.body.data.home[0].image, 'https://example.test/100.png');
  assert.equal(res.body.data.home[0].player.image, 'https://example.test/100.png');
  assert.equal(res.body.data.confirmed, false);
});

test('unverified names and identical dates cannot import another provider lineup', async () => {
  const controller = statsController({
    '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'sportscore', data: {
      id: 'club-a-vs-club-b', provider: 'sportscore', homeTeam: { id: 'sc_t_a', name: 'A' },
      awayTeam: { id: 'sc_t_b', name: 'B' }, utcDate: '2026-09-30T20:00:00Z',
    } }) },
    '../services/kickoffApiService': { safeFetch: async () => assert.fail('No verified fixture alternative') },
  });
  const res = response();
  await controller.getMatchLineups({ params: { id: 'club-a-vs-club-b' }, query: {} }, res);
  assert.equal(res.body.source, 'unavailable');
  assert.equal(res.body.coverage.available, false);
});

test('matching lineup team names cannot override different KickOff team IDs', async () => {
  const controller = statsController({
    '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'kickoffapi', data: {
      id: 'ko_10', provider: 'kickoffapi', homeTeam: { id: 'ko_t_1', name: 'A' },
      awayTeam: { id: 'ko_t_2', name: 'B' }, utcDate: '2026-09-30T20:00:00Z',
    } }) },
    '../services/kickoffApiService': { safeFetch: async () => ({ response: [
      { team: { id: 99, name: 'A' }, startXI: [{ player: { id: 100, name: 'Other A' } }] },
      { team: { id: 98, name: 'B' }, startXI: [{ player: { id: 200, name: 'Other B' } }] },
    ] }) },
  });
  const res = response();
  await controller.getMatchLineups({ params: { id: 'ko_10' }, query: {} }, res);
  assert.equal(res.body.source, 'unavailable');
  assert.deepEqual(res.body.data.home, []);
});

test('missing incident coverage is different from a supplied empty event list', async () => {
  for (const [available, expectedSource] of [[false, 'unavailable'], [true, 'sportscore']]) {
    const controller = statsController({
      '../services/sportscoreService': { getMatchDetails: async () => ({
        id: 'a-vs-b', timeline: [], detailsAvailable: true,
        incidentCoverage: { available, complete: false, partial: true },
      }) },
    });
    const res = response();
    await controller.getMatchTimeline({ params: { id: 'a-vs-b' } }, res);
    assert.equal(res.body.source, expectedSource);
    assert.equal(res.body.coverage.available, available);
    assert.deepEqual(res.body.data, []);
  }
});

test('SportScore lineup retains provider portrait and identity on the outer and player records', async () => {
  const provider = load('../services/sportscoreService', {
    '../utils/logger': logger, './cacheService': cacheMock(),
    axios: { get: async () => ({ data: { match: { slug: 'a-vs-b', home: 'A', away: 'B',
      time: '2026-09-30T20:00:00Z', incidents: [], lineups: { home_xi: [
        { slug: 'real-player', name: 'Player', logo: 'https://example.test/player.png' },
      ] } } } }) },
  });
  const match = await provider.getMatchDetails('a-vs-b');
  assert.equal(match.lineups.home[0].image, 'https://example.test/player.png');
  assert.equal(match.lineups.home[0].player.image, 'https://example.test/player.png');
  assert.equal(match.lineups.home[0].provider, 'sportscore');
  assert.equal(match.incidentCoverage.available, true);
});

test('a namesake Barcelona cannot borrow FC Barcelona roster or fixtures through a name alias', async () => {
  const recent = [{ id: 'chilean-cup-match', awayTeam: { name: 'Cobreloa' } }];
  const controller = statsController({
    '../services/sportscoreService': { getTeamDetails: async () => ({
      info: { id: 'barcelona', name: 'Barcelona', logo: 'chilean-club-logo' },
      matches: { recent, upcoming: [] },
    }) },
    '../services/kickoffApiService': {
      getTeamDetails: async () => ({ id: 'ko_t_529', name: 'FC Barcelona', country: 'Spain' }),
      getTeamSquad: async () => assert.fail('Do not attach the other Barcelona roster'),
      getTeamFixtures: async () => assert.fail('Do not attach the other Barcelona fixtures'),
    },
  });
  const res = response();
  await controller.getDeepTeamDetails({ params: { id: 'barcelona' } }, res);
  assert.equal(res.body.source, 'sportscore');
  assert.equal(res.body.data.info.id, 'barcelona');
  assert.equal(res.body.data.info.name, 'Barcelona');
  assert.equal(res.body.data.info.logo, 'chilean-club-logo');
  assert.equal(res.body.data.info.country, undefined);
  assert.deepEqual(res.body.data.squad, []);
  assert.deepEqual(res.body.data.matches.recent, recent);
});

test('verified secondary club identity joins only via its scoped ID and preserves primary provider identity', async () => {
  const requested = [];
  const controller = statsController({
    '../services/sportscoreService': { getTeamDetails: async () => ({
      info: { id: 'real-madrid', name: 'Real Madrid', country: 'Spain' },
      matches: { recent: [], upcoming: [] },
    }) },
    '../services/kickoffApiService': {
      getTeamDetails: async () => ({ id: 'ko_t_541', name: 'Real Madrid', country: 'Spain', venue: 'Provider Stadium' }),
      getTeamSquad: async id => { requested.push(id); return [{ id: 'ko_p_1', name: 'Actual Player' }]; },
      getTeamFixtures: async id => { requested.push(id); return { recent: [], upcoming: [] }; },
    },
  });
  const res = response();
  await controller.getDeepTeamDetails({ params: { id: 'real-madrid' } }, res);
  assert.deepEqual(requested, ['ko_t_541', 'ko_t_541']);
  assert.equal(res.body.data.info.id, 'real-madrid');
  assert.equal(res.body.data.info.venue, 'Provider Stadium');
  assert.equal(res.body.data.squad[0].id, 'ko_p_1');
});

test('identical Barcelona names without country confirmation cannot join a Spanish roster to a Chilean profile', async () => {
  const recent = [{ id: 'chilean-cup-match', competition: { name: 'Chilean Cup' }, awayTeam: { name: 'Cobreloa' } }];
  const controller = statsController({
    '../services/sportscoreService': { getTeamDetails: async () => ({
      info: { id: 'barcelona', slug: 'barcelona', name: 'Barcelona', logo: 'chilean-club-logo', country: '' },
      matches: { recent, upcoming: [] },
    }) },
    '../services/kickoffApiService': {
      getTeamDetails: async () => ({ id: 'ko_t_529', name: 'Barcelona', country: '' }),
      getTeamSquad: async () => assert.fail('Matching generic names are insufficient to establish club identity'),
      getTeamFixtures: async () => assert.fail('Matching generic names are insufficient to establish club identity'),
    },
  });
  const res = response();
  await controller.getDeepTeamDetails({ params: { id: 'barcelona' } }, res);
  assert.equal(res.body.source, 'sportscore');
  assert.deepEqual(res.body.data.squad, []);
  assert.equal(res.body.data.info.id, 'barcelona');
  assert.deepEqual(res.body.data.matches.recent, recent);
});

test('player age is calculated from birth date with birthday boundaries and impossible dates rejected', () => {
  const provider = load('../services/kickoffApiService', { '../utils/logger': logger });
  assert.equal(provider.ageFromBirthDate('2003-09-14', new Date('2026-09-30T00:00:00Z')), 23);
  assert.equal(provider.ageFromBirthDate('2003-09-14', new Date('2026-09-13T23:59:00Z')), 22);
  assert.equal(provider.ageFromBirthDate('2003-09-14', new Date('2026-09-14T00:00:00Z')), 23);
  assert.equal(provider.ageFromBirthDate('2003-02-31', new Date('2026-09-30T00:00:00Z')), null);
  assert.equal(provider.ageFromBirthDate('', new Date('2026-09-30T00:00:00Z')), null);
});

test('legacy Spanish Barcelona ID resolves its explicit provider identity without querying the Chilean slug', async () => {
  const teams = load('../services/teamService', {
    '../utils/logger': logger, './sportscoreService': {}, './kickoffApiService': {},
    './searchService': { CLUBS: { Barcelona: { id: '81', country: 'Spain', leagueCode: 'PD' } } },
  });
  assert.equal(teams.resolveProviderTeamLookup('81'), 'ko_t_529');
  assert.equal(teams.resolveProviderTeamLookup('barcelona'), 'barcelona');
  const requested = [];
  const controller = statsController({
    '../services/teamService': teams,
    '../services/sportscoreService': { getTeamDetails: async () => assert.fail('Legacy ID cannot become a generic Barcelona slug') },
    '../services/kickoffApiService': {
      getTeamDetails: async id => { requested.push(id); return { id, name: 'Barcelona', country: 'Spain' }; },
      getTeamSquad: async id => { requested.push(id); return [{ id: 'ko_p_1', name: 'Actual FC Player' }]; },
      getTeamFixtures: async id => { requested.push(id); return { recent: [], upcoming: [] }; },
    },
  });
  const res = response();
  await controller.getDeepTeamDetails({ params: { id: '81' } }, res);
  assert.equal(res.body.source, 'kickoffapi');
  assert.equal(res.body.data.info.id, 'ko_t_529');
  assert.equal(res.body.data.info.country, 'Spain');
  assert.deepEqual(requested, ['ko_t_529', 'ko_t_529', 'ko_t_529']);
});
