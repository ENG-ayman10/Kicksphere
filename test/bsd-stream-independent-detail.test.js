'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const NOW = Date.parse('2026-10-14T18:40:00Z');
const iso = offset => new Date(NOW + offset).toISOString();

function fixture(home = 0) {
  return { id: 'bsd_42', source: 'bsd', provider: 'bsd', status: 'IN_PLAY',
    utcDate: '2026-10-14T17:30:00Z', minute: 68, period: 'SECOND_HALF', matchPhase: 'SECOND_HALF',
    homeTeam: { id: 'bsd_t_101', name: 'Offline home' },
    awayTeam: { id: 'bsd_t_102', name: 'Offline away' },
    score: { fullTime: { home, away: 0 } }, lastUpdated: iso(-1000) };
}

function harness() {
  const persisted = [], delivered = [], errors = [];
  const database = {
    collection: () => ({ doc: () => ({}), where() { return {
      orderBy() { return this; }, limit() { return this; }, async get() { return { docs: [] }; }
    }; } }),
    batch: () => ({ set: (_, event) => persisted.push(event), async commit() {} })
  };
  const devices = {
    async flushRetries() {},
    async findRecipients(events) { return new Map([['offline-installation', {
      userId: 'offline-user', events: new Map(events.map(event => [event.eventId, event]))
    }]]); },
    async deliver(_, event) { delivered.push(event); }
  };
  const forbid = () => assert.fail('This regression test must not make provider or push requests');
  const mocks = {
    '../config/firebase': database,
    '../utils/logger': { info() {}, warn() {}, error: value => errors.push(value) },
    './bsdSportsService': { isConfigured: () => false },
    './sportscoreService': {}, './sportsDataService': {}, './kickoffApiService': {},
    './notificationDeviceService': devices,
    './notificationService': { async saveNotification() { return {}; } },
    './pushNotificationService': { sendPushNotification: forbid }
  };
  const path = require.resolve('../services/liveEventsService');
  delete require.cache[path];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let service;
  try { service = require(path); } finally { Module._load = original; }
  const io = { sockets: { adapter: { rooms: new Map() } }, to: () => ({
    except() { return this; }, emit() {}
  }) };
  const emit = service.createLiveEventsEmitter({ now: () => NOW,
    notificationDevices: devices, recipientAllowed: () => true, getMatchDetails: forbid,
    provider: { async getMatchesByDate() { return []; }, getLiveMatches: forbid } });
  return { persisted, delivered, errors,
    restBaseline: () => emit(io, { liveSnapshot: [fixture()], includeDetails: false,
      completedDetails: new Map([['bsd_42', { ...fixture(), timeline: [] }]]) }),
    stream: (match, baseline = false) => emit(io, { streamOnly: true, includeDetails: false,
      streamUpdates: new Map([[match.id, { match, baseline, receivedAt: NOW }]]) }),
    detail: detail => emit(io, { detailsOnly: true, includeDetails: false,
      completedDetails: new Map([['bsd_42', detail]]) }) };
}

const freshRedCard = () => ({ id: 'offline-red-card', type: 'red_card', side: 'home',
  minute: 68, player: 'Offline player', playerId: 'bsd_p_401', isLive: true });

async function streamedGoal(h) {
  await h.restBaseline();
  await h.stream(fixture(), true);
  await h.stream({ ...fixture(1), lastUpdated: iso(-500) });
  assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
}

test('a fresh red-card timeline survives a lagging summary score without cancelling the streamed goal', async () => {
  const h = harness();
  await streamedGoal(h);
  await h.detail({ ...fixture(0), lastUpdated: iso(0), timeline: [freshRedCard()] });
  assert.deepEqual(h.persisted.map(event => event.type), ['goal', 'card']);
  assert.deepEqual(h.delivered.map(event => event.type), ['goal', 'card']);
  assert.equal(h.persisted[1].incidentId, 'offline-red-card');
  assert.equal(h.persisted[1].cardType, 'red');
  assert.equal(h.persisted[1].score, '1 - 0', 'Independent timeline cannot replace the stream scoreboard');
  await h.detail({ ...fixture(0), lastUpdated: iso(0), timeline: [freshRedCard()] });
  assert.equal(h.persisted.length, 2, 'Repeating the detail must not repeat the card');
  assert.deepEqual(h.errors, []);
});

test('a timeline-only detail with missing scoreboard fields still delivers its independently verified incident', async () => {
  const h = harness();
  await streamedGoal(h);
  await h.detail({ id: 'bsd_42', lastUpdated: iso(0), timeline: [freshRedCard()] });
  assert.deepEqual(h.persisted.map(event => event.type), ['goal', 'card']);
  assert.equal(h.persisted[1].playerId, 'bsd_p_401');
  assert.equal(h.persisted[1].score, '1 - 0');
  assert.deepEqual(h.errors, []);
});

test('an older source timestamp cannot introduce incidents during the stream lease or poison their later fresh version', async () => {
  const h = harness();
  await streamedGoal(h);
  await h.detail({ ...fixture(0), lastUpdated: iso(-750), timeline: [freshRedCard()] });
  assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
  await h.detail({ ...fixture(0), lastUpdated: iso(0), timeline: [freshRedCard()] });
  assert.deepEqual(h.persisted.map(event => event.type), ['goal', 'card']);
  assert.equal(h.delivered[1].incidentId, 'offline-red-card');
  assert.deepEqual(h.errors, []);
});
