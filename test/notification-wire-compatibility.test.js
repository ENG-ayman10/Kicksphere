'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { validateMessage } = require(path.join(path.dirname(require.resolve('firebase-admin/messaging')), 'messaging-internal.js'));

const token = 'offline_notification_protocol_token_1234567890';
const legacyTypes = new Set(['goal', 'matchStart', 'matchEnd', 'card', 'lineup',
  'substitution', 'var', 'penalty', 'detailed']);
const extendedTypes = ['matchReminder', 'goalCancelled', 'scoreCorrection', 'halfTime',
  'secondHalfStart', 'extraTimeStart', 'penaltyShootout', 'matchPostponed', 'matchCancelled'];
const registration = preferences => ({ token, platform: 'android', language: 'en',
  preferences: { matchIds: ['bsd_123'], ...preferences } });
const event = (type, eventId = `offline_${type}`, time = Date.now()) => ({
  type, eventId, matchId: 'bsd_123', provider: 'bsd', createdAt: new Date(time),
  homeTeam: { id: 'bsd_t_57', name: 'Home' }, awayTeam: { id: 'bsd_t_44', name: 'Away' },
  scoreValues: { home: 1, away: 0 }, previousScore: { home: 2, away: 0 },
  utcDate: new Date(time + 15 * 60000).toISOString(), reminderMinutes: 15,
  phase: 'SECOND_HALF', lineupConfirmed: true,
});
const logger = { warn() {}, info() {}, error() {} };

function load(file, mocks = {}) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(file); } finally { Module._load = original; }
}

function databaseFixture() {
  const records = new Map();
  let barrier = Promise.resolve();
  const valueAt = (row, field) => field.split('.').reduce((value, part) => value?.[part], row);
  const reference = key => ({ key, id: key.split('/').at(-1), get: async () => snapshot(key),
    set: async (value, options) => records.set(key, options?.merge ? { ...records.get(key), ...value } : value),
    update: async value => records.set(key, { ...records.get(key), ...value }),
    delete: async () => records.delete(key) });
  const snapshot = key => ({ exists: records.has(key), id: key.split('/').at(-1),
    ref: reference(key), data: () => records.get(key) });
  function query(name, filters = [], maximum = Infinity, after = '') {
    return { isQuery: true,
      where(field, operator, value) { return query(name, [...filters, [field, operator, value]], maximum, after); },
      orderBy(field) { assert.equal(field, '__name__'); return this; },
      limit(value) { return query(name, filters, value, after); },
      startAfter(document) { return query(name, filters, maximum, document.id); },
      async get() {
        const docs = [...records].filter(([key, row]) => key.startsWith(`${name}/`) && key.split('/').length === 2 &&
          key.split('/')[1] > after && filters.every(([field, operator, value]) => {
            const actual = valueAt(row, field);
            if (operator === '<=') return actual <= value;
            if (operator === 'array-contains') return actual?.includes(value);
            if (operator === 'array-contains-any') return actual?.some(item => value.includes(item));
            return actual === value;
          })).sort(([left], [right]) => left.localeCompare(right)).slice(0, maximum).map(([key]) => snapshot(key));
        return { docs, empty: docs.length === 0 };
      }
    };
  }
  const database = { collection: name => ({ ...query(name), doc: id => reference(`${name}/${id}`) }),
    runTransaction(operation) {
      const work = barrier.then(async () => {
        const writes = [];
        const result = await operation({ get: async ref => {
          assert.equal(writes.length, 0);
          return ref.isQuery ? ref.get() : snapshot(ref.key);
        }, set: (ref, value, options) => writes.push(() => ref.set(value, options)),
        update: (ref, value) => writes.push(() => ref.update(value)),
        delete: ref => writes.push(() => ref.delete()) });
        for (const write of writes) await write();
        return result;
      });
      barrier = work.catch(() => {});
      return work;
    }
  };
  return { database, records };
}

function harness(sendResult = () => ({ sent: true })) {
  const fixture = databaseFixture();
  let time = Date.now();
  const messages = [];
  const push = load('../services/pushNotificationService', { '../utils/logger': logger,
    'firebase-admin/messaging': { getMessaging: () => ({ send: async () => {
      throw new Error('Real messaging must never be invoked by protocol tests.');
    } }) } });
  const exports = load('../services/notificationDeviceService', { '../config/firebase': fixture.database,
    '../utils/logger': logger, './pushNotificationService': push });
  const create = () => exports.createNotificationDeviceService(fixture.database, {
    recipientAllowed: () => true, now: () => time,
    send: async (currentToken, title, body, options) => {
      messages.push(push.buildPushMessage(currentToken, title, body, options));
      return sendResult(messages.length);
    }
  });
  const device = () => fixture.records.get(`notificationDevices/${exports.deviceKey('u1', 'install_1')}`);
  return { ...fixture, push, create, service: create(), messages, device,
    now: () => time, advance: amount => { time += amount; } };
}

function legacyNavigationTarget(message) {
  // APK 4026 requires a supported type and identical outer/inner match, type,
  // and event IDs before it can route either foreground data or an OS tap.
  const nested = JSON.parse(message.data.event);
  return legacyTypes.has(nested.type) && message.data.type === nested.type &&
    message.data.eventId === nested.eventId && message.data.matchId === nested.matchId &&
    /^bsd_[1-9]\d*$/.test(nested.matchId) ? nested.matchId : null;
}

test('old installations receive supported, consistent tap envelopes for every extended event without mutating canonical data', () => {
  const { push } = harness();
  for (const type of extendedTypes) {
    const canonical = event(type);
    const original = structuredClone(canonical);
    const content = push.buildEventNotification(canonical);
    const message = push.buildPushMessage(token, content.title, content.message, {
      event: canonical, supportsExtendedAlerts: false, recipientUserId: 'u1',
    });
    validateMessage(structuredClone(message));
    const nested = JSON.parse(message.data.event);
    assert.equal(message.data.type, 'detailed', type);
    assert.equal(nested.type, 'detailed', type);
    assert.equal(message.data.canonicalType, type);
    assert.equal(nested.canonicalType, type);
    assert.equal(message.notification.title, content.title);
    assert.equal(message.notification.body, content.message);
    assert.equal(message.android.notification.channelId, 'match_events_detailed_s1_v1');
    assert.equal(legacyNavigationTarget(message), 'bsd_123');
    assert.deepEqual(canonical, original);
  }
});

test('capable and direct-default envelopes retain canonical types while every existing legacy type remains unchanged', () => {
  const { push } = harness();
  for (const type of extendedTypes) for (const marker of [undefined, true]) {
    const message = push.buildPushMessage(token, 'Title', 'Body', {
      event: event(type), ...(marker === undefined ? {} : { supportsExtendedAlerts: marker }),
    });
    assert.equal(message.data.type, type);
    assert.equal(JSON.parse(message.data.event).type, type);
    assert.equal(Object.hasOwn(message.data, 'canonicalType'), false);
  }
  for (const type of legacyTypes) {
    const message = push.buildPushMessage(token, 'Title', 'Body', { event: event(type), supportsExtendedAlerts: false });
    assert.equal(message.data.type, type);
    assert.equal(JSON.parse(message.data.event).type, type);
    assert.equal(legacyNavigationTarget(message), 'bsd_123');
  }
  const message = push.buildPushMessage(token, 'Test', 'Body', {
    event: { type: 'systemTest', kind: 'systemTest', eventId: 'offline_system_test' }, supportsExtendedAlerts: false,
  });
  assert.equal(message.data.type, 'systemTest');
  assert.equal(message.data.kind, 'systemTest');
});

test('legacy score corrections preserve shared score tags, exact score and event IDs through payload compaction', () => {
  const { push } = harness();
  const goal = push.buildPushMessage(token, 'Goal', 'Body', { event: event('goal'), supportsExtendedAlerts: false });
  const correction = event('goalCancelled');
  correction.player = correction.team = correction.against = 'لاعب '.repeat(100);
  correction.homeTeam.name = correction.awayTeam.name = 'نادي '.repeat(100);
  const message = push.buildPushMessage(token, 'إلغاء هدف'.repeat(20), 'تصحيح النتيجة'.repeat(40), {
    event: correction, supportsExtendedAlerts: false, preferences: { sound: false, vibration: false },
  });
  validateMessage(structuredClone(message));
  const nested = JSON.parse(message.data.event);
  assert.equal(message.android.notification.tag, goal.android.notification.tag);
  assert.equal(message.apns.headers['apns-collapse-id'], goal.apns.headers['apns-collapse-id']);
  assert.equal(nested.eventId, correction.eventId);
  assert.deepEqual(nested.previousScore, correction.previousScore);
  assert.deepEqual(nested.score, correction.scoreValues);
  assert.equal(nested.canonicalType, 'goalCancelled');
  assert.equal(legacyNavigationTarget(message), 'bsd_123');
  assert.equal(message.android.notification.channelId, 'match_events_detailed_s0_v0');
  assert.ok(Buffer.byteLength(JSON.stringify({ notification: message.notification, data: message.data })) <= 3500);
});

test('installation capability derives only from raw structured alerts preferences and refreshes on each registration', async () => {
  const f = harness();
  const old = { ...registration(), supportsExtendedAlerts: true };
  await f.service.register('u1', 'install_1', old);
  assert.equal(f.device().supportsExtendedAlerts, false);
  assert.equal(typeof f.device().preferences.alerts, 'object');
  await f.service.register('u1', 'install_1', { ...registration({ alerts: { goals: true } }), supportsExtendedAlerts: false });
  assert.equal(f.device().supportsExtendedAlerts, true);
  await f.service.register('u1', 'install_1', registration());
  assert.equal(f.device().supportsExtendedAlerts, false);
});

test('preexisting markerless installations use legacy envelopes and delivery rereads upgrades rather than stale discovery', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const staleDevice = f.device();
  delete staleDevice.supportsExtendedAlerts;
  await f.service.deliver(staleDevice, event('halfTime', 'offline_old', f.now()));
  assert.equal(f.messages[0].data.type, 'detailed');
  await f.service.register('u1', 'install_1', registration({ alerts: {} }));
  await f.service.deliver(staleDevice, event('secondHalfStart', 'offline_new', f.now()));
  assert.equal(f.messages[1].data.type, 'secondHalfStart');
});

test('restart retries use current installation protocol while the durable event remains canonical', async () => {
  const f = harness(count => count === 1 ? { sent: false, retryable: true } : { sent: true });
  await f.service.register('u1', 'install_1', registration());
  const canonical = event('goalCancelled', 'offline_retry', f.now());
  await f.service.deliver(f.device(), canonical);
  assert.equal(f.messages[0].data.type, 'detailed');
  const pending = [...f.records].find(([key, row]) => key.startsWith('notificationDeliveries/') && row.status === 'pending')[1];
  assert.equal(pending.event.type, 'goalCancelled');
  assert.equal(Object.hasOwn(pending.event, 'canonicalType'), false);
  assert.equal(pending.event.eventId, canonical.eventId);
  const restarted = f.create();
  await restarted.register('u1', 'install_1', registration({ alerts: {} }));
  f.advance(30000);
  assert.deepEqual(await restarted.flushRetries(), { attempted: 1, queued: 0 });
  assert.equal(f.messages[1].data.type, 'goalCancelled');
  assert.equal(JSON.parse(f.messages[1].data.event).eventId, canonical.eventId);
});

test('wire compatibility does not bypass canonical categories or hidden-score suppression', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration({ alerts: { matchStatus: false } }));
  // Simulate an old persisted installation with category preferences added by
  // the server, without claiming its old binary understands extended types.
  f.device().supportsExtendedAlerts = false;
  assert.equal((await f.service.deliver(f.device(), event('halfTime', 'offline_disabled', f.now()))).suppressed, true);
  await f.service.register('u1', 'install_1', registration({ hideScores: true }));
  assert.equal((await f.service.deliver(f.device(), event('goalCancelled', 'offline_hidden', f.now()))).suppressed, true);
  assert.equal(f.messages.length, 0);
});
