'use strict';

const { normalizePlayerHonours } = require('./playerHonours');

/**
 * KickOff mixes dated achievements with undated competition/place summaries.
 * Omit valid undated raw rows from history without assigning a season or team.
 * Response completeness describes this resource, never the player's career.
 */
function normalizeKickoffHonoursHistory(input, { playerId, rawPlayerId, responseComplete = false } = {}) {
  const available = Array.isArray(input);
  const scope = { playerId, rawPlayerId, provider: 'kickoffapi' };
  const datedOrInvalid = [];
  let undatedRowsOmitted = 0;
  for (const raw of available ? input : []) {
    // Validate identity before classifying an undated row. Foreign or malformed
    // rows remain rejected by the shared normalizer, rather than being hidden.
    const row = normalizePlayerHonours([raw], scope).honours[0];
    if (row && !row.season) undatedRowsOmitted++;
    else datedOrInvalid.push(raw);
  }
  const normalized = normalizePlayerHonours(available ? datedOrInvalid : undefined, scope);
  return {
    honours: normalized.honours,
    honoursCoverage: {
      ...normalized.honoursCoverage,
      complete: false,
      partial: true,
      responseComplete: available && responseComplete === true,
      rawRecords: available ? input.length : null,
      undatedRowsOmitted,
      reason: normalized.honoursCoverage.rejected ? 'invalid_honour_rows' :
        undatedRowsOmitted > 0 ? 'undated_honour_rows_omitted' : normalized.honoursCoverage.reason,
    },
  };
}

module.exports = { normalizeKickoffHonoursHistory };
