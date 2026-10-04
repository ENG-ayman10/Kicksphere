const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const season = { id: 1307, name: 'LaLiga 26/27', start_date: '2026-07-01', end_date: '2027-06-30', is_current: true };
const league = { id: 3, name: 'LaLiga', country: 'Spain', current_season: season };
function event(id = 1, changes = {}) {
  return { id, league_id: 3, season_id: 1307, home_team_id: 57, home_team: 'Real Madrid', away_team_id: 44, away_team: 'FC Barcelona', event_date: '2026-10-01T18:00:00+00:00', status: 'notstarted', home_score: null, away_score: null, ...changes };
}
function page(results, next = null, count = results.length) { return { count, next, results }; }
function setup(handler, extraEnv = {}) {
  const file = '../services/bsdSportsService';
  delete require.cache[require.resolve(file)];
  const env = { BSD_API_TOKEN: 'test-only-token', BSD_BASE_URL: 'https://sports.bzzoiro.com', BSD_MAX_PAGES: '10', BSD_MAX_ROWS: '2000', ...extraEnv };
  const oldEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const requests = [], logs = [], map = new Map();
  const original = Module._load;
  let options;
  Module._load = function (name, parent, isMain) {
    if (name === 'axios') return { create(config) { options = config; return { get: async (path, config) => {
      const url = new URL(path, 'https://sports.bzzoiro.com');
      for (const [key, value] of Object.entries(config.params || {})) url.searchParams.set(key, value);
      requests.push(url);
      if (url.pathname === '/api/v2/leagues/') return { data: page([league]) };
      const value = await handler(url, config);
      if (value instanceof Error) throw value;
      return { data: value };
    } }; } };
    if (name === './cacheService') return { getCached: key => map.get(key), setCache: (key, value) => map.set(key, value) };
    if (name === '../utils/logger') return { warn: value => logs.push(value), error: value => logs.push(value), info() {} };
    return original.call(this, name, parent, isMain);
  };
  let service;
  try { service = require(file); } finally {
    Module._load = original;
    for (const key of Object.keys(env)) oldEnv[key] === undefined ? delete process.env[key] : process.env[key] = oldEnv[key];
  }
  return { service, requests, logs, options };
}

test('BSD v2 maps flat IDs, logos, exact UTC kickoff and missing scores without name identities', () => {
  const { service } = setup(() => null);
  const value = service.normalizeMatch(event());
  assert.equal(value.id, 'bsd_1');
  assert.equal(value.homeTeam.id, 'bsd_t_57');
  assert.equal(value.awayTeam.provider, 'bsd');
  assert.equal(value.homeTeam.crest, 'https://sports.bzzoiro.com/img/team/57/');
  assert.equal(value.utcDate, '2026-10-01T18:00:00.000Z');
  assert.equal(value.competition.code, 'PD');
  assert.equal(value.score.fullTime.home, null);
  assert.equal(service.normalizeMatch(event(2, { home_team_id: null })), null);
  assert.equal(service.normalizeMatch(event(2, { away_team_id: 57 })), null);
  assert.equal(service.normalizeMatch(event(2, { event_date: '2026-02-30T12:00:00Z' })), null);
  assert.equal(service.normalizeMatch(event(2, { event_date: '2026-10-01T12:00:00' })), null);
  assert.equal(service.normalizeMatch(event(2, { replaced_by: 3 })), null);
  assert.equal(service.normalizeMatch(event(2, { home_score: 'NaN', away_score: 0 })).score.fullTime.home, null);
  assert.equal(service.normalizeMatch(event(2, { home_score: 'NaN', away_score: 0 })).score.fullTime.away, 0);
});

test('BSD active period variants stay active and cancellations retain their true terminal state', () => {
  const { service } = setup(() => null);
  for (const status of ['first_half', 'second_half', '1st_half', '2nd_half', 'inprogress', 'extra_time', 'penalty_shootout']) assert.equal(service.normalizeStatus(status), 'IN_PLAY');
  assert.equal(service.normalizeStatus('halftime'), 'PAUSED');
  assert.equal(service.normalizeStatus('cancelled'), 'CANCELLED');
  assert.equal(service.normalizeStatus('suspended'), 'SUSPENDED');
  assert.equal(service.normalizeStatus('postponed'), 'POSTPONED');
  assert.equal(service.normalizeStatus('unknown'), null);
});

test('events traverse same-scope pagination, deduplicate IDs and retain total coverage', async () => {
  const { service, requests } = setup(url => url.searchParams.get('offset') === '2' ? page([event(2), event(3)], null, 3) : page([event(1), event(2)], 'https://sports.bzzoiro.com/api/v2/events/?limit=2&offset=2&date_from=2026-10-01&date_to=2026-10-01&league_id=3', 3));
  const rows = await service.getMatches({ date: '2026-10-01', competition: 'PD' });
  assert.deepEqual(rows.map(row => row.id), ['bsd_1', 'bsd_2', 'bsd_3']);
  assert.equal(rows.coverage.complete, true);
  assert.equal(rows.coverage.pages, 2);
  assert.equal(rows.coverage.duplicateRows, 1);
  assert.equal(requests.filter(url => url.pathname === '/api/v2/events/').length, 2);
});

test('a hostile next link never receives authorization and is visibly incomplete', async () => {
  const { service, requests, options } = setup(() => page([event(1)], 'https://other.example/api/v2/events/?offset=1', 2));
  const rows = await service.getMatches({ date: '2026-10-01' });
  assert.equal(rows.length, 1);
  assert.equal(rows.coverage.complete, false);
  assert.equal(rows.coverage.reason, 'invalid_pagination');
  assert.ok(requests.every(url => url.origin === 'https://sports.bzzoiro.com'));
  assert.equal(options.maxRedirects, 0);
});

test('pagination cannot silently change the requested club or date range', async () => {
  const { service, requests } = setup(() => page([event(1)], 'https://sports.bzzoiro.com/api/v2/events/?team_id=44&offset=1', 2));
  const rows = await service.getMatches({ teamId: 'bsd_t_57' });
  assert.equal(rows.coverage.reason, 'changed_pagination_scope');
  assert.equal(requests.filter(url => url.pathname === '/api/v2/events/').length, 1);
});

test('pagination caps and a failed second page preserve partial facts rather than an empty success', async () => {
  const first = setup(() => page([event()], 'https://sports.bzzoiro.com/api/v2/events/?offset=1', 2), { BSD_MAX_PAGES: '1' });
  const capped = await first.service.getMatches();
  assert.equal(capped.coverage.reason, 'page_limit');
  assert.equal(capped.coverage.possiblyTruncated, true);
  const second = setup(url => url.searchParams.has('offset') ? new Error('sensitive request config') : page([event()], 'https://sports.bzzoiro.com/api/v2/events/?offset=1', 2));
  const partial = await second.service.getMatches();
  assert.equal(partial.coverage.reason, 'page_unavailable');
  assert.equal(partial.length, 1);
  assert.ok(second.logs.every(value => !value.includes('sensitive request config') && !value.includes('test-only-token')));
});

test('valid empty responses are cached and outage/error envelopes remain unavailable', async () => {
  const empty = setup(() => page([]));
  const first = await empty.service.getMatches({ date: '2026-10-01' });
  await empty.service.getMatches({ date: '2026-10-01' });
  assert.equal(first.coverage.complete, true);
  assert.equal(first.length, 0);
  assert.equal(empty.requests.filter(url => url.pathname === '/api/v2/events/').length, 1);
  assert.equal(await setup(() => ({ error: 'invalid' })).service.getMatches(), null);
  assert.equal(await setup(() => new Error('offline')).service.getMatches(), null);
});

test('identical concurrent reads share one upstream request', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, requests } = setup(async () => { await gate; return page([event()]); });
  const first = service.getMatches(), second = service.getMatches();
  release();
  await Promise.all([first, second]);
  assert.equal(requests.filter(url => url.pathname === '/api/v2/events/').length, 1);
});

test('upcoming uses notstarted and still verifies status, team, competition, date and season locally', async () => {
  const { service, requests } = setup(() => page([event(1), event(2, { status: 'finished' }), event(3, { league_id: 1 }), event(4, { home_team_id: 12, away_team_id: 44 }), event(5, { event_date: '2026-10-02T12:00:00Z' }), event(6, { season_id: 3 })]));
  const rows = await service.getMatches({ date: '2026-10-01', teamId: 'bsd_t_57', competition: 'PD', seasonId: 1307, status: 'upcoming' });
  assert.deepEqual(rows.map(row => row.id), ['bsd_1']);
  assert.equal(rows.coverage.rejectedRows, 5);
  assert.equal(requests.find(url => url.pathname === '/api/v2/events/').searchParams.get('status'), 'notstarted');
});

test('the live events envelope drops recently finished rows without relabeling them live', async () => {
  const { service } = setup(() => ({ count: 3, events: [event(1, { status: 'finished' }), event(2, { status: 'first_half' }), event(3, { status: 'halftime' })] }));
  const rows = await service.getLiveMatches();
  assert.deepEqual(rows.map(row => row.status), ['IN_PLAY', 'PAUSED']);
  assert.equal(rows.coverage.complete, true);
});

test('predicted lineups retain prediction origin, percent confidence, bench and canonical players', () => {
  const { service } = setup(() => null), match = service.normalizeMatch(event());
  const raw = { event_id: 1, lineup_status: 'predicted', beta: true, lineups: { home: { team_id: 57, confidence: 0.677, formation: '4-3-3', players: [{ id: 594, name: 'Mbappé', jersey_number: 10 }] , substitutes: [{ id: 587, name: 'Rüdiger' }] }, away: { team_id: 44, players: [{ name: 'Anonymous' }] } } };
  const rows = service.normalizeLineups(raw, match);
  assert.equal(rows.confirmed, false);
  assert.equal(rows.predicted, true);
  assert.equal(rows.confidence.home, 67.7);
  assert.equal(rows.confidenceRaw.home, 0.677);
  assert.equal(rows.home[0].id, 'bsd_p_594');
  assert.equal(rows.home[0].position, '');
  assert.equal(rows.homeBench.length, 1);
  assert.equal(rows.away.length, 0);
  assert.equal(service.normalizeLineups({ ...raw, event_id: 2 }, match), null);
});

test('confirmed stats preserve xG per-side flags and never mistake a tackles percentage for tackles count', () => {
  const { service } = setup(() => null);
  const rows = service.normalizeStatistics({ stats: { home: { xg: { actual: 1.55, estimated: false }, tackles_won: 57, total_tackles: 21, accurate_passes: { value: 358, total: 425 }, pass_accuracy_pct: 87.5, offsides: 1, interceptions: 6 }, away: { xg: { actual: 2.06, estimated: true }, total_tackles: 16, pass_accuracy_pct: 89.9, offsides: 2, interceptions: 9 } } });
  assert.deepEqual(rows.find(row => row.label === 'Tackles'), { label: 'Tackles', home: 21, away: 16, suffix: '' });
  assert.equal(rows.find(row => row.label === 'Accurate Passes').home, 358);
  assert.equal(rows.find(row => row.label === 'Expected Goals (xG)').homeEstimated, false);
  assert.equal(rows.find(row => row.label === 'Expected Goals (xG)').awayEstimated, true);
  assert.equal(rows.find(row => row.label === 'Pass Accuracy').home, 87.5);
  assert.equal(rows.find(row => row.label === 'Offsides').away, 2);
  assert.equal(rows.find(row => row.label === 'Interceptions').home, 6);
});

test('summary and timeline are cheap, scoped and retain rescinded incidents and exact identity', async () => {
  const { service, requests } = setup(url => url.pathname.endsWith('/incidents/') ? { event_id: 1, incidents: [{ id: 9, type: 'card', card_type: 'red', player_id: 594, rescinded: true, minute: 44, is_home: true }] } : event());
  const value = await service.getMatchSummary('bsd_1');
  const timeline = await service.getMatchTimeline('bsd_1');
  assert.equal(value.id, 'bsd_1');
  assert.equal(timeline[0].rescinded, true);
  assert.equal(timeline[0].id, 'bsd_inc_9');
  assert.equal(await service.getMatchSummary('ko_1'), null);
  assert.equal(requests.filter(url => url.pathname.includes('/stats/')).length, 0);
});

test('detail availability false avoids calls and returns empty observed fields without fake stats or lineups', async () => {
  const { service, requests } = setup(url => url.pathname.endsWith('/availability/') ? { event_id: 1, available: { stats: false, lineups: false, incidents: false, player_stats: false } } : event());
  const value = await service.getMatchDetails('bsd_1');
  assert.deepEqual(value.statistics, []);
  assert.equal(value.lineups, null);
  assert.deepEqual(value.matchInfo.timeline, []);
  assert.equal(value.venue, null);
  assert.equal(value.homeCoach, null);
  assert.equal(value.coverage.complete, true);
  assert.equal(requests.length, 3);
});

test('detail rejects resources for a different event while preserving the requested fixture', async () => {
  const { service } = setup(url => url.pathname === '/api/v2/events/1/' ? event() : { event_id: 2, available: { stats: true }, stats: { home: { ball_possession: 90 }, away: { ball_possession: 10 } }, incidents: [{ type: 'goal' }], lineups: { home: { players: [{ id: 1, name: 'Wrong' }] } } });
  const value = await service.getMatchDetails('bsd_1');
  assert.equal(value.matchInfo.id, 'bsd_1');
  assert.deepEqual(value.statistics, []);
  assert.equal(value.lineups, null);
  assert.deepEqual(value.incidents, []);
  assert.equal(value.coverage.complete, false);
});

test('BSD standings and scorers preserve known zeros and matching season/provider IDs', async () => {
  const { service } = setup(url => {
    if (url.pathname === '/api/v2/leagues/3/') return league;
    if (url.pathname.endsWith('/standings/')) return { league_id: 3, season, standings: [{ team_id: 57, team_name: 'Real Madrid', position: 1, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 }] };
    return { league_id: 3, season, leaders: [{ rank: 1, player_id: 594, player_name: 'Mbappé', team_id: 57, team_name: 'Real Madrid', value: 0, matches: 1 }] };
  });
  const standings = await service.getStandings('PD'), scorers = await service.getTopScorers('PD');
  assert.equal(standings[0].team.id, 'bsd_t_57');
  assert.equal(standings[0].points, 0);
  assert.equal(scorers[0].player.id, 'bsd_p_594');
  assert.equal(scorers[0].goals, 0);
  assert.equal(scorers[0].assists, null);
});

test('team profile uses scoped event fallback and missing availability is never certified fitness', async () => {
  const { service, requests } = setup(url => {
    if (url.pathname === '/api/v2/teams/57/') return { id: 57, name: 'Real Madrid', venue_id: 57 };
    if (url.pathname.endsWith('/squad/')) return { team_id: 57, count: 1, players: [{ id: 594, name: 'Mbappé', availability: 'available' }] };
    if (url.pathname === '/api/v2/venues/57/') return { id: 57, name: 'Bernabéu', capacity: 83186 };
    if (url.pathname === '/api/v2/events/') return page([event()]);
    return null;
  });
  const value = await service.getTeamDetails('bsd_t_57', { dateFrom: '2026-10-01', dateTo: '2026-10-01' });
  assert.equal(value.squad[0].availability.confirmedFit, false);
  assert.equal(value.venue.name, 'Bernabéu');
  assert.ok(!requests.some(url => url.pathname.endsWith('/fixtures/')));
  assert.equal(await service.getTeamDetails('sc_t_real-madrid'), null);
});

test('career and transfer contexts are distinct; current stats never come from an old club or national team', async () => {
  const { service } = setup(url => {
    if (url.pathname === '/api/v2/players/594/') return { id: 594, name: 'Mbappé', current_team_id: 57, current_team: { id: 57, name: 'Real Madrid' }, rating: 95 };
    if (url.pathname.endsWith('/career/')) return { player_id: 594, seasons: [{ season_id: 1307, league_id: 3, team_id: 44, matches: 7, goals: 9 }, { season_id: 999, league_id: 3, team_id: 57, matches: 40, goals: 50 }] };
    if (url.pathname.endsWith('/transfers/')) return { player_id: 594, transfers: [{ id: 9, transfer_date: '2024-07-01', from_team_id: 114, from_team_name: 'Paris Saint-Germain', to_team_id: 57, to_team_name: 'Real Madrid', fee_eur: 0, fee_description: 'Free' }] };
    return null;
  });
  const value = await service.getPlayerDetails('bsd_p_594');
  assert.equal(value.goals, null);
  assert.equal(value.matches, null);
  assert.equal(value.rating, null);
  assert.equal(value.abilityRating, 95);
  assert.equal(value.statsContext, null);
  assert.equal(value.career.length, 2);
  assert.equal(value.transfers[0].fee, 0);
  assert.equal(value.transfers[0].fromTeamId, 'bsd_t_114');
});

test('historical career seasons use an exact league catalog and preserve known current season statistics', async () => {
  const historical = { id: 294, name: 'LaLiga 25/26', year: 2025, start_date: '2025-07-01', end_date: '2026-06-30', is_current: true };
  const { service, requests } = setup(url => {
    if (url.pathname === '/api/v2/players/594/') return { id: 594, name: 'Mbappé', current_team_id: 57, current_team: { id: 57, name: 'Real Madrid' } };
    if (url.pathname.endsWith('/career/')) return { player_id: 594, seasons: [
      { season_id: 1307, league_id: 3, team_id: 57, matches: 0, goals: 0 },
      { season_id: 294, league_id: 3, team_id: 57, matches: 30, goals: 31 },
      { season_id: 294, league_id: 3, team_id: 44, matches: 2, goals: 1 },
    ] };
    if (url.pathname === '/api/v2/leagues/3/seasons/') return { league_id: 3, count: 2, seasons: [
      { ...season, name: 'Conflicting catalog label', is_current: false }, historical,
    ] };
    if (url.pathname.endsWith('/stats/') || url.pathname === '/api/v2/events/') return page([]);
    return null;
  });
  const value = await service.getPlayerDetails('bsd_p_594');
  assert.equal(value.career[1].season, 'LaLiga 25/26');
  assert.equal(value.career[1].seasonInfo.id, 294);
  assert.equal(value.career[1].seasonInfo.year, 2025);
  assert.equal(value.career[2].season, 'LaLiga 25/26');
  assert.equal(value.career[1].goals, 31);
  assert.deepEqual(value.career[0].seasonInfo, season);
  assert.equal(value.career[0].season, 'LaLiga 26/27');
  assert.equal(value.goals, 0);
  assert.equal(value.statsContext.seasonId, 1307);
  assert.equal(value.statsCoverage.complete, true);
  await service.getPlayerDetails('bsd_p_594');
  assert.equal(requests.filter(url => url.pathname.endsWith('/seasons/')).length, 1);
  assert.ok(requests.filter(url => url.pathname.endsWith('/stats/')).every(url => url.searchParams.get('season_id') === '1307'));
});

test('unavailable or mismatched season catalogs preserve historical statistics without inventing a label', async () => {
  const wrongSeason = { id: 294, name: 'Wrong league season', year: 2025, league_id: 1 };
  const catalogs = [
    null,
    new Error('offline'),
    { league_id: 1, count: 1, seasons: [{ ...wrongSeason, league_id: 3 }] },
    { league_id: 3, count: 1, seasons: [wrongSeason] },
    { league_id: 3, count: 1, seasons: [{ id: 293, name: 'LaLiga 24/25', year: 2024 }] },
  ];
  for (const catalog of catalogs) {
    const { service } = setup(url => {
      if (url.pathname === '/api/v2/players/594/') return { id: 594, name: 'Mbappé', current_team_id: 57 };
      if (url.pathname.endsWith('/career/')) return { player_id: 594, seasons: [{ season_id: 294, league_id: 3, team_id: 57, matches: 2, goals: 0, assists: 0, minutes: 180 }] };
      if (url.pathname.endsWith('/seasons/')) return catalog;
      return null;
    });
    const value = await service.getPlayerDetails('bsd_p_594');
    assert.equal(value.career[0].seasonId, 294);
    assert.equal(value.career[0].season, '');
    assert.equal(value.career[0].seasonInfo, null);
    assert.equal(value.career[0].matches, 2);
    assert.equal(value.career[0].goals, 0);
    assert.equal(value.career[0].minutes, 180);
    assert.equal(value.statsContext, null);
  }
});

test('season catalogs reject ambiguous identities, retain a verified year fallback and bound rows', async () => {
  const { service } = setup(() => ({ league_id: 3, count: 204, seasons: [
    { id: 294, name: 'LaLiga 25/26', year: 2025 },
    { id: 294, name: 'Different season label', year: 2024 },
    { id: 293, year: 2024 },
    { id: 292, name: 'Wrong parent', league: { id: 1 } },
    ...Array.from({ length: 200 }, (_, index) => ({ id: 1000 + index, name: 'Reported season ' + index })),
  ] }));
  const rows = await service.getLeagueSeasons('PD');
  assert.ok(!rows.some(row => row.id === 294 || row.id === 292));
  assert.equal(rows.find(row => row.id === 293).year, 2024);
  assert.equal(rows.find(row => row.id === 293).name, '');
  assert.equal(rows.length, 197);
  assert.equal(rows.coverage.complete, false);
  assert.equal(rows.coverage.possiblyTruncated, true);
  assert.equal(rows.coverage.duplicateRows, 1);
});

test('career season enrichment caps distinct league requests and limits concurrent lookups', async () => {
  let active = 0, peak = 0;
  const { service, requests } = setup(async url => {
    if (url.pathname === '/api/v2/players/594/') return { id: 594, name: 'Mbappé' };
    if (url.pathname.endsWith('/career/')) return { player_id: 594, seasons: Array.from({ length: 25 }, (_, index) => ({ season_id: 5000 + index, league_id: 100 + index, team_id: 57, matches: 1 })) };
    if (url.pathname.endsWith('/seasons/')) {
      const id = Number(url.pathname.split('/')[4]);
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return { league_id: id, count: 1, seasons: [{ id: 5000 + id - 100, name: 'Verified season ' + id }] };
    }
    return null;
  });
  const value = await service.getPlayerDetails('bsd_p_594');
  assert.equal(requests.filter(url => url.pathname.endsWith('/seasons/')).length, 20);
  assert.equal(peak, 3);
  assert.equal(value.career[19].season, 'Verified season 119');
  assert.equal(value.career[20].season, '');
});

test('career season enrichment stops new batches at its total budget and leaves ordinary timeouts unchanged', async () => {
  const originalNow = Date.now;
  let now = 1000;
  const catalogTimeouts = [];
  Date.now = () => now;
  try {
    const { service, requests, options } = setup((url, config) => {
      if (url.pathname.endsWith('/seasons/')) {
        const id = Number(url.pathname.split('/')[4]);
        catalogTimeouts.push(config.timeout);
        assert.ok(config.signal instanceof AbortSignal);
        if (id === 100) now += 4500;
        if (id === 103) now += 3500;
        return { league_id: id, count: 1, seasons: [{ id: 5000 + id - 100, name: 'Verified season ' + id }] };
      }
      assert.equal(config.timeout, undefined);
      assert.equal(config.signal, undefined);
      if (url.pathname === '/api/v2/players/594/') return { id: 594, name: 'Mbappé' };
      if (url.pathname.endsWith('/career/')) return { player_id: 594, seasons: Array.from({ length: 10 }, (_, index) => ({ season_id: 5000 + index, league_id: 100 + index, team_id: 57, matches: 1 })) };
      return null;
    });
    const value = await service.getPlayerDetails('bsd_p_594');
    assert.equal(options.timeout, 10000);
    assert.deepEqual(catalogTimeouts, [4000, 4000, 4000, 3500, 3500, 3500]);
    assert.equal(requests.filter(url => url.pathname.endsWith('/seasons/')).length, 6);
    assert.equal(value.career[5].season, 'Verified season 105');
    assert.equal(value.career[6].season, '');
    assert.equal(value.career[6].matches, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('current season extra statistics use all pages and verified event IDs with no zero fill', async () => {
  const { service } = setup(url => {
    if (url.pathname === '/api/v2/players/594/') return { id: 594, name: 'Mbappé', current_team_id: 57, current_team: { id: 57, name: 'Real Madrid' } };
    if (url.pathname.endsWith('/career/')) return { player_id: 594, seasons: [{ season_id: 1307, league_id: 3, team_id: 57, matches: 2, goals: 0, assists: 0, minutes: 180, avg_rating: 7.5 }] };
    if (url.pathname.endsWith('/transfers/')) return { player_id: 594, transfers: [] };
    if (url.pathname.endsWith('/stats/')) {
      const row = { id: 1, player_id: 594, team_id: 57, event_id: 1, minutes_played: 90, total_shots: 2, total_pass: 20, accurate_pass: 10 };
      return url.searchParams.has('offset') ? page([{ ...row, id: 2, event_id: 2 }], null, 2) : page([row], 'https://sports.bzzoiro.com/api/v2/players/594/stats/?offset=1&team_id=57&season_id=1307', 2);
    }
    if (url.pathname === '/api/v2/events/') return page([event(1, { status: 'finished' }), event(2, { status: 'finished' })]);
    return null;
  });
  const value = await service.getPlayerDetails('bsd_p_594');
  assert.equal(value.goals, 0);
  assert.equal(value.shots, 4);
  assert.equal(value.passes, 40);
  assert.equal(value.passesAccuracy, 50);
  assert.equal(value.tackles, null);
  assert.equal(value.statsCoverage.complete, true);
  assert.equal(value.statsContext.season, 'LaLiga 26/27');
});

test('predictions retain their 0–100 probability scale, normalize model confidence and require exact event identity', async () => {
  const payload = { id: 7, event: event(), markets: { match_result: { prob_home: 34.1, prob_draw: 30.2, prob_away: 35.7 }, expected_goals: { home: 1.12, away: 1.24 }, btts: { prob_yes: 0 } }, model: { confidence: 0.62, version: 'v1' } };
  const { service } = setup(() => payload);
  const value = await service.getPredictionForMatch('bsd_1');
  assert.equal(value.probHomeWin, 34.1);
  assert.equal(value.probBttsYes, 0);
  assert.equal(value.probOver25, null);
  assert.equal(value.confidence, 62);
  assert.equal(value.confidenceRaw, 0.62);
  assert.equal(await service.getPredictionForMatch('bsd_2'), null);
  assert.equal(await service.getPredictionForMatch('ko_1'), null);
});

test('Al Hilal spelling and Arabic search find provider rows without joining namesakes', async () => {
  const { service, requests } = setup(url => {
    if (url.pathname === '/api/v2/teams/') return page(url.searchParams.get('name') === 'Al-Hilal'
      ? [{ id: 262, name: 'Al-Hilal', country: 'Saudi Arabia' }]
      : [{ id: 620, name: 'Al Hilal Benghazi SC', country: 'Libya' }]);
    if (url.pathname === '/api/v2/players/') return page([]);
    return null;
  });
  const result = await service.searchEntities('Al Hilal');
  assert.deepEqual(result.teams.map(row => row.id), ['bsd_t_262', 'bsd_t_620']);
  assert.equal(result.teams[0].country, 'Saudi Arabia');
  const arabic = await service.searchEntities('الهلال');
  assert.equal(arabic.teams[0].id, 'bsd_t_262');
  assert.ok(requests.filter(url => url.pathname === '/api/v2/teams/').length <= 2,
    'Cached spelling variants do not refetch the provider');
});

test('same-name search teams are distinguished by their own current competition fixtures', async () => {
  const { service } = setup(url => {
    if (url.pathname === '/api/v2/teams/') return page([
      { id: 57, name: 'Real Madrid', country: 'Spain' },
      { id: 44, name: 'Real Madrid', country: 'Spain' }
    ]);
    if (url.pathname === '/api/v2/players/') return page([]);
    if (url.pathname === '/api/v2/events/') return page([
      event(1, { event_date: new Date().toISOString() })
    ]);
    return null;
  });
  const result = await service.searchEntities('Real Madrid');
  assert.deepEqual(result.teams.map(row => row.id), ['bsd_t_57', 'bsd_t_44']);
  assert.ok(result.teams.every(row => row.league === 'LaLiga' && row.leagueCode === 'PD'));
});
