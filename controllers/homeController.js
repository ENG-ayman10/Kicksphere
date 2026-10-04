/**
 * @file homeController.js
 * @description Home feed with provider-scoped favorites and observed live matches.
 */

const db = require('../config/firebase');
const sportscoreService = require('../services/sportscoreService');
const logger = require('../utils/logger');
const { isAdminUser } = require('../utils/auth');
const { favoriteTeamIds, matchTeamId } = require('../utils/teamIdentity');
const { teamIdentityIds } = require('../utils/matchProviderIdentities');
const kickoffApiService = require('../services/kickoffApiService');
const bsdSportsService = require('../services/bsdSportsService');
const sportsDataService = require('../services/sportsDataService');

// ==========================================
// 🔥 HOME API
// ==========================================
exports.getHome = async (req, res) => {
  try {
    const requestedUserId = typeof req.query.userId === 'string'
      ? req.query.userId.trim()
      : '';
    const authenticatedUserId = req.user?.id ? String(req.user.id) : '';

    if (requestedUserId && !authenticatedUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required for personalized home feed.'
      });
    }

    if (requestedUserId && requestedUserId !== authenticatedUserId && !isAdminUser(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to access this user home feed.'
      });
    }

    const userId = requestedUserId || authenticatedUserId;

    // =========================
    // 🔥 1. FETCH TODAY'S MATCHES FROM API
    // =========================
    const useBsd = typeof bsdSportsService.isConfigured === 'function' && bsdSportsService.isConfigured();
    const provider = useBsd ? sportsDataService : sportscoreService;
    const snapshots = await Promise.allSettled([
      provider.getMatchesByDate('TODAY'), provider.getLiveMatches()
    ]);
    const readSnapshot = settled => {
      if (settled.status !== 'fulfilled') return null;
      if (Array.isArray(settled.value)) return { data: settled.value, source: 'sportscore' };
      return settled.value?.success === true && Array.isArray(settled.value.data) &&
        settled.value.coverage?.available !== false && settled.value.source !== 'unavailable' ? settled.value : null;
    };
    const daySnapshot = readSnapshot(snapshots[0]);
    const liveSnapshot = readSnapshot(snapshots[1]);
    if (!daySnapshot && !liveSnapshot) {
      return res.status(503).json({ success: false, source: 'unavailable', message: 'Home data providers unavailable.' });
    }
    const todayMatches = [...(daySnapshot?.data || [])];
    const liveMatches = [...(liveSnapshot?.data || [])].filter(match =>
      ['IN_PLAY', 'PAUSED'].includes(match.status));

    // Sort today's matches by priority
    const priority = ['CL', 'EL', 'ECL', 'WC', 'EC', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'SPL', 'PPL', 'DED', 'BSA', 'ELC', 'TSL', 'MLS', 'LMX', 'CLI'];
    todayMatches.sort((a, b) => {
      const aRank = priority.indexOf(a.competition?.code) !== -1 ? priority.indexOf(a.competition.code) : 99;
      const bRank = priority.indexOf(b.competition?.code) !== -1 ? priority.indexOf(b.competition.code) : 99;
      return aRank - bRank;
    });

    liveMatches.sort((a, b) => {
      const aRank = priority.indexOf(a.competition?.code) !== -1 ? priority.indexOf(a.competition.code) : 99;
      const bRank = priority.indexOf(b.competition?.code) !== -1 ? priority.indexOf(b.competition.code) : 99;
      return aRank - bRank;
    });

    const live = liveMatches.slice(0, 10);

    // Top Matches = top 10 matches by priority
    const topMatches = todayMatches.slice(0, 10);

    // Events = all today's matches sorted by priority
    const events = todayMatches;

    // =========================
    // 🔥 2. USER PREFERENCES
    // =========================
    let preferredTeams = [];

    if (userId) {
      try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
          const preferences = userDoc.data().preferences || {};
          preferredTeams = favoriteTeamIds([...(preferences.teamIds || []), ...(preferences.teamsV2 || [])]);
        }
      } catch (e) {
        logger.warn(`⚠️ Could not fetch user preferences: ${e.message}`);
      }
    }

    // =========================
    // 🔥 3. RECOMMENDED
    // =========================
    let recommended = [];

    if (preferredTeams.length > 0) {
      // First: try to find favorite teams in today's matches
      recommended = todayMatches
        .filter(m => [matchTeamId(m.homeTeam, m.source || 'sportscore'),
          matchTeamId(m.awayTeam, m.source || 'sportscore'), ...teamIdentityIds(m)]
          .some(teamId => teamId && preferredTeams.includes(teamId)))
        .slice(0, 5);

      // Fallback: if no matches today, fetch recent + upcoming from SportScore
      if (recommended.length < 2) {
        try {
          const teamsToFetch = preferredTeams.slice(0, 3); // Limit to 3 to prevent timeouts
          const teamDetailPromises = teamsToFetch.map(async teamId => {
            try {
              if (teamId.startsWith('ko_t_')) {
                return { matches: await kickoffApiService.getTeamFixtures(teamId) };
              }
              if (teamId.startsWith('bsd_t_')) return await bsdSportsService.getTeamDetails(teamId);
              return await sportscoreService.getTeamDetails(teamId.slice(5));
            } catch (err) {
              logger.warn(`⚠️ Failed to fetch favorite team details: ${err.message}`);
              return null;
            }
          });

          const teamDetailResults = await Promise.all(teamDetailPromises);

          const fetchedMatches = [];
          for (const result of teamDetailResults) {
            if (!result?.matches) continue;
            const matches = [...(result.matches.recent || []).slice(-3), ...(result.matches.upcoming || []).slice(0, 3)];
            fetchedMatches.push(...matches);
          }

          // Deduplicate by ID and merge with existing recommended
          const existingIds = new Set(recommended.map(m => m.id));
          for (const m of fetchedMatches) {
            if (m?.id && !existingIds.has(m.id)) {
              recommended.push(m);
              existingIds.add(m.id);
            }
          }

          // Put live matches first, then the nearest available upcoming fixture.
          const now = Date.now();
          const matchOrder = match => {
            const date = Date.parse(match.utcDate);
            if (['IN_PLAY', 'PAUSED'].includes(match.status)) return { rank: 0, date: Number.isFinite(date) ? date : now };
            if (!Number.isFinite(date)) return { rank: 3, date: 0 };
            return { rank: date >= now ? 1 : 2, date };
          };
          recommended.sort((a, b) => {
            const left = matchOrder(a), right = matchOrder(b);
            return left.rank - right.rank || (left.rank === 2 ? right.date - left.date : left.date - right.date);
          });

          recommended = recommended.slice(0, 10);
          logger.info(`✅ Recommended matches loaded: ${recommended.length} matches`);
        } catch (fallbackErr) {
          logger.warn(`⚠️ Recommended fallback error: ${fallbackErr.message}`);
        }
      }
    }

    // =========================
    // 🔥 RESPONSE
    // =========================
    res.json({
      success: true,
      source: [...new Set([daySnapshot?.source, liveSnapshot?.source].filter(Boolean))].join('+'),
      coverage: { today: daySnapshot?.coverage || { available: !!daySnapshot },
        live: liveSnapshot?.coverage || { available: !!liveSnapshot } },
      data: {
        live,
        topMatches,
        recommended,
        events,
      },
    });
  } catch (error) {
    logger.error(`❌ HOME ERROR: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Server Error',
    });
  }
};
