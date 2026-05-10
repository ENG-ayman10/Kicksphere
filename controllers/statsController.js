/**
 * @file statsController.js
 * @description Stats endpoints — SportScore API → Firestore fallback.
 * Data: https://sportscore.com — "Powered by SportScore"
 */

const db = require('../config/firebase');
const {
  fetchTopScorers,
  fetchStandings,
  fetchMatchEvents,
  fetchLineupsFromAPI,
  LEAGUE_SLUGS,
} = require('../services/footballApi');
const logger = require('../utils/logger');

// ==========================================
// 📊 GET TOP PLAYERS (SportScore → Firestore)
// ==========================================
exports.getTopPlayers = async (req, res) => {
  try {
    const slug = req.query.league || 'premier-league';
    const limit = parseInt(req.query.limit) || 20;

    // Try SportScore
    const real = await fetchTopScorers(slug, limit);
    if (real && real.length > 0) {
      logger.info(`✅ Top Scorers: ${real.length} from SportScore`);
      return res.json({ success: true, source: 'sportscore', data: real });
    }

    // Fallback: Firestore
    logger.info('📦 Top Scorers: Firestore fallback');
    const snap = await db.collection('players').limit(30).get();
    const players = snap.docs.map((doc, i) => {
      const d = doc.data();
      return {
        rank: i + 1,
        name: d.name || 'Unknown',
        photo: d.photo || '',
        position: d.position || 'MF',
        team: d.team || 'Unknown',
        teamLogo: d.teamLogo || '',
        nationality: d.nationality || '',
        goals: d.goals || Math.floor(Math.random() * 25) + 1,
        assists: d.assists || Math.floor(Math.random() * 15),
        matches: d.matches || Math.floor(Math.random() * 30) + 10,
        rating: d.rating || (Math.random() * 2 + 7).toFixed(1),
      };
    });
    players.sort((a, b) => b.goals - a.goals);
    res.json({ success: true, source: 'firestore', data: players });
  } catch (error) {
    logger.error(`❌ TOP PLAYERS ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 📊 GET STANDINGS (SportScore → Firestore)
// ==========================================
exports.getTopTeams = async (req, res) => {
  try {
    const slug = req.query.league || 'premier-league';

    // Try SportScore
    const real = await fetchStandings(slug);
    if (real && real.length > 0) {
      logger.info(`✅ Standings: ${real.length} from SportScore`);
      return res.json({ success: true, source: 'sportscore', data: real });
    }

    // Fallback: Firestore
    logger.info('📦 Standings: Firestore fallback');
    const snap = await db.collection('teams').limit(20).get();
    const teams = snap.docs.map((doc, i) => {
      const d = doc.data();
      const played = d.played || Math.floor(Math.random() * 10) + 25;
      const won = d.won || Math.floor(played * 0.55);
      const drawn = d.drawn || Math.floor(played * 0.2);
      const lost = played - won - drawn;
      return {
        rank: i + 1,
        name: d.name || 'Unknown',
        logo: d.logo || '',
        played, won, drawn, lost,
        gf: d.gf || Math.floor(Math.random() * 40) + 20,
        ga: d.ga || Math.floor(Math.random() * 30) + 10,
        gd: 0,
        points: won * 3 + drawn,
      };
    });
    teams.sort((a, b) => b.points - a.points);
    teams.forEach((t, i) => (t.rank = i + 1));
    res.json({ success: true, source: 'firestore', data: teams });
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
    const leagues = Object.entries(LEAGUE_SLUGS).map(([slug, info]) => ({
      id: slug,
      slug,
      name: info.name,
      country: info.country,
      season: '2024-25',
      totalTeams: 20,
      matchesPlayed: 35,
    }));
    res.json({ success: true, data: leagues });
  } catch (error) {
    logger.error(`❌ LEAGUES ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// ⏱️ GET MATCH TIMELINE (SportScore → mock)
// ==========================================
exports.getMatchTimeline = async (req, res) => {
  try {
    const { id } = req.params;
    const slug = id.replace(/^(ss-|fb-)/, '');

    const events = await fetchMatchEvents(slug);
    if (events && events.length > 0) {
      logger.info(`✅ Timeline: ${events.length} events from SportScore`);
      return res.json({ success: true, source: 'sportscore', data: events });
    }

    // Fallback: generate mock
    logger.info('📦 Timeline: mock fallback');
    const types = [
      { type: 'goal', icon: '⚽', label: 'Goal' },
      { type: 'yellow_card', icon: '🟨', label: 'Yellow Card' },
      { type: 'substitution', icon: '🔄', label: 'Substitution' },
    ];
    const players = ['Mbappé', 'Haaland', 'Salah', 'Bellingham', 'Saka', 'Vinicius Jr', 'De Bruyne'];
    const count = Math.floor(Math.random() * 6) + 3;
    const mins = Array.from({ length: count }, () => Math.floor(Math.random() * 90) + 1).sort((a, b) => a - b);

    const timeline = mins.map(m => {
      const ev = types[Math.floor(Math.random() * types.length)];
      return { minute: m, ...ev, team: Math.random() < 0.5 ? 'Home' : 'Away', player: players[Math.floor(Math.random() * players.length)] };
    });
    res.json({ success: true, source: 'mock', data: timeline });
  } catch (error) {
    logger.error(`❌ TIMELINE ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 👥 GET MATCH LINEUPS (SportScore → mock)
// ==========================================
exports.getMatchLineups = async (req, res) => {
  try {
    const { id } = req.params;
    const slug = id.replace(/^(ss-|fb-)/, '');

    const lineups = await fetchLineupsFromAPI(slug);
    if (lineups) {
      logger.info(`✅ Lineups from SportScore`);
      return res.json({ success: true, source: 'sportscore', data: lineups });
    }

    // Fallback: mock
    logger.info('📦 Lineups: mock fallback');
    const pos = ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'];
    const home = ['Courtois', 'Carvajal', 'Militão', 'Rüdiger', 'Mendy', 'Valverde', 'Camavinga', 'Bellingham', 'Rodrygo', 'Vinicius Jr', 'Mbappé'];
    const away = ['Ederson', 'Walker', 'Dias', 'Akanji', 'Gvardiol', 'Rodri', 'De Bruyne', 'Silva', 'Foden', 'Grealish', 'Haaland'];
    const mk = (names) => pos.map((p, i) => ({ number: i + 1, name: names[i], position: p, isCaptain: i === 5 }));

    res.json({
      success: true, source: 'mock',
      data: { formation: { home: '4-3-3', away: '4-3-3' }, home: mk(home), away: mk(away) },
    });
  } catch (error) {
    logger.error(`❌ LINEUPS ERROR: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};
