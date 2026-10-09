const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const season = { id: 1307, name: 'Premier League 26/27', start_date: '2026-07-01', end_date: '2027-06-30', is_current: true };
const league = { id: 1, name: 'Premier League', current_season: season };
const page = rows => ({ count: rows.length, next: null, results: rows });
const row = (teamId, changes = {}) => ({ team_id: teamId, league_id: 1, season_id: 1307, matches: 2, minutes: 180, goals: 0, assists: null, avg_rating: 7.1, ...changes });

function setup({ profile = {}, career = [], transfers = [], transfersPlayerId = 852, teams = {} } = {}) {
  const file = require.resolve('../services/bsdSportsService');
  delete require.cache[file];
  const previous = { token: process.env.BSD_API_TOKEN, base: process.env.BSD_BASE_URL };
  process.env.BSD_API_TOKEN = 'test-only-token';
  process.env.BSD_BASE_URL = 'https://sports.bzzoiro.com';
  const requests = [], cache = new Map();
  const original = Module._load;
  Module._load = function(name, parent, isMain) {
    if (name === 'axios') return { create: () => ({ get: async (path, config) => {
      const url = new URL(path, 'https://sports.bzzoiro.com');
      for (const [key, value] of Object.entries(config.params || {})) url.searchParams.set(key, value);
      requests.push(url);
      if (url.pathname === '/api/v2/leagues/') return { data: page([league]) };
      if (url.pathname === '/api/v2/players/852/') return { data: { id: 852, name: 'Known Player', current_team_id: 57, current_team: { id: 57, name: 'Manchester City' }, ...profile } };
      if (url.pathname === '/api/v2/players/852/career/') return { data: { player_id: 852, seasons: career } };
      if (url.pathname === '/api/v2/players/852/transfers/') return { data: { player_id: transfersPlayerId, transfers } };
      const teamId = url.pathname.match(/^\/api\/v2\/teams\/(\d+)\/$/)?.[1];
      if (teamId && Object.hasOwn(teams, teamId)) return { data: teams[teamId] };
      if (url.pathname === '/api/v2/players/852/stats/' || url.pathname === '/api/v2/events/') return { data: page([]) };
      throw new Error('Unexpected mocked endpoint: ' + url.pathname);
    } }) };
    if (name === './cacheService') return { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) };
    if (name === '../utils/logger') return { warn() {}, error() {}, info() {} };
    return original.call(this, name, parent, isMain);
  };
  let service;
  try { service = require(file); } finally {
    Module._load = original;
    previous.token === undefined ? delete process.env.BSD_API_TOKEN : process.env.BSD_API_TOKEN = previous.token;
    previous.base === undefined ? delete process.env.BSD_BASE_URL : process.env.BSD_BASE_URL = previous.base;
  }
  return { service, requests };
}

test('career names reuse exact current, national and transfer IDs without extra team requests', async () => {
  const fixture = setup({
    profile: { national_team: { id: 101, name: 'Norway', is_national: true } },
    career: [row(57), row(141, { goals: 42 }), row(85, { assists: 5 }), row(101)],
    transfers: [
      { from_team_id: 141, from_team_name: 'Borussia Dortmund', to_team_id: 57, to_team_name: 'Manchester City' },
      { from_team_id: 85, from_team_name: 'Red Bull Salzburg', to_team_id: 141, to_team_name: 'Borussia Dortmund' },
    ],
  });
  const details = await fixture.service.getPlayerDetails('bsd_p_852');
  assert.deepEqual(details.career.map(value => value.team), ['Manchester City', 'Borussia Dortmund', 'Red Bull Salzburg', 'Norway']);
  assert.deepEqual(details.career.map(value => value.teamId), ['bsd_t_57', 'bsd_t_141', 'bsd_t_85', 'bsd_t_101']);
  assert.equal(details.career[0].goals, 0);
  assert.equal(details.career[1].goals, 42);
  assert.equal(details.career[2].assists, 5);
  assert.equal(details.career[0].assists, null);
  assert.equal(details.career[0].rating, 7.1);
  assert.equal(details.career[0].seasonId, 1307);
  assert.equal(details.career[0].competitionId, 'PL');
  assert.strictEqual(details.career, details.careerBySeason);
  assert.deepEqual(details.statsContext, { teamId: 'bsd_t_57', team: 'Manchester City', competitionId: 'PL', competition: 'Premier League', seasonId: 1307, season: 'Premier League 26/27', scope: 'team_competition_season', source: 'bsd' });
  assert.equal(details.goals, 0);
  assert.equal(fixture.requests.length, 6);
  assert.ok(fixture.requests.every(url => !url.pathname.startsWith('/api/v2/teams/')));
});

test('authoritative current detail wins over same-ID transfer aliases', async () => {
  const { service } = setup({
    profile: { current_team: { id: 57, name: 'FC Barcelona' } },
    career: [row(57)],
    transfers: [
      { to_team_id: 57, to_team_name: 'Barcelona' },
      { from_team_id: 57, from_team_name: 'Fútbol Club Barcelona' },
    ],
  });
  const details = await service.getPlayerDetails('bsd_p_852');
  assert.equal(details.career[0].team, 'FC Barcelona');
  assert.equal(details.currentTeam.name, 'FC Barcelona');
  assert.equal(details.statsContext.team, 'FC Barcelona');
});

test('conflicting transfer-only labels remain unknown while other exact records enrich', async () => {
  const { service } = setup({
    career: [row(141), row(85)],
    transfers: [
      { from_team_id: 141, from_team_name: 'Club One', to_team_id: 85, to_team_name: 'Known Former Club' },
      { to_team_id: 141, to_team_name: 'Different Club' },
    ],
  });
  const details = await service.getPlayerDetails('bsd_p_852');
  assert.equal(details.career[0].team, '');
  assert.equal(details.career[1].team, 'Known Former Club');
});

test('equivalent whitespace and case transfer records do not create false conflicts', async () => {
  const { service } = setup({
    career: [row(141)],
    transfers: [
      { from_team_id: 141, from_team_name: 'Borussia Dortmund' },
      { to_team_id: 141, to_team_name: ' BORUSSIA   DORTMUND ' },
    ],
  });
  const details = await service.getPlayerDetails('bsd_p_852');
  assert.equal(details.career[0].team.toLowerCase().replace(/\s+/g, ' '), 'borussia dortmund');
});

test('same names, malformed IDs and non-string names never become an identity lookup', async () => {
  const { service } = setup({
    career: [row(141), row(85), row(999)],
    transfers: [
      { from_team_id: 'ko_t_141', from_team_name: 'Manchester City' },
      { to_team_id: 85, to_team_name: { name: 'Invented Club' } },
      { from_team_id: 300, from_team_name: 'Manchester City' },
      { from_team_id: 999, from_team_name: '   ' },
    ],
  });
  const details = await service.getPlayerDetails('bsd_p_852');
  assert.deepEqual(details.career.map(value => value.team), ['', '', '']);
});

test('transfers belonging to another player cannot enrich this career', async () => {
  const { service } = setup({ career: [row(141)], transfersPlayerId: 853,
    transfers: [{ from_team_id: 141, from_team_name: 'Wrong Player Club' }] });
  const details = await service.getPlayerDetails('bsd_p_852');
  assert.equal(details.career[0].team, '');
  assert.deepEqual(details.transfers, []);
});

test('contradictory authoritative team details keep affected career labels unavailable', async () => {
  const { service } = setup({ profile: { national_team: { id: 57, name: 'Different National Team' } }, career: [row(57)],
    transfers: [{ from_team_id: 57, from_team_name: 'Manchester City' }] });
  const details = await service.getPlayerDetails('bsd_p_852');
  assert.equal(details.career[0].team, '');
  assert.equal(details.currentTeam.name, 'Manchester City');
});

test('historical team labels recover by exact BSD ID without changing season numbers', async () => {
  const fixture = setup({ career: [row(57), row(5463, { goals: 3 }), row(5463, { assists: 2 })],
    teams: { 5463: { id: 5463, name: 'Known Under-19 Team' } } });
  const details = await fixture.service.getPlayerDetails('bsd_p_852');
  assert.deepEqual(details.career.map(value => value.team), ['Manchester City', 'Known Under-19 Team', 'Known Under-19 Team']);
  assert.equal(details.career[1].teamId, 'bsd_t_5463');
  assert.equal(details.career[1].goals, 3);
  assert.equal(details.career[2].assists, 2);
  assert.equal(details.career[1].seasonId, 1307);
  assert.equal(fixture.requests.filter(url => url.pathname === '/api/v2/teams/5463/').length, 1);
  assert.equal(details.statsContext.team, 'Manchester City');
  assert.ok(!fixture.requests.some(url => /squad|lineups|standings/.test(url.pathname)));
});

test('foreign and malformed team detail responses never supply historical labels', async () => {
  const fixture = setup({ career: [row(141), row(85), row(999)], teams: {
    141: { id: 57, name: 'Wrong Team' }, 85: { id: 85, name: { text: 'Bad Team' } },
    999: { id: 999, name: '   ' },
  } });
  const details = await fixture.service.getPlayerDetails('bsd_p_852');
  assert.deepEqual(details.career.map(value => value.team), ['', '', '']);
  assert.equal(details.careerCoverage.partial, true);
});

test('historical label recovery uses a bounded batch and reuses team response cache', async () => {
  const fixture = setup({ career: Array.from({ length: 16 }, (_, n) => row(6000 + n)),
    teams: Object.fromEntries(Array.from({ length: 16 }, (_, n) => [6000 + n, { id: 6000 + n, name: 'Club ' + n }])) });
  const first = await fixture.service.getPlayerDetails('bsd_p_852');
  assert.equal(first.career.filter(value => value.team).length, 12);
  assert.equal(first.careerCoverage.partial, true);
  assert.equal(fixture.requests.filter(url => url.pathname.startsWith('/api/v2/teams/')).length, 12);
  await fixture.service.getPlayerDetails('bsd_p_852');
  assert.equal(fixture.requests.filter(url => url.pathname.startsWith('/api/v2/teams/')).length, 12);
});

test('foreign-sport team labels stay unavailable even when the source numeric ID matches', async () => {
  const { service } = setup({ career: [row(5463, { goals: 5 })],
    teams: { 5463: { id: 5463, name: 'France Cricket Under-19 U19' } } });
  const details = await service.getPlayerDetails('bsd_p_852');
  assert.equal(details.career[0].team, '');
  assert.equal(details.career[0].teamId, 'bsd_t_5463');
  assert.equal(details.career[0].goals, 5);
  assert.equal(details.careerCoverage.partial, true);
});
