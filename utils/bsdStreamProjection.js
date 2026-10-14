'use strict';

// Protocol: https://sports.bzzoiro.com/docs/websocket/football/ . This module
// accepts no credentials, performs no I/O and never emits notifications.
const { createHash } = require('node:crypto');
const { canonicalMatchStatus, STATUS_LABELS } = require('./matchStatus');
const { normalizeMatchTiming } = require('./matchTiming');
const { normalizeProviderTimestamp } = require('./providerTimestamp');

const PERIODS = Object.freeze({ 1: 'FIRST_HALF', 2: 'SECOND_HALF',
  3: 'EXTRA_TIME', 4: 'EXTRA_TIME', 5: 'PENALTIES' });
const ACTION_TYPES = new Set(('pass take_on tackle interception turnover save claim clearance miss post attempt_saved goal ' +
  'punch good_skill aerial challenge ball_recovery dispossessed error keeper_pickup cross_not_claimed smother shield_ball_opp ' +
  'chance_missed ball_touch blocked_pass attempted_tackle offside_pass foul out corner_awarded start_delay end_delay ' +
  'offside_provoked foul_throw_in penalty_faced keeper_sweeper resume fifty_fifty referee_drop_ball drop_of_ball ' +
  'card rescinded_card contentious_referee_decision player_off player_on player_retired player_returns team_setup ' +
  'player_changed_jersey formation_change condition_change official_change period_end period_start collection_end ' +
  'injury_time_announcement delayed_start early_end coverage_interruption deleted_event').split(' '));
const PROVISIONAL_TYPES = new Set(['temp_goal', 'temp_attempt', 'temp_save']);
const RUNTIME_FIELDS = ['score', 'status', 'statusText', 'minute', 'second', 'period', 'matchPhase',
  'halfTimeConfirmed', 'lastUpdated', 'periodStartedAt', 'injuryTime'];
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const integer = (value, max) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const positiveId = value => (typeof value === 'string' || typeof value === 'number') &&
  /^[1-9]\d{0,14}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(Number(value)) : null;
const scopedNumber = (value, prefix) => typeof value === 'string' && value.startsWith(prefix)
  ? positiveId(value.slice(prefix.length)) : null;
const copy = value => structuredClone(value);
const scoreOf = value => record(value) && integer(value.home, 99) && integer(value.away, 99)
  ? { home: value.home, away: value.away } : null;
const sameScore = (a, b) => Boolean(a && b) && a.home === b.home && a.away === b.away;
const sourceMs = value => { const valid = normalizeProviderTimestamp(value); return valid ? Date.parse(valid) : null; };
const clockOf = value => integer(value?.minute, 180) && integer(value?.second, 59)
  ? value.minute * 60 + value.second : null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixtureIdentity(match) {
  const id = scopedNumber(match?.id, 'bsd_');
  const home = scopedNumber(match?.homeTeam?.id, 'bsd_t_');
  const away = scopedNumber(match?.awayTeam?.id, 'bsd_t_');
  const kickoff = sourceMs(match?.utcDate);
  if (!id || !home || !away || home === away || kickoff === null ||
      match.id !== `bsd_${id}` || match.homeTeam.id !== `bsd_t_${home}` || match.awayTeam.id !== `bsd_t_${away}` ||
      (match.provider && match.provider !== 'bsd') || (match.source && match.source !== 'bsd') ||
      (match.canonicalMatchId && match.canonicalMatchId !== match.id)) return null;
  for (const [obj, expected] of [[match, id], [match.homeTeam, home], [match.awayTeam, away]]) {
    if (obj.rawId !== undefined && positiveId(obj.rawId) !== expected ||
        obj.providerId !== undefined && positiveId(obj.providerId) !== expected ||
        obj.provider && obj.provider !== 'bsd' || obj.source && obj.source !== 'bsd') return null;
  }
  return { id: match.id, home, away, kickoff };
}

function createBsdStreamProjection(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxMatches = integer(options.maxMatches, 1000) && options.maxMatches > 0 ? options.maxMatches : 500;
  const maxActions = integer(options.maxActionsPerMatch, 1024) && options.maxActionsPerMatch > 0
    ? options.maxActionsPerMatch : 256;
  const states = new Map();
  let generation = 0;
  function remember(set, key) {
    set.add(key);
    while (set.size > maxActions) set.delete(set.values().next().value);
  }
  function result(state, accepted, reason, extra = {}) {
    return { accepted, reason, matchId: state?.identity.id || null, generation,
      baseline: false, changed: false, refreshHints: [], receivedAt: now(),
      ...(state ? { match: copy(state.match), revision: state.revision } : {}), ...extra };
  }
  function upsert(match) {
    const identity = fixtureIdentity(match);
    if (!identity) return false;
    let state = states.get(identity.id);
    if (state && (state.identity.home !== identity.home || state.identity.away !== identity.away ||
        state.identity.kickoff !== identity.kickoff)) return false;
    const incoming = { ...(state ? copy(state.match) : {}), ...copy(match) };
    if (!state) {
      state = { identity, match: incoming, subscribed: false, revision: 0,
        sourceAt: sourceMs(incoming.lastUpdated), highestActionAt: null, receivedAt: null, actionClock: null,
        hasStreamState: false, actions: new Set(), events: new Set(), provisional: null };
      states.set(identity.id, state);
      while (states.size > maxMatches) states.delete(states.keys().next().value);
      return true;
    }
    // Inspect the supplied REST timestamp, not one inherited from stream state
    // when the REST response omitted lastUpdated entirely.
    const incomingAt = sourceMs(match.lastUpdated);
    // A cached/missing REST clock may enrich names and images, but cannot undo
    // a newer stream correction while the connection is being reconciled.
    const retainStream = state.hasStreamState && (incomingAt === null ||
      state.sourceAt !== null && incomingAt <= state.sourceAt);
    if (retainStream) for (const field of RUNTIME_FIELDS) {
      if (Object.hasOwn(state.match, field)) incoming[field] = copy(state.match[field]);
      else delete incoming[field];
    }
    state.match = incoming;
    if (!retainStream && incomingAt !== null) state.sourceAt = Math.max(state.sourceAt ?? 0, incomingAt);
    return true;
  }
  function seed(matches) {
    let accepted = 0;
    for (const match of Array.isArray(matches) ? matches : []) if (upsert(match)) accepted++;
    return accepted;
  }
  function beginGeneration() {
    generation++;
    for (const state of states.values()) state.subscribed = false;
    return generation;
  }
  function validateFrameIdentity(frame, state, requireTeams = false) {
    if (positiveId(frame.event_id) !== state.identity.id.slice(4)) return 'fixture_mismatch';
    for (const side of ['home', 'away']) {
      if (requireTeams || Object.hasOwn(frame, side)) {
        if (!record(frame[side]) || positiveId(frame[side].id) !== state.identity[side]) return 'team_mismatch';
      }
    }
    if (frame.time && Object.hasOwn(frame.time, 'kickoff_at') &&
        sourceMs(frame.time.kickoff_at) !== state.identity.kickoff) return 'kickoff_mismatch';
    return null;
  }
  function applyEvent(frame, state, baseline = false) {
    const identityError = validateFrameIdentity(frame, state, true);
    if (identityError) return result(state, false, identityError);
    const score = scoreOf(frame.score), time = frame.time;
    if (!score || !record(time)) return result(state, false, 'invalid_event_state');
    const status = canonicalMatchStatus(time.status);
    if (status === 'UNKNOWN' || time.minute != null && !integer(time.minute, 180) ||
        time.second != null && !integer(time.second, 59)) return result(state, false, 'invalid_event_clock');
    const phase = integer(time.period, 5) && Object.hasOwn(PERIODS, time.period) ? PERIODS[time.period] : 'UNKNOWN';
    const incomingClock = clockOf(time), priorClock = clockOf(state.match);
    const fingerprint = hash(['event', score, time.minute ?? null, time.second ?? null, time.period ?? null, status]);
    const scoreChanged = !sameScore(score, state.match.score?.fullTime);
    const staleClock = incomingClock !== null && priorClock !== null && incomingClock < priorClock;
    const conflictsAction = state.actionClock !== null && scoreChanged &&
      (incomingClock === null || incomingClock <= state.actionClock);
    if (staleClock || conflictsAction || state.events.has(fingerprint)) {
      if (baseline) {
        state.subscribed = true;
        state.provisional = null;
        return result(state, true, 'baseline_retained', { baseline: true,
          refreshHints: staleClock || conflictsAction ? ['score_reconciliation'] : [] });
      }
      return result(state, false, state.events.has(fingerprint) ? 'replayed_event' : 'stale_event',
        { refreshHints: ['score_reconciliation'] });
    }
    const retainProvisionalScore = !baseline && state.provisional && scoreChanged &&
      sameScore(score, state.provisional.score);
    const timing = normalizeMatchTiming({ status: time.status, period: phase });
    const patch = { score: { ...state.match.score,
      fullTime: retainProvisionalScore ? state.match.score.fullTime : score }, status,
      statusText: typeof time.display === 'string' && time.display.length <= 40 ? time.display : STATUS_LABELS[status],
      minute: time.minute ?? null, second: time.second ?? null, period: phase,
      ...timing, lastUpdated: null };
    // period_started_at_uts is a period start, never a score freshness clock.
    if (integer(time.period_started_at_uts, 8640000000000) && time.period_started_at_uts > 0) {
      patch.periodStartedAt = new Date(time.period_started_at_uts * 1000).toISOString();
    }
    if (time.injury_time === null || integer(time.injury_time, 60)) patch.injuryTime = time.injury_time;
    const changed = RUNTIME_FIELDS.some(field => JSON.stringify(state.match[field]) !== JSON.stringify(patch[field]));
    state.match = { ...state.match, ...patch };
    state.receivedAt = now(); state.hasStreamState = true; state.revision++;
    if (baseline) { state.subscribed = true; state.provisional = null; }
    remember(state.events, fingerprint);
    return result(state, true, baseline ? 'subscribed_baseline' : 'event', { baseline, changed,
      refreshHints: retainProvisionalScore ? ['score_reconciliation'] : [], receivedAt: state.receivedAt });
  }
  function applyAction(frame, state) {
    const identityError = validateFrameIdentity(frame, state);
    if (identityError) return result(state, false, identityError);
    const actionType = frame.action_type;
    if (!PROVISIONAL_TYPES.has(actionType) && !ACTION_TYPES.has(actionType)) {
      return result(state, false, 'unknown_action', { refreshHints: ['timeline'] });
    }
    if (!integer(frame.ts, 8640000000000000) || frame.ts <= 0 || !Number.isFinite(new Date(frame.ts).getTime()) ||
        !integer(frame.minute, 180) || !integer(frame.second, 59) || !integer(frame.period, 5) ||
        !Object.hasOwn(PERIODS, frame.period)) {
      return result(state, false, 'invalid_action_clock', { refreshHints: ['timeline'] });
    }
    if (frame.team !== null && frame.team !== undefined && !['home', 'away'].includes(frame.team)) {
      return result(state, false, 'invalid_action_team', { refreshHints: ['timeline'] });
    }
    const score = scoreOf(frame.score);
    if (!score) return result(state, false, 'invalid_action_score', { refreshHints: ['score_reconciliation'] });
    const playerId = positiveId(frame.player?.id);
    if (frame.player != null && (!record(frame.player) || !playerId)) {
      return result(state, false, 'invalid_action_player', { refreshHints: ['timeline'] });
    }
    const fingerprint = hash(['action', actionType, frame.ts, frame.team ?? null, playerId,
      frame.minute, frame.second, frame.period, score]);
    if (state.actions.has(fingerprint)) return result(state, false, 'replayed_action');
    const actionFence = Math.max(state.sourceAt ?? 0, state.highestActionAt ?? 0);
    if (frame.ts < actionFence) return result(state, false, 'stale_action');
    const incomingClock = clockOf(frame), priorClock = clockOf(state.match);
    const settlesProvisionalGoal = actionType === 'goal' && state.provisional &&
      sameScore(score, state.provisional.score) && frame.ts >= state.provisional.ts;
    if (incomingClock < priorClock && frame.period !== 5 && !settlesProvisionalGoal &&
        !['deleted_event', 'rescinded_card'].includes(actionType)) {
      return result(state, false, 'stale_action_clock', { refreshHints: ['score_reconciliation'] });
    }
    if (actionType === 'goal' && !['home', 'away'].includes(frame.team)) {
      return result(state, false, 'unconfirmed_goal_side', { refreshHints: ['timeline'] });
    }
    remember(state.actions, fingerprint);
    state.highestActionAt = frame.ts;
    if (PROVISIONAL_TYPES.has(actionType)) {
      if (actionType === 'temp_goal') state.provisional = { score, ts: frame.ts };
      return result(state, true, 'provisional_action', { refreshHints: ['timeline'] });
    }
    if (state.provisional && !['goal', 'deleted_event'].includes(actionType) &&
        !sameScore(score, state.match.score?.fullTime)) {
      return result(state, true, 'provisional_score_retained', { refreshHints: ['score_reconciliation'] });
    }
    if (['goal', 'deleted_event'].includes(actionType)) state.provisional = null;
    const phase = PERIODS[frame.period];
    const patch = { score: { ...state.match.score, fullTime: score }, lastUpdated: new Date(frame.ts).toISOString() };
    // A correction can refer to the original action's minute. Its new source
    // timestamp establishes the revised score, but does not rewind live time.
    const historicalCorrection = priorClock !== null && incomingClock < priorClock &&
      (['deleted_event', 'rescinded_card'].includes(actionType) || settlesProvisionalGoal);
    if (!historicalCorrection) Object.assign(patch, { minute: frame.minute, second: frame.second });
    if (state.match.status === 'IN_PLAY' && !historicalCorrection) Object.assign(patch, { period: phase },
      normalizeMatchTiming({ status: 'live', period: phase }));
    // Action periods alone do not turn a scheduled/finished fixture into live,
    // or period_end into a final whistle. Explicit event.status establishes it.
    const changed = RUNTIME_FIELDS.some(field => Object.hasOwn(patch, field) &&
      JSON.stringify(state.match[field]) !== JSON.stringify(patch[field]));
    state.match = { ...state.match, ...patch }; state.sourceAt = frame.ts;
    state.actionClock = Math.max(state.actionClock ?? 0, incomingClock, priorClock ?? 0); state.receivedAt = now();
    state.hasStreamState = true; state.revision++;
    const refreshHints = [];
    if (['card', 'rescinded_card', 'contentious_referee_decision', 'deleted_event'].includes(actionType)) refreshHints.push('timeline');
    if (['player_on', 'player_off', 'player_retired', 'player_returns'].includes(actionType)) refreshHints.push('timeline', 'lineups');
    if (['team_setup', 'formation_change', 'player_changed_jersey'].includes(actionType)) refreshHints.push('lineups');
    if (['period_end', 'period_start', 'collection_end', 'early_end', 'delayed_start', 'coverage_interruption'].includes(actionType)) refreshHints.push('match_status');
    const incident = actionType === 'goal' ? {
      id: `bsd_ws_${fingerprint}`, type: 'goal', source: 'bsd', provider: 'bsd',
      side: frame.team, minute: frame.minute, periodSecond: frame.second, period: phase,
      score, isLive: true, lastUpdated: patch.lastUpdated, ...(playerId ? { playerId: `bsd_p_${playerId}` } : {}),
      player: typeof frame.player?.name === 'string' && frame.player.name.length <= 200 ? frame.player.name.trim() : ''
    } : null;
    return result(state, true, 'action', { changed, refreshHints, receivedAt: state.receivedAt,
      ...(incident ? { incident } : {}) });
  }
  function project(frame, context = {}) {
    if (!record(frame)) return result(null, false, 'invalid_frame');
    if (context.generation !== undefined && context.generation !== generation) return result(null, false, 'stale_generation');
    const id = positiveId(frame.event_id);
    const state = id ? states.get(`bsd_${id}`) : null;
    if (!state) return result(null, false, 'unknown_fixture');
    if (frame.type === 'subscribed') {
      const identityError = validateFrameIdentity(frame, state);
      if (identityError) return result(state, false, identityError);
      if (!record(frame.event) || frame.event.event_id !== undefined && positiveId(frame.event.event_id) !== id) {
        return result(state, false, 'invalid_subscribed_snapshot');
      }
      // Some subscribed envelopes omit the redundant inner ID. Only the
      // exact trusted participants AND kickoff can authorize that fallback;
      // standalone events and any contradictory supplied inner ID stay strict.
      if (frame.event.event_id === undefined && sourceMs(frame.event.time?.kickoff_at) !== state.identity.kickoff) {
        return result(state, false, 'invalid_subscribed_snapshot');
      }
      const projected = applyEvent(frame.event.event_id === undefined ? { ...frame.event, event_id: frame.event_id } : frame.event,
        state, true);
      // History is replay, not fresh events. Record only safe fingerprints so
      // an identical replay arriving again after subscribe cannot become live.
      if (projected.accepted && Array.isArray(frame.history)) for (const action of frame.history.slice(-maxActions)) {
        const player = positiveId(action?.player?.id);
        const score = scoreOf(action?.score);
        if (record(action) && positiveId(action.event_id) === id && score && action.ts > 0 &&
            integer(action.ts, 8640000000000000) && integer(action.minute, 180) && integer(action.second, 59) &&
            integer(action.period, 5) && Object.hasOwn(PERIODS, action.period) &&
            (ACTION_TYPES.has(action.action_type) || PROVISIONAL_TYPES.has(action.action_type))) {
          remember(state.actions, hash(['action', action.action_type, action.ts, action.team ?? null, player,
            action.minute, action.second, action.period, score]));
          state.highestActionAt = Math.max(state.highestActionAt ?? 0, action.ts);
        }
      }
      return projected;
    }
    if (!state.subscribed) return result(state, false, 'awaiting_subscribed_baseline');
    if (frame.type === 'event') return applyEvent(frame, state);
    if (frame.type === 'action') return applyAction(frame, state);
    return result(state, false, 'unsupported_frame');
  }
  return { seed, upsert, beginGeneration, project,
    get: id => states.has(id) ? copy(states.get(id).match) : null,
    snapshot: () => [...states.values()].map(state => copy(state.match)),
    get size() { return states.size; }, get generation() { return generation; } };
}

module.exports = { createBsdStreamProjection };
