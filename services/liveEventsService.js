/**
 * @file liveEventsService.js
 * @description Detects live match events (goals, cards, subs) by polling Sofascore
 * and comparing states. Sends real-time notifications to subscribed users.
 * Ultra-fast 30s polling for near real-time performance.
 */

const db = require('../config/firebase');
const sportscoreService = require('./sportscoreService');
const { saveNotification } = require('./notificationService');
const { sendPushNotification } = require('./pushNotificationService');
const logger = require('../utils/logger');
const { matchRoom, teamRoom, userRoom } = require('../utils/socketRooms');

// ==========================================
// 🧠 STATE TRACKING
// ==========================================
const processedEvents = new Map();
const MAX_PROCESSED_EVENTS = 10000;
const previousMatchScores = new Map();
const previousIncidents = new Map(); // Track incidents per match
const MAX_TRACKED_MATCHES = 500;

// Cleanup functions to prevent memory leaks
const cleanupProcessedEvents = () => {
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    let count = 0;
    const now = Date.now();
    for (const [key, timestamp] of processedEvents.entries()) {
      // Remove events older than 4 hours
      if (now - timestamp > 4 * 60 * 60 * 1000) {
        processedEvents.delete(key);
        count++;
      }
    }
    logger.info(`🧹 Cleaned ${count} old events (remaining: ${processedEvents.size})`);
  }
};

const cleanupPreviousScores = () => {
  if (previousMatchScores.size > MAX_TRACKED_MATCHES) {
    const toDelete = Math.floor(previousMatchScores.size / 2);
    let count = 0;
    for (const [key] of previousMatchScores) {
      if (count >= toDelete) break;
      previousMatchScores.delete(key);
      count++;
    }
    logger.info(`🧹 Cleaned ${count} old match scores`);
  }
};

// ==========================================
// 🔥 FETCH SPORTSCORE LIVE MATCHES
// ==========================================
const fetchLiveMatches = async () => {
  try {
    return await sportscoreService.getLiveMatches() || [];
  } catch (err) {
    logger.warn(`⚠️ SportScore live fetch failed: ${err.message}`);
    return [];
  }
};

// ==========================================
// 🔍 FETCH MATCH INCIDENTS (Goals, Cards, Subs)
// ==========================================
const fetchMatchIncidents = async (eventId) => {
  try {
    const details = await sportscoreService.getMatchDetails(eventId);
    return details?.timeline || [];
  } catch (err) {
    logger.error(`⚠️ SportScore incidents fetch failed: ${err.message}`);
    return [];
  }
};

// ==========================================
// 🔥 MAIN: EMIT LIVE EVENTS (called every 30s)
// ==========================================
exports.emitLiveEvents = async (io) => {
  try {
    cleanupProcessedEvents();
    cleanupPreviousScores();

    // ===========================
    // 1. Fetch live matches from SportScore (FAST)
    // ===========================
    const liveMatches = await fetchLiveMatches();

    const eventsToEmit = [];

    // ===========================
    // 2. Process SportScore live matches
    // ===========================
    for (const match of liveMatches) {
      if (!match.id) continue;

      const matchId = String(match.id);
      const homeTeam = match.homeTeam?.name || 'Unknown';
      const awayTeam = match.awayTeam?.name || 'Unknown';
      const homeScore = match.score?.fullTime?.home ?? 0;
      const awayScore = match.score?.fullTime?.away ?? 0;
      const homeTeamId = match.homeTeam?.id;
      const awayTeamId = match.awayTeam?.id;
      const tournament = match.competition?.name || '';
      const statusCode = match.status === 'IN_PLAY' ? 6 : (match.status === 'FINISHED' ? 100 : 0);

      // Track score changes for goal detection
      const prevScores = previousMatchScores.get(matchId);

      // Check for detailed alerts subscription
      const matchAlertsRoom = `matchAlerts_${matchId}`;
      const hasSubscribers = io.sockets.adapter.rooms.get(matchAlertsRoom)?.size > 0;

      if (hasSubscribers) {
        const incidents = await fetchMatchIncidents(matchId);
        if (incidents.length > 0) {
          for (const inc of incidents) {
            const uniqueKey = `${matchId}_inc_${inc.minute}_${inc.type}_${inc.player}`;
            if (!processedEvents.has(uniqueKey)) {
              processedEvents.set(uniqueKey, Date.now());
              
              const teamName = inc.side === 'home' ? homeTeam : awayTeam;
              let title = '';
              let message = '';

              if (inc.type === 'goal') {
                title = `⚽ GOAL for ${teamName}!`;
                message = inc.player || 'Goal scored';
                if (inc.assist) message += ` (Assist: ${inc.assist})`;
                if ((inc.label || '').toLowerCase().includes('penalty')) message += ' (Penalty)';
              } else if (inc.type === 'red_card') {
                title = `🟥 RED CARD - ${teamName}`;
                message = inc.player || 'Red card given';
              } else if (inc.type === 'incident' && (inc.label || '').toLowerCase().includes('var')) {
                title = `🖥️ VAR Decision`;
                message = `Goal Cancelled or Penalty checked`;
              } else if (inc.type === 'incident' && ((inc.label || '').includes('HT') || (inc.label || '').includes('Half Time'))) {
                title = '⏱️ Half Time';
                message = `${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`;
              } else if (inc.type === 'incident' && ((inc.label || '').includes('FT') || (inc.label || '').includes('Full Time'))) {
                title = '🏁 Full Time';
                message = `${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`;
              }

              if (title) {
                eventsToEmit.push({
                  matchId,
                  type: 'detailed_incident',
                  title,
                  message,
                  team: teamName,
                  score: `${homeScore} - ${awayScore}`,
                  tournament,
                  createdAt: new Date(),
                  isDetailed: true
                });
              }
            }
          }
        }
      }

      if (prevScores) {
        // 🔥 GOAL DETECTED — Home team
        if (homeScore > prevScores.homeScore) {
          const uniqueKey = `${matchId}_goal_home_${homeScore}`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.set(uniqueKey, Date.now());
            eventsToEmit.push({
              matchId,
              type: 'goal',
              team: homeTeam,
              teamId: homeTeamId,
              against: awayTeam,
              score: `${homeScore} - ${awayScore}`,
              tournament,
              player: 'Unknown',
              minute: match.time?.currentPeriodStartTimestamp
                  ? Math.max(0, Math.floor((Date.now() / 1000 - match.time.currentPeriodStartTimestamp) / 60))
                  : (match.statusTime?.max ? Math.floor(match.statusTime.max / 60) : 0),
              createdAt: new Date(),
            });
          }
        }

        // 🔥 GOAL DETECTED — Away team
        if (awayScore > prevScores.awayScore) {
          const uniqueKey = `${matchId}_goal_away_${awayScore}`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.set(uniqueKey, Date.now());
            eventsToEmit.push({
              matchId,
              type: 'goal',
              team: awayTeam,
              teamId: awayTeamId,
              against: homeTeam,
              score: `${homeScore} - ${awayScore}`,
              tournament,
              player: 'Unknown',
              minute: 0,
              createdAt: new Date(),
            });
          }
        }

        // 🏟️ Match Started (status changed to live)
        if (prevScores.statusCode !== 6 && statusCode === 6) {
          const uniqueKey = `${matchId}_started`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.set(uniqueKey, Date.now());
            eventsToEmit.push({
              matchId,
              type: 'matchStart',
              team: homeTeam,
              teamId: homeTeamId,
              against: awayTeam,
              awayTeamId,
              tournament,
              createdAt: new Date(),
            });
          }
        }

        // 🏁 Match Ended (status changed to finished)
        if (prevScores.statusCode !== 100 && statusCode === 100) {
          const uniqueKey = `${matchId}_ended`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.set(uniqueKey, Date.now());
            eventsToEmit.push({
              matchId,
              type: 'matchEnd',
              team: homeTeam,
              teamId: homeTeamId,
              against: awayTeam,
              awayTeamId,
              score: `${homeScore} - ${awayScore}`,
              tournament,
              createdAt: new Date(),
            });
          }
        }
      }

      // Save current state
      previousMatchScores.set(matchId, { homeScore, awayScore, statusCode });
    }

    if (eventsToEmit.length === 0) return;

    // ===========================
    // 4. Broadcast to match rooms
    // ===========================
    eventsToEmit.forEach(event => {
      if (event.isDetailed) {
        io.to(`matchAlerts_${event.matchId}`).emit('detailedAlert', event);
      } else {
        io.to(matchRoom(event.matchId)).emit('liveEvent', event);
        if (event.team) io.to(teamRoom(event.team)).emit('liveEvent', event);
        if (event.against) io.to(teamRoom(event.against)).emit('liveEvent', event);
      }
    });

    // ===========================
    // 5. Save to Firestore & Notify subscribed users
    // ===========================
    try {
      const batch = db.batch();
      eventsToEmit.forEach(event => {
        const ref = db.collection('events').doc();
        batch.set(ref, event);
      });
      await batch.commit();
    } catch (dbErr) {
      logger.warn(`⚠️ Firestore batch save failed: ${dbErr.message}`);
    }

    // Notify users with matching favorite teams
    const eventTeams = [...new Set(eventsToEmit.flatMap(e => [e.team, e.against].filter(Boolean)))];

    for (const teamName of eventTeams) {
      try {
        const usersSnapshot = await db.collection('users')
          .where('preferences.teams', 'array-contains', teamName)
          .limit(200)
          .get();

        const teamEvents = eventsToEmit.filter(e => e.team === teamName || e.against === teamName);

        for (const userDoc of usersSnapshot.docs) {
          const user = userDoc.data();
          const userId = userDoc.id;

          for (const ev of teamEvents) {
            let title, message;

            switch (ev.type) {
              case 'goal':
                title = '⚽ GOAL!';
                message = `${ev.team} scored! ${ev.score} (${ev.tournament})`;
                break;
              case 'matchStart':
                title = '🏟️ Match Started!';
                message = `${ev.team} vs ${ev.against} — ${ev.tournament}`;
                break;
              case 'matchEnd':
                title = '🏁 Full Time!';
                message = `${ev.team} vs ${ev.against} — Final: ${ev.score}`;
                break;
              default:
                title = '📢 Match Event';
                message = `${ev.team} — ${ev.type}`;
            }

            // Save notification
            await saveNotification(userId, {
              title,
              message,
              matchId: ev.matchId,
              type: ev.type,
            });

            // Socket push to user's personal room
            io.to(userRoom(userId)).emit('notification', {
              title,
              message,
              matchId: ev.matchId,
              type: ev.type,
              team: ev.team,
              score: ev.score,
              tournament: ev.tournament,
            });

            // FCM push notification
            if (user.fcmToken) {
              await sendPushNotification(user.fcmToken, title, message);
            }
          }
        }
      } catch (err) {
        logger.error(`❌ Notification query error for ${teamName}: ${err.message}`);
      }
    }

    logger.info(`⚡ Live events emitted: ${eventsToEmit.length} (SportScore: ${liveMatches.length} live matches tracked)`);

  } catch (error) {
    logger.error(`❌ Live Events Error: ${error.message}`);
  }
};
