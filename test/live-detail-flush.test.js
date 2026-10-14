'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const initialTime = Date.parse('2026-10-14T12:00:00Z');
const fixture = (id, options = {}) => ({ id: `bsd_${id}`, provider: 'bsd', source: 'bsd', status: 'IN_PLAY',
  minute: 40, utcDate: '2026-10-14T11:20:00Z', lastUpdated: '2026-10-14T12:00:00Z',
  homeTeam: { id: `bsd_t_${id * 2}`, name: `Home ${id}` },
  awayTeam: { id: `bsd_t_${id * 2 + 1}`, name: `Away ${id}` },
  score: { fullTime: { home: 0, away: 0 } }, ...options });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}
function harness(readDetail) {
  const requests = [], persisted = [], delivered = [], logs = [];
  const database = { collection: () => ({ doc: () => ({}), where() { return {
    orderBy() { return this; }, limit() { return this; }, get: async () => ({ docs: [] }),
  }; } }), batch: () => ({ set: (_, data) => persisted.push(data), commit: async () => {} }) };
  const mocks = { '../config/firebase': database,
    '../utils/logger': { warn: message => logs.push(message), info() {}, error: message => logs.push(message) },
    './bsdSportsService': { isConfigured: () => false }, './sportscoreService': {}, './sportsDataService': {}, './kickoffApiService': {},
    './notificationService': { saveNotification: async () => ({}) },
    './pushNotificationService': { sendPushNotification: async () => assert.fail('No live push is allowed') },
    './notificationDeviceService': { getAlertMatchIds: async matches => new Set(matches.map(match => match.id)),
      flushRetries: async () => ({}), findRecipients: async events => new Map([['offline-device', {
        userId: 'offline-user', events: new Map(events.map(event => [event.eventId, event])),
      }]]), deliver: async (_, event) => delivered.push(event) },
  };
  const file = require.resolve('../services/liveEventsService');
  delete require.cache[file];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let service;
  try { service = require(file); } finally { Module._load = original; }
  const io = { sockets: { adapter: { rooms: new Map() } }, to: () => ({
    except() { return this; }, emit() {},
  }) };
  const emit = service.createLiveEventsEmitter({ provider: { getMatchesByDate: async () => [] },
    now: () => initialTime, recipientAllowed: () => true, nonBlockingDetails: true, asynchronousDelivery: true,
    getMatchDetails: async (id, options) => { requests.push({ id, options }); return readDetail(id, options); } });
  return { requests, persisted, delivered, logs,
    poll: rows => emit(io, { liveSnapshot: rows }) };
}

test('a fast fresh incident is delivered while another detail is unresolved, preserving six reads and three concurrent requests', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => fixture(i + 1));
  const slow = [deferred(), deferred()];
  let phase = 'baseline'; let active = 0; let peak = 0;
  const h = harness(async id => {
    active++; peak = Math.max(peak, active);
    try {
      const match = rows.find(row => row.id === id);
      if (phase === 'baseline') return { ...match, timeline: [] };
      if (id === 'bsd_2') return await slow[0].promise;
      if (id === 'bsd_3') return await slow[1].promise;
      return { ...match, timeline: id === 'bsd_1' ? [{ id: 'fresh-red', type: 'red_card',
        minute: 40, side: 'home', player: 'Player' }] : [] };
    } finally { active--; }
  });
  try {
    await h.poll(rows); await settle();
    assert.equal(h.requests.length, 6);
    phase = 'fresh'; h.requests.length = 0;
    await h.poll(rows); await settle();
    assert.equal(active, 2, 'Both unrelated requests remain unresolved');
    assert.equal(h.requests.length, 6);
    assert.equal(peak, 3);
    assert.deepEqual(h.delivered.map(event => event.incidentId), ['fresh-red']);
    assert.deepEqual(h.persisted.map(event => event.type), ['card']);
    assert.equal(h.delivered[0].matchId, 'bsd_1');
    await h.poll(rows); await settle();
    assert.equal(h.requests.length, 6, 'An unresolved batch cannot launch overlapping provider reads');
    assert.equal(h.delivered.length, 1);
  } finally {
    for (const request of slow) request.resolve(null);
    await settle();
  }
});

test('minute-40 subscribed details retain incident reads without repeatedly fetching irrelevant lineups', async () => {
  const match = fixture(1);
  const h = harness(async () => ({ ...match, timeline: [] }));
  await h.poll([match]); await settle();
  await h.poll([match]); await settle();
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => request.options.includeTimeline === true));
  assert.ok(h.requests.every(request => request.options.includeLineups === false));
  assert.equal(h.delivered.length, 0);
});

test('upcoming official lineups still publish once and subsequent details stop fetching the confirmed XI', async () => {
  const match = fixture(1, { status: 'TIMED', minute: null, utcDate: '2026-10-14T12:30:00Z' });
  let confirmed = false;
  const h = harness(async (_, options) => ({ ...match, timeline: [], ...(options.includeLineups ? { lineups: {
    confirmed, predicted: !confirmed, lineupStatus: confirmed ? 'confirmed' : 'predicted', matchId: match.id,
    homeTeamId: match.homeTeam.id, awayTeamId: match.awayTeam.id,
    home: Array.from({ length: 11 }, (_, i) => ({ id: `bsd_p_${i + 1}` })),
    away: Array.from({ length: 11 }, (_, i) => ({ id: `bsd_p_${i + 12}` })),
  } } : {}) }));
  await h.poll([match]); await settle();
  assert.equal(h.delivered.length, 0);
  confirmed = true;
  await h.poll([match]); await settle();
  await h.poll([match]); await settle();
  assert.deepEqual(h.requests.map(request => request.options.includeLineups), [true, true, false]);
  assert.deepEqual(h.delivered.map(event => event.type), ['lineup']);
  assert.equal(h.delivered[0].lineupConfirmed, true);
});

test('detail failures log only the public match identity without provider request metadata', async () => {
  const h = harness(async () => { throw new Error('authorization=offline_sensitive_placeholder'); });
  await h.poll([fixture(1)]); await settle();
  assert.ok(h.logs.some(message => message.includes('bsd_1')));
  assert.ok(h.logs.every(message => !message.includes('offline_sensitive_placeholder')));
  assert.equal(h.delivered.length, 0);
});
