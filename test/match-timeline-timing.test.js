const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { filterPresentedTimeline } = require('../utils/matchTimelineTiming');

const live = (period, minute, extra = {}) => ({ status: 'IN_PLAY', period, minute, ...extra });
const period = (label, minute) => ({ type: 'period', label, minute });
const goal = { type: 'goal', minute: 20, side: 'home' };

test('BSD first-half summary at 45 is hidden while the actual goal stays visible ahead of a delayed clock', () => {
  const rows = [period('First half', 45), goal];
  assert.deepEqual(filterPresentedTimeline(rows, live('1T', 12)), [goal]);
  assert.equal(rows.length, 2, 'Provider timeline is retained unchanged');
  assert.deepEqual(filterPresentedTimeline([period('First half', 45)], live('1st_half', 50)), []);
});

test('first-half added time does not certify halftime; a real halftime phase does', () => {
  const rows = [period('HT', 45), period('FT', 90), goal];
  assert.deepEqual(filterPresentedTimeline(rows, live('1st_half', 48)), [goal]);
  assert.deepEqual(filterPresentedTimeline(rows, { status: 'PAUSED', period: 'HT', minute: 45 }), [rows[0], goal]);
  assert.deepEqual(filterPresentedTimeline(rows, live('2T', 46)), [rows[0], goal]);
  assert.deepEqual(filterPresentedTimeline(rows, { status: 'PAUSED', period: 'HT', minute: 12 }), [rows[0], goal],
    'Confirmed phase beats a lagging clock');
});

test('completed regulation is retained in extra time or penalties without guessing a 120-minute finish', () => {
  const rows = [period('FT', 90), period('Second half', 90), period('FT', 120), period('FT', null)];
  for (const phase of ['extra_time', 'penalty_shootout']) {
    assert.deepEqual(filterPresentedTimeline(rows, live(phase, null)), rows.slice(0, 2));
  }
  assert.deepEqual(filterPresentedTimeline(rows, { status: 'FINISHED', minute: null }), rows);
});

test('generic labels do not hide the original period metadata and unknown phases do not confirm a whistle', () => {
  const row = { ...period('period', 50), period: '1T' };
  assert.deepEqual(filterPresentedTimeline([row], live('first_half', 51)), []);
  assert.deepEqual(filterPresentedTimeline([period('HT', 45)], live('', null)), []);
});

test('specific lifecycle updates override cached phase evidence without removing football incidents', () => {
  const rows = [period('HT', 45), goal];
  for (const status of ['CANCELLED', 'POSTPONED', 'SUSPENDED']) {
    assert.deepEqual(filterPresentedTimeline(rows, { status, matchPhase: 'SECOND_HALF', halfTimeConfirmed: true }), [goal]);
  }
  assert.deepEqual(filterPresentedTimeline(rows, { status: 'FINISHED', matchPhase: 'FIRST_HALF', minute: 12 }), rows);
});

test('full-time boundary stays hidden through second-half stoppage and remains visible after confirmed finish', () => {
  const rows = [period('Second half', 90), period('FT', 90)];
  assert.deepEqual(filterPresentedTimeline(rows, live('2nd_half', 94)), []);
  assert.deepEqual(filterPresentedTimeline(rows, { status: 'FINISHED', minute: null }), rows);
});

test('unknown clocks do not fabricate a phase or remove real football incidents', () => {
  const rows = [period('Provider marker', 45), goal, { type: 'red_card', minute: 80 }];
  assert.deepEqual(filterPresentedTimeline(rows, live('', null)), rows);
  assert.deepEqual(filterPresentedTimeline(rows, live('', 12)), rows.slice(1));
  assert.deepEqual(filterPresentedTimeline([period('HT', 45), goal], live('first_half', null)), [goal]);
});

test('REST timeline and deep statistics suppress the boundary summary while preserving team and added-time metadata', async () => {
  const file = '../controllers/statsController';
  const match = { id: 'bsd_1', ...live('1T', 12), score: { fullTime: { home: 1, away: 0 } },
    homeTeam: { name: 'Home' }, awayTeam: { name: 'Away' } };
  const timeline = [period('First half', 45), { ...goal, addedTime: 2, periodSecond: 16 }];
  const details = { matchInfo: match, timeline, statistics: [], lineups: null };
  const original = Module._load;
  delete require.cache[require.resolve(file)];
  Module._load = function (name, parent, isMain) {
    if (name === '../services/bsdSportsService') return { isConfigured: () => true, getMatchDetails: async () => details };
    if (name === '../utils/logger') return { info() {}, warn() {}, error() {} };
    if (name === '../services/teamService') return { resolveLocalTeam: () => null };
    if (['../services/sportscoreService', '../services/sportsDataService', '../services/kickoffApiService'].includes(name)) return {};
    return original.call(this, name, parent, isMain);
  };
  let api;
  try { api = require(file); } finally { Module._load = original; }
  const response = () => ({ status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
  const normal = response();
  await api.getMatchTimeline({ params: { id: 'bsd_1' } }, normal);
  assert.equal(normal.body.success, true);
  assert.deepEqual(normal.body.data, [{ ...timeline[1], team: 'Home' }]);
  const deep = response();
  await api.getMatchDeepStats({ params: { id: 'bsd_1' } }, deep);
  assert.equal(deep.body.success, true);
  assert.equal(deep.body.data.timeline.length, 1);
  assert.equal(deep.body.data.timeline[0].periodSecond, 16);
});
