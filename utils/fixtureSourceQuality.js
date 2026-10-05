// Reviewed upstream conflicts, scoped to the exact observed fixture context.
// These are quarantined records, not cancellations or replacement identities.
const scheduleSource = 'https://www.concacaf.com/competitions/nations-league/news/2026-27-concacaf-nations-league-september-october-schedule-confirmed';
const conflicts = Object.freeze([
  Object.freeze({ provider: 'bsd', id: 'bsd_223136', competitionId: 65, seasonId: 1633,
    homeTeamId: 668, awayTeamId: 2293, utcDate: '2026-10-05T18:00:00.000Z',
    reason: 'official_schedule_conflict', sourceUrl: scheduleSource, checkedAt: '2026-10-05T09:33:22Z' }),
  Object.freeze({ provider: 'bsd', id: 'bsd_223137', competitionId: 65, seasonId: 1633,
    homeTeamId: 2308, awayTeamId: 681, utcDate: '2026-10-05T18:00:00.000Z',
    reason: 'official_schedule_conflict', sourceUrl: scheduleSource, checkedAt: '2026-10-05T09:33:22Z' }),
]);
const contextKeys = ['provider', 'id', 'competitionId', 'seasonId', 'homeTeamId', 'awayTeamId', 'utcDate'];
function getFixtureSourceConflict(context) {
  // A corrected tuple or actual live/terminal state needs a fresh review;
  // never suppress it using a historical scheduled-record decision.
  if (context?.status !== 'TIMED') return null;
  const found = conflicts.find(row => contextKeys.every(key => row[key] === context[key]));
  return found ? { id: found.id, reason: found.reason, sourceUrl: found.sourceUrl, checkedAt: found.checkedAt } : null;
}
function requiresFixtureSourceReview(provider, id) {
  return conflicts.some(row => row.provider === provider && row.id === id);
}
module.exports = { getFixtureSourceConflict, requiresFixtureSourceReview };
