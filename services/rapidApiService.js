const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('./cacheService');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const API_HOST = 'api-football-v1.p.rapidapi.com';
const BASE_URL = 'https://api-football-v1.p.rapidapi.com/v3';

// Cache TTL
const TTL = {
  TEAM: 60 * 60 * 1000,       // 1 hour
  PLAYER: 24 * 60 * 60 * 1000, // 24 hours (player info doesn't change much)
  STANDINGS: 30 * 60 * 1000,  // 30 mins
};

// ==========================================
// 🛡️ API FOOTBALL FETCH UTILITY
// ==========================================
const fetchAPI = async (endpoint, params = {}) => {
  if (!RAPIDAPI_KEY) {
    throw new Error('RAPIDAPI_KEY is not defined in environment variables');
  }

  try {
    const response = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': API_HOST,
      },
      params,
    });

    if (response.data.errors && Object.keys(response.data.errors).length > 0) {
      logger.error(`RapidAPI Error: ${JSON.stringify(response.data.errors)}`);
      throw new Error('API-Football returned an error');
    }

    return response.data.response;
  } catch (error) {
    logger.error(`❌ RapidAPI fetch error [${endpoint}]: ${error.message}`);
    throw error;
  }
};

// ==========================================
// 👕 GET TEAM DETAILS & STATS
// ==========================================
exports.getTeamDetails = async (teamId, season = new Date().getFullYear()) => {
  const cacheKey = `team:${teamId}:${season}`;
  const cached = getCached(cacheKey, TTL.TEAM);
  if (cached) return cached;

  try {
    // 1. Get basic team info
    const teamData = await fetchAPI('/teams', { id: teamId });
    if (!teamData || teamData.length === 0) throw new Error('Team not found');
    const teamInfo = teamData[0];

    // 2. Get team squad
    const squadData = await fetchAPI('/players/squads', { team: teamId });
    const squad = squadData && squadData.length > 0 ? squadData[0].players : [];

    const result = {
      team: teamInfo.team,
      venue: teamInfo.venue,
      squad,
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`getTeamDetails failed: ${err.message}`);
    return null;
  }
};

// ==========================================
// 📊 GET TEAM STANDINGS
// ==========================================
exports.getTeamStandings = async (teamId, season = new Date().getFullYear()) => {
  const cacheKey = `standings:team:${teamId}:${season}`;
  const cached = getCached(cacheKey, TTL.STANDINGS);
  if (cached) return cached;

  try {
    const data = await fetchAPI('/standings', { team: teamId, season });
    
    // API-Football returns nested standings. We extract the relevant one.
    if (!data || data.length === 0) return null;
    
    const league = data[0].league;
    // Find the exact standing object for this team
    let teamStanding = null;
    if (league && league.standings) {
      for (const group of league.standings) {
        const found = group.find(s => s.team.id == teamId);
        if (found) {
          teamStanding = found;
          break;
        }
      }
    }

    const result = {
      league: {
        id: league.id,
        name: league.name,
        country: league.country,
        logo: league.logo,
        flag: league.flag,
        season: league.season,
      },
      standing: teamStanding,
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`getTeamStandings failed: ${err.message}`);
    return null;
  }
};

// ==========================================
// 🏃 GET PLAYER DETAILS
// ==========================================
exports.getPlayerDetails = async (playerId, season = new Date().getFullYear()) => {
  const cacheKey = `player:${playerId}:${season}`;
  const cached = getCached(cacheKey, TTL.PLAYER);
  if (cached) return cached;

  try {
    const data = await fetchAPI('/players', { id: playerId, season });
    if (!data || data.length === 0) throw new Error('Player not found');
    
    const p = data[0];
    const result = {
      player: p.player,
      statistics: p.statistics,
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`getPlayerDetails failed: ${err.message}`);
    return null;
  }
};

// ==========================================
// 🏆 GET ALL LEAGUES (Competitions)
// ==========================================
exports.getAllLeagues = async () => {
  const cacheKey = 'all_leagues';
  const cached = getCached(cacheKey, TTL.PLAYER); // Cache for 24h
  if (cached) return cached;

  try {
    // Only fetch active leagues or popular ones to avoid huge payloads
    // We can fetch current season leagues
    const data = await fetchAPI('/leagues', { current: 'true' });
    
    // Filter and map to a lighter structure
    const result = (data || []).map(item => ({
      id: item.league.id,
      name: item.league.name,
      type: item.league.type,
      logo: item.league.logo,
      country: item.country.name,
      countryFlag: item.country.flag,
    }));

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`getAllLeagues failed: ${err.message}`);
    return [];
  }
};
