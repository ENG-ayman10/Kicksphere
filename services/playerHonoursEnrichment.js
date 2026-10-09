'use strict';

const apiFootballHonoursService = require('./apiFootballHonoursService');

function measurement(value, unit, min, max) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const match = String(value).trim().match(new RegExp('^(\\d+(?:\\.\\d+)?)\\s*(?:' + unit + ')?$', 'i'));
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}
function verifiedBiography(player, supplied) {
  if (!supplied || supplied.identityVerified !== true || supplied.provider !== 'api-football' ||
      supplied.targetId !== player.id || !/^[1-9]\d*$/.test(String(supplied.sourcePlayerId || ''))) return player;
  const additions = {}, sources = { ...player.biographySources };
  for (const [field, unit, min, max] of [['weight', 'kg', 20, 250], ['height', 'cm', 50, 250]]) {
    const value = measurement(supplied[field], unit, min, max);
    if ((player[field] === null || player[field] === undefined || player[field] === '') && value !== null) {
      additions[field] = value;
      sources[field] = { source: 'api-football', sourcePlayerId: String(supplied.sourcePlayerId), identityVerified: true };
    }
  }
  if (!String(player.image || player.photo || '').trim()) {
    try {
      const url = new URL(supplied.photo);
      if (url.protocol === 'https:' && url.hostname === 'media.api-sports.io' &&
          !url.username && !url.password && !url.search && !url.hash &&
          url.pathname === '/football/players/' + supplied.sourcePlayerId + '.png') {
        additions.image = additions.photo = url.href;
        sources.image = { source: 'api-football', sourcePlayerId: String(supplied.sourcePlayerId), identityVerified: true };
      }
    } catch (_) { /* An invalid supplied portrait never replaces a known image. */ }
  }
  if (!Object.keys(additions).length) return player;
  const oldProfile = player.coverage?.profile || {};
  const fields = { ...oldProfile.fields, ...Object.fromEntries(Object.keys(additions)
    .filter(field => ['weight', 'height'].includes(field)).map(field => [field, true])) };
  const missingFields = Array.isArray(oldProfile.missingFields)
    ? oldProfile.missingFields.filter(field => !Object.hasOwn(additions, field)) : undefined;
  const complete = oldProfile.available === true && missingFields?.length === 0;
  const profile = { ...oldProfile, fields, ...(missingFields ? { missingFields } : {}),
    complete, partial: !complete, supplementalSource: 'api-football' };
  return { ...player, ...additions, biographySources: sources,
    coverage: { ...player.coverage, profile, complete: false, partial: true } };
}

/** Fill independently verified gaps without changing player identity or statistics. */
async function enrichMissingPlayerHonours(player) {
  if (process.env.ENABLE_API_FOOTBALL_HONOURS !== 'true' ||
      !apiFootballHonoursService.isConfigured() || !player || player.provider !== 'bsd' ||
      !/^bsd_p_[1-9]\d*$/.test(String(player.id || ''))) return player;
  if ((Array.isArray(player.honours) && player.honours.length > 0) ||
      (Array.isArray(player.trophies) && player.trophies.length > 0) ||
      (player.honoursCoverage?.available === true && player.honoursCoverage?.complete === true)) return player;

  try {
    const supplement = await apiFootballHonoursService.getPlayerHonoursForProfile(player);
    const enrichedPlayer = verifiedBiography(player, supplement?.profileSupplement);
    const section = supplement?.honoursCoverage;
    const rows = supplement?.honours;
    // Defense in depth: the API adapter must bind every row to both identities.
    if (section?.available !== true || section.identityVerified !== true || section.source !== 'api-football' ||
        !/^[1-9]\d*$/.test(String(section.sourcePlayerId || '')) || !Array.isArray(rows) || rows.length === 0 ||
        rows.some(row => !row || row.playerId !== player.id || row.provider !== 'api-football' ||
          String(row.providerPlayerId) !== String(section.sourcePlayerId))) return enrichedPlayer;
    const honoursCoverage = { ...section, complete: false, partial: true };
    const coverage = { ...enrichedPlayer.coverage, honours: honoursCoverage, complete: false, partial: true };
    return { ...enrichedPlayer, honours: rows, honoursCoverage, coverage };
  } catch (_) {
    // Provider failures cannot turn an available BSD profile into an error.
    return player;
  }
}

module.exports = { enrichMissingPlayerHonours };
