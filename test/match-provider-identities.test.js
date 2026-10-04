const test = require('node:test');
const assert = require('node:assert/strict');
const { validatedProviderIdentities, matchIdentityIds, teamIdentityIds } = require('../utils/matchProviderIdentities');

const fixture = () => ({ id: 'bsd_209462', provider: 'bsd', source: 'bsd', utcDate: '2026-10-02T01:30:00Z',
  competition: { code: 'MLS' }, homeTeam: { id: 'bsd_t_302' }, awayTeam: { id: 'bsd_t_299' },
  providerIdentities: [
    { id: 'bsd_209462', provider: 'bsd', utcDate: '2026-10-02T01:30:00Z', competitionCode: 'MLS',
      homeTeamId: 'bsd_t_302', awayTeamId: 'bsd_t_299' },
    { id: 'seattle-sounders-vs-sporting-kansas-citydn1m1ghl0g4pmoe', provider: 'sportscore', utcDate: '2026-10-02T01:40:00Z',
      competitionCode: 'MLS', homeTeamId: 'sc_t_seattle-sounders', awayTeamId: 'sc_t_sporting-kansas-city' }
  ] });

test('verified fixture aliases keep canonical orientation and both exact subscriber identities', () => {
  const row = fixture();
  const before = structuredClone(row);
  assert.equal(validatedProviderIdentities(row).length, 2);
  assert.deepEqual(matchIdentityIds(row), [row.id, row.providerIdentities[1].id]);
  assert.deepEqual(teamIdentityIds(row), ['bsd_t_302', 'bsd_t_299', 'sc_t_seattle-sounders', 'sc_t_sporting-kansas-city']);
  const event = { ...row, id: undefined, matchId: row.id, competitionCode: 'MLS', homeTeamId: 'bsd_t_302', awayTeamId: 'bsd_t_299' };
  assert.equal(validatedProviderIdentities(event).length, 2);
  assert.deepEqual(row, before);
});

test('wrong canonical anchor, provider, phase context, and unbounded aliases grant no additional subscription IDs', () => {
  const changes = [
    row => { row.providerIdentities[0].id = 'bsd_999'; },
    row => { row.providerIdentities[0].homeTeamId = 'bsd_t_299'; row.providerIdentities[0].awayTeamId = 'bsd_t_302'; },
    row => { row.providerIdentities[0].utcDate = '2026-10-02T01:31:00Z'; },
    row => { row.providerIdentities[1].utcDate = '2026-10-02T01:41:00Z'; },
    row => { row.providerIdentities[1].competitionCode = 'PL'; },
    row => { row.competition.code = 'PL'; row.providerIdentities.forEach(identity => { identity.competitionCode = 'PL'; }); },
    row => { row.providerIdentities[1].homeTeamId = 'sc_t_namesake'; },
    row => { row.providerIdentities[1].provider = 'bsd'; },
    row => { row.provider = 'toString'; },
    row => { row.providerIdentities[1].provider = '__proto__'; },
    row => { row.providerIdentities[1].homeTeamId = 'sc_t_bad space'; },
    row => { row.providerIdentities[1].utcDate = '2026-10-02T01:40:00'; },
    row => { row.providerIdentities.push(...structuredClone(row.providerIdentities)); },
  ];
  for (const change of changes) {
    const row = fixture(); change(row);
    assert.deepEqual(validatedProviderIdentities(row), []);
    assert.deepEqual(matchIdentityIds(row), [row.id]);
    assert.deepEqual(teamIdentityIds(row), ['bsd_t_302', 'bsd_t_299']);
  }
});

test('legacy events without provenance retain only their exact IDs and never borrow display names', () => {
  const event = { matchId: 'exact-old-slug', teamId: 'sc_t_home', againstTeamId: 'sc_t_away',
    team: 'Seattle Sounders', against: 'Sporting Kansas City' };
  assert.deepEqual(validatedProviderIdentities(event), []);
  assert.deepEqual(matchIdentityIds(event), ['exact-old-slug']);
  assert.deepEqual(teamIdentityIds(event), ['sc_t_home', 'sc_t_away']);
});
