/**
 * @file homeController.js
 * @description Home feed controller — returns live/today matches from football-data.org.
 */

const db = require('../config/firebase');
const sportscoreService = require('../services/sportscoreService');
const logger = require('../utils/logger');
const { isAdminUser } = require('../utils/auth');

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
    const todayMatches = await sportscoreService.getMatchesByDate('TODAY');
    const liveMatches = await sportscoreService.getLiveMatches();

    // Sort today's matches by priority
    const priority = ['CL', 'WC', 'EC', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'PPL', 'ELC', 'DED', 'BSA'];
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

    // Live = actually live matches, or today's priority matches if none live
    const live = liveMatches.length > 0 ? liveMatches.slice(0, 10) : todayMatches.slice(0, 5);

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
          preferredTeams = userDoc.data().preferences?.teams || [];
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
        .filter(m =>
          preferredTeams.some(team =>
            (m.homeTeam?.name || '').toLowerCase().includes(team.toLowerCase()) ||
            (m.awayTeam?.name || '').toLowerCase().includes(team.toLowerCase())
          )
        )
        .slice(0, 5);

      // Fallback: if no matches today, fetch recent + upcoming from SportScore
      if (recommended.length < 2) {
        try {
          const teamsToFetch = preferredTeams.slice(0, 3); // Limit to 3 to prevent timeouts
          const teamMatchPromises = teamsToFetch.map(teamName =>
            sportscoreService.getTeamMatches(teamName).catch(err => {
              logger.warn(`⚠️ Failed to fetch matches for ${teamName}: ${err.message}`);
              return { recent: [], upcoming: [] };
            })
          );

          const teamMatchResults = await Promise.all(teamMatchPromises);

          const sofascoreMatches = [];
          for (const result of teamMatchResults) {
            const allEvents = [...(result.recent || []).slice(-3), ...(result.upcoming || []).slice(0, 3)];
            for (const e of allEvents) {
              sofascoreMatches.push({
                id: e.id,
                utcDate: e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString() : '',
                status: e.status === 'Ended' ? 'FINISHED' : (e.status === 'Not started' ? 'TIMED' : (e.homeScore != null ? 'IN_PLAY' : 'TIMED')),
                matchday: null,
                stage: null,
                minute: null,
                competition: {
                  code: '',
                  name: e.tournament || '',
                  emblem: e.tournamentLogo || '',
                  country: '',
                  countryFlag: '',
                },
                homeTeam: {
                  id: e.homeTeamId,
                  name: e.homeTeam || '',
                  fullName: e.homeTeam || '',
                  crest: e.homeTeamLogo || '',
                },
                awayTeam: {
                  id: e.awayTeamId,
                  name: e.awayTeam || '',
                  fullName: e.awayTeam || '',
                  crest: e.awayTeamLogo || '',
                },
                score: {
                  winner: e.winnerCode === 1 ? 'HOME_TEAM' : (e.winnerCode === 2 ? 'AWAY_TEAM' : (e.winnerCode === 3 ? 'DRAW' : null)),
                  fullTime: { home: e.homeScore ?? null, away: e.awayScore ?? null },
                  halfTime: { home: null, away: null },
                },
              });
            }
          }

          // Deduplicate by ID and merge with existing recommended
          const existingIds = new Set(recommended.map(m => m.id));
          for (const m of sofascoreMatches) {
            if (!existingIds.has(m.id)) {
              recommended.push(m);
              existingIds.add(m.id);
            }
          }

          // Sort by date (upcoming first, then recent)
          recommended.sort((a, b) => {
            const dateA = new Date(a.utcDate || 0).getTime();
            const dateB = new Date(b.utcDate || 0).getTime();
            return dateB - dateA;
          });

          recommended = recommended.slice(0, 10);
          logger.info(`✅ Recommended (with Sofascore fallback): ${recommended.length} matches`);
        } catch (fallbackErr) {
          logger.warn(`⚠️ Sofascore recommended fallback error: ${fallbackErr.message}`);
        }
      }
    }

    // =========================
    // 🔥 RESPONSE
    // =========================
    res.json({
      success: true,
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
