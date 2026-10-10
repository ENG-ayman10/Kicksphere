'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
function load(file, mocks = {}) {
  const path = require.resolve(file); delete require.cache[path];
  const original = Module._load;
  Module._load = function(name, parent, main) { return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main); };
  try { return require(path); } finally { Module._load = original; }
}
const logger = { info() {}, warn() {}, error() {} };
const complete = rows => Object.defineProperty(rows, 'coverage', { value: { complete: true, partial: false } });
const fixture = (provider, id, home = 'Valencia', away = 'Real Sociedad') => ({ id, provider, source: provider,
  utcDate: '2026-09-20T19:00:00Z', status: 'FINISHED', competition: { code: 'PD', country: 'Spain' },
  homeTeam: { id: provider === 'bsd' ? 'bsd_t_47' : 'sc_t_valencia-cf', provider, name: home },
  awayTeam: { id: provider === 'bsd' ? 'bsd_t_48' : 'sc_t_real-sociedad', provider, name: away },
  score: { fullTime: { home: 2, away: 3 } } });
function bridge(handler = {}) {
  const cache = new Map(), calls = [];
  const preferred = fixture('bsd', 'bsd_213588'), original = fixture('sportscore', 'valencia-old-route', 'Valencia CF');
  const api = load('../services/verifiedMatchDetailsService', {
    './bsdSportsService': { isConfigured: () => true,
      getMatches: async (...args) => { calls.push(args); await new Promise(resolve => setImmediate(resolve)); return handler.rows ? handler.rows() : complete([preferred]); },
      getMatchDetails: async id => handler.detail ? handler.detail(id) : ({ matchInfo: preferred,
        lineups: { matchId: id, homeTeamId: 'bsd_t_47', awayTeamId: 'bsd_t_48',
          home: [{ id: 'bsd_p_1', provider: 'bsd', rating: 7.5 }], away: [], homeBench: [], awayBench: [] },
        statistics: [{ label: 'Total Shots', home: 14, away: 9 }], coverage: { fields: { stats: true, lineups: true } } }) },
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
  });
  return { api, calls, preferred, original };
}
test('legacy fixture enrichment coalesces one bounded source batch and retains the public route with exact source identities', async () => {
  const { api, calls, original } = bridge();
  const results = await Promise.all([api.resolveVerifiedBsdFixture(original), api.resolveVerifiedBsdFixture(original)]);
  assert.equal(calls.length, 1); assert.equal(results[0].id, 'bsd_213588');
  assert.deepEqual(calls[0], [{ date: '2026-09-20', competition: 'PD', limit: 200 },
    { maxPages: 1, maxRows: 200, timeoutMs: 3500 }]);
  const detail = await api.getVerifiedBsdDetails(original);
  assert.equal(detail.matchInfo.id, original.id); assert.equal(detail.lineups.matchId, original.id);
  assert.equal(detail.matchInfo.canonicalMatchId, 'bsd_213588'); assert.equal(detail.lineups.canonicalMatchId, 'bsd_213588');
  assert.equal(detail.matchInfo.homeTeam.id, 'bsd_t_47'); assert.equal(detail.lineups.homeTeamId, 'bsd_t_47');
  assert.equal(detail.lineups.home[0].id, 'bsd_p_1'); assert.equal(detail.lineups.home[0].rating, 7.5);
  assert.deepEqual(detail.matchInfo.providerIdentities.map(row => row.id), ['bsd_213588', original.id]);
  assert.equal(calls.length, 1);
});
test('foreign competition, kickoff, participant identity or missing explicit IDs cannot authorize a rich match redirect', async () => {
  for (const mutate of [m => m.competition.code = 'PL', m => m.utcDate = '2026-09-21T19:00:00Z',
    m => m.homeTeam.id = 'sc_t_other-valencia', m => m.homeTeam.id = null,
    m => m.awayTeam.name = 'Another Sociedad', m => m.homeTeam.isWomen = true]) {
    const { api, original } = bridge(); mutate(original);
    assert.equal(await api.resolveVerifiedBsdFixture(original), null);
  }
});
test('a provider correction with the same old URL cannot reuse an earlier cached fixture identity', async () => {
  const { api, original, calls } = bridge();
  assert.equal((await api.resolveVerifiedBsdFixture(original)).id, 'bsd_213588');
  const corrected = { ...original, utcDate: '2026-09-21T19:00:00Z' };
  assert.equal(await api.resolveVerifiedBsdFixture(corrected), null);
  assert.equal(calls.length, 2);
});
test('truncated or ambiguous source lists cannot claim unique fixture coverage', async () => {
  for (const rows of [() => Object.defineProperty([fixture('bsd', 'bsd_213588')], 'coverage', { value: { complete: false } }),
    () => complete([fixture('bsd', 'bsd_213588'), fixture('bsd', 'bsd_213589')])]) {
    const { api, original } = bridge({ rows });
    assert.equal(await api.getVerifiedBsdDetails(original), null);
  }
});
test('detail resources are revalidated after the exact calendar join and never attach a changed rematch', async () => {
  for (const detail of [() => ({ matchInfo: fixture('bsd', 'bsd_999') }),
    () => ({ matchInfo: { ...fixture('bsd', 'bsd_213588'), utcDate: '2026-09-21T19:00:00Z' } })]) {
    const { api, original } = bridge({ detail });
    assert.equal(await api.getVerifiedBsdDetails(original), null);
  }
});
function response() { return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } }; }
test('old SportScore deep/timeline routes return recovered exact-source sections instead of shallow duplicate statistics', async () => {
  const { api, original } = bridge();
  const recovered = await api.getVerifiedBsdDetails(original);
  recovered.timeline = [{ type: 'goal', side: 'home', player: 'A', playerId: 'bsd_p_1', playerImage: 'https://example.test/1.png', minute: 11 }];
  recovered.coverage.fields.incidents = true;
  const controller = load('../controllers/statsController', {
    '../services/verifiedMatchDetailsService': { getVerifiedBsdDetails: async match => match.id === original.id ? recovered : null },
    '../services/sportscoreService': { getMatchDetails: async () => original },
    '../services/sportsDataService': {}, '../services/kickoffApiService': {}, '../services/bsdSportsService': {},
    '../services/teamService': {}, '../utils/logger': logger,
  });
  const deep = response(), timeline = response();
  await controller.getMatchDeepStats({ params: { id: original.id }, query: {} }, deep);
  await controller.getMatchTimeline({ params: { id: original.id }, query: {} }, timeline);
  assert.equal(deep.body.source, 'bsd'); assert.equal(deep.body.data.matchInfo.id, original.id);
  assert.equal(deep.body.data.statistics.team1.totalShots, 14);
  assert.equal(timeline.body.source, 'bsd'); assert.equal(timeline.body.data[0].playerId, 'bsd_p_1');
});
test('old lineup route uses only its validated canonical BSD participants and preserves rating and roster ownership', async () => {
  const { api, original } = bridge();
  const recovered = await api.getVerifiedBsdDetails(original);
  const requested = [];
  const controller = load('../controllers/statsController', {
    '../services/verifiedMatchDetailsService': {}, '../services/sportscoreService': {}, '../services/kickoffApiService': {},
    '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'bsd', data: recovered.matchInfo }) },
    '../services/bsdSportsService': { getMatchDetails: async id => {
      requested.push(id); return { ...recovered, matchInfo: { ...recovered.matchInfo, id: 'bsd_213588' },
        lineups: { ...recovered.lineups, matchId: 'bsd_213588' } };
    }, getTeamLineupSquad: async id => Object.defineProperty([{ id: id === 'bsd_t_47' ? 'bsd_p_1' : 'bsd_p_2',
      provider: 'bsd', marketValue: 5000000, marketValueCurrency: 'EUR' }], 'coverage',
      { value: { teamId: id, available: true, complete: true, scope: 'team_roster' } }) },
    '../services/teamService': {}, '../utils/logger': logger,
    '../services/cacheService': { getCached: () => null, setCache() {} },
  });
  const res = response(); await controller.getMatchLineups({ params: { id: original.id }, query: {} }, res);
  assert.deepEqual(requested, ['bsd_213588']); assert.equal(res.body.source, 'bsd');
  assert.equal(res.body.data.matchId, original.id); assert.equal(res.body.data.canonicalMatchId, 'bsd_213588');
  assert.equal(res.body.data.homeTeamId, 'bsd_t_47'); assert.equal(res.body.data.home[0].rating, 7.5);
  assert.equal(res.body.data.home[0].marketValue, 5000000); assert.equal(res.body.data.squadCoverage.home.teamId, 'bsd_t_47');
});
test('a fixture without a verified alternative preserves the original scorer/assist photos and own-goal metadata in its summary', async () => {
  const original = fixture('sportscore', 'score-only-fixture', 'Valencia CF');
  original.timeline = [{ type: 'goal', label: 'Own Goal', goalType: 'own_goal', side: 'home', minute: 19,
    player: 'Scorer', playerId: 'scorer-source-id', playerImage: 'https://example.test/scorer.png',
    assist: 'Assistant', assistId: 'assist-source-id', assistImage: 'https://example.test/assistant.png' }];
  const controller = load('../controllers/statsController', {
    '../services/verifiedMatchDetailsService': { getVerifiedBsdDetails: async () => null },
    '../services/sportscoreService': { getMatchDetails: async () => original },
    '../services/sportsDataService': {}, '../services/kickoffApiService': {}, '../services/bsdSportsService': {},
    '../services/teamService': {}, '../utils/logger': logger,
  });
  const res = response(); await controller.getMatchDeepStats({ params: { id: original.id }, query: {} }, res);
  assert.equal(res.body.source, 'sportscore');
  const goal = res.body.data.goals[0];
  assert.equal(goal.playerId, 'scorer-source-id'); assert.equal(goal.assistId, 'assist-source-id');
  assert.equal(goal.playerImage, original.timeline[0].playerImage); assert.equal(goal.assistImage, original.timeline[0].assistImage);
  assert.equal(goal.goalType, 'own_goal');
});
test('an optional BSD section outage preserves original statistics and lineup with a short recovery TTL', async () => {
  const { api, original } = bridge();
  const recovered = await api.getVerifiedBsdDetails(original);
  original.providerStatistics = [{ label: 'Total Shots', home: 12, away: 8 }];
  original.lineups = { matchId: original.id, source: 'sportscore', confirmed: true,
    homeTeamId: 'sc_t_valencia-cf', awayTeamId: 'sc_t_real-sociedad',
    home: [{ id: 'original-player', provider: 'sportscore', name: 'One', rating: 7.8 }], away: [], homeBench: [], awayBench: [] };
  const ttls = [];
  const controller = load('../controllers/statsController', {
    '../services/verifiedMatchDetailsService': { getVerifiedBsdDetails: async () => ({ ...recovered, statistics: [] }) },
    '../services/sportscoreService': { getMatchDetails: async () => original },
    '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'bsd', data: recovered.matchInfo }) },
    '../services/bsdSportsService': { getMatchDetails: async () => ({ matchInfo: { ...recovered.matchInfo, id: 'bsd_213588' }, lineups: null }) },
    '../services/kickoffApiService': {}, '../services/teamService': {}, '../utils/logger': logger,
    '../services/cacheService': { getCached: () => null, setCache: (_key, _value, ttl) => ttls.push(ttl) },
  });
  const deep = response(), lineups = response();
  await controller.getMatchDeepStats({ params: { id: original.id }, query: {} }, deep);
  await controller.getMatchLineups({ params: { id: original.id }, query: {} }, lineups);
  assert.equal(deep.body.source, 'sportscore'); assert.equal(deep.body.data.statistics.team1.totalShots, 12);
  assert.equal(lineups.body.source, 'sportscore'); assert.equal(lineups.body.data.home[0].id, 'original-player');
  assert.equal(lineups.body.data.home[0].rating, 7.8); assert.equal(lineups.body.data.homeTeamId, 'sc_t_valencia-cf');
  assert.equal(ttls[0], 15000);
});
test('SportScore absent match-rating placeholder is unknown while an actual reported rating remains visible', () => {
  const sc = load('../services/sportscoreService', { '../utils/logger': logger });
  const detail = sc.normalizeMatchDetail({ slug: 'fixture', home: 'Home', away: 'Away', status: 'finished', time: '2026-09-20T19:00:00Z',
    lineups: { home_xi: [{ slug: 'one', name: 'One', rating: 0 }, { slug: 'two', name: 'Two', rating: 7.8 }], away_xi: [] } }, 'fixture');
  assert.equal(detail.lineups.home[0].rating, null); assert.equal(detail.lineups.home[1].rating, 7.8);
});

function bsdProvider(handler) {
  const previous = process.env.BSD_API_TOKEN; process.env.BSD_API_TOKEN = 'test-only';
  const calls = [], cache = new Map();
  const api = load('../services/bsdSportsService', {
    axios: { create: () => ({ get: async (path, config) => { calls.push({ path, config }); return { data: await handler(path, config.params, config) }; } }) },
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
    '../utils/logger': logger,
  });
  if (previous === undefined) delete process.env.BSD_API_TOKEN; else process.env.BSD_API_TOKEN = previous;
  return { api, calls };
}
const rawEvent = { id: 1, event_date: '2026-09-20T19:00:00Z', status: 'finished', league_id: 3,
  home_team_id: 47, away_team_id: 48, home_team: 'Valencia', away_team: 'Real Sociedad', home_score: 2, away_score: 3 };
test('optional fixture lookup bounds its parallel league-catalog read as well as events without uncancelled deadline races', async () => {
  const { api, calls } = bsdProvider(path => path === '/api/v2/leagues/'
    ? { count: 2, next: 'https://sports.bzzoiro.com/api/v2/leagues/?limit=200&offset=200',
      results: [{ id: 3, name: 'La Liga' }] }
    : { count: 1, next: null, results: [rawEvent] });
  const rows = await api.getMatches({ date: '2026-09-20', competition: 'PD', limit: 200 },
    { timeoutMs: 3500, maxPages: 1, maxRows: 200 });
  assert.equal(rows[0].id, 'bsd_1'); assert.equal(rows.coverage.complete, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls.map(call => call.path)), new Set(['/api/v2/events/', '/api/v2/leagues/']));
  for (const call of calls) {
    assert.ok(call.config.timeout > 0 && call.config.timeout <= 3500);
    assert.equal(call.config.signal instanceof AbortSignal, true);
  }
});

test('optional fixture lookup cancels the cold catalog request and gives each later page only the remaining budget', async () => {
  let catalogAborted = false, activeCatalogRequests = 0;
  const { api, calls } = bsdProvider(async (path, _params, config) => {
    if (path === '/api/v2/events/') return { count: 1, next: null, results: [rawEvent] };
    if (path === '/api/v2/leagues/') {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { count: 2, next: 'https://sports.bzzoiro.com/api/v2/leagues/?limit=200&offset=200',
        results: [{ id: 3, name: 'La Liga' }] };
    }
    activeCatalogRequests += 1;
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        catalogAborted = true; activeCatalogRequests -= 1;
        reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' }));
      };
      if (config.signal.aborted) cancelled(); else config.signal.addEventListener('abort', cancelled, { once: true });
    });
  });
  const started = Date.now();
  // The watchdog keeps the test process alive while AbortSignal's unref'ed
  // deadline runs, and fails a regression that leaves the request pending.
  const watchdog = setTimeout(() => {}, 500);
  let rows;
  try {
    rows = await api.getMatches({ date: '2026-09-20', competition: 'PD' },
      { timeoutMs: 80, maxPages: 2, maxRows: 400 });
  } finally { clearTimeout(watchdog); }
  assert.equal(rows[0].id, 'bsd_1');
  assert.equal(catalogAborted, true); assert.equal(activeCatalogRequests, 0);
  const nextPage = calls.find(call => call.path.includes('offset=200'));
  assert.ok(nextPage.config.timeout > 0 && nextPage.config.timeout < 80);
  assert.equal(nextPage.config.signal.aborted, true);
  assert.ok(Date.now() - started < 350);
});

test('bounded match summaries pass the remaining timeout and catalog limits through direct and summary-only calls', async () => {
  for (const summaryOnly of [false, true]) {
    const { api, calls } = bsdProvider(path => path === '/api/v2/leagues/'
      ? { count: 2, next: 'https://sports.bzzoiro.com/api/v2/leagues/?limit=200&offset=200',
        results: [{ id: 3, name: 'La Liga' }] } : rawEvent);
    const options = { timeoutMs: 80, maxPages: 1, maxRows: 200 };
    const match = summaryOnly ? await api.getMatchDetails('bsd_1', { ...options, summaryOnly: true })
      : await api.getMatchSummary('bsd_1', options);
    assert.equal(match.id, 'bsd_1'); assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(call.config.timeout > 0 && call.config.timeout <= 80);
      assert.equal(call.config.signal instanceof AbortSignal, true);
    }
  }
});

test('an exhausted optional request budget starts neither a fixture nor a catalog request', async () => {
  const { api, calls } = bsdProvider(() => { throw new Error('must not be requested'); });
  assert.equal(await api.getMatches({ date: '2026-09-20', competition: 'PD' }, { timeoutMs: 0 }), null);
  assert.equal(await api.getMatchSummary('bsd_1', { timeoutMs: 0 }), null);
  assert.equal(calls.length, 0);
});
test('a missing stats rating cannot retract the same match lineup rating; conflicting duplicate measurements stay unknown', async () => {
  for (const [ratings, expected] of [[[null], 7.5], [[8.1, 8.1], 8.1], [[8.1, 6.2, 8.1], null]]) {
    const { api } = bsdProvider(path => {
      if (path === '/api/v2/events/1/') return rawEvent;
      if (path === '/api/v2/leagues/') return { count: 0, next: null, results: [] };
      if (path.endsWith('/lineups/')) return { event_id: 1, confirmed: true,
        home: { team_id: 47, players: [{ id: 1, name: 'One', rating: 7.5 }], substitutes: [] },
        away: { team_id: 48, players: [], substitutes: [] } };
      if (path.endsWith('/player-stats/')) return { event_id: 1, player_stats: ratings.map(rating =>
        ({ player_id: 1, event_id: 1, team_id: 47, rating })) };
      return { event_id: 1 };
    });
    const result = await api.getMatchDetails('bsd_1');
    assert.equal(result.lineups.home[0].rating, expected);
    assert.equal(result.lineups.home[0].ratingScope, 'match');
    if (expected === null) assert.equal(result.lineups.home[0].ratingCoverage.reason, 'conflicting_match_rating');
  }
});
test('team profile reuses the populated exact-membership profile batch instead of publishing the empty old squad feed', async () => {
  const { api, calls } = bsdProvider(path => {
    if (path === '/api/v2/teams/47/') return { id: 47, name: 'Valencia' };
    if (path === '/api/v2/players/') return { count: 1, next: null, results: [{ id: 1, name: 'One',
      current_team_id: 47, date_of_birth: '2000-01-01', height_cm: 185, market_value_eur: 5000000 }] };
    return { count: 0, next: null, results: [] };
  });
  await api.getTeamLineupSquad('bsd_t_47');
  const profile = await api.getTeamDetails('bsd_t_47');
  assert.equal(profile.squad.length, 1); assert.equal(profile.squad[0].height, 185);
  assert.equal(profile.squad[0].marketValue, 5000000); assert.equal(profile.coverage.squad.complete, true);
  assert.equal(calls.filter(call => call.path === '/api/v2/players/').length, 1);
  assert.equal(calls.some(call => call.path.endsWith('/squad/')), false);
});
test('old club profile only supplements through its exact audited source relation, retaining its public favourite ID', async () => {
  const exactInfo = { id: 'valencia-cf', name: 'Valencia CF' };
  const controller = load('../controllers/statsController', {
    '../services/verifiedMatchDetailsService': {},
    '../services/sportscoreService': { getTeamDetails: async () => ({ info: exactInfo,
      matches: { upcoming: [{ competition: { code: 'PD' } }] } }) },
    '../services/bsdSportsService': { getTeamDetails: async id => ({ info: { id, name: 'Valencia', provider: 'bsd' },
      squad: [{ id: 'bsd_p_1', name: 'One' }], stats: { matches: 7 }, coverage: { squad: { complete: true } } }) },
    '../services/sportsDataService': {}, '../services/kickoffApiService': {},
    '../services/teamService': { resolveLocalTeam: () => null, resolveProviderTeamLookup: () => 'valencia-cf' }, '../utils/logger': logger,
  });
  const res = response(); await controller.getDeepTeamDetails({ params: { id: 'sc_t_valencia-cf' }, query: {} }, res);
  assert.equal(res.body.source, 'sportscore+bsd'); assert.equal(res.body.data.info.id, 'sc_t_valencia-cf');
  assert.equal(res.body.data.info.name, 'Valencia CF'); assert.equal(res.body.data.canonicalTeamId, 'bsd_t_47');
  assert.equal(res.body.data.squad[0].id, 'bsd_p_1'); assert.equal(res.body.data.squadContext.teamId, 'bsd_t_47');
});

test('a different returned SportScore slug, provider or cohort cannot borrow the audited senior BSD club roster', async () => {
  const invalidProfiles = [
    { info: { id: 'another-valencia', slug: 'another-valencia' } },
    { info: { id: 'valencia-cf', slug: 'another-valencia' } },
    { info: { id: 'another-valencia', slug: 'valencia-cf' } },
    { info: { id: 'valencia-cf', provider: 'bsd' } },
    { info: { id: 'valencia-cf', source: 'bsd' } },
    { info: { id: 'valencia-cf' }, source: 'bsd' },
    { info: { id: 'valencia-cf', isWomen: true } },
    { info: { id: 'valencia-cf', gender: 'female' } },
    { info: { id: 'valencia-cf', ageGroup: 'u21' } },
    { info: { id: 'valencia-cf', squadType: 'reserves' } },
  ];
  for (const invalid of invalidProfiles) {
    const requested = [];
    const scTeam = { source: 'sportscore', matches: { upcoming: [{ competition: { code: 'PD' } }] },
      ...invalid, info: { name: 'Valencia CF', country: 'Spain', ...invalid.info } };
    const controller = load('../controllers/statsController', {
      '../services/verifiedMatchDetailsService': {},
      '../services/sportscoreService': { getTeamDetails: async () => scTeam },
      '../services/bsdSportsService': { getTeamDetails: async id => {
        requested.push(id); return { info: { id, name: 'Valencia', provider: 'bsd' },
          squad: [{ id: 'bsd_p_1', name: 'One' }] };
      } },
      '../services/sportsDataService': {}, '../services/kickoffApiService': {},
      '../services/teamService': { resolveLocalTeam: () => null, resolveProviderTeamLookup: () => 'valencia-cf' }, '../utils/logger': logger,
    });
    const res = response(); await controller.getDeepTeamDetails({ params: { id: 'sc_t_valencia-cf' }, query: {} }, res);
    assert.deepEqual(requested, [], JSON.stringify(invalid));
    assert.notEqual(res.body.source, 'sportscore+bsd');
    assert.equal(res.body.data.canonicalTeamId, undefined);
    assert.deepEqual(res.body.data.squad, []);
  }
});
