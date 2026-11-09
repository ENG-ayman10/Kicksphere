const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('./fixtures/provider-fixture-tsl-catalog-2026-11-09.json');
const {
  mergeProviderFixtures, findVerifiedCanonicalFixture, verifiedBsdTeamIdForSportScoreTeam,
} = require('../utils/providerFixtureIdentity');
const { validatedProviderIdentities, matchIdentityIds } = require('../utils/matchProviderIdentities');

const clone = value => structuredClone(value);
// Only catalog IDs/names below are captured upstream evidence. Times, scores
// and match IDs are representative test inputs, not new fixture observations.
function fixtures() {
  const [bsdHome, bsdAway] = clone(catalog.bsdTeams);
  const [scHome, scAway] = clone(catalog.sportscoreTeams);
  return [{
    id: 'bsd_216025', provider: 'bsd', source: 'bsd', utcDate: '2026-11-09T17:00:00Z',
    status: 'IN_PLAY', minute: 63,
    competition: { code: 'TSL', name: 'Süper Lig', country: 'Türkiye', countryCode: 'TR' },
    homeTeam: bsdHome, awayTeam: bsdAway,
    score: { fullTime: { home: 1, away: 0 } },
  }, {
    id: 'basaksehir-futbol-kulubu-vs-besiktas-jk965mkyhkd59zr1g',
    provider: 'sportscore', source: 'sportscore', utcDate: '2026-11-09T20:00:00+03:00',
    status: 'IN_PLAY', minute: 62,
    competition: { code: 'TSL', name: 'Süper Lig', country: 'Turkey' },
    homeTeam: { ...scHome, identityBasis: 'competition_standings', identityCompetitionCode: 'TSL' },
    awayTeam: { ...scAway, identityBasis: 'competition_standings', identityCompetitionCode: 'TSL' },
    score: { fullTime: { home: 0, away: 0 } },
  }];
}

test('two-club TSL catalog evidence keeps exact provider IDs, names and scoped query provenance', () => {
  assert.equal(catalog.competitionCode, 'TSL');
  assert.deepEqual(catalog.bsdTeams.map(team => [team.id, team.name]), [
    ['bsd_t_196', 'Beşiktaş JK'], ['bsd_t_194', 'Başakşehir FK'],
  ]);
  assert.deepEqual(catalog.sportscoreTeams.map(team => [team.id, team.name]), [
    ['sc_t_besiktas-jk', 'Besiktas JK'],
    ['sc_t_basaksehir-futbol-kulubu', 'Başakşehir Futbol Kulübü'],
  ]);
  assert.equal(catalog.evidence.bsd.query.league_id, 11);
  assert.equal(catalog.evidence.bsd.query.is_women, false);
  assert.equal(catalog.evidence.sportscore.query.slug, 'turkish-super-league');
});

test('catalog-backed TSL aliases retain one complete native fixture and both validated subscription IDs', () => {
  const [bsd, sc] = fixtures();
  const before = clone([bsd, sc]);
  assert.notEqual(bsd.awayTeam.name, sc.awayTeam.name);
  const merged = mergeProviderFixtures([bsd], [sc]);
  assert.equal(merged.length, 1);
  const retained = merged[0];
  assert.equal(retained.id, bsd.id);
  assert.equal(retained.homeTeam, bsd.homeTeam);
  assert.equal(retained.awayTeam, bsd.awayTeam);
  assert.equal(retained.score, bsd.score);
  assert.equal(retained.utcDate, bsd.utcDate);
  assert.equal(retained.minute, bsd.minute);
  assert.equal(retained.homeTeam.id, 'bsd_t_196');
  assert.equal(retained.awayTeam.id, 'bsd_t_194');
  const aliases = validatedProviderIdentities(retained);
  assert.equal(aliases.length, 2);
  assert.deepEqual(aliases.map(row => [row.id, row.homeTeamId, row.awayTeamId]), [
    [bsd.id, 'bsd_t_196', 'bsd_t_194'],
    [sc.id, 'sc_t_besiktas-jk', 'sc_t_basaksehir-futbol-kulubu'],
  ]);
  assert.deepEqual(matchIdentityIds(retained), [bsd.id, sc.id]);
  assert.deepEqual([bsd, sc], before);
  assert.equal(findVerifiedCanonicalFixture(sc.id, [bsd], [sc]).id, bsd.id);
  assert.equal(findVerifiedCanonicalFixture('unrelated-route', [bsd], [sc]), null);
  assert.deepEqual(mergeProviderFixtures(merged, [sc]), merged);
});

test('a fresh preferred SportScore row keeps its native fields without splicing BSD data', () => {
  const [bsd, sc] = fixtures();
  const merged = mergeProviderFixtures([sc], [bsd]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, sc.id);
  assert.equal(merged[0].homeTeam, sc.homeTeam);
  assert.equal(merged[0].score, sc.score);
  assert.equal(merged[0].minute, sc.minute);
  assert.equal(validatedProviderIdentities(merged[0])[1].id, bsd.id);
});

test('TR, TUR, Turkey and Türkiye are equivalent country labels only for the known catalog tuples', () => {
  for (const label of ['TR', 'TUR', 'Turkey', 'Türkiye']) {
    const [bsd, sc] = fixtures();
    for (const row of [bsd, sc]) {
      row.competition.countryCode = label;
      for (const side of ['homeTeam', 'awayTeam']) row[side].countryCode = label;
    }
    assert.equal(mergeProviderFixtures([bsd], [sc]).length, 1, label);
  }
});

const rejected = {
  'guessed short SportScore ID': sc => { sc.awayTeam.id = 'sc_t_basaksehir'; },
  'unknown SportScore home ID': sc => { sc.homeTeam.id = 'sc_t_besiktas-other'; },
  'missing SportScore participant ID': sc => { sc.awayTeam.id = null; },
  'unverified FC suffix': sc => { sc.awayTeam.name = 'Başakşehir FC'; },
  'changed catalog name': sc => { sc.homeTeam.name = 'Besiktas Other'; },
  'contradictory participant provider': sc => { sc.awayTeam.provider = 'bsd'; },
  'contradictory fixture source': sc => { sc.source = 'bsd'; },
  'wrong participant country': sc => { sc.awayTeam.country = 'Greece'; },
  'wrong competition country': sc => { sc.competition.country = 'Germany'; },
  'women competition': sc => { sc.competition.isWomen = true; },
  'women player team': sc => { sc.homeTeam.gender = 'female'; },
  'youth squad': sc => { sc.homeTeam.ageGroup = 'U21'; },
  'reserve squad': sc => { sc.awayTeam.isReserve = true; },
  'national side': sc => { sc.homeTeam.type = 'national'; },
  'wrong competition': sc => { sc.competition.code = 'PL'; },
  'wrong identity competition': sc => { sc.awayTeam.identityCompetitionCode = 'FAC'; },
  'different leg': sc => { sc.leg = 2; },
  'different round': sc => { sc.round = 2; },
  'one-second kickoff difference': sc => { sc.utcDate = '2026-11-09T17:00:01Z'; },
  'timezone absent': sc => { sc.utcDate = '2026-11-09T17:00:00'; },
  'reversed participants': sc => { [sc.homeTeam, sc.awayTeam] = [sc.awayTeam, sc.homeTeam]; },
};
for (const [label, change] of Object.entries(rejected)) {
  test(`TSL aliases reject ${label}`, () => {
    const [bsd, sc] = fixtures();
    bsd.leg = 1; bsd.round = 1;
    change(sc);
    assert.equal(mergeProviderFixtures([bsd], [sc]).length, 2);
    assert.equal(findVerifiedCanonicalFixture(sc.id, [bsd], [sc]), null);
  });
}

test('ambiguous TSL candidates and distinct same-provider IDs are never erased', () => {
  const [bsd, sc] = fixtures();
  const anotherBsd = { ...bsd, id: 'bsd_216026' };
  const anotherSc = { ...sc, id: 'another-native-tsl-fixture' };
  assert.equal(mergeProviderFixtures([bsd], [sc, anotherSc]).length, 3);
  assert.equal(mergeProviderFixtures([bsd, anotherBsd], [sc]).length, 3);
  assert.equal(mergeProviderFixtures([bsd], [anotherBsd]).length, 2);
});

test('club lookup uses only the captured TSL IDs and never guesses a club from its name', () => {
  const [, sc] = fixtures();
  assert.equal(verifiedBsdTeamIdForSportScoreTeam(sc.homeTeam, 'TSL'), 'bsd_t_196');
  assert.equal(verifiedBsdTeamIdForSportScoreTeam(sc.awayTeam, 'TSL'), 'bsd_t_194');
  assert.equal(verifiedBsdTeamIdForSportScoreTeam({ ...sc.awayTeam, id: 'sc_t_basaksehir' }, 'TSL'), null);
  assert.equal(verifiedBsdTeamIdForSportScoreTeam(sc.awayTeam, 'FAC'), null);
  assert.equal(verifiedBsdTeamIdForSportScoreTeam({ ...sc.awayTeam, isWomen: true }, 'TSL'), null);
});
