const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeProviderFixtures, findVerifiedCanonicalFixture, verifiedBsdTeamIdForSportScoreTeam } = require('../utils/providerFixtureIdentity');
const { validatedProviderIdentities, matchIdentityIds } = require('../utils/matchProviderIdentities');
const pd = require('./fixtures/provider-fixture-pd-catalog-2026-10-10.json');
const friendly = require('./fixtures/provider-fixture-friendly-2026-10-04.json');
const other = require('./fixtures/provider-fixture-other-aliases-2026-10-10.json');
const germanFrench = require('./fixtures/provider-fixture-bl1-fl1-catalog-2026-10-10.json');
const clone = value => structuredClone(value);

test('captured four PD name variants select the whole enriched fixture with exact old subscription identities', () => {
  for (const captured of pd.pairs) {
    const { preferred, supplement } = clone(captured);
    const before = clone([preferred, supplement]);
    const [row, extra] = mergeProviderFixtures([preferred], [supplement]);
    assert.equal(extra, undefined, preferred.id);
    assert.equal(row.id, preferred.id);
    for (const key of ['homeTeam', 'awayTeam', 'score', 'competition']) assert.strictEqual(row[key], preferred[key]);
    assert.equal(row.utcDate, preferred.utcDate);
    assert.deepEqual(matchIdentityIds(row), [preferred.id, supplement.id]);
    assert.equal(validatedProviderIdentities(row).length, 2);
    assert.deepEqual([preferred, supplement], before);
    assert.deepEqual(mergeProviderFixtures([row], [supplement])[0], row);
  }
});

test('all independently audited PD clubs retain their exact source ID/name/scope in different pairings', () => {
  const pairs = [
    [51, 'athletic-club'], [54, 'atletico-madrid'], [49, 'rc-celta'], [45, 'deportivo-alaves'],
    [1260, 'rc-deportivo'], [55, 'elche-cf'], [53, 'rcd-espanyol-de-barcelona'], [44, 'fc-barcelona'],
    [50, 'getafe'], [46, 'levante'], [1259, 'malaga'], [58, 'ca-osasuna'], [40, 'rayo-vallecano'],
    [56, 'real-betis'], [57, 'real-madrid'], [1400, 'racing-santander'], [48, 'real-sociedad'],
    [52, 'sevilla-fc'], [47, 'valencia-cf'], [41, 'villarreal-cf'],
  ];
  for (let i = 0; i < pairs.length; i++) {
    const fixture = clone(pd.pairs[0]);
    for (const [side, index] of [['homeTeam', i], ['awayTeam', (i + 1) % pairs.length]]) {
      fixture.preferred[side] = clone(pd.bsdTeams.find(team => team.id === `bsd_t_${pairs[index][0]}`));
      fixture.supplement[side] = clone(pd.sportscoreTeams.find(team => team.id === `sc_t_${pairs[index][1]}`));
    }
    assert.equal(mergeProviderFixtures([fixture.preferred], [fixture.supplement]).length, 1, pairs[i][1]);
  }
});

test('new PD mappings never erase foreign clubs, different leg/phase/round, women, youth, reserves or conflicting identities', () => {
  const changes = [
    row => { row.homeTeam.id = 'sc_t_valencia-other'; },
    row => { row.homeTeam.name = 'Valencia CF U21'; },
    row => { row.homeTeam.country = 'Mexico'; },
    row => { row.awayTeam.isReserve = true; },
    row => { row.homeTeam.ageGroup = 'U19'; },
    row => { row.competition.isWomen = true; },
    row => { row.homeTeam.provider = 'bsd'; },
    row => { row.utcDate = '2026-09-20T19:00:01Z'; },
    row => { row.competition.code = 'CDR'; },
    row => { row.homeTeam.identityCompetitionCode = 'SC:spanish-la-liga-2'; },
    row => { row.stage = 'final'; }, row => { row.round = 8; }, row => { row.leg = 2; },
  ];
  for (const change of changes) {
    const { preferred, supplement } = clone(pd.pairs[3]); preferred.leg = 1;
    change(supplement);
    assert.equal(mergeProviderFixtures([preferred], [supplement]).length, 2, change.toString());
  }
  const { preferred, supplement } = clone(pd.pairs[3]);
  assert.equal(mergeProviderFixtures([preferred], [supplement, { ...supplement, id: 'another-valencia-fixture' }]).length, 3);
});

test('canonical lookup certifies only an actual emitted alias and preserves its original public fixture ID', () => {
  const { preferred, supplement } = clone(pd.pairs[3]);
  assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [supplement]).id, preferred.id);
  assert.equal(findVerifiedCanonicalFixture(preferred.id, [preferred], [supplement]).id, preferred.id);
  assert.equal(findVerifiedCanonicalFixture('not-an-observed-match', [preferred], [supplement]), null);
  assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [supplement, { ...supplement, id: 'other-fixture' }]), null);
  assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [{ ...supplement, homeTeam: { ...supplement.homeTeam, id: null } }]), null);
});

test('conflicting child provider or source never certifies a club fixture identity', () => {
  for (const side of ['homeTeam', 'awayTeam']) {
    for (const provenance of ['provider', 'source']) {
      const { preferred, supplement } = clone(pd.pairs[3]);
      supplement[side][provenance] = 'bsd';
      const rows = mergeProviderFixtures([preferred], [supplement]);
      assert.equal(rows.length, 2, `${side}.${provenance}`);
      assert.strictEqual(rows[0], preferred);
      assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [supplement]), null);
    }
  }
});

test('a later distinct same-provider fixture stays visible and cannot invalidate prior subscription aliases', () => {
  const { preferred, supplement } = clone(pd.pairs[3]);
  const joined = mergeProviderFixtures([preferred], [supplement])[0];
  const before = clone(joined);
  const distinct = { ...clone(supplement), id: 'different-valencia-fixture' };
  const rows = mergeProviderFixtures([joined], [distinct]);
  assert.equal(rows.length, 2);
  assert.strictEqual(rows[0], joined);
  assert.strictEqual(rows[1], distinct);
  assert.deepEqual(joined, before);
  assert.deepEqual(matchIdentityIds(rows[0]), [preferred.id, supplement.id]);
  assert.equal(findVerifiedCanonicalFixture(distinct.id, [joined], [distinct]), null);
});

test('a repeated alias with contradictory participants cannot replace its earlier observed identity', () => {
  const { preferred, supplement } = clone(pd.pairs[3]);
  const joined = mergeProviderFixtures([preferred], [supplement])[0];
  const conflicting = clone(supplement);
  // Full names still match the exact-context rule, while an independently
  // observed team ID now disagrees with the existing same-route alias.
  conflicting.homeTeam.name = preferred.homeTeam.name;
  conflicting.homeTeam.id = 'sc_t_valencia-other';
  conflicting.awayTeam.name = preferred.awayTeam.name;
  const rows = mergeProviderFixtures([joined], [conflicting]);
  assert.equal(rows.length, 2);
  assert.strictEqual(rows[0], joined);
  assert.strictEqual(rows[1], conflicting);
  assert.deepEqual(matchIdentityIds(rows[0]), [preferred.id, supplement.id]);
});

test('catalog-scoped team fallback resolves only exact audited senior club identities', () => {
  const { supplement } = clone(pd.pairs[3]);
  const team = supplement.homeTeam;
  assert.equal(verifiedBsdTeamIdForSportScoreTeam(team, 'PD'), 'bsd_t_47');
  assert.equal(verifiedBsdTeamIdForSportScoreTeam({ ...team, countryCode: 'ES' }, 'PD'), 'bsd_t_47');
  assert.equal(verifiedBsdTeamIdForSportScoreTeam(team), 'bsd_t_47');
  const changes = [row => { row.id = 'sc_t_valencia-other'; }, row => { row.name = 'Valencia'; },
    row => { row.country = 'Mexico'; }, row => { row.isWomen = true; }, row => { row.ageGroup = 'U21'; },
    row => { row.isReserve = true; }, row => { row.type = 'national'; },
    row => { row.provider = 'bsd'; }, row => { row.source = 'bsd'; },
    row => { row.identityCompetitionCode = 'SC:spanish-la-liga-2'; }];
  for (const change of changes) { const row = clone(team); change(row); assert.equal(verifiedBsdTeamIdForSportScoreTeam(row, 'PD'), null); }
  assert.equal(verifiedBsdTeamIdForSportScoreTeam(team, 'CDR'), null);
  assert.equal(verifiedBsdTeamIdForSportScoreTeam({ id: null, name: 'Argentina', provider: 'sportscore' }, 'BSD:31'), null);
});

test('one captured national friendly duplicate is suppressed only in display without fabricated source teams or aliases', () => {
  const { preferred, supplement } = clone(friendly);
  const before = clone([preferred, supplement]);
  const rows = mergeProviderFixtures([preferred], [supplement]);
  assert.equal(rows.length, 1);
  assert.strictEqual(rows[0], preferred);
  assert.equal(rows[0].providerIdentities, undefined);
  assert.deepEqual(matchIdentityIds(rows[0]), [preferred.id]);
  assert.equal(supplement.homeTeam.id, null);
  assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [supplement]), null);
  assert.deepEqual([preferred, supplement], before);
  assert.strictEqual(mergeProviderFixtures([supplement], [preferred])[0], preferred);
});

test('national display suppression cannot grow into shifted kickoff, other competitions, conflicting scores or cross-class joins', () => {
  const changes = [
    row => { row.utcDate = '2026-10-04T00:00:01Z'; },
    row => { [row.homeTeam, row.awayTeam] = [row.awayTeam, row.homeTeam]; },
    row => { row.homeTeam.country = 'Canada'; },
    row => { row.competition.country = 'England'; },
    row => { row.competition.code = 'SC:international friendly u21'; },
    row => { row.competition.name = 'Youth International Friendly'; },
    row => { row.awayTeam.ageGroup = 'U21'; },
    row => { row.homeTeam.isWomen = true; },
    row => { row.awayTeam.isReserve = true; },
    row => { row.homeTeam.type = 'club'; },
    row => { row.homeTeam.provider = 'bsd'; },
    row => { row.homeTeam.id = 'sc_t_argentina-guessed'; },
    row => { row.score.fullTime.home = 6; }, row => { row.stage = 'final'; },
  ];
  for (const change of changes) {
    const { preferred, supplement } = clone(friendly); change(supplement);
    assert.equal(mergeProviderFixtures([preferred], [supplement]).length, 2, change.toString());
  }
  const { preferred, supplement } = clone(friendly);
  assert.equal(mergeProviderFixtures([preferred], [supplement, { ...supplement, id: 'another-friendly' }]).length, 3);
  assert.equal(mergeProviderFixtures([preferred, { ...preferred, id: 'bsd_99999' }], [supplement]).length, 3);
});

test('the same audited friendly scope supports other exact full-name fixtures without granting identity aliases', () => {
  for (const [home, away] of [['Egypt', 'South Africa'], ['Morocco', 'Mali']]) {
    const { preferred, supplement } = clone(friendly);
    preferred.id = 'bsd_888888'; supplement.id = 'another-friendly-observation';
    for (const row of [preferred, supplement]) {
      row.utcDate = '2026-10-04T18:00:00Z'; row.homeTeam.name = home; row.awayTeam.name = away;
    }
    const rows = mergeProviderFixtures([preferred], [supplement]);
    assert.equal(rows.length, 1);
    assert.strictEqual(rows[0], preferred);
    assert.deepEqual(validatedProviderIdentities(rows[0]), []);
    assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [supplement]), null);
  }
});

test('captured USA–Mexico ten-minute discrepancy has a fixture-specific display exception and unchanged timestamps', () => {
  const { preferred, supplement } = clone(friendly.kickoffException);
  const before = clone([preferred, supplement]);
  const rows = mergeProviderFixtures([preferred], [supplement]);
  assert.equal(rows.length, 1);
  assert.strictEqual(rows[0], preferred);
  assert.equal(rows[0].providerIdentities, undefined);
  assert.deepEqual([preferred, supplement], before);
  const changes = [row => { row.id = 'other-usa-mexico-fixture'; },
    row => { row.utcDate = '2026-10-04T02:10:01Z'; }, row => { row.score.fullTime.home = 2; },
    row => { row.homeTeam.name = 'USA U21'; }, row => { row.awayTeam.isWomen = true; },
    row => { row.competition.code = 'WC'; }, row => { row.homeTeam.country = 'Canada'; }];
  for (const change of changes) {
    const pair = clone(friendly.kickoffException); change(pair.supplement);
    assert.equal(mergeProviderFixtures([pair.preferred], [pair.supplement]).length, 2, change.toString());
  }
  assert.equal(mergeProviderFixtures([preferred, { ...preferred, id: 'bsd_999999' }], [supplement]).length, 3);
  assert.equal(mergeProviderFixtures([preferred], [supplement, { ...supplement, id: 'other-usa-friendly' }]).length, 3);
});

test('captured aliases in six other senior competitions preserve whole fixture DTOs and old subscriber IDs', () => {
  for (const captured of other.pairs) {
    const { preferred, supplement } = clone(captured);
    const rows = mergeProviderFixtures([preferred], [supplement]);
    assert.equal(rows.length, 1, preferred.id);
    assert.equal(rows[0].id, preferred.id);
    assert.strictEqual(rows[0].score, preferred.score);
    assert.deepEqual(matchIdentityIds(rows[0]), [preferred.id, supplement.id]);
    supplement.utcDate = new Date(Date.parse(supplement.utcDate) + 1000).toISOString();
    assert.equal(mergeProviderFixtures([preferred], [supplement]).length, 2, preferred.id);
  }
});

test('Colorado–Seattle does not inherit the prior Seattle–Kansas ten-minute exception', () => {
  const { preferred, supplement } = clone(other.pairs[7]);
  supplement.utcDate = new Date(Date.parse(preferred.utcDate) + 10 * 60 * 1000).toISOString();
  assert.equal(mergeProviderFixtures([preferred], [supplement]).length, 2);
});

test('captured Bayern, Lyon and Monaco aliases recover the rich exact fixture without splicing original player IDs', () => {
  for (const captured of germanFrench.pairs) {
    const { preferred, supplement } = clone(captured);
    const before = clone(captured);
    const rows = mergeProviderFixtures([preferred], [supplement]);
    assert.equal(rows.length, 1, supplement.id);
    assert.strictEqual(rows[0].homeTeam, preferred.homeTeam);
    assert.strictEqual(rows[0].awayTeam, preferred.awayTeam);
    assert.deepEqual(matchIdentityIds(rows[0]), [preferred.id, supplement.id]);
    assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [supplement]).id, preferred.id);
    assert.deepEqual({ preferred, supplement }, before);
  }
});

test('Monaco league membership preserves club country and never permits a conflicting reported country', () => {
  const captured = germanFrench.pairs.find(pair => pair.preferred.id === 'bsd_210482');
  const { preferred, supplement } = clone(captured);
  preferred.homeTeam.country = 'Monaco'; supplement.homeTeam.country = 'Monaco';
  const [joined] = mergeProviderFixtures([preferred], [supplement]);
  assert.equal(joined.id, preferred.id);
  assert.equal(joined.homeTeam.country, 'Monaco');
  assert.equal(joined.competition.country, 'France');
  assert.equal(verifiedBsdTeamIdForSportScoreTeam(supplement.homeTeam, 'FL1'), 'bsd_t_101');
  for (const mutate of [pair => { pair.supplement.homeTeam.country = 'France'; },
    pair => { pair.preferred.homeTeam.country = 'France'; },
    pair => { pair.supplement.competition.country = 'Monaco'; },
    pair => { pair.supplement.homeTeam.isWomen = true; },
    pair => { pair.supplement.utcDate = '2026-10-10T18:46:00Z'; }]) {
    const pair = clone({ preferred, supplement }); mutate(pair);
    assert.equal(mergeProviderFixtures([pair.preferred], [pair.supplement]).length, 2);
  }
});

test('independently verified German and French catalog identities remain source and competition scoped', () => {
  for (const entry of germanFrench.catalogs) {
    const bsdId = verifiedBsdTeamIdForSportScoreTeam({ ...entry.sportscore,
      identityCompetitionCode: entry.competition }, entry.competition);
    assert.equal(bsdId, entry.bsd.id, entry.sportscore.name);
    assert.equal(verifiedBsdTeamIdForSportScoreTeam({ ...entry.sportscore, isWomen: true }, entry.competition), null);
    assert.equal(verifiedBsdTeamIdForSportScoreTeam({ ...entry.sportscore, country: 'Brazil' }, entry.competition), null);
    assert.equal(verifiedBsdTeamIdForSportScoreTeam(entry.sportscore, 'PL'), null);
  }
});

test('new rich-fixture recovery never guesses a rematch, foreign cohort or source identity', () => {
  for (const captured of germanFrench.pairs) {
    for (const mutate of [m => { m.utcDate = new Date(Date.parse(m.utcDate) + 1000).toISOString(); },
      m => { m.homeTeam.id += '-other'; }, m => { m.awayTeam.ageGroup = 'u21'; },
      m => { m.homeTeam.provider = 'bsd'; }, m => { m.competition.code = 'CL'; }]) {
      const { preferred, supplement } = clone(captured);
      mutate(supplement);
      assert.equal(mergeProviderFixtures([preferred], [supplement]).length, 2, mutate.toString());
    }
  }
});
