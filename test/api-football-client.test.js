'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const response = (headers = {}) => ({ status: 200, data: { errors: [], response: [] }, headers });
function client(read = () => response(), overrides = {}) {
  const configKeys = ['API_FOOTBALL_KEY', 'API_FOOTBALL_DAILY_REQUEST_BUDGET', 'API_FOOTBALL_MINUTE_REQUEST_BUDGET'];
  const previous = Object.fromEntries(configKeys.map(key => [key, process.env[key]]));
  for (const key of configKeys) delete process.env[key];
  process.env.API_FOOTBALL_KEY = 'mock-api-football-key';
  Object.assign(process.env, overrides);
  const calls = [];
  let config;
  const original = Module._load;
  delete require.cache[require.resolve('../services/apiFootballClient')];
  Module._load = function (name, parent, isMain) {
    if (name === 'axios') return { create: options => {
      config = options;
      return { get: async (path, request) => { calls.push({ path, request }); return read(path, request); } };
    } };
    return original.call(this, name, parent, isMain);
  };
  try { return { service: require('../services/apiFootballClient'), calls, get config() { return config; } }; }
  finally {
    Module._load = original;
    for (const key of configKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
async function clock(run) {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  try { await run(ms => { now += ms; }); } finally { Date.now = original; }
}

test('different supplement endpoints share the same daily request budget', async () => clock(async advance => {
  const { service, calls } = client(undefined, { API_FOOTBALL_DAILY_REQUEST_BUDGET: '3' });
  for (const path of ['/players/profiles', '/trophies', '/teams']) {
    assert.ok((await service.fetchResource(path)).data);
  }
  const overflow = await service.fetchResource('/players/squads');
  assert.equal(overflow.reason, 'provider_daily_request_budget_exhausted');
  assert.equal(overflow.retryAfterMs, 24 * 60 * 60 * 1000);
  assert.equal(calls.length, 3);
  advance(60000);
  assert.equal((await service.fetchResource('/trophies')).reason, 'provider_daily_request_budget_exhausted');
  advance(24 * 60 * 60 * 1000 - 60000);
  assert.ok((await service.fetchResource('/players/squads')).data);
  assert.equal(calls.length, 4);
}));

test('default minute request budget rejects excess calls until its sliding window ends', async () => clock(async advance => {
  const { service, calls } = client();
  for (let index = 0; index < 8; index += 1) assert.ok((await service.fetchResource('/teams')).data);
  const overflow = await service.fetchResource('/players/squads');
  assert.equal(overflow.reason, 'provider_minute_request_budget_exhausted');
  assert.equal(overflow.retryAfterMs, 60000);
  advance(59999);
  assert.equal((await service.fetchResource('/trophies')).reason, 'provider_minute_request_budget_exhausted');
  assert.equal(calls.length, 8);
  advance(1);
  assert.ok((await service.fetchResource('/trophies')).data);
  assert.equal(calls.length, 9);
}));

test('optional budgets cannot raise Free plan hard caps', async () => clock(async advance => {
  const { service, calls } = client(undefined, {
    API_FOOTBALL_DAILY_REQUEST_BUDGET: '999', API_FOOTBALL_MINUTE_REQUEST_BUDGET: '999',
  });
  for (let minute = 0; minute < 10; minute += 1) {
    for (let index = 0; index < 10; index += 1) assert.ok((await service.fetchResource('/teams')).data);
    if (minute < 9) assert.equal((await service.fetchResource('/trophies')).reason, 'provider_minute_request_budget_exhausted');
    advance(60000);
  }
  assert.equal((await service.fetchResource('/players/profiles')).reason, 'provider_daily_request_budget_exhausted');
  assert.equal(calls.length, 100);
}));

test('two active requests bound all supplements and overflow does not wait or consume quota', async () => {
  const releases = [];
  let held = true;
  const { service, calls } = client(() => held ? new Promise(resolve => releases.push(resolve)) : response());
  const first = service.fetchResource('/teams');
  const second = service.fetchResource('/players/profiles');
  assert.equal((await service.fetchResource('/trophies')).reason, 'provider_request_capacity_exceeded');
  assert.equal(calls.length, 2);
  held = false;
  releases.forEach(release => release(response()));
  assert.ok((await first).data);
  assert.ok((await second).data);
  assert.ok((await service.fetchResource('/players/squads')).data);
  assert.equal(calls.length, 3);
});

test('positive remaining quota headers constrain the next supplement before exhaustion', async () => clock(async advance => {
  const { service, calls } = client(() => response({
    'x-ratelimit-requests-remaining': '1',
    'x-ratelimit-requests-reset': String(Math.floor((Date.now() + 3600000) / 1000)),
  }));
  assert.ok((await service.fetchResource('/teams')).data);
  assert.ok((await service.fetchResource('/trophies')).data);
  assert.equal((await service.fetchResource('/players/squads')).reason, 'provider_daily_quota_exhausted');
  assert.equal(calls.length, 2);
  advance(3600000);
  assert.ok((await service.fetchResource('/players/profiles')).data);
  assert.equal(calls.length, 3);
}));

test('minute headers cannot restore already reserved quota from a concurrent response', async () => clock(async advance => {
  let count = 0;
  const { service, calls } = client(() => response({
    'X-RateLimit-Remaining': String(++count === 1 ? 1 : 9),
    'x-ratelimit-reset': String(Math.floor((Date.now() + 60000) / 1000)),
  }));
  assert.ok((await service.fetchResource('/teams')).data);
  assert.ok((await service.fetchResource('/trophies')).data);
  assert.equal((await service.fetchResource('/players/profiles')).reason, 'provider_rate_limited');
  assert.equal(calls.length, 2);
  advance(60000);
  assert.ok((await service.fetchResource('/players/squads')).data);
}));

test('401 and 403 pause every endpoint and recover only after the access backoff', async () => {
  for (const status of [401, 403]) await clock(async advance => {
    let denied = true;
    const { service, calls } = client(() => {
      if (denied) throw { response: { status }, config: { secret: 'mock-api-football-key' } };
      return response();
    });
    assert.equal((await service.fetchResource('/teams')).reason, 'provider_auth_failed');
    const blocked = await service.fetchResource('/players/profiles');
    assert.equal(blocked.reason, 'provider_auth_failed');
    assert.equal(JSON.stringify(blocked).includes('mock-api-football-key'), false);
    advance(5 * 60 * 1000 - 1);
    assert.equal((await service.fetchResource('/players/squads')).reason, 'provider_auth_failed');
    assert.equal(calls.length, 1);
    denied = false;
    advance(1);
    assert.ok((await service.fetchResource('/trophies')).data);
    assert.equal(calls.length, 2);
  });
});

test('aborted transports and nonallowlisted endpoints never consume provider requests', async () => {
  const { service, calls, config } = client();
  for (const path of ['https://other.example/teams', '/fixtures', '/teams?search=Yemen', '//other.example/teams']) {
    assert.equal((await service.fetchResource(path)).reason, 'provider_endpoint_refused');
  }
  assert.equal((await service.fetchResource('/teams', {}, AbortSignal.abort())).reason, 'provider_timeout');
  assert.equal(calls.length, 0);
  assert.equal(config.baseURL, 'https://v3.football.api-sports.io');
  assert.equal(config.maxRedirects, 0);
  assert.ok((await service.fetchResource('/teams')).data);
  assert.equal(calls[0].request.timeout, 3500);
  assert.ok(calls[0].request.signal instanceof AbortSignal);
});
