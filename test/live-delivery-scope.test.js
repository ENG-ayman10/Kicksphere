const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveRecipientPolicy } = require('../utils/liveDeliveryScope');

test('normal runtime keeps subscribed delivery without a local restriction', () => {
  assert.equal(createLiveRecipientPolicy({})('offline_user'), true);
});

test('explicit local scope is exact and fails closed when empty', () => {
  const scoped = createLiveRecipientPolicy({ LOCAL_LIVE_PUSH_USER_IDS: 'offline_u1, offline_u2' });
  assert.equal(scoped('offline_u1'), true);
  assert.equal(scoped('offline_u2'), true);
  assert.equal(scoped('offline_u1_other'), false);
  assert.equal(scoped(undefined), false);
  assert.equal(createLiveRecipientPolicy({ LOCAL_LIVE_PUSH_USER_IDS: '' })('offline_u1'), false);
});
