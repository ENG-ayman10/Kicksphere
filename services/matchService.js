/**
 * @file matchService.js
 * @description Service layer for match data — handles caching, API calls, and pagination.
 */

const db = require('../config/firebase');
const { fetchMatchesFromAPI } = require('./footballApi');
const logger = require('../utils/logger');

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const BATCH_LIMIT = 500; // Firestore batch limit

/**
 * Helper: Commit batched operations in chunks of 500 (Firestore limit).
 */
const batchWrite = async (refs, operation) => {
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const chunk = refs.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach(item => operation(batch, item));
    await batch.commit();
  }
};

exports.getMatchesService = async (query) => {

  let matches = [];

  // =========================
  // 🔥 VALIDATION
  // =========================
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit) || 10));

  const team = query.team?.toLowerCase();

  // =========================
  // 🔥 CACHE CHECK
  // =========================
  const lastDocSnap = await db.collection('matches')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  let useCache = false;

  if (!lastDocSnap.empty) {
    const lastData = lastDocSnap.docs[0].data();
    const lastTime = lastData.createdAt?.toDate
      ? lastData.createdAt.toDate().getTime()
      : new Date(lastData.createdAt).getTime();

    if (Date.now() - lastTime < CACHE_TTL) {
      useCache = true;
    }
  }

  // =========================
  // 🔥 FETCH DATA
  // =========================
  if (!useCache) {
    try {
      logger.info("🌐 Fetching fresh match data from API...");

      const apiData = await fetchMatchesFromAPI();

      if (apiData.length > 0) {
        // ❌ Delete old matches (in safe chunks of 500)
        const oldDocs = await db.collection('matches').get();
        const oldRefs = oldDocs.docs.map(doc => doc.ref);
        await batchWrite(oldRefs, (batch, ref) => batch.delete(ref));

        // ✅ Save new matches (in safe chunks of 500)
        const newMatchDocs = apiData.map(match => ({
          matchId: match.id,
          homeTeam: match.home.name,
          awayTeam: match.away.name,
          homeScore: match.home.score ?? 0,
          awayScore: match.away.score ?? 0,
          league: match.leagueId,
          status: match.status?.liveTime?.short || "",
          team: match.home.name,
          createdAt: new Date()
        }));

        await batchWrite(newMatchDocs, (batch, data) => {
          const ref = db.collection('matches').doc();
          batch.set(ref, data);
        });

        matches = apiData;
      } else {
        logger.warn("⚠️ API returned empty → using cache");
        useCache = true;
      }

    } catch (err) {
      logger.warn(`⚠️ API failed → fallback to DB: ${err.message}`);
      useCache = true;
    }
  }

  if (useCache) {
    const snapshot = await db.collection('matches')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    matches = snapshot.docs.map(doc => doc.data());
  }

  // =========================
  // 🔥 CLEAN DATA
  // =========================
  let cleaned = matches.map(m => ({
    id: m.matchId || m.id || null,
    home: {
      name: m.homeTeam || m.home?.name,
      score: m.homeScore ?? m.home?.score ?? 0
    },
    away: {
      name: m.awayTeam || m.away?.name,
      score: m.awayScore ?? m.away?.score ?? 0
    },
    league: m.league || m.leagueId,
    status: m.status,
    team: m.team || m.homeTeam || m.home?.name,
    createdAt: m.createdAt || new Date()
  }));

  // =========================
  // 🔥 FILTER (searches both home and away)
  // =========================
  if (team) {
    cleaned = cleaned.filter(m =>
      (m.team || '').toLowerCase().includes(team) ||
      (m.away?.name || '').toLowerCase().includes(team)
    );
  }

  // =========================
  // 🔥 SORT
  // =========================
  cleaned.sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );

  // =========================
  // 🔥 PAGINATION
  // =========================
  const start = (page - 1) * limit;
  const data = cleaned.slice(start, start + limit);

  return {
    total: cleaned.length,
    page,
    limit,
    data
  };
};