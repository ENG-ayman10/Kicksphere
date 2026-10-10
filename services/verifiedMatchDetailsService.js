'use strict';

const bsd = require('./bsdSportsService');
const { getCached, setCache } = require('./cacheService');
const { fixtureProviderIdentity, findVerifiedCanonicalFixture } = require('../utils/providerFixtureIdentity');
const { validatedProviderIdentities } = require('../utils/matchProviderIdentities');
const pending = new Map();

// An old SportScore URL remains a public route. Only the verified fixture join
// may recover its richer BSD record; query hints, names or a similar rematch
// cannot authorize that redirect. One date/competition batch is shared by all
// sections, with a short retry window when it is unavailable.
async function resolveVerifiedBsdFixture(match) {
  const identity = fixtureProviderIdentity(match);
  if (identity?.provider !== 'sportscore' || !bsd.isConfigured?.() || !bsd.getMatches) return null;
  const cohortKeys = ['type', 'gender', 'sex', 'ageGroup', 'age_group', 'category', 'squadType', 'squad_type',
    'isWomen', 'is_women', 'isFemale', 'isYouth', 'is_youth', 'isReserve', 'is_reserve', 'isReserves'];
  const scope = object => Object.fromEntries(cohortKeys.filter(key => object?.[key] !== undefined)
    .map(key => [key, object[key]]));
  const teamScope = team => ({ name: team?.name, country: team?.country, countryCode: team?.countryCode,
    identityCompetitionCode: team?.identityCompetitionCode, ...scope(team) });
  // A provider may correct kickoff/participants while retaining its URL. That
  // correction must not reuse an earlier join or in-flight request's identity.
  const key = 'verified-bsd-fixture:' + JSON.stringify([identity, teamScope(match.homeTeam), teamScope(match.awayTeam),
    { country: match.competition?.country, countryCode: match.competition?.countryCode, ...scope(match.competition) },
    { round: match.round, group: match.group, stage: match.stage, leg: match.leg, ...scope(match) }]);
  const cached = getCached(key);
  if (cached) return cached.fixture || null;
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    let fixture = null;
    try {
      const date = new Date(identity.utcDate).toISOString().slice(0, 10);
      const rows = await bsd.getMatches({ date, competition: identity.competitionCode, limit: 200 },
        { maxPages: 1, maxRows: 200, timeoutMs: 3500 });
      // A truncated batch could hide a second candidate. Do not certify a
      // unique cross-provider fixture from incomplete evidence.
      if (rows?.coverage?.complete === true) {
        fixture = findVerifiedCanonicalFixture(identity.id, rows, [match]);
        if (fixture?.provider !== 'bsd') fixture = null;
      }
    } catch (_) { /* Optional enrichment must not erase the original source. */ }
    setCache(key, { fixture }, 15000);
    return fixture;
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}

function publicFixture(fixture, publicId) {
  return { ...fixture, id: publicId, slug: publicId, canonicalMatchId: fixture.id,
    sourceMatchId: fixture.id, providerIdentities: validatedProviderIdentities(fixture) };
}

async function getVerifiedBsdDetails(match) {
  const fixture = await resolveVerifiedBsdFixture(match);
  if (!fixture || !bsd.getMatchDetails) return null;
  try {
    const details = await bsd.getMatchDetails(fixture.id);
    // Revalidate the provider detail against the original URL and oriented
    // participants. The calendar record alone cannot bless a changed fixture.
    const checked = details?.matchInfo && findVerifiedCanonicalFixture(match.id, [details.matchInfo], [match]);
    if (!checked || checked.id !== fixture.id) return null;
    const matchInfo = publicFixture(checked, match.id);
    const lineups = details.lineups ? { ...details.lineups, matchId: match.id,
      canonicalMatchId: fixture.id, sourceMatchId: fixture.id, providerIdentities: matchInfo.providerIdentities } : null;
    return { ...details, matchInfo: { ...details.matchInfo, ...matchInfo, lineups }, lineups,
      source: 'bsd', provider: 'bsd', canonicalMatchId: fixture.id, publicMatchId: match.id };
  } catch (_) { return null; }
}

module.exports = { resolveVerifiedBsdFixture, getVerifiedBsdDetails, publicFixture };
