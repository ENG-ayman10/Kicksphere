// Audited 2026-10-10: SportScore retains two unfinished 2026-09-20 rows for
// this pairing. The clubs confirm the game moved to 2026-09-19, with Dortmund
// at home, and finished 4-1. Keep this quarantine limited to the exact stale
// observations; changed dates, status, participants or scope remain usable.
// https://svlippstadt08.de/news/sv-lippstadt-verlegt-oberliga-spiele-vor
// https://asc-09-dortmund.de/41-gegen-lippstadt-asc-09-nach-sieg-in-turbulentem-duell-weiter-auf-dem-vormarsch/
const STALE_FIXTURE_TOKENS = Object.freeze({
  'asc-09-dortmund-vs-sv-lippstadtx7lm7phxgw7wm2w': 'x7lm7phxgw7wm2w',
  'asc-09-dortmund-vs-sv-lippstadt1l4rjnhnyk2gm7v': '1l4rjnhnyk2gm7v',
});
const STALE_KICKOFF = Date.parse('2026-09-20T13:00:00Z');
const STALE_SLUG = 'asc-09-dortmund-vs-sv-lippstadt';
const SCOPE_FIELDS = ['gender', 'sex', 'ageGroup', 'age_group', 'category', 'squadType', 'squad_type', 'type',
  'country', 'countryCode', 'identityCompetitionCode', 'identityCompetitionSlug', 'season', 'seasonId',
  'round', 'roundLabel', 'stage', 'group', 'leg', 'isWomen', 'is_women', 'isFemale', 'isYouth', 'is_youth',
  'isReserve', 'is_reserve', 'isReserves'];
const reportedScope = object => SCOPE_FIELDS.some(key => object?.[key] !== undefined && object[key] !== null &&
  object[key] !== '' && object[key] !== false);

function isQuarantinedProviderFixture(match, kickoffMs) {
  if (!match || !Object.hasOwn(STALE_FIXTURE_TOKENS, match.id) || kickoffMs !== STALE_KICKOFF ||
      match.provider !== 'sportscore' || match.source !== 'sportscore' || match.slug !== match.id ||
      match.status !== 'TIMED' || match.sourceStatus !== 'upcoming' || match.statusText !== 'Not started' ||
      match.matchPhase !== 'NOT_STARTED' || match.minute !== null || match.period !== '' ||
      match.halfTimeConfirmed !== false || match.providerIdentities !== undefined) return false;
  const token = STALE_FIXTURE_TOKENS[match.id], locator = match.matchLocator;
  if (locator?.id !== match.id || locator.slug !== STALE_SLUG || locator.token !== token ||
      locator.url !== `/football/match/${STALE_SLUG}/${token}/` ||
      match.competition?.id !== 'SC:german bundesliga 5' || match.competition.code !== 'SC:german bundesliga 5' ||
      match.competition.name !== 'German Bundesliga 5') return false;
  const teams = [match.homeTeam, match.awayTeam];
  if (teams.some(team => !team || team.id !== null || team.identityBasis !== null || team.provider !== 'sportscore' ||
      (team.source && team.source !== 'sportscore') || team.providerId || team.targetId || team.rawId) ||
      teams[0].name !== 'SV Lippstadt' || teams[1].name !== 'ASC 09 Dortmund' ||
      (match.competition.provider && match.competition.provider !== 'sportscore') ||
      (match.competition.source && match.competition.source !== 'sportscore') ||
      [match, match.competition, ...teams].some(reportedScope)) return false;
  return match.score?.fullTime?.home === null && match.score.fullTime.away === null && match.score.halfTime === null;
}

module.exports = { isQuarantinedProviderFixture };
