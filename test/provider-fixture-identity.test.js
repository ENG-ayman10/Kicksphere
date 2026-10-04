const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const captured = require('./fixtures/provider-fixture-seattle-2026-10-02.json');

function merge() {
  delete require.cache[require.resolve('../services/sportsDataService')];
  const original = Module._load;
  const mocks = { './sportscoreService': {}, './bsdSportsService': {}, './kickoffApiService': {},
    '../utils/logger': { warn() {}, error() {}, info() {} } };
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require('../services/sportsDataService').mergeProviderFixtures; }
  finally { Module._load = original; }
}
const clone = value => structuredClone(value);
const rows = () => [clone(captured.preferred), clone(captured.supplement)];

test('captured Seattle duplicate retains one whole preferred fixture and both exact provider identities', () => {
  const [preferred, supplement] = rows();
  const merged = merge()([preferred], [supplement]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, preferred.id);
  assert.equal(merged[0].homeTeam, preferred.homeTeam);
  assert.equal(merged[0].awayTeam, preferred.awayTeam);
  assert.equal(merged[0].score, preferred.score);
  assert.equal(merged[0].utcDate, preferred.utcDate);
  assert.deepEqual(merged[0].providerIdentities, [
    { id: preferred.id, provider: 'bsd', utcDate: preferred.utcDate, competitionCode: 'MLS', homeTeamId: 'bsd_t_302', awayTeamId: 'bsd_t_299' },
    { id: supplement.id, provider: 'sportscore', utcDate: supplement.utcDate, competitionCode: 'MLS', homeTeamId: 'sc_t_seattle-sounders', awayTeamId: 'sc_t_sporting-kansas-city' },
  ]);
  assert.equal(preferred.providerIdentities, undefined);
  assert.equal(supplement.providerIdentities, undefined);
});

test('fresh preferred source can be SportScore while BSD remains an alternate', () => {
  const [bsd, sc] = rows();
  const result = merge()([sc], [bsd]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, sc.id);
  assert.equal(result[0].providerIdentities[0].provider, 'sportscore');
  assert.equal(result[0].providerIdentities[1].id, bsd.id);
});

test('verified identities join independently of changing scores or status', () => {
  const [bsd, sc] = rows();
  sc.status = 'IN_PLAY'; sc.score.fullTime = { home: 0, away: 0 };
  const result = merge()([bsd], [sc]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].score.fullTime, { home: 2, away: 1 });
});

test('an unknown ID or a guessed FC suffix never supplies a verified participant mapping', () => {
  for (const change of [row => { row.homeTeam.id = 'sc_t_seattle-other'; },
    row => { row.homeTeam.name = 'Seattle Sounders FC U21'; },
    row => { row.awayTeam.id = 'sc_t_other-kansas-city'; }]) {
    const [bsd, sc] = rows(); change(sc);
    assert.equal(merge()([bsd], [sc]).length, 2);
  }
});

test('verified MLS pair needs matching orientation, competition and at most observed ten-minute drift', () => {
  for (const change of [row => { [row.homeTeam, row.awayTeam] = [row.awayTeam, row.homeTeam]; },
    row => { row.competition.code = 'SC:cup'; },
    row => { row.utcDate = '2026-10-02T01:40:00.001Z'; },
    row => { row.utcDate = '2026-10-03T01:30:00Z'; },
    row => { row.utcDate = '2026-10-02'; }]) {
    const [bsd, sc] = rows(); change(sc);
    assert.equal(merge()([bsd], [sc]).length, 2);
  }
});

test('gender, youth, reserves, nationality and conflicting competition scope prevent alias matching', () => {
  const changes = [row => { row.competition.isWomen = true; }, row => { row.homeTeam.gender = 'female'; },
    row => { row.homeTeam.ageGroup = 'U21'; }, row => { row.awayTeam.isReserve = true; },
    row => { row.homeTeam.type = 'national'; }, row => { row.homeTeam.country = 'Canada'; },
    row => { row.competition.country = 'Canada'; }, row => { row.homeTeam.identityCompetitionCode = 'PL'; },
    row => { row.homeTeam.provider = 'bsd'; }];
  for (const change of changes) {
    const [bsd, sc] = rows(); change(sc);
    assert.equal(merge()([bsd], [sc]).length, 2);
  }
});

test('two distinct same-provider fixture IDs make the cross-provider match ambiguous', () => {
  const [bsd, sc] = rows();
  const otherSc = { ...sc, id: 'another-seattle-fixture' };
  const otherBsd = { ...bsd, id: 'bsd_209463' };
  assert.equal(merge()([bsd], [sc, otherSc]).length, 3);
  assert.equal(merge()([bsd, otherBsd], [sc]).length, 3);
  assert.equal(merge()([bsd], [otherBsd]).length, 2);
  assert.equal(merge()([], [sc, otherSc]).length, 2);
});

test('exact duplicate join also preserves subscription identities, without widening kickoff matching', () => {
  const [bsd, sc] = rows();
  // These are unrelated provider identities; only the existing exact fixture-context rule applies.
  bsd.homeTeam = { ...bsd.homeTeam, id: 'bsd_t_500', name: 'First club' };
  sc.homeTeam = { ...sc.homeTeam, id: 'sc_t_first-club', name: 'First club' };
  bsd.awayTeam = { ...bsd.awayTeam, id: 'bsd_t_501', name: 'Second club' };
  sc.awayTeam = { ...sc.awayTeam, id: 'sc_t_second-club', name: 'Second club' };
  sc.utcDate = '2026-10-02T01:30:00Z';
  const result = merge()([bsd], [sc]);
  assert.equal(result.length, 1);
  assert.equal(result[0].providerIdentities[1].id, sc.id);
  sc.utcDate = '2026-10-02T01:30:01Z';
  assert.equal(merge()([bsd], [sc]).length, 2);
});

test('exact names do not erase distinct same-provider IDs or conflicting participant classes', () => {
  const [bsd, sc] = rows(); sc.homeTeam.name = bsd.homeTeam.name; sc.utcDate = bsd.utcDate;
  const anotherBsd = { ...bsd, id: 'bsd_209463' };
  assert.equal(merge()([bsd], [anotherBsd]).length, 2);
  sc.homeTeam.gender = 'female';
  assert.equal(merge()([bsd], [sc]).length, 2);
  delete sc.homeTeam.gender;
  sc.homeTeam.country = 'Canada';
  bsd.homeTeam.country = 'USA';
  assert.equal(merge()([bsd], [sc]).length, 2);
});

test('provider identities are complete, validated, immutable and idempotent across repeated joins', () => {
  const [bsd, sc] = rows();
  const join = merge(); const first = join([bsd], [sc]); const second = join(first, [sc, sc]);
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].providerIdentities, first[0].providerIdentities);
  const invalid = { ...sc, homeTeam: { ...sc.homeTeam, id: null } };
  assert.equal(join([bsd], [invalid]).length, 2);
});
