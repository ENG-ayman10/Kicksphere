const { normalizeCompetitionCode } = require('./sportsContracts');

const providerNames = { bsd: 'bsd', sportscore: 'sportscore', kickoffapi: 'kickoffapi', kickoff: 'kickoffapi', ko: 'kickoffapi' };
const providerName = value => {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  return Object.hasOwn(providerNames, key) ? providerNames[key] : null;
};
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 120 ? value : null;
const providerForId = id => /^bsd_[1-9]\d*$/.test(id || '') ? 'bsd'
  : /^ko_[1-9]\d*$/.test(id || '') ? 'kickoffapi' : 'sportscore';
const validMatchId = (id, provider) => Boolean(text(id)) && (provider === 'bsd' ? /^bsd_[1-9]\d*$/.test(id)
  : provider === 'kickoffapi' ? /^ko_[1-9]\d*$/.test(id)
    : !/^(?:bsd_|ko_|sc_t_)/.test(id) && /^(?=[a-z0-9_-]*[a-z])[a-z0-9][a-z0-9_-]*$/.test(id));
const validTeamId = (id, provider) => Boolean(text(id)) && (provider === 'bsd' ? /^bsd_t_[1-9]\d*$/.test(id)
  : provider === 'kickoffapi' ? /^ko_t_[1-9]\d*$/.test(id)
    : /^sc_t_[a-z0-9][a-z0-9_-]*$/.test(id));
const timestamp = value => typeof value === 'string' && /(?:z|[+-]\d{2}:?\d{2})$/i.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const verifiedMlsClub = id => ({ bsd_t_302: 'seattle', bsd_t_299: 'kansas',
  'sc_t_seattle-sounders': 'seattle', 'sc_t_sporting-kansas-city': 'kansas' })[id] || null;

// These records are emitted by the verified provider fixture join, never built
// from display names or preference values. Validate their canonical anchor and
// bound their size before using them for delivery or sending them to clients.
function validatedProviderIdentities(value = {}) {
  const raw = value.providerIdentities;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) return [];
  const id = text(value.matchId || value.id);
  const explicitProvider = value.provider || value.source;
  const provider = explicitProvider ? providerName(explicitProvider) : providerForId(id);
  const home = text(value.homeTeam?.id || value.homeTeamId);
  const away = text(value.awayTeam?.id || value.awayTeamId);
  const code = normalizeCompetitionCode(value.competitionCode || value.competition?.code);
  const kickoff = timestamp(value.utcDate);
  if (!id || !validMatchId(id, provider) || !validTeamId(home, provider) || !validTeamId(away, provider)
      || home === away || !code || kickoff === null) return [];
  const rows = [];
  const providers = new Set();
  const ids = new Set();
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const rowProvider = providerName(row.provider);
    const rowId = text(row.id), rowHome = text(row.homeTeamId), rowAway = text(row.awayTeamId);
    const rowCode = normalizeCompetitionCode(row.competitionCode);
    const rowTime = timestamp(row.utcDate);
    if (!rowProvider || !validMatchId(rowId, rowProvider) || !validTeamId(rowHome, rowProvider)
        || !validTeamId(rowAway, rowProvider) || rowHome === rowAway || rowCode !== code
        || rowTime === null || Math.abs(rowTime - kickoff) > 10 * 60 * 1000
        || providers.has(rowProvider) || ids.has(rowId)) return [];
    if (rowTime !== kickoff && (code !== 'MLS' || !verifiedMlsClub(home) || !verifiedMlsClub(away)
        || verifiedMlsClub(home) !== verifiedMlsClub(rowHome) || verifiedMlsClub(away) !== verifiedMlsClub(rowAway))) return [];
    if (rows.length === 0 && (rowId !== id || rowProvider !== provider || rowHome !== home || rowAway !== away
        || rowTime !== kickoff)) return [];
    providers.add(rowProvider); ids.add(rowId);
    rows.push({ id: rowId, provider: rowProvider, utcDate: row.utcDate, competitionCode: rowCode,
      homeTeamId: rowHome, awayTeamId: rowAway });
  }
  return rows;
}

function matchIdentityIds(value = {}) {
  return [...new Set([value.matchId || value.id, ...validatedProviderIdentities(value).map(row => row.id)]
    .filter(id => typeof id === 'string' && id.length > 0))];
}
function teamIdentityIds(value = {}) {
  return [...new Set([value.teamId, value.againstTeamId, value.homeTeamId, value.awayTeamId,
    value.homeTeam?.id, value.awayTeam?.id,
    ...validatedProviderIdentities(value).flatMap(row => [row.homeTeamId, row.awayTeamId])]
    .filter(id => typeof id === 'string' && id.length > 0))];
}

module.exports = { validatedProviderIdentities, matchIdentityIds, teamIdentityIds };
