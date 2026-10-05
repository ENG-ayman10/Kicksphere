const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverBsdMatchSquad, buildBsdTeamFixtureNumbers, buildBsdTeamStandingNumbers } = require('../services/teamTabCoverageService');

const now = Date.parse('2026-10-05T12:00:00Z');
const teamId = 'bsd_t_465';
function match(id = 1, extra = {}) {
  return { id: 'bsd_' + id, source: 'bsd', provider: 'bsd', status: 'FINISHED', utcDate: '2026-10-04T18:00:00Z',
    homeTeam: { id: teamId, name: 'Haiti' }, awayTeam: { id: 'bsd_t_699', name: 'Costa Rica' },
    competition: { id: 'BSD:65', name: 'Nations League', season: { id: 1633, name: '2026/27' } }, seasonId: 1633,
    score: { fullTime: { home: 1, away: 0 } }, ...extra };
}
function player(id = 7, extra = {}) {
  return { id: 'bsd_p_' + id, provider: 'bsd', source: 'bsd', name: 'Verified Player ' + id,
    number: 10, image: 'https://sports.bzzoiro.com/img/player/' + id + '/', player: { id: 'bsd_p_' + id }, ...extra };
}
function detail(fixture, extra = {}) {
  return { matchInfo: fixture, lineups: { confirmed: true, lineupStatus: 'confirmed', home: [player()], homeBench: [player(8)] },
    coverage: { source: 'bsd', fields: { lineups: true } }, ...extra };
}
function standings(rows, coverage = {}) {
  Object.defineProperty(rows, 'coverage', { value: { source: 'bsd', available: true, complete: true,
    season: { id: 1633, name: '2026/27' }, ...coverage } });
  return rows;
}
function standing(extra = {}) {
  return { team: { id: teamId }, source: 'bsd', season: { id: 1633, name: '2026/27' },
    playedGames: 4, won: 2, draw: 1, lost: 1, goalsFor: 5, goalsAgainst: 3, goalDifference: 2,
    points: 7, position: 2, ...extra };
}
const scope = { competitionId: 'BSD:65', competition: 'Nations League', seasonId: 1633 };

test('an empty national roster can show the latest confirmed same-provider match selection with honest scope', async () => {
  const fixture = match();
  const result = await recoverBsdMatchSquad(teamId, [fixture], async id => { assert.equal(id, fixture.id); return detail(fixture); }, { now });
  assert.equal(result.squad.length, 2);
  assert.equal(result.squad[0].image, 'https://sports.bzzoiro.com/img/player/7/');
  assert.equal(result.squad[0].number, 10);
  assert.deepEqual(result.squad.map(row => row.selectionRole), ['starter', 'bench']);
  assert.equal(result.context.scope, 'match_squad');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.rosterAvailable, false);
  assert.equal(result.coverage.fixtureId, fixture.id);
});

test('recovery chooses exact away-team side and never leaks opponent selection', async () => {
  const fixture = match(1, { homeTeam: { id: 'bsd_t_699' }, awayTeam: { id: teamId } });
  const details = detail(fixture, { lineups: { confirmed: true, home: [player(7)], away: [player(9)], awayBench: [] } });
  const result = await recoverBsdMatchSquad(teamId, [fixture], async () => details, { now });
  assert.deepEqual(result.squad.map(row => row.id), ['bsd_p_9']);
});

test('wrong match identity, switched team IDs, predictions and missing coverage cannot become a national roster', async () => {
  const fixture = match();
  for (const bad of [detail(match(2)), detail(match(1, { homeTeam: { id: 'bsd_t_77' } })),
    detail(fixture, { lineups: { confirmed: true, predicted: true, home: [player()] } }),
    detail(fixture, { lineups: { confirmed: false, home: [player()] } }),
    detail(fixture, { coverage: { fields: { lineups: false } } }),
    detail(fixture, { coverage: { available: false } }),
    detail(fixture, { lineups: { confirmed: true, source: 'kickoffapi', home: [player()] } })]) {
    assert.equal(await recoverBsdMatchSquad(teamId, [fixture], async () => bad, { now }), null);
  }
});

test('recovery rejects unknown, future, stale, unplayed and foreign provider fixtures without upstream requests', async () => {
  const fixtures = [match(1, { utcDate: '2026-10-06T00:00:00Z' }), match(2, { utcDate: '2025-01-01T00:00:00Z' }),
    match(3, { status: 'TIMED' }), match(4, { provider: 'sportscore' }), match(5, { homeTeam: { id: 'bsd_t_88' } }),
    match(6, { utcDate: '2026-09-31T00:00:00Z' })];
  assert.equal(await recoverBsdMatchSquad(teamId, fixtures, async () => assert.fail('No eligible fixture'), { now }), null);
});

test('recovery is bounded to two distinct recent fixtures and tries an older confirmed lineup if latest lacks coverage', async () => {
  const fixtures = [match(1, { utcDate: '2026-10-04T18:00:00Z' }), match(2, { utcDate: '2026-10-03T18:00:00Z' }),
    match(3, { utcDate: '2026-10-02T18:00:00Z' })];
  const called = [];
  const result = await recoverBsdMatchSquad(teamId, fixtures, async (id, fixture) => {
    called.push(id); return id === 'bsd_2' ? detail(fixture) : null;
  }, { now });
  assert.deepEqual(called, ['bsd_1', 'bsd_2']);
  assert.equal(result.context.fixtureId, 'bsd_2');
  called.length = 0;
  assert.equal(await recoverBsdMatchSquad(teamId, fixtures, async id => { called.push(id); throw new Error('Unavailable'); }, { now }), null);
  assert.equal(called.length, 2);
});

test('selection preserves identity by rejecting mismatched nested players and foreign provider photos', async () => {
  const fixture = match();
  const details = detail(fixture, { lineups: { confirmed: true, home: [player(7),
    player(8, { player: { id: 'bsd_p_99' } }), player(9, { provider: 'kickoffapi' }),
    player(10, { teamId: 'bsd_t_699' })], homeBench: [player(7)] } });
  const result = await recoverBsdMatchSquad(teamId, [fixture], async () => details, { now });
  assert.deepEqual(result.squad.map(row => row.id), ['bsd_p_7']);
  assert.equal(result.squad[0].selectionRole, 'starter');
  assert.equal(result.coverage.invalidRows, 3);
  assert.equal(result.coverage.duplicateRows, 1);
});

test('team numbers count verified finished fixture sample and explicitly retain date and mixed competition scope', () => {
  const fixtures = [match(1), match(2, { utcDate: '2026-10-03T18:00:00Z', score: { fullTime: { home: 1, away: 2 } },
    competition: { id: 'BSD:31', name: 'Friendlies', season: { id: 99, name: '2026' } }, seasonId: 99 }),
    match(3, { utcDate: '2026-10-02T18:00:00Z', score: { fullTime: { home: 0, away: 0 } } })];
  const result = buildBsdTeamFixtureNumbers(teamId, fixtures, { now });
  assert.deepEqual(result.stats, { matches: 3, wins: 1, draws: 1, losses: 1, scoresFor: 2, scoresAgainst: 2, cleanSheets: 2 });
  assert.equal(result.context.scope, 'verified_fixture_sample');
  assert.equal(result.context.dateFrom, '2026-10-02');
  assert.equal(result.context.dateTo, '2026-10-04');
  assert.equal(result.context.mixedCompetitionSeasons, true);
  assert.equal(Object.hasOwn(result.context, 'season'), false);
  assert.equal(Object.hasOwn(result.stats, 'points'), false);
  assert.equal(result.coverage.complete, false);
});

test('unplayed, bad scores, wrong identities, conflicted duplicate fixtures and later matches never inflate numbers', () => {
  const fixtures = [match(1), match(1), match(2), match(2, { score: { fullTime: { home: 8, away: 2 } } }),
    match(3, { score: { fullTime: { home: null, away: 0 } } }), match(4, { status: 'IN_PLAY' }),
    match(5, { utcDate: '2026-10-08T00:00:00Z' }), match(6, { source: 'sportscore' }),
    match(7, { homeTeam: { id: 'bsd_t_99' } }), match(8, { score: { fullTime: { home: false, away: 0 } } })];
  const result = buildBsdTeamFixtureNumbers(teamId, fixtures, { now });
  assert.equal(result.stats.matches, 1);
  assert.deepEqual(result.coverage.verifiedFixtureIds, ['bsd_1']);
  assert.deepEqual(result.coverage.conflictedFixtureIds, ['bsd_2']);
  assert.equal(Object.hasOwn(result.context, 'season'), false);
});

test('a verified standings team provides competition-season totals independently of bounded fixture sample', () => {
  const result = buildBsdTeamStandingNumbers(teamId, standings([standing()]), scope);
  assert.deepEqual(result.stats, { matches: 4, wins: 2, draws: 1, losses: 1, scoresFor: 5, scoresAgainst: 3, position: 2, points: 7 });
  assert.equal(result.context.scope, 'competition_season_standings');
  assert.equal(result.context.seasonId, 1633);
  assert.equal(result.context.season, '2026/27');
  assert.equal(result.coverage.complete, true);
});

test('standings rejects wrong or ambiguous identity, season and arithmetic, preserving missing fields as missing', () => {
  for (const rows of [standings([standing({ team: { id: 'bsd_t_699' } })]), standings([standing(), standing({ group: 'Second stage' })]),
    standings([standing({ season: { id: 99 } })]), standings([standing({ playedGames: 5 })]),
    standings([standing({ goalDifference: 6 })]), standings([standing({ source: 'sportscore' })]),
    standings([standing()], { season: { id: 99 } })]) {
    assert.equal(buildBsdTeamStandingNumbers(teamId, rows, scope), null);
  }
  const result = buildBsdTeamStandingNumbers(teamId, standings([standing({ goalsFor: null, goalsAgainst: null, position: null, points: null })]), scope);
  assert.deepEqual(result.stats, { matches: 4, wins: 2, draws: 1, losses: 1 });
  assert.equal(result.coverage.complete, false);
  assert.equal(buildBsdTeamStandingNumbers(teamId, standings([standing()]), { ...scope, seasonId: true }), null);
});
