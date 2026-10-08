'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function controller(provider, match, predictionCalls) {
  const fixtureId = provider === 'bsd' ? 'bsd_10' : provider === 'kickoffapi' ? 'ko_10' : 'verified-match-slug';
  const fixture = { id: fixtureId, status: match, homeTeam: { name: 'A' }, awayTeam: { name: 'B' },
    score: { fullTime: { home: 2, away: 1 } }, utcDate: '2026-10-08T18:00:00Z' };
  const mocks = {
    '../services/bsdSportsService': { getMatchDetails: async () => ({ matchInfo: fixture }),
      getPredictionForMatch: async (...args) => { predictionCalls.push(args); return { mostLikelyScore: '1-1' }; } },
    '../services/sportscoreService': { getMatchDetails: async () => provider === 'sportscore' ? fixture : null },
    '../services/kickoffApiService': { getMatchDetails: async () => provider === 'kickoffapi' ? fixture : null },
    '../services/sportsDataService': {}, '../services/teamService': {},
    '../services/cacheService': {}, '../utils/logger': { error() {}, warn() {}, info() {} },
  };
  const original = Module._load, file = require.resolve('../controllers/statsController');
  delete require.cache[file];
  Module._load = function(name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let api;
  try { api = require(file); } finally { Module._load = original; }
  return { api, fixtureId };
}

test('finished, cancelled and unknown matches keep the result and omit optional upstream prediction work for every provider', async () => {
  for (const provider of ['bsd', 'sportscore', 'kickoffapi']) {
    for (const status of ['FINISHED', 'FT', 'AET', 'PEN', 'CANCELLED', 'ABANDONED', 'POSTPONED', 'SUSPENDED', 'unknown']) {
      const calls = [], { api, fixtureId } = controller(provider, status, calls);
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
      await api.getMatchDeepStats({ params: { id: fixtureId } }, res);
      assert.equal(res.body.success, true, provider + ':' + status);
      assert.equal(res.body.data.prediction, null);
      assert.equal(res.body.data.matchInfo.score.fullTime.home, 2);
      assert.equal(calls.length, 0);
    }
  }
});

test('upcoming and active match previews remain available with one lookup, preserving the exact fixture identity', async () => {
  for (const provider of ['bsd', 'sportscore', 'kickoffapi']) {
    for (const status of ['TIMED', 'NS', 'IN_PLAY', 'PAUSED']) {
      const calls = [], { api, fixtureId } = controller(provider, status, calls);
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
      await api.getMatchDeepStats({ params: { id: fixtureId } }, res);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.prediction.mostLikelyScore, '1-1');
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], fixtureId);
    }
  }
});
