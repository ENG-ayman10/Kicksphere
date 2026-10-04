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
const { sendPushNotification } = require('./pushNotificationService');
const notificationDevices = require('./notificationDeviceService');
const { createHash } = require('node:crypto');
const logger = require('../utils/logger');
const { matchRoom, teamRoom, userRoom } = require('../utils/socketRooms');
const { matchTeamId } = require('../utils/teamIdentity');
const { createLiveRecipientPolicy } = require('../utils/liveDeliveryScope');
const { normalizeProviderTimestamp } = require('../utils/providerTimestamp');
const { validatedProviderIdentities, matchIdentityIds, teamIdentityIds } = require('../utils/matchProviderIdentities');

const MAX_TRACKED_MATCHES = 500;
const MAX_PROCESSED_EVENTS = 10000;
const MAX_DETAIL_REQUESTS = 6;
const RECIPIENT_PAGE_SIZE = 200;
const STATE_TTL = 6 * 60 * 60 * 1000;
const FIXTURE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
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
const incidentKey = incident => JSON.stringify([
  incident.id || null, incident.minute, incident.type, incident.side, incident.player, incident.label
]);

// Factory keeps state isolated in offline tests; the exported poller is a singleton.
function createLiveEventsEmitter(options = {}) {
  const deviceService = options.notificationDevices || notificationDevices;
  const recipientAllowed = options.recipientAllowed || createLiveRecipientPolicy();
  const restrictSocketAlerts = options.restrictSocketAlerts === true || process.env.LOCAL_LIVE_PUSH_USER_IDS !== undefined;
  const bsdEnabled = typeof bsdSportsService.isConfigured === 'function' && bsdSportsService.isConfigured();
  const provider = options.provider || (bsdEnabled ? sportsDataService : sportscoreService);
  const readDetail = options.getMatchDetails || (async (id, { includeTimeline = false } = {}) => {
    if (/^bsd_[1-9]\d*$/.test(id)) {
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
      previousMatches.set(id, { status: match.status, home: scoreValue(match.score?.fullTime?.home),
        away: scoreValue(match.score?.fullTime?.away), seenAt: now });
    }
  };

  const refreshFixtures = now => {
    const day = new Date(now).toISOString().slice(0, 10);
    if (fixtureDay !== day) { fixtureSnapshot = []; fixtureDay = day; fixtureReadAt = -Infinity; }
    if (fixtureRead || now - fixtureReadAt < fixtureRefreshIntervalMs) return;
    fixtureReadAt = now;
    // A calendar read can fan out across several slow providers. Keep it outside
    // the live cycle, and never let a late scheduled row overwrite live state.
    fixtureRead = Promise.resolve().then(() => provider.getMatchesByDate(day)).then(snapshot => {
      const rows = snapshotRows(snapshot);
      if (rows && fixtureDay === day) {
        fixtureSnapshot = rows;
        if (!running) seedScheduledFixtures(clock());
      }
    }).catch(() => { logger.warn('Scheduled fixture snapshot unavailable.'); }).finally(() => { fixtureRead = null; });
  };

  const forget = id => {
    previousMatches.delete(id);
    previousIncidents.delete(id);
    detailChecks.delete(id);
  };

  return async function emitLiveEvents(io) {
    if (running) return;
    running = true;
    try {
      const now = clock();
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

      refreshFixtures(now);
      const live = await Promise.resolve().then(() => provider.getLiveMatches())
        .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
      const liveRows = live.status === 'fulfilled' ? snapshotRows(live.value) : null;
      seedScheduledFixtures(now, new Set((liveRows || [])
        .filter(match => activeStatuses.has(match.status)).map(match => String(match.id))));
      const matches = new Map();
      for (const result of [{ status: 'fulfilled', value: fixtureSnapshot }, live]) {
        const snapshot = result.status === 'fulfilled' ? result.value : null;
        const rows = snapshotRows(snapshot);
        if (Array.isArray(rows)) {
          for (const match of rows) if (match?.id) {
            const id = String(match.id);
            const previous = previousMatches.get(id);
            if (match.liveSnapshotStale === true) {
              if (previous?.observedMatch) matches.set(id, previous.observedMatch);
              continue;
            }
            const fromCalendar = snapshot === fixtureSnapshot;
            const incomingTime = Date.parse(match.lastUpdated || '');
            const previousTime = Date.parse(previous?.observedMatch?.lastUpdated || '');
            const olderSnapshot = Number.isFinite(incomingTime) && Number.isFinite(previousTime) && incomingTime < previousTime;
            // A retained daily fixture is useful for scheduling, but cannot
            // roll an already observed score back while the live feed omits it.
            const incoming = { ...match,
              providerIdentities: match.providerIdentities || matches.get(id)?.providerIdentities || previous?.observedMatch?.providerIdentities };
            const identities = validatedProviderIdentities(incoming);
            if (identities.length) incoming.providerIdentities = identities;
            else delete incoming.providerIdentities;
            matches.set(id, previous?.observedMatch && (olderSnapshot || (fromCalendar && activeStatuses.has(match.status)))
              ? previous.observedMatch : incoming);
          }
        } else if (result.status === 'rejected') {
          logger.warn(`Live snapshot unavailable: ${result.reason?.message}`);
        }
      }

      const details = new Map();
      const candidates = new Set();
      let deviceMatchIds = new Set();
      try {
        const observedActive = new Map([...matches].filter(([, match]) => activeStatuses.has(match.status)));
        for (const [id, state] of previousMatches) if (activeStatuses.has(state.status) && !observedActive.has(id)) {
          observedActive.set(id, state.observedMatch || { id });
        }
        const queriedIds = [...new Set([...observedActive.values()].flatMap(matchIdentityIds))]
          .slice(0, MAX_TRACKED_MATCHES * 3);
        const subscribedIds = await deviceService.getSubscribedMatchIds(queriedIds);
        deviceMatchIds = new Set([...observedActive].filter(([, match]) =>
          matchIdentityIds(match).some(id => subscribedIds.has(id))).map(([id]) => id));
      } catch (error) { logger.warn('Direct match push subscriptions unavailable.'); }
      const hasAlertRoom = id => matchIdentityIds(matches.get(id) || previousMatches.get(id)?.observedMatch || { id })
        .some(matchId => io.sockets.adapter.rooms.get(`matchAlerts_${matchId}`)?.size);
      // An empty live response is never evidence that a match has finished.
      const liveMatchIds = new Set((liveRows || []).map(match => String(match.id)));
      for (const [id, state] of previousMatches) {
        if (activeStatuses.has(state.status) && (!liveMatchIds.has(id) || scheduledStatuses.has(matches.get(id)?.status))) candidates.add(id);
      }
      for (const [id, match] of matches) {
        const observedActive = activeStatuses.has(match.status) ||
          (match.status === 'FINISHED' && activeStatuses.has(previousMatches.get(id)?.status));
        if (observedActive && (deviceMatchIds.has(id) || hasAlertRoom(id))) {
          candidates.add(id);
        }
      }
      const lookups = [...candidates]
        .sort((a, b) => (detailChecks.get(a) || 0) - (detailChecks.get(b) || 0))
        .slice(0, MAX_DETAIL_REQUESTS);
      await mapConcurrent(lookups, 3, async id => {
        detailChecks.set(id, now);
        try {
          const detail = await readDetail(id, {
            includeTimeline: deviceMatchIds.has(id) || hasAlertRoom(id)
          });
          if (detail && (!detail.id || String(detail.id) === id)) {
            details.set(id, detail);
            const listed = matches.get(id);
            const detailTime = Date.parse(detail.lastUpdated || '');
            const listedTime = Date.parse(listed?.lastUpdated || '');
            const olderDetail = Number.isFinite(detailTime) && Number.isFinite(listedTime) && detailTime < listedTime;
            const newerDetail = Number.isFinite(detailTime) &&
              (!Number.isFinite(listedTime) || detailTime >= listedTime);
            const detailHome = scoreValue(detail.score?.fullTime?.home);
            const detailAway = scoreValue(detail.score?.fullTime?.away);
            const listedHome = scoreValue(listed?.score?.fullTime?.home);
            const listedAway = scoreValue(listed?.score?.fullTime?.away);
            const scoreAdvances = detailHome !== null && detailAway !== null &&
              (listedHome === null || detailHome >= listedHome) &&
              (listedAway === null || detailAway >= listedAway);
            // The detail endpoint can be ahead of a cached active list. Keep the
            // subscribed identity, but reject older detail data and unverified
            // score regressions when neither endpoint exposes an update time.
            if (!listed || (!olderDetail && (detail.status === 'FINISHED' ||
                (activeStatuses.has(detail.status) && (scheduledStatuses.has(listed.status) ||
                  (activeStatuses.has(listed.status) && (newerDetail || scoreAdvances))))))) {
              matches.set(id, { ...listed, ...detail, id });
            }
          }
        } catch (error) {
          logger.warn(`Live detail unavailable for ${id}: ${error.message}`);
        }
      });

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
        const base = {
          matchId: id, team: homeTeam, against: awayTeam,
          teamId: homeId, againstTeamId: awayId, awayTeamId: awayId,
          homeTeamId: homeId, homeTeam: { id: homeId, name: homeTeam }, awayTeam: { id: awayId, name: awayTeam },
          score, scoreValues: { home, away }, provider: matchProvider,
          ...(lastUpdated ? { lastUpdated } : {}),
          tournament: match.competition?.name || '', minute: match.minute ?? null,
          ...(validatedProviderIdentities(match).length ? {
            providerIdentities: validatedProviderIdentities(match), utcDate: match.utcDate,
            competitionCode: match.competition?.code
          } : {})
        };
        if (previous) {
          if (scheduledStatuses.has(previous.status) && activeStatuses.has(match.status)) {
            record({ ...base, type: 'matchStart' }, `${id}:start`);
          }
          if (activeStatuses.has(previous.status) && match.status === 'FINISHED') {
            record({ ...base, type: 'matchEnd' }, `${id}:end`);
          }
          // Missing scores and first sightings are not 0-0 baselines. Scores
          // that decrease (for example after VAR) are updates, not new goals.
          if (activeStatuses.has(previous.status) && (activeStatuses.has(match.status) || match.status === 'FINISHED')) {
            if (home !== null && previous.home !== null && home > previous.home) {
              record({ ...base, type: 'goal', side: 'home', player: '' }, `${id}:goal:home:${home}:${away}`);
            }
            if (away !== null && previous.away !== null && away > previous.away) {
              record({ ...base, team: awayTeam, against: homeTeam, teamId: awayId, againstTeamId: homeId,
                type: 'goal', side: 'away', player: '' }, `${id}:goal:away:${home}:${away}`);
            }
          }
        }

        const timeline = details.get(id)?.timeline;
        if (Array.isArray(timeline)) {
          const prior = previousIncidents.get(id);
          const seen = prior || new Set();
          for (const incident of timeline) {
            if (incident.rescinded === true) continue;
            const key = incidentKey(incident);
            if (prior && !seen.has(key)) {
              // Score/status events already reach detailed-alert subscribers.
              const sideKnown = ['home', 'away'].includes(incident.side);
              const team = incident.side === 'away' ? awayTeam : incident.side === 'home' ? homeTeam : '';
              if (incident.type === 'red_card' || incident.type === 'var' ||
                  (incident.type === 'incident' && /var/i.test(incident.label || ''))) {
                record({ ...base, team, against: !sideKnown ? '' : incident.side === 'away' ? homeTeam : awayTeam,
                  teamId: !sideKnown ? null : incident.side === 'away' ? awayId : homeId,
                  againstTeamId: !sideKnown ? null : incident.side === 'away' ? homeId : awayId,
                  type: incident.type === 'red_card' ? 'card' : 'var', isDetailed: true,
                  side: sideKnown ? incident.side : '', player: incident.player || '',
                  ...(incident.type === 'red_card' ? { cardType: 'red' } : {}),
                  title: incident.type === 'red_card' ? `🟥 Red card — ${team}` : 'VAR update',
                  message: incident.player || incident.label || '', minute: incident.minute ?? null
                }, `${id}:incident:${key}`);
              }
            }
            seen.add(key);
          }
          previousIncidents.set(id, seen);
        }
        previousMatches.set(id, { status: match.status, home, away, homeTeam, awayTeam, homeId, awayId, seenAt: now,
          observedMatch: { id, status: match.status, source: match.source, provider: match.provider,
            utcDate: match.utcDate, lastUpdated: match.lastUpdated, minute: match.minute,
            homeTeam: match.homeTeam, awayTeam: match.awayTeam, score: match.score, competition: match.competition,
            ...(validatedProviderIdentities(match).length ? { providerIdentities: validatedProviderIdentities(match) } : {}) } });
      }
      while (previousMatches.size > MAX_TRACKED_MATCHES) forget(previousMatches.keys().next().value);
      while (processedEvents.size > MAX_PROCESSED_EVENTS) processedEvents.delete(processedEvents.keys().next().value);
      if (!events.length) return;

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
              for (const event of teamEvents) recipient.events.set(event.eventId, event);
              recipients.set(doc.id, recipient);
            }
            if (snapshot.docs.length < RECIPIENT_PAGE_SIZE) break;
            page = query.startAfter(snapshot.docs[snapshot.docs.length - 1]);
          }
        } catch (error) { logger.warn(`Favorite recipients unavailable: ${error.message}`); }
      });

      // Device subscriptions survive disconnected sockets and are evaluated per installation.
      try {
        const deviceRecipients = await deviceService.findRecipients(events);
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
          const title = event.type === 'goal' ? '⚽ Goal!' : event.type === 'matchStart' ? '🟢 Match started' :
            event.type === 'card' ? '🟥 Red card' : event.type === 'var' ? 'VAR update' : '🏁 Full time';
          const message = `${event.homeTeam?.name || event.team} vs ${event.awayTeam?.name || event.against} — ${event.score}`;
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
            for (const device of recipient.devices || []) {
              if (device.events.has(event.eventId)) {
                try { await deviceService.deliver(device, event); }
                catch (error) { logger.warn('One installation delivery failed.'); }
              }
            }
            if (recipient.user.fcmToken && !recipient.user.notificationDeviceVersion && !recipient.devices?.length &&
                recipient.user.preferences?.hideScores !== true) {
              const token = recipient.user.fcmToken;
              const result = await sendPushNotification(token, title, message, { event, preferences: recipient.user.preferences, recipientUserId: userId });
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
      logger.info(`Live events emitted: ${events.length}; tracked matches: ${previousMatches.size}`);
    } catch (error) {
      logger.error(`Live events error: ${error.message}`);
    } finally { running = false; }
  };
}

module.exports = { createLiveEventsEmitter, emitLiveEvents: createLiveEventsEmitter() };
