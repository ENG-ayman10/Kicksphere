/**
 * @file footballApi.js
 * @description Football data service — real data from football-data.org v4.
 * Free tier: 10 req/min, 12 competitions, delayed scores.
 * Smart cache prevents hitting rate limits.
 */

const axios = require('axios');
const logger = require('../utils/logger');

const BASE_URL = 'https://api.football-data.org/v4';
const API_KEY = process.env.FOOTBALL_DATA_API_KEY || '';

const headers = {
  'X-Auth-Token': API_KEY,
  Accept: 'application/json',
};

// ==========================================
// 🔄 SMART CACHE SYSTEM
// ==========================================
const cache = new Map();

const TTL = {
  LIVE: 2 * 60 * 1000,         // 2 min for live matches
  MATCHES: 10 * 60 * 1000,     // 10 min for match lists
  STANDINGS: 30 * 60 * 1000,   // 30 min for standings
  SCORERS: 60 * 60 * 1000,     // 1 hour for top scorers
  DETAILS: 5 * 60 * 1000,      // 5 min for match details
};

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Evict oldest if cache too large
  if (cache.size > 300) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// Rate limiter — max 10 requests per minute
let requestTimestamps = [];
async function rateLimitedFetch(url, params = {}) {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < 60000);
  
  if (requestTimestamps.length >= 9) {
    logger.warn('⚠️ Rate limit approaching, waiting...');
    const wait = 60000 - (now - requestTimestamps[0]);
    await new Promise(r => setTimeout(r, Math.max(wait, 1000)));
  }
  
  requestTimestamps.push(Date.now());
  const response = await axios.get(url, { headers, params, timeout: 8000 });
  return response.data;
}

// ==========================================
// 🏆 COMPETITION CODES (Free Tier)
// ==========================================
const COMPETITIONS = {
  PL:  { name: 'Premier League',      country: 'England',  flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  PD:  { name: 'La Liga',             country: 'Spain',    flag: '🇪🇸' },
  SA:  { name: 'Serie A',             country: 'Italy',    flag: '🇮🇹' },
  BL1: { name: 'Bundesliga',          country: 'Germany',  flag: '🇩🇪' },
  FL1: { name: 'Ligue 1',             country: 'France',   flag: '🇫🇷' },
  CL:  { name: 'Champions League',    country: 'Europe',   flag: '🇪🇺' },
  PPL: { name: 'Primeira Liga',       country: 'Portugal', flag: '🇵🇹' },
  ELC: { name: 'Championship',        country: 'England',  flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  DED: { name: 'Eredivisie',          country: 'Netherlands', flag: '🇳🇱' },
  BSA: { name: 'Brasileirão',         country: 'Brazil',   flag: '🇧🇷' },
  EC:  { name: 'European Championship', country: 'Europe', flag: '🇪🇺' },
  WC:  { name: 'World Cup',           country: 'World',    flag: '🌍' },
};

// ==========================================
// ⚽ FETCH MATCHES BY DATE
// ==========================================
exports.fetchMatchesByDate = async (date = 'TODAY') => {
  const cacheKey = `matches:${date}`;
  const cached = getCached(cacheKey, TTL.MATCHES);
  if (cached) {
    logger.info(`📦 Cache: matches for ${date}`);
    return cached;
  }

  try {
    let params = {};
    
    if (date === 'TODAY') {
      // default — returns today
    } else if (date === 'YESTERDAY') {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const ds = d.toISOString().split('T')[0];
      params = { dateFrom: ds, dateTo: ds };
    } else if (date === 'TOMORROW') {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const ds = d.toISOString().split('T')[0];
      params = { dateFrom: ds, dateTo: ds };
    } else {
      // Specific date: YYYY-MM-DD
      params = { dateFrom: date, dateTo: date };
    }

    const data = await rateLimitedFetch(`${BASE_URL}/matches`, params);
    
    const result = _formatMatchList(data.matches || []);
    setCache(cacheKey, result);
    logger.info(`✅ API: ${result.length} matches for ${date}`);
    return result;
  } catch (err) {
    logger.error(`❌ fetchMatchesByDate error: ${err.message}`);
    return [];
  }
};

// ==========================================
// 🔴 FETCH LIVE MATCHES
// ==========================================
exports.fetchLiveMatches = async () => {
  const cacheKey = 'matches:live';
  const cached = getCached(cacheKey, TTL.LIVE);
  if (cached) return cached;

  try {
    const data = await rateLimitedFetch(`${BASE_URL}/matches`, { status: 'LIVE' });
    const result = _formatMatchList(data.matches || []);
    setCache(cacheKey, result);
    logger.info(`✅ Live: ${result.length} matches`);
    return result;
  } catch (err) {
    logger.error(`❌ fetchLiveMatches error: ${err.message}`);
    // Fallback: return today's in-progress matches from cache
    const today = getCached('matches:TODAY', TTL.MATCHES);
    if (today) return today.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
    return [];
  }
};

// ==========================================
// 📊 FETCH STANDINGS
// ==========================================
exports.fetchStandings = async (competitionCode = 'PL') => {
  const cacheKey = `standings:${competitionCode}`;
  const cached = getCached(cacheKey, TTL.STANDINGS);
  if (cached) return cached;

  try {
    const data = await rateLimitedFetch(`${BASE_URL}/competitions/${competitionCode}/standings`);
    
    const total = data.standings?.find(s => s.type === 'TOTAL');
    if (!total || !total.table) return [];

    const result = total.table.map(t => ({
      rank: t.position,
      name: t.team.shortName || t.team.name,
      logo: t.team.crest || '',
      teamId: t.team.id,
      played: t.playedGames,
      won: t.won,
      drawn: t.draw,
      lost: t.lost,
      gf: t.goalsFor,
      ga: t.goalsAgainst,
      gd: t.goalDifference,
      points: t.points,
    }));

    setCache(cacheKey, result);
    logger.info(`✅ Standings: ${result.length} teams for ${competitionCode}`);
    return result;
  } catch (err) {
    logger.error(`❌ fetchStandings error: ${err.message}`);
    return [];
  }
};

// ==========================================
// 🏅 FETCH TOP SCORERS
// ==========================================
exports.fetchTopScorers = async (competitionCode = 'PL', limit = 20) => {
  const cacheKey = `scorers:${competitionCode}:${limit}`;
  const cached = getCached(cacheKey, TTL.SCORERS);
  if (cached) return cached;

  try {
    const data = await rateLimitedFetch(`${BASE_URL}/competitions/${competitionCode}/scorers`, { limit });
    
    const result = (data.scorers || []).map((s, i) => ({
      rank: i + 1,
      name: s.player?.name || 'Unknown',
      playerId: s.player?.id,
      nationality: s.player?.nationality || '',
      team: s.team?.shortName || s.team?.name || '',
      teamLogo: s.team?.crest || '',
      goals: s.goals || 0,
      assists: s.assists || 0,
      penalties: s.penalties || 0,
      matches: s.playedMatches || 0,
    }));

    setCache(cacheKey, result);
    logger.info(`✅ Scorers: ${result.length} for ${competitionCode}`);
    return result;
  } catch (err) {
    logger.error(`❌ fetchTopScorers error: ${err.message}`);
    return [];
  }
};

// ==========================================
// 🔍 FETCH MATCH DETAILS
// ==========================================
exports.fetchMatchDetails = async (matchId) => {
  const cacheKey = `match:${matchId}`;
  const cached = getCached(cacheKey, TTL.DETAILS);
  if (cached) return cached;

  try {
    const data = await rateLimitedFetch(`${BASE_URL}/matches/${matchId}`);

    const m = data;
    const result = {
      id: m.id,
      competition: {
        name: m.competition?.name || '',
        code: m.competition?.code || '',
        emblem: m.competition?.emblem || '',
      },
      utcDate: m.utcDate,
      status: m.status,
      matchday: m.matchday,
      stage: m.stage,
      venue: m.venue || null,
      attendance: m.attendance || null,
      homeTeam: {
        id: m.homeTeam?.id,
        name: m.homeTeam?.shortName || m.homeTeam?.name || '',
        fullName: m.homeTeam?.name || '',
        crest: m.homeTeam?.crest || '',
        coach: m.homeTeam?.coach?.name || null,
        formation: m.homeTeam?.formation || null,
        lineup: (m.homeTeam?.lineup || []).map(p => ({
          id: p.id, name: p.name, position: p.position, shirtNumber: p.shirtNumber,
        })),
        bench: (m.homeTeam?.bench || []).map(p => ({
          id: p.id, name: p.name, position: p.position, shirtNumber: p.shirtNumber,
        })),
      },
      awayTeam: {
        id: m.awayTeam?.id,
        name: m.awayTeam?.shortName || m.awayTeam?.name || '',
        fullName: m.awayTeam?.name || '',
        crest: m.awayTeam?.crest || '',
        coach: m.awayTeam?.coach?.name || null,
        formation: m.awayTeam?.formation || null,
        lineup: (m.awayTeam?.lineup || []).map(p => ({
          id: p.id, name: p.name, position: p.position, shirtNumber: p.shirtNumber,
        })),
        bench: (m.awayTeam?.bench || []).map(p => ({
          id: p.id, name: p.name, position: p.position, shirtNumber: p.shirtNumber,
        })),
      },
      score: {
        winner: m.score?.winner,
        fullTime: m.score?.fullTime || { home: null, away: null },
        halfTime: m.score?.halfTime || { home: null, away: null },
      },
      goals: (m.goals || []).map(g => ({
        minute: g.minute,
        type: g.type,
        team: g.team?.name || '',
        scorer: g.scorer?.name || '',
        assist: g.assist?.name || null,
      })),
      bookings: (m.bookings || []).map(b => ({
        minute: b.minute,
        team: b.team?.name || '',
        player: b.player?.name || '',
        card: b.card,
      })),
      substitutions: (m.substitutions || []).map(s => ({
        minute: s.minute,
        team: s.team?.name || '',
        playerIn: s.playerIn?.name || '',
        playerOut: s.playerOut?.name || '',
      })),
      referees: (m.referees || []).map(r => ({
        name: r.name, type: r.type, nationality: r.nationality,
      })),
      head2head: data.head2head || null,
    };

    setCache(cacheKey, result);
    logger.info(`✅ Match details: ${matchId}`);
    return result;
  } catch (err) {
    logger.error(`❌ fetchMatchDetails error: ${err.message}`);
    return null;
  }
};

// ==========================================
// 📅 FETCH COMPETITION MATCHES (date range)
// ==========================================
exports.fetchCompetitionMatches = async (competitionCode, dateFrom, dateTo) => {
  const cacheKey = `comp:${competitionCode}:${dateFrom}:${dateTo}`;
  const cached = getCached(cacheKey, TTL.MATCHES);
  if (cached) return cached;

  try {
    const params = {};
    if (dateFrom) params.dateFrom = dateFrom;
    if (dateTo) params.dateTo = dateTo;

    const data = await rateLimitedFetch(
      `${BASE_URL}/competitions/${competitionCode}/matches`,
      params
    );

    const result = _formatMatchList(data.matches || []);
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`❌ fetchCompetitionMatches error: ${err.message}`);
    return [];
  }
};

// ==========================================
// 🔧 INTERNAL: Format match list
// ==========================================
function _formatMatchList(matches) {
  return matches.map(m => ({
    id: m.id,
    utcDate: m.utcDate,
    status: m.status,
    matchday: m.matchday,
    stage: m.stage,
    minute: m.minute || null,
    competition: {
      code: m.competition?.code || '',
      name: m.competition?.name || '',
      emblem: m.competition?.emblem || '',
      country: m.area?.name || '',
      countryFlag: m.area?.flag || '',
    },
    homeTeam: {
      id: m.homeTeam?.id,
      name: m.homeTeam?.shortName || m.homeTeam?.name || '',
      fullName: m.homeTeam?.name || '',
      crest: m.homeTeam?.crest || '',
    },
    awayTeam: {
      id: m.awayTeam?.id,
      name: m.awayTeam?.shortName || m.awayTeam?.name || '',
      fullName: m.awayTeam?.name || '',
      crest: m.awayTeam?.crest || '',
    },
    score: {
      winner: m.score?.winner,
      fullTime: m.score?.fullTime || { home: null, away: null },
      halfTime: m.score?.halfTime || { home: null, away: null },
    },
  }));
}

// ==========================================
// 📤 EXPORTS (backward compatibility)
// ==========================================
exports.fetchMatchesFromAPI = exports.fetchLiveMatches;
exports.fetchMatchesByDateFromAPI = exports.fetchMatchesByDate;
exports.COMPETITIONS = COMPETITIONS;
exports.LEAGUE_SLUGS = Object.fromEntries(
  Object.entries(COMPETITIONS).map(([code, info]) => [code, info])
);