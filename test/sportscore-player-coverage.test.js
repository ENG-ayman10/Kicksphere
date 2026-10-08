const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function provider(raw) {
  const file = '../services/sportscoreService';
  delete require.cache[require.resolve(file)];
  const cache = new Map(), calls = [];
  const mocks = { axios: { get: async url => { calls.push(url); return { data: raw }; } },
    '../utils/logger': { info() {}, warn() {}, error() {} },
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) } };
  const original = Module._load;
  Module._load = function(name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return { api: require(file), calls }; } finally { Module._load = original; }
}
const profile = stats => ({ player: { name: 'Actual Player', slug: 'actual-player',
  logo: 'https://provider.test/actual-player.png', url: '/football/player/actual-player/' }, stats });
const rawCounts = ['matches', 'goals', 'assists', 'minutes', 'yellow_cards', 'red_cards', 'shots',
  'shots_on_target', 'passes', 'tackles', 'interceptions', 'dribbles', 'key_passes'];
const publicCounts = ['matches', 'goals', 'assists', 'minutes', 'yellowCards', 'redCards', 'shots',
  'shotsOnTarget', 'passes', 'tackles', 'interceptions', 'dribbles', 'keyPasses'];
const zeroCounts = () => Object.fromEntries(rawCounts.map(key => [key, 0]));

test('malformed SportScore player counters become unknown and never fabricated appearances or goals', async () => {
  for (const invalid of [true, false, {}, [], null, undefined, '', '  ', -1, '-1', 1.5, '1.5', Infinity, 'Infinity', '0x10', 1e20]) {
    const { api } = provider(profile(Object.fromEntries(rawCounts.map(key => [key, invalid]))));
    const value = await api.getPlayerDetails('actual-player');
    for (const key of publicCounts) {
      assert.equal(value[key], null, `${key}: ${JSON.stringify(invalid)}`);
      assert.equal(value.statsCoverage.fields[key], false);
    }
    assert.equal(value.statsCoverage.available, false);
    assert.equal(value.statsCoverage.reason, 'provider_statistics_unavailable');
  }
});

test('valid zero counters and numeric strings survive with an unknown edition explicitly partial', async () => {
  const { api, calls } = provider(profile({ ...zeroCounts(), goals: '0', matches: ' 2 ', team: 'Actual Club',
    competition: 'Actual League', rating: '7.25', passes_accuracy: 10 }));
  const value = await api.getPlayerDetails('actual-player');
  assert.equal(value.matches, 2); assert.equal(value.goals, 0); assert.equal(value.shots, 0);
  assert.equal(value.rating, 7.25); assert.equal(value.passesAccuracy, null); assert.equal(value.passesAccuracyRaw, 10);
  assert.deepEqual(value.statsContext, { team: 'Actual Club', competition: 'Actual League', season: null });
  assert.equal(value.statsCoverage.available, true); assert.equal(value.statsCoverage.seasonKnown, false);
  assert.equal(value.statsCoverage.complete, false); assert.equal(value.statsCoverage.partial, true);
  assert.equal(value.statsCoverage.reason, 'provider_statistics_season_unknown');
  assert.equal(value.statsCoverage.fields.passesAccuracy, false);
  assert.equal(value.statsCoverage.fields.passesAccuracyRaw, true);
  assert.equal(calls.length, 1, 'Coverage must not cause extra provider reads');
});

test('names-only SportScore biography remains usable while unsupported sections stay unavailable', async () => {
  const { api } = provider({ player: { name: 'Actual Player', slug: 'actual-player' } });
  const value = await api.getPlayerDetails('actual-player');
  assert.equal(value.id, 'actual-player'); assert.equal(value.name, 'Actual Player');
  assert.equal(value.coverage.available, true); assert.equal(value.coverage.profile.available, true);
  assert.equal(value.coverage.profile.fields.name, true); assert.equal(value.coverage.profile.fields.image, false);
  for (const field of ['dateOfBirth', 'nationality', 'position', 'height', 'weight', 'preferredFoot']) {
    assert.equal(value.coverage.profile.fields[field], false);
    assert.equal(value[field], undefined);
  }
  for (const section of [value.careerCoverage, value.transfersCoverage, value.coverage.career, value.coverage.transfers]) {
    assert.equal(section.available, false); assert.equal(section.complete, false);
    assert.equal(section.reason, 'provider_section_unavailable');
  }
  assert.equal(value.statsCoverage.available, false);
});

test('source edition requires a valid explicit calendar year or consecutive football years', async () => {
  for (const season of [true, {}, [], 'current', '2026/99', '2026/2025', '2026/26', '2026/2028', 1307]) {
    const { api } = provider(profile({ ...zeroCounts(), rating: 7, team: 'Actual Club', competition: 'Actual League', season }));
    const value = await api.getPlayerDetails('actual-player');
    assert.equal(value.statsContext.season, null, JSON.stringify(season));
    assert.equal(value.statsCoverage.seasonKnown, false); assert.equal(value.statsCoverage.complete, false);
  }
  for (const season of [2026, '2026', '2026/27', '2026-2027']) {
    const { api } = provider(profile({ ...zeroCounts(), rating: 7, team: 'Actual Club', competition: 'Actual League', season }));
    const value = await api.getPlayerDetails('actual-player');
    assert.equal(value.statsContext.season, season); assert.equal(value.statsCoverage.seasonKnown, true);
  }
});

test('malformed scalar raw ratings and pass metrics are rejected without guessing undocumented scales', async () => {
  for (const invalid of [true, false, {}, [], '', '  ', '0x10']) {
    const { api } = provider(profile({ rating: invalid, passes_accuracy: invalid }));
    const value = await api.getPlayerDetails('actual-player');
    assert.equal(value.rating, null); assert.equal(value.ratingRaw, null); assert.equal(value.passesAccuracyRaw, null);
  }
  const { api } = provider(profile({ rating: 949, passes_accuracy: 6060 }));
  const value = await api.getPlayerDetails('actual-player');
  assert.equal(value.rating, null); assert.equal(value.ratingRaw, 949); assert.equal(value.passesAccuracy, null); assert.equal(value.passesAccuracyRaw, 6060);
  assert.equal(value.statsCoverage.fields.rating, false);
});

test('SportScore standings reject malformed counts while retaining signed point deductions and goal difference', async () => {
  for (const invalid of [true, {}, '  ', -1, 1.5]) {
    const { api } = provider({ tables: [{ rows: [{ team: 'Actual Club', team_slug: 'actual-club',
      pos: invalid, p: invalid, w: invalid, d: invalid, l: invalid, gf: invalid, ga: invalid, pts: -3, gd: -9 }] }] });
    const [value] = await api.getStandings('PL');
    for (const field of ['position', 'playedGames', 'won', 'draw', 'lost', 'goalsFor', 'goalsAgainst']) assert.equal(value[field], null);
    assert.equal(value.points, -3); assert.equal(value.goalDifference, -9);
  }
  const { api } = provider({ tables: [{ rows: [{ team: 'Actual Club', team_slug: 'actual-club',
    pos: '1', p: '0', w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, gd: 0 }] }] });
  const [value] = await api.getStandings('PL');
  assert.equal(value.position, 1); assert.equal(value.playedGames, 0); assert.equal(value.goalsFor, 0);
});

test('scorer ranking counters follow the same strict source count contract', async () => {
  const { api } = provider({ scorers: [{ player: 'Actual Player', player_slug: 'actual-player',
    rank: 1, goals: true, assists: '0', matches: -2, minutes: '15.5', rating: 6.5 }] });
  const [value] = await api.getTopScorers('PL');
  assert.equal(value.goals, null); assert.equal(value.assists, 0); assert.equal(value.playedMatches, null);
  assert.equal(value.minutesPlayed, null); assert.equal(value.rating, 6.5);
});

test('portrait and dated source honours retain their exact player identity alongside coverage', async () => {
  const raw = profile({ ...zeroCounts() });
  raw.player.honours = [{ name: 'Actual Cup', season: '2025', player_slug: 'actual-player', team: 'Actual Club' }];
  const { api, calls } = provider(raw);
  const value = await api.getPlayerDetails('actual-player');
  assert.equal(value.image, raw.player.logo); assert.equal(value.honours[0].playerId, 'actual-player');
  assert.equal(value.honoursCoverage.available, true);
  assert.equal(value.coverage.honours, value.honoursCoverage);
  assert.equal(calls.length, 1);
});
