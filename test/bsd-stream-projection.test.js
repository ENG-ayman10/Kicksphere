'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBsdStreamProjection } = require('../utils/bsdStreamProjection');

const NOW = Date.parse('2026-10-14T18:40:00Z');
const fixture = (overrides = {}) => ({ id: 'bsd_223510', rawId: 223510, slug: 'bsd_223510',
  provider: 'bsd', source: 'bsd', utcDate: '2026-10-14T17:30:00Z', status: 'IN_PLAY',
  matchPhase: 'SECOND_HALF', period: 'SECOND_HALF', minute: 66, second: 50,
  lastUpdated: '2026-10-14T18:36:00Z',
  score: { fullTime: { home: 0, away: 0 }, halfTime: { home: 0, away: 0 } },
  homeTeam: { id: 'bsd_t_3021', rawId: 3021, name: 'Aldosivi', crest: 'https://example.org/home.png', provider: 'bsd' },
  awayTeam: { id: 'bsd_t_3044', rawId: 3044, name: 'Gimnasia', provider: 'bsd' },
  competition: { id: 'ARG', name: 'Primera División', emblem: 'https://example.org/arg.png', season: { id: 44 } },
  lineups: { confirmed: true, home: [{ id: 'bsd_p_40112' }] },
  venue: { name: 'José María Minella' }, customMetadata: { retained: true }, ...overrides });
const event = (overrides = {}) => ({ type: 'event', event_id: 223510,
  home: { id: 3021, name: 'Untrusted replacement name' }, away: { id: 3044, name: 'Other name' },
  score: { home: 0, away: 0 },
  time: { minute: 67, second: 0, display: "67'", period: 2, status: 'live',
    kickoff_at: '2026-10-14T20:30:00+03:00', period_started_at_uts: 1791991800, injury_time: null },
  ...overrides });
const action = (overrides = {}) => ({ type: 'action', event_id: 223510, action_type: 'goal',
  team: 'home', player: { id: 40112, name: 'T. Fernández' }, score: { home: 1, away: 0 },
  minute: 67, second: 34, period: 2, ts: NOW - 5000, qualifiers: ['left_foot'], ...overrides });
function ready(options = {}) {
  const projection = createBsdStreamProjection({ now: () => NOW, ...options });
  assert.equal(projection.seed([fixture()]), 1);
  const generation = projection.beginGeneration();
  assert.equal(projection.project({ type: 'subscribed', event_id: 223510, event: event(), history: [] },
    { generation }).accepted, true);
  return projection;
}

test('confirmed provisional goal can settle after an event clock advances without rewinding match time', () => {
  const projection = ready();
  const pending = action({ action_type: 'temp_goal', minute: 68, second: 1, ts: NOW - 1000 });
  assert.equal(projection.project(pending).reason, 'provisional_action');
  const tick = event({ score: { home: 1, away: 0 }, time: { ...event().time, minute: 68, second: 2 } });
  const held = projection.project(tick);
  assert.deepEqual(held.match.score.fullTime, { home: 0, away: 0 });
  const settled = projection.project(action({ minute: 68, second: 1, ts: NOW - 900 }));
  assert.equal(settled.accepted, true);
  assert.deepEqual(settled.match.score.fullTime, { home: 1, away: 0 });
  assert.equal(settled.match.second, 2);
  assert.equal(settled.incident.periodSecond, 1);
  assert.equal(projection.project(action({ minute: 68, second: 1, ts: NOW - 900 })).reason, 'replayed_action');
});

test('stream requires an exact trusted BSD fixture and cannot create or clone another provider alias', () => {
  const projection = createBsdStreamProjection({ now: () => NOW });
  for (const match of [fixture({ id: 'ko_223510', provider: 'kickoffapi' }),
    fixture({ id: 'bsd_0223510' }), fixture({ provider: 'sportscore' }),
    fixture({ canonicalMatchId: 'other-match' }), fixture({ rawId: 7 }),
    fixture({ homeTeam: { id: 'ko_t_3021', name: 'Aldosivi' } }),
    fixture({ homeTeam: { id: 'bsd_t_3021', rawId: 7 } }),
    fixture({ awayTeam: { id: 'bsd_t_3021' } }), fixture({ utcDate: '2026-10-14 17:30:00' })]) {
    assert.equal(projection.upsert(match), false);
  }
  assert.equal(projection.project(event()).reason, 'unknown_fixture');
  assert.equal(projection.upsert(fixture({ providerIdentities: [{ id: 'other-match', provider: 'sportscore' }] })), true);
  assert.equal(projection.get('other-match'), null);
  assert.equal(projection.project(event({ event_id: 17 })).reason, 'unknown_fixture');
});

test('subscribed validates exact fixture, participant order, positive IDs and kickoff instant', () => {
  const projection = ready();
  for (const bad of [event({ home: { id: 3044 }, away: { id: 3021 } }), event({ home: { id: 0 } }),
    event({ home: { id: true } }), event({ home: { id: '3021 extra' } }),
    event({ time: { ...event().time, kickoff_at: '2026-10-14T17:31:00Z' } }),
    event({ time: { ...event().time, kickoff_at: null } })]) {
    const result = projection.project({ type: 'subscribed', event_id: 223510, event: bad });
    assert.equal(result.accepted, false);
  }
  assert.equal(projection.project({ type: 'subscribed', event_id: 223510,
    event: event({ event_id: 223511 }) }).reason, 'invalid_subscribed_snapshot');
  assert.equal(projection.project({ type: 'subscribed', event_id: 223510,
    home: { id: 7 }, event: event() }).reason, 'team_mismatch');
});

test('subscribed snapshot is a baseline and history never generates a fresh score or incident', () => {
  const projection = createBsdStreamProjection({ now: () => NOW });
  projection.seed([fixture()]);
  const temp = action({ action_type: 'temp_goal', ts: NOW - 7000 });
  const deleted = action({ action_type: 'deleted_event', score: { home: 0, away: 0 }, ts: NOW - 6000 });
  const result = projection.project({ type: 'subscribed', event_id: 223510, source: 'full', event: event(),
    history: [temp, deleted], livedata: [{ situation: 'goal' }] });
  assert.equal(result.baseline, true);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.match.score.fullTime, { home: 0, away: 0 });
  assert.equal(result.incident, undefined);
  assert.equal(projection.project(temp).reason, 'replayed_action');
  assert.equal(projection.project(deleted).reason, 'replayed_action');
});

test('session generation fence rejects late frames and forces a new subscribed baseline', () => {
  const projection = ready();
  const oldGeneration = projection.generation;
  const next = projection.beginGeneration();
  assert.equal(projection.project(action(), { generation: oldGeneration }).reason, 'stale_generation');
  assert.equal(projection.project(action(), { generation: next }).reason, 'awaiting_subscribed_baseline');
  const result = projection.project({ type: 'subscribed', event_id: 223510, event: event() }, { generation: next });
  assert.equal(result.baseline, true);
  assert.equal(projection.project(action(), { generation: next }).accepted, true);
});

test('subscribed can use outer fixture ID only with exact participants and kickoff when inner ID is omitted', () => {
  const projection = createBsdStreamProjection({ now: () => NOW });
  projection.seed([fixture()]);
  const snapshot = event(); delete snapshot.event_id;
  const result = projection.project({ type: 'subscribed', event_id: 223510, event: snapshot });
  assert.equal(result.accepted, true);
  assert.equal(result.baseline, true);
  assert.equal(result.match.id, 'bsd_223510');
  const noKickoff = structuredClone(snapshot); delete noKickoff.time.kickoff_at;
  assert.equal(projection.project({ type: 'subscribed', event_id: 223510, event: noKickoff }).accepted, false);
  assert.equal(projection.project({ type: 'subscribed', event_id: 223510,
    event: { ...snapshot, home: { id: 7 } } }).accepted, false);
  assert.equal(projection.project({ type: 'subscribed', event_id: 223510,
    event: { ...snapshot, event_id: 223511 } }).accepted, false);
  assert.equal(projection.project(snapshot).reason, 'unknown_fixture', 'Standalone events still require an exact ID');
});

test('event projects strict source score/clock and preserves all trusted fixture metadata', () => {
  const projection = ready();
  const result = projection.project(event({ score: { home: 1, away: 0 },
    time: { ...event().time, minute: 67, second: 1 } }));
  assert.equal(result.accepted, true);
  assert.equal(result.changed, true);
  assert.equal(result.match.homeTeam.name, 'Aldosivi');
  assert.deepEqual(result.match.competition, fixture().competition);
  assert.deepEqual(result.match.lineups, fixture().lineups);
  assert.deepEqual(result.match.customMetadata, { retained: true });
  assert.equal(result.match.minute, 67);
  assert.equal(result.match.second, 1);
  assert.equal(result.match.status, 'IN_PLAY');
  assert.equal(result.match.matchPhase, 'SECOND_HALF');
  assert.equal(result.match.lastUpdated, null, 'Receipt and period start are not provider score timestamps');
  assert.equal(result.receivedAt, NOW);
  assert.notEqual(result.match.periodStartedAt, new Date(NOW).toISOString());
  result.match.homeTeam.name = 'Mutated caller copy';
  assert.equal(projection.get('bsd_223510').homeTeam.name, 'Aldosivi');
});

test('invalid or partial score values cannot become fabricated zeroes', () => {
  const projection = ready();
  for (const score of [{ home: null, away: 0 }, { home: -1, away: 0 }, { home: 100, away: 0 },
    { home: 1.1, away: 0 }, { home: '1', away: 0 }, { home: true, away: 0 }, { home: 1 }, []]) {
    assert.equal(projection.project(event({ score })).accepted, false);
    assert.equal(projection.project(action({ score })).accepted, false);
  }
  assert.deepEqual(projection.get('bsd_223510').score.fullTime, { home: 0, away: 0 });
});

test('phases and status use explicit source fields without minute inference or unknown period guesses', () => {
  const projection = ready();
  for (const period of [0, 6, '__proto__', '2', null]) {
    const result = projection.project(event({ time: { ...event().time, minute: 90, second: 0, period } }));
    assert.equal(result.match.matchPhase, 'UNKNOWN');
    assert.equal(result.match.status, 'IN_PLAY');
  }
  const paused = projection.project(event({ time: { ...event().time, minute: 90, second: 1,
    status: 'paused', period: null } }));
  assert.equal(paused.match.status, 'PAUSED');
  assert.equal(paused.match.matchPhase, 'UNKNOWN');
  assert.equal(projection.project(event({ time: { ...event().time, status: 'whatever' } })).accepted, false);
});

test('known numeric periods map only to documented phase meanings', () => {
  const phases = ['FIRST_HALF', 'SECOND_HALF', 'EXTRA_TIME', 'EXTRA_TIME', 'PENALTIES'];
  for (let period = 1; period <= 5; period++) {
    const projection = ready();
    const result = projection.project(event({ time: { ...event().time, minute: 91, second: period, period } }));
    assert.equal(result.match.matchPhase, phases[period - 1]);
  }
});

test('confirmed goal, explicit deleted-event correction and new goal preserve score revision order', () => {
  const projection = ready();
  const goal = projection.project(action());
  assert.deepEqual(goal.match.score.fullTime, { home: 1, away: 0 });
  assert.equal(goal.match.lastUpdated, new Date(action().ts).toISOString());
  assert.equal(goal.incident.playerId, 'bsd_p_40112');
  assert.equal(goal.incident.side, 'home');
  assert.equal(goal.incident.player, 'T. Fernández');
  assert.equal(goal.incident.lastUpdated, goal.match.lastUpdated);
  const cancelled = projection.project(action({ action_type: 'deleted_event', ts: NOW - 4000,
    score: { home: 0, away: 0 } }));
  assert.deepEqual(cancelled.match.score.fullTime, { home: 0, away: 0 });
  assert.equal(cancelled.incident, undefined);
  assert.deepEqual(cancelled.refreshHints, ['timeline']);
  const newGoal = projection.project(action({ ts: NOW - 3000, player: { id: 40113, name: 'Another player' } }));
  assert.deepEqual(newGoal.match.score.fullTime, { home: 1, away: 0 });
  assert.notEqual(newGoal.incident.id, goal.incident.id);
});

test('provisional goal and generic actions carrying its provisional score cannot produce a final goal', () => {
  const projection = ready();
  const provisional = projection.project(action({ action_type: 'temp_goal' }));
  assert.equal(provisional.reason, 'provisional_action');
  assert.equal(provisional.changed, false);
  assert.equal(provisional.incident, undefined);
  assert.deepEqual(provisional.match.score.fullTime, { home: 0, away: 0 });
  const provisionalEvent = projection.project(event({ score: { home: 1, away: 0 },
    time: { ...event().time, second: 34 } }));
  assert.deepEqual(provisionalEvent.match.score.fullTime, { home: 0, away: 0 });
  assert.deepEqual(provisionalEvent.refreshHints, ['score_reconciliation']);
  const pass = projection.project(action({ action_type: 'pass', ts: NOW - 4000 }));
  assert.equal(pass.reason, 'provisional_score_retained');
  assert.deepEqual(pass.match.score.fullTime, { home: 0, away: 0 });
  const deleted = projection.project(action({ action_type: 'deleted_event', ts: NOW - 3000,
    score: { home: 0, away: 0 } }));
  assert.equal(deleted.accepted, true);
  assert.equal(deleted.incident, undefined);
  const settled = projection.project(action({ ts: NOW - 2000 }));
  assert.equal(settled.accepted, true);
  assert.equal(settled.incident.type, 'goal');
});

test('temp_attempt/temp_save are never final incidents and unknown action types cannot update score', () => {
  for (const actionType of ['temp_attempt', 'temp_save', 'unknown_999', 'red_card', 'own_goal']) {
    const projection = ready();
    const result = projection.project(action({ action_type: actionType }));
    assert.equal(result.incident, undefined);
    assert.deepEqual(result.match.score.fullTime, { home: 0, away: 0 });
  }
});

test('stale/replayed actions do not roll source score back or mutate trusted player identity', () => {
  const projection = ready();
  const initial = projection.project(action());
  assert.equal(initial.accepted, true);
  assert.equal(projection.project(action({ player: { id: 40112, name: 'Updated name' },
    qualifiers: ['header', 'new qualifier'] })).reason, 'replayed_action');
  assert.equal(projection.project(action({ action_type: 'deleted_event', ts: NOW - 6000,
    score: { home: 0, away: 0 } })).reason, 'stale_action');
  assert.deepEqual(projection.get('bsd_223510').score.fullTime, { home: 1, away: 0 });
});

test('same-clock distinct confirmed goal/cancellation/actions remain distinct', () => {
  const projection = ready();
  const goal = projection.project(action());
  const cancelled = projection.project(action({ action_type: 'deleted_event', score: { home: 0, away: 0 } }));
  const newGoal = projection.project(action({ player: { id: 40113, name: 'Another player' } }));
  assert.equal(goal.accepted, true);
  assert.equal(cancelled.accepted, true);
  assert.equal(newGoal.accepted, true);
  assert.notEqual(newGoal.incident.id, goal.incident.id);
  assert.equal(newGoal.revision, goal.revision + 2);
});

test('provisional timestamp fences older final action without pretending it is a final source update', () => {
  const projection = ready();
  const provisional = projection.project(action({ action_type: 'temp_goal' }));
  assert.equal(provisional.match.lastUpdated, null);
  assert.equal(projection.project(action({ ts: NOW - 6000 })).reason, 'stale_action');
  assert.equal(projection.project(action({ ts: NOW - 4000 })).accepted, true);
});

test('older untimestamped events and same-clock conflicting events cannot undo a confirmed stream goal', () => {
  const projection = ready();
  projection.project(action());
  const conflicting = projection.project(event({ time: { ...event().time, second: 34 } }));
  assert.equal(conflicting.accepted, false);
  assert.equal(conflicting.reason, 'stale_event');
  assert.deepEqual(conflicting.refreshHints, ['score_reconciliation']);
  assert.deepEqual(conflicting.match.score.fullTime, { home: 1, away: 0 });
  assert.equal(projection.project(event()).accepted, false);
  const newer = projection.project(event({ time: { ...event().time, second: 35 } }));
  assert.equal(newer.accepted, true, 'A new ordered authoritative event can carry an explicit correction');
  assert.equal(newer.match.lastUpdated, null);
});

test('fresh correction of an earlier action revises score without rewinding the authoritative match clock', () => {
  const projection = ready();
  projection.project(action());
  projection.project(event({ score: { home: 1, away: 0 }, time: { ...event().time, minute: 68, second: 0 } }));
  const cancelled = projection.project(action({ action_type: 'deleted_event', minute: 45, period: 1,
    score: { home: 0, away: 0 }, ts: NOW - 1000 }));
  assert.equal(cancelled.accepted, true);
  assert.deepEqual(cancelled.match.score.fullTime, { home: 0, away: 0 });
  assert.equal(cancelled.match.minute, 68);
  assert.equal(cancelled.match.second, 0);
  assert.equal(cancelled.match.period, 'SECOND_HALF');
  assert.equal(cancelled.match.lastUpdated, new Date(NOW - 1000).toISOString());
  assert.equal(projection.project(event({ score: { home: 1, away: 0 },
    time: { ...event().time, minute: 67, second: 59 } })).accepted, false);
});

test('generic cards never guess color from open provider qualifier strings', () => {
  const projection = ready();
  const result = projection.project(action({ action_type: 'card', qualifiers: ['red', 'second_yellow'],
    score: { home: 0, away: 0 } }));
  assert.equal(result.accepted, true);
  assert.equal(result.incident, undefined);
  assert.deepEqual(result.refreshHints, ['timeline']);
});

test('individual player on/off frames never invent a substitution pair', () => {
  for (const actionType of ['player_on', 'player_off']) {
    const projection = ready();
    const result = projection.project(action({ action_type: actionType, score: { home: 0, away: 0 } }));
    assert.equal(result.incident, undefined);
    assert.deepEqual(result.refreshHints, ['timeline', 'lineups']);
  }
});

test('period_end and collection_end request explicit status rather than guessing halftime or final whistle', () => {
  for (const actionType of ['period_end', 'collection_end']) {
    const projection = ready();
    const result = projection.project(action({ action_type: actionType, minute: 90,
      score: { home: 0, away: 0 } }));
    assert.equal(result.match.status, 'IN_PLAY');
    assert.equal(result.match.matchPhase, 'SECOND_HALF');
    assert.deepEqual(result.refreshHints, ['match_status']);
  }
});

test('action periods cannot announce resumption from PAUSED or start/end a scheduled/finished fixture', () => {
  for (const [status, phase] of [['PAUSED', 'HALF_TIME'], ['PAUSED', 'UNKNOWN'],
    ['TIMED', 'NOT_STARTED'], ['FINISHED', 'FULL_TIME']]) {
    const projection = ready();
    projection.upsert(fixture({ status, matchPhase: phase, period: phase,
      lastUpdated: new Date(NOW - 6000).toISOString() }));
    const result = projection.project(action({ action_type: 'period_start', score: { home: 0, away: 0 } }));
    assert.equal(result.accepted, true);
    assert.equal(result.match.status, status);
    assert.equal(result.match.matchPhase, phase);
    assert.equal(result.match.period, phase);
    assert.deepEqual(result.refreshHints, ['match_status']);
  }
});

test('reconnect baseline discards a pending provisional from the previous connection without replaying history', () => {
  const projection = ready();
  projection.project(action({ action_type: 'temp_goal' }));
  projection.beginGeneration();
  const baseline = projection.project({ type: 'subscribed', event_id: 223510,
    event: event({ time: { ...event().time, second: 35 } }),
    history: [action({ action_type: 'temp_goal' })] });
  assert.equal(baseline.baseline, true);
  assert.deepEqual(baseline.match.score.fullTime, { home: 0, away: 0 });
  const newGoal = projection.project(action({ minute: 68, ts: NOW - 1000 }));
  assert.equal(newGoal.accepted, true);
  assert.deepEqual(newGoal.match.score.fullTime, { home: 1, away: 0 });
});

test('clock/action identity validation rejects malformed fields and missing timestamps', () => {
  const projection = ready();
  for (const overrides of [{ ts: null }, { ts: '1792000000000' }, { ts: -1 }, { ts: NaN },
    { second: 60 }, { minute: -1 }, { minute: 181 }, { period: '__proto__' },
    { period: 6 }, { period: '2' }, { team: 'left' }, { player: { id: 0 } }, { player: 'Name' }, { team: null }]) {
    assert.equal(projection.project(action(overrides)).accepted, false, JSON.stringify(overrides));
  }
  assert.equal(projection.project(action({ home: { id: 7 } })).reason, 'team_mismatch');
  assert.equal(projection.project(action()).accepted, true, 'Invalid inputs did not consume the valid action');
});

test('newer REST enrichment is trusted, older/missing REST clocks cannot roll stream correction back', () => {
  const projection = ready();
  projection.project(action());
  const latestName = fixture({ homeTeam: { ...fixture().homeTeam, name: 'Localized team', crest: 'new.png' } });
  assert.equal(projection.upsert(latestName), true);
  assert.equal(projection.get('bsd_223510').homeTeam.name, 'Localized team');
  assert.deepEqual(projection.get('bsd_223510').score.fullTime, { home: 1, away: 0 });
  assert.equal(projection.upsert(fixture({ lastUpdated: null })), true);
  assert.deepEqual(projection.get('bsd_223510').score.fullTime, { home: 1, away: 0 });
  const omittedTimestamp = fixture(); delete omittedTimestamp.lastUpdated;
  assert.equal(projection.upsert(omittedTimestamp), true);
  assert.deepEqual(projection.get('bsd_223510').score.fullTime, { home: 1, away: 0 });
  assert.equal(projection.upsert(fixture({ lastUpdated: new Date(action().ts).toISOString() })), true);
  assert.deepEqual(projection.get('bsd_223510').score.fullTime, { home: 1, away: 0 }, 'Equal timestamp cannot prove a conflicting REST revision');
  const withoutEnrichment = fixture({ lastUpdated: null });
  delete withoutEnrichment.lineups; delete withoutEnrichment.venue; delete withoutEnrichment.customMetadata;
  assert.equal(projection.upsert(withoutEnrichment), true);
  assert.deepEqual(projection.get('bsd_223510').lineups, fixture().lineups);
  assert.deepEqual(projection.get('bsd_223510').venue, fixture().venue);
  assert.equal(projection.upsert(fixture({ lastUpdated: new Date(NOW - 1000).toISOString(),
    score: { fullTime: { home: 0, away: 0 } } })), true);
  assert.deepEqual(projection.get('bsd_223510').score.fullTime, { home: 0, away: 0 });
  assert.equal(projection.project(action({ ts: NOW - 2000 })).reason, 'stale_action');
});

test('trusted fixture identity cannot be replaced in place with other teams or another kickoff', () => {
  const projection = ready();
  assert.equal(projection.upsert(fixture({ homeTeam: { id: 'bsd_t_9' } })), false);
  assert.equal(projection.upsert(fixture({ utcDate: '2026-10-14T17:31:00Z' })), false);
  assert.equal(projection.get('bsd_223510').homeTeam.id, 'bsd_t_3021');
});

test('bounded match state evicts old fixtures and returned snapshots are isolated', () => {
  const projection = createBsdStreamProjection({ maxMatches: 2 });
  const fixtures = [1, 2, 3].map(id => fixture({ id: `bsd_${id}`, rawId: id }));
  assert.equal(projection.seed(fixtures), 3);
  assert.equal(projection.size, 2);
  assert.equal(projection.get('bsd_1'), null);
  const rows = projection.snapshot(); rows[0].score.fullTime.home = 99;
  assert.deepEqual(projection.get('bsd_2').score.fullTime, { home: 0, away: 0 });
});

test('positional livedata and odds never masquerade as confirmed match incidents', () => {
  const projection = ready();
  for (const type of ['livedata', 'odds', 'history', 'error', 'pong']) {
    assert.equal(projection.project({ type, event_id: 223510, situation: 'goal', score: { home: 1, away: 0 } }).reason,
      'unsupported_frame');
  }
});
