'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createPushDeliveryLedger, storedEvent } = require('../utils/pushDeliveryLedger');
const { isEventAllowed } = require('../utils/competitionScope');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const MAJOR = { code: 'PL', name: 'Premier League', country: 'England' };
const EXCLUDED = { name: 'Premier League', country: 'Israel' };
const ARAB = { id: 'bsd_c_711', name: 'Unnamed regional competition', country: { name: 'Yemen', code: 'YE' } };
const goal = (id, competition = MAJOR, patch = {}) => ({ eventId: id, matchId: 'bsd_123', type: 'goal', provider: 'bsd',
  teamId: 'bsd_t_57', againstTeamId: 'bsd_t_44', score: '1 - 0', scoreValues: { home: 1, away: 0 },
  competition, createdAt: new Date(NOW), ...patch });

function scope(t, value) {
  const previous = process.env.SPORTS_COMPETITION_SCOPE;
  process.env.SPORTS_COMPETITION_SCOPE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SPORTS_COMPETITION_SCOPE;
    else process.env.SPORTS_COMPETITION_SCOPE = previous;
  });
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function memoryDatabase() {
  const records = new Map();
  const reads = { installation: 0, audience: 0 };
  let installationRead;
  let transactionBarrier = Promise.resolve();
  const field = (data, key) => key.split('.').reduce((value, part) => value?.[part], data);
  const ref = key => ({ id: key.split('/').at(-1), key,
    get: async () => {
      if (key.startsWith('notificationDevices/')) { reads.installation++; await installationRead?.(); }
      return snapshot(key);
    }, set: async (data, options) => records.set(key, options?.merge ? { ...records.get(key), ...data } : data),
    delete: async () => records.delete(key) });
  const snapshot = key => ({ id: key.split('/').at(-1), exists: records.has(key), ref: ref(key), data: () => records.get(key) });
  function query(name, filters = [], maximum = Infinity, after = '') {
    return { isQuery: true,
      where(key, operator, value) { return query(name, [...filters, [key, operator, value]], maximum, after); },
      orderBy() { return this; }, limit(value) { return query(name, filters, value, after); },
      startAfter(document) { return query(name, filters, maximum, document.id); },
      async get() {
        if (name === 'notificationDevices') reads.audience++;
        const docs = [...records].filter(([key, row]) => key.startsWith(`${name}/`) && key.split('/')[1] > after &&
          filters.every(([name, operator, value]) => {
            const actual = field(row, name);
            if (operator === 'array-contains') return Array.isArray(actual) && actual.includes(value);
            if (operator === 'array-contains-any') return Array.isArray(actual) && actual.some(item => value.includes(item));
            return operator === '<=' ? actual <= value : actual === value;
          })).sort(([a], [b]) => a.localeCompare(b)).slice(0, maximum).map(([key]) => snapshot(key));
        return { docs };
      } };
  }
  const database = { collection(name) { return { ...query(name), doc: id => ref(`${name}/${id}`) }; },
    runTransaction(operation) {
      const work = transactionBarrier.then(async () => {
        const writes = [];
        const result = await operation({ get: async reference => {
          assert.equal(writes.length, 0);
          return reference.isQuery ? reference.get() : snapshot(reference.key);
        }, set: (reference, data, options) => writes.push(() => reference.set(data, options)),
        delete: reference => writes.push(() => reference.delete()) });
        for (const write of writes) await write();
        return result;
      });
      transactionBarrier = work.catch(() => {});
      return work;
    } };
  return { database, records, reads, blockInstallationRead: operation => { installationRead = operation; } };
}

function harness({ send, deliveryLedger } = {}) {
  const memory = memoryDatabase(), calls = [];
  let now = NOW;
  const sender = send || (async (_, __, ___, details) => { calls.push(details.event); return { sent: true }; });
  const file = require.resolve('../services/notificationDeviceService');
  delete require.cache[file];
  const original = Module._load;
  Module._load = function(name, parent, main) {
    if (name === '../config/firebase') return memory.database;
    if (name === '../utils/logger') return { warn() {}, info() {}, error() {} };
    if (name === './pushNotificationService') return { sendPushNotification: sender,
      buildEventNotification: event => ({ title: event.type, message: event.score || '' }) };
    return original.call(this, name, parent, main);
  };
  let exported;
  try { exported = require(file); } finally { Module._load = original; }
  const create = () => exported.createNotificationDeviceService(memory.database, {
    now: () => now, recipientAllowed: () => true, send: sender, ...(deliveryLedger ? { deliveryLedger } : {}),
  });
  const device = { userId: 'offline-user', deviceId: 'offline-install', token: 'offline-placeholder-no-network',
    language: 'en', supportsExtendedAlerts: true, lastSeenAt: new Date(NOW),
    preferences: { matchIds: ['bsd_123'], teamIds: ['bsd_t_57'] } };
  memory.records.set(`notificationDevices/${exported.deviceKey(device.userId, device.deviceId)}`, device);
  const keyFor = (device, event) => `${exported.deviceKey(device.userId, device.deviceId)}:${event.matchId || 'system'}:${event.type}:${event.eventId}`;
  return { ...memory, device, keyFor, calls, create, service: create(), now: () => now, advance: ms => { now += ms; } };
}

test('focused delivery and audience discovery reject excluded competitions before installation reads or pushes', async t => {
  scope(t, 'focused');
  const h = harness();
  const excluded = goal('excluded', EXCLUDED);
  assert.deepEqual(await h.service.deliver(h.device, excluded), { sent: false, suppressed: true, excluded: true });
  assert.equal((await h.service.findRecipients([excluded])).size, 0);
  assert.deepEqual(h.reads, { installation: 0, audience: 0 });
  assert.equal(h.calls.length, 0);
});

test('major, Arab and international notifications remain deliverable, with system notifications unaffected', async t => {
  scope(t, 'focused');
  const h = harness();
  const events = [goal('major'), goal('arab', ARAB), goal('international', { name: 'FIFA World Cup', country: 'World' }),
    goal('system', undefined, { type: 'systemTest', matchId: undefined, competition: undefined })];
  for (const event of events) assert.equal((await h.service.deliver(h.device, event)).sent, true);
  assert.deepEqual(h.calls.map(event => event.eventId), events.map(event => event.eventId));
});

test('a scope change during an installation read suppresses the send after the read finishes', async t => {
  scope(t, 'all');
  const entered = deferred(), release = deferred(), h = harness();
  h.blockInstallationRead(async () => { entered.resolve(); await release.promise; });
  const pending = h.service.deliver(h.device, goal('read-wait', EXCLUDED));
  await entered.promise;
  process.env.SPORTS_COMPETITION_SCOPE = 'focused'; release.resolve();
  assert.equal((await pending).excluded, true);
  assert.equal(h.calls.length, 0);
});

test('a scope change during a ledger claim suppresses delivery before any installation read', async t => {
  scope(t, 'all');
  const entered = deferred(), release = deferred();
  const h = harness({ deliveryLedger: { claim: async () => { entered.resolve(); return release.promise; },
    remove: async () => {}, restore: async () => [], accepted: async () => {}, queued: async () => {} } });
  const pending = h.service.deliver(h.device, goal('claim-wait', EXCLUDED));
  await entered.promise;
  process.env.SPORTS_COMPETITION_SCOPE = 'focused'; release.resolve({ status: 'claimed' });
  assert.equal((await pending).excluded, true);
  assert.equal(h.reads.installation, 0);
  assert.equal(h.calls.length, 0);
});

test('score submissions waiting behind another send recheck scope before claiming or reading an installation', async t => {
  scope(t, 'all');
  const entered = deferred(), release = deferred(), calls = [];
  const h = harness({ send: async (_, __, ___, details) => { calls.push(details.event.eventId); entered.resolve(); return release.promise; } });
  const first = h.service.deliver(h.device, goal('first', EXCLUDED)); await entered.promise;
  const next = h.service.deliver(h.device, goal('queued-score', EXCLUDED));
  process.env.SPORTS_COMPETITION_SCOPE = 'focused'; release.resolve({ sent: true });
  await first; assert.equal((await next).excluded, true);
  assert.deepEqual(calls, ['first']); assert.equal(h.reads.installation, 1);
});

test('stored public competition metadata retains Arab country evidence and strips credentials and extra nested fields', t => {
  scope(t, 'focused');
  const safe = storedEvent(goal('arab-data', { ...ARAB, token: 'must-not-persist', country: {
    ...ARAB.country, authorization: 'must-not-persist', nested: { secret: 'must-not-persist' } } }));
  assert.deepEqual(safe.competition, ARAB);
  assert.equal(isEventAllowed(safe), true);
  assert.equal(JSON.stringify(safe).includes('must-not-persist'), false);
});

test('restart restoration removes old excluded and unknown retries while retaining strong legacy codes and complete Arab metadata', async t => {
  scope(t, 'all');
  const h = harness();
  const ledger = createPushDeliveryLedger(h.database, { now: h.now });
  const events = [goal('excluded-old', EXCLUDED), goal('unknown-old', undefined, { competition: undefined, tournament: 'Premier League' }),
    goal('minor-old', { name: 'I-League', country: 'India' }),
    goal('major-legacy', undefined, { competition: undefined, competitionCode: 'PL' }), goal('arab-new', ARAB)]
    .map(event => ({ ...event, type: 'card', cardType: 'red' }));
  for (const event of events) await ledger.queued(h.keyFor(h.device, event), {
    device: { userId: h.device.userId, deviceId: h.device.deviceId }, event, retryIndex: 0, nextAt: NOW, expiresAt: NOW + 300000,
  });
  process.env.SPORTS_COMPETITION_SCOPE = 'focused';
  assert.deepEqual(await h.create().flushRetries(), { attempted: 2, queued: 0 });
  assert.deepEqual(h.calls.map(event => event.eventId).sort(), ['arab-new', 'major-legacy']);
  const records = [...h.records].filter(([key]) => key.startsWith('notificationDeliveries/'));
  assert.equal(records.length, 2); assert.ok(records.every(([, record]) => record.status === 'accepted'));
});

test('already delivered historical receipts and installation follows survive later competition exclusion', async t => {
  scope(t, 'all');
  const h = harness(), event = goal('accepted-before-scope', EXCLUDED);
  assert.equal((await h.service.deliver(h.device, event)).sent, true);
  const preferences = structuredClone(h.device.preferences);
  process.env.SPORTS_COMPETITION_SCOPE = 'focused';
  assert.equal((await h.service.deliver(h.device, event)).excluded, true);
  assert.equal(h.calls.length, 1);
  const records = [...h.records].filter(([key]) => key.startsWith('notificationDeliveries/'));
  assert.equal(records.length, 1); assert.equal(records[0][1].status, 'accepted');
  assert.deepEqual(h.device.preferences, preferences);
});

test('all mode preserves delivery and persisted retries for excluded and unknown competitions', async t => {
  scope(t, 'all');
  const calls = [];
  const h = harness({ send: async (_, __, ___, details) => {
    calls.push(details.event.eventId); return calls.length <= 2 ? { sent: false, retryable: true } : { sent: true };
  } });
  await h.service.deliver(h.device, goal('all-israel', EXCLUDED, { type: 'card', cardType: 'red' }));
  await h.service.deliver(h.device, goal('all-unknown', undefined, { competition: undefined, type: 'card', cardType: 'red' }));
  h.advance(30001);
  assert.deepEqual(await h.create().flushRetries(), { attempted: 2, queued: 0 });
  assert.equal(calls.length, 4);
});
