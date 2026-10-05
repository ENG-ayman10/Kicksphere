'use strict';

const text = value => typeof value === 'string' ? value.trim() : '';

function firstPlayerImage(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return candidate;
    } catch (_) { /* A missing or malformed provider portrait stays unavailable. */ }
  }
  return '';
}

function playerHonourInput(...values) {
  return values.find(value => Array.isArray(value) && value.length > 0) ||
    values.find(Array.isArray);
}

/** Normalize only records supplied by the already verified player provider. */
function normalizePlayerHonours(input, { playerId, provider, rawPlayerId, complete = false } = {}) {
  const available = Array.isArray(input);
  const rows = [], seen = new Set();
  let rejected = 0;
  for (const raw of available ? input : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { rejected++; continue; }
    const reportedPlayer = raw.playerId ?? raw.player_id ?? raw.player_slug ?? raw.player?.id ?? raw.player?.slug;
    if (reportedPlayer !== undefined && reportedPlayer !== null &&
        String(reportedPlayer) !== String(rawPlayerId ?? playerId) && String(reportedPlayer) !== String(playerId)) {
      rejected++; continue;
    }
    const name = text(raw.name) || text(raw.title) || text(raw.league?.name) || text(raw.league) || text(raw.competition?.name) || text(raw.competition);
    if (!name) { rejected++; continue; }
    const season = text(raw.season) || text(raw.year) ||
      (Number.isInteger(raw.season) ? String(raw.season) : Number.isInteger(raw.year) ? String(raw.year) : '');
    const team = text(raw.team?.name) || text(raw.team) || text(raw.club?.name) || text(raw.club);
    const country = text(raw.country?.name) || text(raw.country);
    const place = text(raw.place) || text(raw.position) || text(raw.result);
    const winner = place ? /^(winner|champion|champions|1st place|first place)$/i.test(place) :
      typeof raw.isWinner === 'boolean' ? raw.isWinner : typeof raw.is_winner === 'boolean' ? raw.is_winner : null;
    const count = raw.count !== undefined && raw.count !== null && raw.count !== '' &&
      Number.isSafeInteger(Number(raw.count)) && Number(raw.count) > 0 ? Number(raw.count) : season ? 1 : null;
    const key = JSON.stringify([name, season, team, country, place, winner, count]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name, season, team, country, place, isWinner: winner, count,
      playerId, provider, image: firstPlayerImage(raw.image, raw.logo, raw.league?.logo, raw.competition?.logo) });
  }
  const isComplete = available && complete === true && rejected === 0;
  return { honours: rows, honoursCoverage: { available, complete: isComplete, partial: !isComplete,
    source: provider || 'unavailable', returned: rows.length, rejected,
    reason: !available ? 'honours_not_supplied' : rejected ? 'invalid_honour_rows' :
      rows.length === 0 ? 'empty_honours' : isComplete ? null : 'provider_history_scope_not_guaranteed' } };
}

module.exports = { normalizePlayerHonours, playerHonourInput, firstPlayerImage };
