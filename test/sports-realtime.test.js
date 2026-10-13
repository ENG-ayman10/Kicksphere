const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const logger = { info() {}, warn() {}, error() {} };
function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}

function fixture(status, home = null, away = null) {
  return { id: 'test-match', status, homeTeam: { id: 'a', name: 'A' }, awayTeam: { id: 'b', name: 'B' },
    score: { fullTime: { home, away } }, competition: { name: 'Offline test league' } };
}

function harness({ usersByTeam, fixtureRead, subscribedMatchIds = [], deviceRecipients,
  recipientAllowed, restrictSocketAlerts, retryRead, now, fixtureRefreshIntervalMs, detailRead,
  nonBlockingDetails, asynchronousDelivery, saveRead, legacyQueryRead, getAlertMatchIds, persistRead } = {}) {
  const state = { fixtures: [], fixtureReads: 0, fixtureDays: [], live: [], detail: null, detailsRead: 0,
    delivered: [], retryFlushes: 0, queriedMatchIds: [], timelineRequests: [],
    reads: [], liveReads: 0, detailIds: [], activeReads: 0, peakReads: 0, activeNotifications: 0, peakNotifications: 0 };
  const emitted = []; const persisted = []; const notifications = [];
  const io = { sockets: { adapter: { rooms: new Map() } }, to(rooms) {
    const target = { excluded: [], except(values) { this.excluded = values; return this; },
      emit(type, data) { emitted.push({ rooms, type, data, excluded: this.excluded }); } };
    return target;
  } };
  const query = (team, cursor = null, pageSize = null) => ({
    orderBy(field) { assert.equal(field, '__name__'); return this; },
    limit(value) { assert.equal(value, 200); return query(team, cursor, value); },
    startAfter(doc) { assert.ok(doc && typeof doc.data === 'function'); return query(team, doc.id, pageSize); },
    async get() {
      if (legacyQueryRead) await legacyQueryRead();
      state.peakReads = Math.max(state.peakReads, ++state.activeReads);
      await new Promise(resolve => setImmediate(resolve));
      state.activeReads--;
      const ids = usersByTeam ? usersByTeam[team] || [] : ['same-fan'];
      const docs = ids.slice().sort().filter(id => cursor === null || id > cursor)
        .slice(0, pageSize).map(id => ({ id, data: () => ({}) }));
      state.reads.push({ team, cursor, pageSize, count: docs.length });
      return { docs };
    }
  });
  const db = {
    batch: () => ({ set: (_, data) => persisted.push(data), commit: async () => { if (persistRead) await persistRead(); } }),
    collection: name => ({ doc: () => ({}), where(field, operator, team) {
      assert.equal(name, 'users');
      assert.equal(field, 'preferences.teamIds');
      assert.equal(operator, 'array-contains');
      return query(team);
    } })
  };
  const service = load('../services/liveEventsService', {
    '../config/firebase': db, '../utils/logger': logger,
    './notificationDeviceService': { ...(getAlertMatchIds ? { getAlertMatchIds } : {}), getSubscribedMatchIds: async ids => {
      state.queriedMatchIds.push(ids); return new Set(subscribedMatchIds);
    },
      flushRetries: async () => { state.retryFlushes++; return retryRead ? retryRead() : {}; },
      findRecipients: async events => deviceRecipients ? deviceRecipients(events) : new Map(),
      deliver: async (device, event) => { state.delivered.push({ userId: device.userId, event }); } },
    './sportscoreService': { getMatchesByDate: async date => {
      state.fixtureReads++; state.fixtureDays.push(date); return fixtureRead ? fixtureRead(state, date) : state.fixtures;
    }, getLiveMatches: async () => { state.liveReads++; return state.live; },
      getMatchDetails: async () => { state.detailsRead++; return state.detail; } },
    './notificationService': { saveNotification: async (id, data) => {
      if (saveRead) await saveRead();
      state.peakNotifications = Math.max(state.peakNotifications, ++state.activeNotifications);
      await new Promise(resolve => setImmediate(resolve));
      state.activeNotifications--;
      notifications.push({ id, data });
    } },
    './pushNotificationService': { sendPushNotification: async () => assert.fail('No push token in offline fixture') }
  });
  return { state, io, emitted, persisted, notifications,
    poll: service.createLiveEventsEmitter({ recipientAllowed, restrictSocketAlerts, now, fixtureRefreshIntervalMs,
      nonBlockingDetails, asynchronousDelivery,
      getMatchDetails: async (id, options) => {
        state.detailsRead++; state.detailIds.push(id); state.timelineRequests.push(options?.includeTimeline === true);
        return detailRead ? detailRead(id, options) : state.detail;
      } }) };
}

const flushTasks = () => new Promise(resolve => setImmediate(resolve));

test('a genuine new goal after cancellation uses a different durable event ID even at the same observation clock', async () => {
  const h = harness({ now: () => 1 });
  for (const home of [0, 1, 0, 1, 1]) {
    await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', home, 0)], includeDetails: false });
  }
  assert.deepEqual(h.persisted.map(event => event.type), ['goal', 'goalCancelled', 'goal']);
  assert.equal(new Set(h.persisted.map(event => event.eventId)).size, 3);
  assert.deepEqual(h.persisted[1].previousScore, { home: 1, away: 0 });
});

test('a score reallocation produces one correction, without an extra goal alert or unsupported VAR claim', async () => {
  const h = harness();
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 1, 0)], includeDetails: false });
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 0, 1)], includeDetails: false });
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 0, 1)], includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.type), ['scoreCorrection']);
  assert.equal(h.persisted[0].side, '');
  assert.equal(h.persisted[0].reason, undefined);
});

test('upcoming reminders fire once in the 15-minute window and never replay late after a restart', async () => {
  let now = Date.parse('2026-10-11T12:00:00Z');
  const h = harness({ now: () => now });
  const scheduled = { ...fixture('TIMED'), utcDate: '2026-10-11T12:15:00Z' };
  h.state.fixtures = [scheduled]; await h.poll(h.io); await flushTasks();
  await h.poll(h.io, { liveSnapshot: [], includeDetails: false });
  now += 10000; await h.poll(h.io, { liveSnapshot: [], includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.type), ['matchReminder']);
  assert.equal(h.persisted[0].reminderMinutes, 15);
  assert.equal(Date.parse(h.persisted[0].utcDate), Date.parse(scheduled.utcDate));
  const restarted = harness({ now: () => now + 2 * 60000 });
  restarted.state.fixtures = [scheduled]; await restarted.poll(restarted.io); await flushTasks();
  await restarted.poll(restarted.io, { liveSnapshot: [], includeDetails: false });
  assert.equal(restarted.persisted.length, 0);
});

test('a reminder before UTC midnight includes the next-day fixture without broad daily reads elsewhere', async () => {
  const now = Date.parse('2026-10-11T23:50:00Z');
  const scheduled = { ...fixture('TIMED'), utcDate: '2026-10-12T00:05:00Z' };
  const h = harness({ now: () => now, fixtureRead: (_, date) => date === '2026-10-12' ? [scheduled] : [] });
  await h.poll(h.io); await flushTasks();
  await h.poll(h.io, { liveSnapshot: [], includeDetails: false });
  assert.deepEqual(h.state.fixtureDays, ['2026-10-11', '2026-10-12']);
  assert.deepEqual(h.persisted.map(event => event.type), ['matchReminder']);
  const midday = harness({ now: () => Date.parse('2026-10-11T12:00:00Z') });
  await midday.poll(midday.io); await flushTasks();
  assert.deepEqual(midday.state.fixtureDays, ['2026-10-11']);
});

test('only a complete source-confirmed lineup transition alerts, not predictions, partial records or an initial historical lineup', async () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const h = harness({ now: () => now, subscribedMatchIds: ['test-match'] });
  const scheduled = { ...fixture('TIMED'), utcDate: '2026-10-11T12:30:00Z' };
  const official = { confirmed: true, predicted: false, lineupStatus: 'confirmed', matchId: scheduled.id,
    home: Array.from({ length: 11 }, (_, i) => ({ id: `h-${i}` })),
    away: Array.from({ length: 11 }, (_, i) => ({ id: `a-${i}` })) };
  h.state.fixtures = [scheduled]; await h.poll(h.io); await flushTasks();
  h.state.detail = { ...scheduled, lineups: { ...official, confirmed: false, predicted: true, lineupStatus: 'predicted' } };
  await h.poll(h.io);
  h.state.detail = { ...scheduled, lineups: { ...official, away: official.away.slice(0, 10) } };
  await h.poll(h.io); assert.equal(h.persisted.length, 0);
  h.state.detail = { ...scheduled, lineups: official };
  await h.poll(h.io); await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['lineup']);
  assert.equal(h.persisted[0].lineupConfirmed, true);
  const restarted = harness({ now: () => now, subscribedMatchIds: ['test-match'] });
  restarted.state.fixtures = [scheduled]; await restarted.poll(restarted.io); await flushTasks();
  restarted.state.detail = h.state.detail; await restarted.poll(restarted.io);
  assert.equal(restarted.persisted.length, 0);
});

test('phase alerts follow explicit forward source phases, with no minute-based halftime or replay on backward phase data', async () => {
  const h = harness();
  const phase = value => ({ ...fixture(value === 'HALF_TIME' ? 'PAUSED' : 'IN_PLAY', 0, 0), matchPhase: value });
  const poll = row => h.poll(h.io, { liveSnapshot: [row], includeDetails: false });
  await poll({ ...fixture('IN_PLAY', 0, 0), minute: 45 });
  await poll({ ...fixture('PAUSED', 0, 0), minute: 47 });
  assert.equal(h.persisted.length, 0);
  await poll(phase('FIRST_HALF')); await poll(phase('HALF_TIME')); await poll(phase('SECOND_HALF'));
  await poll(phase('HALF_TIME')); await poll(phase('SECOND_HALF')); await poll(phase('EXTRA_TIME'));
  await poll(phase('PENALTIES')); await poll({ ...phase('FULL_TIME'), status: 'FINISHED' });
  assert.deepEqual(h.persisted.map(event => event.type), ['halfTime', 'secondHalfStart', 'extraTimeStart', 'penaltyShootout', 'matchEnd']);
});

test('incident enrichment never repeats a red card and late historical backfill stays silent', async () => {
  const h = harness({ subscribedMatchIds: ['test-match'] });
  const match = { ...fixture('IN_PLAY', 0, 0), minute: 70 };
  h.state.live = [match]; h.state.detail = { ...match, timeline: [] };
  await h.poll(h.io);
  const red = { id: 'red-7', type: 'red_card', minute: 70, side: 'home', player: 'Player' };
  h.state.detail.timeline = [red]; await h.poll(h.io);
  h.state.detail.timeline = [{ ...red, player: 'اللاعب', label: 'Translated' },
    { id: 'old-red', type: 'red_card', minute: 20, side: 'away', player: 'Earlier' },
    { id: 'rescinded-red', type: 'red_card', minute: 71, side: 'home', rescinded: true }];
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['card']);
  assert.equal(h.persisted[0].incidentId, 'red-7');
  assert.equal(h.persisted[0].isDetailed, false);
});

test('new yellow cards reach direct match bells only and a provider yellow-to-red upgrade alerts once publicly', async () => {
  const { eventMatchesPreferences } = require('../utils/notificationContracts');
  const h = harness({ subscribedMatchIds: ['test-match'], deviceRecipients: events => {
    const matching = events.filter(event => eventMatchesPreferences(event, { matchIds: ['test-match'] }));
    return new Map([['direct-bell', { userId: 'bell-fan', events: new Map(matching.map(event => [event.eventId, event])) }]]);
  } });
  h.state.live = [fixture('IN_PLAY', 0, 0)]; h.state.detail = { ...fixture('IN_PLAY', 0, 0), timeline: [] };
  await h.poll(h.io);
  const yellow = { id: 'upgraded-card', type: 'yellow_card', minute: 70, side: 'home', player: 'Player' };
  h.state.detail.timeline = [yellow]; await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['card']);
  assert.equal(h.persisted[0].cardType, 'yellow');
  assert.equal(h.persisted[0].isDetailed, true);
  assert.equal(eventMatchesPreferences(h.persisted[0], { teamIds: ['sc_t_a'] }), false);
  assert.equal(h.state.delivered[0].userId, 'bell-fan');
  assert.equal(h.notifications[0].data.title, 'Yellow card');
  h.state.detail.timeline = [{ ...yellow, type: 'red_card' },
    { id: 'deleted-yellow', type: 'yellow_card', minute: 71, side: 'home', deleted: true }];
  await h.poll(h.io); await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.cardType), ['yellow', 'red']);
  assert.equal(h.persisted[1].isDetailed, false);
  assert.equal(eventMatchesPreferences(h.persisted[1], { teamIds: ['sc_t_a'] }), true);
  assert.notEqual(h.persisted[0].eventId, h.persisted[1].eventId);
});

test('new source-confirmed shootout goal incidents send one detailed penalty rather than a regulation goal', async () => {
  const h = harness({ subscribedMatchIds: ['test-match'], usersByTeam: {} });
  h.io.sockets.adapter.rooms.set('matchAlerts_test-match', new Set(['socket']));
  const shootout = (home, timeline = []) => ({ ...fixture('IN_PLAY', home, 1), minute: 120,
    matchPhase: 'PENALTIES', period: 'penalties', timeline });
  h.state.live = [shootout(1)]; h.state.detail = shootout(1); await h.poll(h.io);
  const kick = { id: 'shootout-kick-1', type: 'goal', period: 'penalties', minute: 0, side: 'home', player: 'Scorer' };
  h.state.live = [shootout(2)]; h.state.detail = shootout(2, [kick]); await h.poll(h.io);
  h.state.detail = shootout(2, [{ ...kick, player: 'Enriched' },
    { id: 'rescinded-kick', type: 'goal', period: 'penalties', minute: 0, side: 'home', rescinded: true }]);
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['penalty']);
  assert.equal(h.persisted[0].penaltyType, 'shootout_scored');
  assert.equal(h.persisted[0].phase, 'PENALTIES');
  assert.equal(h.persisted[0].isDetailed, true);
  assert.equal(h.emitted.filter(event => event.type === 'detailedAlert').length, 1);
});

test('an optional detail request and stale completion cannot delay or overwrite newer fast score cycles', async () => {
  let resolveDetail;
  const pendingDetail = new Promise(resolve => { resolveDetail = resolve; });
  const h = harness({ nonBlockingDetails: true, subscribedMatchIds: ['test-match'], detailRead: () => pendingDetail });
  const at = (home, second) => ({ ...fixture('IN_PLAY', home, 0), lastUpdated: `2026-10-11T12:00:${second}Z` });
  await h.poll(h.io, { liveSnapshot: [at(0, '00')] }); await flushTasks();
  assert.equal(h.state.detailsRead, 1);
  await h.poll(h.io, { liveSnapshot: [at(1, '20')], includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.type), ['goal'], 'Score work completes while detail remains unresolved');
  resolveDetail({ ...at(0, '10'), timeline: [{ id: 'stale-card', type: 'red_card', minute: 5, side: 'home' }] });
  await flushTasks(); await flushTasks();
  await h.poll(h.io, { liveSnapshot: [at(2, '30')], includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.type), ['goal', 'goal']);
  assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0', '2 - 0']);
  assert.equal(h.state.liveReads, 0, 'Completed details never trigger another broad HTTP read');
});

test('a late asynchronous upcoming-detail completion never announces historical kickoff or lineup publication', async () => {
  let now = Date.parse('2026-10-11T12:00:00Z');
  let resolveDetail;
  const pending = new Promise(resolve => { resolveDetail = resolve; });
  const h = harness({ now: () => now, nonBlockingDetails: true, subscribedMatchIds: ['test-match'], detailRead: () => pending });
  const official = { confirmed: true, predicted: false, lineupStatus: 'confirmed', matchId: 'test-match',
    home: Array.from({ length: 11 }, (_, i) => ({ id: `home-${i}` })),
    away: Array.from({ length: 11 }, (_, i) => ({ id: `away-${i}` })) };
  const scheduled = { ...fixture('TIMED'), utcDate: '2026-10-11T12:30:00Z',
    lineups: { ...official, confirmed: false, predicted: true, lineupStatus: 'predicted' } };
  await h.poll(h.io, { liveSnapshot: [scheduled] }); await flushTasks();
  assert.equal(h.state.detailsRead, 1);
  now = Date.parse('2026-10-11T13:30:00Z');
  resolveDetail({ ...fixture('IN_PLAY', 2, 1), utcDate: scheduled.utcDate, minute: 60,
    lastUpdated: new Date(now).toISOString(), lineups: official, timeline: [] });
  await flushTasks(); await flushTasks();
  assert.equal(h.persisted.length, 0);
  assert.equal(h.state.liveReads, 0);
});

test('a queued detail-only completion cannot erase a newer queued score sample or synthesize a rollback', async () => {
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const h = harness({ legacyQueryRead: () => blocked });
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 0, 0)], includeDetails: false });
  const first = h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 1, 0)], includeDetails: false });
  await flushTasks();
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 2, 0)], includeDetails: false });
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 0, 0)], includeDetails: false, detailsOnly: true,
    completedDetails: new Map([['test-match', fixture('IN_PLAY', 0, 0)]]) });
  unblock(); await first; await flushTasks(); await flushTasks();
  assert.deepEqual(h.persisted.map(event => event.type), ['goal', 'goal']);
  assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0', '2 - 0']);
  assert.equal(h.state.liveReads, 0);
});

test('a device push starts before blocked legacy audience pagination or inbox persistence', async () => {
  let unblock;
  const pending = new Promise(resolve => { unblock = resolve; });
  const h = harness({ asynchronousDelivery: true, persistRead: () => pending, legacyQueryRead: () => pending, saveRead: () => pending,
    deviceRecipients: events => new Map([['installation', { userId: 'fan', events: new Map(events.map(event => [event.eventId, event])) }]]) });
  try {
    await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 0, 0)], includeDetails: false });
    await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 1, 0)], includeDetails: false }); await flushTasks();
    assert.equal(h.state.delivered.length, 1);
    assert.equal(h.notifications.length, 0);
    await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 2, 0)], includeDetails: false }); await flushTasks();
    assert.equal(h.state.delivered.length, 2, 'A blocked inbox cannot prevent the next score event');
  } finally { unblock(); await flushTasks(); await flushTasks(); }
});

test('favorite club audiences are eligible for bounded timeline/lineup lookup without requiring a direct match bell', async () => {
  const h = harness({ getAlertMatchIds: async matches => new Set(matches.map(match => match.id)) });
  h.state.live = [fixture('IN_PLAY', 0, 0)]; h.state.detail = { ...fixture('IN_PLAY', 0, 0), timeline: [] };
  await h.poll(h.io);
  assert.equal(h.state.detailsRead, 1);
  assert.equal(h.state.timelineRequests[0], true);
  h.state.detail.timeline = [{ id: 'favorite-red', type: 'red_card', minute: 10, side: 'away', player: 'Player' }];
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['card']);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].data.title, 'Red card', 'Legacy inbox mocks lacking a localized builder still have the correct event title');
});

test('shared snapshots detect goals immediately without another broad read or optional detail work', async () => {
  const h = harness({ subscribedMatchIds: ['test-match'] });
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 0, 0)], includeDetails: false });
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 1, 0)], includeDetails: false });
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 1, 0)], includeDetails: false });
  assert.equal(h.state.liveReads, 0);
  assert.equal(h.state.detailsRead, 0);
  assert.equal(h.state.queriedMatchIds.length, 0);
  assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
});

test('subscribed details take priority over older disappeared games within six reads and three concurrent requests', async () => {
  let active = 0; let peak = 0;
  const h = harness({ subscribedMatchIds: ['subscribed-match'], detailRead: async () => {
    peak = Math.max(peak, ++active); await flushTasks(); active--; return null;
  } });
  const subscribed = { ...fixture('IN_PLAY', 0, 0), id: 'subscribed-match' };
  h.state.live = [...Array.from({ length: 8 }, (_, n) => ({ ...fixture('IN_PLAY', 0, 0), id: `missing-${n}` })), subscribed];
  await h.poll(h.io);
  h.state.detailIds.length = 0;
  h.state.live = [subscribed];
  await h.poll(h.io);
  assert.equal(h.state.detailIds[0], 'subscribed-match');
  assert.equal(h.state.detailIds.length, 6);
  assert.equal(peak, 3);
});

test('detail overrides reject lagging un-timestamped lists while authoritative score corrections still apply', async () => {
  const h = harness({ subscribedMatchIds: ['test-match'] });
  h.state.live = [fixture('IN_PLAY', 0, 0)]; h.state.detail = fixture('IN_PLAY', 0, 0);
  await h.poll(h.io);
  h.state.detail = fixture('IN_PLAY', 1, 0); await h.poll(h.io);
  h.state.detail = null;
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 0, 1)], includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0'], 'A conflicting lagging list cannot erase the detail baseline');
  h.state.detail = fixture('IN_PLAY', 0, 0); await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['goal', 'goalCancelled'], 'A confirmed decrease sends cancellation rather than a goal');
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  await h.poll(h.io, { liveSnapshot: h.state.live, includeDetails: false });
  h.state.live = [fixture('IN_PLAY', 0, 1)];
  await h.poll(h.io, { liveSnapshot: h.state.live, includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0', '0 - 0', '0 - 1'], 'The corrected baseline is used for the next genuine goal');
});

test('a newer provider timestamp accepts a real cancellation after a fresher detail goal', async () => {
  const h = harness({ subscribedMatchIds: ['test-match'] });
  const at = (home, away, second) => ({ ...fixture('IN_PLAY', home, away), lastUpdated: `2026-10-02T12:00:${second}Z` });
  h.state.live = [at(0, 0, '00')]; h.state.detail = at(0, 0, '00'); await h.poll(h.io);
  h.state.detail = at(1, 0, '10'); await h.poll(h.io);
  await h.poll(h.io, { liveSnapshot: [at(0, 0, '20')], includeDetails: false });
  await h.poll(h.io, { liveSnapshot: [at(0, 1, '30')], includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0', '0 - 0', '0 - 1']);
  assert.deepEqual(h.persisted.map(event => event.type), ['goal', 'goalCancelled', 'goal']);
});

test('a live list that catches the detail baseline releases its override despite an old active calendar row', async () => {
  const h = harness({ subscribedMatchIds: ['test-match'] });
  h.state.fixtures = [fixture('IN_PLAY', 0, 0)];
  h.state.live = [fixture('IN_PLAY', 0, 0)]; h.state.detail = fixture('IN_PLAY', 0, 0); await h.poll(h.io);
  h.state.detail = fixture('IN_PLAY', 1, 0); await h.poll(h.io);
  h.state.detail = null;
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 1, 0)], includeDetails: false });
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 2, 0)], includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0', '2 - 0']);
});

test('an un-timestamped conflicting list cannot freeze forever or replay a cancelled goal after the detail lease expires', async () => {
  let time = 0;
  const h = harness({ subscribedMatchIds: ['test-match'], now: () => time });
  h.state.live = [fixture('IN_PLAY', 0, 0)]; h.state.detail = fixture('IN_PLAY', 0, 0); await h.poll(h.io);
  time = 30000; h.state.detail = fixture('IN_PLAY', 1, 0); await h.poll(h.io);
  time = 60000; h.state.detail = fixture('IN_PLAY', 0, 0); await h.poll(h.io);
  h.state.detail = null;
  const conflicting = { liveSnapshot: [fixture('IN_PLAY', 1, 0)], includeDetails: false };
  time = 120000; await h.poll(h.io, conflicting);
  time = 239999; await h.poll(h.io, conflicting);
  assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0', '0 - 0']);
  time = 240000; await h.poll(h.io, conflicting);
  assert.equal(h.persisted.length, 2, 'The uncertain rebase cannot replay the cancelled goal');
  time = 300000;
  await h.poll(h.io, { liveSnapshot: [fixture('IN_PLAY', 1, 1)], includeDetails: false });
  assert.deepEqual(h.persisted.map(event => event.score), ['1 - 0', '0 - 0', '1 - 1'], 'A later observed change uses the rebased list instead of staying frozen');
});

test('controlled-clock integration measures a 30-second alert improvement for the same provider observation', async () => {
  let time = 0; let score = 0; let broadReads = 0;
  const previous = harness({ now: () => time });
  const shared = harness({ now: () => time });
  const { createLivePollingCoordinator } = require('../services/livePollingService');
  const polling = createLivePollingCoordinator({ now: () => time, matchesIntervalMs: 60000, eventsIntervalMs: 90000,
    readAndEmitMatches: async () => { broadReads++; return [fixture('IN_PLAY', score, 0)]; },
    emitEvents: cycle => shared.poll(shared.io, cycle) });
  previous.state.live = [fixture('IN_PLAY', 0, 0)]; await previous.poll(previous.io);
  await polling.pollLiveMatches(); await polling.idleEvents();
  time = 30000; score = 1; previous.state.live = [fixture('IN_PLAY', score, 0)];
  time = 60000; await polling.pollLiveMatches(); await polling.idleEvents();
  time = 90000; await previous.poll(previous.io); await polling.pollLiveEvents();
  const oldLatency = previous.persisted[0].createdAt.getTime() - 30000;
  const newLatency = shared.persisted[0].createdAt.getTime() - 30000;
  assert.deepEqual({ oldLatency, newLatency, broadReads, events: shared.persisted.length },
    { oldLatency: 60000, newLatency: 30000, broadReads: 2, events: 1 });
  assert.equal(shared.state.liveReads, 0, 'Neither event phase reads the broad source again');
});

const aliasedFixture = (home = 0, status = 'IN_PLAY') => ({
  id: 'bsd_209462', provider: 'bsd', source: 'bsd', status, utcDate: '2026-10-02T01:30:00Z',
  homeTeam: { id: 'bsd_t_302', name: 'Seattle Sounders FC' },
  awayTeam: { id: 'bsd_t_299', name: 'Sporting Kansas City' },
  score: { fullTime: { home, away: 0 } }, competition: { code: 'MLS', name: 'MLS' },
  providerIdentities: [
    { id: 'bsd_209462', provider: 'bsd', utcDate: '2026-10-02T01:30:00Z', competitionCode: 'MLS',
      homeTeamId: 'bsd_t_302', awayTeamId: 'bsd_t_299' },
    { id: 'seattle-vs-kansas-original', provider: 'sportscore', utcDate: '2026-10-02T01:40:00Z', competitionCode: 'MLS',
      homeTeamId: 'sc_t_seattle-sounders', awayTeamId: 'sc_t_sporting-kansas-city' }
  ]
});

test('verified alternate match bell triggers canonical details and one aliased score event without rewriting provider teams', async () => {
  const h = harness({ subscribedMatchIds: ['seattle-vs-kansas-original'], usersByTeam: {
    'sc_t_seattle-sounders': ['same-fan'], 'sc_t_sporting-kansas-city': ['same-fan']
  } });
  h.state.live = [aliasedFixture(0)];
  const detail = { ...aliasedFixture(0), timeline: [] };
  delete detail.providerIdentities;
  h.state.detail = detail;
  await h.poll(h.io);
  assert.equal(h.state.detailsRead, 1, 'The exact old-provider bell still requests canonical details');
  assert.ok(h.state.queriedMatchIds[0].includes('seattle-vs-kansas-original'));
  assert.equal(h.persisted.length, 0, 'First sighting never replays a historical event');
  h.state.live = [aliasedFixture(1)];
  h.state.detail = { ...detail, score: { fullTime: { home: 1, away: 0 } } };
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
  assert.equal(h.persisted[0].matchId, 'bsd_209462');
  assert.equal(h.persisted[0].homeTeam.id, 'bsd_t_302');
  assert.equal(h.persisted[0].providerIdentities[1].id, 'seattle-vs-kansas-original');
  assert.equal(h.notifications.length, 1, 'Following both verified alternate clubs coalesces the same goal');
  const scoreEvent = h.emitted.find(event => event.type === 'liveEvent');
  assert.ok(scoreEvent.rooms.includes('matchAlerts_seattle-vs-kansas-original'));
  assert.ok(scoreEvent.rooms.includes('team:sc_t_seattle-sounders'));
  await h.poll(h.io);
  assert.equal(h.persisted.length, 1);
});

test('alternate detailed socket room follows canonical timeline and emits one card to both exact alert identities', async () => {
  const h = harness({ usersByTeam: {} });
  h.io.sockets.adapter.rooms.set('matchAlerts_seattle-vs-kansas-original', new Set(['socket']));
  h.state.live = [aliasedFixture()];
  h.state.detail = { ...aliasedFixture(), timeline: [] };
  await h.poll(h.io);
  assert.equal(h.state.detailsRead, 1);
  assert.equal(h.state.timelineRequests[0], true);
  h.state.detail = { ...aliasedFixture(), timeline: [{ id: 'red-1', type: 'red_card', minute: 60,
    side: 'home', player: 'Player', label: 'Red card' }] };
  await h.poll(h.io);
  const cards = h.emitted.filter(event => event.type === 'liveEvent' && event.data.type === 'card');
  assert.equal(cards.length, 1);
  assert.ok(cards[0].rooms.includes('matchAlerts_bsd_209462'));
  assert.ok(cards[0].rooms.includes('matchAlerts_seattle-vs-kansas-original'));
  await h.poll(h.io);
  assert.equal(h.emitted.filter(event => event.type === 'liveEvent' && event.data.type === 'card').length, 1);
});

test('an in-flight FCM retry backlog cannot block live score detection or start an overlapping flush', async () => {
  let resolveRetries;
  const pending = new Promise(resolve => { resolveRetries = resolve; });
  const h = harness({ retryRead: () => pending });
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Pending FCM retries blocked a live score cycle')), 1000);
  });
  try {
    await Promise.race([h.poll(h.io), deadline]);
    h.state.live = [fixture('IN_PLAY', 1, 0)];
    await h.poll(h.io);
    await h.poll(h.io);
    assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
    assert.equal(h.state.retryFlushes, 1);
  } finally { clearTimeout(timeout); resolveRetries({}); }
});

test('slow fixture reads cannot block live goals or reset a first-sighting baseline when they complete', async () => {
  let resolveFixtures;
  const fixturePending = new Promise(resolve => { resolveFixtures = resolve; });
  const h = harness({ fixtureRead: () => fixturePending });
  h.state.live = [fixture('IN_PLAY', 1, 0)];
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('A pending calendar read blocked the live poll')), 1000);
  });
  try {
    await Promise.race([h.poll(h.io), deadline]);
    assert.equal(h.persisted.length, 0, 'First live observation is never a historical goal or kickoff');
    h.state.live = [fixture('IN_PLAY', 2, 0)];
    await h.poll(h.io);
    assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
    assert.equal(h.state.fixtureReads, 1, 'Only one calendar request may remain in flight');
    resolveFixtures([fixture('TIMED')]);
    await flushTasks();
    await h.poll(h.io);
    assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
  } finally { clearTimeout(timeout); resolveFixtures([]); }
});

test('late scheduled fixtures seed upcoming matches without delaying live polls or losing kickoff and full time', async () => {
  let resolveFixtures;
  const h = harness({ fixtureRead: () => new Promise(resolve => { resolveFixtures = resolve; }) });
  await h.poll(h.io);
  resolveFixtures([fixture('TIMED')]);
  await flushTasks();
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  await h.poll(h.io);
  h.state.live = [];
  h.state.detail = fixture('FINISHED', 0, 0);
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['matchStart', 'matchEnd']);
});

test('scheduled calendar refresh is bounded independently of live score cycles', async () => {
  let time = Date.parse('2026-10-02T12:00:00Z');
  const h = harness({ now: () => time });
  h.state.fixtures = [fixture('TIMED')];
  await h.poll(h.io);
  for (let i = 0; i < 11; i++) { time += 5000; await h.poll(h.io); }
  assert.equal(h.state.fixtureReads, 1);
  time += 5000;
  await h.poll(h.io);
  assert.equal(h.state.fixtureReads, 2);
});

test('subscribed match details advance stale active list scores while older detail cannot invent a goal', async () => {
  const observedAt = Date.parse('2026-10-02T12:02:00Z');
  const h = harness({ subscribedMatchIds: ['test-match'], now: () => observedAt });
  const at = (home, timestamp) => ({ ...fixture('IN_PLAY', home, 0), lastUpdated: timestamp });
  h.state.live = [at(1, '2026-10-02T12:00:00Z')];
  h.state.detail = at(1, '2026-10-02T12:00:00Z');
  await h.poll(h.io);
  h.state.detail = at(2, '2026-10-02T12:00:30Z');
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.score), ['2 - 0']);
  assert.equal(h.persisted[0].lastUpdated, '2026-10-02T12:00:30.000Z',
    'The goal preserves the fresher core source clock rather than the stale live-list clock');
  assert.equal(h.persisted[0].createdAt.getTime(), observedAt);
  assert.equal(h.notifications[0].data.lastUpdated, h.persisted[0].lastUpdated);
  assert.equal(h.emitted.find(row => row.type === 'liveEvent').data.lastUpdated, h.persisted[0].lastUpdated);
  h.state.detail = null;
  await h.poll(h.io);
  h.state.live = [{ ...fixture('IN_PLAY', 2, 1), lastUpdated: '2026-10-02T12:01:00Z' }];
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.side), ['home', 'away'],
    'A stale list after fresher detail must not create a second home goal when the opponent scores');
  h.state.live = [at(2, '2026-10-02T12:00:30Z')];
  h.state.detail = at(3, '2026-10-02T12:00:00Z');
  await h.poll(h.io);
  assert.equal(h.persisted.length, 2);
});

test('observed goals never invent provider freshness for missing, unzoned or invalid source timestamps', async () => {
  for (const lastUpdated of [undefined, null, '', 1780400000000, 'not-a-time',
    '2026-10-02T12:00:00', '2026-02-30T12:00:00Z', '2026-10-02T24:00:00Z']) {
    const h = harness();
    h.state.live = [{ ...fixture('IN_PLAY', 0, 0), lastUpdated }];
    await h.poll(h.io);
    h.state.live = [{ ...fixture('IN_PLAY', 1, 0), lastUpdated }];
    await h.poll(h.io);
    assert.equal(h.persisted.length, 1);
    assert.equal(Object.hasOwn(h.persisted[0], 'lastUpdated'), false);
    assert.equal(Object.hasOwn(h.notifications[0].data, 'lastUpdated'), false);
  }
});

test('an active calendar snapshot cannot prevent full-time verification when a match leaves live', async () => {
  const h = harness();
  h.state.fixtures = [fixture('IN_PLAY', 1, 0)];
  h.state.live = [fixture('IN_PLAY', 2, 0)];
  await h.poll(h.io);
  h.state.live = [];
  h.state.detail = fixture('FINISHED', 2, 0);
  await h.poll(h.io);
  assert.equal(h.state.detailsRead, 1);
  assert.deepEqual(h.persisted.map(event => event.type), ['matchEnd']);
  await h.poll(h.io);
  assert.equal(h.persisted.length, 1, 'The stale active calendar cannot revive a finished match');
});

test('scoped local recipients exclude other accounts from inbox, personal sockets and every push path', async () => {
  const h = harness({ usersByTeam: { sc_t_a: ['allowed', 'denied'], sc_t_b: ['denied'] },
    recipientAllowed: userId => userId === 'allowed',
    restrictSocketAlerts: true,
    deviceRecipients: events => new Map(['allowed', 'denied'].map(userId => [userId,
      { userId, deviceId: userId, events: new Map(events.map(event => [event.eventId, event])) }])) });
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  h.io.sockets.adapter.rooms.set('matchAlerts_test-match', new Set(['allowed-socket', 'denied-socket']));
  h.state.detail = { ...fixture('IN_PLAY', 0, 0), timeline: [] };
  await h.poll(h.io);
  h.state.live = [fixture('IN_PLAY', 1, 0)];
  h.state.detail = { ...fixture('IN_PLAY', 1, 0), timeline: [{ id: 'scope-card', type: 'red_card', minute: 50 }] };
  await h.poll(h.io);
  assert.deepEqual(h.notifications.map(row => row.id), ['allowed', 'allowed']);
  assert.deepEqual(h.state.delivered.map(row => row.userId), ['allowed', 'allowed']);
  assert.deepEqual(h.emitted.filter(row => row.type === 'notification').map(row => row.rooms), ['user:allowed', 'user:allowed']);
  assert.equal(h.emitted.some(row => ['liveEvent', 'detailedAlert'].includes(row.type)), false,
    'Shared team and match rooms must not bypass the restricted local audience');
  assert.deepEqual(h.emitted[0].excluded, [], 'The allowed user still receives the notification in a match room');
});

test('stale retained live snapshots cannot replay goals or become new active match baselines', async () => {
  const h = harness();
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  await h.poll(h.io);
  h.state.live = [{ ...fixture('IN_PLAY', 1, 0), liveSnapshotStale: true, liveSnapshotAgeMs: 30000 }];
  await h.poll(h.io);
  assert.equal(h.persisted.length, 0);
  h.state.live = [fixture('IN_PLAY', 1, 0)];
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
  const initial = harness();
  initial.state.live = [{ ...fixture('IN_PLAY', 2, 0), liveSnapshotStale: true }];
  await initial.poll(initial.io);
  initial.state.live = [fixture('IN_PLAY', 3, 0)];
  await initial.poll(initial.io);
  assert.equal(initial.persisted.length, 0, 'The first current observation after stale data stays silent');
});

test('explicit VAR incidents reach detailed subscribers without replaying the existing timeline', async () => {
  const h = harness();
  h.io.sockets.adapter.rooms.set('matchAlerts_test-match', new Set(['socket']));
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  h.state.detail = { ...fixture('IN_PLAY', 0, 0), timeline: [{ id: 'old-var', type: 'var', minute: 10 }] };
  await h.poll(h.io);
  h.state.detail.timeline.push({ id: 'new-var', type: 'var', minute: 20, label: 'Goal reviewed' });
  await h.poll(h.io);
  await h.poll(h.io);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].type, 'detailedAlert');
  assert.equal(h.emitted[0].data.type, 'var');
});

test('kickoff and goals reach overlapping rooms once and save one favorite notification', async () => {
  const h = harness();
  h.state.fixtures = [fixture('TIMED')];
  await h.poll(h.io);
  assert.equal(h.emitted.length, 0);
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  await h.poll(h.io);
  h.state.live = [fixture('IN_PLAY', 1, 0)];
  await h.poll(h.io);
  await h.poll(h.io);
  const events = h.emitted.filter(e => e.type === 'liveEvent');
  assert.deepEqual(events.map(e => e.data.type), ['matchStart', 'goal']);
  assert.deepEqual(events[1].rooms, ['match:test-match', 'matchAlerts_test-match', 'team:sc_t_a', 'team:sc_t_b']);
  assert.equal(h.notifications.length, 2);
  assert.equal(h.persisted.length, 2);
  assert.ok(h.emitted.find(e => e.type === 'notification').excluded.includes('match:test-match'));
});

test('favorite audience spans every page with one notification per fan across teams', async () => {
  const fans = (first, count) => Array.from({ length: count }, (_, i) => `fan-${String(first + i).padStart(4, '0')}`);
  // Shared fans occur on different pages in the two team queries.
  const h = harness({ usersByTeam: { sc_t_a: fans(0, 405), sc_t_b: fans(200, 405) } });
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  await h.poll(h.io);
  h.state.live = [fixture('IN_PLAY', 1, 0)];
  await h.poll(h.io);
  assert.equal(h.notifications.length, 605);
  assert.equal(new Set(h.notifications.map(value => value.id)).size, 605);
  assert.ok(h.notifications.some(value => value.id === 'fan-0604'));
  for (const team of ['sc_t_a', 'sc_t_b']) {
    const reads = h.state.reads.filter(read => read.team === team);
    assert.deepEqual(reads.map(read => read.count), [200, 200, 5]);
    assert.equal(reads[0].cursor, null);
    assert.ok(reads[1].cursor && reads[2].cursor > reads[1].cursor);
  }
  assert.equal(h.state.peakReads, 2);
  assert.equal(h.state.peakNotifications, 4);
  const broadcast = h.emitted.filter(event => event.type === 'liveEvent');
  assert.equal(broadcast.length, 1);
  assert.deepEqual(broadcast[0].rooms, ['match:test-match', 'matchAlerts_test-match', 'team:sc_t_a', 'team:sc_t_b']);
  const personal = h.emitted.filter(event => event.type === 'notification');
  assert.equal(personal.length, 605);
  assert.ok(personal.every(event => event.excluded.includes('team:sc_t_a') && event.excluded.includes('team:sc_t_b')));
});

test('an exact full recipient page terminates on the next empty page', async () => {
  const ids = Array.from({ length: 200 }, (_, index) => `fan-${String(index).padStart(3, '0')}`);
  const h = harness({ usersByTeam: { sc_t_a: ids, sc_t_b: ids } });
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  await h.poll(h.io);
  h.state.live = [fixture('IN_PLAY', 1, 0)];
  await h.poll(h.io);
  assert.equal(h.notifications.length, 200);
  assert.deepEqual(h.state.reads.filter(read => read.team === 'sc_t_a').map(read => read.count), [200, 0]);
  assert.deepEqual(h.state.reads.filter(read => read.team === 'sc_t_b').map(read => read.count), [200, 0]);
});

test('same-name clubs do not share targeted rooms or notifications and away goals preserve both IDs', async () => {
  const h = harness({ usersByTeam: { sc_t_barcelona: ['chile-fan'], sc_t_fc_barcelona: ['spain-fan'],
    sc_t_b: ['opponent-fan'] } });
  const match = (home, away) => ({ ...fixture('IN_PLAY', home, away),
    homeTeam: { id: 'barcelona', name: 'Barcelona' } });
  h.state.live = [match(0, 0)];
  await h.poll(h.io);
  h.state.live = [match(0, 1)];
  await h.poll(h.io);
  const event = h.emitted.find(item => item.type === 'liveEvent');
  assert.equal(event.data.teamId, 'sc_t_b');
  assert.equal(event.data.againstTeamId, 'sc_t_barcelona');
  assert.deepEqual(new Set(h.notifications.map(item => item.id)), new Set(['chile-fan', 'opponent-fan']));
  assert.ok(event.rooms.includes('team:sc_t_barcelona'));
  assert.equal(event.rooms.includes('team:Barcelona'), false);
});

test('disappearance is not full time; confirmed detail can end a disappeared live match', async () => {
  const h = harness();
  h.state.live = [fixture('IN_PLAY', 2, 1)];
  await h.poll(h.io);
  h.state.live = [];
  await h.poll(h.io);
  assert.equal(h.emitted.length, 0);
  h.state.detail = fixture('FINISHED', 2, 1);
  await h.poll(h.io);
  await h.poll(h.io);
  assert.equal(h.state.detailsRead, 2);
  assert.deepEqual(h.persisted.map(e => e.type), ['matchEnd']);
});

test('a stale scheduled fixture does not erase an already observed live score baseline', async () => {
  const h = harness();
  h.state.fixtures = [fixture('TIMED')]; h.state.live = [fixture('IN_PLAY', 1, 0)];
  await h.poll(h.io);
  h.state.live = []; await h.poll(h.io);
  assert.equal(h.persisted.length, 0);
  h.state.live = [fixture('IN_PLAY', 2, 0)]; await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['goal']);
});

test('first sightings and historical incidents stay silent while real cancellations and new red cards reach fans', async () => {
  const h = harness();
  h.io.sockets.adapter.rooms.set('matchAlerts_test-match', new Set(['socket']));
  const oldCard = { type: 'red_card', minute: 15, player: 'Historical', side: 'home' };
  h.state.live = [fixture('IN_PLAY')];
  h.state.detail = { ...fixture('IN_PLAY'), timeline: [oldCard] };
  await h.poll(h.io);
  h.state.live = [fixture('IN_PLAY', 2, 1)];
  await h.poll(h.io);
  h.state.live = [fixture('IN_PLAY', 1, 1)];
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['goalCancelled']);
  const newCard = { type: 'red_card', minute: 60, player: 'New incident', side: 'away' };
  h.state.detail.timeline.push(newCard);
  await h.poll(h.io);
  await h.poll(h.io);
  assert.deepEqual(h.persisted.map(event => event.type), ['goalCancelled', 'card']);
  const red = h.emitted.find(event => event.type === 'liveEvent' && event.data.type === 'card');
  assert.equal(red.data.against, 'A');
  assert.equal(h.notifications.length, 2);
});

test('date-range requests are bounded to three concurrent calls and sorted by requested day', async () => {
  let active = 0; let peak = 0;
  const service = load('../services/sportsDataService', {
    '../utils/logger': logger,
    './sportscoreService': { getMatchesByDate: async date => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return [{ id: date, utcDate: date, competition: { code: 'PL' } }];
    } }
  });
  const result = await service.getCompetitionMatches('PL', '2026-09-21', '2026-09-27');
  assert.equal(peak, 3);
  assert.equal(result.data.length, 7);
  assert.deepEqual(result.data.map(m => m.id), [...result.data.map(m => m.id)].sort());
});

test('live provider outage differs from a successful empty live feed', async () => {
  let time = Date.now();
  const { createLiveSnapshotReader } = require('../services/liveSnapshotReader');
  let unavailable = false;
  const service = load('../services/sportsDataService', {
    '../utils/logger': logger,
    './liveSnapshotReader': { createLiveSnapshotReader: () => createLiveSnapshotReader({ now: () => time }) },
    './sportscoreService': { getLiveMatches: async () => { if (unavailable) throw Error('offline'); return []; } }
  });
  assert.equal((await service.getLiveMatches()).success, true);
  unavailable = true;
  time += 60001;
  assert.equal((await service.getLiveMatches()).statusCode, 503);
});

test('unavailable player data never returns invented ratings, values, or career totals', async () => {
  const controller = load('../controllers/statsController', {
    '../utils/logger': logger, '../services/sportscoreService': { getPlayerDetails: async () => null },
    '../services/sportsDataService': {}, '../services/kickoffApiService': { getPlayerDetails: async () => null },
    '../services/teamService': {}, '../services/cacheService': {}
  });
  const res = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await controller.getDeepPlayerDetails({ params: { id: 'unknown-test-player' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.source, 'unavailable');
  assert.equal(res.body.data, null);
  assert.equal(res.body.coverage.available, false);
});
