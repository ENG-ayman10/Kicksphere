/**
 * @file sportscoreService.js
 * @description Official SportScore API integration service.
 * Base URL: https://sportscore.com
 * Adheres strictly to SportScore API Terms of Use, ~10,000 req/24h fair-use policy,
 * 60s origin caching, 429 backoff handling, and standard contract normalization.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('./cacheService');

const BASE_URL = 'https://sportscore.com';
const SPORT = 'football';
const APP_SRC = 'kicksphere';

// Rate-limiting & 429 backoff tracking
let retryAfterUntil = 0;

// Default TTLs (milliseconds)
const TTL = {
  LIVE_MATCHES: 30 * 1000,     // 30 seconds for live/active matches
  DAILY_MATCHES: 60 * 1000,    // 60 seconds (matches SportScore edge cache)
  MATCH_DETAIL: 60 * 1000,     // 60 seconds
  STANDINGS: 5 * 60 * 1000,    // 5 minutes
  TOP_SCORERS: 5 * 60 * 1000,  // 5 minutes
  TEAM: 15 * 60 * 1000,        // 15 minutes
  PLAYER: 30 * 60 * 1000,      // 30 minutes
  SEARCH: 10 * 60 * 1000,      // 10 minutes
  H2H: 30 * 60 * 1000,         // 30 minutes
};

// Verified Competition Slug Mapping
const COMPETITION_SLUGS = {
  'PL': { slug: 'english-premier-league', name: 'Premier League', country: 'England', logo: 'https://crests.football-data.org/PL.png' },
  'PD': { slug: 'spanish-la-liga', name: 'La Liga', country: 'Spain', logo: 'https://crests.football-data.org/PD.png' },
  'SA': { slug: 'italian-serie-a', name: 'Serie A', country: 'Italy', logo: 'https://crests.football-data.org/SA.png' },
  'BL1': { slug: 'bundesliga', name: 'Bundesliga', country: 'Germany', logo: 'https://crests.football-data.org/BL1.png' },
  'FL1': { slug: 'french-ligue-1', name: 'Ligue 1', country: 'France', logo: 'https://crests.football-data.org/FL1.png' },
  'CL': { slug: 'uefa-champions-league', name: 'UEFA Champions League', country: 'Europe', logo: 'https://crests.football-data.org/CL.png' },
  'EL': { slug: 'uefa-europa-league', name: 'UEFA Europa League', country: 'Europe', logo: 'https://crests.football-data.org/EL.png' },
  'DED': { slug: 'netherlands-eredivisie', name: 'Eredivisie', country: 'Netherlands', logo: 'https://crests.football-data.org/DED.png' },
  'PPL': { slug: 'portuguese-primeira-liga', name: 'Primeira Liga', country: 'Portugal', logo: 'https://crests.football-data.org/PPL.png' },
  'BSA': { slug: 'brazilian-serie-a', name: 'Brasileirão', country: 'Brazil', logo: 'https://crests.football-data.org/BSA.png' },
  'SPL': { slug: 'saudi-pro-league', name: 'Saudi Pro League', country: 'Saudi Arabia', logo: 'https://images.kickoffapi.com/images/leagues/307.png' },
  'ELC': { slug: 'english-championship', name: 'Championship', country: 'England', logo: 'https://crests.football-data.org/ELC.png' },
  'TSL': { slug: 'turkish-super-lig', name: 'Süper Lig', country: 'Turkey', logo: 'https://images.kickoffapi.com/images/leagues/203.png' },
  'MLS': { slug: 'major-league-soccer', name: 'MLS', country: 'USA', logo: 'https://images.kickoffapi.com/images/leagues/253.png' },
  'ECL': { slug: 'uefa-conference-league', name: 'UEFA Conference League', country: 'Europe', logo: 'https://images.kickoffapi.com/images/leagues/848.png' }
};

const resolveCompetitionSlug = (codeOrSlug) => {
  if (!codeOrSlug) return 'english-premier-league';
  const clean = String(codeOrSlug).trim().toUpperCase();
  if (COMPETITION_SLUGS[clean]) {
    return COMPETITION_SLUGS[clean].slug;
  }
  const lower = String(codeOrSlug).trim().toLowerCase();
  for (const info of Object.values(COMPETITION_SLUGS)) {
    if (info.slug === lower) return info.slug;
  }
  return lower;
};

// ═══════════════════════════════════════════════════════════════════
// 🌐 UNIFIED HTTP REQUEST HANDLER WITH 429 BACKOFF & CACHING
// ═══════════════════════════════════════════════════════════════════
async function fetchSportScore(endpoint, params = {}, customTtl = TTL.DAILY_MATCHES) {
  const queryParams = new URLSearchParams({
    sport: SPORT,
    src: APP_SRC,
    ...params
  });

  const url = `${BASE_URL}${endpoint}?${queryParams.toString()}`;
  const cacheKey = `sportscore_${url}`;

  // 1. Check local cache
  const cached = getCached(cacheKey);
  if (cached) {
    return cached;
  }

  // 2. Check if we are in 429 backoff window
  const now = Date.now();
  if (now < retryAfterUntil) {
    logger.warn(`[SportScore] Throttled by 429 backoff until ${new Date(retryAfterUntil).toISOString()}`);
    return null;
  }

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'KickSphereApp/1.0 (SportScore Integration; +https://sportscore.com)',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (response.data) {
      setCache(cacheKey, response.data, customTtl);
      return response.data;
    }
  } catch (error) {
    if (error.response?.status === 429) {
      const retryAfterSec = parseInt(error.response.headers['retry-after'] || '60', 10);
      retryAfterUntil = Date.now() + (retryAfterSec * 1000);
      logger.error(`[SportScore] Received 429 Too Many Requests. Backing off for ${retryAfterSec}s.`);
    } else {
      logger.warn(`[SportScore] Error fetching ${endpoint}: ${error.message}`);
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// ⚽ 1. MATCHES (LIVE & BY DATE)
// ═══════════════════════════════════════════════════════════════════
exports.getLiveMatches = async () => {
  try {
    const raw = await fetchSportScore('/api/widget/matches/', { limit: 50 }, TTL.LIVE_MATCHES);
    if (!raw?.matches) return [];

    const liveOnly = raw.matches.filter(m => {
      const status = (m.status || '').toLowerCase();
      return status === 'live' || status === 'in_progress' || status === 'first_half' || status === 'second_half' || status === 'extra_time';
    });

    return (liveOnly.length > 0 ? liveOnly : raw.matches.slice(0, 15)).map(normalizeSportScoreMatch);
  } catch (e) {
    logger.error(`[SportScore] getLiveMatches error: ${e.message}`);
    return [];
  }
};

exports.getMatchesByDate = async (dateStr) => {
  try {
    let date = dateStr;
    if (!date || date === 'TODAY' || date === 'today') {
      date = new Date().toISOString().split('T')[0];
    }

    const raw = await fetchSportScore('/api/v1/fixtures/', { date, limit: 100 }, TTL.DAILY_MATCHES);
    if (!raw?.matches) {
      // Fallback to widget matches
      const widgetData = await fetchSportScore('/api/widget/matches/', { limit: 50 }, TTL.DAILY_MATCHES);
      return (widgetData?.matches || []).map(normalizeSportScoreMatch);
    }

    return raw.matches.map(normalizeSportScoreMatch);
  } catch (e) {
    logger.error(`[SportScore] getMatchesByDate error: ${e.message}`);
    return [];
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🔍 2. MATCH DETAILS, INCIDENTS & LINEUPS
// ═══════════════════════════════════════════════════════════════════
exports.getMatchDetails = async (matchSlugOrId) => {
  try {
    let slug = String(matchSlugOrId).trim();
    if (slug.startsWith('/football/match/')) {
      slug = slug.replace('/football/match/', '').replace(/\//g, '');
    }

    const raw = await fetchSportScore('/api/widget/match/', { slug }, TTL.MATCH_DETAIL);
    if (!raw?.match) return null;

    return normalizeSportScoreMatchDetail(raw.match, slug);
  } catch (e) {
    logger.error(`[SportScore] getMatchDetails error: ${e.message}`);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🏆 3. LEAGUE STANDINGS
// ═══════════════════════════════════════════════════════════════════
exports.getStandings = async (competitionCode) => {
  try {
    const slug = resolveCompetitionSlug(competitionCode);
    const raw = await fetchSportScore('/api/widget/standings/', { slug }, TTL.STANDINGS);
    if (!raw?.tables?.[0]?.rows) return [];

    const rows = raw.tables[0].rows;
    return rows.map(r => ({
      position: r.pos || 0,
      team: {
        id: r.team_slug || String(r.pos),
        name: r.team || 'Team',
        shortName: r.team || 'Team',
        crest: r.team_logo || '',
        slug: r.team_slug || ''
      },
      playedGames: r.p || 0,
      won: r.w || 0,
      draw: r.d || 0,
      lost: r.l || 0,
      points: r.pts || 0,
      goalsFor: r.gf || 0,
      goalsAgainst: r.ga || 0,
      goalDifference: r.gd || 0,
      promotion: r.promo_name || '',
      promoColor: r.promo_color || '',
      form: ''
    }));
  } catch (e) {
    logger.error(`[SportScore] getStandings error: ${e.message}`);
    return [];
  }
};

// ═══════════════════════════════════════════════════════════════════
// ⚽ 4. TOP SCORERS & ASSISTS
// ═══════════════════════════════════════════════════════════════════
exports.getTopScorers = async (competitionCode, limit = 20, stat = 'goals') => {
  try {
    const slug = resolveCompetitionSlug(competitionCode);
    const raw = await fetchSportScore('/api/widget/topscorers/', {
      slug,
      limit: Math.min(limit, 50),
      stat: stat === 'assists' ? 'assists' : 'goals'
    }, TTL.TOP_SCORERS);

    if (!raw?.scorers) return [];

    return raw.scorers.map(s => ({
      rank: s.rank || 0,
      player: {
        id: s.player_slug || String(s.rank),
        name: s.player || 'Player',
        image: s.player_logo || '',
        slug: s.player_slug || ''
      },
      team: {
        id: s.team_slug || '',
        name: s.team || '',
        crest: s.team_logo || '',
        slug: s.team_slug || ''
      },
      goals: s.goals || 0,
      assists: s.assists || 0,
      playedMatches: s.matches || 0,
      minutesPlayed: s.minutes || 0,
      rating: s.rating ? (s.rating > 100 ? (s.rating / 1000).toFixed(2) : s.rating) : null
    }));
  } catch (e) {
    logger.error(`[SportScore] getTopScorers error: ${e.message}`);
    return [];
  }
};

// ═══════════════════════════════════════════════════════════════════
// 👤 5. PLAYER DETAILS & METRICS
// ═══════════════════════════════════════════════════════════════════
exports.getPlayerDetails = async (playerSlugOrName) => {
  try {
    let slug = String(playerSlugOrName).trim().toLowerCase().replace(/\s+/g, '-');
    if (slug.startsWith('/football/player/')) {
      slug = slug.replace('/football/player/', '').replace(/\//g, '');
    }

    const raw = await fetchSportScore('/api/widget/player/', { slug }, TTL.PLAYER);
    if (!raw?.player) {
      // Try searching player if direct slug fails
      const searchRes = await exports.searchEntities(playerSlugOrName);
      if (searchRes?.players?.length > 0) {
        const foundSlug = searchRes.players[0].slug;
        if (foundSlug && foundSlug !== slug) {
          return exports.getPlayerDetails(foundSlug);
        }
      }
      return null;
    }

    const p = raw.player;
    const st = raw.stats || {};

    const rawRating = st.rating ? Number(st.rating) : null;
    const ratingDec = rawRating ? (rawRating > 100 ? (rawRating / 1000).toFixed(2) : String(rawRating)) : null;

    return {
      id: p.slug || slug,
      name: p.name || '',
      fullName: p.name || '',
      image: p.logo || '',
      team: st.team || '',
      teamBadge: st.team_logo || '',
      competition: st.competition || '',
      matches: st.matches || 0,
      goals: st.goals || 0,
      assists: st.assists || 0,
      minutes: st.minutes || 0,
      rating: ratingDec ? parseFloat(ratingDec) : null,
      yellowCards: st.yellow_cards || 0,
      redCards: st.red_cards || 0,
      shots: st.shots || 0,
      shotsOnTarget: st.shots_on_target || 0,
      passes: st.passes || 0,
      passesAccuracy: st.passes_accuracy || 0,
      tackles: st.tackles || 0,
      interceptions: st.interceptions || 0,
      dribbles: st.dribbles || 0,
      keyPasses: st.key_passes || 0,
      source: 'sportscore'
    };
  } catch (e) {
    logger.error(`[SportScore] getPlayerDetails error: ${e.message}`);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🛡️ 6. TEAM DETAILS & SCHEDULE
// ═══════════════════════════════════════════════════════════════════
exports.getTeamDetails = async (teamSlugOrName) => {
  try {
    let slug = String(teamSlugOrName).trim().toLowerCase().replace(/\s+/g, '-');
    if (slug.startsWith('/football/team/')) {
      slug = slug.replace('/football/team/', '').replace(/\//g, '');
    }

    const raw = await fetchSportScore('/api/widget/team/', { slug, limit: 30 }, TTL.TEAM);
    if (!raw?.team) {
      // Try search fallback
      const searchRes = await exports.searchEntities(teamSlugOrName);
      if (searchRes?.teams?.length > 0) {
        const foundSlug = searchRes.teams[0].slug;
        if (foundSlug && foundSlug !== slug) {
          return exports.getTeamDetails(foundSlug);
        }
      }
      return null;
    }

    const team = raw.team;
    const matches = (raw.matches || []).map(normalizeSportScoreMatch);

    const recent = matches.filter(m => m.status === 'FINISHED' || m.status === 'finished');
    const upcoming = matches.filter(m => m.status === 'TIMED' || m.status === 'SCHEDULED' || m.status === 'upcoming');

    return {
      info: {
        id: team.slug || slug,
        name: team.name || 'Team',
        shortName: team.name || 'Team',
        logo: team.logo || '',
        crest: team.logo || '',
        slug: team.slug || slug,
      },
      matches: {
        recent,
        upcoming
      },
      source: 'sportscore'
    };
  } catch (e) {
    logger.error(`[SportScore] getTeamDetails error: ${e.message}`);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🔍 7. SEARCH (TEAMS, COMPETITIONS, PLAYERS)
// ═══════════════════════════════════════════════════════════════════
exports.searchEntities = async (query, limit = 15) => {
  try {
    const q = String(query || '').trim();
    if (q.length < 2) return { teams: [], competitions: [], players: [] };

    const raw = await fetchSportScore('/api/v1/search/', { q, limit: Math.min(limit, 20) }, TTL.SEARCH);
    if (!raw) return { teams: [], competitions: [], players: [] };

    const teams = (raw.teams || []).map(t => ({
      id: t.slug || t.name,
      name: t.name,
      shortName: t.name,
      logo: t.logo || '',
      crest: t.logo || '',
      slug: t.slug || '',
      url: t.url || '',
      type: 'club',
      provider: 'sportscore'
    }));

    const competitions = (raw.competitions || []).map(c => ({
      id: c.slug || c.name,
      name: c.name,
      logo: c.logo || '',
      emblem: c.logo || '',
      slug: c.slug || '',
      url: c.url || '',
      type: 'league',
      provider: 'sportscore'
    }));

    return {
      teams,
      competitions,
      players: []
    };
  } catch (e) {
    logger.error(`[SportScore] searchEntities error: ${e.message}`);
    return { teams: [], competitions: [], players: [] };
  }
};

// ═══════════════════════════════════════════════════════════════════
// ⚔️ 8. HEAD TO HEAD (H2H)
// ═══════════════════════════════════════════════════════════════════
exports.getH2H = async (team1Slug, team2Slug, limit = 20) => {
  try {
    const raw = await fetchSportScore('/api/v1/h2h/', {
      team1: team1Slug,
      team2: team2Slug,
      limit: Math.min(limit, 50)
    }, TTL.H2H);

    if (!raw?.matches) return null;

    return {
      team1: raw.team1,
      team2: raw.team2,
      summary: raw.summary || { team1_wins: 0, team2_wins: 0, draws: 0, meetings: 0 },
      matches: raw.matches.map(normalizeSportScoreMatch),
      source: 'sportscore'
    };
  } catch (e) {
    logger.error(`[SportScore] getH2H error: ${e.message}`);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 📐 NORMALIZATION HELPERS
// ═══════════════════════════════════════════════════════════════════
// Known competition name → code mapping for proper identification
// IMPORTANT: Use EXACT names as they come from SportScore API - no partial matching!
const KNOWN_COMPETITIONS = {
  // English
  'premier league': { code: 'PL', name: 'Premier League', country: 'England' },
  'english premier league': { code: 'PL', name: 'Premier League', country: 'England' },
  'epl': { code: 'PL', name: 'Premier League', country: 'England' },
  'championship': { code: 'ELC', name: 'Championship', country: 'England' },
  'efl championship': { code: 'ELC', name: 'Championship', country: 'England' },
  'english championship': { code: 'ELC', name: 'Championship', country: 'England' },
  // Spanish
  'la liga': { code: 'PD', name: 'La Liga', country: 'Spain' },
  'spanish la liga': { code: 'PD', name: 'La Liga', country: 'Spain' },
  'laliga': { code: 'PD', name: 'La Liga', country: 'Spain' },
  'laliga ea sports': { code: 'PD', name: 'La Liga', country: 'Spain' },
  // Italian
  'serie a': { code: 'SA', name: 'Serie A', country: 'Italy' },
  'italian serie a': { code: 'SA', name: 'Serie A', country: 'Italy' },
  // German
  'bundesliga': { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
  'german bundesliga': { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
  // French
  'ligue 1': { code: 'FL1', name: 'Ligue 1', country: 'France' },
  'french ligue 1': { code: 'FL1', name: 'Ligue 1', country: 'France' },
  'ligue 1 uber eats': { code: 'FL1', name: 'Ligue 1', country: 'France' },
  // UEFA
  'champions league': { code: 'CL', name: 'UEFA Champions League', country: 'Europe' },
  'uefa champions league': { code: 'CL', name: 'UEFA Champions League', country: 'Europe' },
  'europa league': { code: 'EL', name: 'UEFA Europa League', country: 'Europe' },
  'uefa europa league': { code: 'EL', name: 'UEFA Europa League', country: 'Europe' },
  'conference league': { code: 'ECL', name: 'UEFA Conference League', country: 'Europe' },
  'uefa europa conference league': { code: 'ECL', name: 'UEFA Conference League', country: 'Europe' },
  // Other European
  'eredivisie': { code: 'DED', name: 'Eredivisie', country: 'Netherlands' },
  'netherlands eredivisie': { code: 'DED', name: 'Eredivisie', country: 'Netherlands' },
  'primeira liga': { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  'portuguese primeira liga': { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  'liga portugal': { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  'scottish premiership': { code: 'SPL2', name: 'Scottish Premiership', country: 'Scotland' },
  'belgian pro league': { code: 'BPL', name: 'Belgian Pro League', country: 'Belgium' },
  'super lig': { code: 'TSL', name: 'Süper Lig', country: 'Turkey' },
  'turkish super lig': { code: 'TSL', name: 'Süper Lig', country: 'Turkey' },
  // South America
  'brasileirao serie a': { code: 'BSA', name: 'Brasileirão', country: 'Brazil' },
  'brazilian serie a': { code: 'BSA', name: 'Brasileirão', country: 'Brazil' },
  'brasileirao': { code: 'BSA', name: 'Brasileirão', country: 'Brazil' },
  'copa libertadores': { code: 'CLI', name: 'Copa Libertadores', country: 'South America' },
  'conmebol libertadores': { code: 'CLI', name: 'Copa Libertadores', country: 'South America' },
  'copa sudamericana': { code: 'CSA', name: 'Copa Sudamericana', country: 'South America' },
  'ligapro serie a': { code: 'ECUA', name: 'LigaPro Serie A', country: 'Ecuador' },
  // Middle East
  'saudi pro league': { code: 'SPL', name: 'Saudi Pro League', country: 'Saudi Arabia' },
  'roshn saudi league': { code: 'SPL', name: 'Saudi Pro League', country: 'Saudi Arabia' },
  'qatar stars league': { code: 'QSL', name: 'Qatar Stars League', country: 'Qatar' },
  'united arab emirates adnoc pro-league': { code: 'UAE', name: 'UAE Pro League', country: 'UAE' },
  // North America
  'mls': { code: 'MLS', name: 'MLS', country: 'USA' },
  'major league soccer': { code: 'MLS', name: 'MLS', country: 'USA' },
  'liga mx': { code: 'LMX', name: 'Liga MX', country: 'Mexico' },
  // International
  'world cup': { code: 'WC', name: 'FIFA World Cup', country: 'International' },
  'european championship': { code: 'EC', name: 'European Championship', country: 'Europe' },
  'copa america': { code: 'COPA', name: 'Copa América', country: 'South America' },
  'africa cup of nations': { code: 'AFCON', name: 'Africa Cup of Nations', country: 'Africa' },
  'caf confederation cup': { code: 'CAFCC', name: 'CAF Confederation Cup', country: 'Africa' },
  'caf champions league': { code: 'CAFCL', name: 'CAF Champions League', country: 'Africa' },
  // Other
  'ukrainian premier league': { code: 'UPL', name: 'Ukrainian Premier League', country: 'Ukraine' },
  'categoría primera a': { code: 'COL', name: 'Liga BetPlay', country: 'Colombia' },
};

function resolveCompetition(competitionName) {
  if (!competitionName) return null;
  const lower = competitionName.toLowerCase().trim();
  
  // EXACT match only - no partial matching to avoid false positives
  if (KNOWN_COMPETITIONS[lower]) return KNOWN_COMPETITIONS[lower];
  
  return null;
}

function normalizeSportScoreMatch(m) {
  const statusRaw = (m.status || '').toLowerCase();
  let normalizedStatus = 'TIMED';
  let isLive = false;
  let isFinished = false;

  if (statusRaw === 'finished' || statusRaw === 'ft' || statusRaw === 'aet' || statusRaw === 'pen') {
    normalizedStatus = 'FINISHED';
    isFinished = true;
  } else if (statusRaw === 'live' || statusRaw === 'in_progress' || statusRaw === '1h' || statusRaw === '2h' || statusRaw === 'ht') {
    normalizedStatus = 'IN_PLAY';
    isLive = true;
  } else if (statusRaw === 'postponed' || statusRaw === 'cancelled') {
    normalizedStatus = 'POSTPONED';
  } else {
    normalizedStatus = 'TIMED';
  }

  // Parse scores safely - never create artificial 0-0 for upcoming matches!
  const homeScoreNum = (m.home_score !== null && m.home_score !== undefined && m.home_score !== '')
      ? parseInt(m.home_score, 10)
      : null;
  const awayScoreNum = (m.away_score !== null && m.away_score !== undefined && m.away_score !== '')
      ? parseInt(m.away_score, 10)
      : null;

  const matchId = (m.url || m.slug || `${m.home}-vs-${m.away}`).replace('/football/match/', '').replace(/\//g, '');

  // Resolve known competition
  const knownComp = resolveCompetition(m.competition);
  const compCode = knownComp ? knownComp.code : (m.competition ? m.competition.substring(0, 4).toUpperCase() : 'LEAG');
  const compName = knownComp ? knownComp.name : (m.competition || 'Football Competition');

  return {
    id: matchId,
    slug: matchId,
    utcDate: m.time || new Date().toISOString(),
    status: normalizedStatus,
    statusText: m.status_text || (isFinished ? 'Finished' : (isLive ? 'Live' : 'Upcoming')),
    minute: m.live_minute || null,
    homeTeam: {
      id: m.home || 'home',
      name: m.home || 'Home Team',
      shortName: m.home || 'Home',
      crest: m.home_logo || '',
      logo: m.home_logo || ''
    },
    awayTeam: {
      id: m.away || 'away',
      name: m.away || 'Away Team',
      shortName: m.away || 'Away',
      crest: m.away_logo || '',
      logo: m.away_logo || ''
    },
    score: {
      fullTime: {
        home: homeScoreNum,
        away: awayScoreNum
      },
      halfTime: {
        home: m.home_ht_score !== undefined ? parseInt(m.home_ht_score, 10) : null,
        away: m.away_ht_score !== undefined ? parseInt(m.away_ht_score, 10) : null
      }
    },
    competition: {
      id: compCode,
      name: compName,
      code: compCode,
      country: knownComp ? knownComp.country : '',
      emblem: m.competition_logo || '',
      logo: m.competition_logo || ''
    },
    source: 'sportscore'
  };
}

function normalizeSportScoreMatchDetail(m, slug) {
  const base = normalizeSportScoreMatch(m);

  // Incidents normalization (Timeline)
  const timeline = (m.incidents || []).map(inc => {
    let type = 'incident';
    let icon = '⚡';
    const typeStr = (inc.type || '').toLowerCase();

    if (inc.is_goal || typeStr.includes('goal')) {
      type = 'goal';
      icon = '⚽';
    } else if (inc.is_card || typeStr.includes('yellow')) {
      type = 'yellow_card';
      icon = '🟨';
    } else if (typeStr.includes('red')) {
      type = 'red_card';
      icon = '🟥';
    } else if (typeStr.includes('sub')) {
      type = 'substitution';
      icon = '🔄';
    }

    return {
      minute: inc.time || 0,
      type,
      icon,
      label: inc.type || 'Event',
      side: inc.side || 'home',
      player: inc.player || '',
      assist: inc.assist || null
    };
  });

  // Lineups normalization
  const lineups = m.lineups || {};
  const mapPlayer = p => {
    const name = p.name || p.playerName || 'Player';
    const id = String(p.slug || p.id || name);
    const number = p.number || 0;
    return {
      id,
      name,
      playerName: name,
      number,
      position: p.position || '',
      captain: Boolean(p.captain),
      rating: p.rating || null,
      player: {
        id,
        name,
        number
      }
    };
  };

  const homeXi = (lineups.home_xi || []).map(mapPlayer);
  const awayXi = (lineups.away_xi || []).map(mapPlayer);
  const homeSubs = (lineups.home_subs || []).map(mapPlayer);
  const awaySubs = (lineups.away_subs || []).map(mapPlayer);

  return {
    ...base,
    slug,
    timeline,
    lineups: {
      homeFormation: lineups.home_formation || '',
      awayFormation: lineups.away_formation || '',
      homeCoach: lineups.home_coach || null,
      awayCoach: lineups.away_coach || null,
      confirmed: Boolean(lineups.confirmed),
      home: homeXi,
      away: awayXi,
      homeBench: homeSubs,
      awayBench: awaySubs
    },
    tracker: m.tracker || null,
    source: 'sportscore'
  };
}

module.exports = {
  getLiveMatches: exports.getLiveMatches,
  getMatchesByDate: exports.getMatchesByDate,
  getMatchDetails: exports.getMatchDetails,
  getStandings: exports.getStandings,
  getTopScorers: exports.getTopScorers,
  getPlayerDetails: exports.getPlayerDetails,
  getTeamDetails: exports.getTeamDetails,
  searchEntities: exports.searchEntities,
  getH2H: exports.getH2H,
  COMPETITION_SLUGS
};
