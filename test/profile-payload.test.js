const test = require('node:test');
const assert = require('node:assert/strict');
const { compactPlayerInfo, compactTeamProfile } = require('../utils/profilePayload');

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

const bytes = value => Buffer.byteLength(JSON.stringify(value));

function fixture() {
  const career = Array.from({ length: 35 }, (_, index) => ({
    teamId: 'bsd_t_44', team: 'Verified Club', competitionId: 'PL', competition: 'Premier League',
    seasonId: 100 + index, season: String(1990 + index), goals: index % 7, assists: 0,
    matches: 30, minutes: 2400, seasonInfo: { id: 100 + index, name: String(1990 + index) },
    statsCoverage: { available: true, complete: false, partial: true },
  }));
  const transfers = [{ fromTeamId: 'bsd_t_2', toTeamId: 'bsd_t_44', date: '2025-07-01', fee: null }];
  const honours = [{ name: 'Verified Cup', season: '2024', place: 'Winner', winner: true }];
  const canonical = {
    careerBySeason: career, transfers, honours,
    seasonStats: { seasonId: 134, competitionId: 'PL', teamId: 'bsd_t_44', goals: 0, assists: null },
    statsContext: { seasonId: 134, competitionId: 'PL', teamId: 'bsd_t_44' },
    statsCoverage: { available: true, complete: false },
    careerCoverage: { available: true, complete: true }, transfersCoverage: { available: true, complete: true },
    honoursCoverage: { available: true, complete: false },
    coverage: { available: true, complete: false, stats: { available: true, complete: false } },
    attributes: { passing: 80 }, careerTotals: {}, formerTeams: [], contracts: [], milestones: [],
  };
  const biography = {
    id: 'bsd_p_852', targetId: 'bsd_p_852', provider: 'bsd', providerId: '852',
    name: 'Verified Player', fullName: 'Verified Full Name', nationality: 'Norway',
    dateOfBirth: '2000-07-21', age: 26, preferredFoot: 'Left', height: 195, weight: null,
    image: '/api/images/bsd/player/852', jerseyNumber: 9, teamId: 'bsd_t_44', team: 'Verified Club',
    currentTeam: { id: 'bsd_t_44', name: 'Verified Club' },
    nationalTeam: { id: 'bsd_t_3', name: 'Norway' },
    availability: { status: 'injured', reason: 'Provider reason', expectedReturn: null },
    contractUntil: '2029-06-30', marketValue: 0, abilityRating: 88,
    strengths: ['Finishing'], weaknesses: [], potential: 'High', customBiography: { verified: true },
    goals: 0, assists: null,
  };
  return { biography, canonical, info: { ...biography, ...canonical, career } };
}

test('a compact deep player retains every biography field and complete canonical records', () => {
  const { biography, canonical, info } = fixture();
  const oldProfile = { info, ...canonical };
  const newProfile = { info: compactPlayerInfo(info, canonical), ...canonical };
  assert.deepEqual(newProfile.info, biography);
  for (const key of Object.keys(canonical)) {
    assert.deepEqual(newProfile[key], oldProfile[key], `Canonical ${key} cannot lose data`);
  }
  // Exercise the actual screen data paths, including real zero and missing counters.
  assert.equal(newProfile.info.currentTeam.id, 'bsd_t_44');
  assert.equal(newProfile.info.nationalTeam.name, 'Norway');
  assert.equal(newProfile.seasonStats.goals, 0);
  assert.equal(newProfile.seasonStats.assists, null);
  assert.equal(newProfile.careerBySeason.length, 35);
  assert.deepEqual(newProfile.statsContext, oldProfile.statsContext);
  assert.deepEqual(newProfile.coverage, oldProfile.coverage);
  assert.equal(newProfile.transfers[0].fee, null);
  assert.equal(newProfile.honours[0].winner, true);
  assert.ok(bytes(newProfile) < bytes(oldProfile) * 0.5,
    `Expected repeated history removal to shrink JSON: ${bytes(oldProfile)} -> ${bytes(newProfile)}`);
});

test('player compaction does not mutate cached inputs or drop a section absent from the root', () => {
  const value = fixture();
  freezeDeep(value);
  const before = JSON.stringify(value);
  const compact = compactPlayerInfo(value.info, value.canonical);
  assert.equal(JSON.stringify(value), before);
  assert.notStrictEqual(compact, value.info);
  assert.strictEqual(compact.currentTeam, value.info.currentTeam);
  const absent = compactPlayerInfo(value.info, {});
  assert.deepEqual(absent, value.info);
  const notSerialized = compactPlayerInfo(value.info, { transfers: undefined });
  assert.strictEqual(notSerialized.transfers, value.info.transfers);
  const explicitEmpty = compactPlayerInfo(value.info, { transfers: [] });
  assert.equal(Object.hasOwn(explicitEmpty, 'transfers'), false);
  const explicitUnknown = compactPlayerInfo(value.info, { honoursCoverage: null });
  assert.equal(Object.hasOwn(explicitUnknown, 'honoursCoverage'), false);
});

test('team compaction removes only the same roster alias and preserves fixture/statistics scope', () => {
  const squad = Array.from({ length: 28 }, (_, index) => ({
    id: `bsd_p_${index + 1}`, name: `Verified Player ${index + 1}`, image: `/api/images/bsd/player/${index + 1}`,
  }));
  const profile = freezeDeep({ info: { id: 'bsd_t_44', name: 'Verified Club' }, squad, players: squad,
    matches: { recent: [{ id: 'bsd_1' }], upcoming: [], live: [] },
    squadContext: { source: 'bsd', scope: 'match_squad' },
    statsScopes: [{ context: { seasonId: 294, competitionId: 'PL' }, stats: { goals: 0 } }],
    coverage: { squad: { complete: false, available: true } } });
  const before = JSON.stringify(profile), compact = compactTeamProfile(profile);
  assert.equal(Object.hasOwn(compact, 'players'), false);
  for (const key of Object.keys(profile).filter(key => key !== 'players')) assert.deepEqual(compact[key], profile[key]);
  assert.strictEqual(compact.squad, squad);
  assert.equal(JSON.stringify(profile), before);
  assert.ok(bytes(compact) < bytes(profile) * 0.65);
});

test('different or noncanonical team rosters and unknown player payloads remain unchanged', () => {
  const players = [{ id: 'bsd_p_1' }];
  for (const team of [{ players }, { squad: null, players }, { squad: [], players }, { squad: [{ id: 'bsd_p_2' }], players }]) {
    assert.deepEqual(compactTeamProfile(team), team);
  }
  assert.deepEqual(compactPlayerInfo(null, {}), {});
  assert.deepEqual(compactPlayerInfo([], {}), {});
  assert.deepEqual(compactTeamProfile(null), {});
});
