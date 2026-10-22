const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotificationDispatchQueue } = require('../utils/notificationDispatchQueue');

const flush = () => new Promise(resolve => setImmediate(resolve));

test('default dispatcher admits at most eight active and 400 pending jobs, applying backpressure without dropping work', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const queue = createNotificationDispatchQueue();
  let active = 0;
  let peak = 0;
  let admitted = 0;
  let completed = 0;
  const tickets = Array.from({ length: 420 }, (_, i) => queue.enqueue(`install-${i}`, async () => {
    peak = Math.max(peak, ++active);
    await blocked;
    active--;
    completed++;
  }).then(ticket => { admitted++; return ticket; }));
  try {
    await flush();
    assert.equal(active, 8);
    assert.equal(admitted, 408);
    assert.equal(completed, 0);
  } finally { release(); }
  await Promise.all((await Promise.all(tickets)).map(ticket => ticket.done));
  assert.equal(admitted, 420);
  assert.equal(completed, 420);
  assert.equal(peak, 8);
});

test('one installation stays serialized while other keys progress, including when work and error reporting throw', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let activeA = 0;
  let peakA = 0;
  const order = [];
  const queue = createNotificationDispatchQueue({ concurrency: 2, maxPending: 2, onError: () => { throw new Error('Logger unavailable'); } });
  const a1 = await queue.enqueue('A', async () => {
    peakA = Math.max(peakA, ++activeA); order.push('A1');
    try { await blocked; throw new Error('Push failed'); } finally { activeA--; }
  });
  const a2 = await queue.enqueue('A', () => {
    peakA = Math.max(peakA, ++activeA); order.push('A2'); activeA--;
  });
  const b = await queue.enqueue('B', () => { order.push('B'); });
  await b.done;
  assert.deepEqual(order, ['A1', 'B']);
  release();
  assert.equal((await a1.done).ok, false);
  assert.equal((await a2.done).ok, true);
  assert.deepEqual(order, ['A1', 'B', 'A2']);
  assert.equal(peakA, 1);
});

test('invalid dispatch arguments fail before accepting a job', async () => {
  assert.throws(() => createNotificationDispatchQueue({ concurrency: 0 }), TypeError);
  const queue = createNotificationDispatchQueue();
  await assert.rejects(queue.enqueue('', () => {}), TypeError);
  await assert.rejects(queue.enqueue('installation', null), TypeError);
});

test('an asynchronously failing error reporter cannot reject the queue or stall the next job', async () => {
  const queue = createNotificationDispatchQueue({ concurrency: 1, onError: async () => { throw new Error('Async logging failure'); } });
  const failed = await queue.enqueue('installation', () => { throw new Error('Sync submission failure'); });
  const next = await queue.enqueue('installation', () => 'next delivered');
  assert.equal((await failed.done).ok, false);
  assert.deepEqual(await next.done, { ok: true, value: 'next delivered' });
  await flush();
});
