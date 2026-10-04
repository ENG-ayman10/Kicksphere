const test = require('node:test');
const assert = require('node:assert/strict');
const { optionsFromArgs, runSportsSmoke, assertCalendar, readBoundedResponse, imageContainerType } = require('../scripts/smoke-sports');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7WQAAAAASUVORK5CYII=', 'base64');

const options = () => optionsFromArgs(['http://127.0.0.1:3000', '--allow-local', '--date', '2026-10-01']);
const coverage = { available: true, complete: true, partial: false, possiblyTruncated: false };
const fixture = { id: 'bsd_10', utcDate: '2026-10-01T18:00:00Z', competition: { code: 'PL' },
  homeTeam: { id: 'bsd_t_57', name: 'Home' }, awayTeam: { id: 'bsd_t_58', name: 'Away' } };
function responses(overrides = {}) {
  const interval = options();
  const bodies = {
    '/api/health': { success: true, environment: 'development' },
    '/api/ready': { success: true, status: 'ready' },
    '/api/stats/deep/competitions': { success: true, source: 'bsd+supported-contract', coverage,
      data: [{ code: 'PL', provider: 'bsd' }] },
    '/api/matches': { success: true, source: 'bsd+sportscore', range: { from: interval.from, to: interval.to, toExclusive: true }, total: 1, coverage,
      data: [{ matches: [fixture] }] },
    '/api/stats/deep/team/bsd_t_57': { success: true, source: 'bsd', data: { info: { id: 'bsd_t_57', name: 'Home' } } },
    '/api/teams/bsd_t_57/squad': { success: true, source: 'bsd', coverage, data: [{ id: 'bsd_p_20' }] },
    '/api/stats/deep/player/bsd_p_20': { success: true, source: 'bsd',
      data: { info: { id: 'bsd_p_20', currentTeam: { id: 'bsd_t_57' } } } },
    '/api/stats/deep/player/bsd_p_0': { success: false },
    ...overrides,
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    const path = url.pathname;
    if (path.startsWith('/api/images')) return new Response(png,
      { headers: { 'Content-Type': 'image/png' } });
    return new Response(JSON.stringify(bodies[path]), { status: path.endsWith('bsd_p_0') ? 404 : 200,
      headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, requests };
}

test('release gate rejects credential-bearing origins and impossible dates before making any request', () => {
  for (const args of [['http://example.com'], ['https://user:secret@example.com'],
    ['https://example.com/api'], ['https://example.com', '--date', '2026-02-30'],
    ['https://example.com', '--team', 'sc_t_other'], ['https://example.com', '--unknown']]) {
    assert.throws(() => optionsFromArgs(args));
  }
  assert.equal(options().origin, 'http://127.0.0.1:3000');
});

test('release gate verifies the complete public route chain using GET only and reports no response bodies', async () => {
  const mocked = responses();
  const report = await runSportsSmoke(options(), mocked.fetchImpl);
  assert.equal(report.success, true);
  assert.equal(report.checks.length, 9);
  assert.ok(mocked.requests.every(request => request.method === 'GET'));
  assert.deepEqual(report.warnings, []);
  assert.equal(JSON.stringify(report).includes('currentTeam'), false);
});

test('HTTP 200 with an old catalog, wrong player club or out-of-window fixture fails the release gate', async () => {
  const variants = [
    { '/api/stats/deep/competitions': { success: true, source: 'sportscore', data: [{ code: 'PL' }] } },
    { '/api/stats/deep/player/bsd_p_20': { success: true, source: 'bsd',
      data: { info: { id: 'bsd_p_20', currentTeam: { id: 'bsd_t_999' } } } } },
    { '/api/matches': { success: true, source: 'bsd', range: { from: options().from, to: options().to, toExclusive: true }, total: 1, coverage,
      data: [{ matches: [{ ...fixture, utcDate: options().to }] }] } },
  ];
  for (const variant of variants) {
    const report = await runSportsSmoke(options(), responses(variant).fetchImpl);
    assert.equal(report.success, false);
  }
});

test('partial coverage remains a warning with explicit incomplete metadata and cannot become a completeness claim', async () => {
  const mocked = responses({ '/api/matches': { success: true, source: 'bsd+sportscore',
    range: { from: options().from, to: options().to, toExclusive: true },
    total: 0, data: [], coverage: { ...coverage, complete: false, partial: true, possiblyTruncated: true } } });
  const report = await runSportsSmoke(options(), mocked.fetchImpl);
  assert.equal(report.success, true);
  assert.equal(report.calendarCoverage.complete, false);
  assert.equal(report.warnings.length, 1);
});

test('duplicate fixtures, cross-provider BSD teams and mismatched totals cannot pass', async () => {
  for (const matches of [[fixture, fixture], [{ ...fixture, homeTeam: { name: 'Home', id: 'sc_t_home' } }]]) {
    const mocked = responses({ '/api/matches': { success: true, source: 'bsd',
      range: { from: options().from, to: options().to, toExclusive: true },
      total: matches.length, coverage, data: [{ matches }] } });
    assert.equal((await runSportsSmoke(options(), mocked.fetchImpl)).success, false);
  }
});

test('HTML masquerading as a successful image is detected', async () => {
  const mocked = responses();
  const fetchImpl = (url, init) => url.pathname.startsWith('/api/images') ?
    Promise.resolve(new Response('<html>error</html>', { headers: { 'Content-Type': 'image/png' } })) : mocked.fetchImpl(url, init);
  const report = await runSportsSmoke(options(), fetchImpl);
  assert.equal(report.success, false);
  assert.equal(report.checks.find(check => check.name === 'BSD public image').passed, false);
});

test('calendar readiness agrees with client availability, exclusive interval and explicit kickoff timezone', () => {
  const valid = { success: true, source: 'bsd', coverage, total: 1,
    range: { from: options().from, to: options().to, toExclusive: true }, data: [{ matches: [fixture] }] };
  for (const changes of [
    { source: 'unavailable' }, { coverage: { ...coverage, available: false } },
    { range: { ...valid.range, toExclusive: false } },
    { data: [{ matches: [{ ...fixture, utcDate: '2026-10-01T18:00:00' }] }] },
  ]) assert.throws(() => assertCalendar({ ...valid, ...changes }, options()));
  const march = optionsFromArgs(['https://example.com', '--date', '2026-03-02']);
  assert.throws(() => assertCalendar({ ...valid, range: { from: march.from, to: march.to, toExclusive: true },
    data: [{ matches: [{ ...fixture, utcDate: '2026-02-30T18:00:00Z' }] }] }, march));
});

test('bounded reader cancels overflowing streamed responses without consuming the remaining payload', async () => {
  let canceled = false, reads = 0;
  const stream = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(8)); },
    cancel() { canceled = true; },
  });
  await assert.rejects(readBoundedResponse(new Response(stream), 10), /size limit/);
  assert.equal(canceled, true);
  assert.ok(reads <= 3);
  assert.deepEqual(await readBoundedResponse(new Response(new Uint8Array(10)), 10), new Uint8Array(10));
});

test('valid image containers pass while a bare prefix or missing end chunk is rejected', () => {
  assert.equal(imageContainerType(png), 'image/png');
  assert.equal(imageContainerType(png.subarray(0, 8)), null);
  assert.equal(imageContainerType(png.subarray(0, png.length - 12)), null);
  assert.equal(imageContainerType(Buffer.from([255, 216, 255, 217])), null);
});
