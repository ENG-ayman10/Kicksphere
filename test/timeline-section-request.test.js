'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(file); } finally { Module._load = original; }
}
const logger = { info() {}, warn() {}, error() {} };
const rawFixture = { id: 1, league_id: 3, home_team_id: 47, home_team: 'Valencia', away_team_id: 48,
  away_team: 'Real Sociedad', event_date: '2026-09-20T19:00:00Z', status: 'live',
  period: 'first_half', current_minute: 30, home_score: 1, away_score: 0,
  venue_id: 9, home_coach_id: 11, away_coach_id: 12 };
const paths = ['/api/v2/events/1/', '/api/v2/leagues/', '/api/v2/events/1/availability/', '/api/v2/events/1/incidents/'];
function provider(payload, options = {}) {
  const oldToken = process.env.BSD_API_TOKEN; process.env.BSD_API_TOKEN = 'offline-timeline-section';
  const requests = [], cache = new Map(), fixture = options.fixture || rawFixture;
  try {
    const api = load('../services/bsdSportsService', {
      axios: { create: () => ({ get: async path => {
        requests.push(path);
        const data = path === '/api/v2/events/1/' ? fixture
          : path === '/api/v2/leagues/' ? { count: 1, next: null, results: [{ id: 3, name: 'LaLiga', country: 'Spain' }] }
          : path === '/api/v2/events/' ? { count: 1, next: null, results: [fixture] }
          : path.endsWith('/availability/') ? options.availability === undefined
            ? { event_id: 1, available: { stats: true, lineups: true, incidents: true, player_stats: true } } : options.availability
          : path.endsWith('/incidents/') ? payload : { event_id: 1 };
        if (options.strict && !paths.includes(path)) assert.fail('Unexpected optional timeline resource ' + path);
        return { data };
      } }) },
      './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
      '../utils/logger': logger,
    });
    return { api, requests };
  } finally { oldToken === undefined ? delete process.env.BSD_API_TOKEN : process.env.BSD_API_TOKEN = oldToken; }
}
const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
function controller(bsd, extra = {}) {
  return load('../controllers/statsController', {
    '../services/bsdSportsService': bsd, '../services/sportscoreService': {},
    '../services/kickoffApiService': {}, '../services/sportsDataService': {},
    '../services/teamService': {}, '../utils/logger': logger, ...extra,
  });
}
async function read(api, id = 'bsd_1') {
  const res = response(); await api.getMatchTimeline({ params: { id } }, res); return res;
}

test('a cold direct REST timeline reads only its exact event, catalog, availability and incidents; repeated reads share those caches', async () => {
  const { api, requests } = provider({ event_id: 1, incidents: [] }, { strict: true });
  const endpoint = controller(api), first = await read(endpoint), second = await read(endpoint);
  assert.equal(first.statusCode, 200); assert.equal(first.body.source, 'bsd');
  assert.deepEqual(first.body.data, []); assert.equal(first.body.coverage.complete, true);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(requests.slice().sort(), paths.slice().sort());
});

test('the full details reader retains its existing resources while timeline-only skips six optional requests', async () => {
  const payload = { event_id: 1, incidents: [] };
  const full = provider(payload), slim = provider(payload, { strict: true });
  const [a, b] = await Promise.all([full.api.getMatchDetails('bsd_1'), slim.api.getMatchDetails('bsd_1', { timelineOnly: true })]);
  assert.equal(full.requests.length, 10); assert.equal(slim.requests.length, 4);
  assert.ok(full.requests.includes('/api/v2/events/1/lineups/'));
  assert.ok(full.requests.includes('/api/v2/events/1/player-stats/'));
  assert.ok(full.requests.includes('/api/v2/events/1/stats/'));
  assert.ok(full.requests.includes('/api/v2/venues/9/'));
  assert.ok(full.requests.includes('/api/v2/managers/11/'));
  assert.ok(full.requests.includes('/api/v2/managers/12/'));
  assert.deepEqual(b.timeline, a.timeline); assert.deepEqual(b.coverage.incidents, a.coverage.incidents);
  assert.equal(b.coverage.scope, 'match_timeline');
});

test('timeline-only retains goal corrections, own/penalty metadata, scorer and assist identities/photos, team hydration and phase filtering', async () => {
  const payload = { event_id: 1, incidents: [
    { id: 1, type: 'period', text: 'First half', minute: 45 },
    { id: 2, type: 'goal', minute: 20, added_time: 1, period_second: 12, is_home: true,
      player_id: 4, player: { id: 4, name: 'Scorer', photo: 'https://example.test/scorer.png' },
      assist_id: 5, assist: { id: 5, name: 'Assistant' }, goal_type: 'penalty', rescinded: true,
      home_score: 0, away_score: 0 },
    { id: 3, type: 'goal', minute: 21, is_home: false, player_id: 6, player: 'Defender', goal_type: 'own_goal' },
  ] };
  const { api } = provider(payload, { strict: true }), res = await read(controller(api));
  assert.equal(res.body.data.length, 2); assert.equal(res.body.coverage.complete, true);
  const [cancelled, own] = res.body.data;
  assert.equal(cancelled.team, 'Valencia'); assert.equal(cancelled.playerId, 'bsd_p_4');
  assert.equal(cancelled.playerImage, 'https://example.test/scorer.png');
  assert.equal(cancelled.assistId, 'bsd_p_5'); assert.equal(cancelled.assist, 'Assistant');
  assert.equal(cancelled.assistImage, 'https://sports.bzzoiro.com/img/player/5/');
  assert.equal(cancelled.rescinded, true); assert.equal(cancelled.goalType, 'penalty');
  assert.equal(cancelled.addedTime, 1); assert.equal(cancelled.periodSecond, 12);
  assert.equal(own.goalType, 'own_goal'); assert.equal(own.team, 'Real Sociedad');
});

test('timeline-only explicit empty remains authoritative even when other match sections have no data', async () => {
  const { api } = provider({ event_id: 1, incidents: [] }, { strict: true, availability: null });
  const res = await read(controller(api));
  assert.deepEqual(res.body.data, []); assert.equal(res.body.coverage.available, true);
  assert.equal(res.body.coverage.complete, true); assert.equal(res.body.coverage.partial, false);
  assert.equal(res.body.coverage.matchId, 'bsd_1');
});

test('timeline-only outages, foreign event resources and malformed arrays cannot clear known incidents as a complete empty feed', async () => {
  for (const payload of [null, { event_id: 2, incidents: [] }, { event_id: 1 }, { event_id: 1, incidents: {} }]) {
    const { api } = provider(payload, { strict: true }), res = await read(controller(api));
    assert.equal(res.body.source, 'unavailable'); assert.deepEqual(res.body.data, []);
    assert.equal(res.body.coverage.available, false); assert.equal(res.body.coverage.complete, false);
  }
});

test('partial or invalid incident rows remain partial while preserving valid corrections', async () => {
  const event = { id: 3, event_id: 1, type: 'goal', minute: 9, rescinded: true };
  for (const payload of [
    { event_id: 1, incidents: [event, null] },
    { event_id: 1, incidents: [event, { type: 'goal', event_id: 2 }] },
    { event_id: 1, incidents: [event], complete: false },
    { event_id: 1, incidents: [event], coverage: { possiblyTruncated: true } },
  ]) {
    const { api } = provider(payload, { strict: true }), res = await read(controller(api));
    assert.equal(res.body.source, 'bsd'); assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].rescinded, true); assert.equal(res.body.coverage.available, true);
    assert.equal(res.body.coverage.complete, false); assert.equal(res.body.coverage.partial, true);
  }
});

test('an explicit unavailable incident section stops its fetch without declaring a zero-event result', async () => {
  const { api, requests } = provider({ event_id: 1, incidents: [] }, { strict: true,
    availability: { event_id: 1, available: { incidents: false } } });
  const res = await read(controller(api));
  assert.equal(res.body.source, 'unavailable'); assert.equal(res.body.coverage.complete, false);
  assert.equal(requests.includes('/api/v2/events/1/incidents/'), false);
});

test('timeline-only still rejects a mismatched fixture resource and excluded focused competition before incident fanout', async () => {
  const prior = process.env.SPORTS_COMPETITION_SCOPE; process.env.SPORTS_COMPETITION_SCOPE = 'focused';
  try {
    for (const fixture of [{ ...rawFixture, id: 2 }, { ...rawFixture, league_id: 999, league: { name: 'Minor league', country: 'India' } }]) {
      const { api, requests } = provider({ event_id: 1, incidents: [] }, { fixture, strict: true });
      const res = await read(controller(api));
      assert.equal(res.statusCode, 404); assert.equal(requests.some(path => path.endsWith('/incidents/')), false);
      assert.equal(requests.some(path => path.endsWith('/availability/')), false);
    }
  } finally { prior === undefined ? delete process.env.SPORTS_COMPETITION_SCOPE : process.env.SPORTS_COMPETITION_SCOPE = prior; }
});

function originalFixture() {
  return { id: 'valencia-old-route', provider: 'sportscore', source: 'sportscore',
    utcDate: rawFixture.event_date, status: 'IN_PLAY', competition: { code: 'PD', country: 'Spain' },
    homeTeam: { id: 'sc_t_valencia-cf', provider: 'sportscore', name: 'Valencia CF' },
    awayTeam: { id: 'sc_t_real-sociedad', provider: 'sportscore', name: 'Real Sociedad' },
    timeline: [{ type: 'goal', minute: 3, side: 'home', player: 'Old cached scorer' }],
    incidentCoverage: { available: true, complete: false, partial: true } };
}

test('verified legacy timelines request only canonical incident resources and retain public/canonical identity and authoritative empty corrections', async () => {
  const { api, requests } = provider({ event_id: 1, incidents: [] }), options = [], cache = new Map();
  const bridge = load('../services/verifiedMatchDetailsService', {
    './bsdSportsService': { ...api, getMatchDetails: async (id, opts) => { options.push([id, opts]); return api.getMatchDetails(id, opts); } },
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
  });
  const original = originalFixture(), res = await read(controller(api, {
    '../services/verifiedMatchDetailsService': bridge,
    '../services/sportscoreService': { getMatchDetails: async () => original },
  }), original.id);
  assert.deepEqual(options, [['bsd_1', { timelineOnly: true }]]);
  assert.equal(res.body.source, 'bsd'); assert.deepEqual(res.body.data, []);
  assert.equal(res.body.coverage.matchId, original.id); assert.equal(res.body.coverage.canonicalMatchId, 'bsd_1');
  assert.equal(res.body.coverage.complete, true);
  assert.ok(requests.every(path => [...paths, '/api/v2/events/'].includes(path)));
});

test('a canonical incident outage retains the original SportScore timeline and coverage fallback', async () => {
  const { api } = provider(null), cache = new Map();
  const bridge = load('../services/verifiedMatchDetailsService', {
    './bsdSportsService': api,
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
  });
  const original = originalFixture(), res = await read(controller(api, {
    '../services/verifiedMatchDetailsService': bridge,
    '../services/sportscoreService': { getMatchDetails: async () => original },
  }), original.id);
  assert.equal(res.body.source, 'sportscore'); assert.equal(res.body.data[0].player, 'Old cached scorer');
  assert.equal(res.body.coverage.complete, false);
});

test('timeline-only options cannot authorize a changed canonical detail after the calendar identity was verified', async () => {
  const { api } = provider({ event_id: 1, incidents: [] }), cache = new Map();
  const bridge = load('../services/verifiedMatchDetailsService', {
    './bsdSportsService': { ...api, getMatchDetails: async (id, opts) => {
      assert.deepEqual(opts, { timelineOnly: true });
      const details = await api.getMatchDetails(id, opts);
      return { ...details, matchInfo: { ...details.matchInfo, utcDate: '2026-09-21T19:00:00Z' } };
    } },
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
  });
  const original = originalFixture(), res = await read(controller(api, {
    '../services/verifiedMatchDetailsService': bridge,
    '../services/sportscoreService': { getMatchDetails: async () => original },
  }), original.id);
  assert.equal(res.body.source, 'sportscore'); assert.equal(res.body.data[0].player, 'Old cached scorer');
});
