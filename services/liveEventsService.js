/**
 * @file liveEventsService.js
 * @description Detects live match events (goals) by comparing scores
 * and sends notifications to subscribed users.
 */

const db = require('../config/firebase');
const { fetchMatchesFromAPI } = require('./footballApi');
const { saveNotification } = require('./notificationService');
const { sendPushNotification } = require('./pushNotificationService');
const logger = require('../utils/logger');

// لتجنب تكرار نفس الحدث
const processedEvents = new Set();
const MAX_PROCESSED_EVENTS = 10000;

// آخر بيانات محفوظة للمقارنة
const previousMatchScores = new Map();
const MAX_TRACKED_MATCHES = 500;

// 🔥 تنظيف الأحداث القديمة لمنع تسرّب الذاكرة
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

// 🔥 تنظيف previousMatchScores لمنع تسرّب الذاكرة
const cleanupPreviousScores = () => {
  if (previousMatchScores.size > MAX_TRACKED_MATCHES) {
    const toDelete = Math.floor(previousMatchScores.size / 2);
    let count = 0;

    for (const [key] of previousMatchScores) {
      if (count >= toDelete) break;
      previousMatchScores.delete(key);
      count++;
    }

    logger.info(`🧹 Cleaned ${count} old match scores (remaining: ${previousMatchScores.size})`);
  }
};

// ==========================================
// 🔥 EMIT REAL EVENTS
// ==========================================
exports.emitLiveEvents = async (io) => {
  try {
    // 🧹 تنظيف الذاكرة
    cleanupProcessedEvents();
    cleanupPreviousScores();

    // =========================
    // 🔥 جلب المباريات الحية
    // =========================
    let liveMatches = [];

    try {
      liveMatches = await fetchMatchesFromAPI();
    } catch (err) {
      // لو الـ API فشل، نقرأ من الكاش
      const snapshot = await db.collection('matches')
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get();

      liveMatches = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: data.matchId,
          home: { name: data.homeTeam, score: data.homeScore ?? 0 },
          away: { name: data.awayTeam, score: data.awayScore ?? 0 },
          leagueId: data.league,
          status: data.status
        };
      });
    }

    if (liveMatches.length === 0) return;

    const eventsToEmit = [];

    // =========================
    // 🔥 مقارنة النتائج (كشف الأهداف)
    // =========================
    for (const match of liveMatches) {
      if (!match.id) continue;

      const prevScores = previousMatchScores.get(match.id);

      if (prevScores) {
        // 🔥 هدف للفريق المضيف
        if (match.home.score > prevScores.homeScore) {
          const event = {
            matchId: String(match.id),
            type: "goal",
            team: match.home.name,
            player: "Unknown",
            minute: 0,
            createdAt: new Date()
          };

          const uniqueKey = `${match.id}_goal_home_${match.home.score}`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.add(uniqueKey);
            eventsToEmit.push(event);
          }
        }

        // 🔥 هدف للفريق الضيف
        if (match.away.score > prevScores.awayScore) {
          const event = {
            matchId: String(match.id),
            type: "goal",
            team: match.away.name,
            player: "Unknown",
            minute: 0,
            createdAt: new Date()
          };

          const uniqueKey = `${match.id}_goal_away_${match.away.score}`;
          if (!processedEvents.has(uniqueKey)) {
            processedEvents.add(uniqueKey);
            eventsToEmit.push(event);
          }
        }
      }

      // حفظ النتيجة الحالية للمقارنة القادمة
      previousMatchScores.set(match.id, {
        homeScore: match.home.score,
        awayScore: match.away.score
      });
    }

    if (eventsToEmit.length === 0) return;

    // =========================
    // 🔥 حفظ في Firestore
    // =========================
    const batch = db.batch();

    eventsToEmit.forEach(event => {
      const ref = db.collection('events').doc();
      batch.set(ref, event);
    });

    await batch.commit();

    // =========================
    // 🔥 بث لكل مباراة
    // =========================
    eventsToEmit.forEach(event => {
      io.to(event.matchId).emit('liveEvent', event);
    });

    // =========================
    // 🔥 Notifications — only query users with matching team preferences
    // Instead of fetching ALL users, we query by preferred teams
    // =========================
    const eventTeams = [...new Set(eventsToEmit.map(e => e.team))];

    // Query users who have at least one matching team in preferences
    // Firestore array-contains can only check one value at a time
    for (const teamName of eventTeams) {
      try {
        const usersSnapshot = await db.collection('users')
          .where('preferences.teams', 'array-contains', teamName)
          .limit(100)
          .get();

        const teamEvents = eventsToEmit.filter(e => e.team === teamName);

        for (const userDoc of usersSnapshot.docs) {
          const user = userDoc.data();
          const userId = userDoc.id;

          const ev = teamEvents[0];
          const title = "⚽ Live Event";
          const message = `${ev.team} scored! 🎉`;

          await saveNotification(userId, {
            title,
            message,
            matchId: ev.matchId,
            type: ev.type
          });

          io.to(userId).emit('notification', {
            title,
            message,
            matchId: ev.matchId
          });

          if (user.fcmToken) {
            await sendPushNotification(user.fcmToken, title, message);
          }
        }
      } catch (err) {
        logger.error(`❌ Notification query error for team ${teamName}: ${err.message}`);
      }
    }

    logger.info(`⚽ Real events sent: ${eventsToEmit.length}`);

  } catch (error) {
    logger.error(`❌ Live Events Error: ${error.message}`);
  }
};