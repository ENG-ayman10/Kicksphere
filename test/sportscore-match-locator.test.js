const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { sportscoreMatchLocator, sportscoreMatchLookupCandidate } = require('../utils/sportscoreMatchLocator');
const logger = { info() {}, warn() {}, error() {} };
const slug = 'aff-guatemala-vs-nueva-santa-rosa-cdf';
const token = 'k82rekh2z4yvrep';
const id = slug + token;
const url = `/football/match/${slug}/${token}/`;
const fixture = changes => ({ url, home: 'AFF Guatemala', away: 'Nueva Santa Rosa CDF',
  competition: 'Guatemala Division 2', time: '2026-10-07T21:00:00Z',
  home_score: '0', away_score: '2', status: 'live', ...changes });
function loadProvider(read) {
  const values = new Map(), calls = [];
  const mocks = { '../utils/logger': logger,
    './cacheService': { getCached: key => values.get(key), setCache: (key, value) => values.set(key, value) },
    axios: { get: async value => { const request = new URL(value); calls.push(request); return { data: await read(request) }; } } };
  delete require.cache[require.resolve('../services/sportscoreService')];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  let api;
  try { api = require('../services/sportscoreService'); } finally { Module._load = original; }
  return { api, calls, values };
}
const details = changes => ({ match: fixture({ live_minute: 'HT', status_text: 'Half time',
  incidents: [{ type: 'Goal', time: '23', is_goal: true, side: 'away', player: 'Verified scorer' }],
  ...changes }) });

test('provider match URL retains both exact source segments without changing saved fixture ID', () => {
  const { api } = loadProvider(() => assert.fail('Normalizer is offline'));
  const normalized = api.normalizeMatch(fixture());
  assert.equal(normalized.id, id);
  assert.equal(normalized.slug, id);
  assert.deepEqual(normalized.matchLocator, { id, slug, token, url });
  assert.equal(api.normalizeMatch(fixture({ url: undefined, slug: 'old-opaque-slug' })).id, 'old-opaque-slug');
});

test('only explicit provider URL segments establish a locator; arbitrary concatenated IDs are never truncated', () => {
  for (const value of [id, slug, `/football/match/${slug}/`,
    `https://other.example${url}`, `${url}?slug=another`, `${url}#another`,
    `/football/match/../${token}/`, `/football/match/${slug}/${token}/extra/`, null]) {
    assert.equal(sportscoreMatchLocator(value), null, String(value));
  }
  assert.equal(sportscoreMatchLocator(url.slice(0, -1)).id, id);
});

test('a calendar fixture uses the human widget slug and returns actual same-token events with the existing ID', async () => {
  const { api, calls } = loadProvider(request => request.pathname.includes('/fixtures/')
    ? { matches: [fixture()] } : details());
  const rows = await api.getMatchesByDate('2026-10-07');
  const result = await api.getMatchDetails(rows[0].id);
  const widget = calls.find(request => request.pathname === '/api/widget/match/');
  assert.equal(widget.searchParams.get('slug'), slug, 'Do not send concatenated slug plus opaque token');
  assert.equal(result.id, id, 'Saved subscriptions keep their exact identity');
  assert.equal(result.detailsAvailable, true);
  assert.equal(result.timeline[0].player, 'Verified scorer');
  assert.equal(result.timeline[0].type, 'goal');
  assert.equal(result.matchPhase, 'HALF_TIME');
});

test('an explicit full provider URL resolves cold without arbitrary legacy-ID parsing', async () => {
  const { api, calls } = loadProvider(() => details());
  const result = await api.getMatchDetails(url);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('slug'), slug);
  assert.equal(result.id, id);
  assert.equal(result.detailsAvailable, true);
});

test('a supported canonical application ID guides one cold lookup and still requires the exact returned URL', async () => {
  assert.deepEqual(sportscoreMatchLookupCandidate(id), { id, slug, token, url });
  assert.equal(sportscoreMatchLocator(id), null, 'Candidate parsing never establishes verified URL provenance');
  const { api, calls, values } = loadProvider(() => details());
  assert.equal(values.size, 0, 'The fresh provider module has no fixture or locator cache');
  const result = await api.getMatchDetails(id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('slug'), slug);
  assert.equal(result.id, id);
  assert.equal(result.matchLocator.url, url);
  assert.equal(result.detailsAvailable, true);
  assert.equal(result.timeline[0].player, 'Verified scorer');
});

test('an all-letter 15-character opaque token resolves cold only after exact returned URL verification', async () => {
  const letters = 'abcdefghijklmno';
  const lettersId = slug + letters;
  const lettersUrl = `/football/match/${slug}/${letters}/`;
  const { api, calls } = loadProvider(() => details({ url: lettersUrl }));
  const result = await api.getMatchDetails(lettersId);
  assert.equal(result.id, lettersId);
  assert.equal(result.matchLocator.url, lettersUrl);
  assert.equal(result.detailsAvailable, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('slug'), slug);
  const mismatch = loadProvider(() => details({ url }));
  assert.equal(await mismatch.api.getMatchDetails(lettersId), null);
});

test('long canonical participant slugs remain bounded without changing their saved fixture ID', async () => {
  const longSlug = `${'a'.repeat(100)}-vs-${'b'.repeat(100)}`;
  const longId = longSlug + token;
  const longUrl = `/football/match/${longSlug}/${token}/`;
  assert.ok(longId.length > 120 && longId.length < 256);
  const { api, calls } = loadProvider(() => details({ url: longUrl }));
  const result = await api.getMatchDetails(longId);
  assert.equal(result.id, longId);
  assert.equal(result.matchLocator.url, longUrl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('slug'), longSlug);
});

test('a cold candidate cannot accept a same-pair rematch, missing URL token or mismatched full fixture ID', async () => {
  for (const changes of [
    { url: `/football/match/${slug}/k82rekh2z4yvrxx/` },
    { url: `/football/match/another-vs-rematch/${token}/` },
    { url: undefined, slug },
    { url: `/football/match/${slug}/` }
  ]) {
    const { api, calls } = loadProvider(() => details(changes));
    assert.equal(await api.getMatchDetails(id), null, JSON.stringify(changes));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get('slug'), slug);
  }
});

test('invalid or unsupported cold IDs do not trigger provider guesses; known legacy rows retain summary only', async () => {
  const { api, calls, values } = loadProvider(() => assert.fail('Invalid identities must not make a provider request'));
  for (const value of [null, undefined, 123, {}, '', slug, 'old-opaque-slug', id + '?x=1',
    id.toUpperCase(), '/football/match/' + slug + '/', 'a'.repeat(257), `${'a'.repeat(240)}-vs-b${token}`, `https://other.example${url}`]) {
    assert.equal(await api.getMatchDetails(value), null, String(value));
  }
  values.set('sportscore:fixture:legacy-stable-key', { id: 'legacy-stable-key', status: 'IN_PLAY', score: { fullTime: { home: 1, away: 0 } } });
  const summary = await api.getMatchDetails('legacy-stable-key');
  assert.equal(summary.id, 'legacy-stable-key');
  assert.equal(summary.detailsAvailable, false);
  assert.deepEqual(summary.timeline, []);
  assert.equal(calls.length, 0);
});

test('a widget rematch of the same teams and same kickoff cannot replace another opaque fixture', async () => {
  const { api } = loadProvider(request => request.pathname.includes('/fixtures/')
    ? { matches: [fixture()] } : details({ url: `/football/match/${slug}/differenttoken/`, home_score: 9 }));
  await api.getMatchesByDate('2026-10-07');
  const result = await api.getMatchDetails(id);
  assert.equal(result.id, id);
  assert.equal(result.detailsAvailable, false);
  assert.equal(result.score.fullTime.home, 0);
  assert.deepEqual(result.timeline, []);
  assert.equal(result.lineups, null);
});

test('same URL token does not authorize contradictory teams or kickoff, and missing token is unavailable', async () => {
  for (const changes of [{ home: 'Different Team' }, { time: '2026-10-08T21:00:00Z' }, { url: undefined, slug }]) {
    const { api } = loadProvider(request => request.pathname.includes('/fixtures/')
      ? { matches: [fixture()] } : details(changes));
    await api.getMatchesByDate('2026-10-07');
    const result = await api.getMatchDetails(id);
    assert.equal(result.detailsAvailable, false, JSON.stringify(changes));
    assert.equal(result.id, id);
    assert.deepEqual(result.timeline, []);
  }
});

test('source lookup identity survives score-cache expiry without treating retained identity as a fresh summary', async () => {
  const { api, values, calls } = loadProvider(request => request.pathname.includes('/fixtures/')
    ? { matches: [fixture()] } : details());
  await api.getMatchesByDate('2026-10-07');
  values.delete('sportscore:fixture:' + id);
  const result = await api.getMatchDetails(id);
  assert.equal(calls.at(-1).searchParams.get('slug'), slug);
  assert.equal(result.id, id);
  assert.equal(result.detailsAvailable, true);
  assert.equal(values.has('sportscore:fixture:' + id), false, 'Locator cache cannot recreate cached score freshness');
});

test('an expired summary and a mismatched retained locator yield no fabricated score or events', async () => {
  const { api, values } = loadProvider(request => request.pathname.includes('/fixtures/')
    ? { matches: [fixture()] } : details({ url: `/football/match/${slug}/anotherfixture/` }));
  await api.getMatchesByDate('2026-10-07');
  values.delete('sportscore:fixture:' + id);
  assert.equal(await api.getMatchDetails(id), null);
});

test('a failed provider read retains a known summary with explicit unavailable details', async () => {
  const { api } = loadProvider(request => {
    if (request.pathname.includes('/fixtures/')) return { matches: [fixture()] };
    throw new Error('Provider unavailable');
  });
  await api.getMatchesByDate('2026-10-07');
  const result = await api.getMatchDetails(id);
  assert.equal(result.id, id);
  assert.equal(result.detailsAvailable, false);
  assert.deepEqual(result.timeline, []);
  assert.equal(result.lineups, null);
});
