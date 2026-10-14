'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createBsdLiveStreamService, FOOTBALL_ENDPOINT, MAX_PAYLOAD_BYTES
} = require('../services/bsdLiveStreamService');

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function fakeClock() {
  let current = 1000000;
  let sequence = 0;
  const tasks = new Map();
  return {
    now: () => current,
    setTimeout(callback, delay) {
      const handle = { id: ++sequence, unref() {} };
      tasks.set(handle.id, { callback, at: current + delay });
      return handle;
    },
    clearTimeout(handle) { tasks.delete(handle.id); },
    async advance(milliseconds) {
      const until = current + milliseconds;
      let iterations = 0;
      while (true) {
        const due = [...tasks].filter(([, task]) => task.at <= until)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        assert.ok(iterations++ < 1000, 'timer callbacks must remain bounded');
        tasks.delete(due[0]);
        current = due[1].at;
        const pending = due[1].callback();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        await settle();
      }
      current = until;
      await settle();
    },
    pendingCount: () => tasks.size,
    nextDelay: () => Math.min(...[...tasks.values()].map((task) => task.at - current))
  };
}

function makeHarness(overrides = {}) {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url, protocols, options) {
      super();
      this.url = url;
      this.protocols = protocols;
      this.options = options;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
    }
    send(message) { this.sent.push(JSON.parse(message)); }
    open() { this.readyState = 1; this.emit('open'); }
    frame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame)), false); }
    remoteClose(code = 1006) { this.readyState = 3; this.emit('close', code); }
    close() { this.closed = true; this.readyState = 3; this.emit('close', 1000); }
    terminate() { this.close(); }
  }
  const clock = fakeClock();
  const received = [];
  const service = createBsdLiveStreamService({
    apiToken: 'private-test-key',
    WebSocketCtor: FakeSocket,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0.5,
    onSnapshot: async (frame, meta) => received.push({ frame, meta }),
    onFrame: async (frame, meta) => received.push({ frame, meta }),
    ...overrides
  });
  return { service, sockets, clock, received };
}

function event(eventId = 42, score = [1, 0], minute = 67) {
  return {
    type: 'event', event_id: eventId,
    home: { id: 301, name: 'Home' }, away: { id: 302, name: 'Away' },
    score: { home: score[0], away: score[1] },
    time: { minute, second: 34, period: 2, status: 'live' }
  };
}

function subscribed(eventId = 42, source = 'full') {
  return {
    type: 'subscribed', event_id: eventId, source,
    event: event(eventId),
    history: [{ type: 'action', event_id: eventId, action_type: 'goal', ts: 100 }],
    livedata: [{ situation: 'goal' }], odds: { value: 3 }
  };
}

function action(eventId = 42, actionType = 'goal', ts = 1000001) {
  return {
    type: 'action', event_id: eventId, action_type: actionType,
    team: 'home', player: { id: 401, name: 'Player' },
    score: { home: 2, away: 0 }, ts, minute: 68, second: 4, period: 2
  };
}

test('transport is opt-in; credentials never enter URL or sanitized status', async () => {
  const { service, sockets, clock } = makeHarness();
  assert.equal(sockets.length, 0);
  service.updateSubscriptions([42]);
  assert.equal(sockets.length, 0);
  assert.equal(service.getStatus().running, false);
  service.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, FOOTBALL_ENDPOINT);
  assert.deepEqual(sockets[0].protocols, ['token', 'private-test-key']);
  assert.equal(sockets[0].options.maxPayload, 65536);
  assert.equal(sockets[0].options.autoPong, true);
  assert.equal(sockets[0].options.perMessageDeflate, false);
  assert.equal(sockets[0].options.handshakeTimeout, 10000);
  const sanitized = JSON.stringify(service.getStatus());
  assert.doesNotMatch(sanitized, /private-test-key|event_id|\[42\]/);
  service.stop();
  await clock.advance(60000);
  assert.equal(sockets.length, 1);
  assert.equal(clock.pendingCount(), 0);
});

test('strict event IDs and pool enforce exactly ten subscriptions per socket, at most four sockets', () => {
  const { service, sockets } = makeHarness({ maxSockets: 99 });
  service.start([...Array.from({ length: 45 }, (_, index) => index + 1), 1, '42', 0, -1, 'bsd_42', '01', 1.5, Infinity]);
  assert.equal(sockets.length, 4);
  for (const socket of sockets) {
    socket.open();
    assert.equal(socket.sent.length, 10);
    assert.ok(socket.sent.every((frame) => frame.action === 'subscribe' && Number.isSafeInteger(frame.event_id)));
  }
  assert.equal(service.getStatus().subscriptionCount, 40);
  assert.equal(service.getStatus().capacityExceededCount, 5);
  assert.equal(service.getStatus().invalidSubscriptionCount, 6);
  service.stop();
});

test('acknowledged baseline precedes live callbacks; only provisional goals reach projection as state hints', async () => {
  const { service, sockets, clock, received } = makeHarness();
  service.start([42]);
  const socket = sockets[0];
  socket.open();
  socket.frame(event());
  socket.frame(action());
  socket.frame(subscribed());
  socket.frame({ type: 'history', event_id: 42, actions: [action()] });
  socket.frame({ type: 'livedata', event_id: 42, situation: 'goal' });
  socket.frame({ type: 'odds', event_id: 42 });
  socket.frame(action(42, 'temp_goal'));
  socket.frame(action(42, 'temp_attempt'));
  socket.frame(action(42, 'temp_save'));
  socket.frame(event(42, [2, 0], 68));
  socket.frame(action());
  await clock.advance(100);
  assert.deepEqual(received.map((item) => item.frame.type), ['subscribed', 'action', 'event', 'action']);
  assert.equal(received[0].meta.baseline, true);
  assert.equal(received[0].meta.live, false);
  assert.equal(received[0].meta.coverage, 'full');
  assert.equal(received[1].meta.baseline, false);
  assert.equal(received[1].meta.live, true);
  assert.equal(received[1].meta.generationId, received[0].meta.generationId);
  assert.equal(received[1].meta.provisional, true);
  assert.equal(received[1].frame.action_type, 'temp_goal');
  assert.equal(received[2].meta.provisional, false);
  assert.equal(service.getStatus().fullCoverageCount, 1);
  assert.equal(service.getStatus().basicCoverageCount, 0);
  service.stop();
});

test('basic coverage accepts confirmed event state but cannot create an action alert', async () => {
  const { service, sockets, clock, received } = makeHarness();
  service.start([42]);
  sockets[0].open();
  sockets[0].frame(subscribed(42, 'basic'));
  sockets[0].frame(action());
  sockets[0].frame(event(42, [2, 0]));
  await clock.advance(40);
  assert.deepEqual(received.map((item) => item.frame.type), ['subscribed', 'event']);
  assert.equal(service.getStatus().basicCoverageCount, 1);
  service.stop();
});

test('transient close reconnects with backoff, resubscribes, and fences old socket frames', async () => {
  const { service, sockets, clock, received } = makeHarness({ reconnectBaseMs: 100, reconnectMaxMs: 400 });
  service.start([42, 43]);
  sockets[0].open();
  sockets[0].frame(subscribed());
  await clock.advance(0);
  const firstGeneration = received[0].meta.generationId;
  sockets[0].remoteClose();
  assert.equal(clock.nextDelay(), 100);
  sockets[0].frame(event(42, [8, 0]));
  await clock.advance(99);
  assert.equal(sockets.length, 1);
  await clock.advance(1);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, [{ action: 'subscribe', event_id: 42 }, { action: 'subscribe', event_id: 43 }]);
  sockets[1].frame(event(42, [3, 0]));
  sockets[1].frame(subscribed());
  sockets[1].frame(event(42, [3, 0]));
  await clock.advance(100);
  assert.equal(received.length, 3);
  assert.equal(received[1].meta.baseline, true);
  assert.notEqual(received[1].meta.generationId, firstGeneration);
  assert.equal(received[2].frame.score.home, 3);
  sockets[1].remoteClose();
  await clock.advance(100);
  sockets[2].remoteClose();
  assert.equal(clock.nextDelay(), 200);
  await clock.advance(200);
  sockets[3].remoteClose();
  assert.equal(clock.nextDelay(), 400);
  service.stop();
});

for (const [code, reason] of [[4401, 'auth'], [4402, 'sub-required'], [4404, 'network']]) {
  test(`fatal close ${code} never retries, including after subscription updates`, async () => {
    const { service, sockets, clock } = makeHarness({ maxSockets: 2 });
    service.start(Array.from({ length: 11 }, (_, index) => index + 1));
    sockets[0].remoteClose(code);
    assert.equal(service.getStatus().running, false);
    assert.equal(service.getStatus().blockedReason, reason);
    assert.ok(sockets[1].closed);
    service.updateSubscriptions([42]);
    await clock.advance(60000);
    assert.equal(sockets.length, 2);
    assert.equal(clock.pendingCount(), 0);
    service.stop();
  });
}

test('fatal error envelopes are handled before close without exposing provider messages', async () => {
  const { service, sockets, clock } = makeHarness();
  service.start([42]);
  sockets[0].open();
  sockets[0].frame({ type: 'error', code: 'subscription_required', message: 'private-test-key secret account text' });
  await clock.advance(60000);
  assert.equal(sockets.length, 1);
  assert.equal(service.getStatus().blockedReason, 'sub-required');
  assert.doesNotMatch(JSON.stringify(service.getStatus()), /private-test-key|secret|account text/);
  service.stop();
});

test('periodic subscription refresh cannot bypass an outstanding reconnect delay', async () => {
  const { service, sockets, clock } = makeHarness({ reconnectBaseMs: 1000 });
  service.start([42]);
  sockets[0].open();
  sockets[0].remoteClose();
  for (let index = 0; index < 5; index += 1) {
    service.updateSubscriptions([42, 43]);
    await clock.advance(100);
  }
  assert.equal(sockets.length, 1);
  assert.equal(clock.nextDelay(), 500);
  await clock.advance(500);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent.map((frame) => frame.event_id), [42, 43]);
  service.stop();
});

test('untrusted error code keys cannot become unsanitized status reasons', async () => {
  const { service, sockets, clock, received } = makeHarness();
  service.start([42]);
  sockets[0].open();
  for (const code of ['toString', '__proto__', 'constructor']) sockets[0].frame({ type: 'error', code });
  sockets[0].frame(subscribed());
  await clock.advance(0);
  assert.equal(service.getStatus().blocked, false);
  assert.equal(service.getStatus().blockedReason, null);
  assert.equal(received.length, 1);
  service.stop();
});

test('subscription replacement unsubscribes and drops removed queued matches before callbacks', async () => {
  const { service, sockets, clock, received } = makeHarness();
  service.start([42, 43]);
  sockets[0].open();
  sockets[0].frame(subscribed());
  sockets[0].frame(event());
  service.updateSubscriptions([43, 44]);
  assert.deepEqual(sockets[0].sent.slice(2), [{ action: 'unsubscribe', event_id: 42 }, { action: 'subscribe', event_id: 44 }]);
  sockets[0].frame(subscribed(42));
  sockets[0].frame(event(42));
  sockets[0].frame(subscribed(44));
  await clock.advance(40);
  assert.deepEqual(received.map((item) => item.meta.eventId), [44]);
  service.updateSubscriptions([]);
  assert.ok(sockets[0].closed);
  assert.equal(service.getStatus().subscriptionCount, 0);
  service.stop();
});

test('unsubscribe and re-subscribe on the same socket fences queued frames from the old subscription', async () => {
  let testRelease;
  const gate = new Promise((resolve) => { testRelease = resolve; });
  const delivered = [];
  let baselines = 0;
  const { service, sockets, clock } = makeHarness({
    onSnapshot: async (frame, metadata) => {
      delivered.push({ frame, metadata });
      baselines += 1;
      if (baselines === 1) await gate;
    },
    onFrame: async (frame, metadata) => delivered.push({ frame, metadata })
  });
  service.start([42, 43]);
  sockets[0].open();
  sockets[0].frame(subscribed());
  await clock.advance(0);
  sockets[0].frame(event(42, [2, 0]));
  service.updateSubscriptions([43]);
  service.updateSubscriptions([42, 43]);
  sockets[0].frame(subscribed());
  sockets[0].frame(event(42, [3, 0]));
  testRelease();
  await settle();
  await clock.advance(30);
  assert.deepEqual(delivered.map((item) => item.frame.type), ['subscribed', 'subscribed', 'event']);
  assert.equal(delivered.at(-1).frame.score.home, 3);
  assert.equal(delivered[0].metadata.generationId, delivered[1].metadata.generationId);
  assert.notEqual(delivered[0].metadata.subscriptionGeneration, delivered[1].metadata.subscriptionGeneration);
  service.stop();
});

test('callbacks stay globally serialized and throttle start times across sockets', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const starts = [];
  let active = 0;
  let maximumActive = 0;
  let clock;
  const harness = makeHarness({
    maxSockets: 2, minCallbackIntervalMs: 25,
    onSnapshot: async () => {
      starts.push(clock.now());
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (starts.length === 1) await gate;
      active -= 1;
    }
  });
  ({ clock } = harness);
  harness.service.start(Array.from({ length: 11 }, (_, index) => index + 1));
  harness.sockets.forEach((socket) => socket.open());
  harness.sockets[0].frame(subscribed(1));
  harness.sockets[1].frame(subscribed(11));
  await clock.advance(20);
  assert.equal(starts.length, 1);
  release();
  await settle();
  await clock.advance(4);
  assert.equal(starts.length, 1);
  await clock.advance(1);
  assert.equal(starts.length, 2);
  assert.equal(starts[1] - starts[0], 25);
  assert.equal(maximumActive, 1);
  harness.service.stop();
});

test('a slow consumer has bounded queue and overflow forces a baseline instead of an incomplete live burst', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, sockets, clock } = makeHarness({ queueLimit: 4, onSnapshot: async () => gate });
  service.start([42]);
  sockets[0].open();
  sockets[0].frame(subscribed());
  await clock.advance(0);
  for (let index = 0; index < 100; index += 1) sockets[0].frame(action(42, 'goal', 100 + index));
  assert.equal(service.getStatus().queuedFrames, 4);
  assert.equal(service.getStatus().droppedFrames, 1);
  assert.ok(sockets[0].closed);
  assert.equal(service.getStatus().acknowledgedCount, 0);
  service.stop();
  release();
  await settle();
  await clock.advance(60000);
  assert.equal(service.getStatus().queuedFrames, 0);
  assert.equal(sockets.length, 1);
});

test('bounded incident de-duplication ignores name enrichment but delivers settled corrections', async () => {
  const { service, sockets, clock, received } = makeHarness({ seenLimit: 16, minCallbackIntervalMs: 0 });
  service.start([42]);
  sockets[0].open();
  sockets[0].frame(subscribed());
  sockets[0].frame(action());
  sockets[0].frame({ ...action(), player: { id: 401, name: 'Enriched Player', photo: 'https://example.com/p.png' } });
  sockets[0].frame(action(42, 'deleted_event'));
  await clock.advance(0);
  assert.deepEqual(received.map((item) => item.frame.action_type || item.frame.type), ['subscribed', 'goal', 'deleted_event']);
  assert.equal(service.getStatus().duplicateFrames, 1);
  for (let index = 0; index < 40; index += 1) {
    sockets[0].frame(action(42, 'card', 3000 + index));
    await clock.advance(0);
  }
  assert.equal(service.getStatus().seenCount, 16);
  service.stop();
});

test('malformed/binary/mismatched/provisional frames are ignored and oversized payload disconnects safely', async () => {
  const { service, sockets, clock, received } = makeHarness();
  service.start([42]);
  sockets[0].open();
  sockets[0].emit('message', Buffer.from('{bad'), false);
  sockets[0].emit('message', Buffer.from('{}'), true);
  sockets[0].frame({ ...subscribed(), event: event(43) });
  sockets[0].frame({ ...subscribed(), source: 'unexpected' });
  sockets[0].frame(subscribed());
  sockets[0].frame({ ...event(), score: { home: -1, away: 0 } });
  sockets[0].frame({ ...action(), ts: null });
  sockets[0].frame(action(999));
  await clock.advance(30);
  assert.equal(received.length, 1);
  sockets[0].emit('message', Buffer.alloc(MAX_PAYLOAD_BYTES + 1, ' '), false);
  assert.ok(sockets[0].closed);
  assert.equal(service.getStatus().reconnectingSockets, 1);
  service.stop();
});

test('stop fences in-flight callbacks and subsequent starts preserve serialization', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let callbacks = 0;
  const { service, sockets, clock } = makeHarness({ onSnapshot: async () => { callbacks += 1; if (callbacks === 1) await gate; } });
  service.start([42]);
  sockets[0].open();
  sockets[0].frame(subscribed());
  await clock.advance(0);
  service.stop();
  sockets[0].frame(event());
  service.start([43]);
  sockets[1].open();
  sockets[1].frame(subscribed(43));
  await clock.advance(20);
  assert.equal(callbacks, 1);
  release();
  await settle();
  await clock.advance(0);
  assert.equal(callbacks, 2);
  assert.equal(service.getStatus().deliveredFrames, 1);
  service.stop();
});

test('callback rejection is counted but never breaks the next callback or exposes exception text', async () => {
  let attempts = 0;
  const { service, sockets, clock } = makeHarness({ onFrame: async () => { attempts += 1; if (attempts === 1) throw new Error('private-test-key'); } });
  service.start([42]);
  sockets[0].open();
  sockets[0].frame(subscribed());
  sockets[0].frame(event(42, [2, 0]));
  sockets[0].frame(event(42, [3, 0]));
  await clock.advance(50);
  assert.equal(attempts, 2);
  assert.equal(service.getStatus().callbackErrors, 1);
  assert.doesNotMatch(JSON.stringify(service.getStatus()), /private-test-key/);
  service.stop();
});

test('rejected baseline callback fences pending live frames and requires a fresh subscription snapshot', async () => {
  let baselineAttempts = 0;
  let liveCallbacks = 0;
  const { service, sockets, clock } = makeHarness({
    reconnectBaseMs: 100,
    onSnapshot: async () => { baselineAttempts += 1; return baselineAttempts !== 1; },
    onFrame: async () => { liveCallbacks += 1; }
  });
  service.start([42]);
  sockets[0].open();
  sockets[0].frame(subscribed());
  sockets[0].frame(event(42, [2, 0]));
  await clock.advance(20);
  assert.equal(liveCallbacks, 0);
  assert.equal(service.getStatus().acknowledgedCount, 0);
  await clock.advance(80);
  sockets[1].open();
  sockets[1].frame(subscribed());
  sockets[1].frame(event(42, [3, 0]));
  await clock.advance(20);
  assert.equal(baselineAttempts, 2);
  assert.equal(liveCallbacks, 1);
  service.stop();
});

test('constructor failures retry at bounded exponential delay with jitter and stop cancels retries', async () => {
  let connections = 0;
  class FailingSocket { constructor() { connections += 1; throw new Error('private-test-key'); } }
  const { service, clock } = makeHarness({ WebSocketCtor: FailingSocket, reconnectBaseMs: 100, reconnectMaxMs: 250, random: () => 1 });
  service.start([42]);
  assert.equal(connections, 1);
  assert.equal(clock.nextDelay(), 120);
  await clock.advance(120);
  assert.equal(clock.nextDelay(), 240);
  await clock.advance(240);
  assert.equal(clock.nextDelay(), 250);
  await clock.advance(250);
  assert.equal(clock.nextDelay(), 250);
  service.stop();
  await clock.advance(10000);
  assert.equal(connections, 4);
});

test('invalid configuration cannot construct a socket', () => {
  for (const apiToken of ['', 'unsafe token', 'token;secret', 'x'.repeat(1025)]) {
    const { service, sockets } = makeHarness({ apiToken });
    const status = service.start([42]);
    assert.equal(status.blockedReason, 'auth');
    assert.equal(status.running, false);
    assert.equal(sockets.length, 0);
  }
});
