'use strict';

const { createHash } = require('node:crypto');
const WebSocket = require('ws');

const FOOTBALL_ENDPOINT = 'wss://sports.bzzoiro.com/live/football/';
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 10;
const FATAL_ERRORS = Object.freeze({
  auth_required: 'auth',
  subscription_required: 'sub-required',
  not_found: 'network'
});
const FATAL_CLOSE_CODES = Object.freeze({ 4401: 'auth', 4402: 'sub-required', 4404: 'network' });
const ELIGIBLE_ACTION_TYPES = new Set([
  'temp_goal', 'goal', 'deleted_event', 'card', 'rescinded_card', 'contentious_referee_decision',
  'player_on', 'player_off', 'player_retired', 'player_returns', 'player_changed_jersey', 'team_setup', 'formation_change',
  'penalty_faced', 'period_start', 'period_end', 'collection_end', 'delayed_start',
  'early_end', 'coverage_interruption', 'resume'
]);

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function positiveEventId(value) {
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validScore(value) {
  return record(value) && ['home', 'away'].every((side) =>
    Number.isInteger(value[side]) && value[side] >= 0 && value[side] <= 99);
}

function validEvent(value, eventId) {
  return record(value) && validScore(value.score) && record(value.time)
    && (value.event_id === undefined || positiveEventId(value.event_id) === eventId);
}

function seenKey(frame) {
  // Player images/names and qualifiers can be enriched later; they are not a new incident.
  const identity = frame.type === 'action'
    ? [frame.type, frame.event_id, frame.action_type, frame.ts, frame.period,
      frame.minute, frame.second, frame.team, frame.player?.id, frame.score.home, frame.score.away]
    : [frame.type, frame.event_id, frame.score.home, frame.score.away, frame.time];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/**
 * Opt-in transport only. Construction never opens a network connection.
 * onSnapshot receives the subscribed envelope (baseline=true); onFrame receives
 * only subsequent event/settled action frames (live=true). Canonical projection
 * and the REST fallback remain the caller's responsibility.
 */
function createBsdLiveStreamService(options = {}) {
  const apiToken = typeof options.apiToken === 'string' ? options.apiToken.trim() : '';
  const Socket = options.WebSocketCtor || WebSocket;
  const now = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const random = options.random || Math.random;
  const onSnapshot = typeof options.onSnapshot === 'function' ? options.onSnapshot : async () => {};
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : async () => {};
  const maxSockets = boundedInteger(options.maxSockets, 1, 1, 4);
  const queueLimit = boundedInteger(options.queueLimit, 128, 4, 512);
  const seenLimit = boundedInteger(options.seenLimit, 256, 16, 2048);
  const callbackIntervalMs = boundedInteger(options.minCallbackIntervalMs, 10, 0, 1000);
  const reconnectBaseMs = boundedInteger(options.reconnectBaseMs, 1000, 100, 10000);
  const reconnectMaxMs = boundedInteger(options.reconnectMaxMs, 30000, reconnectBaseMs, 60000);
  const slots = Array.from({ length: maxSockets }, (_, index) => ({
    index,
    desired: new Set(), acknowledged: new Map(), subscriptionGenerations: new Map(),
    nextSubscriptionGeneration: 0, socket: null, generation: 0,
    reconnectTimer: null, reconnectAttempt: 0, rejected: new Set()
  }));
  const seen = new Map();
  const queue = [];
  let desiredIds = [];
  let running = false;
  let generation = 0;
  let blockedReason = null;
  let lastFailureReason = null;
  let drainTimer = null;
  let callbackActive = false;
  let lastCallbackAt = -Infinity;
  let capacityExceededCount = 0;
  let invalidSubscriptionCount = 0;
  const counters = {
    receivedFrames: 0, deliveredFrames: 0, ignoredFrames: 0,
    malformedFrames: 0, duplicateFrames: 0, droppedFrames: 0,
    callbackErrors: 0, reconnects: 0
  };

  function unref(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function current(slot, socket, connectionGeneration) {
    return running && slot.socket === socket && slot.generation === connectionGeneration;
  }

  function safeClose(socket) {
    if (!socket) return;
    try {
      if (socket.readyState === 0 && typeof socket.terminate === 'function') socket.terminate();
      else socket.close(1000);
    } catch { /* Never log provider errors, which may contain authentication details. */ }
  }

  function disconnect(slot) {
    if (slot.reconnectTimer !== null) cancel(slot.reconnectTimer);
    slot.reconnectTimer = null;
    const socket = slot.socket;
    slot.socket = null;
    slot.generation += 1;
    slot.acknowledged.clear();
    slot.subscriptionGenerations.clear();
    safeClose(socket);
  }

  function block(reason) {
    blockedReason = reason;
    running = false;
    generation += 1;
    queue.length = 0;
    if (drainTimer !== null) cancel(drainTimer);
    drainTimer = null;
    for (const slot of slots) disconnect(slot);
  }

  function send(slot, frame) {
    if (!slot.socket || slot.socket.readyState !== 1) return false;
    try {
      slot.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      const socket = slot.socket;
      disconnect(slot);
      scheduleReconnect(slot);
      safeClose(socket);
      return false;
    }
  }

  function scheduleReconnect(slot) {
    if (!running || blockedReason || !slot.desired.size || slot.reconnectTimer !== null) return;
    lastFailureReason = 'network';
    const exponent = Math.min(slot.reconnectAttempt++, 16);
    const base = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** exponent));
    const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
    const delay = Math.min(reconnectMaxMs, Math.round(base * (0.8 + 0.4 * jitter)));
    const runGeneration = generation;
    slot.reconnectTimer = unref(schedule(() => {
      slot.reconnectTimer = null;
      if (!running || generation !== runGeneration || !slot.desired.size) return;
      counters.reconnects += 1;
      connect(slot);
    }, delay));
  }

  function stillEligible(item) {
    return item.runGeneration === generation
      && current(item.slot, item.socket, item.connectionGeneration)
      && item.slot.desired.has(item.eventId) && item.slot.acknowledged.has(item.eventId)
      && item.subscriptionGeneration === item.slot.subscriptionGenerations.get(item.eventId);
  }

  function drain() {
    if (!running || callbackActive || drainTimer !== null || !queue.length) return;
    const delay = Math.max(0, lastCallbackAt + callbackIntervalMs - now());
    const runGeneration = generation;
    drainTimer = unref(schedule(async () => {
      drainTimer = null;
      if (!running || generation !== runGeneration || callbackActive) return;
      let item;
      while (queue.length) {
        const candidate = queue.shift();
        if (stillEligible(candidate)) { item = candidate; break; }
      }
      if (!item) return;
      callbackActive = true;
      lastCallbackAt = now();
      try {
        const outcome = await (item.baseline ? onSnapshot : onFrame)(item.frame, {
          eventId: item.eventId,
          baseline: item.baseline,
          live: !item.baseline,
          source: item.source,
          coverage: item.source,
          provisional: item.frame.type === 'action' && item.frame.action_type === 'temp_goal',
          generationId: `${item.runGeneration}:${item.slot.index}:${item.connectionGeneration}`,
          subscriptionGeneration: item.subscriptionGeneration,
          receivedAtMs: item.receivedAtMs
        });
        if (item.baseline && outcome === false) throw new Error('Baseline rejected');
        if (generation === runGeneration) counters.deliveredFrames += 1;
      } catch {
        if (generation === runGeneration) {
          counters.callbackErrors += 1;
          if (item.baseline && current(item.slot, item.socket, item.connectionGeneration)) {
            disconnect(item.slot);
            scheduleReconnect(item.slot);
          }
        }
      } finally {
        callbackActive = false;
        drain();
      }
    }, delay));
  }

  function enqueue(slot, socket, connectionGeneration, frame, baseline) {
    const eventId = positiveEventId(frame.event_id);
    const key = baseline ? null : seenKey(frame);
    if (key && seen.has(key)) { counters.duplicateFrames += 1; return; }
    if (queue.length >= queueLimit) {
      // A fresh baseline after reconnect is safer than delivering an incomplete
      // burst as a complete sequence. Existing REST polling remains the fallback.
      counters.droppedFrames += 1;
      disconnect(slot);
      scheduleReconnect(slot);
      return;
    }
    if (key) {
      seen.set(key, true);
      if (seen.size > seenLimit) seen.delete(seen.keys().next().value);
    }
    queue.push({
      slot, socket, connectionGeneration, frame, eventId, baseline,
      subscriptionGeneration: slot.subscriptionGenerations.get(eventId),
      runGeneration: generation, source: slot.acknowledged.get(eventId), receivedAtMs: now()
    });
    drain();
  }

  function message(slot, socket, connectionGeneration, data, isBinary) {
    if (!current(slot, socket, connectionGeneration)) return;
    counters.receivedFrames += 1;
    let frame;
    try {
      if (isBinary || !(typeof data === 'string' || Buffer.isBuffer(data))) throw new Error('frame');
      if (Buffer.byteLength(data) > MAX_PAYLOAD_BYTES) {
        counters.malformedFrames += 1;
        disconnect(slot);
        scheduleReconnect(slot);
        return;
      }
      frame = JSON.parse(data.toString());
      if (!record(frame) || typeof frame.type !== 'string') throw new Error('frame');
    } catch {
      counters.malformedFrames += 1;
      return;
    }
    if (frame.type === 'error') {
      const fatal = Object.hasOwn(FATAL_ERRORS, frame.code) ? FATAL_ERRORS[frame.code] : null;
      if (fatal) { block(fatal); return; }
      const eventId = positiveEventId(frame.event_id);
      if (eventId && slot.desired.has(eventId)) {
        slot.acknowledged.delete(eventId);
        slot.subscriptionGenerations.delete(eventId);
        slot.rejected.add(eventId);
      }
      counters.ignoredFrames += 1;
      return;
    }
    const eventId = positiveEventId(frame.event_id);
    if (!eventId || !slot.desired.has(eventId)) { counters.ignoredFrames += 1; return; }
    if (frame.type === 'subscribed') {
      if (!['basic', 'full'].includes(frame.source) || !validEvent(frame.event, eventId)
        || slot.acknowledged.has(eventId)) { counters.ignoredFrames += 1; return; }
      slot.acknowledged.set(eventId, frame.source);
      slot.subscriptionGenerations.set(eventId, ++slot.nextSubscriptionGeneration);
      slot.rejected.delete(eventId);
      slot.reconnectAttempt = 0;
      lastFailureReason = null;
      enqueue(slot, socket, connectionGeneration, frame, true);
      return;
    }
    if (frame.type === 'unsubscribed') {
      slot.acknowledged.delete(eventId);
      slot.subscriptionGenerations.delete(eventId);
      return;
    }
    if (!slot.acknowledged.has(eventId)) { counters.ignoredFrames += 1; return; }
    if (frame.type === 'event') {
      if (!validEvent(frame, eventId)) { counters.malformedFrames += 1; return; }
      enqueue(slot, socket, connectionGeneration, frame, false);
      return;
    }
    if (frame.type === 'action' && slot.acknowledged.get(eventId) === 'full'
      && ELIGIBLE_ACTION_TYPES.has(frame.action_type) && validScore(frame.score)
      && Number.isSafeInteger(frame.ts) && frame.ts > 0) {
      enqueue(slot, socket, connectionGeneration, frame, false);
      return;
    }
    // Only temp_goal is forwarded as a provisional state hint. It is never a
    // settled alert; the caller must pass it to the score projection first.
    // History, other provisional actions, positional data and odds are ignored.
    counters.ignoredFrames += 1;
  }

  function connect(slot) {
    if (!running || blockedReason || !slot.desired.size || slot.socket || slot.reconnectTimer !== null) return;
    let socket;
    try {
      socket = new Socket(FOOTBALL_ENDPOINT, ['token', apiToken], {
        maxPayload: MAX_PAYLOAD_BYTES,
        perMessageDeflate: false,
        handshakeTimeout: 10000,
        autoPong: true
      });
    } catch {
      scheduleReconnect(slot);
      return;
    }
    slot.socket = socket;
    const connectionGeneration = ++slot.generation;
    socket.on('open', () => {
      if (!current(slot, socket, connectionGeneration)) return;
      for (const eventId of slot.desired) {
        if (!send(slot, { action: 'subscribe', event_id: eventId })) break;
      }
    });
    socket.on('message', (data, isBinary) => message(slot, socket, connectionGeneration, data, isBinary));
    socket.on('close', (code) => {
      if (!current(slot, socket, connectionGeneration)) return;
      const fatal = Object.hasOwn(FATAL_CLOSE_CODES, code) ? FATAL_CLOSE_CODES[code] : null;
      if (fatal) { block(fatal); return; }
      slot.socket = null;
      slot.acknowledged.clear();
      slot.subscriptionGenerations.clear();
      slot.generation += 1;
      scheduleReconnect(slot);
    });
    socket.on('error', () => {
      // Do not pass ws exception text to logging or callbacks: it may include the key.
      if (!current(slot, socket, connectionGeneration)) return;
      disconnect(slot);
      scheduleReconnect(slot);
    });
  }

  function updateSubscriptions(values = []) {
    const normalized = new Set();
    invalidSubscriptionCount = 0;
    if (!Array.isArray(values) && !(values instanceof Set)) values = [];
    for (const value of values) {
      const eventId = positiveEventId(value);
      if (eventId) normalized.add(eventId);
      else invalidSubscriptionCount += 1;
    }
    const ordered = [...normalized].sort((a, b) => a - b);
    const capacity = maxSockets * MAX_SUBSCRIPTIONS_PER_SOCKET;
    capacityExceededCount = Math.max(0, ordered.length - capacity);
    desiredIds = ordered.slice(0, capacity);
    slots.forEach((slot, index) => {
      const next = new Set(desiredIds.slice(index * MAX_SUBSCRIPTIONS_PER_SOCKET,
        (index + 1) * MAX_SUBSCRIPTIONS_PER_SOCKET));
      const previous = slot.desired;
      slot.desired = next;
      for (const eventId of previous) {
        if (next.has(eventId)) continue;
        slot.acknowledged.delete(eventId);
        slot.subscriptionGenerations.delete(eventId);
        slot.rejected.delete(eventId);
        if (running) send(slot, { action: 'unsubscribe', event_id: eventId });
      }
      if (!next.size) { disconnect(slot); return; }
      if (!running) return;
      if (!slot.socket) { connect(slot); return; }
      if (slot.socket.readyState === 1) {
        for (const eventId of next) {
          if (!previous.has(eventId) && !send(slot, { action: 'subscribe', event_id: eventId })) break;
        }
      }
    });
    return getStatus();
  }

  function start(eventIds) {
    if (eventIds !== undefined) updateSubscriptions(eventIds);
    if (running) return getStatus();
    if (!apiToken || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(apiToken) || apiToken.length > 1024) {
      blockedReason = 'auth';
      return getStatus();
    }
    blockedReason = null;
    lastFailureReason = null;
    running = true;
    generation += 1;
    for (const slot of slots) {
      slot.reconnectAttempt = 0;
      slot.rejected.clear();
      connect(slot);
    }
    return getStatus();
  }

  function stop() {
    running = false;
    generation += 1;
    queue.length = 0;
    seen.clear();
    if (drainTimer !== null) cancel(drainTimer);
    drainTimer = null;
    for (const slot of slots) disconnect(slot);
    return getStatus();
  }

  function getStatus() {
    return {
      running, blocked: Boolean(blockedReason), blockedReason, lastFailureReason,
      maxSockets,
      connectedSockets: slots.filter((slot) => slot.socket?.readyState === 1).length,
      reconnectingSockets: slots.filter((slot) => slot.reconnectTimer !== null).length,
      subscriptionCount: desiredIds.length,
      acknowledgedCount: slots.reduce((total, slot) => total + slot.acknowledged.size, 0),
      basicCoverageCount: slots.reduce((total, slot) => total
        + [...slot.acknowledged.values()].filter((source) => source === 'basic').length, 0),
      fullCoverageCount: slots.reduce((total, slot) => total
        + [...slot.acknowledged.values()].filter((source) => source === 'full').length, 0),
      rejectedCount: slots.reduce((total, slot) => total + slot.rejected.size, 0),
      capacityExceededCount, invalidSubscriptionCount,
      queuedFrames: queue.length, seenCount: seen.size, callbackActive,
      ...counters
    };
  }

  return { start, updateSubscriptions, stop, getStatus };
}

module.exports = { createBsdLiveStreamService, FOOTBALL_ENDPOINT, MAX_PAYLOAD_BYTES };
