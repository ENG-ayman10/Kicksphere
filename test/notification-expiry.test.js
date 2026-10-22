'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NOTIFICATION_TTL_MS, notificationObservedAt, notificationExpiresAt } = require('../utils/notificationExpiry');
const NOW = Date.parse('2026-10-22T12:00:00Z');

test('notification clocks support Date, numeric, ISO and Firestore timestamps without mutating the event', () => {
  for (const createdAt of [new Date(NOW - 1000), NOW - 1000, new Date(NOW - 1000).toISOString(), { toMillis: () => NOW - 1000 }]) {
    const event = Object.freeze({ createdAt });
    assert.equal(notificationObservedAt(event, NOW), NOW - 1000);
    assert.equal(notificationExpiresAt(event, NOW), NOW + NOTIFICATION_TTL_MS - 1000);
  }
});

test('malformed timestamps use valid emittedAt before the caller clock and future dates cannot extend the TTL', () => {
  for (const createdAt of [undefined, null, '', 'invalid', new Date(NaN), { toMillis() { throw new Error('bad timestamp'); } }]) {
    const event = { createdAt, emittedAt: NOW - 1000 };
    assert.equal(notificationObservedAt(event, NOW), NOW - 1000);
    assert.equal(notificationExpiresAt(event, NOW), NOW + NOTIFICATION_TTL_MS - 1000);
  }
  assert.equal(notificationObservedAt({}, NOW), NOW);
  assert.equal(notificationObservedAt({}, NaN), NaN);
  assert.equal(notificationExpiresAt({ createdAt: new Date(NOW + 86400000) }, NOW), NOW + NOTIFICATION_TTL_MS);
  assert.equal(notificationExpiresAt({ createdAt: NOW }, NOW, NOW + 500), NOW + 500);
});

test('reminder lifetime is bounded by kickoff while malformed optional dates remain harmless', () => {
  assert.equal(notificationExpiresAt({ type: 'matchReminder', createdAt: NOW, utcDate: NOW + 750 }, NOW), NOW + 750);
  assert.equal(notificationExpiresAt({ type: 'matchReminder', createdAt: NOW, utcDate: 'invalid' }, NOW), NOW + NOTIFICATION_TTL_MS);
  assert.equal(notificationExpiresAt(null, NOW), NOW + NOTIFICATION_TTL_MS);
});
