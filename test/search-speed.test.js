const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const complete = { available: true, complete: true, partial: false };
const empty = () => ({ teams: [], players: [], competitions: [], coverage: complete });
const bsdResult = () => ({ ...empty(), teams: [
  { id: 'bsd_t_91', provider: 'bsd', name: 'Speed Club' },
] });
const scResult = () => ({ ...empty(), teams: [
  { slug: 'speed-club-sc', name: 'Speed Club SC' },
] });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function loadSearch(bsdSearch, scSearch) {
  const path = require.resolve('../services/searchService');
  delete require.cache[path];
  const original = Module._load;
  const mocks = {
    '../utils/logger': { info() {}, warn() {}, error() {} },
    './bsdSportsService': { isConfigured: () => true, searchEntities: bsdSearch },
    './sportscoreService': { COMPETITION_SLUGS: {}, searchEntities: scSearch },
  };
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(path); } finally { Module._load = original; }
}

test('BSD and SportScore start together before either provider responds', async () => {
  const bsd = deferred();
  const sc = deferred();
  const started = [];
  const search = loadSearch(
    () => { started.push('bsd'); return bsd.promise; },
    () => { started.push('sportscore'); return sc.promise; },
  );
  const pending = search.searchAll('Speed Club');
  assert.deepEqual(started, ['bsd', 'sportscore']);
  sc.resolve(scResult());
  await Promise.resolve();
  assert.deepEqual(started, ['bsd', 'sportscore']);
  bsd.resolve(bsdResult());
  const result = await pending;
  assert.equal(result.source, 'bsd+sportscore');
  assert.deepEqual(result.teams.map(row => row.id), ['bsd_t_91', 'sc_t_speed-club-sc']);
  assert.equal(result.coverage.complete, true);
});

test('normalized simultaneous searches share provider calls and finished results', async () => {
  const bsd = deferred();
  const sc = deferred();
  const calls = [];
  const search = loadSearch(
    (term, limit) => { calls.push(['bsd', term, limit]); return bsd.promise; },
    (term, limit) => { calls.push(['sportscore', term, limit]); return sc.promise; },
  );
  const first = search.searchAll('  Spéed   Club  ');
  const second = search.searchAll('SPEED CLUB');
  assert.deepEqual(calls, [['bsd', 'speed club', 50], ['sportscore', 'speed club', 50]]);
  bsd.resolve(bsdResult());
  sc.resolve(scResult());
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  const cached = await search.searchAll('speed\tclub');
  assert.deepEqual(cached, a);
  assert.equal(calls.length, 2);
});

for (const throws of [false, true]) {
  test(`failed searches are retried and do not create an empty cached success (${throws ? 'throws' : 'null'})`, async () => {
    let bsdCalls = 0;
    let scCalls = 0;
    const search = loadSearch(
      async () => {
        if (++bsdCalls > 1) return bsdResult();
        if (throws) throw new Error('BSD temporarily unavailable');
        return null;
      },
      async () => {
        if (++scCalls > 1) return scResult();
        if (throws) throw new Error('SportScore temporarily unavailable');
        return null;
      },
    );
    const unavailable = await search.searchAll('unlisted speed club');
    assert.equal(unavailable.coverage.available, false);
    assert.deepEqual(unavailable.teams, []);
    const recovered = await search.searchAll('unlisted speed club');
    assert.equal(recovered.coverage.available, true);
    assert.equal(recovered.teams.length, 2);
    assert.equal(bsdCalls, 2);
    assert.equal(scCalls, 2);
    await search.searchAll('UNLISTED SPEED CLUB');
    assert.equal(bsdCalls, 2);
    assert.equal(scCalls, 2);
  });
}

test('a provider-confirmed empty search is cached distinctly from unavailable data', async () => {
  let calls = 0;
  const search = loadSearch(
    async () => { calls++; return empty(); },
    async () => { calls++; return empty(); },
  );
  const result = await search.searchAll('unlisted speed club');
  assert.equal(result.coverage.available, true);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.teams, []);
  await search.searchAll('UNLISTED SPEED CLUB');
  assert.equal(calls, 2);
});

test('local suggestions after provider failure do not suppress the next provider recovery', async () => {
  let bsdCalls = 0;
  let scCalls = 0;
  const search = loadSearch(
    async () => {
      if (++bsdCalls === 1) throw new Error('BSD temporarily unavailable');
      return { ...empty(), teams: [{ id: 'bsd_t_57', provider: 'bsd', name: 'Arsenal' }] };
    },
    async () => {
      if (++scCalls === 1) throw new Error('SportScore temporarily unavailable');
      return empty();
    },
  );
  const fallback = await search.searchAll('Arsenal');
  assert.equal(fallback.source, 'local-fallback');
  assert.equal(fallback.teams[0].id, '57');
  const recovered = await search.searchAll('Arsenal');
  assert.equal(recovered.source, 'bsd');
  assert.deepEqual(recovered.teams.map(row => row.id), ['bsd_t_57']);
  assert.equal(bsdCalls, 2);
  assert.equal(scCalls, 2);
});

test('local-only and provider searches do not share cached suggestions', async () => {
  let bsdCalls = 0;
  let scCalls = 0;
  const search = loadSearch(
    async () => { bsdCalls++; return bsdResult(); },
    async () => { scCalls++; return scResult(); },
  );
  const local = await search.searchAll('Arsenal', { useProvider: false });
  assert.equal(local.source, 'local-fallback');
  assert.equal(bsdCalls, 0);
  assert.equal(scCalls, 0);
  const current = await search.searchAll('Arsenal');
  assert.equal(current.source, 'bsd+sportscore');
  assert.equal(bsdCalls, 1);
  assert.equal(scCalls, 1);
  assert.equal(current.teams.some(row => row.id === '57'), false);
});

test('cached search expires after two minutes and fetches current providers again', async () => {
  const originalNow = Date.now;
  let clock = 1791200000000;
  let calls = 0;
  Date.now = () => clock;
  try {
    const search = loadSearch(
      async () => { calls++; return bsdResult(); },
      async () => { calls++; return scResult(); },
    );
    await search.searchAll('speed club');
    clock += 119999;
    await search.searchAll('speed club');
    assert.equal(calls, 2);
    clock++;
    await search.searchAll('speed club');
    assert.equal(calls, 4);
  } finally {
    Date.now = originalNow;
  }
});

test('the shared search cache stays bounded while keeping recent successful queries', async () => {
  let calls = 0;
  const search = loadSearch(
    async () => { calls++; return bsdResult(); },
    async () => { calls++; return scResult(); },
  );
  for (let i = 0; i <= 100; i++) await search.searchAll(`unique speed club ${i}`);
  assert.equal(calls, 202);
  await search.searchAll('unique speed club 100');
  assert.equal(calls, 202);
  await search.searchAll('unique speed club 0');
  assert.equal(calls, 204);
});
