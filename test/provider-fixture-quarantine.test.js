const test = require('node:test');
const assert = require('node:assert/strict');
const { selectMatchesInInterval } = require('../utils/matchCalendar');
const { mergeProviderFixtures } = require('../utils/providerFixtureIdentity');
const { validatedProviderIdentities } = require('../utils/matchProviderIdentities');
const captured = require('./fixtures/provider-fixture-stale-lippstadt-2026-10-10.json');
const clone = value => structuredClone(value);
const select = rows => selectMatchesInInterval(rows, Date.parse('2026-09-19T00:00:00Z'), Date.parse('2026-09-25T00:00:00Z'));

test('both audited stale schedule records are quarantined without changing source data or creating identities', () => {
  const stale = clone(captured.stale), before = clone(stale);
  const selected = select(stale);
  assert.deepEqual(selected.data, []);
  assert.equal(selected.invalidRecords, 2);
  assert.equal(selected.outsideInterval, 0);
  assert.deepEqual(mergeProviderFixtures([], selected.data), []);
  assert.deepEqual(stale, before);
  for (const row of stale) {
    assert.equal(row.homeTeam.id, null);
    assert.equal(row.awayTeam.id, null);
    assert.equal(row.providerIdentities, undefined);
    assert.deepEqual(validatedProviderIdentities(row), []);
  }
});

test('corrected date, status, identity or scope escapes the observation-specific quarantine', () => {
  const changes = [
    row => { row.utcDate = '2026-09-19T13:00:00Z'; },
    row => { row.utcDate = '2026-09-20T13:00:01Z'; },
    row => { row.status = 'FINISHED'; },
    row => { row.sourceStatus = 'postponed'; },
    row => { row.statusText = 'Delayed'; },
    row => { row.matchPhase = 'FULL_TIME'; },
    row => { row.minute = 1; },
    row => { row.halfTimeConfirmed = true; },
    row => { row.score.fullTime.home = 0; },
    row => { row.score.halfTime = { home: 0, away: 0 }; },
    row => { row.id = 'another-lippstadt-fixture'; },
    row => { row.matchLocator.token = 'another-token'; },
    row => { row.provider = 'bsd'; },
    row => { row.source = 'bsd'; },
    row => { row.competition.id = 'SC:another-competition'; },
    row => { row.competition.code = 'SC:another-competition'; },
    row => { row.competition.name = 'German Regional Cup'; },
    row => { row.competition.country = 'Germany'; },
    row => { row.competition.provider = 'bsd'; },
    row => { row.homeTeam.name = 'SV Lippstadt 08'; },
    row => { row.awayTeam.name = 'ASC Dortmund'; },
    row => { [row.homeTeam, row.awayTeam] = [row.awayTeam, row.homeTeam]; },
    row => { row.homeTeam.id = 'sc_t_sv-lippstadt'; },
    row => { row.awayTeam.providerId = 'asc-dortmund'; },
    row => { row.homeTeam.source = 'bsd'; },
    row => { row.awayTeam.ageGroup = 'U21'; },
    row => { row.homeTeam.isWomen = true; },
    row => { row.awayTeam.isReserve = true; },
    row => { row.competition.type = 'youth'; },
    row => { row.round = 7; }, row => { row.stage = 'regular-season'; },
    row => { row.group = 'Westfalen'; }, row => { row.leg = 1; }, row => { row.seasonId = 2026; },
    row => { row.providerIdentities = []; },
  ];
  for (const original of captured.stale) {
    for (const change of changes) {
      const row = clone(original); change(row);
      const before = clone(row), selected = select([row]);
      assert.equal(selected.data.length, 1, `${original.id}: ${change}`);
      assert.strictEqual(selected.data[0], row);
      assert.equal(selected.invalidRecords, 0);
      assert.deepEqual(row, before);
    }
  }
});

test('the third delayed provider record and other same-named fixtures remain complete original DTOs', () => {
  const later = clone(captured.otherProviderRecord.normalized);
  const another = { ...clone(captured.stale[0]), id: 'other-observed-lippstadt-route' };
  const inputs = [...clone(captured.stale), another, later], before = clone(inputs);
  const selected = select(inputs);
  assert.deepEqual(selected.data, [another, later]);
  assert.strictEqual(selected.data[0], another);
  assert.strictEqual(selected.data[1], later);
  assert.equal(selected.invalidRecords, 2);
  assert.deepEqual(inputs, before);
  const rows = mergeProviderFixtures([], selected.data);
  assert.deepEqual(rows, [another, later]);
  for (const row of rows) {
    assert.equal(row.providerIdentities, undefined);
    assert.deepEqual(validatedProviderIdentities(row), []);
  }
});
