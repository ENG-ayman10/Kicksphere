'use strict';

const apiFootballHonoursService = require('./apiFootballHonoursService');

/** Add one independently verified section; never replace the base player's identity or statistics. */
async function enrichMissingPlayerHonours(player) {
  if (process.env.ENABLE_API_FOOTBALL_HONOURS !== 'true' ||
      !apiFootballHonoursService.isConfigured() || !player || player.provider !== 'bsd' ||
      !/^bsd_p_[1-9]\d*$/.test(String(player.id || ''))) return player;
  if ((Array.isArray(player.honours) && player.honours.length > 0) ||
      (Array.isArray(player.trophies) && player.trophies.length > 0) ||
      (player.honoursCoverage?.available === true && player.honoursCoverage?.complete === true)) return player;

  try {
    const supplement = await apiFootballHonoursService.getPlayerHonoursForProfile(player);
    const section = supplement?.honoursCoverage;
    const rows = supplement?.honours;
    // Defense in depth: the API adapter must bind every row to both identities.
    if (section?.available !== true || section.identityVerified !== true || section.source !== 'api-football' ||
        !/^[1-9]\d*$/.test(String(section.sourcePlayerId || '')) || !Array.isArray(rows) || rows.length === 0 ||
        rows.some(row => !row || row.playerId !== player.id || row.provider !== 'api-football' ||
          String(row.providerPlayerId) !== String(section.sourcePlayerId))) return player;
    const honoursCoverage = { ...section, complete: false, partial: true };
    const coverage = { ...player.coverage, honours: honoursCoverage, complete: false, partial: true };
    return { ...player, honours: rows, honoursCoverage, coverage };
  } catch (_) {
    // Provider failures cannot turn an available BSD profile into an error.
    return player;
  }
}

module.exports = { enrichMissingPlayerHonours };
