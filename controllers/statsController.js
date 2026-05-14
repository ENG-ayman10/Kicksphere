/**
 * @file statsController.js
 * @description Stats endpoints — football-data.org v4 API.
 */

const {
  fetchTopScorers,
  fetchStandings,
  fetchMatchDetails,
  COMPETITIONS,
} = require('../services/footballApi');
const sofascoreService = require('../services/sofascoreService');
const logger = require('../utils/logger');

// ==========================================
// 📊 GET TOP PLAYERS (Scorers)
// ==========================================
exports.getTopPlayers = async (req, res) => {
  try {
    const league = req.query.league || 'PL';
    const limit = parseInt(req.query.limit) || 20;

    const data = await fetchTopScorers(league, limit);
    
    if (data && data.length > 0) {
      logger.info(`✅ Top Scorers: ${data.length} from football-data.org`);
      return res.json({ success: true, source: 'football-data.org', data });
    }

    // Empty fallback
    res.json({ success: true, source: 'empty', data: [] });
  } catch (error) {
    logger.error(`❌ TOP PLAYERS ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 📊 GET STANDINGS
// ==========================================
exports.getTopTeams = async (req, res) => {
  try {
    const league = req.query.league || 'PL';

    const data = await fetchStandings(league);
    
    if (data && data.length > 0) {
      logger.info(`✅ Standings: ${data.length} from football-data.org`);
      return res.json({ success: true, source: 'football-data.org', data });
    }

    res.json({ success: true, source: 'empty', data: [] });
  } catch (error) {
    logger.error(`❌ STANDINGS ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 📊 GET LEAGUES
// ==========================================
exports.getLeaguesStandings = async (req, res) => {
  try {
    const leagues = Object.entries(COMPETITIONS).map(([code, info]) => ({
      id: code,
      code,
      name: info.name,
      country: info.country,
      flag: info.flag,
    }));
    res.json({ success: true, data: leagues });
  } catch (error) {
    logger.error(`❌ LEAGUES ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// ⏱️ GET MATCH TIMELINE (goals, cards, subs from match details)
// ==========================================
exports.getMatchTimeline = async (req, res) => {
  try {
    const { id } = req.params;
    const details = await fetchMatchDetails(id);
    
    if (!details) {
      return res.json({ success: true, source: 'empty', data: [] });
    }

    // Build timeline from goals + bookings + substitutions
    const timeline = [];

    for (const g of (details.goals || [])) {
      timeline.push({
        minute: g.minute,
        type: 'goal',
        icon: '⚽',
        label: g.type === 'PENALTY' ? 'Penalty Goal' : 'Goal',
        team: g.team,
        player: g.scorer,
        assist: g.assist,
      });
    }

    for (const b of (details.bookings || [])) {
      timeline.push({
        minute: b.minute,
        type: b.card === 'RED' ? 'red_card' : 'yellow_card',
        icon: b.card === 'RED' ? '🟥' : '🟨',
        label: b.card === 'RED' ? 'Red Card' : 'Yellow Card',
        team: b.team,
        player: b.player,
      });
    }

    for (const s of (details.substitutions || [])) {
      timeline.push({
        minute: s.minute,
        type: 'substitution',
        icon: '🔄',
        label: 'Substitution',
        team: s.team,
        player: s.playerIn,
        playerOut: s.playerOut,
      });
    }

    // Sort by minute
    timeline.sort((a, b) => (a.minute || 0) - (b.minute || 0));

    res.json({ success: true, source: 'football-data.org', data: timeline });
  } catch (error) {
    logger.error(`❌ TIMELINE ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 👥 GET MATCH LINEUPS
// ==========================================
exports.getMatchLineups = async (req, res) => {
  try {
    const { id } = req.params;
    const details = await fetchMatchDetails(id);

    if (!details || (!details.homeTeam.lineup.length && !details.awayTeam.lineup.length)) {
      // Return empty - lineups not available (free tier limitation)
      return res.json({
        success: true,
        source: 'unavailable',
        data: {
          message: 'Lineups not available for this match',
          formation: { home: details?.homeTeam?.formation || '4-3-3', away: details?.awayTeam?.formation || '4-3-3' },
          home: details?.homeTeam?.lineup || [],
          away: details?.awayTeam?.lineup || [],
        },
      });
    }

    res.json({
      success: true,
      source: 'football-data.org',
      data: {
        formation: {
          home: details.homeTeam.formation || '4-3-3',
          away: details.awayTeam.formation || '4-3-3',
        },
        homeCoach: details.homeTeam.coach,
        awayCoach: details.awayTeam.coach,
        home: details.homeTeam.lineup,
        away: details.awayTeam.lineup,
        homeBench: details.homeTeam.bench,
        awayBench: details.awayTeam.bench,
      },
    });
  } catch (error) {
    logger.error(`❌ LINEUPS ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 🚀 DEEP STATS (RAPIDAPI)
// ==========================================

exports.getDeepTeamDetails = async (req, res) => {
  try {
    const teamId = req.params.id;
    // Fetch team details and matches in parallel for speed
    const [teamDetails, teamMatches] = await Promise.all([
      sofascoreService.getTeamDetails(teamId),
      sofascoreService.getTeamMatches(teamId),
    ]);
    
    // Automatically fetch standings and overall statistics for the current season
    const teamStandingsAndStats = await sofascoreService.getTeamStandingsAndStats(teamId);
    
    if (!teamDetails) {
      return res.status(404).json({ success: false, message: 'Team details not found' });
    }

    return res.json({
      success: true,
      data: {
        info: teamDetails.team,
        squad: teamDetails.squad,
        standing: teamStandingsAndStats?.standing,
        stats: teamStandingsAndStats?.statistics,
        tournament: teamStandingsAndStats?.tournament,
        season: teamStandingsAndStats?.season,
        matches: teamMatches,
      }
    });
  } catch (error) {
    logger.error(`getDeepTeamDetails Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getDeepPlayerDetails = async (req, res) => {
  try {
    const playerId = req.params.id;
    const playerDetails = await sofascoreService.getPlayerDetails(playerId);
    
    if (!playerDetails) {
      return res.status(404).json({ success: false, message: 'Player details not found' });
    }

    return res.json({
      success: true,
      data: playerDetails
    });
  } catch (error) {
    logger.error(`getDeepPlayerDetails Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getAllCompetitions = async (req, res) => {
  try {
    const competitions = await sofascoreService.getAllLeagues();
    return res.json({
      success: true,
      data: competitions
    });
  } catch (error) {
    logger.error(`getAllCompetitions Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getMatchDeepStats = async (req, res) => {
  try {
    const matchId = req.params.id;
    const details = await fetchMatchDetails(matchId);

    if (!details) {
      return res.json({ success: true, source: 'empty', data: null });
    }

    // Build a comprehensive match data payload
    const goals = details.goals || [];
    const bookings = details.bookings || [];
    const substitutions = details.substitutions || [];
    const referees = details.referees || [];

    // Derive statistics from the match data we have
    const homeGoals = goals.filter(g => g.team === details.homeTeam.name || g.team === details.homeTeam.fullName).length;
    const awayGoals = goals.filter(g => g.team === details.awayTeam.name || g.team === details.awayTeam.fullName).length;
    const homeYellows = bookings.filter(b => (b.team === details.homeTeam.name || b.team === details.homeTeam.fullName) && b.card === 'YELLOW').length;
    const awayYellows = bookings.filter(b => (b.team === details.awayTeam.name || b.team === details.awayTeam.fullName) && b.card === 'YELLOW').length;
    const homeReds = bookings.filter(b => (b.team === details.homeTeam.name || b.team === details.homeTeam.fullName) && b.card === 'RED').length;
    const awayReds = bookings.filter(b => (b.team === details.awayTeam.name || b.team === details.awayTeam.fullName) && b.card === 'RED').length;
    const homeSubs = substitutions.filter(s => s.team === details.homeTeam.name || s.team === details.homeTeam.fullName).length;
    const awaySubs = substitutions.filter(s => s.team === details.awayTeam.name || s.team === details.awayTeam.fullName).length;

    return res.json({
      success: true,
      source: 'football-data.org',
      data: {
        // Full match info for Details tab
        matchInfo: {
          competition: details.competition,
          utcDate: details.utcDate,
          status: details.status,
          matchday: details.matchday,
          stage: details.stage,
          venue: details.venue,
          attendance: details.attendance,
          referees: referees,
          score: details.score,
          homeTeam: {
            id: details.homeTeam.id,
            name: details.homeTeam.name,
            fullName: details.homeTeam.fullName,
            crest: details.homeTeam.crest,
            coach: details.homeTeam.coach,
            formation: details.homeTeam.formation,
          },
          awayTeam: {
            id: details.awayTeam.id,
            name: details.awayTeam.name,
            fullName: details.awayTeam.fullName,
            crest: details.awayTeam.crest,
            coach: details.awayTeam.coach,
            formation: details.awayTeam.formation,
          },
        },
        // Key events for Details tab
        goals: goals,
        bookings: bookings,
        substitutions: substitutions,
        // Match statistics
        statistics: {
          goals: { home: homeGoals, away: awayGoals },
          yellowCards: { home: homeYellows, away: awayYellows },
          redCards: { home: homeReds, away: awayReds },
          substitutions: { home: homeSubs, away: awaySubs },
          halfTimeScore: details.score?.halfTime || { home: 0, away: 0 },
          fullTimeScore: details.score?.fullTime || { home: 0, away: 0 },
        },
        // H2H data
        head2head: details.head2head || null,
      }
    });
  } catch (error) {
    logger.error(`getMatchDeepStats Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};
