const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function teams(bsd) {
  const path = '../services/teamService';
  delete require.cache[require.resolve(path)];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    const mocks = { './bsdSportsService': bsd, './searchService': { CLUBS: {} },
      './sportscoreService': { getTeamDetails: async () => assert.fail('Never recover a BSD selection by name in another provider') },
      './kickoffApiService': { getTeamSquad: async () => assert.fail('Never recover a BSD selection by name in another provider') } };
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { return require(path); } finally { Module._load = original; }
}

function emptyRoster() {
  const rows = [];
  Object.defineProperty(rows, 'coverage', { value: { source: 'bsd', available: true, complete: false, partial: true, reason: 'empty_squad' } });
  return rows;
}

const recovered = () => ({ info: { id: 'bsd_t_465' }, squad: [{ id: 'bsd_p_7', provider: 'bsd', name: 'Verified Player' }],
  squadContext: { source: 'bsd', scope: 'match_squad', teamId: 'bsd_t_465', fixtureId: 'bsd_22', fixtureDate: '2026-10-04T18:00:00Z' },
  coverage: { squad: { source: 'bsd', scope: 'match_squad', available: true, complete: false, partial: true, rosterAvailable: false } } });

test('public BSD squad route exposes recovered selection scope/date and retains exact team identity', async () => {
  const profile = recovered(), requested = [];
  const api = teams({ getTeamSquad: async id => { requested.push(['roster', id]); return emptyRoster(); },
    getTeamDetails: async id => { requested.push(['profile', id]); return profile; } });
  const result = await api.getTeamSquadService(' bsd_t_465 ');
  assert.deepEqual(requested, [['roster', 'bsd_t_465'], ['profile', 'bsd_t_465']]);
  assert.equal(result.success, true);
  assert.equal(result.data, profile.squad);
  assert.equal(result.squadContext, profile.squadContext);
  assert.equal(result.coverage.rosterAvailable, false);
  assert.equal(result.coverage.complete, false);
});

test('a populated authoritative BSD roster needs no deep profile recovery', async () => {
  const squad = [{ id: 'bsd_p_7', name: 'Verified Player' }];
  Object.defineProperty(squad, 'coverage', { value: { source: 'bsd', available: true, complete: true } });
  const api = teams({ getTeamSquad: async () => squad,
    getTeamDetails: async () => assert.fail('A source roster must not trigger profile/fixtures/lineups fanout') });
  const result = await api.getTeamSquadService('bsd_t_465');
  assert.equal(result.data, squad);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.squadContext, undefined);
});

test('wrong team, cross-provider scope and alleged complete match roster cannot replace empty BSD roster', async () => {
  const profiles = [recovered(), recovered(), recovered()];
  profiles[0].info.id = 'bsd_t_699';
  profiles[1].squadContext.source = 'kickoffapi';
  profiles[2].coverage.squad.complete = true;
  for (const profile of profiles) {
    const api = teams({ getTeamSquad: async () => emptyRoster(), getTeamDetails: async () => profile });
    const result = await api.getTeamSquadService('bsd_t_465');
    assert.deepEqual(result.data, []);
    assert.equal(result.coverage.reason, 'empty_squad');
    assert.equal(result.squadContext, undefined);
  }
});

test('unavailable roster and unavailable recovery remain unavailable with explicit coverage', async () => {
  const api = teams({ getTeamSquad: async () => null, getTeamDetails: async () => null });
  const result = await api.getTeamSquadService('bsd_t_465');
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.coverage.available, false);
});
