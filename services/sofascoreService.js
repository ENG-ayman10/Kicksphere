const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('./cacheService');

const BASE_URL = 'https://api.sofascore.com/api/v1';

// Headers to bypass basic blocks
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Origin': 'https://www.sofascore.com',
  'Referer': 'https://www.sofascore.com/',
};

// Cache TTL
const TTL = {
  TEAM: 60 * 60 * 1000,       // 1 hour
  PLAYER: 24 * 60 * 60 * 1000, // 24 hours
  STANDINGS: 30 * 60 * 1000,  // 30 mins
};

// ==========================================
// 🛡️ FETCH UTILITY
// ==========================================
const fetchAPI = async (endpoint) => {
  try {
    const response = await axios.get(`${BASE_URL}${endpoint}`, { headers });
    return response.data;
  } catch (error) {
    logger.error(`❌ Sofascore fetch error [${endpoint}]: ${error.message}`);
    return null;
  }
};

// ==========================================
// 👕 GET TEAM DETAILS & STATS
// ==========================================
exports.getTeamDetails = async (teamId) => {
  const cacheKey = `team:${teamId}`;
  const cached = getCached(cacheKey, TTL.TEAM);
  if (cached) return cached;

  try {
    const data = await fetchAPI(`/team/${teamId}`);
    if (!data || !data.team) return null;

    // Get team performance/matches or squad
    const squadData = await fetchAPI(`/team/${teamId}/players`);
    const squad = squadData ? squadData.players : [];

    const result = {
      team: {
        id: data.team.id,
        name: data.team.name,
        shortName: data.team.shortName,
        logo: `https://api.sofascore.app/api/v1/team/${teamId}/image`,
        country: data.team.country?.name,
        manager: data.team.manager?.name,
        venue: data.team.venue?.city,
        foundationDate: data.team.foundationDateTimestamp,
      },
      squad: squad.map(p => ({
        id: p.player.id,
        name: p.player.name,
        position: p.player.position,
        jerseyNumber: p.player.jerseyNumber,
        image: `https://api.sofascore.app/api/v1/player/${p.player.id}/image`,
        country: p.player.country?.name,
      })),
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
exports.getTeamStandings = async (teamId, tournamentId, seasonId) => {
  // If we don't know the exact tournament/season, we can fetch team tournaments first
  // For simplicity, we just return basic info if tournamentId isn't provided
  if (!tournamentId || !seasonId) return null;

  const cacheKey = `standings:team:${teamId}:${seasonId}`;
  const cached = getCached(cacheKey, TTL.STANDINGS);
  if (cached) return cached;

  try {
    const data = await fetchAPI(`/tournament/${tournamentId}/season/${seasonId}/standings/total`);
    if (!data || !data.standings || data.standings.length === 0) return null;

    let teamStanding = null;
    for (const group of data.standings) {
      const found = group.rows.find(r => r.team.id == teamId);
      if (found) {
        teamStanding = found;
        break;
      }
    }

    const result = teamStanding ? {
      position: teamStanding.position,
      matches: teamStanding.matches,
      wins: teamStanding.wins,
      draws: teamStanding.draws,
      losses: teamStanding.losses,
      points: teamStanding.points,
      scoresFor: teamStanding.scoresFor,
      scoresAgainst: teamStanding.scoresAgainst,
    } : null;

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
exports.getPlayerDetails = async (playerId) => {
  const cacheKey = `player:${playerId}`;
  const cached = getCached(cacheKey, TTL.PLAYER);
  if (cached) return cached;

  try {
    const data = await fetchAPI(`/player/${playerId}`);
    if (!data || !data.player) return null;
    
    const p = data.player;
    
    // Attempt to get attributes
    const attrData = await fetchAPI(`/player/${playerId}/attribute-overview`);
    
    const result = {
      id: p.id,
      name: p.name,
      shortName: p.shortName,
      image: `https://api.sofascore.app/api/v1/player/${p.id}/image`,
      team: p.team?.name,
      teamId: p.team?.id,
      position: p.position,
      jerseyNumber: p.jerseyNumber,
      height: p.height,
      preferredFoot: p.preferredFoot,
      dateOfBirth: p.dateOfBirthTimestamp,
      country: p.country?.name,
      marketValue: p.proposedMarketValue,
      attributes: attrData ? attrData.averageAttributeOverview : null,
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
  const cached = getCached(cacheKey, TTL.PLAYER);
  if (cached) return cached;

  try {
    const data = await fetchAPI('/config/unique-tournaments/EN'); // gets popular tournaments
    if (!data || !data.uniqueTournaments) return [];
    
    const result = data.uniqueTournaments.map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      logo: `https://api.sofascore.app/api/v1/unique-tournament/${t.id}/image`,
      country: t.category?.name,
      countryFlag: t.category?.flag,
    }));

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`getAllLeagues failed: ${err.message}`);
    return [];
  }
};
