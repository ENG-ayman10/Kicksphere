const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const logger = { info() {}, warn() {}, error() {} };

function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(file); } finally { Module._load = original; }
}
const match = (status, home = null, away = null) => ({ id: 'bsd_212636', status, source: 'bsd',
  homeTeam: { id: 'bsd_t_467', provider: 'bsd', name: 'Germany' },
  awayTeam: { id: 'bsd_t_492', provider: 'bsd', name: 'Serbia' },
  score: { fullTime: { home, away } }, competition: { code: 'UNL', name: 'UEFA Nations League' } });

test('BSD observed transitions route to BSD club rooms and follow disappeared matches by their own ID', async () => {
  let fixture = match('TIMED'), live = null, detail = null;
  const emitted = [], favoriteQueries = [], detailIds = [];
  const io = { sockets: { adapter: { rooms: new Map() } }, to(rooms) {
    return { except() { return this; }, emit(type, data) { emitted.push({ rooms, type, data }); } };
  } };
  const db = { batch: () => ({ set() {}, async commit() {} }), collection: () => ({ doc: () => ({}),
    where(field, operator, id) {
      favoriteQueries.push(id);
      return { orderBy() { return this; }, limit() { return this; }, async get() { return { docs: [] }; } };
    } }) };
  const service = load('../services/liveEventsService', { '../config/firebase': db, '../utils/logger': logger,
    './notificationDeviceService': { getSubscribedMatchIds: async () => new Set(), findRecipients: async () => new Map() },
    './sportsDataService': {}, './bsdSportsService': { isConfigured: () => true }, './kickoffApiService': {},
    './notificationService': { saveNotification: async () => assert.fail('No recipients') },
    './pushNotificationService': { sendPushNotification: async () => assert.fail('No recipients') } });
  const poll = service.createLiveEventsEmitter({ provider: {
    getMatchesByDate: async () => ({ success: true, source: 'bsd', data: fixture ? [fixture] : [] }),
    getLiveMatches: async () => ({ success: true, source: 'bsd', data: live ? [live] : [] })
  }, getMatchDetails: async id => { detailIds.push(id); return detail; } });
  await poll(io);
  live = match('IN_PLAY', 0, 0); await poll(io);
  live = match('IN_PLAY', 1, 0); await poll(io);
  fixture = null; live = null; await poll(io);
  assert.equal(emitted.filter(e => e.type === 'liveEvent').length, 2, 'An empty snapshot cannot invent full time');
  detail = match('FINISHED', 1, 0); await poll(io);
  const events = emitted.filter(e => e.type === 'liveEvent');
  assert.deepEqual(events.map(e => e.data.type), ['matchStart', 'goal', 'matchEnd']);
  assert.deepEqual(events[1].rooms, ['match:bsd_212636', 'matchAlerts_bsd_212636', 'team:bsd_t_467', 'team:bsd_t_492']);
  assert.ok(favoriteQueries.every(id => /^bsd_t_/.test(id)));
  assert.deepEqual(detailIds, ['bsd_212636', 'bsd_212636']);
});

test('BSD personalized home selects the nearest same-provider fixtures without inventing live matches', async () => {
  const now = Date.now();
  const fixture = (id, time) => ({ id, utcDate: new Date(time).toISOString(), status: 'TIMED', source: 'bsd',
    homeTeam: { id: 'bsd_t_57', provider: 'bsd', name: 'Real Madrid' },
    awayTeam: { id: 'bsd_t_44', provider: 'bsd', name: 'Barcelona' } });
  const controller = load('../controllers/homeController', {
    '../config/firebase': { collection: () => ({ doc: () => ({ get: async () => ({ exists: true,
      data: () => ({ preferences: { teamIds: ['bsd_t_57'], teamsV2: [] } }) }) }) }) },
    '../services/bsdSportsService': { isConfigured: () => true, getTeamDetails: async id => {
      assert.equal(id, 'bsd_t_57');
      return { matches: { recent: [], upcoming: [fixture('bsd_3', now + 3 * 86400000), fixture('bsd_1', now + 86400000)] } };
    } },
    '../services/sportsDataService': { getMatchesByDate: async () => ({ success: true, source: 'bsd', data: [] }),
      getLiveMatches: async () => ({ success: true, source: 'bsd', data: [] }) },
    '../services/sportscoreService': { getTeamDetails: async () => assert.fail('No name fallback') },
    '../utils/auth': { isAdminUser: () => false }, '../utils/logger': logger
  });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await controller.getHome({ query: {}, user: { id: 'offline-bsd-fan' } }, res);
  assert.equal(res.body.source, 'bsd');
  assert.deepEqual(res.body.data.live, []);
  assert.deepEqual(res.body.data.recommended.map(m => m.id), ['bsd_1', 'bsd_3']);
});

test('verified alternate favorite selects one canonical home row while a namesake with mismatched IDs stays unrelated', async () => {
  const canonical = { id: 'bsd_209462', provider: 'bsd', source: 'bsd', status: 'FINISHED',
    utcDate: '2026-10-02T01:30:00Z', competition: { code: 'MLS' },
    homeTeam: { id: 'bsd_t_302', name: 'Seattle Sounders FC' },
    awayTeam: { id: 'bsd_t_299', name: 'Sporting Kansas City' }, providerIdentities: [
      { id: 'bsd_209462', provider: 'bsd', utcDate: '2026-10-02T01:30:00Z', competitionCode: 'MLS',
        homeTeamId: 'bsd_t_302', awayTeamId: 'bsd_t_299' },
      { id: 'original-seattle-match', provider: 'sportscore', utcDate: '2026-10-02T01:40:00Z', competitionCode: 'MLS',
        homeTeamId: 'sc_t_seattle-sounders', awayTeamId: 'sc_t_sporting-kansas-city' }
    ] };
  const unrelated = { ...canonical, id: 'bsd_999', homeTeam: { id: 'bsd_t_999', name: 'Seattle Sounders FC' } };
  const controller = load('../controllers/homeController', {
    '../config/firebase': { collection: () => ({ doc: () => ({ get: async () => ({ exists: true,
      data: () => ({ preferences: { teamIds: ['sc_t_seattle-sounders'] } }) }) }) }) },
    '../services/bsdSportsService': { isConfigured: () => true },
    '../services/sportsDataService': {
      getMatchesByDate: async () => ({ success: true, source: 'bsd+sportscore', data: [canonical, unrelated] }),
      getLiveMatches: async () => ({ success: true, source: 'bsd', data: [] })
    },
    '../services/sportscoreService': { getTeamDetails: async id => {
      assert.equal(id, 'seattle-sounders'); return { matches: { recent: [], upcoming: [] } };
    } }, '../utils/auth': { isAdminUser: () => false }, '../utils/logger': logger
  });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await controller.getHome({ query: {}, user: { id: 'offline-original-fan' } }, res);
  assert.deepEqual(res.body.data.recommended.map(row => row.id), ['bsd_209462']);
  assert.equal(res.body.data.recommended[0].homeTeam.id, 'bsd_t_302');
});

test('BSD detailed subscribers receive new incidents without replaying old or rescinded cards', async () => {
  const emitted = [], calls = [];
  let timeline = [{ id: 1, type: 'red_card', minute: 30, side: 'home', player: 'Earlier card' }];
  const rooms = new Map([['matchAlerts_bsd_212636', new Set(['subscriber'])]]);
  const io = { sockets: { adapter: { rooms } }, to(target) {
    return { emit(type, data) { emitted.push({ target, type, data }); } };
  } };
  const service = load('../services/liveEventsService', {
    './notificationDeviceService': { getSubscribedMatchIds: async () => new Set(), findRecipients: async () => new Map() },
    '../config/firebase': { batch: () => ({ set() {}, async commit() {} }) },
    '../utils/logger': logger,
    './sportsDataService': {
      getMatchesByDate: async () => ({ success: true, source: 'bsd', data: [match('IN_PLAY', 0, 0)] }),
      getLiveMatches: async () => ({ success: true, source: 'bsd', data: [] })
    },
    './bsdSportsService': { isConfigured: () => true,
      getMatchSummary: async id => { calls.push(['summary', id]); return match('IN_PLAY', 0, 0); },
      getMatchTimeline: async id => { calls.push(['timeline', id]); return timeline; } },
    './kickoffApiService': {}, './notificationService': {}, './pushNotificationService': {}
  });
  const poll = service.createLiveEventsEmitter();
  await poll(io);
  timeline = [...timeline, { id: 2, type: 'red_card', minute: 40, side: 'away', player: 'Withdrawn', rescinded: true },
    { id: 3, type: 'red_card', minute: 41, side: 'away', player: 'New card' }];
  await poll(io);
  await poll(io);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'detailedAlert');
  assert.equal(emitted[0].target, 'matchAlerts_bsd_212636');
  assert.equal(emitted[0].data.teamId, 'bsd_t_492');
  assert.equal(emitted[0].data.message, 'New card');
  rooms.clear();
  await poll(io);
  assert.equal(calls.filter(([type]) => type === 'timeline').length, 3,
    'Incidents are only requested for subscribers to detailed alerts');
});

test('live scoreboard uses BSD facade identities and never clears the stream on a provider outage', async () => {
  let snapshot = { success: true, source: 'bsd+sportscore', data: [match('IN_PLAY', 1, 0)] };
  const emitted = [];
  const service = load('../services/liveService', {
    './bsdSportsService': { isConfigured: () => true },
    './sportsDataService': { getLiveMatches: async () => snapshot },
    './sportscoreService': { getLiveMatches: async () => assert.fail('BSD snapshots must use the composite facade') },
    '../utils/logger': logger
  });
  const io = { emit(name, data) { emitted.push({ name, data }); } };
  await service.emitLiveMatches(io);
  snapshot = { success: false, source: 'unavailable', data: [], coverage: { available: false } };
  await service.emitLiveMatches(io);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].data[0].id, 'bsd_212636');
  snapshot = { success: true, source: 'bsd', data: [], coverage: { available: true, complete: false, partial: true } };
  await service.emitLiveMatches(io);
  assert.equal(emitted.length, 1, 'A partial empty feed must not clear the existing live scoreboard');
  snapshot = { success: true, source: 'bsd', data: [], coverage: { available: true, complete: true, partial: false } };
  await service.emitLiveMatches(io);
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted[1].data, []);
});
