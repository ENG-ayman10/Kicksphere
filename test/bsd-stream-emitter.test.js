'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createBsdStreamProjection } = require('../utils/bsdStreamProjection');

const START = Date.parse('2026-10-14T18:40:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));
function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}
function match(id = 101, home = 0, overrides = {}) {
  return { id: `bsd_${id}`, provider: 'bsd', source: 'bsd', utcDate: '2026-10-14T17:30:00Z',
    status: 'IN_PLAY', matchPhase: 'SECOND_HALF', period: 'SECOND_HALF', minute: 67, second: 0,
    homeTeam: { id: `bsd_t_${id * 2}`, name: `Home ${id}` },
    awayTeam: { id: `bsd_t_${id * 2 + 1}`, name: `Away ${id}` },
    score: { fullTime: { home, away: 0 }, halfTime: { home: 0, away: 0 } },
    competition: { id: 'ARG', code: 'ARG', name: 'Offline league' }, lastUpdated: null, ...overrides };
}
function harness({ persistRead, readDetail } = {}) {
  let now = START;
  const state = { persisted: [], delivered: [], emitted: [], saved: [], fixtureReads: 0,
    liveReads: 0, detailReads: 0, warnings: [] };
  const provider = { async getMatchesByDate() { state.fixtureReads++; return []; },
    async getLiveMatches() { state.liveReads++; return []; } };
  const db = { batch: () => ({ set: (_, event) => state.persisted.push(event),
    commit: async () => { if (persistRead) await persistRead(); } }),
    collection: name => ({ doc: id => ({ id }), where() {
      assert.equal(name, 'users');
      return { orderBy() { return this; }, limit() { return this; }, async get() { return { docs: [] }; } };
    } }) };
  const devices = { async flushRetries() {}, async getSubscribedMatchIds() { return new Set(); },
    async findRecipients(events) { return new Map([['offline-installation', { userId: 'offline-user',
      events: new Map(events.map(event => [event.eventId, event])) }]]); },
    async deliver(_, event) { state.delivered.push(event); } };
  const service = load('../services/liveEventsService', {
    '../config/firebase': db,
    '../utils/logger': { info() {}, warn: value => state.warnings.push(value), error: value => state.warnings.push(value) },
    './sportscoreService': provider, './sportsDataService': provider,
    './bsdSportsService': { isConfigured: () => false }, './kickoffApiService': {},
    './notificationDeviceService': devices,
    './notificationService': { async saveNotification(userId, event) { state.saved.push({ userId, event }); } },
    './pushNotificationService': { async sendPushNotification() { assert.fail('Real push forbidden in offline test'); } }
  });
  const io = { sockets: { adapter: { rooms: new Map() } }, to(rooms) {
    return { except() { return this; }, emit(type, data) { state.emitted.push({ rooms, type, data }); } };
  } };
  const poll = service.createLiveEventsEmitter({ now: () => now, provider, notificationDevices: devices,
    recipientAllowed: () => true, getMatchDetails: async (...args) => {
      state.detailReads++; return readDetail ? readDetail(...args) : null;
    } });
  const update = (row, options = {}) => ({ match: row, baseline: false, receivedAt: now,
    generationId: '1:0:1', ...options });
  return { state, io, poll, update, time: () => now, advance: ms => { now += ms; },
    rest: rows => poll(io, { liveSnapshot: rows, includeDetails: false }),
    stream: (row, options = {}) => poll(io, { streamOnly: true, includeDetails: false,
      streamUpdates: new Map([[row.id, update(row, options)]]) }) };
}
const types = h => h.state.persisted.map(event => event.type);

test('subscription baseline and history stay silent, then a new confirmed action alerts with source clock and player', async () => {
  const h = harness();
  const projection = createBsdStreamProjection({ now: h.time });
  const initial = match(); projection.seed([initial]);
  const snapshot = { type: 'event', event_id: 101,
    home: { id: 202 }, away: { id: 203 }, score: { home: 3, away: 0 },
    time: { status: 'live', minute: 67, second: 0, period: 2, kickoff_at: initial.utcDate } };
  const historicGoal = { type: 'action', action_type: 'goal', event_id: 101, team: 'home',
    score: { home: 3, away: 0 }, player: { id: 7, name: 'Historical scorer' },
    minute: 20, second: 0, period: 1, ts: START - 2000000 };
  const baseline = projection.project({ type: 'subscribed', event_id: 101, source: 'full',
    event: snapshot, history: [historicGoal] });
  await h.stream(baseline.match, { baseline: baseline.baseline, receivedAt: baseline.receivedAt });
  assert.deepEqual(types(h), []);
  assert.equal(projection.project(historicGoal).accepted, false);
  const goalFrame = { ...historicGoal, score: { home: 4, away: 0 },
    player: { id: 8, name: 'New scorer' }, minute: 67, second: 1, period: 2, ts: START - 50 };
  const fresh = projection.project(goalFrame);
  await h.stream(fresh.match, { receivedAt: fresh.receivedAt, incident: fresh.incident });
  assert.deepEqual(types(h), ['goal']);
  assert.equal(h.state.persisted[0].player, 'New scorer');
  assert.equal(h.state.persisted[0].playerId, 'bsd_p_8');
  assert.equal(h.state.persisted[0].lastUpdated, new Date(goalFrame.ts).toISOString());
  assert.notEqual(h.state.persisted[0].lastUpdated, new Date(fresh.receivedAt).toISOString());
  assert.equal(h.state.fixtureReads, 0); assert.equal(h.state.liveReads, 0); assert.equal(h.state.detailReads, 0);
});

test('confirmed stream goal/cancellation/new goal are distinct and stale REST cannot replay either score', async () => {
  const h = harness();
  await h.stream(match(), { baseline: true });
  await h.stream(match(101, 1));
  await h.stream(match(101, 0));
  await h.stream(match(101, 1));
  await h.rest([match(101, 0)]);
  await h.rest([match(101, 1)]);
  assert.deepEqual(types(h), ['goal', 'goalCancelled', 'goal']);
  assert.equal(new Set(h.state.persisted.map(event => event.eventId)).size, 3);
  assert.deepEqual(h.state.persisted[1].previousScore, { home: 1, away: 0 });
  assert.deepEqual(h.state.delivered.map(event => event.type), types(h));
});

test('a per-fixture stream update preserves unrelated baseline for its later real goal', async () => {
  const h = harness();
  await h.rest([match(101), match(102)]);
  await h.stream(match(101), { baseline: true });
  await h.stream(match(101, 1));
  await h.rest([match(101, 0), match(102, 1)]);
  assert.deepEqual(types(h), ['goal', 'goal']);
  assert.deepEqual(h.state.persisted.map(event => event.matchId), ['bsd_101', 'bsd_102']);
});

test('queued stream baseline/goal/cancel/new goal retain FIFO order behind a blocked cycle', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const blockedEntered = new Promise(resolve => { entered = resolve; });
  let firstCommit = true;
  const h = harness({ persistRead: async () => { if (firstCommit) {
    firstCommit = false; entered(); await blocked;
  } } });
  await h.rest([match(102)]);
  const running = h.rest([match(102, 1)]);
  await blockedEntered;
  const baseline = h.stream(match(101), { baseline: true });
  const goal = h.stream(match(101, 1));
  const cancellation = h.stream(match(101, 0));
  const newGoal = h.stream(match(101, 1));
  const otherRest = h.rest([match(101, 0), match(102, 2)]);
  release();
  await Promise.all([running, baseline, goal, cancellation, newGoal, otherRest]);
  await flush(); await flush();
  const streamed = h.state.persisted.filter(event => event.matchId === 'bsd_101');
  assert.deepEqual(streamed.map(event => event.type), ['goal', 'goalCancelled', 'goal']);
  assert.equal(new Set(streamed.map(event => event.eventId)).size, 3);
  assert.deepEqual(h.state.persisted.filter(event => event.matchId === 'bsd_102').map(event => event.score), ['1 - 0', '2 - 0']);
});

test('reconnect baseline silently rebases scores without goal/cancellation/phase/history alerts', async () => {
  const h = harness();
  await h.stream(match(), { baseline: true });
  await h.stream(match(101, 1));
  await h.stream(match(101, 3, { matchPhase: 'EXTRA_TIME', period: 'EXTRA_TIME', minute: 101 }),
    { baseline: true, generationId: '1:0:2' });
  assert.deepEqual(types(h), ['goal']);
  await h.stream(match(101, 4, { matchPhase: 'EXTRA_TIME', period: 'EXTRA_TIME', minute: 102 }),
    { generationId: '1:0:2' });
  assert.deepEqual(types(h), ['goal', 'goal']);
  assert.equal(h.state.persisted[1].score, '4 - 0');
});

test('terminal stream status alerts only once for the exact canonical fixture participants and kickoff', async () => {
  const h = harness();
  await h.stream(match(), { baseline: true });
  const finished = match(101, 0, { status: 'FINISHED', matchPhase: 'FULL_TIME', period: 'FULL_TIME', minute: 90 });
  await h.stream({ ...finished, homeTeam: match(102).homeTeam });
  await h.stream({ ...finished, utcDate: '2026-10-14T17:31:00Z' });
  assert.deepEqual(types(h), []);
  await h.stream(finished); await h.stream(finished);
  assert.deepEqual(types(h), ['matchEnd']);
  assert.equal(h.state.persisted[0].matchId, 'bsd_101');
});

test('unknown nonbaseline fixtures and mismatched identities never establish or mutate detector state', async () => {
  const h = harness();
  await h.stream(match(999, 3));
  await h.stream(match(999, 4));
  assert.deepEqual(types(h), []);
  await h.stream(match(), { baseline: true });
  await h.stream(match(101, 1, { awayTeam: match(102).awayTeam }));
  await h.stream(match(101, 1, { homeTeam: match(101).awayTeam, awayTeam: match(101).homeTeam }));
  await h.stream(match(101, 1, { utcDate: '2026-10-14T17:31:00Z' }));
  await h.stream(match(101, 1, { source: 'sportscore' }));
  await h.poll(h.io, { streamOnly: true, includeDetails: false,
    streamUpdates: new Map([['bsd_999', h.update(match(101, 1))]]) });
  assert.deepEqual(types(h), []);
  await h.stream(match(101, 1));
  assert.deepEqual(types(h), ['goal']);
});

test('stream rejects noninteger/out-of-range/unknown scoreboard values instead of inventing valid scores', async () => {
  const h = harness();
  await h.stream(match(), { baseline: true });
  for (const home of [-1, 100, 1.5, '1', true, null, NaN]) await h.stream(match(101, home));
  assert.deepEqual(types(h), []);
  await h.stream(match(101, 1));
  assert.deepEqual(types(h), ['goal']);
});

test('receipt freshness is distinct from provider clock and stale/future observations do not mutate state', async () => {
  const h = harness();
  await h.stream(match(), { baseline: true });
  await h.stream(match(101, 1), { receivedAt: START - 60001 });
  await h.stream(match(101, 1), { receivedAt: START + 1001 });
  await h.stream(match(101, 1), { receivedAt: NaN });
  assert.deepEqual(types(h), []);
  await h.stream(match(101, 1), { receivedAt: START });
  assert.deepEqual(types(h), ['goal']);
  assert.equal(h.state.persisted[0].lastUpdated, undefined, 'No fabricated provider clock from receipt time');
  assert.equal(h.state.persisted[0].createdAt.getTime(), START);
});

test('older actual source timestamps cannot roll a confirmed stream goal back', async () => {
  const h = harness();
  await h.stream(match(101, 0, { lastUpdated: new Date(START - 1000).toISOString() }), { baseline: true });
  await h.stream(match(101, 1, { lastUpdated: new Date(START - 500).toISOString() }));
  await h.stream(match(101, 0, { lastUpdated: new Date(START - 900).toISOString() }));
  await h.rest([match(101, 0, { lastUpdated: new Date(START - 800).toISOString() })]);
  assert.deepEqual(types(h), ['goal']);
  assert.equal(h.state.persisted[0].lastUpdated, new Date(START - 500).toISOString());
});

test('expired stream lease silently rebases an untimestamped conflicting REST fallback', async () => {
  const h = harness();
  await h.stream(match(), { baseline: true });
  await h.stream(match(101, 1));
  h.advance(59999); await h.rest([match(101, 0)]);
  assert.deepEqual(types(h), ['goal']);
  h.advance(2); await h.rest([match(101, 0)]);
  assert.deepEqual(types(h), ['goal'], 'Uncertain fallback is not a verified goal cancellation');
  await h.rest([match(101, 1)]);
  assert.deepEqual(types(h), ['goal', 'goal'], 'A later fresh REST transition uses the rebased baseline');
  assert.equal(new Set(h.state.persisted.map(event => event.eventId)).size, 2);
});

test('invalid direct goal enrichment cannot substitute another side/score or provider incident identity', async () => {
  const h = harness();
  await h.stream(match(), { baseline: true });
  await h.stream(match(101, 1), { incident: { id: `bsd_ws_${'a'.repeat(64)}`, type: 'goal', provider: 'bsd',
    side: 'away', score: { home: 1, away: 0 }, player: 'Incorrect scorer', playerId: 'bsd_p_8' } });
  assert.equal(h.state.persisted[0].player, '');
  await h.stream(match(101, 2), { incident: { id: 'ko_inc_8', type: 'goal', provider: 'kickoffapi',
    side: 'home', score: { home: 2, away: 0 }, player: 'Incorrect provider', playerId: 'ko_p_8' } });
  assert.equal(h.state.persisted[1].player, '');
});
