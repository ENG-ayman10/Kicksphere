const { normalizeMatchTiming } = require('./matchTiming');

const phaseRank = { NOT_STARTED: 0, FIRST_HALF: 1, HALF_TIME: 2, SECOND_HALF: 3,
  REGULATION_END: 4, EXTRA_TIME: 4, PENALTIES: 5, FULL_TIME: 6 };
const liveStatuses = new Set(['IN_PLAY', 'LIVE', 'INPROGRESS', 'IN_PROGRESS', 'PAUSED', 'HALF_TIME', '1ST_HALF', '2ND_HALF']);
const minuteValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value :
  typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null;

function markerBoundary(event) {
  // BSD puts the current period's summary at its nominal end minute, even
  // before that boundary occurs. This is not an incident at that future time.
  const minute = minuteValue(event.minute);
  for (const value of [event.label, event.text, event.period]) {
    const text = String(value || '').trim().toLowerCase().replace(/[ _-]+/g, ' ');
    if (['ht', 'half time', 'halftime', 'end of first half', 'first half ended'].includes(text)) return 'HALF_TIME';
    if (text === 'end of second half') return 'REGULATION_END';
    if (['ft', 'full time', 'fulltime'].includes(text)) return minute === 90 ? 'REGULATION_END' : 'FULL_TIME';
    if (['match ended', 'end of match', 'match finished', 'aet', 'after extra time'].includes(text)) return 'FULL_TIME';
    if (['first half', '1st half', '1t', '1h'].includes(text) && minute !== null && minute >= 45) return 'HALF_TIME';
    if (['second half', '2nd half', '2t', '2h'].includes(text) && minute !== null && minute >= 90) return minute === 90 ? 'REGULATION_END' : 'FULL_TIME';
  }
  return null;
}

function isVisiblePeriodMarker(event, match = {}) {
  if (String(event?.type || '').toLowerCase() !== 'period') return true;
  const status = String(match.status || '').trim().toLowerCase();
  if (['cancelled', 'canceled', 'postponed', 'suspended', 'abandoned'].includes(status)) return false;
  const specificStatus = normalizeMatchTiming({ status: match.status }).matchPhase;
  const phase = specificStatus !== 'UNKNOWN' ? specificStatus :
    Object.hasOwn(phaseRank, match.matchPhase) ? match.matchPhase : normalizeMatchTiming(match).matchPhase;
  if (phase === 'FULL_TIME') return true;
  const boundary = markerBoundary(event);
  if (boundary) {
    // A confirmed phase takes precedence over a lagging clock. An unknown
    // phase cannot certify that the referee ended a period.
    if (Object.hasOwn(phaseRank, phase)) return phaseRank[phase] >= phaseRank[boundary];
    return boundary === 'HALF_TIME' && match.halfTimeConfirmed === true;
  }
  const current = minuteValue(match.minute), eventMinute = minuteValue(event.minute);
  const active = ['FIRST_HALF', 'HALF_TIME', 'SECOND_HALF', 'EXTRA_TIME', 'PENALTIES'].includes(phase) ||
    liveStatuses.has(String(match.status || '').toUpperCase());
  if (active && current !== null && eventMinute !== null && eventMinute > current) return false;
  return true;
}

function filterPresentedTimeline(timeline, match) {
  return (Array.isArray(timeline) ? timeline : []).filter(event => isVisiblePeriodMarker(event, match));
}

module.exports = { isVisiblePeriodMarker, filterPresentedTimeline };
