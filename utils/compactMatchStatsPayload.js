'use strict';

// New clients obtain XI/player ratings and the full timeline from their
// dedicated endpoints. Negotiate away only those unused copies here; keep the
// statistics, summary incidents and full fixture provenance unchanged.
const COMPACT_MATCH_STATS_FORMAT = 'stats-v1';
const objectRow = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function projectMatchStatsPayload(data, format) {
  // Legacy clients, malformed query values and unknown versions retain their
  // full contract. Malformed data is not turned into a valid-looking object.
  if (format !== COMPACT_MATCH_STATS_FORMAT || !objectRow(data)) return data;

  const result = { ...data };
  for (const field of ['timeline', 'providerStatistics', 'lineups', 'playerStatistics']) delete result[field];

  if (objectRow(data.matchInfo)) {
    // Never whitelist the identity: cross-provider recovery also needs scoped
    // participants, kickoff, competition and the complete provenance chain.
    result.matchInfo = { ...data.matchInfo };
    for (const field of ['timeline', 'providerStatistics', 'lineups', 'head2head']) delete result.matchInfo[field];
  }
  return result;
}

module.exports = { COMPACT_MATCH_STATS_FORMAT, projectMatchStatsPayload };
