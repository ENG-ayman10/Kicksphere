const { normalizeCompetitionCode } = require('./sportsContracts');
const { matchTeamId } = require('./teamIdentity');
const { validatedProviderIdentities } = require('./matchProviderIdentities');

// Provider feeds frequently differ only by accents (for example Curaçao /
// Curacao). Fold combining marks for the exact same competition/date/fixture
// comparison; IDs and country/scope checks still prevent namesake joins.
const normalized = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[-\s]+/g, ' ').trim();
const country = value => {
  const name = normalized(value);
  return ['us', 'usa', 'united states', 'united states of america'].includes(name) ? 'usa' : name;
};
const sameCountry = (a, b) => !country(a) || !country(b) || country(a) === country(b);

// Explicit, source-scoped senior-club identities verified independently against
// BSD's MLS team catalog and SportScore's MLS standings on 2026-10-02. This is
// intentionally not a global name alias or a rule that removes FC/age suffixes.
// Evidence and both unmodified kickoff values are captured in the regression fixture.
const VERIFIED_MLS_TEAMS = Object.freeze({
  bsd_t_302: { club: 'seattle-sounders', provider: 'bsd', name: 'Seattle Sounders FC' },
  'sc_t_seattle-sounders': { club: 'seattle-sounders', provider: 'sportscore', name: 'Seattle Sounders' },
  bsd_t_299: { club: 'sporting-kansas-city', provider: 'bsd', name: 'Sporting Kansas City' },
  'sc_t_sporting-kansas-city': { club: 'sporting-kansas-city', provider: 'sportscore', name: 'Sporting Kansas City' },
});
// The audited providers disagree by exactly ten minutes for the verified pair.
// No other clubs or name-based fixture joins get a kickoff tolerance.
const MAX_VERIFIED_KICKOFF_DRIFT_MS = 10 * 60 * 1000;

function kickoffTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
  const instant = Date.parse(value);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10) && Number.isFinite(instant) ? instant : null;
}

function fixtureProviderIdentity(match) {
  const provider = match?.provider || match?.source;
  if (!['bsd', 'sportscore', 'kickoffapi'].includes(provider) ||
      (match.provider && match.source && match.provider !== match.source)) return null;
  const id = typeof match.id === 'string' || typeof match.id === 'number' ? String(match.id) : '';
  const validId = provider === 'bsd' ? /^bsd_[1-9]\d*$/.test(id) : provider === 'kickoffapi' ?
    /^ko_[1-9]\d*$/.test(id) : /^[a-z0-9][a-z0-9_-]{0,199}$/.test(id) && !/^(?:bsd_|ko_|\d+$)/.test(id);
  const competitionCode = normalizeCompetitionCode(match.competition?.code);
  const homeTeamId = matchTeamId(match.homeTeam, provider);
  const awayTeamId = matchTeamId(match.awayTeam, provider);
  if (!validId || id.length > 120 || !competitionCode || !homeTeamId || !awayTeamId || homeTeamId === awayTeamId || kickoffTime(match.utcDate) === null) return null;
  return { id, provider, utcDate: match.utcDate, competitionCode, homeTeamId, awayTeamId };
}

const marked = (object, keys) => keys.some(key => object?.[key] === true);
const gender = object => marked(object, ['isWomen', 'is_women', 'isFemale']) ? 'female' :
  normalized(object?.gender || object?.sex) || 'male';
const ageGroup = object => normalized(object?.ageGroup || object?.age_group || object?.category) ||
  (marked(object, ['isYouth', 'is_youth']) ? 'youth' : 'senior');
const reserves = object => marked(object, ['isReserve', 'is_reserve', 'isReserves']) ? 'reserves' :
  normalized(object?.squadType || object?.squad_type) || 'first';
const teamType = object => normalized(object?.type) || 'team';
function classSignature(match) {
  return [match, match.competition, match.homeTeam, match.awayTeam].map(object =>
    [gender(object), ageGroup(object), reserves(object)].join(':')).join('|') +
    `|${teamType(match.homeTeam)}|${teamType(match.awayTeam)}`;
}
function compatibleScopes(first, second) {
  return classSignature(first) === classSignature(second) &&
    sameCountry(first.competition?.countryCode || first.competition?.country, second.competition?.countryCode || second.competition?.country) &&
    ['homeTeam', 'awayTeam'].every(side => sameCountry(first[side]?.countryCode || first[side]?.country, second[side]?.countryCode || second[side]?.country));
}

function verifiedClub(team, provider) {
  const id = matchTeamId(team, provider);
  const verified = VERIFIED_MLS_TEAMS[id];
  if (!verified || verified.provider !== provider || normalized(team?.name) !== normalized(verified.name) ||
      !sameCountry(team.countryCode || team.country, 'USA') ||
      (team.identityCompetitionCode && normalizeCompetitionCode(team.identityCompetitionCode) !== 'MLS')) return null;
  return verified.club;
}
function seniorMlsContext(match, identity) {
  if (identity.competitionCode !== 'MLS' || !sameCountry(match.competition?.countryCode || match.competition?.country, 'USA')) return null;
  for (const object of [match, match.competition, match.homeTeam, match.awayTeam]) {
    if (!['male', 'men', 'm'].includes(gender(object)) || !['senior', 'adult', 'open'].includes(ageGroup(object)) ||
        !['first', 'first team', 'senior'].includes(reserves(object))) return null;
  }
  if (!['team', 'club'].includes(teamType(match.homeTeam)) || !['team', 'club'].includes(teamType(match.awayTeam))) return null;
  const home = verifiedClub(match.homeTeam, identity.provider);
  const away = verifiedClub(match.awayTeam, identity.provider);
  return home && away ? `MLS|${home}|${away}` : null;
}
function context(match) {
  const identity = fixtureProviderIdentity(match);
  if (!identity) return null;
  const home = normalized(match.homeTeam?.name), away = normalized(match.awayTeam?.name);
  return { identity, time: kickoffTime(match.utcDate),
    exact: home && away ? `${identity.competitionCode}|${kickoffTime(match.utcDate)}|${home}|${away}` : null,
    verified: seniorMlsContext(match, identity) };
}

function aliasEntries(match, identity) {
  const previous = validatedProviderIdentities(match);
  return previous.length ? previous : [identity];
}

// Select one complete provider fixture. Never splice scores/statistics/child
// entities, infer IDs from names, or merge distinct IDs within the same provider.
// Ambiguous candidate sets remain visible rather than silently losing fixtures.
function mergeProviderFixtures(preferred = [], supplement = []) {
  const seen = new Set(), rows = [];
  for (const [preferredSource, matches] of [[true, preferred], [false, supplement]]) {
    for (const match of matches) {
      if (!match) continue;
      const key = match.id ? `${match.provider || match.source || ''}|${match.id}` : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push({ match, preferred: preferredSource, context: context(match) });
    }
  }
  const byExact = new Map(), byVerified = new Map();
  const index = (map, key, value) => { if (key) { if (!map.has(key)) map.set(key, []); map.get(key).push(value); } };
  rows.forEach((row, i) => {
    if (row.preferred && row.context) { index(byExact, row.context.exact, i); index(byVerified, row.context.verified, i); }
  });
  const edges = new Map();
  const addEdge = (a, b) => { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a).add(b); };
  rows.forEach((row, i) => {
    if (row.preferred || !row.context) return;
    const candidates = new Set([...(byExact.get(row.context.exact) || []), ...(byVerified.get(row.context.verified) || [])]);
    for (const j of candidates) {
      const other = rows[j];
      if (other.context.identity.provider === row.context.identity.provider || !compatibleScopes(other.match, row.match)) continue;
      const exact = row.context.exact && row.context.exact === other.context.exact;
      const verified = row.context.verified && row.context.verified === other.context.verified &&
        Math.abs(row.context.time - other.context.time) <= MAX_VERIFIED_KICKOFF_DRIFT_MS;
      if (exact || verified) { addEdge(i, j); addEdge(j, i); }
    }
  });
  const removed = new Set(), merged = new Map();
  rows.forEach((row, i) => {
    if (!row.preferred || edges.get(i)?.size !== 1) return;
    const j = [...edges.get(i)][0];
    if (edges.get(j)?.size !== 1) return;
    const identities = [...aliasEntries(row.match, row.context.identity),
      ...aliasEntries(rows[j].match, rows[j].context.identity)];
    const keys = new Set();
    const providerIdentities = identities.filter(entry => {
      const key = `${entry.provider}|${entry.id}`;
      if (keys.has(key)) return false;
      keys.add(key); return true;
    });
    merged.set(i, { ...row.match, providerIdentities }); removed.add(j);
  });
  return rows.flatMap((row, i) => removed.has(i) ? [] : [merged.get(i) || row.match]);
}

module.exports = { mergeProviderFixtures, fixtureProviderIdentity, MAX_VERIFIED_KICKOFF_DRIFT_MS };
