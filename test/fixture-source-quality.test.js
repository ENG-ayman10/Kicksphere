const test = require('node:test');
const assert = require('node:assert/strict');
const { getFixtureSourceConflict, requiresFixtureSourceReview } = require('../utils/fixtureSourceQuality');
const observed = { provider: 'bsd', id: 'bsd_223136', competitionId: 65, seasonId: 1633,
  homeTeamId: 668, awayTeamId: 2293, utcDate: '2026-10-05T18:00:00.000Z', status: 'TIMED' };
test('only the exact reviewed scheduled tuple is quarantined with official evidence', () => {
  const result = getFixtureSourceConflict(observed);
  assert.equal(result.reason, 'official_schedule_conflict');
  assert.ok(result.sourceUrl.startsWith('https://www.concacaf.com/'));
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.equal(result.id, observed.id);
  assert.equal(Object.hasOwn(result, 'replacementId'), false);
  assert.equal(Object.hasOwn(result, 'status'), false);
});
test('a source correction, other identity, season, competition or actual status remains eligible', () => {
  for (const change of [{ provider: 'sportscore' }, { id: 'bsd_602460' }, { competitionId: 31 },
    { seasonId: 1634 }, { homeTeamId: 2293 }, { awayTeamId: 681 },
    { utcDate: '2026-10-06T00:00:00.000Z' }, { status: 'IN_PLAY' },
    { status: 'FINISHED' }, { status: 'CANCELLED' }]) {
    assert.equal(getFixtureSourceConflict({ ...observed, ...change }), null);
  }
  assert.equal(requiresFixtureSourceReview('bsd', 'bsd_223136'), true);
  assert.equal(requiresFixtureSourceReview('bsd', 'bsd_602460'), false);
});
