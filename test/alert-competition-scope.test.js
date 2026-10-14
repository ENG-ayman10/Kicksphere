'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createBsdStreamCoordinator } = require('../services/bsdStreamCoordinator');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const MAJOR = { code: 'PL', name: 'Premier League', country: 'England' };
const ARAB = { name: 'Saudi Pro League', country: 'Saudi Arabia' };
const INTERNATIONAL = { code: 'WC', name: 'FIFA World Cup', country: 'World' };
const EXCLUDED = { name: 'Premier League', country: 'Israel' };
const MINOR = { name: 'I-League', country: 'India' };

function scope(t, value) {
  const previous = process.env.SPORTS_COMPETITION_SCOPE;
  process.env.SPORTS_COMPETITION_SCOPE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SPORTS_COMPETITION_SCOPE;
    else process.env.SPORTS_COMPETITION_SCOPE = previous;
  });
}

function fixture(id, competition = MAJOR, home = 0, patch = {}) {
  return { id: `bsd_${id}`, provider: 'bsd', source: 'bsd', status: 'IN_PLAY', liveWebsocket: true,
    minute: 40, utcDate: '2026-10-14T11:20:00Z', lastUpdated: null,
    homeTeam: { id: `bsd_t_${id * 2}`, name: `Home ${id}` },
    awayTeam: { id: `bsd_t_${id * 2 + 1}`, name: `Away ${id}` },
    score: { fullTime: { home, away: 0 } }, competition, ...patch };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve));
}

function emitterHarness({ readDetail = async () => null, nonBlockingDetails = false, calendar = [], persistRead } = {}) {
  const requests = [], persisted = [], delivered = [], queries = [];
  const db = { collection: () => ({ doc: () => ({}), where() { return {
    orderBy() { return this; }, limit() { return this; }, get: async () => ({ docs: [] }),
  }; } }), batch: () => ({ set: (_, data) => persisted.push(data), commit: async () => persistRead?.() }) };
  const devices = { getAlertMatchIds: async matches => {
    queries.push(matches.map(match => structuredClone(match)));
    return new Set(matches.map(match => match.id));
  }, flushRetries: async () => ({}), findRecipients: async events => new Map([['offline-device', {
    userId: 'offline-user', events: new Map(events.map(event => [event.eventId, event])),
  }]]), deliver: async (_, event) => delivered.push(event) };
  const mocks = { '../config/firebase': db, '../utils/logger': { warn() {}, info() {}, error() {} },
    './bsdSportsService': { isConfigured: () => false }, './sportscoreService': {}, './sportsDataService': {}, './kickoffApiService': {},
    './notificationService': { saveNotification: async () => ({}) },
    './pushNotificationService': { sendPushNotification: async () => assert.fail('Offline scope tests must not send FCM') },
    './notificationDeviceService': devices,
  };
  const file = require.resolve('../services/liveEventsService');
  delete require.cache[file];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let service;
  try { service = require(file); } finally { Module._load = original; }
  const io = { sockets: { adapter: { rooms: new Map() } }, to: () => ({ except() { return this; }, emit() {} }) };
  const emit = service.createLiveEventsEmitter({ provider: { getMatchesByDate: async () => calendar },
    notificationDevices: devices, now: () => NOW, recipientAllowed: () => true, nonBlockingDetails,
    getMatchDetails: async (id, options) => { requests.push({ id, options }); return readDetail(id, options); } });
  return { requests, persisted, delivered, queries,
    poll: (rows, options = {}) => emit(io, { liveSnapshot: rows, ...options }),
    stream: (match, baseline = false) => emit(io, { streamOnly: true, includeDetails: false,
      streamUpdates: new Map([[match.id, { match, baseline, receivedAt: NOW, generationId: 'offline:1' }]]) }) };
}

test('focused alerts discover followers and read optional details only for major, Arab and international fixtures', async t => {
  scope(t, 'focused');
  const rows = [fixture(1), fixture(2, ARAB), fixture(3, INTERNATIONAL), fixture(4, EXCLUDED), fixture(5, MINOR), fixture(6, null)];
  const h = emitterHarness();
  await h.poll(rows); await settle();
  assert.deepEqual(h.requests.map(request => request.id), ['bsd_1', 'bsd_2', 'bsd_3']);
  assert.deepEqual(h.queries[0].map(match => match.id), ['bsd_1', 'bsd_2', 'bsd_3']);
  await h.poll(rows.map(match => ({ ...match, score: { fullTime: { home: 1, away: 0 } } })));
  assert.deepEqual(h.persisted.map(event => event.matchId), ['bsd_1', 'bsd_2', 'bsd_3']);
  assert.deepEqual(h.persisted.map(event => event.competition), [MAJOR, ARAB, INTERNATIONAL]);
  assert.deepEqual(h.delivered.map(event => event.matchId), ['bsd_1', 'bsd_2', 'bsd_3']);
  assert.ok(h.queries.flat().every(match => ['bsd_1', 'bsd_2', 'bsd_3'].includes(match.id)));
});

test('all mode preserves previous unknown and minor fixture alert behavior', async t => {
  scope(t, 'all');
  const rows = [fixture(4, EXCLUDED), fixture(5, MINOR), fixture(6, null)];
  const h = emitterHarness();
  await h.poll(rows); await settle();
  assert.deepEqual(h.requests.map(request => request.id), ['bsd_4', 'bsd_5', 'bsd_6']);
  await h.poll(rows.map(match => ({ ...match, score: { fullTime: { home: 1, away: 0 } } })));
  assert.deepEqual(h.persisted.map(event => event.matchId), ['bsd_4', 'bsd_5', 'bsd_6']);
});

test('excluded metadata purges a cached active fixture silently and prevents disappearance detail reads', async t => {
  scope(t, 'focused');
  const h = emitterHarness();
  await h.poll([fixture(1)]); await settle();
  assert.equal(h.requests.length, 1);
  await h.poll([fixture(1, EXCLUDED, 1)]);
  await h.poll([]); await settle();
  assert.equal(h.requests.length, 1, 'Excluded disappearance must not spend an optional-detail request');
  assert.equal(h.persisted.length, 0, 'Exclusion must not invent an end or score correction');
  assert.ok(h.queries.slice(1).every(rows => rows.length === 0));
});

test('a late allowed detail cannot resurrect a fixture excluded while its request was in flight', async t => {
  scope(t, 'focused');
  const pending = deferred();
  const h = emitterHarness({ nonBlockingDetails: true, readDetail: async () => pending.promise });
  try {
    await h.poll([fixture(1)]); await settle();
    assert.equal(h.requests.length, 1);
    await h.poll([fixture(1, EXCLUDED)]); await settle();
    pending.resolve({ ...fixture(1, MAJOR, 1), timeline: [{ id: 'late-card', type: 'red_card', side: 'home', minute: 40 }] });
    await settle();
    await h.poll([]); await settle();
    assert.equal(h.requests.length, 1);
    assert.equal(h.persisted.length, 0);
    assert.equal(h.delivered.length, 0);
  } finally { pending.resolve(null); await settle(); }
});

test('scoped stream deltas reject excluded baselines and purge a prior eligible fixture without alerts', async t => {
  scope(t, 'focused');
  const h = emitterHarness();
  assert.equal(await h.stream(fixture(4, EXCLUDED), true), false);
  await h.stream(fixture(1), true);
  assert.equal(await h.stream(fixture(1, EXCLUDED, 1)), false);
  assert.equal(await h.stream(fixture(1, MAJOR, 2)), false, 'Purged fixture needs a verified silent baseline again');
  await h.stream(fixture(1, MAJOR, 2), true);
  await h.stream(fixture(1, MAJOR, 3));
  assert.deepEqual(h.persisted.map(event => [event.type, event.matchId, event.score]), [['goal', 'bsd_1', '3 - 0']]);
  assert.equal(h.requests.length, 0);
});

test('an already-completed detail queued behind persistence cannot reinsert a fixture excluded by the queued source snapshot', async t => {
  scope(t, 'focused');
  const pending = deferred(), persistence = deferred(), entered = deferred();
  const h = emitterHarness({ nonBlockingDetails: true, readDetail: async () => pending.promise,
    persistRead: async () => { entered.resolve(); await persistence.promise; } });
  try {
    await h.poll([fixture(1)]); await settle();
    const running = h.poll([fixture(1, MAJOR, 1)], { includeDetails: false });
    await entered.promise;
    pending.resolve(fixture(1, MAJOR, 2)); await settle();
    await h.poll([fixture(1, EXCLUDED, 2)], { includeDetails: false });
    persistence.resolve(); await running; await settle();
    await h.poll([]); await settle();
    assert.equal(h.requests.length, 1, 'Queued stale detail must not recreate an active disappearance candidate');
    assert.equal(await h.stream(fixture(1, MAJOR, 3)), false, 'Excluded baseline must remain purged');
    assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0']);
  } finally { pending.resolve(null); persistence.resolve(); await settle(); }
});

test('excluded upcoming calendar fixtures cannot send reminders or spend lineup detail reads', async t => {
  scope(t, 'focused');
  const upcoming = fixture(4, EXCLUDED, 0, { status: 'TIMED', minute: null, utcDate: '2026-10-14T12:15:00Z' });
  const h = emitterHarness({ calendar: [upcoming] });
  await h.poll([]); await settle();
  await h.poll([]); await settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.persisted.length, 0);
  assert.ok(h.queries.every(rows => rows.length === 0));
});

function coordinatorHarness({ query } = {}) {
  const subscriptions = [], queries = [], updates = [];
  let callbacks;
  const service = createBsdStreamCoordinator({ enabled: true, apiToken: 'offline-key', now: () => NOW,
    io: { sockets: { adapter: { rooms: new Map([['matchAlerts_bsd_4', new Set(['offline-socket'])]]) } } },
    deviceService: { getAlertMatchIds: async matches => {
      queries.push(matches.map(match => structuredClone(match)));
      return query ? query(matches) : new Set(matches.map(match => match.id));
    } }, emitUpdate: async update => updates.push(update),
    transportFactory: options => { callbacks = options; return {
      start(ids) { subscriptions.push(ids); }, updateSubscriptions(ids) { subscriptions.push(ids); }, stop() {}, getStatus: () => ({}),
    }; } });
  return { service, subscriptions, queries, updates, callbacks: () => callbacks };
}

test('coordinator filters before audience discovery and stream subscriptions despite excluded alert rooms', async t => {
  scope(t, 'focused');
  const h = coordinatorHarness();
  try {
    h.service.start();
    h.service.observeSnapshot([fixture(1), fixture(2, ARAB), fixture(3, INTERNATIONAL), fixture(4, EXCLUDED), fixture(5, MINOR)]);
    await settle();
    assert.deepEqual(h.queries[0].map(match => match.id), ['bsd_1', 'bsd_2', 'bsd_3']);
    assert.deepEqual(h.subscriptions.at(-1), [1, 2, 3]);
    assert.equal(h.service.getStatus().trustedMatchCount, 3);
    assert.equal(await h.callbacks().onSnapshot({ type: 'subscribed', event_id: 4 },
      { eventId: 4, generationId: 'offline:1', receivedAtMs: NOW }), false);
    assert.equal(h.updates.length, 0);
  } finally { h.service.stop(); }
});

test('switching to focused scope during audience lookup removes excluded stream state before a late audience result', async t => {
  scope(t, 'all');
  const pending = deferred();
  const h = coordinatorHarness({ query: async () => pending.promise });
  try {
    h.service.start(); h.service.observeSnapshot([fixture(4, EXCLUDED)]); await settle();
    assert.deepEqual(h.subscriptions.at(-1), [4], 'All mode retains the existing explicit alert room');
    process.env.SPORTS_COMPETITION_SCOPE = 'focused';
    pending.resolve(new Set(['bsd_4'])); await settle();
    assert.deepEqual(h.subscriptions.at(-1), []);
    assert.equal(h.service.getStatus().trustedMatchCount, 0);
    assert.equal(await h.callbacks().onFrame({ type: 'action', event_id: 4 },
      { eventId: 4, generationId: 'offline:1', receivedAtMs: NOW }), false);
    assert.equal(h.updates.length, 0);
  } finally { pending.resolve(new Set()); h.service.stop(); await settle(); }
});
