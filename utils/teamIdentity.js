const MAX_ID_LENGTH = 120;
const providerName = value => {
  const name = String(value || '').toLowerCase();
  return ['kickoffapi', 'kickoff'].includes(name) ? 'kickoffapi' : ['sportscore', 'bsd'].includes(name) ? name : null;
};

function scopedTeamId(value, provider) {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  if (!id || id.length > MAX_ID_LENGTH) return null;
  const source = providerName(provider);
  if (provider && !source) return null;
  if (/^ko_t_[1-9]\d*$/.test(id)) return !source || source === 'kickoffapi' ? id : null;
  if (/^bsd_t_[1-9]\d*$/.test(id)) return !source || source === 'bsd' ? id : null;
  if (/^sc_t_[a-z0-9][a-z0-9_-]*$/.test(id)) return !source || source === 'sportscore' ? id : null;
  if (id.startsWith('ko_t_') || id.startsWith('sc_t_') || id.startsWith('bsd_t_')) return null;
  if (source === 'kickoffapi' && id.length <= MAX_ID_LENGTH - 5 && /^[1-9]\d*$/.test(id)) return `ko_t_${id}`;
  if (source === 'bsd' && id.length <= MAX_ID_LENGTH - 6 && /^[1-9]\d*$/.test(id)) return `bsd_t_${id}`;
  // SportScore IDs are exact provider slugs. Never turn a human-readable name
  // into a guessed slug, and never reinterpret an unscoped numeric ID.
  if (source === 'sportscore' && id.length <= MAX_ID_LENGTH - 5 && /^[a-z0-9][a-z0-9_-]*$/.test(id) && !/^\d+$/.test(id)) return `sc_t_${id}`;
  return null;
}

function favoriteTeamId(record) {
  if (typeof record === 'string') return scopedTeamId(record);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return scopedTeamId(record.targetId || record.id || record.providerId, record.provider || record.source);
}

function matchTeamId(team, matchSource) {
  if (!team || typeof team !== 'object') return null;
  return scopedTeamId(team.id || team.targetId || team.providerId, team.provider || matchSource);
}

function favoriteTeamIds(records, limit = 50) {
  if (!Array.isArray(records)) return [];
  return [...new Set(records.map(favoriteTeamId).filter(Boolean))].slice(0, limit);
}

module.exports = { scopedTeamId, favoriteTeamId, favoriteTeamIds, matchTeamId };
