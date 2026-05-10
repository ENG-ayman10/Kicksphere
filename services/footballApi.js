/**
 * @file footballApi.js
 * @description Football data service — serves data INSTANTLY.
 * SportScore API is tried in background to fill cache for next request.
 * https://sportscore.com — "Powered by SportScore"
 */

const axios = require('axios');
const logger = require('../utils/logger');

const BASE = 'https://sportscore.com/api/widget';
const SRC = 'kicksphere-app';

// ==========================================
// 🔄 CACHE SYSTEM
// ==========================================
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function getCached(key) {
  const e = cache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

// Background fetch — does NOT block the response
function bgFetch(endpoint, params = {}) {
  params.src = SRC;
  const key = `${endpoint}:${JSON.stringify(params)}`;
  if (getCached(key)) return; // already cached

  axios.get(`${BASE}${endpoint}`, { params, timeout: 5000, headers: { Accept: 'application/json' } })
    .then(({ data }) => {
      setCache(key, data);
      logger.info(`✅ BG: SportScore ${endpoint} cached`);
    })
    .catch(() => {});
}

// Sync cached fetch — returns cached data or null INSTANTLY
function getCachedData(endpoint, params = {}) {
  params.src = SRC;
  const key = `${endpoint}:${JSON.stringify(params)}`;
  const cached = getCached(key);

  // Always trigger background refresh
  bgFetch(endpoint, params);

  return cached;
}

// ==========================================
// 🏆 LEAGUE SLUGS (Matching SportScore Docs)
// ==========================================
const LEAGUE_SLUGS = {
  'premier-league': { name: 'Premier League', country: 'England' },
  'la-liga': { name: 'La Liga', country: 'Spain' },
  'serie-a': { name: 'Serie A', country: 'Italy' },
  'ligue-1': { name: 'Ligue 1', country: 'France' },
  'uefa-champions-league': { name: 'Champions League', country: 'Europe' },
};

// ==========================================
// 🏟️ RICH FALLBACK DATA (If API fails & Firestore empty)
// ==========================================
const MOCK_STANDINGS = [
  { rank: 1, name: 'Arsenal', logo: 'https://crests.football-data.org/57.png', played: 28, won: 20, drawn: 4, lost: 4, gf: 70, ga: 24, gd: 46, points: 64 },
  { rank: 2, name: 'Liverpool', logo: 'https://crests.football-data.org/64.png', played: 28, won: 19, drawn: 7, lost: 2, gf: 65, ga: 26, gd: 39, points: 64 },
  { rank: 3, name: 'Manchester City', logo: 'https://crests.football-data.org/65.png', played: 28, won: 19, drawn: 6, lost: 3, gf: 63, ga: 28, gd: 35, points: 63 },
  { rank: 4, name: 'Aston Villa', logo: 'https://crests.football-data.org/58.png', played: 28, won: 17, drawn: 4, lost: 7, gf: 59, ga: 41, gd: 18, points: 55 },
  { rank: 5, name: 'Tottenham', logo: 'https://crests.football-data.org/73.png', played: 27, won: 16, drawn: 5, lost: 6, gf: 59, ga: 39, gd: 20, points: 53 },
];

const MOCK_SCORERS = [
  { rank: 1, name: 'Erling Haaland', photo: 'https://img.thesports.com/football/player/51b72775cb5201281213c806ec0a2850.png', team: 'Manchester City', goals: 18, assists: 5, rating: 8.2 },
  { rank: 2, name: 'Ollie Watkins', photo: 'https://img.thesports.com/football/player/03b9b479bd39690f055bd4424dc488b3.png', team: 'Aston Villa', goals: 16, assists: 10, rating: 7.9 },
  { rank: 3, name: 'Mohamed Salah', photo: 'https://img.thesports.com/football/player/b1db5d5c18c4c3e3870624bdc49d6dae.png', team: 'Liverpool', goals: 15, assists: 9, rating: 8.0 },
  { rank: 4, name: 'Son Heung-Min', photo: 'https://img.thesports.com/football/player/8643888bdba6ee9ceea226dbddcaeb4c.png', team: 'Tottenham', goals: 14, assists: 8, rating: 7.8 },
  { rank: 5, name: 'Bukayo Saka', photo: 'https://img.thesports.com/football/player/729e2f41656b2e3cc0af18274a27546a.png', team: 'Arsenal', goals: 13, assists: 8, rating: 7.7 },
];
const LIVE_MATCHES = [
  {
    id: 'match-rm-mc', slug: 'real-madrid-vs-manchester-city',
    home: { name: 'Real Madrid', score: 2, logo: 'https://crests.football-data.org/86.png' },
    away: { name: 'Manchester City', score: 1, logo: 'https://crests.football-data.org/65.png' },
    leagueId: 'UEFA Champions League', leagueLogo: '',
    status: { liveTime: { short: "67'" } },
  },
  {
    id: 'match-bar-bay', slug: 'barcelona-vs-bayern-munich',
    home: { name: 'Barcelona', score: 1, logo: 'https://crests.football-data.org/81.png' },
    away: { name: 'Bayern Munich', score: 1, logo: 'https://crests.football-data.org/5.png' },
    leagueId: 'UEFA Champions League', leagueLogo: '',
    status: { liveTime: { short: "34'" } },
  },
  {
    id: 'match-liv-che', slug: 'liverpool-vs-chelsea',
    home: { name: 'Liverpool', score: 3, logo: 'https://crests.football-data.org/64.png' },
    away: { name: 'Chelsea', score: 2, logo: 'https://crests.football-data.org/61.png' },
    leagueId: 'Premier League', leagueLogo: '',
    status: { liveTime: { short: "55'" } },
  },
  {
    id: 'match-ars-tot', slug: 'arsenal-vs-tottenham',
    home: { name: 'Arsenal', score: 2, logo: 'https://crests.football-data.org/57.png' },
    away: { name: 'Tottenham', score: 0, logo: 'https://crests.football-data.org/73.png' },
    leagueId: 'Premier League', leagueLogo: '',
    status: { liveTime: { short: "72'" } },
  },
  {
    id: 'match-psg-inter', slug: 'psg-vs-inter-milan',
    home: { name: 'PSG', score: 1, logo: 'https://crests.football-data.org/524.png' },
    away: { name: 'Inter Milan', score: 1, logo: 'https://crests.football-data.org/108.png' },
    leagueId: 'Ligue 1', leagueLogo: '',
    status: { liveTime: { short: "88'" } },
  },
  {
    id: 'match-juv-nap', slug: 'juventus-vs-napoli',
    home: { name: 'Juventus', score: 0, logo: 'https://crests.football-data.org/109.png' },
    away: { name: 'Napoli', score: 2, logo: 'https://crests.football-data.org/113.png' },
    leagueId: 'Serie A', leagueLogo: '',
    status: { liveTime: { short: "41'" } },
  },
  {
    id: 'match-manu-new', slug: 'manchester-united-vs-newcastle',
    home: { name: 'Manchester United', score: 1, logo: 'https://crests.football-data.org/66.png' },
    away: { name: 'Newcastle', score: 1, logo: 'https://crests.football-data.org/67.png' },
    leagueId: 'Premier League', leagueLogo: '',
    status: { liveTime: { short: "15'" } },
  },
];

// ==========================================
// 🔥 FETCH MATCHES — INSTANT response
// ==========================================
exports.fetchMatchesFromAPI = async () => {
  // Check cache first (instant)
  const cached = getCachedData('/matches/', { sport: 'football', limit: 20 });

  if (cached && cached.matches && cached.matches.length > 0) {
    logger.info(`📦 Cache: ${cached.matches.length} matches`);
    return cached.matches.map((m, i) => {
      const slug = m.url?.replace('/football/match/', '').replace(/\/$/, '') || `match-${i}`;
      return {
        id: `ss-${slug}`, slug,
        home: { name: m.home, score: m.home_score ?? 0, logo: m.home_logo || '' },
        away: { name: m.away, score: m.away_score ?? 0, logo: m.away_logo || '' },
        leagueId: m.competition || '', leagueLogo: m.competition_logo || '',
        status: { liveTime: { short: m.status_text || m.status || 'SCH' } },
      };
    });
  }

  // Return fallback instantly
  return LIVE_MATCHES;
};

// ==========================================
// 📊 FETCH TOP SCORERS
// ==========================================
exports.fetchTopScorers = async (leagueSlug = 'premier-league', limit = 20) => {
  const cached = getCachedData('/topscorers/', { sport: 'football', slug: leagueSlug, limit });
  if (cached && cached.scorers && cached.scorers.length > 0) {
    return cached.scorers.map((p, i) => ({
      rank: p.rank || i + 1,
      name: p.player || 'Unknown',
      photo: p.player_logo || '',
      team: p.team || '',
      teamLogo: p.team_logo || '',
      slug: p.player_slug || '',
      goals: p.goals || 0,
      assists: p.assists || 0,
      matches: p.matches || 0,
      minutes: p.minutes || 0,
      nationality: '',
    }));
  }
  // Return fallback instantly
  logger.info(`📦 Mock: Returning Top Scorers for ${leagueSlug}`);
  return [
    { rank: 1, name: 'E. Haaland', team: 'Man City', goals: 25, assists: 5, matches: 28, rating: '8.9' },
    { rank: 2, name: 'M. Salah', team: 'Liverpool', goals: 18, assists: 9, matches: 29, rating: '8.5' },
    { rank: 3, name: 'B. Saka', team: 'Arsenal', goals: 15, assists: 10, matches: 28, rating: '8.4' }
  ];
};

// ==========================================
// 📊 FETCH STANDINGS
// ==========================================
exports.fetchStandings = async (leagueSlug = 'premier-league') => {
  const cached = getCachedData('/standings/', { sport: 'football', slug: leagueSlug });
  
  if (cached) {
    const groups = cached.tables || cached.standings || [];
    if (groups && groups.length > 0) {
      const allRows = [];
      for (const group of groups) {
        if (group.rows) allRows.push(...group.rows);
      }

      if (allRows.length > 0) {
        return allRows.map(t => ({
          rank: t.pos, name: t.team, logo: t.team_logo || '', slug: t.team_slug || '',
          played: t.p || 0, won: t.w || 0, drawn: t.d || 0, lost: t.l || 0,
          gf: t.gf || 0, ga: t.ga || 0, gd: t.gd || 0, points: t.pts || 0,
        }));
      }
    }
  }

  // Return fallback instantly
  logger.info(`📦 Mock: Returning Standings for ${leagueSlug}`);
  return [
    { rank: 1, name: 'Arsenal', played: 30, won: 22, drawn: 5, lost: 3, gf: 65, ga: 20, gd: 45, points: 71 },
    { rank: 2, name: 'Liverpool', played: 30, won: 21, drawn: 6, lost: 3, gf: 68, ga: 25, gd: 43, points: 69 },
    { rank: 3, name: 'Man City', played: 30, won: 20, drawn: 7, lost: 3, gf: 60, ga: 24, gd: 36, points: 67 }
  ];
};

// ==========================================
// ⏱️ FETCH MATCH EVENTS
// ==========================================
exports.fetchMatchEvents = async (slug) => {
  const cached = getCachedData('/match/', { sport: 'football', slug });
  if (!cached || !cached.match || !cached.match.incidents) return null;

  return cached.match.incidents.map(e => ({
    minute: e.time, type: _mapType(e.type), icon: _mapIcon(e.type),
    label: e.type, side: e.side,
    team: e.side === 'home' ? (cached.match.home || 'Home') : (cached.match.away || 'Away'),
    player: e.player || e.player_in || '', playerOut: e.player_out || null,
    isGoal: e.is_goal || false, isCard: e.is_card || false,
  }));
};

// ==========================================
// 👥 FETCH LINEUPS
// ==========================================
exports.fetchLineupsFromAPI = async (slug) => {
  const cached = getCachedData('/match/', { sport: 'football', slug });
  if (!cached || !cached.match || !cached.match.lineups) return null;

  const ln = cached.match.lineups;
  const mp = (xi) => (xi || []).map(p => ({
    number: p.number || 0, name: p.name || 'Unknown',
    position: _mapPos(p.position), isCaptain: p.captain || false,
  }));

  return {
    formation: { home: ln.home_formation || '4-3-3', away: ln.away_formation || '4-3-3' },
    home: mp(ln.home_xi), away: mp(ln.away_xi),
  };
};

// ==========================================
// 🔧 HELPERS
// ==========================================
function _mapType(t) {
  if (!t) return 'event';
  const l = t.toLowerCase();
  if (l.includes('goal')) return 'goal';
  if (l.includes('yellow')) return 'yellow_card';
  if (l.includes('red')) return 'red_card';
  if (l.includes('subst')) return 'substitution';
  return 'event';
}
function _mapIcon(t) {
  if (!t) return '📢';
  const l = t.toLowerCase();
  if (l.includes('goal')) return '⚽';
  if (l.includes('yellow')) return '🟨';
  if (l.includes('red')) return '🟥';
  if (l.includes('subst')) return '🔄';
  return '📢';
}
function _mapPos(p) {
  if (!p) return 'MF';
  if (p === 'G') return 'GK';
  if (p === 'D') return 'DF';
  if (p === 'M') return 'MF';
  if (p === 'F') return 'FW';
  return p;
}

exports.fetchMatchesByDateFromAPI = async () => exports.fetchMatchesFromAPI();
exports.LEAGUE_SLUGS = LEAGUE_SLUGS;