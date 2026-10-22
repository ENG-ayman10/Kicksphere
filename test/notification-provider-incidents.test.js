'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { incidentAlert, incidentKey } = require('../utils/notificationEventTransitions');

const NOW = Date.parse('2026-10-17T12:00:00Z');
const logger = { info() {}, warn() {}, error() {} };
function load(file, mocks = {}) {
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(resolved); } finally { Module._load = original; }
}

function bsdProvider() {
  const state = { incidents: [], requests: [], match: { id: 1, league_id: 3,
    home_team_id: 57, away_team_id: 44, home_team: 'Home', away_team: 'Away',
    event_date: '2026-10-17T10:50:00Z', status: 'live', period: 'second_half',
    minute: 70, home_score: 0, away_score: 0 } };
  const previous = process.env.BSD_API_TOKEN;
  process.env.BSD_API_TOKEN = 'offline-test-only';
  let service;
  try {
    service = load('../services/bsdSportsService', {
      axios: { create: () => ({ get: async path => {
        state.requests.push(path);
        if (path === '/api/v2/leagues/') return { data: { count: 1, next: null,
          results: [{ id: 3, name: 'LaLiga', country: 'Spain' }] } };
        if (path === '/api/v2/events/1/') return { data: state.match };
        if (path === '/api/v2/events/1/incidents/') return { data: { event_id: 1, incidents: state.incidents } };
        assert.fail('Unexpected alert resource: ' + path);
      } }) },
      './cacheService': { getCached() {}, setCache() {} }, '../utils/logger': logger,
    });
  } finally {
    if (previous === undefined) delete process.env.BSD_API_TOKEN;
    else process.env.BSD_API_TOKEN = previous;
  }
  return { state, match: () => service.normalizeMatch(state.match),
    detail: () => service.getMatchAlertDetails('bsd_1', { includeTimeline: true }), service };
}

function sportscoreProvider() {
  const service = load('../services/sportscoreService', {
    './cacheService': { getCached() {}, setCache() {} }, '../utils/logger': logger,
  });
  const state = { match: { slug: 'home-away', home: 'Home', away: 'Away',
    home_slug: 'home', away_slug: 'away', status: 'live', period: 'second_half',
    time: '2026-10-17T10:50:00Z', live_minute: 70, home_score: 0, away_score: 0 }, incidents: [] };
  return { state, match: () => service.normalizeMatch(state.match),
    detail: async () => service.normalizeMatchDetail({ ...state.match, incidents: state.incidents }, state.match.slug) };
}

function emitter(provider) {
  const persisted = [], delivered = [];
  const devices = { flushRetries: async () => ({}),
    getAlertMatchIds: async matches => new Set(matches.map(match => match.id)),
    findRecipients: async events => new Map([['offline-installation', { userId: 'offline-user',
      events: new Map(events.map(event => [event.eventId, event])) }]]),
    deliver: async (_, event) => { delivered.push(event); } };
  const database = { collection: () => ({ doc: () => ({}), where() { return {
    orderBy() { return this; }, limit() { return this; }, get: async () => ({ docs: [] }),
  }; } }), batch: () => ({ set: (_, event) => persisted.push(event), commit: async () => {} }) };
  const service = load('../services/liveEventsService', {
    '../config/firebase': database, '../utils/logger': logger,
    './bsdSportsService': { isConfigured: () => false }, './sportscoreService': {},
    './sportsDataService': {}, './kickoffApiService': {}, './notificationDeviceService': devices,
    './notificationService': { saveNotification: async () => ({}) },
    './pushNotificationService': { sendPushNotification: async () => assert.fail('Real push forbidden') },
  });
  const io = { sockets: { adapter: { rooms: new Map() } }, to: () => ({ except() { return this; }, emit() {} }) };
  const emit = service.createLiveEventsEmitter({ now: () => NOW,
    provider: { getMatchesByDate: async () => [] }, notificationDevices: devices,
    recipientAllowed: () => true, getMatchDetails: provider.detail });
  return { persisted, delivered, poll: () => emit(io, { liveSnapshot: [provider.match()] }) };
}

const bsdCard = (id, flags = {}) => ({ id, event_id: 1, type: 'card', card_type: 'red',
  minute: 70, player_id: 594, player: 'Player', is_home: true, ...flags });
const scIncident = (id, type = 'red_card', fields = {}) => ({ id, type, time: 70,
  side: 'home', player: 'Player', ...fields });

test('BSD alert reads reject foreign incident rows before they reach the live emitter', async () => {
  const provider = bsdProvider(), h = emitter(provider);
  await h.poll();
  provider.state.incidents = [bsdCard(1, { event_id: 999 }), bsdCard(2, { card_type: 'second_yellow' })];
  const detail = await provider.detail();
  assert.deepEqual(detail.timeline.map(row => row.id), ['bsd_inc_2']);
  assert.equal(detail.timeline.coverage.complete, false);
  assert.equal(detail.timeline.coverage.invalidRows, 1);
  await h.poll(); await h.poll();
  assert.deepEqual(h.delivered.map(event => [event.type, event.cardType, event.incidentId]), [['card', 'red', 'bsd_inc_2']]);
  assert.equal(h.persisted[0].matchId, 'bsd_1');
  assert.ok(provider.state.requests.every(path => ['/api/v2/leagues/', '/api/v2/events/1/', '/api/v2/events/1/incidents/'].includes(path)));
});

test('BSD second-yellow spellings become red cards without guessing an unknown card colour', async () => {
  const provider = bsdProvider();
  const aliases = ['second_yellow', 'second yellow', 'second-yellow-card', 'yellow_red', 'red'];
  provider.state.incidents = aliases.map((card_type, index) => bsdCard(index + 1, { card_type }));
  provider.state.incidents.push(bsdCard(99, { card_type: 'not_red' }));
  const detail = await provider.detail();
  for (const row of detail.timeline.slice(0, aliases.length)) assert.equal(incidentAlert(row).cardType, 'red');
  assert.equal(incidentAlert(detail.timeline.at(-1)), null);
});

for (const [name, create, card] of [['BSD', bsdProvider, bsdCard], ['SportScore', sportscoreProvider,
  (id, flags) => scIncident(id, 'red_card', flags)]]) {
  test(`${name} explicit invalidation flags suppress fresh cancelled cards through normalization and emission`, async () => {
    const provider = create(), h = emitter(provider);
    await h.poll();
    const flags = ['rescinded', 'is_rescinded', 'deleted', 'is_deleted', 'isDeleted'];
    provider.state.incidents = flags.map((flag, index) => card(index + 1, { [flag]: true }));
    const detail = await provider.detail();
    assert.ok(detail.timeline.every(row => incidentAlert(row) === null));
    await h.poll();
    assert.equal(h.persisted.length, 0);
    assert.equal(h.delivered.length, 0);
  });

  test(`${name} strings and numeric flags cannot silently invalidate a valid source card`, async () => {
    const provider = create(), h = emitter(provider);
    await h.poll();
    provider.state.incidents = [card(1, { rescinded: 'false', is_rescinded: 'true', deleted: 1, is_deleted: 'true', isDeleted: 'false' })];
    const row = (await provider.detail()).timeline[0];
    assert.equal(row.rescinded, false);
    assert.equal(row.deleted, false);
    assert.equal(incidentAlert(row).cardType, 'red');
    await h.poll(); await h.poll();
    assert.equal(h.delivered.length, 1);
  });
}

test('SportScore stable source IDs prevent translated or corrected display metadata from replaying a card', async () => {
  const provider = sportscoreProvider(), h = emitter(provider);
  await h.poll();
  provider.state.incidents = [scIncident('source-7')];
  const before = (await provider.detail()).timeline[0];
  await h.poll();
  provider.state.incidents = [scIncident('source-7', 'red_card', { player: 'اللاعب', time: 71, player_image: 'https://example.com/new.png' })];
  const after = (await provider.detail()).timeline[0];
  assert.equal(before.id, 'source-7');
  assert.equal(incidentKey(before), incidentKey(after));
  await h.poll();
  assert.deepEqual(h.delivered.map(event => event.incidentId), ['source-7']);
  assert.equal(h.persisted.length, 1);
});

test('SportScore a source yellow-to-second-yellow upgrade emits exactly one red transition for the same incident ID', async () => {
  const provider = sportscoreProvider(), h = emitter(provider);
  await h.poll();
  provider.state.incidents = [scIncident('upgraded', 'yellow_card')]; await h.poll();
  provider.state.incidents = [scIncident('upgraded', 'card', { card_type: 'second_yellow' })];
  await h.poll(); await h.poll();
  assert.deepEqual(h.delivered.map(event => [event.cardType, event.isDetailed]), [['yellow', true], ['red', false]]);
  assert.equal(new Set(h.delivered.map(event => event.eventId)).size, 2);
});

test('SportScore explicit penalty outcomes and shootout periods survive raw-to-emitter normalization', async () => {
  const provider = sportscoreProvider(), h = emitter(provider);
  await h.poll();
  const ordinary = ['penalty_awarded', 'penalty_missed', 'penalty_saved'].map((type, index) => scIncident('ordinary-' + index, type));
  provider.state.incidents = ordinary; await h.poll();
  assert.deepEqual(h.delivered.map(event => event.penaltyType), ['penalty_awarded', 'penalty_missed', 'penalty_saved']);
  provider.state.match.period = 'penalties'; provider.state.match.live_minute = 120;
  const kicks = ['goal', 'penalty_missed', 'penalty_saved'].map((type, index) => scIncident('shootout-' + index, type,
    { period: 'penalty_shootout', time: 0 }));
  provider.state.incidents = [...ordinary, ...kicks];
  await h.poll(); await h.poll();
  const shootout = h.delivered.filter(event => event.phase === 'PENALTIES' && event.type === 'penalty');
  assert.deepEqual(shootout.map(event => event.penaltyType), ['shootout_scored', 'shootout_missed', 'shootout_saved']);
  assert.equal(h.delivered.filter(event => event.type === 'goal').length, 0);
});

test('SportScore published scorer, assist, source score and substitution identity survive the notification path', async () => {
  const provider = sportscoreProvider(), h = emitter(provider);
  await h.poll();
  provider.state.match.home_score = 1;
  provider.state.incidents = [scIncident('goal-1', 'goal', { player_id: 'scorer', player: 'Scorer',
    assist_id: 'assistant', assist: 'Assist', player_image: 'https://example.com/scorer.png',
    assist_image: 'https://example.com/assist.png', home_score: 1, away_score: 0, added_time: 2, period_second: 25 }),
  scIncident('sub-1', 'substitution', { player_id: 'incoming', player: 'Incoming',
    player_out_id: 'outgoing', player_out: { id: 'outgoing', name: 'Outgoing' } })];
  const snapshot = structuredClone(provider.state.incidents);
  await h.poll();
  assert.deepEqual(provider.state.incidents, snapshot, 'Normalization must not mutate provider/cache records');
  const goal = h.delivered.find(event => event.type === 'goal');
  assert.deepEqual([goal.incidentId, goal.playerId, goal.assistId, goal.minute, goal.addedTime, goal.periodSecond],
    ['goal-1', 'scorer', 'assistant', 70, 2, 25]);
  assert.equal(goal.playerImage, 'https://example.com/scorer.png');
  assert.equal(goal.assistImage, 'https://example.com/assist.png');
  const substitution = h.delivered.find(event => event.type === 'substitution');
  assert.equal(substitution.playerOutId, 'outgoing');
  assert.equal(substitution.playerOut, 'Outgoing');
});

test('SportScore unknown card colours and unverified penalty labels do not fabricate typed alerts', async () => {
  const provider = sportscoreProvider();
  provider.state.incidents = [scIncident('unknown-card', 'card', { card_type: 'not_red', is_card: true }),
    scIncident('unknown-penalty', 'incident', { text: 'Penalty maybe awarded' })];
  assert.ok((await provider.detail()).timeline.every(row => incidentAlert(row) === null));
});

test('SportScore an unknown type containing red cannot fabricate a red-card alert', async () => {
  const provider = sportscoreProvider(), h = emitter(provider);
  await h.poll();
  provider.state.incidents = ['not_red', 'redacted', 'penalty_scored'].map((type, index) => scIncident('unknown-' + index, type));
  assert.ok((await provider.detail()).timeline.every(row => incidentAlert(row) === null));
  await h.poll();
  assert.equal(h.persisted.length, 0);
  assert.equal(h.delivered.length, 0);
});
