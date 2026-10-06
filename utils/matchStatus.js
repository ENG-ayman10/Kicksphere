'use strict';

function canonicalMatchStatus(raw) {
  const status = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['finished', 'ended', 'ft', 'aet', 'pen', 'full_time', 'after_extra_time', 'after_penalties'].includes(status)) return 'FINISHED';
  if (['live', 'inprogress', 'in_progress', 'inplay', 'in_play', '1t', '2t', '1h', '2h', 'first_half', '1st_half', 'second_half', '2nd_half', 'extra_time', 'extra_time_first_half', 'extra_time_second_half', 'penalties', 'penalty_shootout'].includes(status)) return 'IN_PLAY';
  if (['ht', 'halftime', 'half_time', 'paused'].includes(status)) return 'PAUSED';
  if (['postponed', 'pst', 'post'].includes(status)) return 'POSTPONED';
  if (['cancelled', 'canceled', 'canc', 'abandoned', 'abd'].includes(status)) return 'CANCELLED';
  if (['suspended', 'susp', 'interrupted', 'int'].includes(status)) return 'SUSPENDED';
  if (['notstarted', 'not_started', 'upcoming', 'scheduled', 'timed', 'ns'].includes(status)) return 'TIMED';
  return 'UNKNOWN';
}

const STATUS_LABELS = Object.freeze({ FINISHED: 'Finished', IN_PLAY: 'Live', PAUSED: 'Paused',
  POSTPONED: 'Postponed', CANCELLED: 'Cancelled', SUSPENDED: 'Suspended', TIMED: 'Upcoming', UNKNOWN: 'Unavailable' });

module.exports = { canonicalMatchStatus, STATUS_LABELS };
