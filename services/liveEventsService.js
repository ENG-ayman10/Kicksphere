/**
 * @file liveEventsService.js
 * @description Detects live match events (goals, cards, subs) by polling Sofascore
 * and comparing states. Sends real-time notifications to subscribed users.
 * Ultra-fast 30s polling for near real-time performance.
 */

const db = require('../config/firebase');
const { fetchMatchesFromAPI } = require('./footballApi');
const { saveNotification } = require('./notificationService');
const { sendPushNotification } = require('./pushNotificationService');
const logger = require('../utils/logger');
const axios = require('axios');

// Sofascore headers
const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0'
};

// ==========================================
// 🧠 STATE TRACKING
// ==========================================
const processedEvents = new Set();
const MAX_PROCESSED_EVENTS = 10000;
const previousMatchScores = new Map();
const previousIncidents = new Map(); // Track incidents per match
const MAX_TRACKED_MATCHES = 500;

// Cleanup functions to prevent memory leaks
const cleanupProcessedEvents = () => {
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const toDelete = Math.floor(processedEvents.size / 2);
    let count = 0;
    for (const key of processedEvents) {
      if (count >= toDelete) break;
      processedEvents.delete(key);
      count++;
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
// 🔥 FETCH SOFASCORE LIVE MATCHES
// ==========================================
const fetchSofascoreLiveMatches = async () => {
  try {
    const res = await axios.get('https://api.sofascore.com/api/v1/sport/football/events/live', {
      headers: SOFA_HEADERS,
      timeout: 8000,
    });
    return res.data?.events || [];
  } catch (err) {
    logger.warn(`⚠️ Sofascore live fetch failed: ${err.message}`);
    return [];
  }
};

// ==========================================
// 🔍 FETCH MATCH INCIDENTS (Goals, Cards, Subs)
// ==========================================
const fetchMatchIncidents = async (eventId) => {
  try {
    const res = await axios.get(`https://api.sofascore.com/api/v1/event/${eventId}/incidents`, {
      headers: SOFA_HEADERS,
      timeout: 5000,
    });
    return res.data?.incidents || [];
  } catch (err) {
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
    // 1. Fetch live matches from Sofascore (FAST)
    // ===========================
    const sofaLiveMatches = await fetchSofascoreLiveMatches();
    
    // Also get football-data.org matches as fallback
    let fdMatches = [];
    try {
      fdMatches = await fetchMatchesFromAPI();
    } catch (_) {}

    const eventsToEmit = [];

    // ===========================
    // 2. Process Sofascore live matches
    // ===========================
    for (const match of sofaLiveMatches) {
      if (!match.id) continue;

      const matchId = String(match.id);
      const homeTeam = match.homeTeam?.name || 'Unknown';
      const awayTeam = match.awayTeam?.name || 'Unknown';
      const homeScore = match.homeScore?.current ?? 0;
      const awayScore = match.awayScore?.current ?? 0;
      const homeTeamId = match.homeTeam?.id;
      const awayTeamId = match.awayTeam?.id;
      const tournament = match.tournament?.name || '';
      const statusCode = match.status?.code;

      // Track score changes for goal detection
      const prevScores = previousMatchScores.get(matchId);

      if (prevScores) {
        // 🔥 GOAL DETECTED — Home team
        if (homeScore > prevScores.homeScore) {
          const uniqueKey = `${matchId}_goal_home_${homeScore}`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.add(uniqueKey);
            eventsToEmit.push({
              matchId,
              type: 'goal',
              team: homeTeam,
              teamId: homeTeamId,
              against: awayTeam,
              score: `${homeScore} - ${awayScore}`,
              tournament,
              player: 'Unknown',
              minute: match.time?.currentPeriodStartTimestamp ? Math.floor((Date.now() / 1000 - match.time.currentPeriodStartTimestamp) / 60) : 0,
              createdAt: new Date(),
            });
          }
        }

        // 🔥 GOAL DETECTED — Away team
        if (awayScore > prevScores.awayScore) {
          const uniqueKey = `${matchId}_goal_away_${awayScore}`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.add(uniqueKey);
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
            processedEvents.add(uniqueKey);
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
            processedEvents.add(uniqueKey);
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

    // ===========================
    // 3. Process football-data.org matches (fallback for goal detection)
    // ===========================
    for (const match of fdMatches) {
      if (!match.id) continue;
      const matchId = `fd_${match.id}`;
      const prevScores = previousMatchScores.get(matchId);

      if (prevScores) {
        if (match.home?.score > prevScores.homeScore) {
          const uniqueKey = `${matchId}_goal_home_${match.home.score}`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.add(uniqueKey);
            eventsToEmit.push({
              matchId: String(match.id),
              type: 'goal',
              team: match.home.name,
              against: match.away.name,
              score: `${match.home.score} - ${match.away.score}`,
              player: 'Unknown',
              minute: 0,
              createdAt: new Date(),
            });
          }
        }
        if (match.away?.score > prevScores.awayScore) {
          const uniqueKey = `${matchId}_goal_away_${match.away.score}`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.add(uniqueKey);
            eventsToEmit.push({
              matchId: String(match.id),
              type: 'goal',
              team: match.away.name,
              against: match.home.name,
              score: `${match.home.score} - ${match.away.score}`,
              player: 'Unknown',
              minute: 0,
              createdAt: new Date(),
            });
          }
        }
      }
      previousMatchScores.set(matchId, {
        homeScore: match.home?.score ?? 0,
        awayScore: match.away?.score ?? 0,
        statusCode: 0,
      });
    }

    if (eventsToEmit.length === 0) return;

    // ===========================
    // 4. Broadcast to match rooms
    // ===========================
    eventsToEmit.forEach(event => {
      io.to(event.matchId).emit('liveEvent', event);
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
            io.to(userId).emit('notification', {
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

    logger.info(`⚡ Live events emitted: ${eventsToEmit.length} (Sofascore: ${sofaLiveMatches.length} live matches tracked)`);

  } catch (error) {
    logger.error(`❌ Live Events Error: ${error.message}`);
  }
};