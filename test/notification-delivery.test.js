const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createServer } = require('node:http');

const logger = { info() {}, warn() {}, error() {} };
const token = n => `offline_fcm_token_${String(n).padStart(20, '0')}`;
const registration = (n, preferences = {}) => ({ token: token(n), platform: 'android', language: 'en', preferences });
const event = { eventId: 'evt_offline_goal', matchId: 'bsd_123', type: 'goal', provider: 'bsd',
  homeTeam: { id: 'bsd_t_57', name: 'Home' }, awayTeam: { id: 'bsd_t_44', name: 'Away' },
  team: 'Away', against: 'Home', teamId: 'bsd_t_44', againstTeamId: 'bsd_t_57', side: 'away',
  scoreValues: { home: 1, away: 2 }, score: '1 - 2', minute: 70, player: '', createdAt: new Date('2026-10-01T12:00:00Z') };

function aliasedEvent() {
  const { preferred, supplement } = structuredClone(require('./fixtures/provider-fixture-seattle-2026-10-02.json'));
  const { mergeProviderFixtures } = require('../utils/providerFixtureIdentity');
  const fixture = mergeProviderFixtures([preferred], [supplement])[0];
  return { ...event, ...fixture, matchId: fixture.id, eventId: 'evt_verified_alias',
    competitionCode: fixture.competition.code, score: '2 - 1', scoreValues: { home: 2, away: 1 },
    teamId: fixture.homeTeam.id, againstTeamId: fixture.awayTeam.id, side: 'home',
    createdAt: new Date('2026-10-02T12:00:00Z') };
}

function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}

function store() {
  const records = new Map();
  let queue = Promise.resolve();
  let peakReads = 0; let activeReads = 0;
  const fieldValue = (data, field) => field.split('.').reduce((value, key) => value?.[key], data);
  const reference = key => ({ key, id: key.split('/').at(-1), get: async () => snapshot(key),
    set: async (data, options) => records.set(key, options?.merge ? { ...records.get(key), ...data } : data),
    update: async data => records.set(key, { ...records.get(key), ...data }), delete: async () => records.delete(key) });
  const snapshot = key => ({ exists: records.has(key), id: key.split('/').at(-1), ref: reference(key), data: () => records.get(key) });
  const query = (name, filters = [], maximum = Infinity, after = '') => ({
    isQuery: true,
    where(field, operator, value) { return query(name, [...filters, { field, operator, value }], maximum, after); },
    orderBy(field) { assert.equal(field, '__name__'); return this; },
    limit(value) { return query(name, filters, value, after); },
    startAfter(document) { return query(name, filters, maximum, document.id); },
    async get() {
      peakReads = Math.max(peakReads, ++activeReads);
      await new Promise(resolve => setImmediate(resolve)); activeReads--;
      const docs = [...records].filter(([key, data]) => key.startsWith(`${name}/`) && key.split('/').length === 2 &&
        key.split('/')[1] > after && filters.every(({ field, operator, value }) => {
          const actual = fieldValue(data, field);
          return operator === 'array-contains' ? Array.isArray(actual) && actual.includes(value)
            : operator === 'array-contains-any' ? Array.isArray(actual) && actual.some(item => value.includes(item))
            : operator === '>=' ? actual >= value : actual === value;
        })).sort(([a], [b]) => a.localeCompare(b)).slice(0, maximum).map(([key]) => snapshot(key));
      return { docs, empty: docs.length === 0 };
    }
  });
  const database = { collection(name) { return { ...query(name), doc: id => reference(`${name}/${id}`) }; },
    runTransaction(action) {
      const work = queue.then(async () => {
        const writes = [];
        const result = await action({ get: async ref => {
          assert.equal(writes.length, 0, 'Firestore requires reads before writes');
          return ref.isQuery ? ref.get() : snapshot(ref.key);
        }, set: (ref, data, options) => writes.push(() => ref.set(data, options)),
        update: (ref, data) => writes.push(() => ref.update(data)), delete: ref => writes.push(() => ref.delete()) });
        for (const write of writes) await write();
        return result;
      }); queue = work.catch(() => {}); return work;
    }
  };
  return { records, database, peakReads: () => peakReads };
}

function harness(send, options = {}) {
  const f = store(); const sent = [];
  const push = load('../services/pushNotificationService', {
    'firebase-admin/messaging': { getMessaging: () => ({ send: async message => sent.push(message) }) },
    '../utils/logger': logger
  });
  const exports = load('../services/notificationDeviceService', {
    '../config/firebase': f.database, './pushNotificationService': push, '../utils/logger': logger
  });
  const service = exports.createNotificationDeviceService(f.database, { send: send || (async (...args) => {
    sent.push(args); return { sent: true };
  }), now: () => new Date('2026-10-02T12:00:00Z').getTime(), ...options });
  return { ...f, service, sent, push, deviceKey: exports.deviceKey };
}

test('local live scope excludes other accounts from subscriptions and delivery', async () => {
  const f = harness(undefined, { recipientAllowed: id => id === 'u1' });
  await f.service.register('u1', 'install_1', registration(1, { teamIds: ['bsd_t_57'], matchIds: ['bsd_123'] }));
  await f.service.register('u2', 'install_2', registration(2, { teamIds: ['bsd_t_57'], matchIds: ['bsd_124'] }));
  const recipients = await f.service.findRecipients([event]);
  assert.deepEqual([...recipients.values()].map(row => row.userId), ['u1']);
  assert.deepEqual([...(await f.service.getSubscribedMatchIds(['bsd_123', 'bsd_124']))], ['bsd_123']);
  const other = f.records.get(`notificationDevices/${f.deviceKey('u2', 'install_2')}`);
  assert.deepEqual(await f.service.deliver(other, event), { sent: false, suppressed: true });
  assert.equal(f.sent.length, 0);
  assert.equal((await f.service.deliver([...recipients.values()][0], event)).sent, true);
  assert.equal(f.sent.length, 1);
});

test('a restricted pending retry cannot send after its account leaves scope', async () => {
  let allowed = true;
  let time = Date.parse('2026-10-01T12:00:00Z');
  let sends = 0;
  const f = harness(async () => { sends++; return { sent: false, retryable: true }; }, {
    recipientAllowed: () => allowed, now: () => time,
  });
  await f.service.register('u1', 'install_1', registration(1, { matchIds: ['bsd_123'] }));
  const device = f.records.get(`notificationDevices/${f.deviceKey('u1', 'install_1')}`);
  await f.service.deliver(device, event);
  assert.equal(sends, 1);
  allowed = false;
  time += 30001;
  const result = await f.service.flushRetries();
  assert.equal(result.attempted, 1);
  assert.equal(result.queued, 0);
  assert.equal(sends, 1);
});

test('installation registration validates bounded opaque IDs, metadata, booleans and token input', async () => {
  const f = harness();
  for (const body of [registration(1, { sound: 'true' }), registration(1, { teamIds: ['Arsenal'] }),
    registration(1, { matchIds: ['123'] }), registration(1, { matchIds: ['bsd_0'] }),
    registration(1, { matchIds: ['ko_t_57'] }), registration(1, { matchIds: ['sc_t_57'] }), registration(1, { matchIds: Array(101).fill('bsd_123') }),
    { ...registration(1), token: 'bad token' }, { ...registration(1), token: 'x'.repeat(4097) },
    { ...registration(1), platform: 'invented' }, { ...registration(1), language: 'invented' }]) {
    await assert.rejects(f.service.register('u1', 'install_1', body), error => error.statusCode === 400);
  }
  await assert.rejects(f.service.register('u1', '../unsafe', registration(1)), error => error.statusCode === 400);
  assert.equal(f.records.size, 0);
  const result = await f.service.register('u1', 'install_1', registration(1, { teamIds: ['bsd_t_57', 'bsd_t_57'], matchIds: ['bsd_123'] }));
  assert.deepEqual(result, { deviceId: 'install_1', registered: true });
  assert.equal(JSON.stringify(result).includes(token(1)), false);
  const stored = f.records.get(`notificationDevices/${f.deviceKey('u1', 'install_1')}`);
  assert.deepEqual(stored.preferences.teamIds, ['bsd_t_57']);
  assert.equal(stored.preferences.sound, true);
  assert.equal(f.records.get('users/u1').fcmToken, null);
});

test('FCM invalid token errors are classified without logging token-bearing server messages', async () => {
  const logs = []; let invalidToken = true;
  const push = load('../services/pushNotificationService', {
    'firebase-admin/messaging': { getMessaging: () => ({ send: async () => {
      throw Object.assign(new Error(invalidToken ? `The registration token is not a valid FCM registration token: ${token(1)}`
        : `Invalid payload containing private token ${token(1)}`), { code: 'messaging/invalid-argument' });
    } }) }, '../utils/logger': { warn: message => logs.push(message) }
  });
  assert.equal((await push.sendPushNotification(token(1), 'Test', 'Body', { event })).invalidToken, true);
  invalidToken = false;
  assert.equal((await push.sendPushNotification(token(1), 'Test', 'Body', { event })).invalidToken, false);
  assert.equal(logs.some(message => message.includes(token(1))), false);
});

test('multiple devices receive once each with their own preferences and durable match bells', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration(1, { teamIds: ['bsd_t_57'], sound: false }));
  await f.service.register('u1', 'install_2', registration(2, { matchIds: ['bsd_123'], favoritesOnly: true, vibration: false }));
  await f.service.register('u1', 'install_3', registration(3, { teamIds: ['bsd_t_57'], matchIds: ['bsd_123'], hideScores: true }));
  await f.service.register('u2', 'install_4', registration(4, { teamIds: ['ko_t_57'] }));
  const recipients = await f.service.findRecipients([event, event]);
  assert.equal(recipients.size, 2);
  for (const device of recipients.values()) {
    assert.equal(device.events.size, 1);
    await f.service.deliver(device, event);
  }
  assert.deepEqual(new Set(f.sent.map(args => args[0])), new Set([token(1), token(2)]));
  assert.equal(f.sent.find(args => args[0] === token(1))[3].preferences.sound, false);
  assert.equal(f.sent.find(args => args[0] === token(2))[3].preferences.vibration, false);
  const oldVisibleRegistration = [...recipients.values()].find(device => device.deviceId === 'install_1');
  await f.service.register('u1', 'install_1', registration(1, { teamIds: ['bsd_t_57'], hideScores: true }));
  assert.equal((await f.service.deliver(oldVisibleRegistration,
    { ...event, eventId: `${event.eventId}:next`, score: '2 - 0' })).suppressed, true);
  assert.equal(f.sent.length, 2, 'Preferences are reread before sending a queued event');
  assert.deepEqual([...await f.service.getSubscribedMatchIds(['bsd_123', 'ko_123'])], ['bsd_123']);
  const detailed = { ...event, type: 'card', isDetailed: true, cardType: 'red' };
  assert.equal((await f.service.findRecipients([detailed])).size, 1);
  const hidden = f.records.get(`notificationDevices/${f.deviceKey('u1', 'install_3')}`);
  assert.equal((await f.service.deliver(hidden, event)).suppressed, true);
});

test('token ownership prevents another installation from claiming a token and same installation can switch accounts', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration(1));
  await assert.rejects(f.service.register('u2', 'install_2', registration(1)), error => error.statusCode === 409);
  assert.equal(await f.service.revoke('u2', 'install_1'), false);
  assert.ok(f.records.has(`notificationDevices/${f.deviceKey('u1', 'install_1')}`));
  await f.service.register('u2', 'install_1', registration(1));
  assert.equal(f.records.has(`notificationDevices/${f.deviceKey('u1', 'install_1')}`), false);
  assert.ok(f.records.has(`notificationDevices/${f.deviceKey('u2', 'install_1')}`));
  assert.equal(await f.service.revoke('u1', 'install_1'), false);
});

test('invalid tokens are removed while a just-rotated token survives an old failed delivery', async () => {
  let rotate = false; let f;
  f = harness(async () => {
    if (rotate) await f.service.register('u1', 'install_1', registration(2, { matchIds: ['bsd_123'] }));
    return { sent: false, invalidToken: true };
  });
  await f.service.register('u1', 'install_1', registration(1, { matchIds: ['bsd_123'] }));
  let device = [...(await f.service.findRecipients([event])).values()][0];
  await f.service.deliver(device, event);
  assert.equal([...f.records.keys()].filter(key => key.startsWith('notificationDevices/') || key.startsWith('notificationTokens/')).length, 0);
  await f.service.register('u1', 'install_1', registration(1, { matchIds: ['bsd_123'] }));
  device = [...(await f.service.findRecipients([event])).values()][0]; rotate = true;
  await f.service.deliver(device, event);
  assert.equal(f.records.get(`notificationDevices/${f.deviceKey('u1', 'install_1')}`).token, token(2));
});

test('recipient pagination covers every installation with at most three concurrent queries and expires stale installations', async () => {
  const f = harness();
  for (let i = 0; i < 405; i++) f.records.set(`notificationDevices/device_${String(i).padStart(4, '0')}`, {
    userId: `u${i}`, deviceId: `install_${i}`, token: token(i), lastSeenAt: new Date('2026-10-02T12:00:00Z'),
    preferences: { teamIds: ['bsd_t_57'], matchIds: ['bsd_123'] }
  });
  f.records.set('notificationDevices/stale', { userId: 'stale', token: token(999), lastSeenAt: new Date(0),
    preferences: { teamIds: ['bsd_t_57'] } });
  const recipients = await f.service.findRecipients([event]);
  assert.equal(recipients.size, 405);
  assert.equal(recipients.has('stale'), false);
  assert.ok(f.peakReads() <= 3);
});

test('installation cap is transactionally enforced and updating an existing installation is allowed', async () => {
  const f = harness();
  for (let i = 0; i < 10; i++) await f.service.register('u1', `install_${i}`, registration(i));
  await assert.rejects(f.service.register('u1', 'install_10', registration(10)), error => error.statusCode === 409);
  await f.service.register('u1', 'install_0', registration(11));
  assert.equal([...f.records.keys()].filter(key => key.startsWith('notificationDevices/')).length, 10);
});

test('durable inbox deduplication preserves read state for the same stable event', async () => {
  const f = store();
  const originalCollection = f.database.collection;
  f.database.collection = name => {
    const collection = originalCollection(name);
    if (name !== 'users') return collection;
    return { ...collection, doc: userId => ({ collection: child => ({ doc: id =>
      originalCollection(`users/${userId}/${child}`).doc(id) }) }) };
  };
  const service = load('../services/notificationService', { '../config/firebase': f.database });
  const first = await service.saveNotification('u1', event);
  assert.equal(first.duplicate, false);
  const key = [...f.records.keys()][0]; f.records.set(key, { ...f.records.get(key), isRead: true });
  const duplicate = await service.saveNotification('u1', event);
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.isRead, true);
  assert.equal(f.records.size, 1);
});

test('FCM payload preserves navigation, side and structured scores without requiring a connected socket', async () => {
  const f = harness();
  const message = f.push.buildPushMessage(token(1), 'Goal', 'Home vs Away — 1 - 2', { event, recipientUserId: 'u1', preferences: { sound: false, vibration: false } });
  assert.equal(message.data.matchId, 'bsd_123');
  assert.equal(message.data.recipientUserId, 'u1');
  assert.equal(JSON.parse(message.data.event).recipientUserId, undefined);
  assert.equal(message.data.eventId, event.eventId);
  assert.equal(message.data.emittedAt, String(event.createdAt.getTime()));
  assert.equal(message.android.notification.channelId, 'match_events_goal_s0_v0');
  assert.equal(message.android.notification.tag, event.eventId);
  assert.equal(message.android.notification.defaultSound, undefined);
  assert.equal(message.apns.payload.aps.sound, undefined);
  const payload = JSON.parse(message.data.event);
  assert.equal(payload.side, 'away');
  assert.deepEqual(payload.homeTeam, { id: 'bsd_t_57', name: 'Home' });
  assert.deepEqual(payload.score, { home: 1, away: 2 });
  assert.equal(payload.player, '');
  assert.ok(Object.values(message.data).every(value => typeof value === 'string'));
  const unknownHome = f.push.buildPushMessage(token(1), 'Goal', 'Body', {
    event: { ...event, homeTeam: { id: null, name: '' }, homeTeamId: null }
  });
  assert.equal(JSON.parse(unknownHome.data.event).homeTeam.id, '', 'Unknown home team cannot borrow the away scorer identity');
  const suppressed = await f.push.sendPushNotification(token(1), 'Goal', 'spoiler', { event, preferences: { hideScores: true } });
  assert.equal(suppressed.suppressed, true);
  assert.equal(f.sent.length, 0);
});

test('FCM event and scalar data preserve the actual UTC provider clock separately from emission time', () => {
  const f = harness();
  const createdAt = new Date('2026-10-02T12:02:00Z');
  const sourceTime = '2026-10-02T15:00:30+03:00';
  const message = f.push.buildPushMessage(token(1), 'Goal', 'Body', {
    event: { ...event, createdAt, lastUpdated: sourceTime } });
  const payload = JSON.parse(message.data.event);
  assert.equal(payload.lastUpdated, '2026-10-02T12:00:30.000Z');
  assert.equal(message.data.lastUpdated, payload.lastUpdated);
  assert.equal(payload.emittedAt, createdAt.getTime());
  assert.notEqual(Date.parse(payload.lastUpdated), payload.emittedAt);
  for (const lastUpdated of [undefined, null, '', 1780400000000, new Date(sourceTime), 'not-a-time',
    '2026-10-02T12:00:00', '2026-02-30T12:00:00Z', '2026-10-02T24:00:00Z', '2026-10-02T12:00:00+99:00']) {
    const invalid = f.push.buildPushMessage(token(1), 'Goal', 'Body', { event: { ...event, createdAt, lastUpdated } });
    assert.equal(Object.hasOwn(invalid.data, 'lastUpdated'), false);
    assert.equal(Object.hasOwn(JSON.parse(invalid.data.event), 'lastUpdated'), false);
  }
});

test('explicit system test sends a genuine test with no invented match and enforces its device rate limit', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration(1, { hideScores: true }));
  const result = await f.service.testDevice('u1', 'install_1');
  assert.deepEqual(result, { sent: true, invalidToken: false, eventId: f.sent[0][3].event.eventId });
  const message = f.push.buildPushMessage(...f.sent[0]);
  assert.equal(result.eventId, message.data.eventId);
  assert.equal(result.eventId, JSON.parse(message.data.event).eventId);
  assert.match(result.eventId, /^test_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(result).includes(token(1)), false, 'Test responses must not expose the FCM token');
  assert.doesNotMatch(result.eventId, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'The receipt identifier is not a JWT');
  assert.equal(f.sent[0][3].event.type, 'systemTest');
  assert.equal(f.sent[0][3].event.matchId, undefined);
  assert.equal(f.sent[0][3].recipientUserId, 'u1');
  await f.service.register('u1', 'install_1', registration(1, { hideScores: true }));
  await assert.rejects(f.service.testDevice('u1', 'install_1'), error => error.statusCode === 429);
  await assert.rejects(f.service.testDevice('u2', 'install_1'), error => error.statusCode === 404);
});

test('FCM payload stays within the service byte budget for multilingual provider metadata and passes SDK validation', () => {
  const f = harness();
  const fullEvent = { ...event, eventId: 'evt_' + 'a'.repeat(64), matchId: 'a'.repeat(120),
    homeTeam: { id: 'sc_t_' + 'a'.repeat(115), name: '⚽'.repeat(160) },
    awayTeam: { id: 'sc_t_' + 'b'.repeat(115), name: '⚽'.repeat(160) },
    team: '⚽'.repeat(160), against: '⚽'.repeat(160), player: '⚽'.repeat(160), tournament: '⚽'.repeat(160),
    teamId: 'sc_t_' + 'a'.repeat(115), againstTeamId: 'sc_t_' + 'b'.repeat(115) };
  const message = f.push.buildPushMessage(token(1), '⚽'.repeat(160), '⚽'.repeat(500), { event: fullEvent, recipientUserId: 'u1' });
  assert.ok(Buffer.byteLength(JSON.stringify({ notification: message.notification, data: message.data }), 'utf8') < 3800);
  assert.equal(message.data.matchId, fullEvent.matchId);
  assert.equal(JSON.parse(message.data.event).teamId, fullEvent.teamId);
  const path = require('node:path');
  const { validateMessage } = require(path.join(path.dirname(require.resolve('firebase-admin/messaging')), 'messaging-internal.js'));
  assert.doesNotThrow(() => validateMessage(structuredClone(message)));
});

test('verified alternatives select an old bell and both club favorites exactly once per installation', async () => {
  const f = harness(); const current = aliasedEvent();
  const old = current.providerIdentities[1];
  await f.service.register('u1', 'install_1', registration(1, { matchIds: [old.id, current.matchId], teamIds: [old.homeTeamId, old.awayTeamId] }));
  await f.service.register('u2', 'install_2', registration(2, { teamIds: [old.homeTeamId, old.awayTeamId] }));
  await f.service.register('u3', 'install_3', registration(3, { matchIds: [old.id], hideScores: true }));
  await f.service.register('u4', 'install_4', registration(4, { teamIds: ['sc_t_seattle-other'] }));
  const recipients = await f.service.findRecipients([current, current]);
  assert.deepEqual([...recipients.values()].map(row => row.userId).sort(), ['u1', 'u2']);
  assert.ok([...recipients.values()].every(row => row.events.size === 1));
  for (const row of recipients.values()) {
    assert.equal((await f.service.deliver(row, current)).sent, true);
    assert.equal((await f.service.deliver(row, current)).duplicate, true);
  }
  assert.equal(f.sent.length, 2);
  const detailed = { ...current, eventId: 'evt_verified_card', type: 'card', isDetailed: true };
  assert.deepEqual([...(await f.service.findRecipients([detailed])).values()].map(row => row.userId), ['u1']);
  const broken = { ...current, homeTeam: { ...current.homeTeam, id: 'bsd_t_999' } };
  const unmatched = await f.service.findRecipients([broken]);
  assert.deepEqual([...unmatched.values()].map(row => row.userId), ['u1'], 'Only its stored canonical bell can match invalid provenance');
  assert.ok(f.peakReads() <= 3);
});

test('FCM retains verified fixture alternatives and native navigation under maximum IDs and multibyte display text', () => {
  const f = harness();
  for (const count of [2, 3]) {
    const current = aliasedEvent();
    current.utcDate = '2026-10-02T01:30:00.000Z';
    current.providerIdentities[1] = { id: 'a'.repeat(120), provider: 'sportscore', utcDate: current.utcDate, competitionCode: 'MLS',
      homeTeamId: 'sc_t_' + 'a'.repeat(115), awayTeamId: 'sc_t_' + 'b'.repeat(115) };
    if (count === 3) current.providerIdentities.push({ id: 'ko_' + '1'.repeat(117), provider: 'kickoffapi', utcDate: current.utcDate,
      competitionCode: 'MLS', homeTeamId: 'ko_t_' + '1'.repeat(115), awayTeamId: 'ko_t_' + '2'.repeat(115) });
    current.homeTeam.name = '⚽'.repeat(160); current.awayTeam.name = 'ع'.repeat(160);
    for (const field of ['team', 'against', 'player', 'tournament']) current[field] = '⚽'.repeat(160);
    const message = f.push.buildPushMessage(token(1), '⚽'.repeat(160), '⚽'.repeat(500), { event: current, recipientUserId: 'u'.repeat(128) });
    const payload = JSON.parse(message.data.event);
    assert.deepEqual(payload.providerIdentities, current.providerIdentities);
    assert.equal(payload.matchId, current.matchId); assert.equal(payload.homeTeam.id, current.homeTeam.id);
    assert.equal(payload.awayTeam.id, current.awayTeam.id); assert.deepEqual(payload.score, { home: 2, away: 1 });
    assert.equal(payload.utcDate, current.utcDate); assert.equal(payload.competitionCode, 'MLS');
    assert.ok(Buffer.byteLength(JSON.stringify({ notification: message.notification, data: message.data }), 'utf8') < 4096);
    const path = require('node:path');
    const { validateMessage } = require(path.join(path.dirname(require.resolve('firebase-admin/messaging')), 'messaging-internal.js'));
    assert.doesNotThrow(() => validateMessage(structuredClone(message)));
  }
  const invalid = aliasedEvent(); invalid.providerIdentities[0].id = 'bsd_999';
  assert.equal(JSON.parse(f.push.buildPushMessage(token(1), 'Goal', 'Body', { event: invalid }).data.event).providerIdentities, undefined);
});

test('live emitter pushes to every subscribed installation while a socket is active and reads offline match timelines without historical replay', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration(1, { matchIds: ['bsd_123'] }));
  await f.service.register('u1', 'install_2', registration(2, { teamIds: ['bsd_t_57'] }));
  const emitted = []; const saved = []; const detailReads = [];
  const rooms = new Map([['user:u1', new Set(['other-device-socket'])]]);
  const io = { sockets: { adapter: { rooms } }, to(target) {
    return { except() { return this; }, emit(type, data) { emitted.push({ target, type, data }); } };
  } };
  let goals = 0;
  let failInbox = false;
  let timeline = [{ id: 'old', type: 'red_card', side: 'home', player: 'Earlier player', minute: 15 }];
  const match = () => ({ id: 'bsd_123', source: 'bsd', status: 'IN_PLAY', homeTeam: event.homeTeam,
    awayTeam: event.awayTeam, score: { fullTime: { home: goals, away: 0 } }, minute: 70 });
  const database = { ...f.database, batch: () => ({ set() {}, commit: async () => {} }) };
  const live = load('../services/liveEventsService', {
    '../config/firebase': database, '../utils/logger': logger, './notificationDeviceService': f.service,
    './notificationService': { saveNotification: async (userId, data) => {
      saved.push({ userId, data }); if (failInbox) throw new Error('Offline inbox store');
    } },
    './sportscoreService': {}, './sportsDataService': {}, './bsdSportsService': { isConfigured: () => false }, './kickoffApiService': {}
  });
  const poll = live.createLiveEventsEmitter({ notificationDevices: f.service,
    provider: { getMatchesByDate: async () => [match()], getLiveMatches: async () => [] },
    getMatchDetails: async (id, options) => { detailReads.push({ id, ...options }); return { ...match(), timeline }; } });
  await poll(io); assert.equal(f.sent.length, 0); assert.equal(emitted.length, 0);
  goals = 1; timeline = [...timeline, { id: 'new', type: 'red_card', side: 'away', player: 'New player', minute: 70 }];
  await poll(io); await poll(io);
  assert.ok(detailReads.every(row => row.id === 'bsd_123' && row.includeTimeline));
  assert.equal(f.sent.length, 3, 'Both installations receive the goal; only the match bell receives the card');
  assert.equal(saved.length, 2, 'Inbox saves once per event for this user');
  assert.equal(new Set(f.sent.map(args => args[3].event.eventId)).size, 2);
  assert.ok(f.sent.every(args => emitted.some(row => row.data.eventId === args[3].event.eventId)));
  const card = f.sent.find(args => args[3].event.type === 'card')[3].event;
  assert.equal(card.cardType, 'red'); assert.equal(card.homeTeamId, 'bsd_t_57'); assert.equal(card.awayTeamId, 'bsd_t_44');
  assert.equal(card.player, 'New player');
  failInbox = true; goals = 2; await poll(io);
  assert.equal(f.sent.length, 5, 'An inbox persistence outage cannot suppress either installation push');
});

test('test HTTP controller returns failure when FCM does not accept the message', async () => {
  const controller = load('../controllers/notificationDeviceController', {
    '../services/notificationDeviceService': { testDevice: async () => ({ sent: false, invalidToken: true }) }, '../utils/logger': logger
  });
  const response = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await controller.testDevice({ params: { userId: 'u1', deviceId: 'install_1' }, user: { id: 'u1' } }, response);
  assert.equal(response.statusCode, 502); assert.equal(response.body.success, false); assert.equal(response.body.data.sent, false);
});

test('device HTTP routes reject missing auth and cross-user admin claims before persistence', async t => {
  const f = harness();
  const controller = load('../controllers/notificationDeviceController', { '../services/notificationDeviceService': f.service, '../utils/logger': logger });
  const auth = load('../middlewares/authMiddleware', { '../utils/logger': logger, '../utils/auth': {
    verifyAuthToken: async value => {
      if (!['own', 'admin'].includes(value)) throw new Error('Invalid session');
      return { id: value === 'own' ? 'u1' : 'admin', role: value === 'admin' ? 'admin' : 'user' };
    }
  } });
  const pass = (req, res, next) => next();
  const noop = (req, res) => res.json({ success: true });
  const router = load('../routes/userRoutes', {
    '../controllers/notificationDeviceController': controller,
    '../middlewares/authMiddleware': auth,
    '../middlewares/authorization': { requireSelfOrAdmin: () => pass },
    '../controllers/userController': Object.fromEntries(['savePreferences', 'getPreferences', 'addFavorite', 'getFavorites', 'removeFavorite', 'uploadAvatar'].map(name => [name, noop])),
    '../middlewares/uploadMiddleware': { single: () => pass }
  });
  const express = require('express'); const app = express(); app.use(express.json()); app.use('/api/users', router);
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/users/u1/notification-devices/install_1`;
  const call = async (method, auth) => fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    ...(method === 'PUT' ? { body: JSON.stringify(registration(1)) } : {}) });
  assert.equal((await call('PUT')).status, 401);
  assert.equal((await call('PUT', 'invalid')).status, 403);
  assert.equal((await call('PUT', 'admin')).status, 403);
  assert.equal((await call('DELETE', 'admin')).status, 403);
  assert.equal(f.records.size, 0);
  const registered = await call('PUT', 'own'); assert.equal(registered.status, 200);
  const registeredBody = await registered.json();
  assert.equal(JSON.stringify(registeredBody).includes(token(1)), false);
  assert.equal(typeof registeredBody.automaticEventsEnabled, 'boolean');
  assert.equal((await call('DELETE', 'own')).status, 200);
});

test('temporary FCM failures retry once due, reread current registration, and never resend after acceptance', async () => {
  let time = new Date('2026-10-02T12:00:00Z').getTime(); let calls = 0;
  const sentTokens = [];
  const f = harness(async currentToken => {
    sentTokens.push(currentToken); calls++;
    return calls === 1 ? { sent: false, retryable: true, errorCode: 'messaging/server-unavailable' } : { sent: true };
  }, { now: () => time });
  await f.service.register('u1', 'install_1', registration(1, { matchIds: ['bsd_123'] }));
  const currentEvent = { ...event, createdAt: new Date(time) };
  const device = [...(await f.service.findRecipients([currentEvent])).values()][0];
  assert.equal((await f.service.deliver(device, currentEvent)).sent, false);
  assert.deepEqual(await f.service.flushRetries(), { attempted: 0, queued: 1 });
  await f.service.register('u1', 'install_1', registration(2, { matchIds: ['bsd_123'] }));
  time += 30000;
  assert.deepEqual(await f.service.flushRetries(), { attempted: 1, queued: 0 });
  assert.deepEqual(sentTokens, [token(1), token(2)]);
  assert.equal((await f.service.deliver(device, currentEvent)).duplicate, true);
  time += 60000; assert.deepEqual(await f.service.flushRetries(), { attempted: 0, queued: 0 });
  assert.equal(calls, 2);
});

test('retry cancellation honors changed spoiler preferences, revoked ownership, invalid tokens and expiry', async () => {
  for (const mode of ['hidden', 'revoked', 'invalid', 'expired']) {
    let time = new Date('2026-10-02T12:00:00Z').getTime(); let calls = 0;
    const f = harness(async () => { calls++; return mode === 'invalid'
      ? { sent: false, invalidToken: true, retryable: false } : { sent: false, retryable: true }; }, { now: () => time });
    await f.service.register('u1', 'install_1', registration(1, { matchIds: ['bsd_123'] }));
    const currentEvent = { ...event, createdAt: new Date(time) };
    const device = [...(await f.service.findRecipients([currentEvent])).values()][0];
    await f.service.deliver(device, currentEvent);
    if (mode === 'hidden') await f.service.register('u1', 'install_1', registration(1, { matchIds: ['bsd_123'], hideScores: true }));
    if (mode === 'revoked') await f.service.register('u2', 'install_1', registration(1, { matchIds: ['bsd_123'] }));
    time += mode === 'expired' ? 300001 : 30000;
    const retry = await f.service.flushRetries(); assert.equal(retry.queued, 0, mode); assert.equal(calls, 1, mode);
  }
});

test('transient retries stop after three backoff attempts and the queue remains bounded', async () => {
  let time = new Date('2026-10-02T12:00:00Z').getTime(); let calls = 0;
  const f = harness(async () => { calls++; return { sent: false, retryable: true }; }, { now: () => time, retryQueueLimit: 3 });
  await f.service.register('u1', 'install_1', registration(1, { matchIds: ['bsd_123'] }));
  const currentEvent = { ...event, createdAt: new Date(time) };
  const device = [...(await f.service.findRecipients([currentEvent])).values()][0];
  await f.service.deliver(device, currentEvent);
  for (const delay of [30000, 60000, 120000]) { time += delay; await f.service.flushRetries(); }
  assert.equal(calls, 4); assert.equal((await f.service.flushRetries()).queued, 0);
  for (let i = 0; i < 5; i++) await f.service.deliver(device, { ...currentEvent, eventId: `new-${i}`, createdAt: new Date(time) });
  assert.equal((await f.service.flushRetries()).queued, 3);
});
