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

function harness({ usersByTeam } = {}) {
  const state = { fixtures: [], live: [], detail: null, detailsRead: 0,
    reads: [], activeReads: 0, peakReads: 0, activeNotifications: 0, peakNotifications: 0 };
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
    batch: () => ({ set: (_, data) => persisted.push(data), commit: async () => {} }),
    collection: name => ({ doc: () => ({}), where(field, operator, team) {
      assert.equal(name, 'users');
      assert.equal(field, 'preferences.teams');
      assert.equal(operator, 'array-contains');
      return query(team);
    } })
  };
  const service = load('../services/liveEventsService', {
    '../config/firebase': db, '../utils/logger': logger,
    './sportscoreService': { getMatchesByDate: async () => state.fixtures, getLiveMatches: async () => state.live,
      getMatchDetails: async () => { state.detailsRead++; return state.detail; } },
    './notificationService': { saveNotification: async (id, data) => {
      state.peakNotifications = Math.max(state.peakNotifications, ++state.activeNotifications);
      await new Promise(resolve => setImmediate(resolve));
      state.activeNotifications--;
      notifications.push({ id, data });
    } },
    './pushNotificationService': { sendPushNotification: async () => assert.fail('No push token in offline fixture') }
  });
  return { state, io, emitted, persisted, notifications, poll: service.createLiveEventsEmitter() };
}

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
  assert.deepEqual(events[1].rooms, ['match:test-match', 'matchAlerts_test-match', 'team:A', 'team:B']);
  assert.equal(h.notifications.length, 2);
  assert.equal(h.persisted.length, 2);
  assert.ok(h.emitted.find(e => e.type === 'notification').excluded.includes('match:test-match'));
});

test('favorite audience spans every page with one notification per fan across teams', async () => {
  const fans = (first, count) => Array.from({ length: count }, (_, i) => `fan-${String(first + i).padStart(4, '0')}`);
  // Shared fans occur on different pages in the two team queries.
  const h = harness({ usersByTeam: { A: fans(0, 405), B: fans(200, 405) } });
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  await h.poll(h.io);
  h.state.live = [fixture('IN_PLAY', 1, 0)];
  await h.poll(h.io);
  assert.equal(h.notifications.length, 605);
  assert.equal(new Set(h.notifications.map(value => value.id)).size, 605);
  assert.ok(h.notifications.some(value => value.id === 'fan-0604'));
  for (const team of ['A', 'B']) {
    const reads = h.state.reads.filter(read => read.team === team);
    assert.deepEqual(reads.map(read => read.count), [200, 200, 5]);
    assert.equal(reads[0].cursor, null);
    assert.ok(reads[1].cursor && reads[2].cursor > reads[1].cursor);
  }
  assert.equal(h.state.peakReads, 2);
  assert.equal(h.state.peakNotifications, 4);
  const broadcast = h.emitted.filter(event => event.type === 'liveEvent');
  assert.equal(broadcast.length, 1);
  assert.deepEqual(broadcast[0].rooms, ['match:test-match', 'matchAlerts_test-match', 'team:A', 'team:B']);
  const personal = h.emitted.filter(event => event.type === 'notification');
  assert.equal(personal.length, 605);
  assert.ok(personal.every(event => event.excluded.includes('team:A') && event.excluded.includes('team:B')));
});

test('an exact full recipient page terminates on the next empty page', async () => {
  const ids = Array.from({ length: 200 }, (_, index) => `fan-${String(index).padStart(3, '0')}`);
  const h = harness({ usersByTeam: { A: ids, B: ids } });
  h.state.live = [fixture('IN_PLAY', 0, 0)];
  await h.poll(h.io);
  h.state.live = [fixture('IN_PLAY', 1, 0)];
  await h.poll(h.io);
  assert.equal(h.notifications.length, 200);
  assert.deepEqual(h.state.reads.filter(read => read.team === 'A').map(read => read.count), [200, 0]);
  assert.deepEqual(h.state.reads.filter(read => read.team === 'B').map(read => read.count), [200, 0]);
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

test('first sightings, missing scores, corrections, and historical incidents do not replay alerts', async () => {
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
  assert.equal(h.emitted.length, 0);
  const newCard = { type: 'red_card', minute: 60, player: 'New incident', side: 'away' };
  h.state.detail.timeline.push(newCard);
  await h.poll(h.io);
  await h.poll(h.io);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].type, 'detailedAlert');
  assert.equal(h.emitted[0].data.against, 'A');
  assert.equal(h.notifications.length, 0);
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
  let unavailable = false;
  const service = load('../services/sportsDataService', {
    '../utils/logger': logger,
    './sportscoreService': { getLiveMatches: async () => { if (unavailable) throw Error('offline'); return []; } }
  });
  assert.equal((await service.getLiveMatches()).success, true);
  unavailable = true;
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
  assert.equal(res.body.source, 'unavailable');
  assert.deepEqual(res.body.data.info, {});
  assert.deepEqual(res.body.data.seasonStats, {});
  assert.deepEqual(res.body.data.careerTotals, {});
});
