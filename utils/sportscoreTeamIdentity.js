const { scopedTeamId } = require('./teamIdentity');

const normalizedTeamName = value => typeof value === 'string' ?
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : '';

function explicitId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  const id = String(value).trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return null;
  return scopedTeamId(id.startsWith('sc_t_') ? id : `sc_t_${id}`, 'sportscore');
}

function teamUrlId(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, 'https://sportscore.com');
    if (!['http:', 'https:'].includes(url.protocol) ||
        !['sportscore.com', 'www.sportscore.com'].includes(url.hostname)) return null;
    const match = /^\/football\/team\/([a-z0-9][a-z0-9_-]*)\/?$/.exec(url.pathname);
    return match ? explicitId(match[1]) : null;
  } catch { return null; }
}

function providerIdentity(slugs, urls, ids = []) {
  const namedIds = [...new Set([...slugs.map(explicitId), ...urls.map(teamUrlId)].filter(Boolean))];
  if (namedIds.length > 1) return { id: null, identityBasis: null, identityConflict: true };
  if (namedIds.length === 1) return { id: namedIds[0], identityBasis: 'provider_slug_or_url' };
  const explicitIds = [...new Set(ids.map(explicitId).filter(Boolean))];
  if (explicitIds.length > 1) return { id: null, identityBasis: null, identityConflict: true };
  return { id: explicitIds[0] || null, identityBasis: explicitIds.length ? 'provider_id' : null };
}

function fixtureTeam(raw, side) {
  const value = raw[side];
  const team = value && typeof value === 'object' && !Array.isArray(value) ? value :
    raw[`${side}_team`] && typeof raw[`${side}_team`] === 'object' ? raw[`${side}_team`] : {};
  const identity = providerIdentity(
    [raw[`${side}_slug`], raw[`${side}_team_slug`], team.slug],
    [raw[`${side}_url`], raw[`${side}_team_url`], team.url, team.team_url],
    [raw[`${side}_id`], raw[`${side}_team_id`], team.id],
  );
  const name = typeof value === 'string' && value.trim() ? value :
    team.name || raw[`${side}_name`] || (side === 'home' ? 'Home Team' : 'Away Team');
  const logo = raw[`${side}_logo`] || team.logo || team.crest || '';
  return { ...identity, provider: 'sportscore', name, shortName: team.shortName || name, crest: logo, logo };
}

function standingsTeamIdentity(row) {
  return providerIdentity([row.team_slug], [row.team_url], [row.team_id]);
}

function buildMembershipIndex(rows) {
  const byName = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const name = normalizedTeamName(row.team);
    const identity = standingsTeamIdentity(row);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, new Set());
    // An unresolved row with the same name prevents a unique membership claim.
    byName.get(name).add(identity.id);
  }
  return byName;
}

module.exports = { normalizedTeamName, fixtureTeam, standingsTeamIdentity, buildMembershipIndex };
