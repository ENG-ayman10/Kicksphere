/**
 * Detect observed match transitions without replaying historical events.
 * The live feed stays live-only; today's fixtures establish scheduled states,
 * and bounded detail lookups follow active games that disappear from that feed.
 */
const db = require('../config/firebase');
const sportscoreService = require('./sportscoreService');
const sportsDataService = require('./sportsDataService');
const bsdSportsService = require('./bsdSportsService');
const kickoffApiService = require('./kickoffApiService');
const { saveNotification } = require('./notificationService');
const { sendPushNotification, buildEventNotification } = require('./pushNotificationService');
const notificationDevices = require('./notificationDeviceService');
const { createHash } = require('node:crypto');
const logger = require('../utils/logger');
const { matchRoom, teamRoom, userRoom } = require('../utils/socketRooms');
const { matchTeamId } = require('../utils/teamIdentity');
const { createLiveRecipientPolicy } = require('../utils/liveDeliveryScope');
const { normalizeProviderTimestamp } = require('../utils/providerTimestamp');
const { validatedProviderIdentities, matchIdentityIds, teamIdentityIds } = require('../utils/matchProviderIdentities');
const { reminderDue, upcomingAlertCandidate, kickoffNotificationFresh, lineupNotificationRelevant, matchPhase, PHASE_EVENTS, PHASE_ORDER,
  lineupState, incidentKey, incidentAlert, incidentFields } = require('../utils/notificationEventTransitions');
const { eventCategoryEnabled } = require('../utils/notificationContracts');

const MAX_TRACKED_MATCHES = 500;
const MAX_PROCESSED_EVENTS = 10000;
const MAX_DETAIL_REQUESTS = 6;
const RECIPIENT_PAGE_SIZE = 200;
const STATE_TTL = 6 * 60 * 60 * 1000;
const FIXTURE_REFRESH_INTERVAL_MS = 60 * 1000;
const DETAIL_OVERRIDE_TTL_MS = 3 * 60 * 1000;
const activeStatuses = new Set(['IN_PLAY', 'PAUSED']);
const scheduledStatuses = new Set(['TIMED', 'SCHEDULED']);

async function mapConcurrent(items, limit, action) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await action(items[cursor++]);
  }));
}

const scoreValue = value => value === null || value === undefined || value === ''
  ? null : (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
const sourceTime = value => Date.parse(normalizeProviderTimestamp(value) || '');

// Factory keeps state isolated in offline tests; the exported poller is a singleton.
function createLiveEventsEmitter(options = {}) {
  const deviceService = options.notificationDevices || notificationDevices;
  const recipientAllowed = options.recipientAllowed || createLiveRecipientPolicy();
  const restrictSocketAlerts = options.restrictSocketAlerts === true || process.env.LOCAL_LIVE_PUSH_USER_IDS !== undefined;
  const bsdEnabled = typeof bsdSportsService.isConfigured === 'function' && bsdSportsService.isConfigured();
  const provider = options.provider || (bsdEnabled ? sportsDataService : sportscoreService);
  const readDetail = options.getMatchDetails || (async (id, { includeTimeline = false, includeLineups = false } = {}) => {
    if (/^bsd_[1-9]\d*$/.test(id)) {
      if (typeof bsdSportsService.getMatchAlertDetails === 'function') {
        return bsdSportsService.getMatchAlertDetails(id, { includeTimeline, includeLineups });
      }
      const [summary, incidents] = await Promise.all([
        bsdSportsService.getMatchSummary(id),
        includeTimeline && typeof bsdSportsService.getMatchTimeline === 'function'
          ? bsdSportsService.getMatchTimeline(id) : null
      ]);
      const match = summary?.matchInfo || summary?.data || summary;
      const timeline = Array.isArray(incidents) ? incidents : incidents?.data || incidents?.timeline;
      return match ? { ...match, ...(Array.isArray(timeline) ? { timeline } : {}) } : null;
    }
    if (/^ko_[1-9]\d*$/.test(id)) return kickoffApiService.getMatchDetails(id);
    return sportscoreService.getMatchDetails(id);
  });
  const previousMatches = new Map();
  const previousIncidents = new Map();
  const processedEvents = new Map();
  const detailChecks = new Map();
  const clock = options.now || Date.now;
  const fixtureRefreshIntervalMs = options.fixtureRefreshIntervalMs ?? FIXTURE_REFRESH_INTERVAL_MS;
  let fixtureSnapshot = [];
  let fixtureRead = null;
  let fixtureReadAt = -Infinity;
  let fixtureDay = null;
  let retryFlush = null;
  let running = false;
  let queuedCycle = null;
  let backgroundDetails = null;
  const streamCycles = [];
  const requestedDetails = new Set();
  const streamLeaseMs = 60000;
  const nonBlockingDetails = options.nonBlockingDetails === true;
  const asynchronousDelivery = options.asynchronousDelivery === true;

  const snapshotRows = snapshot => Array.isArray(snapshot) ? snapshot : snapshot?.success === true &&
    snapshot.coverage?.available !== false && snapshot.source !== 'unavailable' && Array.isArray(snapshot.data)
    ? snapshot.data : null;

  const seedScheduledFixtures = (now, newlyObservedActive = new Set()) => {
    for (const match of fixtureSnapshot) {
      const id = match?.id && String(match.id);
      if (!id || !scheduledStatuses.has(match.status) ||
          (previousMatches.has(id) && !scheduledStatuses.has(previousMatches.get(id).status))) continue;
      if (!previousMatches.has(id) && newlyObservedActive.has(id)) continue;
      if (!previousMatches.has(id) && previousMatches.size >= MAX_TRACKED_MATCHES) continue;
      previousMatches.set(id, { ...previousMatches.get(id), status: match.status,
        home: scoreValue(match.score?.fullTime?.home), away: scoreValue(match.score?.fullTime?.away),
        seenAt: now });
    }
  };

  const refreshFixtures = now => {
    const day = new Date(now).toISOString().slice(0, 10);
    if (fixtureDay !== day) { fixtureSnapshot = []; fixtureDay = day; fixtureReadAt = -Infinity; }
    if (fixtureRead || now - fixtureReadAt < fixtureRefreshIntervalMs) return;
    fixtureReadAt = now;
    // A calendar read can fan out across several slow providers. Keep it outside
    // the live cycle, and never let a late scheduled row overwrite live state.
    const tomorrow = new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const nextMidnight = Date.parse(`${tomorrow}T00:00:00Z`);
    const days = nextMidnight - now <= 90 * 60 * 1000 ? [day, tomorrow] : [day];
    fixtureRead = Promise.resolve().then(() => Promise.allSettled(days.map(date => provider.getMatchesByDate(date)))).then(snapshots => {
      const rows = snapshots.flatMap(snapshot => snapshot.status === 'fulfilled' ? snapshotRows(snapshot.value) || [] : []);
      if (snapshots.some(snapshot => snapshot.status === 'fulfilled' && snapshotRows(snapshot.value)) && fixtureDay === day) {
        fixtureSnapshot = [...new Map(rows.filter(match => match?.id).map(match => [String(match.id), match])).values()];
        if (!running) seedScheduledFixtures(clock());
      }
    }).catch(() => { logger.warn('Scheduled fixture snapshot unavailable.'); }).finally(() => { fixtureRead = null; });
  };

  const forget = id => {
    previousMatches.delete(id);
    previousIncidents.delete(id);
    detailChecks.delete(id);
  };

  async function emitLiveEvents(io, cycle = {}) {
    if (Array.isArray(cycle.requestedDetailIds)) for (const id of cycle.requestedDetailIds.slice(0, MAX_DETAIL_REQUESTS)) {
      if (typeof id === 'string' && /^bsd_[1-9]\d{0,14}$/.test(id) && previousMatches.has(id) &&
          requestedDetails.size < MAX_TRACKED_MATCHES) requestedDetails.add(id);
    }
    if (running) {
      // Stream callbacks await their exact delta. Do not coalesce a reconnect
      // baseline away or collapse goal -> cancellation -> new goal into one.
      if (cycle.streamOnly === true) {
        if (streamCycles.length >= 128) return false;
        return new Promise(resolve => streamCycles.push({ io, cycle, resolve }));
      }
      // A slow legacy inbox read must never discard the latest score sample.
      // Coalesce queued source snapshots while retaining every completed detail.
      const completedDetails = new Map([...(queuedCycle?.completedDetails || []), ...(cycle.completedDetails || [])]);
      const queuedSource = queuedCycle && Object.hasOwn(queuedCycle, 'liveSnapshot') && queuedCycle.detailsOnly !== true;
      const incomingSource = Object.hasOwn(cycle, 'liveSnapshot') && cycle.detailsOnly !== true;
      const next = { ...queuedCycle, ...cycle, ...(completedDetails.size ? { completedDetails } : {}) };
      if (queuedSource && !incomingSource) {
        next.liveSnapshot = queuedCycle.liveSnapshot;
        next.includeDetails = queuedCycle.includeDetails;
        delete next.detailsOnly;
      } else if (incomingSource) delete next.detailsOnly;
      queuedCycle = next;
      return;
    }
    running = true;
    try {
      const now = clock();
      const overrideTtlMs = cycle.detailOverrideTtlMs ?? options.detailOverrideTtlMs ?? DETAIL_OVERRIDE_TTL_MS;
      if (!retryFlush) {
        retryFlush = Promise.resolve().then(() => deviceService.flushRetries?.())
          .catch(() => { logger.warn('Pending push retry processing failed.'); })
          .finally(() => { retryFlush = null; });
      }
      for (const [id, state] of previousMatches) {
        if (now - state.seenAt > STATE_TTL) forget(id);
      }
      for (const [id, time] of processedEvents) {
        if (now - time > STATE_TTL) processedEvents.delete(id);
      }

      if (cycle.streamOnly !== true) refreshFixtures(now);
      const live = await Promise.resolve().then(() => cycle.streamOnly === true ? [] : cycle.detailsOnly === true
        ? [...previousMatches.values()].map(state => state.observedMatch).filter(Boolean)
        : Object.hasOwn(cycle, 'liveSnapshot') ? cycle.liveSnapshot : provider.getLiveMatches())
        .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
      const liveRows = live.status === 'fulfilled' ? snapshotRows(live.value) : null;
      if (cycle.streamOnly !== true) seedScheduledFixtures(now, new Set((liveRows || [])
        .filter(match => activeStatuses.has(match.status)).map(match => String(match.id))));
      const matches = new Map();
      const detailOverrides = new Set();
      const renewedOverrides = new Set();
      const uncertainBaselines = new Set();
      for (const result of [{ status: 'fulfilled', value: cycle.streamOnly === true ? [] : fixtureSnapshot }, live]) {
        const snapshot = result.status === 'fulfilled' ? result.value : null;
        const rows = snapshotRows(snapshot);
        if (Array.isArray(rows)) {
          for (const match of rows) if (match?.id) {
            const id = String(match.id);
            const previous = previousMatches.get(id);
            if (match.liveSnapshotStale === true) {
              if (previous?.observedMatch) matches.set(id, previous.observedMatch);
              if (previous?.detailOverride) detailOverrides.add(id);
              continue;
            }
            const fromCalendar = snapshot === fixtureSnapshot;
            const incomingTime = sourceTime(match.lastUpdated);
            const previousTime = sourceTime(previous?.observedMatch?.lastUpdated);
            const olderSnapshot = Number.isFinite(incomingTime) && Number.isFinite(previousTime) && incomingTime < previousTime;
            const newerSnapshot = Number.isFinite(incomingTime) &&
              (!Number.isFinite(previousTime) || incomingTime > previousTime);
            const priorScore = previous?.observedMatch?.score?.fullTime;
            const incomingScore = match.score?.fullTime;
            const differsFromDetail = previous?.detailOverride && priorScore &&
              (scoreValue(incomingScore?.home) !== scoreValue(priorScore.home) ||
                scoreValue(incomingScore?.away) !== scoreValue(priorScore.away) || match.status !== previous.status);
            const differsFromStream = previous?.streamLeaseExpiresAt && priorScore &&
              (scoreValue(incomingScore?.home) !== scoreValue(priorScore.home) ||
                scoreValue(incomingScore?.away) !== scoreValue(priorScore.away) || match.status !== previous.status);
            if (differsFromStream && now < previous.streamLeaseExpiresAt && previous.observedMatch) {
              matches.set(id, previous.observedMatch);
              continue;
            }
            if (differsFromStream && now >= previous.streamLeaseExpiresAt && !newerSnapshot) uncertainBaselines.add(id);
            // A retained daily fixture is useful for scheduling, but cannot
            // roll an already observed score back while the live feed omits it.
            const incoming = { ...match,
              providerIdentities: match.providerIdentities || matches.get(id)?.providerIdentities || previous?.observedMatch?.providerIdentities };
            const identities = validatedProviderIdentities(incoming);
            if (identities.length) incoming.providerIdentities = identities;
            else delete incoming.providerIdentities;
            const leaseActive = previous?.detailOverride &&
              now < (previous.detailOverrideExpiresAt ?? now + overrideTtlMs);
            const retainDetail = !fromCalendar && differsFromDetail && !newerSnapshot && leaseActive;
            // Without source clocks, an expired conflicting list cannot prove
            // a new goal or cancellation. Rebase silently rather than freeze
            // forever or replay a previously cancelled goal as a fresh event.
            if (!fromCalendar && differsFromDetail && !newerSnapshot && !olderSnapshot && !leaseActive) uncertainBaselines.add(id);
            if (retainDetail || (previous?.detailOverride && (olderSnapshot || (!newerSnapshot && fromCalendar)))) detailOverrides.add(id);
            else if (!fromCalendar) detailOverrides.delete(id);
            matches.set(id, previous?.observedMatch && (olderSnapshot || retainDetail || (fromCalendar && activeStatuses.has(match.status)))
              ? previous.observedMatch : incoming);
          }
        } else if (result.status === 'rejected') {
          logger.warn(`Live snapshot unavailable: ${result.reason?.message}`);
        }
      }

      const details = new Map();
      const collectDetails = async onCompleted => {
        const candidates = new Set();
        let deviceMatchIds = new Set();
        const observedActive = new Map([...matches].filter(([, match]) => activeStatuses.has(match.status) || upcomingAlertCandidate(match, now)));
        for (const [id, state] of previousMatches) if (activeStatuses.has(state.status) && !observedActive.has(id)) {
          observedActive.set(id, state.observedMatch || { id });
        }
        try {
          if (typeof deviceService.getAlertMatchIds === 'function') {
            deviceMatchIds = await deviceService.getAlertMatchIds([...observedActive.values()]);
          } else {
            const queriedIds = [...new Set([...observedActive.values()].flatMap(matchIdentityIds))].slice(0, MAX_TRACKED_MATCHES * 3);
            const subscribedIds = await deviceService.getSubscribedMatchIds(queriedIds);
            deviceMatchIds = new Set([...observedActive].filter(([, match]) =>
              matchIdentityIds(match).some(id => subscribedIds.has(id))).map(([id]) => id));
          }
        } catch (error) { logger.warn('Match push subscriptions unavailable.'); }
        const hasAlertRoom = id => matchIdentityIds(matches.get(id) || previousMatches.get(id)?.observedMatch || { id })
          .some(matchId => io.sockets.adapter.rooms.get(`matchAlerts_${matchId}`)?.size);
        // An empty live response is never evidence that a match has finished.
        const liveMatchIds = new Set((liveRows || []).map(match => String(match.id)));
        for (const [id, state] of previousMatches) {
          if (activeStatuses.has(state.status) && (!liveMatchIds.has(id) || scheduledStatuses.has(matches.get(id)?.status))) candidates.add(id);
        }
        for (const [id, match] of observedActive) {
          if (deviceMatchIds.has(id) || hasAlertRoom(id)) candidates.add(id);
        }
        for (const [id, match] of matches) {
          if (match.status === 'FINISHED' && activeStatuses.has(previousMatches.get(id)?.status) &&
              (deviceMatchIds.has(id) || hasAlertRoom(id))) candidates.add(id);
        }
        for (const id of requestedDetails) {
          if (observedActive.has(id) && (deviceMatchIds.has(id) || hasAlertRoom(id))) candidates.add(id);
          else requestedDetails.delete(id);
        }
        const lookups = [...candidates].sort((a, b) =>
          Number(requestedDetails.has(b)) - Number(requestedDetails.has(a)) ||
          Number(deviceMatchIds.has(b) || hasAlertRoom(b)) - Number(deviceMatchIds.has(a) || hasAlertRoom(a)) ||
          (detailChecks.get(a) || 0) - (detailChecks.get(b) || 0)).slice(0, MAX_DETAIL_REQUESTS);
        const completed = new Map();
        await mapConcurrent(lookups, 3, async id => {
          requestedDetails.delete(id);
          detailChecks.set(id, now);
          try {
            const includeTimeline = deviceMatchIds.has(id) || hasAlertRoom(id);
            const latest = previousMatches.get(id);
            const detail = await readDetail(id, { includeTimeline,
              includeLineups: includeTimeline && latest?.lineupConfirmed !== true &&
                lineupNotificationRelevant(latest?.observedMatch || matches.get(id), clock()) });
            if (detail && (!detail.id || String(detail.id) === id)) {
              if (onCompleted) await onCompleted(id, detail);
              else completed.set(id, detail);
            }
          } catch (_) { logger.warn(`Live detail unavailable for ${id}.`); }
        });
        return completed;
      };
      let completed = new Map(cycle.completedDetails || []);
      if (cycle.streamOnly !== true && cycle.includeDetails !== false) {
        if (!nonBlockingDetails) completed = new Map([...completed, ...await collectDetails()]);
        else if (!backgroundDetails) {
          // Network work never holds the score detector. Completions re-enter
          // its serialized source-clock guards against the newest observation.
          backgroundDetails = Promise.resolve().then(() => collectDetails((id, detail) =>
            emitLiveEvents(io, { includeDetails: false, completedDetails: new Map([[id, detail]]), detailsOnly: true })))
            .catch(() => { logger.warn('Live alert detail scheduling failed.'); }).finally(() => {
              backgroundDetails = null;
              if (requestedDetails.size) queueMicrotask(() => {
                void emitLiveEvents(io, { detailsOnly: true, includeDetails: true });
              });
            });
        }
      }
      for (const [id, detail] of completed) {
        if (detail && (!detail.id || String(detail.id) === id)) {
            const listed = matches.get(id) || previousMatches.get(id)?.observedMatch;
            const streamState = previousMatches.get(id);
            const streamConflict = streamState?.streamLeaseExpiresAt > now && listed &&
              (scoreValue(detail.score?.fullTime?.home) !== scoreValue(listed.score?.fullTime?.home) ||
                scoreValue(detail.score?.fullTime?.away) !== scoreValue(listed.score?.fullTime?.away) || detail.status !== listed.status);
            const detailTime = sourceTime(detail.lastUpdated);
            const listedTime = sourceTime(listed?.lastUpdated);
            const olderDetail = Number.isFinite(detailTime) && Number.isFinite(listedTime) && detailTime < listedTime;
            // Missing scoreboard fields do not invalidate an independently
            // verified fresh timeline or official-lineup response.
            if (!olderDetail) details.set(id, detail);
            // A lagging/missing summary score cannot undo the live stream, but
            // a fresh independently verified card/lineup must not wait for it.
            if (streamConflict) continue;
            const newerDetail = Number.isFinite(detailTime) &&
              (!Number.isFinite(listedTime) || detailTime >= listedTime);
            const detailHome = scoreValue(detail.score?.fullTime?.home);
            const detailAway = scoreValue(detail.score?.fullTime?.away);
            const listedHome = scoreValue(listed?.score?.fullTime?.home);
            const listedAway = scoreValue(listed?.score?.fullTime?.away);
            const scoreAdvances = detailHome !== null && detailAway !== null &&
              (listedHome === null || detailHome >= listedHome) &&
              (listedAway === null || detailAway >= listedAway);
            // Once a detail endpoint establishes a different score, an
            // un-timestamped live list may remain behind that endpoint. Re-read
            // the same detail source to accept real corrections in either
            // direction; the score is not a monotonic counter.
            const confirmedDetail = previousMatches.get(id)?.detailOverride &&
              !Number.isFinite(detailTime) && !Number.isFinite(listedTime);
            // The detail endpoint can be ahead of a cached active list. Keep the
            // subscribed identity, but reject older detail data and unverified
            // score regressions when neither endpoint exposes an update time.
            if (!listed || (!olderDetail && (detail.status === 'FINISHED' ||
                ['POSTPONED', 'CANCELLED'].includes(detail.status) ||
                (scheduledStatuses.has(detail.status) && scheduledStatuses.has(listed.status)) ||
                (activeStatuses.has(detail.status) && (scheduledStatuses.has(listed.status) ||
                  (activeStatuses.has(listed.status) && (newerDetail || scoreAdvances || confirmedDetail))))))) {
              matches.set(id, { ...listed, ...detail, id });
              details.set(id, detail);
              const differsFromList = detailHome !== listedHome || detailAway !== listedAway || detail.status !== listed?.status;
              if (differsFromList || detailOverrides.has(id)) detailOverrides.add(id);
              else detailOverrides.delete(id);
              const previous = previousMatches.get(id);
              if (detailOverrides.has(id) && (!previous?.detailOverride || detailHome !== previous.home ||
                  detailAway !== previous.away || detail.status !== previous.status)) renewedOverrides.add(id);
              // A due detail read resolves ambiguity from an expired lease.
              uncertainBaselines.delete(id);
            }
        }
      }

      const streamBaselines = new Set();
      const acceptedStreamUpdates = new Map();
      if (cycle.streamOnly === true && cycle.streamUpdates instanceof Map) {
        // This is a narrow, verified fixture delta, never a replacement board.
        matches.clear();
        for (const [id, update] of cycle.streamUpdates) {
          const match = update?.match;
          if (typeof id !== 'string' || !/^bsd_[1-9]\d{0,14}$/.test(id) || match?.id !== id || match.source !== 'bsd' ||
              match.provider !== 'bsd' || !/^bsd_t_[1-9]\d{0,14}$/.test(match.homeTeam?.id) ||
              !/^bsd_t_[1-9]\d{0,14}$/.test(match.awayTeam?.id) || match.homeTeam.id === match.awayTeam.id ||
              !normalizeProviderTimestamp(match.utcDate) || !Number.isSafeInteger(match.score?.fullTime?.home) ||
              !Number.isSafeInteger(match.score?.fullTime?.away) || match.score.fullTime.home < 0 ||
              match.score.fullTime.away < 0 || match.score.fullTime.home > 99 || match.score.fullTime.away > 99) continue;
          const previous = previousMatches.get(id);
          const known = previous?.observedMatch;
          if (!known && update.baseline !== true) continue;
          if (known && (known.homeTeam?.id !== match.homeTeam.id || known.awayTeam?.id !== match.awayTeam.id ||
              normalizeProviderTimestamp(known.utcDate) !== normalizeProviderTimestamp(match.utcDate))) continue;
          const incomingAt = sourceTime(match.lastUpdated), priorAt = sourceTime(known?.lastUpdated);
          if (Number.isFinite(incomingAt) && Number.isFinite(priorAt) && incomingAt < priorAt) continue;
          if (!Number.isFinite(update.receivedAt) || update.receivedAt > now + 1000 || now - update.receivedAt > streamLeaseMs) continue;
          matches.set(id, match);
          acceptedStreamUpdates.set(id, update);
          if (update.baseline === true) streamBaselines.add(id);
        }
      }

      const events = [];
      const record = (event, key) => {
        if (processedEvents.has(key)) return;
        processedEvents.set(key, now);
        events.push({ ...event, eventId: `evt_${createHash('sha256').update(key).digest('hex')}`, createdAt: new Date(now) });
      };

      for (const [id, match] of matches) {
        const previous = previousMatches.get(id);
        // A stale scheduled fixture cannot erase the baseline of an observed live game.
        if (previous && activeStatuses.has(previous.status) && scheduledStatuses.has(match.status)) continue;
        const home = scoreValue(match.score?.fullTime?.home);
        const away = scoreValue(match.score?.fullTime?.away);
        const homeTeam = match.homeTeam?.name || previous?.homeTeam || '';
        const awayTeam = match.awayTeam?.name || previous?.awayTeam || '';
        const matchProvider = match.source || (id.startsWith('bsd_') ? 'bsd' : id.startsWith('ko_') ? 'kickoffapi' : 'sportscore');
        // Each snapshot retains its provider identity. A
        // provider-scoped ID remains opaque; names never become subscription IDs.
        const homeId = matchTeamId(match.homeTeam, matchProvider) || previous?.homeId || null;
        const awayId = matchTeamId(match.awayTeam, matchProvider) || previous?.awayId || null;
        const score = `${home ?? '-'} - ${away ?? '-'}`;
        const lastUpdated = normalizeProviderTimestamp(match.lastUpdated);
        const phase = matchPhase(match);
        const matchLineups = details.get(id)?.lineups || match.lineups;
        const officialLineup = lineupState(matchLineups, match);
        const scoreChanged = previous && ((home !== null && previous.home !== null && home !== previous.home) ||
          (away !== null && previous.away !== null && away !== previous.away));
        const scoreRevision = (previous?.scoreRevision || 0) + (scoreChanged ? 1 : 0);
        const base = {
          matchId: id, team: homeTeam, against: awayTeam,
          teamId: homeId, againstTeamId: awayId, awayTeamId: awayId,
          homeTeamId: homeId, homeTeam: { id: homeId, name: homeTeam }, awayTeam: { id: awayId, name: awayTeam },
          score, scoreValues: { home, away }, provider: matchProvider,
          ...(normalizeProviderTimestamp(match.utcDate) ? { utcDate: normalizeProviderTimestamp(match.utcDate) } : {}),
          ...(lastUpdated ? { lastUpdated } : {}),
          tournament: match.competition?.name || '', minute: match.minute ?? null,
          ...(validatedProviderIdentities(match).length ? {
            providerIdentities: validatedProviderIdentities(match), utcDate: match.utcDate,
            competitionCode: match.competition?.code
          } : {})
        };
        if (!streamBaselines.has(id) && reminderDue(match, now)) {
          record({ ...base, type: 'matchReminder', reminderMinutes: 15 }, `${id}:reminder:15:${base.utcDate}`);
        }
        const lineupUpdatedAt = sourceTime(matchLineups?.updatedAt);
        const recentlyPublished = Number.isFinite(lineupUpdatedAt) && lineupUpdatedAt <= now && now - lineupUpdatedAt <= 2 * 60 * 1000;
        if (!streamBaselines.has(id) && officialLineup === true && lineupNotificationRelevant(match, now) && (previous?.lineupConfirmed === false ||
            (previous?.lineupConfirmed === undefined && upcomingAlertCandidate(match, now) && recentlyPublished))) {
          record({ ...base, type: 'lineup', lineupConfirmed: true }, `${id}:lineup:official`);
        }
        if (previous && !streamBaselines.has(id) && !uncertainBaselines.has(id)) {
          if (scheduledStatuses.has(previous.status) && activeStatuses.has(match.status) && kickoffNotificationFresh(match, now)) {
            record({ ...base, type: 'matchStart' }, `${id}:start`);
          }
          if (activeStatuses.has(previous.status) && match.status === 'FINISHED') {
            record({ ...base, type: 'matchEnd' }, `${id}:end`);
          }
          if ((scheduledStatuses.has(previous.status) || activeStatuses.has(previous.status)) &&
              ['POSTPONED', 'CANCELLED'].includes(match.status) && match.status !== previous.status) {
            const type = match.status === 'POSTPONED' ? 'matchPostponed' : 'matchCancelled';
            record({ ...base, type }, `${id}:${type}:${base.utcDate || ''}`);
          }
          if (activeStatuses.has(previous.status) && activeStatuses.has(match.status) && PHASE_EVENTS[phase] &&
              PHASE_ORDER[previous.phase] && PHASE_ORDER[phase] > PHASE_ORDER[previous.phase]) {
            record({ ...base, type: PHASE_EVENTS[phase], phase }, `${id}:phase:${phase}`);
          }
          // Missing scores and first sightings are not 0-0 baselines. A verified
          // score decrease is a cancellation/correction, never a fresh goal.
          if (activeStatuses.has(previous.status) && (activeStatuses.has(match.status) || match.status === 'FINISHED')) {
            const homeDelta = home !== null && previous.home !== null ? home - previous.home : null;
            const awayDelta = away !== null && previous.away !== null ? away - previous.away : null;
            const regressed = homeDelta !== null && homeDelta < 0 || awayDelta !== null && awayDelta < 0;
            const occurrence = `${lastUpdated || String(now)}:${scoreRevision}`;
            if (regressed) {
              const singleCancellation = phase !== 'PENALTIES' && previous.phase !== 'PENALTIES' &&
                (homeDelta === -1 && awayDelta === 0 || awayDelta === -1 && homeDelta === 0);
              const side = singleCancellation ? homeDelta === -1 ? 'home' : 'away' : '';
              record({ ...base, type: singleCancellation ? 'goalCancelled' : 'scoreCorrection', side,
                previousScore: { home: previous.home, away: previous.away } },
              `${id}:correction:${previous.home}:${previous.away}:${home}:${away}:${occurrence}`);
            } else if (phase !== 'PENALTIES' && previous.phase !== 'PENALTIES') {
              const timeline = details.get(id)?.timeline;
              for (const side of ['home', 'away']) {
                const delta = side === 'home' ? homeDelta : awayDelta;
                if (delta === null || delta <= 0) continue;
                const direct = acceptedStreamUpdates.get(id)?.incident;
                const streamIncident = delta === 1 && direct?.type === 'goal' && direct.provider === 'bsd' &&
                  direct.side === side && /^bsd_ws_[a-f0-9]{64}$/.test(direct.id || '') &&
                  scoreValue(direct.score?.home) === home && scoreValue(direct.score?.away) === away ? direct : null;
                const incident = streamIncident || (Array.isArray(timeline) && delta === 1 ? timeline.find(item =>
                  item.type === 'goal' && item.rescinded !== true && item.deleted !== true && item.isDeleted !== true && item.side === side &&
                  scoreValue(item.score?.home) === home && scoreValue(item.score?.away) === away &&
                  previousIncidents.has(id) && !previousIncidents.get(id).has(incidentKey(item))) : null);
                record({ ...base, ...(side === 'away' ? { team: awayTeam, against: homeTeam,
                  teamId: awayId, againstTeamId: homeId } : {}), type: 'goal', side,
                  ...(incident ? incidentFields(incident) : { player: '' }) },
                `${id}:goal:${side}:${previous.home}:${previous.away}:${home}:${away}:${incident?.id || occurrence}`);
              }
            }
          }
        }

        const timeline = details.get(id)?.timeline;
        if (!streamBaselines.has(id) && Array.isArray(timeline)) {
          const prior = previousIncidents.get(id);
          const seen = prior || new Set();
          for (const incident of timeline) {
            if (incident.rescinded === true || incident.deleted === true || incident.isDeleted === true) continue;
            const key = incidentKey(incident);
            if (prior && !seen.has(key)) {
              // Score/status events already reach detailed-alert subscribers.
              const sideKnown = ['home', 'away'].includes(incident.side);
              const team = incident.side === 'away' ? awayTeam : incident.side === 'home' ? homeTeam : '';
              const alert = incidentAlert(incident);
              const minute = Number(match.minute), incidentMinute = Number(incident.minute);
              const sameShootout = (phase === 'PENALTIES' || previous?.phase === 'PENALTIES') &&
                matchPhase({ period: incident.period }) === 'PENALTIES';
              const historic = incident.isLive === false || (incident.isLive !== true && !sameShootout &&
                match.minute !== null && match.minute !== undefined &&
                incident.minute !== null && incident.minute !== undefined && Number.isFinite(minute) &&
                Number.isFinite(incidentMinute) && minute - incidentMinute > 3);
              if (alert && !historic) {
                record({ ...base, team, against: !sideKnown ? '' : incident.side === 'away' ? homeTeam : awayTeam,
                  teamId: !sideKnown ? null : incident.side === 'away' ? awayId : homeId,
                  againstTeamId: !sideKnown ? null : incident.side === 'away' ? homeId : awayId,
                  ...alert, side: sideKnown ? incident.side : '', ...incidentFields(incident),
                  title: alert.type === 'card' ? `${alert.cardType === 'yellow' ? '🟨 Yellow card' : '🟥 Red card'} — ${team}` : 'Match update',
                  message: incident.player || incident.label || ''
                }, `${id}:incident:${key}`);
              }
            }
            seen.add(key);
          }
          previousIncidents.set(id, seen);
        }
        previousMatches.set(id, { status: match.status, phase, scoreRevision, home, away, homeTeam, awayTeam, homeId, awayId, seenAt: now,
          streamLeaseExpiresAt: acceptedStreamUpdates.has(id) ? now + streamLeaseMs :
            previous?.streamLeaseExpiresAt && previous.home === home && previous.away === away && previous.status === match.status
              ? previous.streamLeaseExpiresAt : null,
          ...(officialLineup !== null ? { lineupConfirmed: officialLineup } :
            previous?.lineupConfirmed !== undefined ? { lineupConfirmed: previous.lineupConfirmed } : {}),
          detailOverride: detailOverrides.has(id),
          detailOverrideExpiresAt: detailOverrides.has(id)
            ? renewedOverrides.has(id) ? now + overrideTtlMs : previous?.detailOverrideExpiresAt ?? now + overrideTtlMs : null,
          observedMatch: { id, status: match.status, source: match.source, provider: match.provider,
            utcDate: match.utcDate, lastUpdated: match.lastUpdated, minute: match.minute,
            matchPhase: match.matchPhase, period: match.period, statusText: match.statusText,
            homeTeam: match.homeTeam, awayTeam: match.awayTeam, score: match.score, competition: match.competition,
            ...(validatedProviderIdentities(match).length ? { providerIdentities: validatedProviderIdentities(match) } : {}) } });
      }
      while (previousMatches.size > MAX_TRACKED_MATCHES) forget(previousMatches.keys().next().value);
      while (processedEvents.size > MAX_PROCESSED_EVENTS) processedEvents.delete(processedEvents.keys().next().value);
      if (cycle.streamOnly === true && acceptedStreamUpdates.size === 0) return false;
      if (!events.length) return;

      const deliverEvents = async () => {
        // Installation discovery and FCM start immediately. They do not depend
        // on global event writes, legacy fan pagination or an inbox transaction.
        const deviceRecipientsRead = Promise.resolve().then(() => deviceService.findRecipients(events))
          .catch(() => { logger.warn('Push installation audience unavailable.'); return new Map(); });
        const fastPushTask = deviceRecipientsRead.then(async devices => {
          await mapConcurrent([...devices.values()], 8, async device => {
            if (!recipientAllowed(device.userId)) return;
            for (const event of device.events.values()) {
              try { await deviceService.deliver(device, event); }
              catch (error) { logger.warn('One installation delivery failed.'); }
            }
          });
        });

        const eventRooms = event => [...new Set([
          ...matchIdentityIds(event).flatMap(id => [matchRoom(id), `matchAlerts_${id}`]),
          ...teamIdentityIds(event).map(teamRoom)
        ])];
        if (!restrictSocketAlerts) {
          for (const event of events) {
            if (event.isDetailed) {
              const rooms = matchIdentityIds(event).map(id => `matchAlerts_${id}`);
              io.to(rooms.length === 1 ? rooms[0] : rooms).emit('detailedAlert', event);
            }
            else io.to(eventRooms(event)).emit('liveEvent', event);
          }
        }
        try {
          // Firestore batches support at most 500 writes.
          for (let i = 0; i < events.length; i += 500) {
            const batch = db.batch();
            for (const event of events.slice(i, i + 500)) batch.set(db.collection('events').doc(event.eventId), event);
            await batch.commit();
          }
        } catch (error) { logger.warn(`Event persistence failed: ${error.message}`); }

        const publicEvents = events.filter(event => !event.isDetailed);
        const recipients = new Map();
        const teams = [...new Set(publicEvents.flatMap(teamIdentityIds))];
        await mapConcurrent(teams, 3, async team => {
          try {
            const query = db.collection('users')
              .where('preferences.teamIds', 'array-contains', team)
              .orderBy('__name__')
              .limit(RECIPIENT_PAGE_SIZE);
            const teamEvents = publicEvents.filter(event => teamIdentityIds(event).includes(team));
            let page = query;
            // The limit bounds each read, not the audience. Document snapshots
            // provide a stable cursor; do not skip fans after the first page.
            while (true) {
              const snapshot = await page.get();
              for (const doc of snapshot.docs) {
                if (!recipientAllowed(doc.id)) continue;
                const recipient = recipients.get(doc.id) || { user: doc.data(), events: new Map() };
                for (const event of teamEvents) if (recipient.user.preferences?.hideScores !== true &&
                    eventCategoryEnabled(event.type, recipient.user.preferences || {})) {
                  recipient.events.set(event.eventId, event);
                }
                recipients.set(doc.id, recipient);
              }
              if (snapshot.docs.length < RECIPIENT_PAGE_SIZE) break;
              page = query.startAfter(snapshot.docs[snapshot.docs.length - 1]);
            }
          } catch (error) { logger.warn(`Favorite recipients unavailable: ${error.message}`); }
        });

        // Device subscriptions survive disconnected sockets and are evaluated per installation.
        try {
          const deviceRecipients = await deviceRecipientsRead;
          for (const device of deviceRecipients.values()) {
            if (!recipientAllowed(device.userId)) continue;
            const recipient = recipients.get(device.userId) || { user: {}, events: new Map() };
            recipient.devices = recipient.devices || [];
            recipient.devices.push(device);
            for (const event of device.events.values()) recipient.events.set(event.eventId, event);
            recipients.set(device.userId, recipient);
          }
        } catch (error) { logger.warn('Push installation audience unavailable.'); }

        await mapConcurrent([...recipients], 4, async ([userId, recipient]) => {
          if (!recipientAllowed(userId)) return;
          for (const event of recipient.events.values()) {
            const { title, message } = typeof buildEventNotification === 'function' ? buildEventNotification(event, 'en') : {
              title: event.type === 'card' && event.cardType === 'yellow' ? 'Yellow card' : {
                goal: 'Goal!', matchStart: 'Match started', matchEnd: 'Full time', matchReminder: 'Kickoff in 15 minutes',
                lineup: 'Official lineups', goalCancelled: 'Goal cancelled', scoreCorrection: 'Score corrected', card: 'Red card',
                halfTime: 'Half time', secondHalfStart: 'Second half started', extraTimeStart: 'Extra time started',
                penaltyShootout: 'Penalty shootout', matchPostponed: 'Match postponed', matchCancelled: 'Match cancelled' }[event.type] || 'Match update',
              message: `${event.homeTeam?.name || event.team} vs ${event.awayTeam?.name || event.against} — ${event.score}` };
            const notification = { ...event, title, message };
            let saved;
            try { saved = await saveNotification(userId, notification); }
            catch (error) { logger.warn('Event inbox persistence failed.'); }
            if (saved?.duplicate) continue;
            try {
              // A socket already in a match/team/alert room received liveEvent.
              const socketAudience = io.to(userRoom(userId));
              if (!restrictSocketAlerts) socketAudience.except(eventRooms(event));
              socketAudience.emit('notification', notification);
              if (recipient.user.fcmToken && !recipient.user.notificationDeviceVersion && !recipient.devices?.length &&
                  recipient.user.preferences?.hideScores !== true) {
                const token = recipient.user.fcmToken;
                const result = await sendPushNotification(token, title, message, { event, preferences: recipient.user.preferences,
                  recipientUserId: userId, supportsExtendedAlerts: false });
                if (result?.invalidToken) {
                  await db.runTransaction(async transaction => {
                    const ref = db.collection('users').doc(userId);
                    const current = await transaction.get(ref);
                    if (current.exists && current.data().fcmToken === token) transaction.update(ref, { fcmToken: null });
                  });
                }
              }
            } catch (error) { logger.warn('Event notification delivery failed.'); }
          }
        });
        await fastPushTask;
        logger.info(`Live events emitted: ${events.length}; tracked matches: ${previousMatches.size}`);
      };
      if (asynchronousDelivery) void deliverEvents().catch(() => { logger.warn('Live event delivery pipeline failed.'); });
      else await deliverEvents();
    } catch (error) {
      logger.error(`Live events error: ${error.message}`);
    } finally {
      running = false;
      if (streamCycles.length) {
        const pending = streamCycles.shift();
        queueMicrotask(() => { void emitLiveEvents(pending.io, pending.cycle).then(pending.resolve, () => pending.resolve(false)); });
      } else if (queuedCycle) {
        const pending = queuedCycle; queuedCycle = null;
        queueMicrotask(() => { void emitLiveEvents(io, pending); });
      }
    }
  }
  return emitLiveEvents;
}

module.exports = { createLiveEventsEmitter,
  emitLiveEvents: createLiveEventsEmitter({ nonBlockingDetails: true, asynchronousDelivery: true }) };
