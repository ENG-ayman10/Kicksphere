'use strict';

const { normalizeMatchTiming } = require('./matchTiming');
const { normalizeProviderTimestamp } = require('./providerTimestamp');

const REMINDER_MS = 15 * 60 * 1000;
const REMINDER_WINDOW_MS = 60 * 1000;
const UPCOMING_DETAIL_WINDOW_MS = 90 * 60 * 1000;
const PHASE_EVENTS = Object.freeze({ HALF_TIME: 'halfTime', SECOND_HALF: 'secondHalfStart',
  EXTRA_TIME: 'extraTimeStart', PENALTIES: 'penaltyShootout' });
const PHASE_ORDER = Object.freeze({ FIRST_HALF: 1, HALF_TIME: 2, SECOND_HALF: 3, EXTRA_TIME: 4, PENALTIES: 5 });

function matchPhase(match = {}) {
  // Provider-normalized phase is authoritative. A minute, paused status or
  // inferred clock never establishes half time or extra time by itself.
  return Object.hasOwn(PHASE_ORDER, match.matchPhase) ? match.matchPhase :
    normalizeMatchTiming({ status: match.status, period: match.period, statusText: match.statusText }).matchPhase;
}
function kickoffTime(match = {}) {
  const value = normalizeProviderTimestamp(match.utcDate);
  return value ? Date.parse(value) : NaN;
}
function reminderDue(match, now) {
  if (!['TIMED', 'SCHEDULED'].includes(match?.status) || match?.liveSnapshotStale === true) return false;
  const remaining = kickoffTime(match) - now;
  return Number.isFinite(remaining) && remaining <= REMINDER_MS && remaining > REMINDER_MS - REMINDER_WINDOW_MS;
}
function upcomingAlertCandidate(match, now) {
  const remaining = kickoffTime(match) - now;
  return ['TIMED', 'SCHEDULED'].includes(match?.status) && Number.isFinite(remaining) &&
    remaining > 0 && remaining <= UPCOMING_DETAIL_WINDOW_MS;
}
function kickoffNotificationFresh(match, now, graceMinutes = 3) {
  const minute = match?.minute === null || match?.minute === undefined ? null : Number(match.minute);
  // A source-reported opening minute also covers a delayed kickoff whose
  // planned utcDate is now old. Late data recovery at minute 40 does not.
  if (Number.isFinite(minute)) return minute >= 0 && minute <= graceMinutes;
  const kickoff = kickoffTime(match);
  return !Number.isFinite(kickoff) || now >= kickoff - 60000 && now - kickoff <= graceMinutes * 60000;
}
function lineupNotificationRelevant(match, now) {
  if (['TIMED', 'SCHEDULED'].includes(match?.status)) return kickoffTime(match) > now;
  return ['IN_PLAY', 'PAUSED'].includes(match?.status) && kickoffNotificationFresh(match, now, 5);
}
function lineupState(lineups, match) {
  if (!lineups || typeof lineups !== 'object') return null;
  if (lineups.predicted === true || lineups.lineupStatus === 'predicted') return false;
  if (lineups.confirmed === false && lineups.lineupStatus !== 'confirmed') return false;
  if (lineups.confirmed !== true && lineups.lineupStatus !== 'confirmed') return null;
  // Official flags without both complete starting elevens do not establish
  // that the official lineup is ready. Reject conflicting match identities.
  if (lineups.matchId && String(lineups.matchId) !== String(match?.id)) return null;
  for (const side of ['home', 'away']) {
    const players = lineups[side];
    if (!Array.isArray(players) || players.length !== 11) return null;
    const ids = players.map(player => player?.id || player?.player?.id);
    if (ids.some(id => id === undefined || id === null || id === '') || new Set(ids.map(String)).size !== 11) return null;
    if (players.some(player => player?.id && player?.player?.id && String(player.id) !== String(player.player.id))) return null;
    const teamId = lineups[`${side}TeamId`];
    if (teamId && match?.[`${side}Team`]?.id && String(teamId) !== String(match[`${side}Team`].id)) return null;
  }
  if (new Set([...lineups.home, ...lineups.away].map(player => String(player?.id || player?.player?.id))).size !== 22) return null;
  return true;
}
function incidentKey(incident = {}) {
  // Display names, translations, photos and enrichment are mutable. A stable
  // provider incident ID is not; fallback contains only occurrence identity.
  const semanticType = incident.type === 'card' && /red|second_yellow/.test(String(incident.cardType || incident.card_type || ''))
    ? 'red_card' : incident.type || '';
  if (incident.id !== null && incident.id !== undefined && String(incident.id).trim()) return `id:${String(incident.id)}:${semanticType}`;
  return JSON.stringify([incident.type || '', incident.side || '', incident.period || '',
    incident.minute ?? null, incident.addedTime ?? null, incident.periodSecond ?? null,
    incident.playerId || incident.player || '', incident.playerOutId || '']);
}
function incidentAlert(incident = {}) {
  const type = String(incident.type || '').toLowerCase();
  if (incident.rescinded === true || incident.deleted === true || incident.isDeleted === true) return null;
  if (type === 'red_card' || (type === 'card' && /red|second_yellow/.test(String(incident.cardType || incident.card_type || '')))) {
    return { type: 'card', cardType: 'red', isDetailed: false };
  }
  if (type === 'yellow_card' || (type === 'card' && String(incident.cardType || incident.card_type || '') === 'yellow')) {
    return { type: 'card', cardType: 'yellow', isDetailed: true };
  }
  const shootout = normalizeMatchTiming({ period: incident.period }).matchPhase === 'PENALTIES';
  if (shootout && type === 'goal') return { type: 'penalty', penaltyType: 'shootout_scored', phase: 'PENALTIES', isDetailed: true };
  if (['penalty_awarded', 'penalty_missed', 'penalty_saved', 'penalty'].includes(type)) {
    return { type: 'penalty', penaltyType: shootout && type === 'penalty_missed' ? 'shootout_missed' :
      shootout && type === 'penalty_saved' ? 'shootout_saved' : type,
    ...(shootout ? { phase: 'PENALTIES' } : {}), isDetailed: true };
  }
  if (type === 'substitution') return { type: 'substitution', isDetailed: true };
  if (type === 'var' || (type === 'incident' && /\bvar\b/i.test(incident.label || ''))) return { type: 'var', isDetailed: true };
  return null;
}
function incidentFields(incident = {}) {
  const fields = { player: typeof incident.player === 'string' ? incident.player : '',
    minute: incident.minute ?? null };
  for (const field of ['playerId', 'playerImage', 'assist', 'assistId', 'assistImage', 'playerOut', 'playerOutId', 'addedTime', 'periodSecond']) {
    if (incident[field] !== undefined && incident[field] !== null) fields[field] = incident[field];
  }
  if (incident.id !== undefined && incident.id !== null) fields.incidentId = String(incident.id);
  return fields;
}

module.exports = { REMINDER_MS, reminderDue, upcomingAlertCandidate, kickoffTime, kickoffNotificationFresh, lineupNotificationRelevant, matchPhase,
  PHASE_EVENTS, PHASE_ORDER, lineupState, incidentKey, incidentAlert, incidentFields };
