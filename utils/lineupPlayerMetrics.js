'use strict';

// Roster facts are current biography/value facts, not a historical starting XI.
// A roster can enrich an exact identity; it must never replace tactical evidence.
function number(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}
function playerIdentity(row) {
  if (!row || typeof row !== 'object') return null;
  const root = row.id ?? null, nested = row.player?.id ?? null;
  if (root && nested && String(root) !== String(nested)) return null;
  return String(nested ?? root ?? '').trim() || null;
}
function playerFacts(raw) {
  const text = value => typeof value === 'string' ? value.trim() : '';
  const birthInput = raw?.date_of_birth ?? raw?.dateOfBirth ?? raw?.birth?.date;
  const birth = /^\d{4}-\d{2}-\d{2}$/.test(String(birthInput || '')) ? new Date(birthInput + 'T00:00:00Z') : null;
  const dateOfBirth = birth && Number.isFinite(birth.getTime()) && birth.toISOString().slice(0, 10) === birthInput ? birthInput : null;
  const now = new Date();
  let age = dateOfBirth ? now.getUTCFullYear() - birth.getUTCFullYear() -
    Number(now.getUTCMonth() < birth.getUTCMonth() || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate())) : number(raw?.age, 0, 99);
  if (!Number.isInteger(age) || age < 0 || age > 99) age = null;
  const statedHeight = typeof raw?.height === 'string' && /^\d+(?:\.\d+)?\s*cm$/i.test(raw.height.trim())
    ? raw.height.replace(/\s*cm$/i, '') : raw?.heightUnit === 'cm' ? raw.height : null;
  const height = number(raw?.height_cm ?? statedHeight, 100, 250);
  const marketValue = number(raw?.market_value_eur ?? (raw?.marketValueCurrency === 'EUR' ? raw.marketValue : null));
  return { dateOfBirth, dateBorn: dateOfBirth || '', age, height, heightUnit: height !== null ? 'cm' : null,
    nationality: text(raw?.nationality), country: text(raw?.nationality),
    marketValue, marketValueCurrency: marketValue !== null ? 'EUR' : null };
}
const ROSTER_FACT_FIELDS = ['dateOfBirth', 'dateBorn', 'age', 'nationality', 'country',
  'height', 'heightUnit', 'marketValue', 'marketValueCurrency'];
const TEXT_FACT_FIELDS = new Set(['dateBorn', 'nationality', 'country']);
function absentFact(field) { return TEXT_FACT_FIELDS.has(field) ? '' : null; }
function presentFact(value) { return value !== undefined && value !== null && value !== ''; }
function sameFact(field, a, b) {
  if (['age', 'height', 'marketValue'].includes(field)) return number(a) === number(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
function mergeDuplicateRosterFacts(first, next) {
  const merged = { ...first };
  const conflicts = new Set([...(Array.isArray(first.conflictingRosterFacts) ? first.conflictingRosterFacts : []),
    ...(Array.isArray(next.conflictingRosterFacts) ? next.conflictingRosterFacts : [])]
    .filter(field => ROSTER_FACT_FIELDS.includes(field)));
  for (const field of ROSTER_FACT_FIELDS) {
    const a = first[field] ?? first.player?.[field], b = next[field] ?? next.player?.[field];
    if (presentFact(a) && presentFact(b) && !sameFact(field, a, b)) conflicts.add(field);
    merged[field] = presentFact(a) ? a : presentFact(b) ? b : absentFact(field);
  }
  // Clear related aliases/units as well; otherwise a consumer could fall back
  // to a contradictory dateBorn, country or nested player value.
  for (const group of [
    ['dateOfBirth', 'dateBorn', 'age'], ['nationality', 'country'],
    ['height', 'heightUnit'], ['marketValue', 'marketValueCurrency'],
  ]) {
    const triggers = group[0] === 'dateOfBirth' ? group.slice(0, 2) : group;
    if (triggers.some(field => conflicts.has(field))) group.forEach(field => conflicts.add(field));
  }
  for (const field of conflicts) merged[field] = absentFact(field);
  if (first.player && typeof first.player === 'object') {
    merged.player = { ...first.player };
    for (const field of ROSTER_FACT_FIELDS) merged.player[field] = merged[field];
  }
  if (conflicts.size) merged.conflictingRosterFacts = [...conflicts];
  return merged;
}
function deduplicateRosterFacts(rows) {
  const byId = new Map();
  let duplicateRows = 0;
  for (const row of rows) {
    const id = playerIdentity(row);
    if (byId.has(id)) {
      duplicateRows++;
      byId.set(id, mergeDuplicateRosterFacts(byId.get(id), row));
    } else byId.set(id, row);
  }
  return { rows: [...byId.values()], duplicateRows };
}
function uniqueRoster(rows, teamId, provider) {
  const result = [];
  let invalidRows = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = playerIdentity(row);
    const owner = row.rosterTeamId ?? row.lineupTeamId;
    if (!id || (owner && String(owner) !== String(teamId)) ||
        (row.provider && provider && row.provider !== provider) ||
        (id.startsWith('bsd_p_') && provider !== 'bsd') ||
        (id.startsWith('ko_p_') && provider !== 'kickoffapi')) { invalidRows++; continue; }
    result.push(row);
  }
  const unique = deduplicateRosterFacts(result);
  return { rows: unique.rows, invalidRows: invalidRows + unique.duplicateRows };
}
function valuation(rows, coverage, scope) {
  let total = 0, known = 0;
  for (const row of rows) {
    const value = row.marketValueCurrency === 'EUR' ? number(row.marketValue) : null;
    if (value !== null) { total += value; known++; }
  }
  return { currency: 'EUR', totalEUR: known ? total : null, knownPlayers: known,
    totalPlayers: rows.length, missingPlayers: rows.length - known,
    available: known > 0, complete: rows.length > 0 && known === rows.length && coverage.complete === true,
    scope, temporalScope: 'current', estimated: true };
}
function enrichLineupMetrics(lineup, squads, teamIds, provider) {
  const result = { ...lineup, squadCoverage: {}, squadValuation: {} };
  for (const side of ['home', 'away']) {
    const input = squads?.[side], teamId = teamIds?.[side];
    const checked = uniqueRoster(input, teamId, provider);
    const supplied = input?.coverage || {};
    const ownerMatches = supplied.teamId === teamId && supplied.scope === 'team_roster';
    const rows = ownerMatches && supplied.available !== false ? checked.rows : [];
    const coverage = { source: provider, available: rows.length > 0,
      complete: rows.length > 0 && ownerMatches && supplied.complete === true && checked.invalidRows === 0,
      scope: 'team_roster', temporalScope: 'current', teamId,
      invalidRows: checked.invalidRows + (supplied.invalidRows || 0),
      reportedTotal: supplied.reportedTotal ?? null,
      reason: !ownerMatches ? 'roster_identity_unavailable' : supplied.reason || null };
    coverage.partial = !coverage.complete;
    const byId = new Map(rows.map(row => [playerIdentity(row), row]));
    for (const key of [side, side + 'Bench']) {
      result[key] = (lineup[key] || []).map(row => {
        const profile = byId.get(playerIdentity(row));
        if (!profile) return row;
        const merged = { ...row };
        const conflicts = profile.conflictingRosterFacts || [];
        if (conflicts.length && row.player && typeof row.player === 'object') merged.player = { ...row.player };
        for (const field of conflicts) {
          merged[field] = absentFact(field);
          if (merged.player) merged.player[field] = absentFact(field);
        }
        for (const field of ROSTER_FACT_FIELDS) {
          const value = profile[field];
          if (value !== undefined && value !== null && value !== '') merged[field] = value;
        }
        return merged;
      });
    }
    result[side + 'Squad'] = rows;
    result.squadCoverage[side] = coverage;
    const matchSquad = uniqueRoster([...result[side], ...result[side + 'Bench']], teamId, provider).rows;
    const full = coverage.complete === true;
    result.squadValuation[side] = valuation(full ? rows : matchSquad,
      full ? coverage : { complete: false }, full ? 'team_roster' : 'match_squad');
  }
  return result;
}

module.exports = { enrichLineupMetrics, playerFacts, number, playerIdentity, deduplicateRosterFacts };
