'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reminderDue, upcomingAlertCandidate, kickoffNotificationFresh, lineupNotificationRelevant, matchPhase, lineupState, incidentKey,
  incidentAlert, incidentFields } = require('../utils/notificationEventTransitions');

const now = Date.parse('2026-10-11T12:00:00Z');
const scheduled = minutes => ({ id: 'bsd_1', status: 'TIMED', utcDate: new Date(now + minutes * 60000).toISOString(),
  homeTeam: { id: 'bsd_t_1' }, awayTeam: { id: 'bsd_t_2' } });
const lineup = confirmed => ({ matchId: 'bsd_1', confirmed, predicted: !confirmed, lineupStatus: confirmed ? 'confirmed' : 'predicted',
  homeTeamId: 'bsd_t_1', awayTeamId: 'bsd_t_2',
  home: Array.from({ length: 11 }, (_, i) => ({ id: `bsd_p_${i + 1}` })),
  away: Array.from({ length: 11 }, (_, i) => ({ id: `bsd_p_${i + 12}` })) });

test('15-minute reminder has a one-minute scheduling window without late or historical reminders', () => {
  assert.equal(reminderDue(scheduled(15), now), true);
  assert.equal(reminderDue(scheduled(14.5), now), true);
  for (const minutes of [16, 14, 10, 0, -1]) assert.equal(reminderDue(scheduled(minutes), now), false);
  assert.equal(reminderDue({ ...scheduled(15), status: 'IN_PLAY' }, now), false);
  assert.equal(reminderDue({ ...scheduled(15), liveSnapshotStale: true }, now), false);
  assert.equal(reminderDue({ ...scheduled(15), utcDate: '2026-10-11 12:15:00' }, now), false);
});

test('optional lineup detail scope covers only the next 90 minutes of scheduled fixtures', () => {
  assert.equal(upcomingAlertCandidate(scheduled(90), now), true);
  assert.equal(upcomingAlertCandidate(scheduled(1), now), true);
  for (const minutes of [91, 0, -1]) assert.equal(upcomingAlertCandidate(scheduled(minutes), now), false);
  assert.equal(upcomingAlertCandidate({ ...scheduled(10), status: 'CANCELLED' }, now), false);
});

test('late scheduled-to-live recovery cannot announce a historical kickoff or post-match lineup', () => {
  const past = { ...scheduled(-60), status: 'IN_PLAY' };
  assert.equal(kickoffNotificationFresh(past, now), false);
  assert.equal(kickoffNotificationFresh({ ...past, minute: 40 }, now), false);
  assert.equal(kickoffNotificationFresh({ ...past, minute: 1 }, now), true, 'Published opening minute proves a delayed kickoff');
  assert.equal(lineupNotificationRelevant({ ...past, minute: 40 }, now), false);
  assert.equal(lineupNotificationRelevant({ ...past, status: 'FINISHED' }, now), false);
  assert.equal(lineupNotificationRelevant(scheduled(30), now), true);
});

test('phase uses explicit provider periods without deriving half time from minute 45 or a generic pause', () => {
  assert.equal(matchPhase({ status: 'PAUSED', minute: 45 }), 'UNKNOWN');
  assert.equal(matchPhase({ status: 'IN_PLAY', minute: 90 }), 'UNKNOWN');
  assert.equal(matchPhase({ status: 'PAUSED', period: 'half_time', minute: 49 }), 'HALF_TIME');
  assert.equal(matchPhase({ status: 'IN_PLAY', period: 'second_half' }), 'SECOND_HALF');
  assert.equal(matchPhase({ status: 'IN_PLAY', matchPhase: 'EXTRA_TIME' }), 'EXTRA_TIME');
  assert.equal(matchPhase({ status: 'IN_PLAY', period: 'penalty_shootout' }), 'PENALTIES');
});

test('official lineup confirmation requires two complete distinct elevens and verified match/team identity', () => {
  const match = scheduled(30), official = lineup(true);
  assert.equal(lineupState(official, match), true);
  assert.equal(lineupState(lineup(false), match), false);
  assert.equal(lineupState(null, match), null);
  assert.equal(lineupState({ ...official, matchId: 'bsd_9' }, match), null);
  assert.equal(lineupState({ ...official, homeTeamId: 'bsd_t_9' }, match), null);
  assert.equal(lineupState({ ...official, away: official.away.slice(0, 10) }, match), null);
  assert.equal(lineupState({ ...official, away: official.home }, match), null);
  assert.equal(lineupState({ ...official, home: official.home.map((player, i) => i === 0 ? {} : player) }, match), null);
  assert.equal(lineupState({ ...official, home: official.home.map((player, i) => i === 0 ? { ...player, player: { id: 'bsd_p_99' } } : player) }, match), null);
  assert.equal(lineupState({ ...official, predicted: true }, match), false);
});

test('stable incident ID ignores mutable translations, player names, images and ratings', () => {
  const original = { id: 'bsd_inc_7', type: 'red_card', minute: 70, player: 'Player', label: 'Red card' };
  assert.equal(incidentKey(original), incidentKey({ ...original, player: 'اللاعب', label: 'طرد', playerImage: 'new', rating: 6 }));
  assert.notEqual(incidentKey(original), incidentKey({ ...original, id: 'bsd_inc_8' }));
  assert.notEqual(incidentKey(original), incidentKey({ ...original, type: 'yellow_card' }), 'A yellow-to-red provider correction is a distinct semantic transition');
  const fallback = { type: 'red_card', side: 'away', minute: 70, playerId: 'bsd_p_7', player: 'Player' };
  assert.equal(incidentKey(fallback), incidentKey({ ...fallback, player: 'اللاعب', label: 'Enriched', playerImage: 'new' }));
});

test('red cards are public; yellow cards and explicit penalties/substitutions are scoped to direct match bells', () => {
  assert.deepEqual(incidentAlert({ type: 'red_card' }), { type: 'card', cardType: 'red', isDetailed: false });
  assert.equal(incidentAlert({ type: 'red_card', rescinded: true }), null);
  assert.deepEqual(incidentAlert({ type: 'yellow_card' }), { type: 'card', cardType: 'yellow', isDetailed: true });
  assert.equal(incidentAlert({ type: 'yellow_card', deleted: true }), null);
  assert.deepEqual(incidentAlert({ type: 'substitution' }), { type: 'substitution', isDetailed: true });
  assert.deepEqual(incidentAlert({ type: 'penalty_missed' }), { type: 'penalty', penaltyType: 'penalty_missed', isDetailed: true });
  assert.equal(incidentAlert({ type: 'incident', label: 'Goal overturned' }), null, 'An ambiguous text label is not a verified cancellation');
});

test('shootout kicks require an explicit source penalty-shootout period without relabeling ordinary penalties', () => {
  assert.deepEqual(incidentAlert({ type: 'goal', period: 'penalties' }),
    { type: 'penalty', penaltyType: 'shootout_scored', phase: 'PENALTIES', isDetailed: true });
  assert.deepEqual(incidentAlert({ type: 'penalty_missed', period: 'penalty_shootout' }),
    { type: 'penalty', penaltyType: 'shootout_missed', phase: 'PENALTIES', isDetailed: true });
  assert.equal(incidentAlert({ type: 'goal', period: 'second_half', goalType: 'penalty' }), null);
  assert.equal(incidentAlert({ type: 'goal', minute: 120, goalType: 'penalty' }), null);
  assert.equal(incidentAlert({ type: 'goal', period: 'penalties', rescinded: true }), null);
});

test('incident metadata includes only published scorer and assist evidence', () => {
  assert.deepEqual(incidentFields({ id: 7, minute: 8, player: 'Scorer', playerId: 'bsd_p_1', assist: 'Assist', assistId: 'bsd_p_2',
    playerImage: 'published-player-image', assistImage: 'published-assist-image' }),
  { incidentId: '7', minute: 8, player: 'Scorer', playerId: 'bsd_p_1', assist: 'Assist', assistId: 'bsd_p_2',
    playerImage: 'published-player-image', assistImage: 'published-assist-image' });
  assert.deepEqual(incidentFields({}), { player: '', minute: null });
});
