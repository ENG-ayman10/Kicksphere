const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createPushDeliveryLedger, storedEvent } = require('../utils/pushDeliveryLedger');

const initialTime = Date.parse('2026-10-11T12:00:00Z');
const registration = (token = 'offline_fcm_token_12345678901234567890', preferences = {}) => ({
  token, platform: 'android', language: 'en', preferences: { matchIds: ['bsd_123', 'bsd_124'], ...preferences },
});
const goal = (time = initialTime, overrides = {}) => ({
  eventId: 'goal-a', matchId: 'bsd_123', type: 'goal', provider: 'bsd',
  homeTeam: { id: 'bsd_t_57', name: 'Home' }, awayTeam: { id: 'bsd_t_44', name: 'Away' },
  team: 'Home', against: 'Away', teamId: 'bsd_t_57', againstTeamId: 'bsd_t_44', side: 'home',
  score: '1-0', scoreValues: { home: 1, away: 0 }, createdAt: new Date(time), ...overrides,
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function memoryDatabase() {
  const records = new Map();
  let transactionBarrier = Promise.resolve();
  const field = (data, key) => key.split('.').reduce((value, part) => value?.[part], data);
  const ref = key => ({ id: key.split('/').at(-1), key, get: async () => snapshot(key),
    set: async (data, options) => records.set(key, options?.merge ? { ...records.get(key), ...data } : data),
    update: async data => records.set(key, { ...records.get(key), ...data }),
    delete: async () => records.delete(key),
  });
  const snapshot = key => ({ id: key.split('/').at(-1), exists: records.has(key), ref: ref(key),
    data: () => records.get(key),
  });
  function query(name, filters = [], limit = Infinity, after = '') {
    return {
      isQuery: true,
      where(key, operator, value) { return query(name, [...filters, [key, operator, value]], limit, after); },
      orderBy(key) { assert.equal(key, '__name__'); return this; },
      limit(value) { return query(name, filters, value, after); },
      startAfter(document) { return query(name, filters, limit, document.id); },
      async get() {
        const docs = [...records].filter(([key, row]) => key.startsWith(`${name}/`) && key.split('/').length === 2 &&
          key.split('/')[1] > after && filters.every(([key, operator, value]) => {
            const actual = field(row, key);
            if (operator === 'array-contains') return Array.isArray(actual) && actual.includes(value);
            if (operator === 'array-contains-any') return Array.isArray(actual) && actual.some(item => value.includes(item));
            if (operator === '<=') return actual <= value;
            return actual === value;
          })).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key]) => snapshot(key));
        return { docs, empty: docs.length === 0 };
      },
    };
  }
  const database = {
    collection(name) { return { ...query(name), doc: id => ref(`${name}/${id}`) }; },
    runTransaction(operation) {
      const work = transactionBarrier.then(async () => {
        const writes = [];
        const result = await operation({
          get: async reference => { assert.equal(writes.length, 0); return reference.isQuery ? reference.get() : snapshot(reference.key); },
          set: (reference, data, options) => writes.push(() => reference.set(data, options)),
          update: (reference, data) => writes.push(() => reference.update(data)),
          delete: reference => writes.push(() => reference.delete()),
        });
        for (const write of writes) await write();
        return result;
      });
      transactionBarrier = work.catch(() => {});
      return work;
    },
  };
  return { database, records };
}

function harness(send, options = {}) {
  const fixture = memoryDatabase();
  let time = initialTime;
  const calls = [];
  const delivery = send || (async (token, title, message, details) => { calls.push({ token, event: details.event }); return { sent: true }; });
  const serviceFile = require.resolve('../services/notificationDeviceService');
  delete require.cache[serviceFile];
  const original = Module._load;
  Module._load = function(name, parent, isMain) {
    if (name === '../config/firebase') return fixture.database;
    if (name === '../utils/logger') return { warn() {}, info() {}, error() {} };
    if (name === './pushNotificationService') return {
      sendPushNotification: delivery, buildEventNotification: event => ({ title: event.type, message: event.score || '' }),
    };
    return original.call(this, name, parent, isMain);
  };
  let exports;
  try { exports = require(serviceFile); } finally { Module._load = original; }
  const create = extra => exports.createNotificationDeviceService(fixture.database, {
    send: delivery, now: () => time, recipientAllowed: () => true, ...options, ...extra,
  });
  const service = create();
  const getDevice = (userId = 'u1', deviceId = 'install_1') => fixture.records.get(
    `notificationDevices/${exports.deviceKey(userId, deviceId)}`);
  const keyFor = (device, event) => `${exports.deviceKey(device.userId, device.deviceId)}:${event.matchId || 'system'}:${event.type}:${event.eventId}`;
  return { ...fixture, service, create, getDevice, keyFor, calls,
    now: () => time, advance: delta => { time += delta; },
  };
}

test('pending retry survives a process restart and accepted receipt deduplicates a second restart', async () => {
  const calls = [];
  const f = harness(async (token, _, __, details) => {
    calls.push({ token, event: details.event });
    return calls.length === 1 ? { sent: false, retryable: true } : { sent: true };
  });
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  await f.service.deliver(device, goal());
  const restarted = f.create();
  assert.deepEqual(await restarted.flushRetries(), { attempted: 0, queued: 1 });
  const freshToken = 'offline_fcm_token_98765432109876543210';
  await restarted.register('u1', 'install_1', registration(freshToken));
  f.advance(30000);
  assert.deepEqual(await restarted.flushRetries(), { attempted: 1, queued: 0 });
  assert.deepEqual(calls.map(call => call.token), [registration().token, freshToken]);
  const nextRestart = f.create();
  assert.deepEqual(await nextRestart.deliver(device, goal()), { sent: true, duplicate: true });
  assert.equal(calls.length, 2);
  const receipts = [...f.records].filter(([key]) => key.startsWith('notificationDeliveries/'));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0][1].status, 'accepted');
  assert.equal(JSON.stringify(receipts).includes('offline_fcm_token'), false);
  assert.equal(Object.hasOwn(receipts[0][1], 'event'), false);
});

test('a crashed pre-send lease recovers when due, with no FCM call before its lease expires', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const ledger = createPushDeliveryLedger(f.database, { now: f.now });
  const device = f.getDevice();
  assert.equal((await ledger.claim(f.keyFor(device, goal()), device, goal(), f.now() + 300000)).status, 'claimed');
  const restarted = f.create();
  assert.deepEqual(await restarted.deliver(device, goal()), { sent: false, pending: true });
  await restarted.flushRetries();
  assert.equal(f.calls.length, 0);
  f.advance(30001);
  assert.deepEqual(await restarted.flushRetries(), { attempted: 1, queued: 0 });
  assert.equal(f.calls.length, 1);
});

test('two service instances cannot submit one unexpired delivery lease concurrently', async () => {
  const started = deferred();
  const accepted = deferred();
  let calls = 0;
  const f = harness(async () => { calls++; started.resolve(); return accepted.promise; });
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  const first = f.service.deliver(device, goal());
  await started.promise;
  assert.deepEqual(await f.create().deliver(device, goal()), { sent: false, pending: true });
  assert.equal(calls, 1);
  accepted.resolve({ sent: true });
  await first;
});

test('newer corrected score makes an older pending goal retry obsolete after restart', async () => {
  const calls = [];
  const f = harness(async (_, __, ___, details) => {
    calls.push(details.event.type);
    return details.event.type === 'goal' ? { sent: false, retryable: true } : { sent: true };
  });
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  await f.service.deliver(device, goal());
  f.advance(1000);
  await f.service.deliver(device, goal(f.now(), { type: 'goalCancelled', eventId: 'cancel-a',
    previousScore: '1-0', score: '0-0', scoreValues: { home: 0, away: 0 } }));
  f.advance(30000);
  assert.deepEqual(await f.create().flushRetries(), { attempted: 1, queued: 0 });
  assert.deepEqual(calls, ['goal', 'goalCancelled']);
});

test('same-clock cancellation and a new goal obsolete the old goal retry without suppressing the new goal', async () => {
  const calls = [];
  const f = harness(async (_, __, ___, details) => {
    calls.push(details.event.eventId);
    return details.event.eventId === 'goal-a' ? { sent: false, retryable: true } : { sent: true };
  });
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  await f.service.deliver(device, goal());
  await f.service.deliver(device, goal(initialTime, { type: 'goalCancelled', eventId: 'cancel-a',
    previousScore: '1-0', score: '0-0', scoreValues: { home: 0, away: 0 } }));
  await f.service.deliver(device, goal(initialTime, { eventId: 'goal-b' }));
  f.advance(30000);
  assert.deepEqual(await f.create().flushRetries(), { attempted: 1, queued: 0 });
  assert.deepEqual(calls, ['goal-a', 'cancel-a', 'goal-b']);
});

test('score submissions serialize one installation/match and leave another match unblocked', async () => {
  const firstStarted = deferred();
  const firstAccepted = deferred();
  const calls = [];
  const f = harness(async (_, __, ___, details) => {
    const event = details.event; calls.push(`${event.matchId}:${event.type}`);
    if (event.eventId === 'goal-a') { firstStarted.resolve(); return firstAccepted.promise; }
    return { sent: true };
  });
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  const first = f.service.deliver(device, goal());
  await firstStarted.promise;
  f.advance(1);
  const corrected = f.service.deliver(device, goal(f.now(), { type: 'goalCancelled', eventId: 'cancel-a', score: '0-0' }));
  const separate = f.service.deliver(device, goal(f.now(), { matchId: 'bsd_124', eventId: 'other-goal' }));
  await separate;
  assert.deepEqual(calls, ['bsd_123:goal', 'bsd_124:goal']);
  firstAccepted.resolve({ sent: true });
  await Promise.all([first, corrected]);
  assert.deepEqual(calls, ['bsd_123:goal', 'bsd_124:goal', 'bsd_123:goalCancelled']);
});

test('restart retry rereads changed spoiler preferences and installation ownership', async () => {
  for (const mode of ['hidden', 'transferred']) {
    let calls = 0;
    const f = harness(async () => { calls++; return { sent: false, retryable: true }; });
    await f.service.register('u1', 'install_1', registration());
    await f.service.deliver(f.getDevice(), goal());
    const restarted = f.create();
    if (mode === 'hidden') await restarted.register('u1', 'install_1', registration(undefined, { hideScores: true }));
    else await restarted.register('u2', 'install_1', registration());
    f.advance(30000);
    assert.deepEqual(await restarted.flushRetries(), { attempted: 1, queued: 0 });
    assert.equal(calls, 1);
  }
});

test('expired reminders and predicted lineups never create a user-visible delivery', async () => {
  let calls = 0;
  const f = harness(async () => { calls++; return { sent: false, retryable: true }; });
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  await f.service.deliver(device, goal(initialTime, { type: 'matchReminder', eventId: 'reminder-a',
    reminderMinutes: 15, utcDate: new Date(initialTime + 20000).toISOString() }));
  assert.equal(calls, 1);
  f.advance(30000);
  assert.deepEqual(await f.create().flushRetries(), { attempted: 0, queued: 0 });
  assert.equal(calls, 1);
  assert.equal((await f.service.deliver(device, goal(f.now(), { type: 'lineup',
    eventId: 'predicted-a', lineupConfirmed: false }))).suppressed, true);
  assert.equal(calls, 1);
});

test('persisted retry count remains bounded and stale entries expire without a send', async () => {
  const f = harness(async () => ({ sent: false, retryable: true }), { retryQueueLimit: 3 });
  await f.service.register('u1', 'install_1', registration());
  for (let i = 0; i < 5; i++) await f.service.deliver(f.getDevice(), goal(initialTime, { eventId: `goal-${i}` }));
  assert.equal([...f.records.values()].filter(row => row.status === 'pending').length, 3);
  const restarted = f.create();
  assert.deepEqual(await restarted.flushRetries(), { attempted: 0, queued: 3 });
  f.advance(300001);
  assert.deepEqual(await f.create().flushRetries(), { attempted: 0, queued: 0 });
  assert.equal([...f.records.values()].filter(row => row.status === 'pending').length, 0);
});

test('a restricted worker never drains another account persisted retry', async () => {
  const f = harness(async () => ({ sent: false, retryable: true }));
  await f.service.register('u1', 'install_1', registration());
  await f.service.deliver(f.getDevice(), goal());
  f.advance(30000);
  const restricted = f.create({ recipientAllowed: id => id === 'other-account' });
  assert.deepEqual(await restricted.flushRetries(), { attempted: 0, queued: 0 });
  assert.equal([...f.records.values()].filter(row => row.status === 'pending').length, 1);
});

test('ledger storage excludes credentials and strips arbitrary nested provider fields', () => {
  const stored = storedEvent(goal(initialTime, { token: 'secret-token', authorization: 'secret-auth',
    homeTeam: { id: 'bsd_t_57', name: 'Home', token: 'nested-token', private_key: 'secret-key' },
    player: { name: 'Player', token: 'nested-player-token' } }));
  assert.deepEqual(stored.homeTeam, { id: 'bsd_t_57', name: 'Home' });
  assert.equal(JSON.stringify(stored).includes('secret-'), false);
  assert.equal(JSON.stringify(stored).includes('nested-'), false);
  assert.equal(storedEvent(goal(initialTime, { title: 'x'.repeat(40 * 1024) })), null);
});

test('ledger outage deadline does not indefinitely delay foreground push submission', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const claimStarted = deferred();
  const unavailable = new Promise(() => {});
  const f = harness(undefined, { deliveryLedgerDeadlineMs: 20, deliveryLedger: {
    claim: () => { claimStarted.resolve(); return unavailable; },
    accepted: async () => {}, queued: async () => {}, remove: async () => {}, restore: async () => [],
  } });
  await f.service.register('u1', 'install_1', registration());
  const delivery = f.service.deliver(f.getDevice(), goal());
  await claimStarted.promise;
  context.mock.timers.tick(19);
  await Promise.resolve();
  assert.equal(f.calls.length, 0);
  context.mock.timers.tick(1);
  assert.equal((await delivery).sent, true);
  assert.equal(f.calls.length, 1);
});

test('failed accepted receipt write is retried without sending the FCM message again', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const ledger = createPushDeliveryLedger(f.database, { now: f.now });
  let receiptWrites = 0;
  const flakyLedger = { ...ledger, accepted: async (...args) => {
    if (++receiptWrites === 1) throw new Error('temporary receipt write outage');
    return ledger.accepted(...args);
  } };
  const service = f.create({ deliveryLedger: flakyLedger });
  await service.deliver(f.getDevice(), goal());
  assert.equal(f.calls.length, 1);
  await service.flushRetries();
  assert.equal(receiptWrites, 2);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.create().deliver(f.getDevice(), goal())).duplicate, true);
  assert.equal(f.calls.length, 1);
});

test('persisted backoff budget survives each restart and still stops after three retries', async () => {
  let calls = 0;
  const f = harness(async () => { calls++; return { sent: false, retryable: true }; });
  await f.service.register('u1', 'install_1', registration());
  await f.service.deliver(f.getDevice(), goal());
  for (const delay of [30000, 60000, 120000]) {
    f.advance(delay); await f.create().flushRetries();
  }
  assert.equal(calls, 4);
  assert.deepEqual(await f.create().flushRetries(), { attempted: 0, queued: 0 });
});

test('accepted receipts and score heads expire with bounded cleanup', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  await f.service.deliver(f.getDevice(), goal());
  assert.equal([...f.records.keys()].filter(key => key.startsWith('notificationDeliveries/')).length, 1);
  assert.equal([...f.records.keys()].filter(key => key.startsWith('notificationScoreDeliveryHeads/')).length, 1);
  f.advance(24 * 60 * 60 * 1000 + 1);
  await f.create().flushRetries();
  assert.equal([...f.records.keys()].filter(key => key.startsWith('notificationDeliveries/')).length, 0);
  assert.equal([...f.records.keys()].filter(key => key.startsWith('notificationScoreDeliveryHeads/')).length, 0);
});

test('initial delivery respects source-age expiry and forwards only the remaining lifetime', async () => {
  const sends = [];
  const f = harness(async (_, __, ___, options) => { sends.push(options); return { sent: true }; });
  await f.service.register('u1', 'install_1', registration());
  f.advance(299000);
  assert.equal((await f.service.deliver(f.getDevice(), goal())).sent, true);
  assert.equal(sends[0].ttlMs, 1000);
  assert.equal(sends[0].expiresAt, initialTime + 300000);
  f.advance(1001);
  assert.deepEqual(await f.service.deliver(f.getDevice(), goal(initialTime, { eventId: 'stale-initial' })),
    { sent: false, expired: true });
  assert.equal(sends.length, 1);
});

test('a delayed claim and a delayed registration read cannot send an expired initial event', async () => {
  for (const delayed of ['claim', 'registration']) {
    const f = harness();
    await f.service.register('u1', 'install_1', registration());
    const device = f.getDevice();
    let service = f.service;
    if (delayed === 'claim') {
      const ledger = createPushDeliveryLedger(f.database, { now: f.now });
      service = f.create({ deliveryLedger: { ...ledger, claim: async (...args) => {
        const result = await ledger.claim(...args); f.advance(300001); return result;
      } } });
    } else {
      const originalCollection = f.database.collection;
      f.database.collection = name => {
        const collection = originalCollection(name);
        return name !== 'notificationDevices' ? collection : { ...collection, doc: id => {
          const ref = collection.doc(id);
          return { ...ref, get: async () => { const result = await ref.get(); f.advance(300001); return result; } };
        } };
      };
      service = f.create();
    }
    assert.equal((await service.deliver(device, goal())).expired, true, delayed);
    assert.equal(f.calls.length, 0, delayed);
  }
});

test('reminder first send and persisted retry expire exactly at kickoff', async () => {
  const sends = [];
  const f = harness(async (_, __, ___, options) => {
    sends.push(options); return { sent: false, retryable: true };
  });
  await f.service.register('u1', 'install_1', registration());
  const reminder = goal(initialTime, { type: 'matchReminder', eventId: 'kickoff-boundary',
    utcDate: new Date(initialTime + 40000).toISOString() });
  await f.service.deliver(f.getDevice(), reminder);
  assert.equal(sends[0].ttlMs, 40000);
  assert.equal(sends[0].expiresAt, initialTime + 40000);
  f.advance(40000);
  assert.deepEqual(await f.create().flushRetries(), { attempted: 0, queued: 0 });
  assert.equal(sends.length, 1);
});

test('an active FCM submission renews its lease across workers and stops renewal after completion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred(), finish = deferred();
  let pulse = deferred(), renewals = 0, sends = 0;
  const f = harness(async () => { sends++; started.resolve(); return finish.promise; });
  await f.service.register('u1', 'install_1', registration());
  const ledger = createPushDeliveryLedger(f.database, { now: f.now });
  const service = f.create({ deliveryLedger: { ...ledger, renew: async key => {
    const result = await ledger.renew(key); renewals++; pulse.resolve(); return result;
  } } });
  const submission = service.deliver(f.getDevice(), goal());
  await started.promise;
  for (let i = 0; i < 4; i++) {
    f.advance(10000); context.mock.timers.tick(10000); await pulse.promise;
    await new Promise(resolve => setImmediate(resolve)); pulse = deferred();
  }
  assert.equal(renewals, 4);
  assert.deepEqual(await f.create().deliver(f.getDevice(), goal()), { sent: false, pending: true });
  assert.equal(sends, 1);
  finish.resolve({ sent: true }); await submission;
  f.advance(30000); context.mock.timers.tick(30000); await Promise.resolve();
  assert.equal(renewals, 4);
  assert.equal((await f.create().deliver(f.getDevice(), goal())).duplicate, true);
});

test('a late former owner cannot renew or replace another worker claim with an accepted receipt', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const first = createPushDeliveryLedger(f.database, { now: f.now });
  const second = createPushDeliveryLedger(f.database, { now: f.now });
  const device = f.getDevice(), item = goal(), key = f.keyFor(device, item);
  assert.equal((await first.claim(key, device, item, initialTime + 300000)).status, 'claimed');
  f.advance(30001);
  assert.equal((await second.claim(key, device, item, initialTime + 300000)).status, 'claimed');
  const recordKey = [...f.records.keys()].find(key => key.startsWith('notificationDeliveries/'));
  const newOwner = f.records.get(recordKey).leaseOwner;
  f.advance(30001);
  assert.equal(await first.renew(key), false);
  assert.equal(await first.accepted(key, device), false);
  await first.queued(key, { device, event: item, retryIndex: 1, nextAt: f.now(), expiresAt: initialTime + 300000 });
  await first.remove(key);
  assert.equal(f.records.get(recordKey).leaseOwner, newOwner);
  assert.equal(f.records.get(recordKey).status, 'pending');
  assert.equal(await second.accepted(key, device), true);
  assert.equal((await first.claim(key, device, item, initialTime + 300000)).status, 'accepted');
});

test('a sender losing its lease during a registry wait cannot submit after another worker claimed it', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice(), registryStarted = deferred(), registryReleased = deferred(), renewal = deferred();
  const originalCollection = f.database.collection;
  f.database.collection = name => {
    const collection = originalCollection(name);
    return name !== 'notificationDevices' ? collection : { ...collection, doc: id => {
      const ref = collection.doc(id);
      return { ...ref, get: async () => {
        registryStarted.resolve(); await registryReleased.promise; return ref.get();
      } };
    } };
  };
  const first = createPushDeliveryLedger(f.database, { now: f.now });
  const second = createPushDeliveryLedger(f.database, { now: f.now });
  const service = f.create({ deliveryLedger: { ...first, renew: async key => {
    const result = await first.renew(key); renewal.resolve(); return result;
  } } });
  const submitting = service.deliver(device, goal());
  await registryStarted.promise;
  f.advance(30001); context.mock.timers.tick(30001); await renewal.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await second.claim(f.keyFor(device, goal()), device, goal(), initialTime + 300000)).status, 'claimed');
  registryReleased.resolve();
  assert.deepEqual(await submitting, { sent: false, pending: true });
  assert.equal(f.calls.length, 0);
  assert.equal((await second.claim(f.keyFor(device, goal()), device, goal(), initialTime + 300000)).status, 'pending');
});

test('same-clock score revisions suppress a late initial goal while preserving a genuinely newer goal', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  const correction = goal(initialTime, { eventId: 'cancel-rev-2', type: 'goalCancelled',
    score: '0-0', scoreRevision: 2 });
  assert.equal((await f.service.deliver(device, correction)).sent, true);
  assert.deepEqual(await f.create().deliver(device, goal(initialTime, { scoreRevision: 1 })),
    { sent: false, obsolete: true });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.create().deliver(device, goal(initialTime, { eventId: 'goal-rev-3', scoreRevision: 3 }))).sent, true);
  assert.deepEqual(f.calls.map(({ event }) => event.eventId), ['cancel-rev-2', 'goal-rev-3']);
});

test('score revision cannot overrule a newer emission clock or suppress a legacy initial same-clock event', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  await f.service.deliver(device, goal(initialTime, { eventId: 'prior-process', scoreRevision: 999 }));
  f.advance(1);
  assert.equal((await f.create().deliver(device, goal(f.now(), { eventId: 'new-process', scoreRevision: 0 }))).sent, true);
  assert.equal((await f.create().deliver(device, goal(f.now(), { eventId: 'legacy-same-clock' }))).sent, true);
  assert.equal(f.calls.length, 3);
});

test('malformed createdAt cannot bypass a newer durable score head when emittedAt is available', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice();
  await f.service.deliver(device, goal(initialTime, { eventId: 'latest-correction', type: 'goalCancelled', score: '0-0' }));
  const stale = goal(initialTime, { eventId: 'old-delayed-goal', createdAt: 'invalid-date', emittedAt: initialTime - 1 });
  assert.deepEqual(await f.create().deliver(device, stale), { sent: false, obsolete: true });
  assert.deepEqual(f.calls.map(({ event }) => event.eventId), ['latest-correction']);
});

test('a delayed claim response cannot submit after its lease expired and another worker acquired it', async () => {
  const f = harness();
  await f.service.register('u1', 'install_1', registration());
  const device = f.getDevice(), item = goal(), key = f.keyFor(device, item);
  const first = createPushDeliveryLedger(f.database, { now: f.now });
  const second = createPushDeliveryLedger(f.database, { now: f.now });
  const service = f.create({ deliveryLedger: { ...first, claim: async (...args) => {
    const result = await first.claim(...args);
    f.advance(30001);
    assert.equal((await second.claim(key, device, item, initialTime + 300000)).status, 'claimed');
    return result;
  } } });
  assert.deepEqual(await service.deliver(device, item), { sent: false, pending: true });
  assert.equal(f.calls.length, 0);
  assert.equal((await second.claim(key, device, item, initialTime + 300000)).status, 'pending');
});
