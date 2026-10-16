'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { COMPACT_MATCH_STATS_FORMAT, projectMatchStatsPayload } = require('../utils/compactMatchStatsPayload');
const { compactMatchStatsCases } = require('./fixtures/compactMatchStatsCases');

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('only exact stats-v1 negotiates a projected response; legacy and malformed formats retain the same full value', () => {
  const full = freeze(compactMatchStatsCases()[0].full);
  assert.equal(COMPACT_MATCH_STATS_FORMAT, 'stats-v1');
  for (const format of [undefined, null, '', 'full', 'stats', 'STATS-V1', 'stats-v2', ' stats-v1', ['stats-v1'], {}, false]) {
    assert.strictEqual(projectMatchStatsPayload(full, format), full);
  }
});

test('the projection removes only unused copies while preserving every other section and every team field', () => {
  const full = freeze(compactMatchStatsCases()[0].full);
  const projected = projectMatchStatsPayload(full, COMPACT_MATCH_STATS_FORMAT);
  assert.notStrictEqual(projected, full);
  assert.notStrictEqual(projected.matchInfo, full.matchInfo);
  const topOmissions = new Set(['timeline', 'providerStatistics', 'lineups', 'playerStatistics']);
  const infoOmissions = new Set(['timeline', 'providerStatistics', 'lineups', 'head2head']);
  assert.deepEqual(Object.keys(projected), Object.keys(full).filter(key => !topOmissions.has(key)));
  assert.deepEqual(Object.keys(projected.matchInfo), Object.keys(full.matchInfo).filter(key => !infoOmissions.has(key)));
  for (const [key, value] of Object.entries(full)) {
    if (!topOmissions.has(key) && key !== 'matchInfo') assert.strictEqual(projected[key], value, key);
  }
  for (const [key, value] of Object.entries(full.matchInfo)) {
    if (!infoOmissions.has(key)) assert.strictEqual(projected.matchInfo[key], value, 'matchInfo.' + key);
  }
  assert.equal(projected.matchInfo.homeTeam.lineup[0].rating, 8.2);
  assert.equal(projected.matchInfo.homeTeam.bench[0].id, 'bsd_p_9');
  assert.deepEqual(projected.futureExtension.timeline, ['preserve unknown nesting']);
});

test('full then compact then full cannot delete or replace any field of a frozen cached/provider object', () => {
  const full = freeze(compactMatchStatsCases()[0].full), before = JSON.stringify(full);
  const first = projectMatchStatsPayload(full), compact = projectMatchStatsPayload(full, 'stats-v1');
  compact.matchInfo.id = 'caller-local-id';
  compact.coverage = null;
  compact.goals = [];
  const last = projectMatchStatsPayload(full), unknown = projectMatchStatsPayload(full, 'stats-v2');
  assert.strictEqual(first, full);
  assert.strictEqual(last, full);
  assert.strictEqual(unknown, full);
  assert.equal(JSON.stringify(full), before);
  assert.equal(last.matchInfo.id, 'bsd_42');
  assert.equal(last.lineups.home[0].rating, 8.2);
  assert.equal(last.matchInfo.lineups.home[0].rating, 8.2);
  assert.equal(last.playerStatistics[0].rating, 8.2);
});

test('incidents retain scorer and assist images corrections nulls and unknown values without reclassification', () => {
  const full = freeze(compactMatchStatsCases()[0].full), projected = projectMatchStatsPayload(full, 'stats-v1');
  assert.equal(projected.goals[0].playerImage, 'https://example.test/7.png');
  assert.equal(projected.goals[0].assistImage, 'https://example.test/8.png');
  assert.equal(projected.bookings[0].rescinded, true);
  assert.equal(projected.statistics.team1.totalShots, 3);
  assert.equal(projected.statistics.team2.totalShots, 0);
  assert.equal(projected.statistics.team2.expectedGoals, null);
  assert.equal(projected.statistics.team1.xgEstimated, true);
  assert.equal(projected.statistics.team2.expectedGoalsEstimated, false);
  assert.deepEqual(projected.statistics.yellowCards, { home: null, away: 0 });
  assert.deepEqual(projected.statistics.futureStats, [null, 0]);
  const corrected = projectMatchStatsPayload(freeze(compactMatchStatsCases()[2].full), 'stats-v1');
  assert.deepEqual(corrected.goals, []);
  assert.equal(Object.hasOwn(corrected, 'head2head'), true);
  assert.equal(corrected.head2head, null);
  assert.equal(corrected.prediction, null);
});

test('complete public and canonical identities are preserved without accepting repairing or guessing malformed identities', () => {
  for (const scenario of compactMatchStatsCases().filter(row => !row.shapeOnly)) {
    const full = freeze(scenario.full), compact = projectMatchStatsPayload(full, 'stats-v1');
    for (const field of ['id', 'provider', 'source', 'canonicalMatchId', 'sourceMatchId', 'providerIdentities',
      'utcDate', 'homeTeam', 'awayTeam', 'competition', 'score', 'futureIdentity']) {
      assert.deepEqual(compact.matchInfo[field], full.matchInfo[field], scenario.name + ':' + field);
      assert.equal(Object.hasOwn(compact.matchInfo, field), Object.hasOwn(full.matchInfo, field));
    }
  }
});

test('all advanced plots predictions venue coverage and unknown extensions retain their original values', () => {
  const full = freeze(compactMatchStatsCases()[0].full), compact = projectMatchStatsPayload(full, 'stats-v1');
  for (const field of ['statistics', 'goals', 'bookings', 'substitutions', 'head2head', 'prediction', 'aiPreview',
    'shotMap', 'pressure', 'momentum', 'averagePositions', 'tracker', 'coaches', 'availability', 'coverage',
    'venue', 'venueInfo', 'referees', 'futureExtension']) assert.deepEqual(compact[field], full[field], field);
});

test('malformed containers retain failures and empty values without being normalized into a valid response', () => {
  for (const value of [undefined, null, false, true, 0, 17, '', 'invalid', [], [null], ['stats-v1']]) {
    freeze(value);
    assert.strictEqual(projectMatchStatsPayload(value, 'stats-v1'), value);
  }
  for (const scenario of compactMatchStatsCases().filter(row => row.shapeOnly && row.full && typeof row.full === 'object')) {
    const full = freeze(scenario.full), compact = projectMatchStatsPayload(full, 'stats-v1');
    assert.strictEqual(compact.matchInfo, full.matchInfo, scenario.name);
    assert.strictEqual(compact.statistics, full.statistics, scenario.name);
  }
  for (const matchInfo of [undefined, null, false, 0, 'invalid', []]) {
    const full = freeze({ matchInfo, head2head: null });
    const compact = projectMatchStatsPayload(full, 'stats-v1');
    assert.strictEqual(compact.matchInfo, matchInfo);
    assert.equal(Object.hasOwn(compact, 'matchInfo'), true);
    assert.equal(compact.head2head, null);
  }
  assert.deepEqual(projectMatchStatsPayload({}, 'stats-v1'), {});
  assert.equal(Object.hasOwn(projectMatchStatsPayload({}, 'stats-v1'), 'matchInfo'), false);
});
