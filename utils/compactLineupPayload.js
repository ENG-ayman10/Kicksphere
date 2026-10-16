'use strict';

// A negotiated transport shape for clients which use the current full roster
// only for valuation. Match XI/bench rows remain the rich, enriched profiles:
// their portraits, ratings, positions and biography tabs are not projected.
const COMPACT_LINEUP_FORMAT = 'compact-v1';
const ROSTER_VALUATION_FIELDS = Object.freeze([
  'id', 'playerId', 'rawId', 'providerId', 'providerIdentities',
  'provider', 'source', 'teamId', 'rosterTeamId', 'lineupTeamId',
  'currentTeamId', 'current_team_id', 'clubId', 'clubTeamId',
  'nationalTeamId', 'national_team_id', 'teamType',
  'marketValue', 'marketValueCurrency', 'market_value_currency',
  'marketValueEUR', 'market_value_eur', 'conflictingRosterFacts',
  'coverage', 'provenance', 'scope', 'temporalScope',
]);

const objectRow = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copyValue = value => value !== null && typeof value === 'object' ? structuredClone(value) : value;

function projectRosterRow(row) {
  // Do not filter malformed rows or deduplicate here. Their cardinality and
  // identity failures must still prevent an incorrect complete-roster claim.
  if (!objectRow(row)) return row;
  const result = {};
  for (const field of ROSTER_VALUATION_FIELDS) {
    if (Object.hasOwn(row, field)) result[field] = copyValue(row[field]);
  }
  if (Object.hasOwn(row, 'player')) {
    // Preserve the nested precedence, including nulls, unsupported currency
    // and conflicting IDs. Flattening would make an unknown value look valid.
    const player = row.player;
    result.player = objectRow(player)
      ? Object.fromEntries(ROSTER_VALUATION_FIELDS.filter(field => Object.hasOwn(player, field))
        .map(field => [field, copyValue(player[field])]))
      : copyValue(player);
  }
  return result;
}

function projectLineupPayload(lineup, format) {
  // Existing clients, malformed query values and future/unknown versions
  // retain the full original contract without dropping even unknown fields.
  if (format !== COMPACT_LINEUP_FORMAT || !objectRow(lineup)) return lineup;
  const result = { ...lineup };
  for (const field of ['homeSquad', 'awaySquad']) {
    if (Array.isArray(lineup[field])) result[field] = lineup[field].map(projectRosterRow);
  }
  return result;
}

module.exports = { COMPACT_LINEUP_FORMAT, projectLineupPayload };
