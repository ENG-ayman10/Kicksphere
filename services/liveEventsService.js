/**
 * Detect observed match transitions without replaying historical events.
 * The live feed stays live-only; today's fixtures establish scheduled states,
 * and bounded detail lookups follow active games that disappear from that feed.
 */
const db = require('../config/firebase');
const sportscoreService = require('./sportscoreService');
const { saveNotification } = require('./notificationService');
const { sendPushNotification } = require('./pushNotificationService');
const logger = require('../utils/logger');
const { matchRoom, teamRoom, userRoom } = require('../utils/socketRooms');

const MAX_TRACKED_MATCHES = 500;
const MAX_PROCESSED_EVENTS = 10000;
const MAX_DETAIL_REQUESTS = 6;
const RECIPIENT_PAGE_SIZE = 200;
const STATE_TTL = 6 * 60 * 60 * 1000;
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
function createLiveEventsEmitter() {
  const previousMatches = new Map();
  const previousIncidents = new Map();
  const processedEvents = new Map();
  const detailChecks = new Map();
  let running = false;

  const forget = id => {
    previousMatches.delete(id);
    previousIncidents.delete(id);
    detailChecks.delete(id);
  };

  return async function emitLiveEvents(io) {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const [id, state] of previousMatches) {
        if (now - state.seenAt > STATE_TTL) forget(id);
      }
      for (const [id, time] of processedEvents) {
        if (now - time > STATE_TTL) processedEvents.delete(id);
      }

      const [fixtures, live] = await Promise.allSettled([
        sportscoreService.getMatchesByDate('TODAY'), sportscoreService.getLiveMatches()
      ]);
      const matches = new Map();
      for (const result of [fixtures, live]) {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          for (const match of result.value) if (match?.id) matches.set(String(match.id), match);
        } else if (result.status === 'rejected') {
          logger.warn(`Live snapshot unavailable: ${result.reason?.message}`);
        }
      }

      const details = new Map();
      const candidates = new Set();
      // An empty live response is never evidence that a match has finished.
      for (const [id, state] of previousMatches) {
        if (activeStatuses.has(state.status) && !matches.has(id)) candidates.add(id);
      }
      for (const [id, match] of matches) {
        if (activeStatuses.has(match.status) && io.sockets.adapter.rooms.get(`matchAlerts_${id}`)?.size) {
          candidates.add(id);
        }
      }
      const lookups = [...candidates]
        .sort((a, b) => (detailChecks.get(a) || 0) - (detailChecks.get(b) || 0))
        .slice(0, MAX_DETAIL_REQUESTS);
      await mapConcurrent(lookups, 3, async id => {
        detailChecks.set(id, now);
        try {
          const detail = await sportscoreService.getMatchDetails(id);
          if (detail) {
            details.set(id, detail);
            // Preserve the identity used by existing subscriptions.
            if (!matches.has(id) || detail.status === 'FINISHED') matches.set(id, { ...detail, id });
          }
        } catch (error) {
          logger.warn(`Live detail unavailable for ${id}: ${error.message}`);
        }
      });

      const events = [];
      const record = (event, key) => {
        if (processedEvents.has(key)) return;
        processedEvents.set(key, now);
        events.push({ ...event, eventId: key, createdAt: new Date(now) });
      };

      for (const [id, match] of matches) {
        const previous = previousMatches.get(id);
        const home = scoreValue(match.score?.fullTime?.home);
        const away = scoreValue(match.score?.fullTime?.away);
        const homeTeam = match.homeTeam?.name || previous?.homeTeam || '';
        const awayTeam = match.awayTeam?.name || previous?.awayTeam || '';
        const score = `${home ?? '-'} - ${away ?? '-'}`;
        const base = {
          matchId: id, team: homeTeam, against: awayTeam,
          teamId: match.homeTeam?.id || homeTeam, awayTeamId: match.awayTeam?.id || awayTeam,
          score, tournament: match.competition?.name || '', minute: match.minute ?? null
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
              record({ ...base, type: 'goal', player: '' }, `${id}:goal:home:${home}:${away}`);
            }
            if (away !== null && previous.away !== null && away > previous.away) {
              record({ ...base, team: awayTeam, against: homeTeam, teamId: match.awayTeam?.id || awayTeam,
                type: 'goal', player: '' }, `${id}:goal:away:${home}:${away}`);
            }
          }
        }

        const timeline = details.get(id)?.timeline;
        if (Array.isArray(timeline)) {
          const prior = previousIncidents.get(id);
          const seen = prior || new Set();
          for (const incident of timeline) {
            const key = incidentKey(incident);
            if (prior && !seen.has(key)) {
              // Score/status events already reach detailed-alert subscribers.
              const team = incident.side === 'away' ? awayTeam : homeTeam;
              if (incident.type === 'red_card' || (incident.type === 'incident' && /var/i.test(incident.label || ''))) {
                record({ ...base, team, against: incident.side === 'away' ? homeTeam : awayTeam,
                  teamId: incident.side === 'away' ? match.awayTeam?.id || awayTeam : match.homeTeam?.id || homeTeam,
                  type: 'detailed_incident', isDetailed: true,
                  title: incident.type === 'red_card' ? `🟥 Red card — ${team}` : 'VAR update',
                  message: incident.player || incident.label || '', minute: incident.minute ?? null
                }, `${id}:incident:${key}`);
              }
            }
            seen.add(key);
          }
          previousIncidents.set(id, seen);
        }
        previousMatches.set(id, { status: match.status, home, away, homeTeam, awayTeam, seenAt: now });
      }
      while (previousMatches.size > MAX_TRACKED_MATCHES) forget(previousMatches.keys().next().value);
      while (processedEvents.size > MAX_PROCESSED_EVENTS) processedEvents.delete(processedEvents.keys().next().value);
      if (!events.length) return;

      const eventRooms = event => [...new Set([
        matchRoom(event.matchId), `matchAlerts_${event.matchId}`,
        ...[event.team, event.against].filter(Boolean).map(teamRoom)
      ])];
      for (const event of events) {
        if (event.isDetailed) io.to(`matchAlerts_${event.matchId}`).emit('detailedAlert', event);
        else io.to(eventRooms(event)).emit('liveEvent', event);
      }
      try {
        // Firestore batches support at most 500 writes.
        for (let i = 0; i < events.length; i += 500) {
          const batch = db.batch();
          for (const event of events.slice(i, i + 500)) batch.set(db.collection('events').doc(), event);
          await batch.commit();
        }
      } catch (error) { logger.warn(`Event persistence failed: ${error.message}`); }

      const publicEvents = events.filter(event => !event.isDetailed);
      const recipients = new Map();
      const teams = [...new Set(publicEvents.flatMap(event => [event.team, event.against]).filter(Boolean))];
      await mapConcurrent(teams, 3, async team => {
        try {
          const query = db.collection('users')
            .where('preferences.teams', 'array-contains', team)
            .orderBy('__name__')
            .limit(RECIPIENT_PAGE_SIZE);
          const teamEvents = publicEvents.filter(event => event.team === team || event.against === team);
          let page = query;
          // The limit bounds each read, not the audience. Document snapshots
          // provide a stable cursor; do not skip fans after the first page.
          while (true) {
            const snapshot = await page.get();
            for (const doc of snapshot.docs) {
              const recipient = recipients.get(doc.id) || { user: doc.data(), events: new Map() };
              for (const event of teamEvents) recipient.events.set(event.eventId, event);
              recipients.set(doc.id, recipient);
            }
            if (snapshot.docs.length < RECIPIENT_PAGE_SIZE) break;
            page = query.startAfter(snapshot.docs[snapshot.docs.length - 1]);
          }
        } catch (error) { logger.warn(`Favorite recipients unavailable: ${error.message}`); }
      });

      await mapConcurrent([...recipients], 4, async ([userId, recipient]) => {
        for (const event of recipient.events.values()) {
          const title = event.type === 'goal' ? '⚽ Goal!' : event.type === 'matchStart' ? '🟢 Match started' : '🏁 Full time';
          const message = `${event.team} vs ${event.against} — ${event.score}`;
          const notification = { ...event, title, message };
          try {
            await saveNotification(userId, notification);
            // A socket already in a match/team/alert room received liveEvent.
            io.to(userRoom(userId)).except(eventRooms(event)).emit('notification', notification);
            if (recipient.user.fcmToken && !io.sockets.adapter.rooms.get(userRoom(userId))?.size) {
              await sendPushNotification(recipient.user.fcmToken, title, message);
            }
          } catch (error) { logger.warn(`Event notification failed: ${error.message}`); }
        }
      });
      logger.info(`Live events emitted: ${events.length}; tracked matches: ${previousMatches.size}`);
    } catch (error) {
      logger.error(`Live events error: ${error.message}`);
    } finally { running = false; }
  };
}

module.exports = { createLiveEventsEmitter, emitLiveEvents: createLiveEventsEmitter() };
