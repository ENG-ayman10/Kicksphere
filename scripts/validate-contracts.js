const assert = require('assert');

const {
  normalizeFavoriteItem,
  normalizePreferences
} = require('../utils/userContracts');
const {
  normalizeCompetitionCode,
  normalizeDateSelector,
  normalizeFootballDataMatch,
  normalizeLimit,
  normalizeLineupPlayers
} = require('../utils/sportsContracts');
const {
  requireAdmin,
  requireSelfOrAdmin
} = require('../middlewares/authorization');
const sportsDataService = require('../services/sportsDataService');
const { searchAll } = require('../services/searchService');
const leagueController = require('../controllers/leagueController');
const teamService = require('../services/teamService');
const kickoffApiService = require('../services/kickoffApiService');
const {
  matchRoom,
  normalizeRoomValue,
  teamRoom,
  userRoom
} = require('../utils/socketRooms');

const runMiddleware = (middleware, req) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      resolve({ status: this.statusCode, body });
    }
  };

  middleware(req, res, () => resolve({ status: 200, next: true }));
});

const runController = (handler, req = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      resolve({ status: this.statusCode, body });
    }
  };

  Promise.resolve(handler(req, res, reject)).catch(reject);
});

const testUserContracts = () => {
  assert.deepStrictEqual(normalizeFavoriteItem({
    type: 'league',
    targetId: ' PL ',
    displayName: 'Premier League'
  }), {
    type: 'competition',
    targetId: 'PL',
    canonicalKey: 'competition:pl',
    displayName: 'Premier League'
  });

  assert.throws(
    () => normalizeFavoriteItem({ type: 'stadium', targetId: 'x' }),
    /Favorite item type/
  );

  assert.deepStrictEqual(normalizePreferences({
    teams: [' Arsenal ', 'arsenal', '', null],
    leagues: ['PL', 'PD', 'PL'],
    content: ['goals', 'goals']
  }), {
    teams: ['Arsenal'],
    leagues: ['PL', 'PD'],
    content: ['goals']
  });
};

const testSportsContracts = () => {
  assert.strictEqual(normalizeCompetitionCode('pl'), 'PL');
  assert.strictEqual(normalizeCompetitionCode('bad'), null);
  assert.strictEqual(normalizeLimit('200', 20, 50), 50);
  assert.strictEqual(normalizeDateSelector('2026-02-31'), null);
  assert.strictEqual(normalizeDateSelector('2026-08-29'), '2026-08-29');

  const match = normalizeFootballDataMatch({
    id: 123,
    utcDate: '2026-08-29T16:00:00Z',
    status: 'TIMED',
    competition: { code: 'PL', name: 'Premier League' },
    area: { name: 'England' },
    homeTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', crest: 'crest-a' },
    awayTeam: { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', crest: 'crest-c' },
    score: { fullTime: { home: 2, away: 1 } }
  });

  assert.strictEqual(match.id, '123');
  assert.strictEqual(match.league, 'Premier League');
  assert.strictEqual(match.leagueId, 'PL');
  assert.strictEqual(match.homeScore, 2);
  assert.strictEqual(match.awayScore, 1);
  assert.strictEqual(match.homeTeam.logo, 'crest-a');

  const players = normalizeLineupPlayers({
    home: [{ id: 1, name: 'Home Player', position: 'Midfielder' }],
    away: [{ id: 2, name: 'Away Player', position: 'Forward' }]
  }, match);

  assert.strictEqual(players.length, 2);
  assert.strictEqual(players[0].team, 'Arsenal');
  assert.strictEqual(players[1].teamId, '61');
};

const testAuthorizationContracts = async () => {
  assert.deepStrictEqual(
    await runMiddleware(requireSelfOrAdmin(), {
      user: { id: 'user-a', role: 'user' },
      params: { userId: 'user-a' }
    }),
    { status: 200, next: true }
  );

  assert.strictEqual(
    (await runMiddleware(requireSelfOrAdmin(), {
      user: { id: 'user-a', role: 'user' },
      params: { userId: 'user-b' }
    })).status,
    403
  );

  assert.deepStrictEqual(
    await runMiddleware(requireAdmin, {
      user: { id: 'admin-a', role: 'admin' },
      params: {}
    }),
    { status: 200, next: true }
  );

  assert.strictEqual(
    (await runMiddleware(requireAdmin, {
      user: { id: 'user-a', role: 'user' },
      params: {}
    })).status,
    403
  );
};

const testSportsDataFacade = async () => {
  const competitions = sportsDataService.getSupportedCompetitions();
  assert(
    competitions.some(competition => (
      competition.id === 'PL' &&
      competition.code === 'PL' &&
      competition.name === 'Premier League'
    ))
  );

  assert.deepStrictEqual(
    await sportsDataService.getCompetitionMatches('BAD', '2026-08-01', '2026-08-31'),
    { success: false, statusCode: 400, message: 'Unsupported league code' }
  );

  assert.deepStrictEqual(
    await sportsDataService.getCompetitionMatches('PL', '2026-02-31', '2026-03-01'),
    { success: false, statusCode: 400, message: 'Invalid date range' }
  );

  assert.deepStrictEqual(
    await sportsDataService.getCompetitionMatches('PL', '2026-09-01', '2026-08-01'),
    { success: false, statusCode: 400, message: 'Invalid date range' }
  );
};

const testSearchContracts = async () => {
  const arsenal = await searchAll('arsenal', { useProvider: false });
  assert.strictEqual(arsenal.source, 'local-fallback');
  assert.strictEqual(arsenal.teams[0].name, 'Arsenal');
  assert.strictEqual(arsenal.teams[0].id, '57');
  assert.strictEqual(arsenal.teams[0].targetId, 'Arsenal');

  const premierLeague = await searchAll('premier', { useProvider: false });
  assert(
    premierLeague.leagues.some(league => (
      league.id === 'PL' &&
      league.targetId === 'PL' &&
      league.name === 'Premier League'
    ))
  );

  assert.deepStrictEqual(await searchAll(' ', { useProvider: false }), {
    teams: [],
    players: [],
    leagues: [],
    matches: [],
    source: 'empty'
  });
};

const testSocketRoomContracts = () => {
  assert.strictEqual(normalizeRoomValue('  Arsenal   FC  '), 'Arsenal FC');
  assert.strictEqual(normalizeRoomValue(''), null);
  assert.strictEqual(normalizeRoomValue('x'.repeat(121)), null);
  assert.strictEqual(userRoom('user-a'), 'user:user-a');
  assert.strictEqual(matchRoom('497410'), 'match:497410');
  assert.strictEqual(teamRoom('Arsenal'), 'team:Arsenal');
};

const testLeagueControllerContracts = async () => {
  const league = await runController(leagueController.getLeagueById, {
    params: { id: 'pl' }
  });

  assert.strictEqual(league.status, 200);
  assert.strictEqual(league.body.data.id, 'PL');
  assert.strictEqual(league.body.data.code, 'PL');

  const missing = await runController(leagueController.getLeagueById, {
    params: { id: 'bad' }
  });

  assert.strictEqual(missing.status, 404);
};

const testTeamContracts = async () => {
  const teams = await teamService.getTeamsService();
  assert.strictEqual(teams.success, true);
  assert(teams.data.some(team => team.name === 'Arsenal' && team.id === '57'));

  const premierLeagueTeams = await teamService.getTeamsService('pl');
  assert.strictEqual(premierLeagueTeams.success, true);
  assert(premierLeagueTeams.data.every(team => team.leagueCode === 'PL'));

  assert.deepStrictEqual(await teamService.getTeamsService('bad'), {
    success: false,
    statusCode: 400,
    message: 'Unsupported league code'
  });

  const arsenal = await teamService.getTeamByIdService('57');
  assert.strictEqual(arsenal.success, true);
  assert.strictEqual(arsenal.data.name, 'Arsenal');
  assert.strictEqual(arsenal.data.targetId, 'Arsenal');
};

const testKickoffApiContracts = async () => {
  if (!process.env.KICKOFF_API_KEY) {
    assert.strictEqual(kickoffApiService.isConfigured(), false);
    assert.deepStrictEqual(await kickoffApiService.getMatchesByDate('TODAY'), []);
    assert.deepStrictEqual(await kickoffApiService.getTeamFixtures('Arsenal'), {
      recent: [],
      upcoming: []
    });
  }
};

(async () => {
  testUserContracts();
  testSportsContracts();
  await testAuthorizationContracts();
  await testSportsDataFacade();
  await testSearchContracts();
  testSocketRoomContracts();
  await testLeagueControllerContracts();
  await testTeamContracts();
  await testKickoffApiContracts();
  console.log('Contract checks passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
