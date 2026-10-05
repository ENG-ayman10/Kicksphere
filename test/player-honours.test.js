const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { normalizePlayerHonours, playerHonourInput, firstPlayerImage } = require('../utils/playerHonours');
const logger = { info() {}, warn() {}, error() {} };

function load(file, mocks) {
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}
function cache() {
  const map = new Map();
  return { getCached: key => map.get(key), setCache: (key, value) => map.set(key, value) };
}
function kickoff(read) {
  const previousKey = process.env.KICKOFF_API_KEY;
  process.env.KICKOFF_API_KEY = 'unit-test-key';
  const calls = [];
  try {
    return { calls, api: load('../services/kickoffApiService', {
      axios: { create: () => ({ get: async (path, { params }) => {
        calls.push({ path, params }); return { data: await read(path, params) };
      } }) }, '../utils/logger': logger, './cacheService': cache(),
    }) };
  } finally {
    if (previousKey === undefined) delete process.env.KICKOFF_API_KEY;
    else process.env.KICKOFF_API_KEY = previousKey;
  }
}
const scope = { playerId: 'ko_p_278', rawPlayerId: 278, provider: 'kickoffapi', complete: true };
const trophy = (overrides = {}) => ({ playerId: 278, league: 'Champions League', country: 'Europe', season: '2024/2025', place: 'Winner', ...overrides });
const envelope = rows => ({ parameters: { player: '278' }, errors: [], results: rows.length, paging: { current: 1, total: 1 }, response: rows });

test('honour history preserves provider seasons and distinguishes winners from placements', () => {
  const result = normalizePlayerHonours([trophy(), trophy({ league: 'La Liga', place: '2nd Place' })], scope);
  assert.equal(result.honours.length, 2);
  assert.equal(result.honours[0].isWinner, true);
  assert.equal(result.honours[1].isWinner, false);
  assert.equal(result.honours[1].place, '2nd Place');
  assert.equal(result.honours[0].count, 1);
  assert.equal(result.honours[0].playerId, 'ko_p_278');
  assert.equal(result.honoursCoverage.complete, true);
});

test('honour normalization rejects a different explicit player and malformed rows', () => {
  const result = normalizePlayerHonours([trophy(), trophy({ playerId: 279 }), { league: {} }, 'Fake title'], scope);
  assert.equal(result.honours.length, 1);
  assert.equal(result.honoursCoverage.rejected, 3);
  assert.equal(result.honoursCoverage.complete, false);
});

test('empty history, omitted history and partial history have separate coverage', () => {
  assert.equal(normalizePlayerHonours(undefined, scope).honoursCoverage.available, false);
  const empty = normalizePlayerHonours([], scope).honoursCoverage;
  assert.equal(empty.available, true);
  assert.equal(empty.complete, true);
  assert.equal(empty.reason, 'empty_honours');
  const partial = normalizePlayerHonours([trophy()], { ...scope, complete: false }).honoursCoverage;
  assert.equal(partial.partial, true);
  assert.equal(partial.reason, 'provider_history_scope_not_guaranteed');
});

test('duplicate records deduplicate without inventing team, date or trophy count', () => {
  const result = normalizePlayerHonours([trophy(), trophy(), { name: 'Named award' }], scope);
  assert.equal(result.honours.length, 2);
  assert.equal(result.honours[1].count, null);
  assert.equal(result.honours[1].team, '');
  assert.equal(result.honours[1].season, '');
  assert.equal(result.honours[1].isWinner, null);
  assert.deepEqual(playerHonourInput([], [trophy()]), [trophy()]);
});

test('provider image aliases preserve the first valid URL and reject malformed fields', () => {
  assert.equal(firstPlayerImage({}, 'javascript:alert(1)', 'https://provider.test/portrait.png'), 'https://provider.test/portrait.png');
  assert.equal(firstPlayerImage('null', 7), '');
});

test('Kickoff obtains documented exact player history and caches/coalesces it', async () => {
  const { api, calls } = kickoff(async (path, params) => {
    assert.equal(path, '/api/v1/trophies'); assert.equal(params.player, 278);
    return envelope([trophy()]);
  });
  const [first, duplicate] = await Promise.all([api.getPlayerHonours('ko_p_278'), api.getPlayerHonours('ko_p_278')]);
  assert.deepEqual(first, duplicate);
  assert.equal(first.honoursCoverage.complete, true);
  await api.getPlayerHonours('ko_p_278');
  assert.equal(calls.length, 1);
  await api.getPlayerHonours('bsd_p_278');
  assert.equal(calls.length, 1);
});

test('Kickoff cannot attach ignored filters, error envelopes or a foreign player history', async () => {
  for (const data of [
    { ...envelope([trophy()]), parameters: { player: '279' } },
    { ...envelope([trophy()]), errors: { token: 'expired' } },
    { ...envelope([trophy()]), response: {} },
  ]) {
    const { api } = kickoff(() => data);
    assert.equal((await api.getPlayerHonours('ko_p_278')).honoursCoverage.available, false);
  }
  const { api } = kickoff(() => envelope([trophy({ playerId: 279 })]));
  const result = await api.getPlayerHonours('ko_p_278');
  assert.deepEqual(result.honours, []);
  assert.equal(result.honoursCoverage.complete, false);
  assert.equal(result.honoursCoverage.rejected, 1);
});

test('Kickoff keeps a partial page distinct from a complete trophy history', async () => {
  const { api } = kickoff(() => ({ ...envelope([trophy()]), paging: { current: 1, total: 2 } }));
  const result = await api.getPlayerHonours('ko_p_278');
  assert.equal(result.honours.length, 1);
  assert.equal(result.honoursCoverage.complete, false);
});

test('Kickoff deep player preserves source portrait and fetches honours only after verifying its ID', async () => {
  const { api, calls } = kickoff((path) => path === '/api/v1/players' ? {
    response: [{ player: { id: 278, name: 'Verified Player', image: 'https://provider.test/player278.png' }, statistics: [] }],
  } : envelope([trophy()]));
  const profile = await api.getPlayerDetails('ko_p_278');
  assert.equal(profile.image, 'https://provider.test/player278.png');
  assert.equal(profile.honours[0].name, 'Champions League');
  assert.equal(calls.length, 2);
  const wrong = kickoff(() => ({ response: [{ player: { id: 279, name: 'Different Player' } }] }));
  assert.equal(await wrong.api.getPlayerDetails('ko_p_278'), null);
  assert.equal(wrong.calls.length, 1);
});

test('embedded honours avoid another request and retain actual player identity', async () => {
  const { api, calls } = kickoff(() => ({ response: [{ player: { id: 278, name: 'Verified Player', trophies: [trophy()] } }] }));
  const player = await api.getPlayerDetails('ko_p_278');
  assert.equal(player.honours.length, 1);
  assert.equal(player.honoursCoverage.complete, false);
  assert.equal(calls.length, 1);
});

test('SportScore preserves portraits and embedded honours without borrowing another provider', async () => {
  const api = load('../services/sportscoreService', {
    axios: { get: async () => ({ data: { player: { slug: 'verified-player', name: 'Verified Player', photo: 'https://provider.test/player.png',
      honours: [{ name: 'Actual cup', season: '2025', team: 'Actual club', player_slug: 'verified-player' }] }, stats: {} } }) },
    '../utils/logger': logger, './cacheService': cache(),
  });
  const player = await api.getPlayerDetails('verified-player');
  assert.equal(player.image, 'https://provider.test/player.png');
  assert.equal(player.honours[0].playerId, 'verified-player');
  assert.equal(player.honoursCoverage.available, true);
});

test('Kickoff scorer and squad portraits keep source image aliases before deterministic fallback', async () => {
  const { api } = kickoff(path => path === '/api/v1/players/squads' ? {
    response: [{ team: { id: 42 }, players: [{ id: 278, name: 'Verified Player', image: 'https://provider.test/squad.png' }] }],
  } : { response: [{ player: { id: 278, name: 'Verified Player', image: 'https://provider.test/rank.png' }, statistics: [] }] });
  const squad = await api.getTeamSquad('ko_t_42');
  assert.equal(squad[0].image, 'https://provider.test/squad.png');
  const ranking = await api.getTopScorers('PL', 2026);
  assert.equal(ranking[0].player.photo, 'https://provider.test/rank.png');
});

test('SportScore search and rankings preserve explicit source portraits beyond the logo field', async () => {
  const api = load('../services/sportscoreService', {
    axios: { get: async url => ({ data: new URL(url).pathname === '/api/v1/search/' ? {
      players: [{ slug: 'verified-player', name: 'Verified Player', image: 'https://provider.test/search.png' }],
    } : { scorers: [{ player_slug: 'verified-player', player: 'Verified Player', player_photo: 'https://provider.test/ranking.png' }] } }) },
    '../utils/logger': logger, './cacheService': cache(),
  });
  assert.equal((await api.searchEntities('verified')).players[0].image, 'https://provider.test/search.png');
  assert.equal((await api.getTopScorers('PL'))[0].player.image, 'https://provider.test/ranking.png');
});
