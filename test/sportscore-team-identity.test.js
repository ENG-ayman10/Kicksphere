const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { fixtureTeam, buildMembershipIndex } = require('../utils/sportscoreTeamIdentity');
const { mergeProviderFixtures } = require('../utils/providerFixtureIdentity');
const { validatedProviderIdentities } = require('../utils/matchProviderIdentities');

const logger = { info() {}, warn() {}, error() {} };
function loadProvider(get) {
  const file = '../services/sportscoreService';
  delete require.cache[require.resolve(file)];
  const cache = new Map();
  const mocks = { axios: { get }, '../utils/logger': logger,
    './cacheService': { getCached: key => cache.get(key), setCache: (key, value) => cache.set(key, value) } };
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, isMain);
  };
  try { return require(file); } finally { Module._load = original; }
}
const fixture = overrides => ({ slug: 'genuine-match-id', home: 'Barcelona', away: 'Opponent',
  competition: 'La Liga', time: '2026-10-01T19:00:00Z', status: 'upcoming', ...overrides });
const table = (slug, rows) => ({ competition_slug: slug, tables: [{ rows }] });

test('audited CONCACAF scope resolves source IDs and joins the same exact fixture without borrowing child data', async () => {
  const provider = loadProvider(async value => ({ data: value.includes('/fixtures/') ? { matches: [fixture({
    slug: 'haiti-vs-costa-rica6ypq3nhvx9wlmd7', home: 'Costa Rica', away: 'Haiti',
    competition: 'CONCACAF Nations League', time: '2026-10-05T03:00:00+03:00',
    status: 'live', home_score: 1, away_score: 0,
  })] } : table('concacaf-nations-league', [
    { team: 'Costa Rica', team_slug: 'costa-rica', team_url: '/football/team/costa-rica/' },
    { team: 'Haiti', team_slug: 'haiti', team_url: '/football/team/haiti/' },
  ]) }));
  const rows = await provider.getMatchesByDate('2026-10-05');
  assert.equal(rows[0].competition.code, 'BSD:65');
  assert.equal(rows[0].homeTeam.id, 'sc_t_costa-rica');
  assert.equal(rows[0].awayTeam.id, 'sc_t_haiti');
  const preferred = { id: 'bsd_223128', provider: 'bsd', source: 'bsd',
    utcDate: '2026-10-05T00:00:00Z', competition: { code: 'BSD:65', country: 'North America' },
    homeTeam: { id: 'bsd_t_699', name: 'Costa Rica' }, awayTeam: { id: 'bsd_t_465', name: 'Haiti' },
    minute: 11, score: { fullTime: {home: 1, away: 0} },
  };
  const merged = mergeProviderFixtures([preferred], rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].homeTeam.id, 'bsd_t_699');
  assert.equal(merged[0].minute, 11);
  assert.deepEqual(merged[0].score, preferred.score);
  assert.deepEqual(validatedProviderIdentities(merged[0]).map(row => row.id),
    ['bsd_223128', 'haiti-vs-costa-rica6ypq3nhvx9wlmd7']);
});

test('CONCACAF name cannot override a conflicting source scope or ambiguous team membership', async () => {
  for (const conflictingSlug of [true, false]) {
    const provider = loadProvider(async value => ({ data: value.includes('/fixtures/') ? { matches: [fixture({
      home: 'Costa Rica', away: 'Haiti', competition: 'CONCACAF Nations League',
      ...(conflictingSlug ? { competition_slug: 'concacaf-gold-cup' } : {}),
    })] } : table('concacaf-nations-league', [
      { team: 'Costa Rica', team_slug: 'costa-rica' }, { team: 'Costa Rica', team_slug: 'costa-rica-u20' },
      { team: 'Haiti', team_slug: 'haiti' },
    ]) }));
    const rows = await provider.getMatchesByDate('2026-10-01');
    assert.equal(rows[0].homeTeam.id, null);
    if (conflictingSlug) {
      assert.equal(rows[0].competition.code, 'SC:concacaf-gold-cup');
      assert.equal(rows[0].awayTeam.id, null);
    }
  }
});

test('fixture display names never become club IDs; explicit provider slugs/URLs are scoped and conflicts stay unresolved', () => {
  for (const name of ['Barcelona', 'barcelona', 'Real Madrid', 'real-madrid']) {
    assert.equal(fixtureTeam({ home: name }, 'home').id, null);
  }
  assert.equal(fixtureTeam({ home: 'Barcelona', home_slug: 'fc-barcelona' }, 'home').id, 'sc_t_fc-barcelona');
  assert.equal(fixtureTeam({ away: 'Barcelona', away_team_url: '/football/team/barcelona-chile/' }, 'away').id,
    'sc_t_barcelona-chile');
  assert.equal(fixtureTeam({ home: { name: 'Club', id: 123 } }, 'home').id, 'sc_t_123');
  assert.equal(fixtureTeam({ home: 'Club', home_slug: 'a'.repeat(115) }, 'home').id.length, 120);
  assert.equal(fixtureTeam({ home: 'Club', home_slug: 'a'.repeat(116) }, 'home').id, null);
  assert.equal(fixtureTeam({ home: 'Club', home_url: 'https://evil.test/football/team/club/' }, 'home').id, null);
  const conflict = fixtureTeam({ home: 'Club', home_slug: 'club-a', home_url: '/football/team/club-b/' }, 'home');
  assert.equal(conflict.id, null);
  assert.equal(conflict.identityConflict, true);
});

test('an ambiguous standings name, including an unresolved duplicate row, cannot certify one club', () => {
  const index = buildMembershipIndex([
    { team: 'Barcelona', team_slug: 'barcelona-spain' },
    { team: 'BARCELONA', team_slug: 'barcelona-other' },
    { team: 'Club A', team_slug: 'club-a' }, { team: 'Club A' },
    { team: 'Unique Club', team_url: '/football/team/unique-club/' },
  ]);
  assert.equal(index.get('barcelona').size, 2);
  assert.equal(index.get('club a').size, 2);
  assert.deepEqual([...index.get('unique club')], ['sc_t_unique-club']);
});

test('namesake clubs resolve only inside each verified provider competition, never a global name index', async () => {
  const requested = [];
  const provider = loadProvider(async value => {
    const url = new URL(value);
    if (url.pathname.includes('/fixtures/')) return { data: { matches: [
      fixture({ slug: 'spain-match' }),
      fixture({ slug: 'brazil-match', competition: 'Brazilian Serie A' }),
      fixture({ slug: 'unknown-match', competition: 'Chilean Amateur League' }),
    ] } };
    const slug = url.searchParams.get('slug'); requested.push(slug);
    return { data: table(slug, [{ team: 'Barcelona', team_slug: slug === 'spanish-la-liga' ? 'barcelona-spain' : 'barcelona-brazil' }]) };
  });
  const matches = await provider.getMatchesByDate('2026-10-01');
  assert.equal(matches[0].homeTeam.id, 'sc_t_barcelona-spain');
  assert.equal(matches[1].homeTeam.id, 'sc_t_barcelona-brazil');
  assert.equal(matches[2].homeTeam.id, null);
  assert.equal(matches[0].homeTeam.identityBasis, 'competition_standings');
  assert.deepEqual(requested.sort(), ['brazilian-serie-a', 'spanish-la-liga']);
});

test('wrong or malformed standings scope does not suppress usable fixtures or attach club IDs', async () => {
  for (const scope of [
    { competition_slug: 'brazilian-serie-a' }, { competition: 'LigaPro Serie A' }, { competition: { name: 'La Liga' } },
  ]) {
    const provider = loadProvider(async value => ({ data: value.includes('/fixtures/') ? { matches: [fixture()] } : {
      ...scope, tables: [{ rows: [{ team: 'Barcelona', team_slug: 'wrong-barcelona' }] }],
    } }));
    const matches = await provider.getMatchesByDate('2026-10-01');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].homeTeam.id, null);
  }
});

test('an explicit conflicting or unknown fixture competition slug cannot borrow a recognized display-name league', async () => {
  let standingsCalls = 0;
  const provider = loadProvider(async value => {
    if (value.includes('/fixtures/')) return { data: { matches: [
      fixture({ slug: 'conflict', competition_slug: 'brazilian-serie-a' }),
      fixture({ slug: 'unknown', competition_slug: 'chilean-amateur-league' }),
    ] } };
    standingsCalls++; return { data: table('spanish-la-liga', [{ team: 'Barcelona', team_slug: 'barcelona-spain' }]) };
  });
  const matches = await provider.getMatchesByDate('2026-10-01');
  assert.deepEqual(matches.map(match => match.homeTeam.id), [null, null]);
  assert.deepEqual(matches.map(match => match.competition.code), ['SC:brazilian-serie-a', 'SC:chilean-amateur-league']);
  assert.equal(standingsCalls, 0);
});

test('ambiguous rows and explicit club conflicts are not overridden by standings', async () => {
  const provider = loadProvider(async value => ({ data: value.includes('/fixtures/') ? { matches: [
    fixture(), fixture({ slug: 'conflicting-team', home: 'Unique', home_slug: 'unique-a', home_url: '/football/team/unique-b/' }),
  ] } : table('spanish-la-liga', [
    { team: 'Barcelona', team_slug: 'barcelona-a' }, { team: 'Barcelona', team_slug: 'barcelona-b' },
    { team: 'Unique', team_slug: 'unique-a' },
  ]) }));
  const matches = await provider.getMatchesByDate('2026-10-01');
  assert.deepEqual(matches.map(match => match.homeTeam.id), [null, null]);
  assert.equal(matches[1].homeTeam.identityConflict, true);
});

test('standings membership shares in-flight lookups and caches results across daily/live calls with at most three requests', async () => {
  const names = ['La Liga', 'Premier League', 'Serie A', 'Bundesliga', 'Ligue 1', 'MLS'];
  let active = 0; let peak = 0; const calls = new Map();
  const provider = loadProvider(async value => {
    const url = new URL(value);
    if (url.pathname.includes('/fixtures/')) return { data: { matches: names.map((competition, i) =>
      fixture({ slug: `league-${i}`, competition, home: 'Same Club', status: 'live',
        time: `${url.searchParams.get('date')}T19:00:00Z` })) } };
    const slug = url.searchParams.get('slug');
    calls.set(slug, (calls.get(slug) || 0) + 1); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return { data: table(slug, [{ team: 'Same Club', team_slug: `club-${slug}` }]) };
  });
  const [first, second] = await Promise.all([provider.getMatchesByDate('2026-10-01'), provider.getMatchesByDate('2026-10-02')]);
  assert.equal(peak, 3);
  assert.equal(calls.size, 6);
  assert.ok([...calls.values()].every(count => count === 1));
  assert.ok(first.every(match => match.homeTeam.id?.startsWith('sc_t_club-')));
  assert.deepEqual(second.map(match => match.homeTeam.id), first.map(match => match.homeTeam.id));
  const live = await provider.getLiveMatches();
  assert.deepEqual(live.map(match => match.homeTeam.id), first.map(match => match.homeTeam.id));
  assert.ok([...calls.values()].every(count => count === 1));
});

test('slow standings return usable fixtures at the eight-second identity deadline and remain single-flight until verified', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let releaseStandings; let calls = 0;
  const provider = loadProvider(async value => {
    if (value.includes('/fixtures/')) return { data: { matches: [fixture({
      time: `${new URL(value).searchParams.get('date')}T19:00:00Z`,
    })] } };
    calls++;
    return await new Promise(resolve => { releaseStandings = () => resolve({
      data: table('spanish-la-liga', [{ team: 'Barcelona', team_slug: 'barcelona-spain' }]),
    }); });
  });
  const first = provider.getMatchesByDate('2026-10-01');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(8000);
  const unresolved = await first;
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].homeTeam.id, null);
  const second = provider.getMatchesByDate('2026-10-02');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseStandings();
  const resolved = await second;
  assert.equal(resolved[0].homeTeam.id, 'sc_t_barcelona-spain');
  const cached = await provider.getMatchesByDate('2026-10-03');
  assert.equal(cached[0].homeTeam.id, 'sc_t_barcelona-spain');
  assert.equal(calls, 1);
  // A later cache fill never mutates a previously returned unresolved fixture.
  assert.equal(unresolved[0].homeTeam.id, null);
});

test('matched details preserve genuine daily club identities; malformed details do not create another club', async () => {
  const provider = loadProvider(async value => ({ data: value.includes('/fixtures/') ? { matches: [fixture()] } :
    value.includes('/standings/') ? table('spanish-la-liga', [{ team: 'Barcelona', team_slug: 'barcelona-spain' }]) :
      { match: fixture() } }));
  const [daily] = await provider.getMatchesByDate('2026-10-01');
  const details = await provider.getMatchDetails(daily.id);
  assert.equal(details.homeTeam.id, daily.homeTeam.id);
  assert.equal(details.awayTeam.id, null);
  assert.equal(details.homeTeam.identityBasis, 'competition_standings');
});

test('team widget fixture enrichment requires its own exact competition slug even beside a verified fixture in the same league', async () => {
  const provider = loadProvider(async value => ({ data: value.includes('/team/') ? {
    team: { slug: 'barcelona-spain', name: 'Barcelona' }, matches: [
      fixture({ slug: 'verified', competition_slug: 'spanish-la-liga' }),
      fixture({ slug: 'display-name-only' }),
      fixture({ slug: 'conflicting', competition_slug: 'brazilian-serie-a' }),
    ],
  } : table('spanish-la-liga', [{ team: 'Barcelona', team_slug: 'barcelona-spain' }]) }));
  const details = await provider.getTeamDetails('barcelona-spain');
  const byId = new Map(details.matches.upcoming.map(match => [match.id, match]));
  assert.equal(byId.get('verified').homeTeam.id, 'sc_t_barcelona-spain');
  assert.equal(byId.get('display-name-only').homeTeam.id, null);
  assert.equal(byId.get('conflicting').homeTeam.id, null);
});
