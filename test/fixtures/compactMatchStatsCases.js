'use strict';

// Synthetic wire cases, also exported through the real projector into the
// Dart contract fixture. These contain no real account/provider information.
const bsdSeed = () => ({
  id: 'bsd_42', provider: 'bsd', source: 'bsd', status: 'IN_PLAY',
  utcDate: '2026-10-17T18:00:00Z', competition: { code: 'PL' },
  homeTeam: { id: 'bsd_t_1', name: 'Home', provider: 'bsd' },
  awayTeam: { id: 'bsd_t_2', name: 'Away', provider: 'bsd' },
  score: { fullTime: { home: 1, away: 0 } },
});
const scSeed = () => ({
  id: 'home-vs-away-match', provider: 'sportscore', source: 'sportscore', status: 'IN_PLAY',
  utcDate: '2026-10-17T18:00:00Z', competition: { code: 'PL' },
  homeTeam: { id: 'sc_t_home', name: 'Home', provider: 'sportscore' },
  awayTeam: { id: 'sc_t_away', name: 'Away', provider: 'sportscore' },
  score: { fullTime: { home: 1, away: 0 } },
});

function compactMatchStatsCases() {
  const goal = { id: 'g1', type: 'Goal', minute: 12, side: 'home', teamId: 'bsd_t_1',
    scorer: 'Scorer', playerId: 'bsd_p_7', playerImage: 'https://example.test/7.png',
    assist: 'Assist', assistId: 'bsd_p_8', assistImage: 'https://example.test/8.png', provider: 'bsd' };
  const h2h = { numberOfMatches: 1, complete: false, homeTeam: { wins: 1, draws: 0 },
    awayTeam: { wins: 0 }, matches: [{ id: 'bsd_41', status: 'FINISHED', score: { fullTime: { home: 2, away: 0 } } }] };
  const full = {
    matchInfo: { ...bsdSeed(), canonicalMatchId: 'bsd_42', venue: 'Example Stadium', referees: [{ name: 'Official' }],
      homeTeam: { ...bsdSeed().homeTeam, lineup: [{ id: 'bsd_p_7', rating: 8.2 }], bench: [{ id: 'bsd_p_9' }], futureTeam: { keep: true } },
      lineups: { home: [{ id: 'bsd_p_7', rating: 8.2 }], away: [] },
      timeline: [{ ...goal, type: 'goal' }], providerStatistics: [{ label: 'Shots', home: 3, away: 0 }], head2head: h2h,
      futureIdentity: { scope: 'verified_fixture', keep: null } },
    timeline: [{ ...goal, type: 'goal' }], lineups: { home: [{ id: 'bsd_p_7', rating: 8.2 }] },
    providerStatistics: [{ label: 'Shots', home: 3, away: 0 }], playerStatistics: [{ playerId: 'bsd_p_7', rating: 8.2 }],
    goals: [goal], bookings: [{ id: 'c1', playerId: 'bsd_p_10', card: 'YELLOW', rescinded: true }], substitutions: [],
    statistics: { hasAdvancedStats: true, xgEstimated: true, xgClassification: 'estimated',
      team1: { ballPossession: 60, expectedGoals: 0.8, xgEstimated: true, totalShots: 3, futureMetric: 0 },
      team2: { ballPossession: 40, expectedGoals: null, expectedGoalsEstimated: false, totalShots: 0 },
      yellowCards: { home: null, away: 0 }, substitutions: { home: 0, away: null }, futureStats: [null, 0] },
    head2head: h2h, venue: 'Example Stadium', venueInfo: { capacity: 0 }, referees: [{ name: 'Official' }],
    prediction: { mostLikelyScore: '1-0', confidence: 72, confidenceScale: 100, prediction: true }, aiPreview: null,
    shotMap: [{ player_id: 7, x: 80, xgEstimated: true }], pressure: [{ minute: 1, home: 0 }],
    momentum: [{ minute: 1 }], averagePositions: { home: [{ playerId: 'bsd_p_7', x: 60 }] },
    tracker: null, coaches: { home: null, away: { id: 'coach2' } }, availability: { stats: true },
    coverage: { available: true, complete: false, partial: true, incidents: { complete: false } },
    source: 'bsd', futureExtension: { timeline: ['preserve unknown nesting'], empty: null },
  };
  const legacy = {
    matchInfo: { ...bsdSeed(), id: 'home-vs-away-match', canonicalMatchId: 'bsd_42', sourceMatchId: 'bsd_42',
      providerIdentities: [
        { id: 'bsd_42', provider: 'bsd', homeTeamId: 'bsd_t_1', awayTeamId: 'bsd_t_2', utcDate: '2026-10-17T18:00:00Z', competitionCode: 'PL' },
        { id: 'home-vs-away-match', provider: 'sportscore', homeTeamId: 'sc_t_home', awayTeamId: 'sc_t_away', utcDate: '2026-10-17T18:00:00Z', competitionCode: 'PL' },
      ], lineups: {}, timeline: [], providerStatistics: [], head2head: null },
    statistics: { hasAdvancedStats: true, team1: { totalShots: 0 }, team2: { totalShots: null }, xgClassification: 'unknown' },
    goals: [], bookings: [], substitutions: [], head2head: null,
    coverage: { available: true, complete: false, partial: true }, source: 'bsd',
  };
  const corrected = {
    matchInfo: { ...scSeed(), timeline: [], lineups: {}, providerStatistics: [], head2head: h2h },
    goals: [], bookings: [], substitutions: [], head2head: null, prediction: null,
    statistics: { hasAdvancedStats: false, goals: { home: 0, away: 0 }, yellowCards: { home: null, away: 0 } },
    coverage: { available: true, incidents: { available: true, complete: true } }, source: 'sportscore',
  };
  return [
    { name: 'native BSD rich summary advanced statistics and unknown extensions', requestedId: 'bsd_42', initialMatch: bsdSeed(), full,
      expectedIdentityMatch: true, expectedSummaryAttach: true },
    { name: 'verified legacy public route preserves canonical provenance', requestedId: 'home-vs-away-match', initialMatch: scSeed(), full: legacy,
      expectedIdentityMatch: true, expectedSummaryAttach: true },
    { name: 'SportScore empty corrected goals and explicit H2H null', requestedId: 'home-vs-away-match', initialMatch: scSeed(), full: corrected,
      expectedIdentityMatch: true, expectedSummaryAttach: true },
    { name: 'wrong fixture ID must remain rejected', requestedId: 'bsd_42', initialMatch: bsdSeed(),
      full: { matchInfo: { ...bsdSeed(), id: 'bsd_43', timeline: [] }, statistics: { team1: { totalShots: 99 } }, goals: [goal] },
      expectedIdentityMatch: false, expectedSummaryAttach: false },
    { name: 'reversed scoped participants must remain rejected', requestedId: 'bsd_42', initialMatch: bsdSeed(),
      full: { matchInfo: { ...bsdSeed(), homeTeam: bsdSeed().awayTeam, awayTeam: bsdSeed().homeTeam, lineups: {} }, statistics: { team1: { totalShots: 99 } } },
      expectedIdentityMatch: false, expectedSummaryAttach: false },
    { name: 'malformed matchInfo scalar is not made into an identity', shapeOnly: true,
      full: { matchInfo: false, statistics: { team1: { totalShots: null } }, coverage: null, head2head: null, timeline: [] } },
    { name: 'malformed matchInfo array is retained', shapeOnly: true,
      full: { matchInfo: [{ id: 'bsd_42', timeline: ['unchanged'] }], statistics: false, futureExtension: null, playerStatistics: [] } },
    { name: 'scalar data failure is retained', shapeOnly: true, full: false },
    { name: 'null data failure is retained', shapeOnly: true, full: null },
  ];
}

module.exports = { compactMatchStatsCases };
