const test = require('node:test');
const assert = require('node:assert/strict');
const { annotateFixtureSourceStage } = require('../utils/fixtureSourceAnnotations');

// Exact source-scoped tuple captured from the public API at
// 2026-10-05T00:12:42.737Z (Data-Public-Snapshot-2026-10-05.json).
function fixture(final = true) {
  const rawId = final ? 605568 : 605595;
  const homeId = final ? 470 : 472, awayId = final ? 482 : 496;
  return {
    id: `bsd_${rawId}`, rawId, slug: `bsd_${rawId}`, provider: 'bsd', source: 'bsd',
    utcDate: final ? '2026-10-05T10:30:00.000Z' : '2026-10-05T06:30:00.000Z',
    status: 'TIMED',
    homeTeam: { id: `bsd_t_${homeId}`, rawId: homeId, provider: 'bsd', source: 'bsd', type: 'team', name: final ? 'Japan' : 'Ecuador' },
    awayTeam: { id: `bsd_t_${awayId}`, rawId: awayId, provider: 'bsd', source: 'bsd', type: 'team', name: final ? 'New Zealand' : 'Panama' },
    score: { fullTime: { home: null, away: null }, halfTime: null },
    competition: { id: 'BSD:31', code: 'BSD:31', rawId: 31, providerId: '31', provider: 'bsd', name: 'International Friendly Games', country: 'International',
      season: { id: 133, name: 'Int. Friendly Games 2026', year: 2026, start_date: '2026-01-01', end_date: '2026-12-31', is_current: true } },
    seasonId: 133, round: null, roundLabel: 'League phase', stage: 'league-phase', stageName: 'League phase',
  };
}

function changePath(object, path, value) {
  const parts = path.split('.');
  const parent = parts.slice(0, -1).reduce((current, key) => current[key], object);
  if (value === undefined) delete parent[parts.at(-1)];
  else parent[parts.at(-1)] = value;
}

test('organizer-confirmed Japan–New Zealand final preserves BSD identity and upstream scores', () => {
  const source = fixture();
  source.status = 'IN_PLAY'; source.score.fullTime = { home: 2, away: 1 };
  source.elapsed = 71; source.venueId = 430;
  const before = structuredClone(source), annotated = annotateFixtureSourceStage(source);
  assert.equal(annotated.stage, 'final');
  assert.equal(annotated.stageName, 'Final'); assert.equal(annotated.roundLabel, 'Final');
  assert.deepEqual(source, before);
  assert.strictEqual(annotated.homeTeam, source.homeTeam);
  assert.strictEqual(annotated.awayTeam, source.awayTeam);
  assert.strictEqual(annotated.competition, source.competition);
  assert.strictEqual(annotated.score, source.score);
  const { stage, stageName, roundLabel, fixtureStageEvidence, ...unchanged } = annotated;
  const { stage: oldStage, stageName: oldName, roundLabel: oldLabel, ...original } = before;
  assert.deepEqual(unchanged, original);
  assert.deepEqual(fixtureStageEvidence.previousStage, { stage: 'league-phase', stageName: 'League phase', roundLabel: 'League phase' });
  assert.equal(fixtureStageEvidence.source, 'organizer');
  assert.equal(fixtureStageEvidence.sourceURL, 'https://www.jfa.jp/eng/samuraiblue/news/00036851/');
  assert.equal(fixtureStageEvidence.checkedAt, '2026-10-05T09:35:10.000Z');
  assert.equal(fixtureStageEvidence.fixtureId, source.id);
});

test('organizer-confirmed Ecuador–Panama is third place, never the final', () => {
  const source = fixture(false), annotated = annotateFixtureSourceStage(source);
  assert.equal(annotated.stage, 'third-place');
  assert.equal(annotated.stageName, 'Third place play-off');
  assert.equal(annotated.roundLabel, 'Third place play-off');
  assert.equal(annotated.id, 'bsd_605595'); assert.equal(annotated.provider, 'bsd');
  assert.equal(annotated.competition.id, 'BSD:31'); assert.equal(annotated.seasonId, 133);
});

test('full fixture tuple rejects incorrect provider, team, season, competition and kickoff', () => {
  const mismatches = [
    ['id', 'bsd_605567'], ['rawId', 605567], ['slug', 'bsd_1'],
    ['provider', 'sportscore'], ['source', 'sportscore'],
    ['utcDate', '2026-10-05T10:31:00Z'], ['utcDate', '2026-10-05T10:30:00'], ['utcDate', '2027-10-05T10:30:00Z'],
    ['competition.id', 'SC:japanesekirincup'], ['competition.code', 'SC:japanesekirincup'],
    ['competition.rawId', 32], ['competition.providerId', '32'], ['competition.provider', 'sportscore'],
    ['seasonId', 134], ['competition.season.id', 134], ['competition.season.year', 2027],
    ['homeTeam.id', 'sc_t_japan'], ['homeTeam.rawId', 471], ['homeTeam.provider', 'sportscore'], ['homeTeam.source', 'sportscore'],
    ['homeTeam.name', 'Japan U19'], ['homeTeam.type', 'club'],
    ['awayTeam.id', 'bsd_t_483'], ['awayTeam.rawId', 483], ['awayTeam.name', 'New Zealand Women'],
  ];
  for (const [path, value] of mismatches) {
    const source = fixture(); changePath(source, path, value);
    assert.strictEqual(annotateFixtureSourceStage(source), source, path);
  }
  for (const path of ['rawId', 'provider', 'source', 'utcDate', 'competition', 'seasonId', 'competition.season', 'homeTeam.id', 'homeTeam.rawId', 'awayTeam.id']) {
    const source = fixture(); changePath(source, path, undefined);
    assert.strictEqual(annotateFixtureSourceStage(source), source, `missing ${path}`);
  }
});

test('reversed sides or a foreign provider match with identical names and timing is untouched', () => {
  const reversed = fixture(); [reversed.homeTeam, reversed.awayTeam] = [reversed.awayTeam, reversed.homeTeam];
  assert.strictEqual(annotateFixtureSourceStage(reversed), reversed);
  const sc = fixture(); sc.id = 'japan-vs-new-zealandy39mp1hdvzxnmoj'; sc.provider = sc.source = 'sportscore';
  assert.strictEqual(annotateFixtureSourceStage(sc), sc);
  const ordinary = fixture(); ordinary.id = ordinary.slug = 'bsd_605569'; ordinary.rawId = 605569;
  assert.strictEqual(annotateFixtureSourceStage(ordinary), ordinary);
});

test('conflicting youth, women, reserve and squad metadata cannot inherit a senior final', () => {
  for (const path of ['isWomen', 'competition.isYouth', 'homeTeam.isReserve', 'awayTeam.is_women']) {
    const source = fixture(); changePath(source, path, true);
    assert.strictEqual(annotateFixtureSourceStage(source), source, path);
  }
  for (const [path, value] of [['gender', 'female'], ['competition.ageGroup', 'U21'], ['homeTeam.squadType', 'reserves'], ['awayTeam.category', 'youth']]) {
    const source = fixture(); changePath(source, path, value);
    assert.strictEqual(annotateFixtureSourceStage(source), source, path);
  }
});

test('equivalent explicitly zoned instant and canonical string IDs retain the verified tuple', () => {
  const source = fixture(); source.utcDate = '2026-10-05T19:30:00+09:00';
  for (const path of ['rawId', 'seasonId', 'competition.rawId', 'competition.season.id', 'competition.season.year', 'homeTeam.rawId', 'awayTeam.rawId']) {
    const parts = path.split('.'); const value = parts.reduce((current, key) => current[key], source);
    changePath(source, path, String(value));
  }
  source.homeTeam.name = ' Japan '; source.awayTeam.name = 'New   Zealand';
  assert.equal(annotateFixtureSourceStage(source).stage, 'final');
  assert.equal(annotateFixtureSourceStage(source).utcDate, source.utcDate);
});

test('annotation is idempotent, retains original stage evidence, and supports immutable source fixtures', () => {
  const source = fixture(); Object.freeze(source); Object.freeze(source.competition);
  const annotated = annotateFixtureSourceStage(source);
  assert.deepEqual(annotateFixtureSourceStage(annotated), annotated);
  assert.equal(annotated.fixtureStageEvidence.previousStage.stage, 'league-phase');
  for (const unknown of [null, undefined, false, 'bsd_605568', {}, { id: '__proto__' }, { id: 'constructor' }]) {
    assert.strictEqual(annotateFixtureSourceStage(unknown), unknown);
  }
});
