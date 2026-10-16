'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { projectLineupPayload } = require('../utils/compactLineupPayload');

const richPlayer = (id, extras = {}) => ({
  id: 'bsd_p_' + id, provider: 'bsd', source: 'bsd', rosterTeamId: 'bsd_t_44',
  name: 'Player ' + id, image: 'https://example.test/players/' + id, photo: 'portrait',
  nationality: 'Spain', height: 180, heightUnit: 'cm', age: 26,
  marketValue: 1000000, marketValueCurrency: 'EUR',
  player: { id: 'bsd_p_' + id, provider: 'bsd', name: 'Player ' + id, image: 'portrait' },
  ...extras,
});
const lineup = () => ({
  matchId: 'bsd_1', homeTeamId: 'bsd_t_44', awayTeamId: 'bsd_t_57', confirmed: true,
  home: [richPlayer(1, { grid: '2:1', rating: 7.1 })], away: [richPlayer(101)],
  homeBench: [richPlayer(2)], awayBench: [richPlayer(102)],
  homeFormation: '4-4-2', homeCoach: { id: 'bsd_c_1', image: 'coach portrait' },
  squadCoverage: { home: { teamId: 'bsd_t_44', available: true, complete: true, scope: 'team_roster' } },
  squadValuation: { home: { totalPlayers: 3, knownPlayers: 3, totalEUR: 3000000 } },
  coverage: { available: true, complete: false, partial: true },
  homeSquad: [richPlayer(1), richPlayer(2), richPlayer(3)], awaySquad: [],
  arbitraryFutureField: { preserve: 'unchanged' },
});

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('the full default and unrecognized formats preserve every original field for existing clients', () => {
  const full = freeze(lineup());
  for (const format of [undefined, null, '', 'full', 'compact', 'COMPACT-V1', 'compact-v2', ['compact-v1'], {}]) {
    assert.strictEqual(projectLineupPayload(full, format), full);
  }
  assert.equal(projectLineupPayload(full, undefined).homeSquad[2].name, 'Player 3');
});

test('compact format keeps the complete roster, rich XI and bench and all non-roster sections unchanged', () => {
  const full = freeze(lineup()), before = JSON.stringify(full);
  const compact = projectLineupPayload(full, 'compact-v1');
  assert.notStrictEqual(compact, full);
  assert.equal(JSON.stringify(full), before);
  assert.equal(compact.homeSquad.length, 3);
  assert.deepEqual(compact.homeSquad.map(row => row.id), ['bsd_p_1', 'bsd_p_2', 'bsd_p_3']);
  assert.equal(compact.homeSquad[2].marketValue, 1000000); // Not in XI or bench.
  assert.equal(compact.homeSquad[0].name, undefined);
  assert.equal(compact.homeSquad[0].image, undefined);
  assert.equal(compact.homeSquad[0].player.name, undefined);
  for (const [field, value] of Object.entries(full)) {
    if (!['homeSquad', 'awaySquad'].includes(field)) assert.deepEqual(compact[field], value, field);
  }
  assert.equal(compact.home[0].image, full.home[0].image);
  assert.equal(compact.home[0].rating, 7.1);
  assert.equal(compact.home[0].height, 180);
  assert.equal(compact.homeBench[0].nationality, 'Spain');
});

test('nested identity, currency and null precedence survive without inventing or flattening values', () => {
  const source = lineup();
  source.homeSquad = [
    richPlayer(1, { marketValue: 0, marketValueCurrency: 'EUR' }),
    richPlayer(2, { marketValue: null, marketValueCurrency: null }),
    richPlayer(3, { player: { id: 'bsd_p_3', marketValue: 500, marketValueCurrency: 'USD' } }),
    richPlayer(4, { player: { id: 'bsd_p_4', marketValue: null, marketValueCurrency: 'EUR' } }),
    richPlayer(5, { player: { id: 'bsd_p_99', marketValue: 999999, marketValueCurrency: 'EUR' } }),
    richPlayer(6, { market_value_eur: 37, market_value_currency: 'USD', marketValueCurrency: '' }),
    richPlayer(7, { marketValueEUR: null, market_value_eur: 61, marketValue: 13,
      player: { id: 'bsd_p_7', teamId: 'bsd_t_57', source: 'other' } }),
  ];
  const compact = projectLineupPayload(source, 'compact-v1');
  assert.equal(compact.homeSquad[0].marketValue, 0);
  assert.equal(compact.homeSquad[1].marketValue, null);
  assert.equal(compact.homeSquad[2].player.marketValueCurrency, 'USD');
  assert.equal(compact.homeSquad[3].player.marketValue, null);
  assert.equal(compact.homeSquad[4].id, 'bsd_p_5');
  assert.equal(compact.homeSquad[4].player.id, 'bsd_p_99');
  assert.equal(compact.homeSquad[5].market_value_eur, 37);
  assert.equal(compact.homeSquad[5].market_value_currency, 'USD');
  assert.equal(compact.homeSquad[6].marketValueEUR, null);
  assert.equal(compact.homeSquad[6].market_value_eur, 61);
  assert.equal(compact.homeSquad[6].player.teamId, 'bsd_t_57');
  assert.equal(compact.homeSquad[6].player.source, 'other');
});

test('national roster ownership, club membership and conflict/provenance stay separate and cannot mutate the cache', () => {
  const full = lineup();
  full.homeTeamId = 'bsd_t_488';
  full.squadCoverage.home = { teamId: 'bsd_t_488', teamType: 'national', complete: true, available: true };
  full.homeSquad = [richPlayer(1, {
    rosterTeamId: 'bsd_t_488', nationalTeamId: 'bsd_t_488', currentTeamId: 'bsd_t_12',
    conflictingRosterFacts: ['marketValue', 'marketValueCurrency'], marketValue: null, marketValueCurrency: null,
    provenance: { source: 'bsd', membershipField: 'national_team_id' },
    player: { id: 'bsd_p_1', marketValue: null, conflictingRosterFacts: ['marketValue'] },
  })];
  const original = structuredClone(full), compact = projectLineupPayload(full, 'compact-v1');
  assert.equal(compact.homeSquad[0].rosterTeamId, 'bsd_t_488');
  assert.equal(compact.homeSquad[0].nationalTeamId, 'bsd_t_488');
  assert.equal(compact.homeSquad[0].currentTeamId, 'bsd_t_12');
  assert.deepEqual(compact.homeSquad[0].conflictingRosterFacts, ['marketValue', 'marketValueCurrency']);
  assert.deepEqual(compact.squadCoverage, full.squadCoverage);
  compact.homeSquad[0].provenance.membershipField = 'changed';
  compact.homeSquad[0].conflictingRosterFacts.push('height');
  compact.homeSquad[0].player.conflictingRosterFacts.push('height');
  assert.deepEqual(full, original);
});

test('malformed, unknown and duplicate roster members retain cardinality and identity failures', () => {
  const full = lineup();
  full.homeSquad = [null, false, ['invalid'], 'invalid', {}, richPlayer(1), richPlayer(1),
    richPlayer(9, { player: null }), richPlayer(10, { player: { id: 'ko_p_10' } })];
  const compact = projectLineupPayload(freeze(full), 'compact-v1');
  assert.equal(compact.homeSquad.length, 9);
  assert.deepEqual(compact.homeSquad.slice(0, 5), [null, false, ['invalid'], 'invalid', {}]);
  assert.deepEqual(compact.homeSquad.slice(5, 7).map(row => row.id), ['bsd_p_1', 'bsd_p_1']);
  assert.equal(compact.homeSquad[7].player, null);
  assert.equal(compact.homeSquad[8].player.id, 'ko_p_10');
  for (const empty of [null, undefined, false, []]) assert.strictEqual(projectLineupPayload(empty, 'compact-v1'), empty);
  for (const unavailable of [{}, { homeSquad: null }, { homeSquad: [] }]) {
    assert.deepEqual(projectLineupPayload(unavailable, 'compact-v1'), unavailable);
  }
});

function controllerWithCache(cache, providers = {}) {
  const resolved = require.resolve('../controllers/statsController'); delete require.cache[resolved];
  const stubs = {
    '../services/sportscoreService': {}, '../services/sportsDataService': {},
    '../services/kickoffApiService': {}, '../services/teamService': {},
    '../utils/logger': { info() {}, warn() {}, error() {} },
    '../services/bsdSportsService': providers,
    '../services/cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) },
  };
  const original = Module._load;
  Module._load = function(name, parent, isMain) {
    return Object.hasOwn(stubs, name) ? stubs[name] : original.call(this, name, parent, isMain);
  };
  try { return require(resolved); } finally { Module._load = original; }
}
const request = async (controller, format, hints = {}) => {
  const response = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.getMatchLineups({ params: { id: 'bsd_1' }, query: {
    ...hints, ...(format === undefined ? {} : { format }),
  } }, response);
  assert.equal(response.statusCode, undefined);
  assert.equal(response.body.success, true);
  return response.body;
};

test('the shared full cache serves full then compact then full without data loss or provider reads', async () => {
  const original = lineup(), cache = new Map([['lineups:bsd_1', freeze({ source: 'bsd', coverage: { complete: true }, lineups: original })]]);
  const before = JSON.stringify(original), controller = controllerWithCache(cache);
  const fullBefore = await request(controller), compact = await request(controller, 'compact-v1');
  const fullAfter = await request(controller), unknown = await request(controller, 'compact-v2');
  assert.equal(compact.source, 'bsd_cached');
  assert.equal(compact.data.homeSquad[0].name, undefined);
  assert.deepEqual(compact.data.home, original.home);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(fullBefore.data, original);
  assert.deepEqual(fullAfter.data, original);
  assert.deepEqual(unknown.data, original);
  assert.equal(cache.size, 1);
});

test('fresh compact response caches full enriched roster for existing clients and never repeats provider calls', async () => {
  const cache = new Map(), calls = [];
  const controller = controllerWithCache(cache, {
    getMatchDetails: async () => {
      calls.push('details');
      return { matchInfo: { id: 'bsd_1', status: 'IN_PLAY', homeTeam: { id: 'bsd_t_44' }, awayTeam: { id: 'bsd_t_57' } },
        lineups: lineup() };
    },
    getTeamLineupSquad: async teamId => {
      calls.push(teamId);
      const rows = [richPlayer(teamId === 'bsd_t_44' ? 1 : 101, { rosterTeamId: teamId })];
      Object.defineProperty(rows, 'coverage', { value: { teamId, scope: 'team_roster', complete: true, available: true } });
      return rows;
    },
  });
  const compact = await request(controller, 'compact-v1');
  assert.equal(compact.data.homeSquad[0].name, undefined);
  assert.equal(compact.data.home[0].image, 'https://example.test/players/1');
  const full = await request(controller);
  assert.equal(full.data.homeSquad[0].name, 'Player 1');
  assert.equal(full.data.homeSquad[0].player.image, 'portrait');
  assert.deepEqual(full.data.squadCoverage, compact.data.squadCoverage);
  assert.deepEqual(full.data.squadValuation, compact.data.squadValuation);
  assert.deepEqual(calls, ['details', 'bsd_t_44', 'bsd_t_57']);
  assert.equal(cache.size, 1);
});

test('the exact fixture shares one full cache across absent ISO and alternate date hints without mixing identities', async () => {
  const cache = new Map(), calls = [];
  const controller = controllerWithCache(cache, {
    getMatchDetails: async id => {
      calls.push(['details', id]);
      return { matchInfo: { id: 'bsd_1', status: 'IN_PLAY', homeTeam: { id: 'bsd_t_44' }, awayTeam: { id: 'bsd_t_57' } },
        lineups: lineup() };
    },
    getTeamLineupSquad: async teamId => {
      calls.push(['roster', teamId]);
      const rows = [richPlayer(teamId === 'bsd_t_44' ? 1 : 101, { rosterTeamId: teamId })];
      Object.defineProperty(rows, 'coverage', { value: { teamId, scope: 'team_roster', complete: true, available: true } });
      return rows;
    },
  });
  const plain = await request(controller);
  const before = JSON.stringify(plain.data);
  const compact = await request(controller, 'compact-v1', { date: '2026-10-16', home: 'Unrelated home', away: 'Unrelated away' });
  const alternate = await request(controller, undefined, { date: '16/10/2026', home: 'Another club', away: 'Another country' });
  const isoTime = await request(controller, undefined, { date: '2026-10-16T20:00:00.000Z' });
  assert.equal(compact.data.matchId, 'bsd_1');
  assert.equal(compact.data.homeTeamId, 'bsd_t_44');
  assert.equal(compact.data.awayTeamId, 'bsd_t_57');
  assert.equal(compact.data.homeSquad[0].name, undefined);
  assert.equal(alternate.data.homeSquad[0].name, 'Player 1');
  assert.equal(JSON.stringify(alternate.data), before);
  assert.equal(JSON.stringify(isoTime.data), before);
  assert.equal(compact.source, 'bsd_cached');
  assert.equal(alternate.source, 'bsd_cached');
  assert.deepEqual(calls, [['details', 'bsd_1'], ['roster', 'bsd_t_44'], ['roster', 'bsd_t_57']]);
  assert.deepEqual([...cache.keys()], ['lineups:bsd_1']);
});
