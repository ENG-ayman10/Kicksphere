'use strict';

const { createBsdLiveStreamService } = require('./bsdLiveStreamService');
const { createBsdStreamProjection } = require('../utils/bsdStreamProjection');
const { matchIdentityIds, teamIdentityIds } = require('../utils/matchProviderIdentities');

const ACTIVE_STATUSES = new Set(['IN_PLAY', 'PAUSED']);
const REFRESH_HINTS = new Set(['timeline', 'lineups', 'match_status', 'score_reconciliation']);
const MAX_TRUSTED_MATCHES = 500;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotRows(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (!record(snapshot) || snapshot.success !== true || snapshot.source === 'unavailable'
    || snapshot.coverage?.available === false || snapshot.stale === true
    || snapshot.liveSnapshotStale === true || !Array.isArray(snapshot.data)) return null;
  return snapshot.data;
}

function eventIdOf(match) {
  const id = match?.id;
  if (typeof id !== 'string' || !/^bsd_[1-9]\d{0,14}$/.test(id)) return null;
  const eventId = Number(id.slice(4));
  return Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null;
}

/** Connect verified REST identities to opted-in stream subscriptions only. */
function createBsdStreamCoordinator(options = {}) {
  const enabled = options.enabled === true;
  const maxSockets = Number.isInteger(options.maxSockets)
    ? Math.max(1, Math.min(4, options.maxSockets)) : 2;
  const capacity = maxSockets * 10;
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const transportFactory = options.transportFactory || createBsdLiveStreamService;
  const projectionFactory = options.projectionFactory || createBsdStreamProjection;
  const emitUpdate = typeof options.emitUpdate === 'function' ? options.emitUpdate : async () => {};
  const refreshDetails = typeof options.refreshDetails === 'function' ? options.refreshDetails : null;
  const onBoardUpdate = typeof options.onBoardUpdate === 'function' ? options.onBoardUpdate : null;
  const audienceRefreshMs = Number.isInteger(options.audienceRefreshMs)
    ? Math.max(250, Math.min(60000, options.audienceRefreshMs)) : 2000;
  const entries = new Map();
  const selected = new Set();
  const pendingRefresh = new Map();
  const activeRefresh = new Map();
  const lastRefreshAt = new Map();
  let transport = null;
  let running = false;
  let generation = 0;
  let audienceIds = new Set();
  let audienceInFlight = null;
  let lastAudienceSignature = '';
  let lastAudienceAt = -Infinity;
  let audienceDirty = false;
  let refreshDrainScheduled = false;
  let refreshCooldownTimer = null;
  const counters = {
    snapshots: 0, rejectedSnapshots: 0, rejectedMatches: 0, audienceQueries: 0,
    audienceErrors: 0, baselineCallbacks: 0, frameCallbacks: 0, rejectedBaselines: 0,
    acceptedUpdates: 0, rejectedFrames: 0, callbackErrors: 0, boardErrors: 0,
    refreshRequests: 0, refreshErrors: 0, droppedRefreshes: 0
  };

  function currentEntry(frame, meta) {
    if (!running || !record(frame) || !record(meta) || typeof meta.generationId !== 'string'
      || !Number.isSafeInteger(meta.eventId) || frame.event_id !== meta.eventId) return null;
    if (meta.subscriptionGeneration !== undefined && (!Number.isSafeInteger(meta.subscriptionGeneration)
      || meta.subscriptionGeneration < 1)) return null;
    const entry = entries.get(`bsd_${meta.eventId}`);
    return entry && selected.has(entry.match.id) ? entry : null;
  }

  function hasAlertRoom(match) {
    const rooms = options.io?.sockets?.adapter?.rooms;
    if (!rooms || typeof rooms.get !== 'function') return false;
    return matchIdentityIds(match).some((id) => Number(rooms.get(`matchAlerts_${id}`)?.size) > 0);
  }

  function hasAudience(match) {
    return matchIdentityIds(match).some((id) => audienceIds.has(id)) || hasAlertRoom(match);
  }

  function applySelection() {
    if (!running || !transport) return;
    for (const id of selected) {
      if (!entries.has(id) || !hasAudience(entries.get(id).match)) {
        if (entries.has(id)) entries.get(id).baselineReady = false;
        selected.delete(id);
      }
    }
    const ordered = [...entries.values()].filter((entry) => hasAudience(entry.match))
      .sort((left, right) => left.eventId - right.eventId);
    for (const entry of ordered) {
      if (selected.size >= capacity) break;
      selected.add(entry.match.id);
    }
    transport.updateSubscriptions([...selected].map((id) => entries.get(id).eventId));
  }

  function audienceSignature() {
    return JSON.stringify([...entries.values()].map((entry) => [entry.match.id,
      matchIdentityIds(entry.match), teamIdentityIds(entry.match)]));
  }

  function discoverAudience() {
    if (!running || !entries.size || typeof options.deviceService?.getAlertMatchIds !== 'function') return;
    const signature = audienceSignature();
    if (audienceInFlight) {
      if (audienceInFlight.signature !== signature) audienceDirty = true;
      return;
    }
    if (signature === lastAudienceSignature && clock() - lastAudienceAt < audienceRefreshMs) return;
    lastAudienceSignature = signature;
    lastAudienceAt = clock();
    audienceDirty = false;
    const ownGeneration = generation;
    const rows = [...entries.values()].map((entry) => structuredClone(entry.match));
    const operation = { signature, promise: null };
    audienceInFlight = operation;
    counters.audienceQueries += 1;
    operation.promise = Promise.resolve().then(() => options.deviceService.getAlertMatchIds(rows))
      .then((ids) => {
        if (!running || generation !== ownGeneration) return;
        audienceIds = new Set((ids instanceof Set || Array.isArray(ids) ? [...ids] : [])
          .filter((id) => typeof id === 'string' && id.length <= 120).slice(0, MAX_TRUSTED_MATCHES * 3));
        applySelection();
      }).catch(() => {
        if (running && generation === ownGeneration) counters.audienceErrors += 1;
      }).finally(() => {
        if (audienceInFlight !== operation) return;
        audienceInFlight = null;
        if (running && (audienceDirty || generation !== ownGeneration)) discoverAudience();
      });
  }

  function scheduleRefreshDrain() {
    if (!running || !refreshDetails || refreshDrainScheduled) return;
    refreshDrainScheduled = true;
    const ownGeneration = generation;
    Promise.resolve().then(() => {
      refreshDrainScheduled = false;
      if (!running || generation !== ownGeneration) return;
      let earliestCooldown = Infinity;
      for (const [id, hints] of pendingRefresh) {
        if (activeRefresh.size >= 2) break;
        if (activeRefresh.has(id)) continue;
        if (!entries.has(id) || !selected.has(id)) { pendingRefresh.delete(id); continue; }
        const cooldown = 1000 - (clock() - (lastRefreshAt.get(id) ?? -Infinity));
        if (cooldown > 0) {
          earliestCooldown = Math.min(earliestCooldown, cooldown);
          continue;
        }
        pendingRefresh.delete(id);
        const operation = { generation: ownGeneration, hints: [...hints] };
        activeRefresh.set(id, operation);
        lastRefreshAt.set(id, clock());
        counters.refreshRequests += 1;
        const trustedEntry = entries.get(id);
        Promise.resolve().then(() => {
          if (running && generation === ownGeneration && entries.get(id) === trustedEntry
            && selected.has(id)) return refreshDetails(id, operation.hints);
        }).catch(() => {
          if (running && generation === ownGeneration) counters.refreshErrors += 1;
        }).finally(() => {
          if (activeRefresh.get(id) === operation) activeRefresh.delete(id);
          if (running) scheduleRefreshDrain();
        });
      }
      if (Number.isFinite(earliestCooldown) && refreshCooldownTimer === null) {
        refreshCooldownTimer = schedule(() => {
          refreshCooldownTimer = null;
          if (running && generation === ownGeneration) scheduleRefreshDrain();
        }, Math.max(1, earliestCooldown));
        refreshCooldownTimer?.unref?.();
      }
    });
  }

  function requestRefresh(entry, hints) {
    if (!refreshDetails || !Array.isArray(hints) || !running || !selected.has(entry.match.id)) return;
    const valid = hints.filter((hint) => REFRESH_HINTS.has(hint));
    if (!valid.length) return;
    const id = entry.match.id;
    if (!pendingRefresh.has(id) && pendingRefresh.size >= capacity) {
      counters.droppedRefreshes += 1;
      return;
    }
    const merged = pendingRefresh.get(id) || new Set();
    valid.forEach((hint) => merged.add(hint));
    pendingRefresh.set(id, merged);
    scheduleRefreshDrain();
  }

  async function deliverProjection(entry, projection, meta, baseline) {
    requestRefresh(entry, projection.refreshHints);
    if (!projection.accepted || !projection.match || (!baseline && !projection.changed && !projection.incident)) return false;
    const ownGeneration = generation;
    const update = {
      match: projection.match, baseline,
      receivedAt: Number.isFinite(meta.receivedAtMs) ? meta.receivedAtMs : clock(),
      generationId: meta.generationId,
      ...(!baseline && projection.incident ? { incident: projection.incident } : {})
    };
    if (await emitUpdate(update) === false) {
      if (baseline) entry.baselineReady = false;
      counters.callbackErrors += 1;
      return false;
    }
    if (!running || generation !== ownGeneration || entries.get(entry.match.id) !== entry) return true;
    counters.acceptedUpdates += 1;
    if (onBoardUpdate) Promise.resolve().then(() => {
      if (running && generation === ownGeneration && entries.get(entry.match.id) === entry) {
        return onBoardUpdate(structuredClone(projection.match));
      }
    }).catch(() => {
      if (running && generation === ownGeneration) counters.boardErrors += 1;
    });
    return true;
  }

  async function onSnapshot(frame, meta) {
    const entry = currentEntry(frame, meta);
    if (!entry) { counters.rejectedBaselines += 1; return false; }
    counters.baselineCallbacks += 1;
    try {
      const subscriptionGeneration = `${meta.generationId}:${meta.subscriptionGeneration ?? 0}`;
      if (entry.transportGeneration !== subscriptionGeneration) {
        entry.transportGeneration = subscriptionGeneration;
        entry.projectionGeneration = entry.projection.beginGeneration();
      }
      const projected = entry.projection.project(frame, { generation: entry.projectionGeneration });
      if (!projected.accepted || projected.baseline !== true) {
        entry.baselineReady = false;
        counters.rejectedBaselines += 1;
        requestRefresh(entry, projected.refreshHints);
        return false;
      }
      entry.baselineReady = true;
      return await deliverProjection(entry, projected, meta, true);
    } catch {
      entry.baselineReady = false;
      counters.callbackErrors += 1;
      return false;
    }
  }

  async function onFrame(frame, meta) {
    const entry = currentEntry(frame, meta);
    if (!entry || !entry.baselineReady || entry.transportGeneration
      !== `${meta.generationId}:${meta.subscriptionGeneration ?? 0}`) {
      counters.rejectedFrames += 1;
      return false;
    }
    counters.frameCallbacks += 1;
    try {
      const projected = entry.projection.project(frame, { generation: entry.projectionGeneration });
      if (!projected.accepted) counters.rejectedFrames += 1;
      return await deliverProjection(entry, projected, meta, false);
    } catch {
      counters.callbackErrors += 1;
      return false;
    }
  }

  function observeSnapshot(snapshot) {
    if (!enabled) return false;
    const rows = snapshotRows(snapshot);
    if (!rows) { counters.rejectedSnapshots += 1; return false; }
    counters.snapshots += 1;
    const retained = new Set();
    for (const match of rows.slice(0, MAX_TRUSTED_MATCHES * 3)) {
      const eventId = eventIdOf(match);
      if (!eventId || !ACTIVE_STATUSES.has(match.status) || match.liveWebsocket !== true
        || match.liveSnapshotStale === true || match.stale === true
        || !['bsd'].includes(match.provider || match.source)) {
        counters.rejectedMatches += 1;
        continue;
      }
      let entry = entries.get(match.id);
      if (!entry && entries.size >= MAX_TRUSTED_MATCHES) { counters.rejectedMatches += 1; continue; }
      if (!entry) {
        entry = {
          match: null, eventId, projection: projectionFactory({ now: clock, maxMatches: 1 }),
          transportGeneration: null, projectionGeneration: null, baselineReady: false
        };
      }
      try {
        if (!entry.projection.upsert(match)) { counters.rejectedMatches += 1; continue; }
        entry.match = structuredClone(match);
        entries.set(match.id, entry);
        retained.add(match.id);
      } catch { counters.rejectedMatches += 1; }
    }
    for (const id of entries.keys()) if (!retained.has(id)) {
      entries.delete(id);
      selected.delete(id);
      pendingRefresh.delete(id);
      lastRefreshAt.delete(id);
    }
    if (running) {
      applySelection();
      discoverAudience();
      scheduleRefreshDrain();
    }
    return true;
  }

  function start() {
    if (!enabled || running) return getStatus();
    running = true;
    generation += 1;
    try {
      const ownGeneration = generation;
      transport = transportFactory({ apiToken: options.apiToken, maxSockets, now: clock,
        onSnapshot: (frame, meta) => running && generation === ownGeneration ? onSnapshot(frame, meta) : false,
        onFrame: (frame, meta) => running && generation === ownGeneration ? onFrame(frame, meta) : false });
      transport.start([]);
      applySelection();
      discoverAudience();
    } catch {
      running = false;
      counters.callbackErrors += 1;
      try { transport?.stop(); } catch { /* Only sanitized counters are exposed. */ }
      transport = null;
    }
    return getStatus();
  }

  function stop() {
    running = false;
    generation += 1;
    transport?.stop();
    entries.clear();
    selected.clear();
    pendingRefresh.clear();
    if (refreshCooldownTimer !== null) cancel(refreshCooldownTimer);
    refreshCooldownTimer = null;
    lastRefreshAt.clear();
    audienceIds.clear();
    lastAudienceSignature = '';
    lastAudienceAt = -Infinity;
    return getStatus();
  }

  function getStatus() {
    const raw = transport?.getStatus() || {};
    const reason = ['auth', 'sub-required', 'network'].includes(raw.blockedReason) ? raw.blockedReason : null;
    const transportStatus = {};
    for (const key of ['connectedSockets', 'reconnectingSockets', 'acknowledgedCount', 'basicCoverageCount',
      'fullCoverageCount', 'queuedFrames', 'seenCount', 'droppedFrames', 'callbackErrors', 'reconnects']) {
      transportStatus[key] = Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : 0;
    }
    const eligibleCount = [...entries.values()].filter((entry) => hasAudience(entry.match)).length;
    return {
      enabled, running, blocked: raw.blocked === true, blockedReason: reason,
      maxSockets, capacity, trustedMatchCount: entries.size, selectedCount: selected.size,
      overflowCount: Math.max(0, eligibleCount - selected.size), audienceInFlight: Boolean(audienceInFlight),
      pendingRefreshCount: pendingRefresh.size, activeRefreshCount: activeRefresh.size,
      transport: transportStatus, ...counters
    };
  }

  return { start, stop, observeSnapshot, getStatus };
}

module.exports = { createBsdStreamCoordinator };
