'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const evidence = require('./fixtures/provider-fixture-cl-catalog-2026-10-15.json');
const { mergeProviderFixtures, findVerifiedCanonicalFixture, verifiedBsdTeamIdForSportScoreTeam } = require('../utils/providerFixtureIdentity');
const { validatedProviderIdentities } = require('../utils/matchProviderIdentities');
const clone = value => structuredClone(value);

test('four captured CL duplicates select the whole rated BSD fixture and preserve each original public URL', () => {
  assert.equal(evidence.evidence.bsdComplete, true);
  assert.equal(evidence.evidence.bsdReportedTotal, 36);
  assert.equal(evidence.evidence.sportscoreReportedTotal, 36);
  for (const pair of evidence.pairs) {
    const { preferred, supplement } = clone(pair);
    const before = clone([preferred, supplement]);
    const rows = mergeProviderFixtures([preferred], [supplement]);
    assert.equal(rows.length, 1, supplement.id);
    assert.equal(rows[0].id, preferred.id);
    for (const key of ['homeTeam', 'awayTeam', 'score', 'competition']) assert.strictEqual(rows[0][key], preferred[key]);
    assert.deepEqual(validatedProviderIdentities(rows[0]).map(row => row.id), [preferred.id, supplement.id]);
    assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [supplement]).id, preferred.id);
    assert.deepEqual([preferred, supplement], before);
  }
});

test('all 36 independently captured CL catalog pairs work across national club countries without relaxing competition scope', () => {
  assert.equal(evidence.catalogs.length, 36);
  for (const [index, row] of evidence.catalogs.entries()) {
    const { preferred, supplement } = clone(evidence.pairs[0]);
    const other = evidence.catalogs[(index + 1) % evidence.catalogs.length];
    preferred.homeTeam = clone(row.bsd); supplement.homeTeam = clone(row.sportscore);
    preferred.awayTeam = clone(other.bsd); supplement.awayTeam = clone(other.sportscore);
    assert.equal(mergeProviderFixtures([preferred], [supplement]).length, 1, row.club);
    assert.equal(verifiedBsdTeamIdForSportScoreTeam(row.sportscore, 'CL'), row.bsd.id, row.club);
    assert.equal(verifiedBsdTeamIdForSportScoreTeam(row.sportscore, 'EL'), null);
  }
});

test('CL catalog mappings reject unverified names, IDs, kickoff drift, countries, competition and player cohorts', () => {
  const changes = [
    m => { m.homeTeam.id = 'sc_t_other-lask'; },
    m => { m.homeTeam.name = 'LASK'; },
    m => { m.awayTeam.name = 'Liverpool U19'; },
    m => { m.awayTeam.id = null; },
    m => { m.homeTeam.country = 'Germany'; },
    m => { m.competition.country = 'England'; },
    m => { m.competition.code = 'EL'; },
    m => { m.homeTeam.identityCompetitionCode = 'PL'; },
    m => { m.utcDate = '2026-10-14T16:45:01Z'; },
    m => { m.homeTeam.isWomen = true; },
    m => { m.awayTeam.ageGroup = 'U19'; },
    m => { m.awayTeam.isReserve = true; },
    m => { m.homeTeam.provider = 'bsd'; },
    m => { m.leg = 2; },
    m => { [m.homeTeam, m.awayTeam] = [m.awayTeam, m.homeTeam]; },
  ];
  for (const change of changes) {
    const { preferred, supplement } = clone(evidence.pairs[0]); preferred.leg = 1;
    change(supplement);
    assert.equal(mergeProviderFixtures([preferred], [supplement]).length, 2, change.toString());
    assert.equal(findVerifiedCanonicalFixture(supplement.id, [preferred], [supplement]), null);
  }
});

test('CL ambiguous matches remain distinct and domestic Liverpool catalog restrictions remain unchanged', () => {
  const { preferred, supplement } = clone(evidence.pairs[0]);
  assert.equal(mergeProviderFixtures([preferred], [supplement, { ...supplement, id: 'another-lask-liverpool' }]).length, 3);
  assert.equal(mergeProviderFixtures([preferred, { ...preferred, id: 'bsd_999999' }], [supplement]).length, 3);
  assert.equal(verifiedBsdTeamIdForSportScoreTeam({ id: 'sc_t_liverpool', provider: 'sportscore', name: 'Liverpool', identityCompetitionCode: 'PL' }, 'PL'), 'bsd_t_1');
  assert.equal(verifiedBsdTeamIdForSportScoreTeam({ id: 'sc_t_liverpool', provider: 'sportscore', name: 'Liverpool', identityCompetitionCode: 'PL' }, 'CL'), null);
});

function load(file, stubs) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function(name, parent, main) { return Object.hasOwn(stubs, name) ? stubs[name] : original.call(this, name, parent, main); };
  try { return require(file); } finally { Module._load = original; }
}
function response() { return { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

test('the captured names-only LASK URL recovers 22 exact BSD profiles and measured match ratings through the public lineup route', async () => {
  const { preferred, supplement } = clone(evidence.pairs[0]);
  const publishedLineup = clone(evidence.lineupEvidence);
  const sourceCalls = [];
  const rows = Object.defineProperty([preferred], 'coverage', { value: { complete: true } });
  const bsd = { isConfigured: () => true,
    getMatches: async () => rows,
    getMatchDetails: async id => { sourceCalls.push(id); return { matchInfo: preferred, lineups: publishedLineup, coverage: { fields: { lineups: true } } }; } };
  const bridge = load('../services/verifiedMatchDetailsService', { './bsdSportsService': bsd,
    './cacheService': { getCached: () => null, setCache() {} } });
  const recovered = await bridge.getVerifiedBsdDetails(supplement);
  assert.equal(recovered.matchInfo.id, supplement.id);
  assert.equal(recovered.matchInfo.canonicalMatchId, preferred.id);
  const api = load('../controllers/statsController', {
    '../services/sportsDataService': { getMatchDetails: async () => ({ source: 'bsd', data: recovered.matchInfo }) },
    '../services/bsdSportsService': bsd,
    '../services/sportscoreService': {}, '../services/kickoffApiService': {}, '../services/teamService': {},
    '../services/verifiedMatchDetailsService': bridge,
    '../services/cacheService': { getCached: () => null, setCache() {} },
    '../utils/logger': { info() {}, warn() {}, error() {} },
  });
  const res = response(); await api.getMatchLineups({ params: { id: supplement.id }, query: {} }, res);
  assert.equal(res.body.source, 'bsd'); assert.equal(res.body.data.matchId, supplement.id);
  assert.equal(res.body.data.canonicalMatchId, preferred.id);
  assert.deepEqual(sourceCalls, [preferred.id, preferred.id]);
  for (const side of ['home', 'away']) {
    assert.equal(res.body.data[side].length, 11);
    assert.ok(['grid', 'position_groups'].includes(res.body.data[side + 'Layout'].mode));
    for (const player of res.body.data[side]) {
      const actual = publishedLineup[side].find(row => row.id === player.id);
      assert.ok(actual); assert.equal(player.rating, actual.rating);
      assert.equal(player.ratingEventId, preferred.id); assert.equal(player.ratingScope, 'match');
    }
  }
});
