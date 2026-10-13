const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('fast score checks do not resend unchanged boards, while real changes and verified empty feeds arrive immediately', async () => {
  const originalLoad = Module._load;
  const originalNow = Date.now;
  let now = 1000;
  let snapshot = { success: true, coverage: { complete: true }, data: [{ id: 'bsd_1', score: { home: 0, away: 0 } }] };
  const provider = { getLiveMatches: async () => snapshot };
  const mocks = { './sportscoreService': provider, './sportsDataService': provider,
    './bsdSportsService': { isConfigured: () => true }, '../utils/logger': { error() {} } };
  delete require.cache[require.resolve('../services/liveService')];
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : originalLoad.call(this, name, parent, isMain);
  };
  let service;
  try { service = require('../services/liveService'); } finally { Module._load = originalLoad; }
  Date.now = () => now;
  const sent = [];
  const io = { emit: (type, data) => sent.push({ type, data }) };
  try {
    assert.equal(await service.emitLiveMatches(io), snapshot, 'every poll still feeds transition detection');
    for (let i = 0; i < 5; i++) { now += 5000; await service.emitLiveMatches(io); }
    assert.equal(sent.length, 1, 'cached boards avoid handset decoding and rebuilds');
    snapshot = { ...snapshot, data: [{ id: 'bsd_1', score: { home: 1, away: 0 } }] };
    await service.emitLiveMatches(io);
    assert.equal(sent.length, 2, 'a score change does not wait for the heartbeat');
    now += 30000;
    await service.emitLiveMatches(io);
    assert.equal(sent.length, 3, 'heartbeat bounds silence for connected clients');
    snapshot = { success: true, coverage: { complete: false }, data: [] };
    await service.emitLiveMatches(io);
    assert.equal(sent.length, 3, 'a partial outage cannot clear an existing board');
    snapshot = { success: true, coverage: { complete: true }, data: [] };
    await service.emitLiveMatches(io);
    assert.deepEqual(sent.at(-1), { type: 'liveMatches', data: [] });
    const lateClient = { emit: (type, data) => sent.push({ type, data }) };
    await service.emitLiveMatches(lateClient);
    assert.equal(sent.length, 5, 'independent Socket servers never share broadcast suppression');
  } finally { Date.now = originalNow; delete require.cache[require.resolve('../services/liveService')]; }
});
