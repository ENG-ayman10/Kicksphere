const PHASE_ALIASES = new Map();
function aliases(phase, values) {
  for (const value of values) PHASE_ALIASES.set(value, phase);
}

aliases('FIRST_HALF', ['first_half', 'firsthalf', '1st_half', '1sthalf', '1h', '1t', 'h1', 't1']);
aliases('HALF_TIME', ['half_time', 'halftime', 'half_time_break', 'ht', 'interval']);
aliases('SECOND_HALF', ['second_half', 'secondhalf', '2nd_half', '2ndhalf', '2h', '2t', 'h2', 't2']);
aliases('EXTRA_TIME', ['extra_time', 'extratime', 'et', 'extra_time_first_half', 'extra_time_second_half',
  'extra_time_half_time', 'extra_time_halftime', 'extra_time_break', '1st_extra', '2nd_extra', 'et1', 'et2']);
aliases('PENALTIES', ['penalties', 'penalty_shootout', 'penalty_shoot_out', 'shootout']);
aliases('FULL_TIME', ['finished', 'ft', 'full_time', 'fulltime', 'aet', 'after_extra_time', 'pen', 'after_penalties']);
aliases('NOT_STARTED', ['notstarted', 'not_started', 'upcoming', 'scheduled', 'timed', 'ns']);

const phaseToken = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
function phaseOf(value) { return PHASE_ALIASES.get(phaseToken(value)) || 'UNKNOWN'; }

const HALF_TIME_COMPLETE_PHASES = new Set(['HALF_TIME', 'SECOND_HALF', 'EXTRA_TIME', 'PENALTIES', 'FULL_TIME']);
const UNCERTAIN_STATUSES = new Set(['cancelled', 'canceled', 'postponed', 'suspended', 'abandoned']);

/**
 * A specific status takes precedence over period, which can lag a provider update.
 * Thus an active first-half status beats an inconsistent HT period, while finished
 * and not-started statuses beat stale periods. Generic live/paused statuses defer
 * to period; paused alone does not prove the half ended. Invalidated/suspended
 * statuses cannot certify a phase from potentially stale period metadata.
 * Minute is intentionally not used: first-half injury time can exceed 45
 * (including 50 or "45+5").
 */
function normalizeMatchTiming({ status, period, statusText, minute } = {}) {
  const statusPhase = phaseOf(status);
  const periodPhase = phaseOf(period);
  const matchPhase = UNCERTAIN_STATUSES.has(phaseToken(status)) ? 'UNKNOWN' :
    statusPhase !== 'UNKNOWN' ? statusPhase :
      periodPhase !== 'UNKNOWN' ? periodPhase : phaseOf(statusText);
  return { matchPhase, halfTimeConfirmed: HALF_TIME_COMPLETE_PHASES.has(matchPhase) };
}

module.exports = { normalizeMatchTiming };
