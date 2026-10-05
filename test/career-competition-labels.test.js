const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCareerCompetitionLabels } = require('../utils/careerCompetitionLabels');

function goldCup(year = 2023, id = 1119) {
  return {
    teamId: 'bsd_t_699',
    leagueId: 69,
    competitionId: 'BSD:69',
    competition: 'CONCACAF Gold Cup 2025',
    league: 'CONCACAF Gold Cup 2025',
    seasonId: id,
    season: `Gold Cup ${year}`,
    seasonInfo: {
      id,
      name: `Gold Cup ${year}`,
      year,
      start_date: `${year}-01-01`,
      end_date: `${year}-12-31`,
      is_current: year === 2025,
    },
    matches: 2,
    goals: 0,
    assists: null,
    source: 'bsd',
  };
}

test('2023 career edition removes 2025 catalog suffix and retains provider labels and season context', () => {
  const row = goldCup();
  const before = structuredClone(row);
  const result = normalizeCareerCompetitionLabels(row);
  assert.equal(result.competition, 'CONCACAF Gold Cup');
  assert.equal(result.league, 'CONCACAF Gold Cup');
  assert.equal(result.season, 'Gold Cup 2023');
  assert.equal(result.seasonId, 1119);
  assert.equal(result.teamId, 'bsd_t_699');
  assert.equal(result.competitionId, 'BSD:69');
  assert.equal(result.matches, 2);
  assert.equal(result.goals, 0);
  assert.equal(result.assists, null);
  assert.deepEqual(result.competitionLabelProvenance, {
    source: 'bsd',
    method: 'season_catalog_edition_neutral_name',
    leagueId: 69,
    seasonId: 1119,
    seasonYear: 2023,
    originalLabels: {
      competition: 'CONCACAF Gold Cup 2025',
      league: 'CONCACAF Gold Cup 2025',
    },
  });
  assert.deepEqual(row, before, 'The helper must not mutate the original provider row.');
});

test('2025 career edition uses the same competition base with its own verified year', () => {
  const result = normalizeCareerCompetitionLabels(goldCup(2025, 1118));
  assert.equal(result.competition, 'CONCACAF Gold Cup');
  assert.equal(result.season, 'Gold Cup 2025');
  assert.equal(result.competitionLabelProvenance.seasonYear, 2025);
  assert.equal(result.competitionLabelProvenance.seasonId, 1118);
});

test('missing, mismatched or contradictory season catalog never becomes a guessed edition', () => {
  for (const change of [
    { seasonInfo: null },
    { seasonInfo: { id: 1118, name: 'Gold Cup 2023', year: 2023 } },
    { seasonInfo: { id: 1119, name: 'Gold Cup 2023' } },
    { seasonInfo: { id: 1119, name: 'Gold Cup 2025', year: 2023 } },
    { seasonInfo: { id: 1119, name: 'Gold Cup 2023', year: 2023, start_date: '2025-01-01' } },
    { seasonId: 2023, seasonInfo: { id: 2023 } },
  ]) {
    const row = { ...goldCup(), ...change };
    assert.deepEqual(normalizeCareerCompetitionLabels(row), row);
  }
});

test('the exact BSD competition context is required and unrelated names are preserved', () => {
  for (const change of [
    { leagueId: 65 },
    { source: 'sportscore' },
    { provider: 'kickoffapi' },
    { competitionId: 'BSD:65' },
    { competition: 'World Cup Qualification 2026', league: 'World Cup Qualification 2026' },
    { competition: 'CONCACAF U17 Gold Cup 2025', league: 'CONCACAF U17 Gold Cup 2025' },
    { competition: 'Gold Cup 2025 qualifiers', league: 'Gold Cup 2025 qualifiers' },
    { competition: 'CONCACAF Gold Cup', league: 'CONCACAF Gold Cup' },
  ]) {
    const row = { ...goldCup(), ...change };
    assert.deepEqual(normalizeCareerCompetitionLabels(row), row);
  }
});

test('normalization is idempotent and keeps already stored provenance', () => {
  const result = normalizeCareerCompetitionLabels(goldCup());
  assert.deepEqual(normalizeCareerCompetitionLabels(result), result);
});
