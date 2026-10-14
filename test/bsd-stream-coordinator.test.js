'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBsdStreamCoordinator } = require('../services/bsdStreamCoordinator');

const NOW = Date.parse('2026-10-14T18:40:00Z');

async function settle() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(eventId = 42, patch = {}) {
  return {
    id: `bsd_${eventId}`, rawId: eventId, source: 'bsd', provider: 'bsd',
    status: 'IN_PLAY', liveWebsocket: true, websocketPlus: true,
    utcDate: '2026-10-14T17:30:00Z', lastUpdated: '2026-10-14T18:36:00Z',
    minute: 66, second: 0, period: 'SECOND_HALF', matchPhase: 'SECOND_HALF',
    score: { fullTime: { home: 0, away: 0 } }, competition: { code: 'PL' },
    homeTeam: { id: 'bsd_t_101', rawId: 101, provider: 'bsd', name: 'Home' },
    awayTeam: { id: 'bsd_t_102', rawId: 102, provider: 'bsd', name: 'Away' },
    ...patch
  };
}

function event(eventId = 42, score = [0, 0], minute = 67, second = 0) {
  return {
    type: 'event', event_id: eventId,
    home: { id: 101, name: 'Untrusted home name' }, away: { id: 102, name: 'Untrusted away name' },
    score: { home: score[0], away: score[1] },
    time: { minute, second, period: 2, status: 'live', kickoff_at: '2026-10-14T17:30:00Z' }
  };
}

function subscribed(eventId = 42, score = [0, 0]) {
  return { type: 'subscribed', event_id: eventId, source: 'full', event: event(eventId, score), history: [] };
}

function action(eventId = 42, actionType = 'goal', score = [1, 0], ts = NOW - 1000) {
  return { type: 'action', event_id: eventId, action_type: actionType,
    team: 'home', player: { id: 401, name: 'Goal scorer' }, score: { home: score[0], away: score[1] },
    minute: 68, second: 1, period: 2, ts };
}

function meta(eventId = 42, generationId = 'run:socket:1') {
  return { eventId, generationId, source: 'full', coverage: 'full', receivedAtMs: NOW };
}

function harness(overrides = {}) {
  let current = NOW;
  const transports = [];
  const updates = [];
  const boards = [];
  const queries = [];
  const refreshes = [];
  const rooms = new Map();
  const service = createBsdStreamCoordinator({
    enabled: true, apiToken: 'private-key-never-exposed', now: () => current,
    io: { sockets: { adapter: { rooms } } },
    deviceService: { getAlertMatchIds: async (matches) => { queries.push(matches); return new Set(); } },
    emitUpdate: async (update) => updates.push(structuredClone(update)),
    onBoardUpdate: async (match) => boards.push(match),
    refreshDetails: async (id, hints) => refreshes.push({ id, hints }),
    transportFactory: (options) => {
      const transport = {
        options, subscriptions: [], history: [], stopped: false,
        start(ids) { this.history.push(['start', ids]); this.subscriptions = ids; },
        updateSubscriptions(ids) { this.history.push(['update', ids]); this.subscriptions = ids; },
        stop() { this.stopped = true; this.subscriptions = []; },
        getStatus: () => ({ connectedSockets: 1, secret: 'private-key-never-exposed', fixtureIds: [42] })
      };
      transports.push(transport);
      return transport;
    },
    ...overrides
  });
  return { service, transports, updates, boards, queries, refreshes, rooms,
    advance(milliseconds) { current += milliseconds; } };
}

test('detector refusal invalidates stream baseline until a new accepted subscription', async () => {
  let refuse = true;
  const h = harness({ emitUpdate: async () => refuse ? false : undefined });
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.service.start(); h.service.observeSnapshot([fixture()]); await settle();
  const callbacks = h.transports[0].options;
  assert.equal(await callbacks.onSnapshot(subscribed(), meta()), false);
  refuse = false;
  assert.equal(await callbacks.onFrame(action(), meta()), false, 'Failed baseline cannot license a fresh goal');
  assert.equal(await callbacks.onSnapshot(subscribed(), meta(42, 'reconnected')), true);
  assert.equal(await callbacks.onFrame(action(), meta(42, 'reconnected')), true);
  h.service.stop();
});

test('disabled coordinator does no transport, projection, audience or callback work', async () => {
  const forbid = () => assert.fail('Disabled mode must do no work');
  const service = createBsdStreamCoordinator({ enabled: false, apiToken: 'key',
    transportFactory: forbid, projectionFactory: forbid,
    deviceService: { getAlertMatchIds: forbid }, emitUpdate: forbid, refreshDetails: forbid });
  assert.equal(service.observeSnapshot([fixture()]), false);
  assert.equal(service.start().running, false);
  await settle();
  assert.equal(service.getStatus().trustedMatchCount, 0);
  service.stop();
});

test('start remains explicit and zero-subscriber start opens no fixture subscription', async () => {
  const h = harness();
  h.service.observeSnapshot([fixture()]);
  assert.equal(h.transports.length, 0);
  assert.equal(h.queries.length, 0);
  h.service.start();
  assert.deepEqual(h.transports[0].history[0], ['start', []]);
  await settle();
  assert.deepEqual(h.transports[0].subscriptions, []);
  assert.equal(h.service.getStatus().trustedMatchCount, 1);
  h.service.stop();
});

test('only verified active non-stale subscribable BSD matches reach audience queries', async () => {
  const h = harness();
  h.service.start();
  h.service.observeSnapshot([
    fixture(), fixture(43, { status: 'TIMED' }), fixture(44, { liveWebsocket: false }),
    fixture(45, { liveSnapshotStale: true }), fixture(46, { provider: 'sportscore' }),
    fixture(47, { homeTeam: { id: 'ko_t_101' } }), fixture(48, { rawId: 49 }),
    fixture(50, { utcDate: '2026-10-14 17:30:00' }), fixture(51, { canonicalMatchId: 'other-match' })
  ]);
  await settle();
  assert.equal(h.queries.length, 1);
  assert.deepEqual(h.queries[0].map((match) => match.id), ['bsd_42']);
  assert.equal(h.service.getStatus().trustedMatchCount, 1);
  assert.equal(h.service.getStatus().rejectedMatches, 8);
  h.service.stop();
});

test('unavailable/stale snapshot envelopes cannot clear trusted state or trigger audience work', async () => {
  const h = harness();
  h.service.start();
  h.service.observeSnapshot({ success: true, source: 'bsd', data: [fixture()] });
  await settle();
  for (const snapshot of [{ success: false, data: [] }, { success: true, source: 'unavailable', data: [] },
    { success: true, stale: true, data: [] }, { success: true, coverage: { available: false }, data: [] }]) {
    assert.equal(h.service.observeSnapshot(snapshot), false);
  }
  await settle();
  assert.equal(h.service.getStatus().trustedMatchCount, 1);
  assert.equal(h.queries.length, 1);
  h.service.stop();
});

test('audience discovery is asynchronous and coalesces changing snapshots behind one pending query', async () => {
  const first = deferred();
  const second = deferred();
  const reads = [];
  const h = harness({ deviceService: { getAlertMatchIds: (rows) => { reads.push(rows); return reads.length === 1 ? first.promise : second.promise; } } });
  h.service.start();
  assert.equal(h.service.observeSnapshot([fixture()]), true);
  assert.equal(reads.length, 0, 'Observe must not synchronously invoke Firestore audience reads');
  await settle();
  assert.equal(reads.length, 1);
  for (let index = 0; index < 50; index += 1) h.service.observeSnapshot([fixture(43)]);
  await settle();
  assert.equal(reads.length, 1);
  first.resolve(new Set(['bsd_42']));
  await settle();
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1].map((row) => row.id), ['bsd_43']);
  assert.deepEqual(h.transports[0].subscriptions, []);
  second.resolve(new Set(['bsd_43']));
  await settle();
  assert.deepEqual(h.transports[0].subscriptions, [43]);
  h.service.stop();
});

test('device audiences and explicit alert rooms qualify; view rooms and forged aliases do not', async () => {
  const h = harness({ deviceService: { getAlertMatchIds: async () => new Set(['bsd_44', 'fake-alias']) } });
  h.rooms.set('match:bsd_42', new Set(['viewer']));
  h.rooms.set('matchAlerts_bsd_43', new Set(['subscriber']));
  h.rooms.set('matchAlerts_fake-alias', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture(), fixture(43), fixture(44), fixture(45, {
    providerIdentities: [{ id: 'fake-alias', provider: 'sportscore' }]
  })]);
  await settle();
  assert.deepEqual(h.transports[0].subscriptions, [43, 44]);
  h.service.stop();
});

test('fully verified alias match alert rooms qualify the existing BSD identity without duplicating it', async () => {
  const match = fixture();
  match.providerIdentities = [
    { id: 'bsd_42', provider: 'bsd', homeTeamId: 'bsd_t_101', awayTeamId: 'bsd_t_102', utcDate: match.utcDate, competitionCode: 'PL' },
    { id: 'verified-home-v-away', provider: 'sportscore', homeTeamId: 'sc_t_home', awayTeamId: 'sc_t_away', utcDate: match.utcDate, competitionCode: 'PL' }
  ];
  const h = harness();
  h.rooms.set('matchAlerts_verified-home-v-away', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([match]);
  await settle();
  assert.deepEqual(h.transports[0].subscriptions, [42]);
  h.service.stop();
});

test('selection stays stable under new lower IDs and respects socket capacity; overflow remains with REST', async () => {
  const h = harness({ maxSockets: 1, deviceService: { getAlertMatchIds: async (rows) => new Set(rows.map((row) => row.id)) } });
  const original = Array.from({ length: 12 }, (_, index) => fixture(index + 10));
  h.service.start();
  h.service.observeSnapshot(original);
  await settle();
  assert.deepEqual(h.transports[0].subscriptions, Array.from({ length: 10 }, (_, index) => index + 10));
  h.service.observeSnapshot([fixture(1), ...original]);
  await settle();
  assert.deepEqual(h.transports[0].subscriptions, Array.from({ length: 10 }, (_, index) => index + 10));
  assert.equal(h.service.getStatus().overflowCount, 3);
  assert.equal(h.service.getStatus().trustedMatchCount, 13);
  h.service.observeSnapshot(original.filter((row) => row.id !== 'bsd_10'));
  await settle();
  assert.equal(h.transports[0].subscriptions.length, 10);
  assert.ok(!h.transports[0].subscriptions.includes(10));
  h.service.stop();
});

test('accepted subscribed state is a silent baseline; following settled goal projects one canonical update', async () => {
  const h = harness();
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  const transport = h.transports[0];
  assert.equal(await transport.options.onSnapshot(subscribed(), meta()), true);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].baseline, true);
  assert.equal(h.updates[0].incident, undefined);
  assert.equal(h.updates[0].match.homeTeam.name, 'Home');
  assert.equal(await transport.options.onFrame(action(), meta()), true);
  assert.equal(h.updates.length, 2);
  assert.equal(h.updates[1].baseline, false);
  assert.equal(h.updates[1].match.score.fullTime.home, 1);
  assert.equal(h.updates[1].incident.playerId, 'bsd_p_401');
  assert.equal(h.updates[1].generationId, meta().generationId);
  await settle();
  assert.equal(h.boards.length, 2);
  h.service.stop();
});

test('provisional goal is internal only and later event score does not emit a fake goal', async () => {
  const h = harness();
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  const transport = h.transports[0];
  await transport.options.onSnapshot(subscribed(), meta());
  assert.equal(await transport.options.onFrame(action(42, 'temp_goal'), { ...meta(), provisional: true }), false);
  assert.equal(h.updates.length, 1);
  await transport.options.onFrame(event(42, [1, 0], 68, 2), meta());
  assert.equal(h.updates.at(-1).match.score.fullTime.home, 0);
  assert.equal(h.updates.at(-1).incident, undefined);
  await transport.options.onFrame(action(42, 'deleted_event', [0, 0], NOW), meta());
  assert.equal(h.updates.at(-1).match.score.fullTime.home, 0);
  assert.ok(h.updates.every((update) => !update.incident));
  h.service.stop();
});

test('per-fixture projector generations isolate reconnect baselines and fence stale connection frames', async () => {
  const h = harness();
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.rooms.set('matchAlerts_bsd_43', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture(), fixture(43)]);
  const callbacks = h.transports[0].options;
  await callbacks.onSnapshot(subscribed(42), meta(42, 'socketA:1'));
  await callbacks.onSnapshot(subscribed(43), meta(43, 'socketB:1'));
  await callbacks.onSnapshot(subscribed(42), meta(42, 'socketA:2'));
  assert.equal(await callbacks.onFrame(action(42), meta(42, 'socketA:1')), false);
  assert.equal(await callbacks.onFrame(action(43), meta(43, 'socketB:1')), true);
  assert.equal(h.updates.at(-1).match.id, 'bsd_43');
  h.service.stop();
});

test('a fresh subscription lease requires another baseline even on the same connection generation', async () => {
  const h = harness();
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  const callbacks = h.transports[0].options;
  const first = { ...meta(), subscriptionGeneration: 1 };
  const second = { ...meta(), subscriptionGeneration: 2 };
  await callbacks.onSnapshot(subscribed(), first);
  assert.equal(await callbacks.onFrame(action(), second), false);
  await callbacks.onSnapshot(subscribed(), second);
  assert.equal(await callbacks.onFrame(action(), first), false);
  assert.equal(await callbacks.onFrame(action(), second), true);
  h.service.stop();
});

test('rejected identity baseline returns false, emits nothing and cannot unlock live events', async () => {
  const h = harness();
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  const callbacks = h.transports[0].options;
  const bad = subscribed();
  bad.event.home.id = 999;
  assert.equal(await callbacks.onSnapshot(bad, meta()), false);
  assert.equal(await callbacks.onFrame(action(), meta()), false);
  assert.equal(h.updates.length, 0);
  assert.equal(h.service.getStatus().rejectedBaselines, 1);
  h.service.stop();
});

test('refresh hints are asynchronous, coalesced, concurrency capped and limited to trusted selected IDs', async () => {
  const gate = deferred();
  const requests = [];
  const h = harness({ refreshDetails: async (id, hints) => { requests.push({ id, hints }); await gate.promise; } });
  for (const id of [42, 43, 44]) h.rooms.set(`matchAlerts_bsd_${id}`, new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture(), fixture(43), fixture(44)]);
  const callbacks = h.transports[0].options;
  for (const id of [42, 43, 44]) await callbacks.onSnapshot(subscribed(id), meta(id));
  for (const id of [42, 43, 44]) await callbacks.onFrame(action(id, 'player_on'), meta(id));
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(h.service.getStatus().activeRefreshCount, 2);
  for (let index = 0; index < 50; index += 1) await callbacks.onFrame(action(42, 'formation_change', [1, 0], NOW), meta(42));
  await settle();
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => /^bsd_(42|43|44)$/.test(request.id)));
  assert.ok(requests.every((request) => request.hints.includes('lineups')));
  gate.resolve();
  await settle();
  assert.equal(requests.length, 3);
  assert.equal(h.service.getStatus().activeRefreshCount, 0);
  h.service.stop();
});

test('refresh cooldown retains newer lineup hints until its bounded timer rather than losing them', async () => {
  const timers = [];
  const h = harness({
    setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cancelled = true; }
  });
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  const callbacks = h.transports[0].options;
  await callbacks.onSnapshot(subscribed(), meta());
  await callbacks.onFrame(action(42, 'card'), meta());
  await settle();
  assert.deepEqual(h.refreshes[0], { id: 'bsd_42', hints: ['timeline'] });
  await callbacks.onFrame(action(42, 'formation_change', [1, 0], NOW), meta());
  await settle();
  assert.equal(h.refreshes.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1000);
  h.advance(1000);
  timers[0].callback();
  await settle();
  assert.deepEqual(h.refreshes[1], { id: 'bsd_42', hints: ['lineups'] });
  h.service.stop();
});

test('stop fences late transport and audience callbacks even across a subsequent start', async () => {
  const gate = deferred();
  const h = harness({ deviceService: { getAlertMatchIds: () => gate.promise } });
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  const oldCallbacks = h.transports[0].options;
  await settle();
  h.service.stop();
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  assert.equal(await oldCallbacks.onSnapshot(subscribed(), meta()), false);
  assert.equal(await oldCallbacks.onFrame(action(), meta()), false);
  assert.equal(h.updates.length, 0);
  gate.resolve(new Set(['bsd_42']));
  await settle();
  assert.equal(h.service.getStatus().audienceInFlight, false);
  assert.ok(h.transports[0].stopped);
  h.service.stop();
});

test('status contains only safe counts and a whitelisted block reason', async () => {
  const h = harness();
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  await settle();
  const status = JSON.stringify(h.service.getStatus());
  assert.doesNotMatch(status, /private-key|fixtureIds|bsd_42|subscriber|Goal scorer/);
  assert.equal(h.service.getStatus().transport.connectedSockets, 1);
  h.transports[0].getStatus = () => ({ blocked: true, blockedReason: 'account-user-secret', connectedSockets: -1 });
  assert.equal(h.service.getStatus().blockedReason, null);
  assert.equal(h.service.getStatus().transport.connectedSockets, 0);
  h.service.stop();
});

test('audience/emit/refresh failures remain sanitized and do not poison later accepted frames', async () => {
  let failEmit = true;
  const h = harness({
    deviceService: { getAlertMatchIds: async () => { throw new Error('private-key'); } },
    emitUpdate: async () => { if (failEmit) throw new Error('private-key'); },
    refreshDetails: async () => { throw new Error('private-key'); }
  });
  h.rooms.set('matchAlerts_bsd_42', new Set(['subscriber']));
  h.service.start();
  h.service.observeSnapshot([fixture()]);
  await settle();
  const callbacks = h.transports[0].options;
  assert.equal(await callbacks.onSnapshot(subscribed(), meta()), false);
  assert.equal(await callbacks.onFrame(action(), meta()), false);
  failEmit = false;
  assert.equal(await callbacks.onSnapshot(subscribed(), meta(42, 'new-generation')), true);
  assert.equal(await callbacks.onFrame(action(42, 'player_on'), meta(42, 'new-generation')), true);
  await settle();
  assert.equal(h.service.getStatus().audienceErrors, 1);
  assert.equal(h.service.getStatus().refreshErrors, 1);
  assert.doesNotMatch(JSON.stringify(h.service.getStatus()), /private-key/);
  h.service.stop();
});
