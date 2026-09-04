const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('./cacheService');
const {
  normalizeCompetitionCode,
  normalizeLimit
} = require('../utils/sportsContracts');

const BASE_URL = 'https://api.sofascore.com/api/v1';

// Headers to bypass basic blocks
const headers = {
  'User-Agent': 'Mozilla/5.0'
};

// Cache TTL
const TTL = {
  TEAM: 60 * 60 * 1000,       // 1 hour
  PLAYER: 24 * 60 * 60 * 1000, // 24 hours
  SEARCH: 10 * 60 * 1000,     // 10 mins
  STANDINGS: 30 * 60 * 1000,  // 30 mins
};

const toText = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
};

const toId = (value) => {
  const text = toText(value);
  return text || null;
};

const logoUrl = {
  team: id => `https://api.sofascore.app/api/v1/team/${id}/image`,
  player: id => `https://api.sofascore.app/api/v1/player/${id}/image`,
};

const isFootballEntity = (entity = {}) => {
  const sport = toText(entity.sport?.slug || entity.sport?.name).toLowerCase();
  return !sport || sport === 'football' || sport === 'soccer';
};

const normalizeSearchTeam = (entity = {}) => {
  const id = toId(entity.id);
  const name = toText(entity.name || entity.shortName);
  if (!id || !name || !isFootballEntity(entity)) return null;

  return {
    id,
    targetId: id,
    provider: 'sofascore',
    providerId: id,
    name,
    shortName: toText(entity.shortName, name),
    league: toText(entity.primaryUniqueTournament?.name || entity.tournament?.name),
    country: toText(entity.country?.name || entity.category?.name),
    logo: logoUrl.team(id)
  };
};

const normalizeSearchPlayer = (entity = {}) => {
  const id = toId(entity.id);
  const name = toText(entity.name || entity.shortName);
  if (!id || !name || !isFootballEntity(entity)) return null;

  const teamId = toId(entity.team?.id);

  return {
    id,
    targetId: id,
    provider: 'sofascore',
    providerId: id,
    name,
    shortName: toText(entity.shortName, name),
    team: toText(entity.team?.name),
    teamId,
    teamLogo: teamId ? logoUrl.team(teamId) : '',
    position: toText(entity.position),
    nationality: toText(entity.country?.name),
    country: toText(entity.country?.name),
    number: entity.jerseyNumber || null,
    image: logoUrl.player(id)
  };
};

// ==========================================
// 🛡️ FETCH UTILITY
// ==========================================
const fetchAPI = async (endpoint, options = {}) => {
  const timeout = options.timeout || 5000;
  const useProxy = options.useProxy !== false;
  const logErrors = options.logErrors !== false;

  try {
    // Try direct first
    const response = await axios.get(`${BASE_URL}${endpoint}`, { headers, timeout });
    return response.data;
  } catch (error) {
    if (useProxy && (error.response?.status === 403 || error.code === 'ECONNABORTED' || error.message.includes('timeout'))) {
      logger.warn(`⚠️ Direct fetch failed for ${endpoint}, trying via proxy...`);
      try {
        // Fallback to a different proxy if direct fails
        // Using allorigins as a raw proxy
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(BASE_URL + endpoint)}`;
        const proxyResponse = await axios.get(proxyUrl, { timeout: 10000 });
        return proxyResponse.data;
      } catch (proxyError) {
        logger.error(`❌ Proxy fetch failed: ${proxyError.message}`);
      }
    }
    if (logErrors) {
      logger.error(`❌ Sofascore fetch error [${endpoint}]: ${error.message}`);
    }
    return null;
  }
};

// ==========================================
// 🔎 SEARCH TEAMS & PLAYERS
// ==========================================
exports.search = async (query, limit = 10) => {
  const q = toText(query);
  if (!q) return { teams: [], players: [], leagues: [], matches: [] };

  const safeLimit = normalizeLimit(limit, 10, 20);
  const cacheKey = `sofascore_search:${q.toLowerCase()}:${safeLimit}`;
  const cached = getCached(cacheKey, TTL.SEARCH);
  if (cached) return cached;

  try {
    const data = await fetchAPI(`/search/all?q=${encodeURIComponent(q)}`, {
      timeout: 3000,
      useProxy: false,
      logErrors: false
    });
    const rows = Array.isArray(data?.results) ? data.results : [];

    const teams = [];
    const players = [];

    for (const row of rows) {
      const type = toText(row.type).toLowerCase();
      const entity = row.entity || {};

      if (type === 'team' && teams.length < safeLimit) {
        const team = normalizeSearchTeam(entity);
        if (team) teams.push(team);
      }

      if (type === 'player' && players.length < safeLimit) {
        const player = normalizeSearchPlayer(entity);
        if (player) players.push(player);
      }

      if (teams.length >= safeLimit && players.length >= safeLimit) break;
    }

    const result = { teams, players, leagues: [], matches: [] };
    setCache(cacheKey, result);
    return result;
  } catch (error) {
    logger.warn(`Sofascore search failed for "${q}": ${error.message}`);
    return { teams: [], players: [], leagues: [], matches: [] };
  }
};

// ==========================================
// 🔍 RESOLVE TEAM ID BY NAME
// ==========================================
const resolveTeamIdByName = async (teamName) => {
  if (!teamName) return null;
  const cacheKey = `resolve_team:${teamName.toLowerCase()}`;
  const cached = getCached(cacheKey, TTL.TEAM);
  if (cached) return cached;

  try {
    const data = await fetchAPI(`/search/all?q=${encodeURIComponent(teamName)}`);
    if (data && data.results) {
      const teamResult = data.results.find(r => r.type === 'team');
      if (teamResult && teamResult.entity) {
        const id = teamResult.entity.id;
        setCache(cacheKey, id);
        return id;
      }
    }

    return null;
  } catch (e) {
    logger.error(`resolveTeamIdByName failed: ${e.message}`);
    return null;
  }
};

// ==========================================
// 🔍 RESOLVE PLAYER ID BY NAME
// ==========================================
const resolvePlayerIdByName = async (playerName) => {
  if (!playerName) return null;
  const cacheKey = `resolve_player:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey, TTL.PLAYER);
  if (cached) return cached;

  try {
    const data = await fetchAPI(`/search/all?q=${encodeURIComponent(playerName)}`);
    if (data && data.results) {
      const playerResult = data.results.find(r => r.type === 'player');
      if (playerResult && playerResult.entity) {
        const id = playerResult.entity.id;
        setCache(cacheKey, id);
        return id;
      }
    }
    return null;
  } catch (e) {
    logger.error(`resolvePlayerIdByName failed: ${e.message}`);
    return null;
  }
};

// ==========================================
// 👕 GET TEAM DETAILS & STATS
// ==========================================
exports.getTeamDetails = async (teamIdOrName) => {
  let teamId = teamIdOrName;
  
  // If it's a string that contains letters, treat as name and resolve
  if (isNaN(teamIdOrName)) {
    teamId = await resolveTeamIdByName(teamIdOrName);
    if (!teamId) return null;
  }

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
// 📊 GET TEAM STANDINGS & OVERALL STATS
// ==========================================
exports.getTeamStandingsAndStats = async (teamIdOrName) => {
  let teamId = teamIdOrName;
  if (isNaN(teamIdOrName)) {
    teamId = await resolveTeamIdByName(teamIdOrName);
    if (!teamId) return null;
  }

  const cacheKey = `standings_stats:team:${teamId}`;
  const cached = getCached(cacheKey, TTL.STANDINGS);
  if (cached) return cached;

  try {
    // 1. Get primary tournament
    const tourneysData = await fetchAPI(`/team/${teamId}/unique-tournaments`);
    if (!tourneysData || !tourneysData.uniqueTournaments || tourneysData.uniqueTournaments.length === 0) return null;
    const primaryTournament = tourneysData.uniqueTournaments[0];
    
    // 2. Get current season
    const seasonsData = await fetchAPI(`/unique-tournament/${primaryTournament.id}/seasons`);
    if (!seasonsData || !seasonsData.seasons || seasonsData.seasons.length === 0) return null;
    const currentSeason = seasonsData.seasons[0]; // latest season is typically first

    // 3. Fetch standings and stats in parallel
    const [standingsData, statsData] = await Promise.all([
      fetchAPI(`/unique-tournament/${primaryTournament.id}/season/${currentSeason.id}/standings/total`).catch(() => null),
      fetchAPI(`/team/${teamId}/unique-tournament/${primaryTournament.id}/season/${currentSeason.id}/statistics/overall`).catch(() => null)
    ]);

    let teamStanding = null;
    if (standingsData && standingsData.standings) {
      for (const group of standingsData.standings) {
        const found = group.rows?.find(r => r.team.id == teamId);
        if (found) {
          teamStanding = found;
          break;
        }
      }
    }

    const result = {
      tournament: {
        id: primaryTournament.id,
        name: primaryTournament.name,
        logo: `https://api.sofascore.app/api/v1/unique-tournament/${primaryTournament.id}/image`
      },
      season: {
        id: currentSeason.id,
        name: currentSeason.name,
        year: currentSeason.year
      },
      standing: teamStanding ? {
        position: teamStanding.position,
        matches: teamStanding.matches,
        wins: teamStanding.wins,
        draws: teamStanding.draws,
        losses: teamStanding.losses,
        points: teamStanding.points,
        scoresFor: teamStanding.scoresFor,
        scoresAgainst: teamStanding.scoresAgainst,
      } : null,
      statistics: statsData ? statsData.statistics : null
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`getTeamStandingsAndStats failed: ${err.message}`);
    return null;
  }
};

exports.getTeamStandings = async (teamIdOrName, tournamentId, seasonId) => {
  // Legacy method for backward compatibility if needed
  if (!tournamentId || !seasonId) return exports.getTeamStandingsAndStats(teamIdOrName);

  let teamId = teamIdOrName;
  if (isNaN(teamIdOrName)) {
    teamId = await resolveTeamIdByName(teamIdOrName);
    if (!teamId) return null;
  }

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

const getPlayerTransferHistory = async (playerId) => {
  try {
    const data = await fetchAPI(`/player/${playerId}/transfer-history`);
    if (!data || !data.transferHistory) return [];
    
    return data.transferHistory.map(t => ({
      transferDate: t.transferDateTimestamp,
      fromTeam: t.fromTeamName,
      fromTeamId: t.transferFrom?.id,
      fromTeamLogo: t.transferFrom?.id ? `https://api.sofascore.app/api/v1/team/${t.transferFrom.id}/image` : null,
      toTeam: t.toTeamName,
      toTeamId: t.transferTo?.id,
      toTeamLogo: t.transferTo?.id ? `https://api.sofascore.app/api/v1/team/${t.transferTo.id}/image` : null,
      type: t.type,
      fee: t.transferFeeDescription || (t.transferFeeRaw ? t.transferFeeRaw.value : 'Free'),
    }));
  } catch (err) {
    logger.error(`getPlayerTransferHistory failed: ${err.message}`);
    return [];
  }
};

// ==========================================
// 🏃 GET PLAYER DETAILS
// ==========================================
exports.getPlayerDetails = async (playerIdOrName) => {
  let playerId = playerIdOrName;
  
  if (isNaN(playerIdOrName)) {
    playerId = await resolvePlayerIdByName(playerIdOrName);
    if (!playerId) return null;
  }

  const cacheKey = `player:${playerId}`;
  const cached = getCached(cacheKey, TTL.PLAYER);
  if (cached) return cached;

  try {
    const data = await fetchAPI(`/player/${playerId}`);
    if (!data || !data.player) return null;
    
    const p = data.player;
    
    // Attempt to get attributes & transfers in parallel
    const [attrData, transfers] = await Promise.all([
      fetchAPI(`/player/${playerId}/attribute-overview`),
      getPlayerTransferHistory(playerId)
    ]);
    
    const result = {
      id: p.id,
      name: p.name,
      shortName: p.shortName,
      image: `https://api.sofascore.app/api/v1/player/${p.id}/image`,
      team: p.team?.name,
      teamId: p.team?.id,
      teamLogo: p.team?.id ? `https://api.sofascore.app/api/v1/team/${p.team.id}/image` : null,
      position: p.position,
      jerseyNumber: p.jerseyNumber,
      height: p.height,
      preferredFoot: p.preferredFoot,
      dateOfBirth: p.dateOfBirthTimestamp,
      country: p.country?.name,
      marketValue: p.proposedMarketValue,
      attributes: attrData ? attrData.averageAttributeOverview : null,
      transferHistory: transfers,
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

// ==========================================
// ⚽ GET TEAM MATCHES (LAST & NEXT)
// ==========================================
exports.getTeamMatches = async (teamIdOrName) => {
  let teamId = teamIdOrName;

  // If it's a string that contains letters, treat as name and resolve
  if (isNaN(teamIdOrName)) {
    teamId = await resolveTeamIdByName(teamIdOrName);
    if (!teamId) return { recent: [], upcoming: [] };
  }

  const cacheKey = `team_matches:${teamId}`;
  const cached = getCached(cacheKey, TTL.TEAM);
  if (cached) return cached;

  try {
    const [lastMatches, nextMatches] = await Promise.all([
      fetchAPI(`/team/${teamId}/events/last/0`),
      fetchAPI(`/team/${teamId}/events/next/0`)
    ]);

    const formatEvent = (e) => ({
      id: e.id,
      tournament: e.tournament?.name,
      tournamentLogo: e.tournament?.uniqueTournament?.id ? `https://api.sofascore.app/api/v1/unique-tournament/${e.tournament.uniqueTournament.id}/image` : null,
      startTimestamp: e.startTimestamp,
      status: e.status?.description,
      homeTeam: e.homeTeam?.name,
      homeTeamId: e.homeTeam?.id,
      homeTeamLogo: e.homeTeam?.id ? `https://api.sofascore.app/api/v1/team/${e.homeTeam.id}/image` : null,
      awayTeam: e.awayTeam?.name,
      awayTeamId: e.awayTeam?.id,
      awayTeamLogo: e.awayTeam?.id ? `https://api.sofascore.app/api/v1/team/${e.awayTeam.id}/image` : null,
      homeScore: e.homeScore?.display,
      awayScore: e.awayScore?.display,
      winnerCode: e.winnerCode,
    });

    const result = {
      recent: (lastMatches?.events || []).map(formatEvent),
      upcoming: (nextMatches?.events || []).map(formatEvent),
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`getTeamMatches failed: ${err.message}`);
    return { recent: [], upcoming: [] };
  }
};

// ==========================================
// 🏆 LEAGUE MAPPING & FREE DATA FETCHERS
// ==========================================

const SOFASCORE_LEAGUE_MAP = {
  'PL': 17,    // Premier League
  'PD': 8,     // La Liga
  'SA': 23,    // Serie A
  'BL1': 35,   // Bundesliga
  'FL1': 34,   // Ligue 1
  'CL': 7,     // Champions League
  'PPL': 238,  // Primeira Liga
  'DED': 37,   // Eredivisie
  'BSA': 325,  // Brasileirão
  'ELC': 18,   // Championship
  'EC': 1,     // Euro
  'WC': 16,    // World Cup
};

exports.getLeagueStandings = async (leagueCode) => {
  leagueCode = normalizeCompetitionCode(leagueCode);
  if (!leagueCode) return null;

  const tournamentId = SOFASCORE_LEAGUE_MAP[leagueCode];
  if (!tournamentId) return null;

  const cacheKey = `sofascore_standings:${leagueCode}`;
  const cached = getCached(cacheKey, TTL.STANDINGS);
  if (cached) return cached;

  try {
    const seasonsData = await fetchAPI(`/unique-tournament/${tournamentId}/seasons`);
    if (!seasonsData || !seasonsData.seasons || seasonsData.seasons.length === 0) return null;
    const currentSeason = seasonsData.seasons[0];

    const standingsData = await fetchAPI(`/unique-tournament/${tournamentId}/season/${currentSeason.id}/standings/total`);
    if (!standingsData || !standingsData.standings || standingsData.standings.length === 0) return null;

    const group = standingsData.standings[0];
    if (!group || !group.rows) return null;

    const formatted = group.rows.map(row => ({
      teamId: row.team.id?.toString(),
      name: row.team.name,
      logo: `https://api.sofascore.app/api/v1/team/${row.team.id}/image`,
      rank: row.position,
      played: row.matches,
      won: row.wins,
      drawn: row.draws,
      lost: row.losses,
      points: row.points,
      gf: row.scoresFor,
      ga: row.scoresAgainst,
      gd: row.scoresFor - row.scoresAgainst,
    }));

    setCache(cacheKey, formatted);
    return formatted;
  } catch (err) {
    logger.error(`getLeagueStandings failed for ${leagueCode}: ${err.message}`);
    return null;
  }
};

exports.getLeagueTopScorers = async (leagueCode, limit = 20) => {
  leagueCode = normalizeCompetitionCode(leagueCode);
  limit = normalizeLimit(limit, 20, 50);
  if (!leagueCode) return null;

  const tournamentId = SOFASCORE_LEAGUE_MAP[leagueCode];
  if (!tournamentId) return null;

  const cacheKey = `sofascore_scorers:${leagueCode}:${limit}`;
  const cached = getCached(cacheKey, TTL.PLAYER);
  if (cached) return cached;

  try {
    const seasonsData = await fetchAPI(`/unique-tournament/${tournamentId}/seasons`);
    if (!seasonsData || !seasonsData.seasons || seasonsData.seasons.length === 0) return null;
    const currentSeason = seasonsData.seasons[0];

    // Fetch players statistics sorted by goals
    const statsData = await fetchAPI(`/unique-tournament/${tournamentId}/season/${currentSeason.id}/statistics?limit=${limit}&order=-goals&accumulation=total`);
    if (!statsData || !statsData.results || statsData.results.length === 0) return null;

    const formatted = statsData.results.map((row, i) => ({
      rank: i + 1,
      name: row.player.name,
      playerId: row.player.id?.toString(),
      nationality: row.player.country?.name || '',
      team: row.team.name,
      teamLogo: `https://api.sofascore.app/api/v1/team/${row.team.id}/image`,
      goals: row.statistics.goals || 0,
      assists: row.statistics.assists || 0,
      penalties: row.statistics.penalties || 0,
      matches: row.statistics.appearances || 0,
    }));

    setCache(cacheKey, formatted);
    return formatted;
  } catch (err) {
    logger.error(`getLeagueTopScorers failed for ${leagueCode}: ${err.message}`);
    return null;
  }
};
