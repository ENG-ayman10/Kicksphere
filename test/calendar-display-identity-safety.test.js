const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeProviderFixtures, findVerifiedCanonicalFixture } = require('../utils/providerFixtureIdentity');
const { validatedProviderIdentities, matchIdentityIds } = require('../utils/matchProviderIdentities');

// Representative identity fields captured from the public 2026-11-09 calendar.
// These rows may be consolidated in presentation, but SportScore supplied no
// participant IDs. Display similarity cannot authorize route/alert aliases.
const fixtures = () => [{
  id: 'bsd_642942', rawId: 642942, slug: 'bsd_642942', provider: 'bsd', source: 'bsd',
  utcDate: '2026-11-09T19:30:00Z', status: 'TIMED', matchPhase: 'NOT_STARTED',
  homeTeam: { id: 'bsd_t_4104', rawId: 4104, provider: 'bsd', source: 'bsd', name: 'Plymouth Parkway', type: 'team' },
  awayTeam: { id: 'bsd_t_2777', rawId: 2777, provider: 'bsd', source: 'bsd', name: 'Berkhamsted Town', type: 'team' },
  competition: { id: 'FAC', code: 'FAC', rawId: 39, provider: 'bsd', name: 'FA Cup', country: 'England' },
  score: { fullTime: { home: null, away: null }, halfTime: null }, round: 1, stage: 'round-1',
}, {
  id: 'berkhamsted-town-vs-plymouth-parkway3glrw7h4w125qdy',
  slug: 'berkhamsted-town-vs-plymouth-parkway3glrw7h4w125qdy',
  provider: 'sportscore', source: 'sportscore',
  matchLocator: {
    id: 'berkhamsted-town-vs-plymouth-parkway3glrw7h4w125qdy',
    slug: 'berkhamsted-town-vs-plymouth-parkway', token: '3glrw7h4w125qdy',
    url: '/football/match/berkhamsted-town-vs-plymouth-parkway/3glrw7h4w125qdy/',
  },
  utcDate: '2026-11-09T22:30:00+03:00', status: 'TIMED', matchPhase: 'NOT_STARTED',
  homeTeam: { id: null, identityBasis: null, provider: 'sportscore', name: 'Plymouth Parkway' },
  awayTeam: { id: null, identityBasis: null, provider: 'sportscore', name: 'Berkhamsted Town' },
  competition: { id: 'FAC', code: 'FAC', name: 'FA Cup', country: 'England' },
  score: { fullTime: { home: null, away: null }, halfTime: null },
}];

test('display-similar ID-less FAC copies retain both internal routes and independent alert identities', () => {
  const [bsd, sc] = fixtures();
  const original = structuredClone([bsd, sc]);
  assert.equal(Date.parse(bsd.utcDate), Date.parse(sc.utcDate));
  const merged = mergeProviderFixtures([bsd], [sc]);

  // Removing the legacy SC row here would stop its ID reaching the existing
  // calendar/live subscription scheduler. Only presentation may hide a copy.
  assert.equal(merged.length, 2);
  assert.equal(merged[0], bsd);
  assert.equal(merged[1], sc);
  assert.deepEqual(merged.flatMap(matchIdentityIds), [bsd.id, sc.id]);
  for (const row of merged) {
    assert.equal(Object.hasOwn(row, 'providerIdentities'), false);
    assert.equal(Object.hasOwn(row, 'canonicalMatchId'), false);
    assert.deepEqual(validatedProviderIdentities(row), []);
  }
  assert.equal(findVerifiedCanonicalFixture(sc.id, [bsd], [sc]), null);
  assert.equal(findVerifiedCanonicalFixture(bsd.id, [bsd], [sc]), null);
  assert.equal(merged[0].homeTeam.id, 'bsd_t_4104');
  assert.equal(merged[0].awayTeam.id, 'bsd_t_2777');
  assert.equal(merged[1].homeTeam.id, null);
  assert.equal(merged[1].awayTeam.id, null);
  assert.equal(merged[1].matchLocator.url, original[1].matchLocator.url);
  assert.deepEqual([bsd, sc], original);
});
