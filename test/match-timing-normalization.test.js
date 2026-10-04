const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { normalizeMatchTiming } = require('../utils/matchTiming');

function loadProvider(file, response = null) {
  delete require.cache[require.resolve(file)];
  const mocks = {
    axios: { create: () => ({ get: async () => ({ data: response }) }), get: async () => ({ data: response }) },
    './cacheService': { getCached() {}, setCache() {} },
    '../utils/logger': { info() {}, warn() {}, error() {} },
  };
  const original = Module._load;
  const previousToken = process.env.BSD_API_TOKEN;
  process.env.BSD_API_TOKEN = 'test-only-token';
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally {
    Module._load = original;
    if (previousToken === undefined) delete process.env.BSD_API_TOKEN;
    else process.env.BSD_API_TOKEN = previousToken;
  }
}

const bsdEvent = overrides => ({
  id: 1, league_id: 3, home_team_id: 57, home_team: 'Home', away_team_id: 44, away_team: 'Away',
  event_date: '2026-10-01T18:00:00Z', status: 'inprogress', period: '1st_half', current_minute: 17,
  home_score: 0, away_score: 0, home_score_ht: 0, away_score_ht: 0, ...overrides,
});
const sportscoreEvent = overrides => ({
  slug: 'match-1', home: 'Home', away: 'Away', competition: 'La Liga', time: '2026-10-01T18:00:00Z',
  status: 'live', period: '1T', live_minute: 17, home_score: 0, away_score: 0,
  home_ht_score: 0, away_ht_score: 0, ...overrides,
});

test('first-half aliases stay unconfirmed throughout stoppage time', () => {
  for (const alias of ['first_half', '1st_half', '1h', '1t', '1T', 'FIRST_HALF']) {
    for (const minute of [17, 19, 45, 50, '45+5']) {
      const expected = { matchPhase: 'FIRST_HALF', halfTimeConfirmed: false };
      assert.deepEqual(normalizeMatchTiming({ status: alias, minute }), expected);
      assert.deepEqual(normalizeMatchTiming({ status: 'inprogress', period: alias, minute }), expected);
    }
  }
});

test('explicit halftime, later periods and terminal states confirm halftime without a clock', () => {
  for (const [phase, aliases] of [
    ['HALF_TIME', ['ht', 'HT', 'halftime', 'half_time']],
    ['SECOND_HALF', ['second_half', '2nd_half', '2h', '2t', '2T']],
    ['EXTRA_TIME', ['extra_time', 'extra_time_first_half', 'extra_time_second_half', 'ET']],
    ['PENALTIES', ['penalties', 'penalty_shootout']],
    ['FULL_TIME', ['finished', 'ft', 'aet', 'pen', 'FULL_TIME']],
  ]) {
    for (const alias of aliases) {
      const expected = { matchPhase: phase, halfTimeConfirmed: true };
      assert.deepEqual(normalizeMatchTiming({ status: alias }), expected);
      assert.deepEqual(normalizeMatchTiming({ status: 'live', period: alias }), expected);
    }
  }
});

test('a clock or an unspecified pause never proves halftime; a specific status beats a stale period', () => {
  for (const status of ['live', 'IN_PLAY', 'paused', 'PAUSED', 'suspended', 'cancelled', undefined]) {
    for (const minute of [46, 90, 120, '90+9']) {
      assert.deepEqual(normalizeMatchTiming({ status, minute }), { matchPhase: 'UNKNOWN', halfTimeConfirmed: false });
    }
  }
  assert.deepEqual(normalizeMatchTiming({ status: 'paused', period: 'HT', minute: 45 }),
    { matchPhase: 'HALF_TIME', halfTimeConfirmed: true });
  assert.deepEqual(normalizeMatchTiming({ status: '1st_half', period: 'HT', minute: 50 }),
    { matchPhase: 'FIRST_HALF', halfTimeConfirmed: false });
  assert.deepEqual(normalizeMatchTiming({ status: '2nd_half', period: '1T', minute: 46 }),
    { matchPhase: 'SECOND_HALF', halfTimeConfirmed: true });
  for (const status of ['finished', 'aet', 'pen']) {
    assert.deepEqual(normalizeMatchTiming({ status, period: '1T', minute: 17 }),
      { matchPhase: 'FULL_TIME', halfTimeConfirmed: true });
  }
  for (const status of ['notstarted', 'not_started', 'upcoming', 'TIMED']) {
    assert.deepEqual(normalizeMatchTiming({ status, period: '2T', minute: 90 }),
      { matchPhase: 'NOT_STARTED', halfTimeConfirmed: false });
  }
});

test('BSD hides running first-half HT fields while preserving the live score and raw period', () => {
  const provider = loadProvider('../services/bsdSportsService');
  for (const raw of [
    bsdEvent(),
    bsdEvent({ current_minute: 19, home_score: 1, home_score_ht: 1 }),
    bsdEvent({ status: '1st_half', period: '1T', current_minute: 50, home_score: 1, home_score_ht: 1 }),
    bsdEvent({ status: '1h', period: 'HT', current_minute: 45 }),
  ]) {
    const match = provider.normalizeMatch(raw);
    assert.equal(match.status, 'IN_PLAY');
    assert.equal(match.period, raw.period);
    assert.equal(match.matchPhase, 'FIRST_HALF');
    assert.equal(match.halfTimeConfirmed, false);
    assert.equal(match.score.halfTime, null);
    assert.deepEqual(match.score.fullTime, { home: raw.home_score, away: raw.away_score });
  }
});

test('invalidated or suspended fixtures cannot certify halftime from a stale period or clock', () => {
  for (const status of ['cancelled', 'canceled', 'postponed', 'suspended', 'abandoned', ' SUSPENDED ']) {
    for (const period of ['HT', '2T', 'extra_time', 'FT']) {
      assert.deepEqual(normalizeMatchTiming({ status, period, minute: 120 }),
        { matchPhase: 'UNKNOWN', halfTimeConfirmed: false });
    }
  }
});

test('both providers hide historical HT fields when a fixture lifecycle becomes uncertain', () => {
  const bsd = loadProvider('../services/bsdSportsService');
  const sportscore = loadProvider('../services/sportscoreService');
  for (const status of ['cancelled', 'canceled', 'postponed', 'suspended', 'abandoned']) {
    const matches = [
      bsd.normalizeMatch(bsdEvent({ status, period: 'HT', current_minute: 90 })),
      sportscore.normalizeMatch(sportscoreEvent({ status, period: '2T', live_minute: 90 })),
    ];
    for (const match of matches) {
      assert.equal(match.matchPhase, 'UNKNOWN');
      assert.equal(match.halfTimeConfirmed, false);
      assert.equal(match.score.halfTime, null);
      assert.deepEqual(match.score.fullTime, { home: 0, away: 0 });
    }
  }
});

test('BSD exposes confirmed zero halftime scores and keeps missing or malformed sides unknown', () => {
  const provider = loadProvider('../services/bsdSportsService');
  for (const changes of [
    { status: 'half_time', period: 'HT' },
    { status: 'inprogress', period: '2T', current_minute: 46 },
    { status: 'extra_time', period: 'ET' },
    { status: 'penalties', period: 'penalty_shootout' },
    { status: 'finished', period: '1T' },
    { status: 'aet', period: '' },
    { status: 'pen', period: '' },
  ]) {
    const match = provider.normalizeMatch(bsdEvent(changes));
    assert.equal(match.halfTimeConfirmed, true);
    assert.deepEqual(match.score.halfTime, { home: 0, away: 0 });
  }
  const missing = provider.normalizeMatch(bsdEvent({ status: 'finished', home_score_ht: null, away_score_ht: '0' }));
  assert.deepEqual(missing.score.halfTime, { home: null, away: 0 });
  const malformed = provider.normalizeMatch(bsdEvent({ status: 'finished', home_score_ht: false, away_score_ht: -1 }));
  assert.deepEqual(malformed.score.halfTime, { home: null, away: null });
  const paused = provider.normalizeMatch(bsdEvent({ status: 'paused', period: '', current_minute: 90 }));
  assert.equal(paused.matchPhase, 'UNKNOWN');
  assert.equal(paused.score.halfTime, null);
});

test('SportScore fixture and detail normalization follow the same halftime contract and preserve live scores', () => {
  const provider = loadProvider('../services/sportscoreService');
  for (const status of ['live', 'inprogress', '1st_half', '1T']) {
    const raw = sportscoreEvent({ status, live_minute: 50, home_score: 1, home_ht_score: 1 });
    const match = provider.normalizeMatch(raw);
    assert.equal(match.status, 'IN_PLAY');
    assert.equal(match.period, '1T');
    assert.equal(match.matchPhase, 'FIRST_HALF');
    assert.equal(match.halfTimeConfirmed, false);
    assert.equal(match.score.halfTime, null);
    assert.deepEqual(match.score.fullTime, { home: 1, away: 0 });
    assert.equal(provider.normalizeMatchDetail(raw, 'match-1').score.halfTime, null);
  }
  for (const raw of [
    sportscoreEvent({ status: 'half_time', period: 'HT' }),
    sportscoreEvent({ status: 'live', period: '2nd_half', live_minute: 46 }),
    sportscoreEvent({ status: '2T', period: '1T' }),
    sportscoreEvent({ status: 'penalty_shootout', period: 'penalties' }),
    sportscoreEvent({ status: 'finished', period: '1T' }),
  ]) {
    const match = provider.normalizeMatch(raw);
    assert.equal(match.halfTimeConfirmed, true);
    assert.deepEqual(match.score.halfTime, { home: 0, away: 0 });
    assert.equal(provider.normalizeMatchDetail(raw, 'match-1').halfTimeConfirmed, true);
  }
  const missing = provider.normalizeMatch(sportscoreEvent({ status: 'finished', home_ht_score: '0', away_ht_score: null }));
  assert.deepEqual(missing.score.halfTime, { home: 0, away: null });
  const paused = provider.normalizeMatch(sportscoreEvent({ status: 'paused', period: '', live_minute: 90 }));
  assert.equal(paused.score.halfTime, null);
});

test('BSD incidents preserve timing metadata and raw period-summary text without turning flags into booleans', async () => {
  const provider = loadProvider('../services/bsdSportsService', { event_id: 1, incidents: [
    { id: 1, type: 'period', minute: 45, period: '1T', period_second: 2700, text: 'First half', is_live: true },
    { id: 2, type: 'goal', minute: 46, period: '2T', period_second: 0, text: 'Goal', is_live: false },
    { id: 3, type: 'period', minute: 90, period: '2T', text: 'Second half', is_live: 'false' },
  ] });
  const incidents = await provider.getMatchTimeline('bsd_1');
  assert.equal(incidents.length, 3);
  assert.equal(incidents[0].period, '1T');
  assert.equal(incidents[0].periodSecond, 2700);
  assert.equal(incidents[0].label, 'First half');
  assert.equal(incidents[0].text, 'First half');
  assert.equal(incidents[0].isLive, true);
  assert.equal(incidents[1].type, 'goal');
  assert.equal(incidents[1].periodSecond, 0);
  assert.equal(incidents[1].isLive, false);
  assert.equal(Object.hasOwn(incidents[2], 'isLive'), false);
});

test('SportScore named phase text supplies evidence when the live status and period are generic', () => {
  const provider = loadProvider('../services/sportscoreService');
  for (const [statusText, matchPhase, confirmed] of [
    ['1st half', 'FIRST_HALF', false], ['2nd half', 'SECOND_HALF', true],
    ['Half time', 'HALF_TIME', true], ['Live', 'UNKNOWN', false],
  ]) {
    const match = provider.normalizeMatch(sportscoreEvent({ status: 'live', period: '',
      status_text: statusText, live_minute: null, home_score: 2, home_ht_score: 1 }));
    assert.equal(match.matchPhase, matchPhase);
    assert.equal(match.halfTimeConfirmed, confirmed);
    assert.deepEqual(match.score.fullTime, { home: 2, away: 0 });
    assert.deepEqual(match.score.halfTime, confirmed ? { home: 1, away: 0 } : null);
    assert.equal(match.minute, null);
  }
  assert.deepEqual(normalizeMatchTiming({ status: '1st_half', period: '', statusText: 'Half time' }),
    { matchPhase: 'FIRST_HALF', halfTimeConfirmed: false });
  assert.deepEqual(normalizeMatchTiming({ status: 'live', period: '1T', statusText: '2nd half' }),
    { matchPhase: 'FIRST_HALF', halfTimeConfirmed: false });
  assert.deepEqual(normalizeMatchTiming({ status: 'cancelled', period: '', statusText: 'Half time' }),
    { matchPhase: 'UNKNOWN', halfTimeConfirmed: false });
});
