/**
 * @file kickoffApiService.js
 * @description KickOff API Client & Data Provider (api.kickoffapi.com).
 * Features intelligent multi-tier caching (RAM cache) to protect against daily limits,
 * automated fallbacks, and standard contract transformations for KickSphere.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('./cacheService');

const BASE_URL = 'https://api.kickoffapi.com';
const API_KEY = String(process.env.KICKOFF_API_KEY || '').trim();
const PLACEHOLDER_KEYS = new Set(['replace-me', 'replace-with-kickoff-api-key']);

const isConfigured = () => Boolean(API_KEY) && !PLACEHOLDER_KEYS.has(API_KEY.toLowerCase());

const currentFootballSeason = (date = new Date()) => {
  const month = date.getUTCMonth();
  return month >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
};

// League ID mapping (API-Football / KickOff API standard IDs)
const LEAGUE_MAP = {
  // Football-Data code -> KickOff API League ID
  PL: 39,       // Premier League
  PD: 140,      // La Liga
  SA: 135,      // Serie A
  BL1: 78,      // Bundesliga
  FL1: 61,      // Ligue 1
  CL: 2,        // UEFA Champions League
  EL: 3,        // UEFA Europa League
  PPL: 94,      // Primeira Liga
  DED: 88,      // Eredivisie
  BSA: 71,      // Serie A (Brazil)
  SPL: 307,     // Saudi Pro League
  WC: 1,        // World Cup
  EC: 4,        // European Championship
};

// Reverse mapping
const REVERSE_LEAGUE_MAP = Object.fromEntries(
  Object.entries(LEAGUE_MAP).map(([code, id]) => [id, code])
);

// Cache TTLs (ms)
const TTL = {
  STATUS: 10 * 60 * 1000,      // 10 minutes
  LIVE: 60 * 1000,             // 1 minute for live matches
  FIXTURES_DAY: 5 * 60 * 1000, // 5 minutes for daily fixtures
  STANDINGS: 30 * 60 * 1000,   // 30 minutes for standings
  SCORERS: 60 * 60 * 1000,     // 1 hour for top scorers
  TEAM: 2 * 60 * 60 * 1000,    // 2 hours for team info
  SQUAD: 2 * 60 * 60 * 1000,   // 2 hours for squad
};

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: {
    'User-Agent': 'KickSphere/2.0',
    'x-api-key': API_KEY,
    Accept: 'application/json',
  },
});

/**
 * Safe fetch with logging and error handling
 */
const safeFetch = async (endpoint, params = {}) => {
  if (!isConfigured()) return null;

  try {
    const response = await client.get(endpoint, { params });
    return response.data;
  } catch (error) {
    logger.error(`KickOff API error on ${endpoint}: ${error.message}`);
    return null;
  }
};
exports.safeFetch = safeFetch;

/**
 * 1. Fetch Account / Usage Status
 */
exports.getStatus = async () => {
  if (!isConfigured()) return null;

  const cacheKey = 'kickoff:status';
  const cached = getCached(cacheKey, TTL.STATUS);
  if (cached) return cached;

  const data = await safeFetch('/api/v1/status');
  if (data?.response) {
    setCache(cacheKey, data.response);
    return data.response;
  }
  return null;
};

/**
 * 2. Fetch Live Matches
 */
exports.getLiveMatches = async () => {
  if (!isConfigured()) return [];

  const cacheKey = 'kickoff:live';
  const cached = getCached(cacheKey, TTL.LIVE);
  if (cached) return cached;

  const data = await safeFetch('/api/v1/fixtures', { live: 'all' });
  const rawList = data?.response || [];

  const formatted = rawList.map(item => normalizeKickoffFixture(item)).filter(Boolean);
  setCache(cacheKey, formatted);
  logger.info(`✅ KickOff API: ${formatted.length} live matches loaded`);
  return formatted;
};

/**
 * 3. Fetch Matches by Date (YYYY-MM-DD or 'TODAY')
 */
exports.getMatchesByDate = async (dateStr) => {
  if (!isConfigured()) return [];

  let targetDate = dateStr;
  if (!targetDate || targetDate === 'TODAY') {
    targetDate = new Date().toISOString().split('T')[0];
  } else if (targetDate === 'YESTERDAY') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    targetDate = d.toISOString().split('T')[0];
  } else if (targetDate === 'TOMORROW') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    targetDate = d.toISOString().split('T')[0];
  }

  const cacheKey = `kickoff:matches:${targetDate}`;
  const cached = getCached(cacheKey, TTL.FIXTURES_DAY);
  if (cached) return cached;

  const data = await safeFetch('/api/v1/fixtures', { date: targetDate });
  const rawList = data?.response || [];

  const formatted = rawList.map(item => normalizeKickoffFixture(item)).filter(Boolean);
  setCache(cacheKey, formatted);
  logger.info(`✅ KickOff API: ${formatted.length} matches for ${targetDate}`);
  return formatted;
};

/**
 * 4. Fetch League Standings
 */
exports.getStandings = async (leagueCode = 'PL', season = currentFootballSeason()) => {
  if (!isConfigured()) return [];

  const leagueId = LEAGUE_MAP[String(leagueCode).toUpperCase()] || Number(leagueCode);
  if (!leagueId) return [];

  const cacheKey = `kickoff:standings:${leagueId}:${season}`;
  const cached = getCached(cacheKey, TTL.STANDINGS);
  if (cached) return cached;

  // Try requested season first, then the previous season if the new table is not populated yet.
  let data = await safeFetch('/api/v1/standings', { league: leagueId, season });
  if (!data?.response || data.response.length === 0) {
    data = await safeFetch('/api/v1/standings', { league: leagueId, season: season - 1 });
  }

  const rawLeague = data?.response?.[0]?.league;
  const table = rawLeague?.standings?.[0] || data?.response || [];

  const formatted = table.map((item, idx) => ({
    position: item.rank || item.position || idx + 1,
    team: {
      id: item.team?.id?.toString() || item.teamId?.toString() || '',
      name: item.team?.name || 'Unknown Team',
      shortName: item.team?.name || '',
      crest: item.team?.logo || `https://images.kickoffapi.com/images/logos/${item.teamId}.png`,
    },
    playedGames: item.allPlayed ?? item.all?.played ?? item.played ?? 0,
    won: item.allWin ?? item.all?.win ?? item.won ?? 0,
    draw: item.allDraw ?? item.all?.draw ?? item.draw ?? 0,
    lost: item.allLose ?? item.all?.lose ?? item.lost ?? 0,
    points: item.points ?? 0,
    goalsFor: item.allGoalsFor ?? item.all?.goals?.for ?? item.goalsFor ?? 0,
    goalsAgainst: item.allGoalsAgainst ?? item.all?.goals?.against ?? item.goalsAgainst ?? 0,
    goalDifference: item.goalsDiff ?? item.goalDifference ?? 0,
    form: item.form || '',
    description: item.description || '',
  })).filter(row => row.team.name);

  setCache(cacheKey, formatted);
  logger.info(`✅ KickOff API: ${formatted.length} standings entries for league ${leagueId}`);
  return formatted;
};

/**
 * 5. Fetch Top Scorers
 */
exports.getTopScorers = async (leagueCode = 'PL', limit = 20, season = currentFootballSeason()) => {
  if (!isConfigured()) return [];

  const leagueId = LEAGUE_MAP[String(leagueCode).toUpperCase()] || Number(leagueCode);
  if (!leagueId) return [];

  const cacheKey = `kickoff:scorers:${leagueId}:${season}:${limit}`;
  const cached = getCached(cacheKey, TTL.SCORERS);
  if (cached) return cached;

  let data = await safeFetch('/api/v1/players/topscorers', { league: leagueId, season });
  if (!data?.response || data.response.length === 0) {
    data = await safeFetch('/api/v1/players/topscorers', { league: leagueId, season: season - 1 });
  }
  const rawList = data?.response || [];

  const formatted = rawList.slice(0, limit).map((item, idx) => ({
    rank: idx + 1,
    player: {
      id: item.player?.id?.toString() || item.playerId?.toString() || '',
      name: item.player?.name || 'Player',
      photo: item.photo || item.player?.photo || '',
      nationality: item.player?.nationality || '',
      age: item.player?.age || null,
    },
    team: {
      id: item.team?.id?.toString() || item.teamId?.toString() || '',
      name: item.team?.name || '',
      crest: item.team?.logo || '',
    },
    goals: item.goals ?? item.statistics?.[0]?.goals?.total ?? 0,
    assists: item.assists ?? item.statistics?.[0]?.goals?.assists ?? 0,
    playedMatches: item.statistics?.[0]?.games?.appearences ?? null,
  }));

  setCache(cacheKey, formatted);
  logger.info(`✅ KickOff API: ${formatted.length} top scorers for league ${leagueId}`);
  return formatted;
};

/**
 * 6. Fetch Team Squad by Team ID or Name
 */
exports.getTeamSquad = async (teamIdOrName) => {
  if (!isConfigured()) return [];

  let numericId = parseInt(teamIdOrName, 10);
  if (!numericId) {
    const team = await exports.getTeamDetails(teamIdOrName);
    numericId = parseInt(team?.id, 10);
  }
  if (!numericId) return [];

  const cacheKey = `kickoff:squad:${numericId}`;
  const cached = getCached(cacheKey, TTL.SQUAD);
  if (cached) return cached;

  const data = await safeFetch('/api/v1/players/squads', { team: numericId });
  const rawList = data?.response || [];

  let players = [];
  if (rawList.length > 0 && rawList[0].players) {
    players = rawList[0].players;
  } else {
    players = rawList;
  }

  const formatted = players.map(item => {
    const p = item.player || item;
    return {
      id: p.id?.toString() || item.playerId?.toString() || '',
      name: p.name || `${p.firstname || ''} ${p.lastname || ''}`.trim() || 'Player',
      position: item.position || p.position || '',
      jerseyNumber: item.number || p.number || null,
      country: p.nationality || p.birth?.country || '',
      nationality: p.nationality || '',
      dateBorn: p.birth?.date || '',
      age: p.age || null,
      image: p.photo || (p.id ? `https://images.kickoffapi.com/images/players/${p.id}.png` : ''),
    };
  });

  setCache(cacheKey, formatted);
  logger.info(`✅ KickOff API: ${formatted.length} squad players for team ${numericId}`);
  return formatted;
};

/**
 * 7. Fetch Team Details & Venue
 */
exports.getTeamDetails = async (teamIdOrName) => {
  if (!isConfigured()) return null;

  const cacheKey = `kickoff:team:${teamIdOrName}`;
  const cached = getCached(cacheKey, TTL.TEAM);
  if (cached) return cached;

  let endpoint = '/api/v1/teams';
  let params = {};

  if (!isNaN(teamIdOrName)) {
    params.id = Number(teamIdOrName);
  } else {
    params.search = teamIdOrName.replace(/-/g, ' ');
  }

  const data = await safeFetch(endpoint, params);
  const rawList = data?.response || [];
  if (rawList.length === 0) return null;

  // 1. Prefer exact name match
  const searchStr = String(teamIdOrName).toLowerCase().trim();
  const exact = rawList.find(item => {
    const t = item.team || item;
    return (t.name || '').toLowerCase().trim() === searchStr;
  });

  // 2. Prefer senior team (skip youth/women squads if searching general name)
  const senior = rawList.find(item => {
    const t = item.team || item;
    const n = (t.name || '').toLowerCase();
    return !n.includes('u21') && !n.includes('u19') && !n.includes('u23') && !n.includes('women') && !n.includes(' w');
  });

  const raw = exact || senior || rawList[0];
  if (!raw) return null;

  const team = raw.team || raw;
  const venue = raw.venue || team.venue;

  const formatted = {
    id: team.id?.toString() || '',
    name: team.name || '',
    shortName: team.name || '',
    logo: team.logo || (team.id ? `https://images.kickoffapi.com/images/logos/${team.id}.png` : ''),
    country: team.countryName || team.country || '',
    founded: team.founded || null,
    venue: venue?.name ? `${venue.name}${venue.city ? ` (${venue.city})` : ''}` : '',
    venueImage: venue?.image || '',
    venueCapacity: venue?.capacity || null,
  };

  setCache(cacheKey, formatted);
  return formatted;
};


/**
 * 8. Fetch Team Recent & Upcoming Fixtures
 */
exports.getTeamFixtures = async (teamIdOrName) => {
  if (!isConfigured()) return { recent: [], upcoming: [] };

  let numericId = parseInt(teamIdOrName, 10);
  if (!numericId) {
    const team = await exports.getTeamDetails(teamIdOrName);
    numericId = parseInt(team?.id, 10);
  }
  if (!numericId) return { recent: [], upcoming: [] };

  const cacheKey = `kickoff:team_fixtures:${numericId}`;
  const cached = getCached(cacheKey, TTL.FIXTURES_DAY);
  if (cached) return cached;

  const [lastData, nextData] = await Promise.all([
    safeFetch('/api/v1/fixtures', { team: numericId, last: 5 }),
    safeFetch('/api/v1/fixtures', { team: numericId, next: 5 }),
  ]);

  const recent = (lastData?.response || []).map(normalizeKickoffFixture).filter(Boolean);
  const upcoming = (nextData?.response || []).map(normalizeKickoffFixture).filter(Boolean);

  const result = { recent, upcoming };
  setCache(cacheKey, result);
  return result;
};

/**
 * 9. Fetch Player Details by ID or Name
 */
exports.getPlayerDetails = async (playerIdOrName) => {
  const cacheKey = `kickoff:player:${playerIdOrName}`;
  const cached = getCached(cacheKey, TTL.SQUAD);
  if (cached) return cached;

  const season = currentFootballSeason();
  let params = { season };
  if (!isNaN(playerIdOrName)) {
    params.id = Number(playerIdOrName);
  } else {
    params.search = String(playerIdOrName).replace(/-/g, ' ').trim();
  }

  let data = await safeFetch('/api/v1/players', params);
  
  // Check if player has 0 appearances in current season, if so try previous season
  let hasAppearances = false;
  if (data?.response && data.response.length > 0) {
    const st = data.response[0]?.statistics?.[0] || {};
    const app = st.games?.appearences ?? st.games?.appearances ?? 0;
    if (Number(app) > 0) hasAppearances = true;
  }

  let actualSeason = season;
  if (!data?.response || data.response.length === 0 || !hasAppearances) {
    const prevData = await safeFetch('/api/v1/players', { ...params, season: season - 1 });
    if (prevData?.response && prevData.response.length > 0) {
      data = prevData;
      actualSeason = season - 1;
    }
  }

  const rawList = data?.response || [];
  if (rawList.length === 0) return null;

  // Sort rawList by appearances to prefer active/famous players
  rawList.sort((a, b) => {
    const appA = Number(a.statistics?.[0]?.games?.appearences ?? a.statistics?.[0]?.games?.appearances ?? 0);
    const appB = Number(b.statistics?.[0]?.games?.appearences ?? b.statistics?.[0]?.games?.appearances ?? 0);
    return appB - appA;
  });

  const searchStr = String(playerIdOrName).toLowerCase().replace(/-/g, ' ').trim();
  const removeAccentsAndDashes = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/-/g, ' ');

  const exact = rawList.find(item => {
    const p = item.player || item;
    const fn = removeAccentsAndDashes(`${p.firstname || ''} ${p.lastname || ''}`.toLowerCase());
    const n = removeAccentsAndDashes((p.name || '').toLowerCase());
    return fn.includes(searchStr) || n.includes(searchStr) || searchStr.includes(n);
  });

  const raw = exact || rawList[0];
  if (!raw) return null;

  const player = raw.player || raw;
  const stat = raw.statistics?.[0] || {};
  const team = stat.team || {};
  const games = stat.games || {};
  const goals = stat.goals || {};
  const passes = stat.passes || {};
  const tackles = stat.tackles || {};
  const dribbles = stat.dribbles || {};
  const cards = stat.cards || {};
  const shots = stat.shots || {};
  const appearances = games.appearences ?? games.appearances ?? null;
  const appearancesBase = Number(appearances) > 0 ? Number(appearances) : null;
  const perGame = (total) => {
    if (total === undefined || total === null || appearancesBase === null) return null;
    return parseFloat((Number(total) / appearancesBase).toFixed(1));
  };

  const formatted = {
    id: player.id?.toString() || '',
    name: `${player.firstname || ''} ${player.lastname || ''}`.trim() || player.name || '',
    shortName: player.name || '',
    team: team.name || '',
    teamBadge: team.logo || '',
    jerseyNumber: games.number || null,
    position: games.position || '',
    country: player.nationality || player.birth?.country || '',
    flag: '',
    dateBorn: player.birth?.date || '',
    birthLocation: player.birth?.place || '',
    height: player.height || '',
    weight: player.weight || '',
    preferredFoot: player.foot || '',
    marketValue: player.marketValue || null,
    wage: null,
    contractUntil: null,
    image: player.photo || (player.id ? `https://images.kickoffapi.com/images/players/${player.id}.png` : ''),
    description: '',
    seasonStats: {
      season: `${actualSeason}/${actualSeason + 1}`,
      matches: appearances ?? 0,
      minutes: games.minutes ?? 0,
      goals: goals.total ?? 0,
      assists: goals.assists ?? 0,
      rating: games.rating ? parseFloat(games.rating) : null,
      shotsPerGame: perGame(shots.total),
      passAccuracy: passes.accuracy ? parseFloat(passes.accuracy) : null,
      keyPassesPerGame: perGame(passes.key),
      dribblesPerGame: perGame(dribbles.success),
      tacklesPerGame: perGame(tackles.total),
      yellowCards: cards.yellow || 0,
      redCards: cards.red || 0,
      goalContributions: (goals.total || 0) + (goals.assists || 0),
      penaltyGoals: stat.penalty?.scored || 0,
      cleanSheets: games.position === 'Goalkeeper' ? (games.cleanSheets ?? null) : null,
      saves: goals.saves || 0,
    },
    formerTeams: (raw.transfers || []).map(tr => ({
      team: tr.teams?.out?.name || '',
      teamBadge: tr.teams?.out?.logo || '',
      joined: tr.date ? tr.date.split('-')[0] : '',
      departed: '',
      moveType: tr.type || '',
    })),
    honours: [],
    contracts: [],
    milestones: [],
  };

  setCache(cacheKey, formatted);
  return formatted;
};



/**
 * Normalizer: transforms a raw KickOff fixture into standard KickSphere MatchModel format
 */
function normalizeKickoffFixture(item) {
  if (!item) return null;

  // Support both fixture-wrapped and flat format
  const f = item.fixture || item;
  const h = item.homeTeam || item.teams?.home || {};
  const a = item.awayTeam || item.teams?.away || {};
  const g = item.goals || { home: item.goalsHome, away: item.goalsAway };
  const league = item.league || {};

  const homeScore = g.home ?? null;
  const awayScore = g.away ?? null;

  let statusShort = f.statusShort || f.status?.short || 'NS';
  let statusLong = f.statusLong || f.status?.long || 'Not Started';

  // Normalize status
  let mappedStatus = 'SCHEDULED';
  if (['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(statusShort)) {
    mappedStatus = 'IN_PLAY';
  } else if (['FT', 'AET', 'PEN'].includes(statusShort)) {
    mappedStatus = 'FINISHED';
  } else if (['POST', 'CANC', 'ABD'].includes(statusShort)) {
    mappedStatus = 'POSTPONED';
  }

  // Determine winner
  let winner = null;
  if (homeScore !== null && awayScore !== null) {
    if (homeScore > awayScore) winner = 'HOME_TEAM';
    else if (awayScore > homeScore) winner = 'AWAY_TEAM';
    else winner = 'DRAW';
  }

  const leagueCode = REVERSE_LEAGUE_MAP[league.id || item.leagueId] || 'OTHER';

  return {
    id: f.id?.toString() || item.id?.toString() || `${Date.now()}-${Math.random()}`,
    utcDate: f.date || item.date || new Date().toISOString(),
    status: mappedStatus,
    statusShort,
    statusLong,
    minute: f.elapsed ?? item.elapsed ?? null,
    competition: {
      id: league.id || item.leagueId || 0,
      name: league.name || 'League',
      code: leagueCode,
      emblem: league.logo || '',
      country: league.country || 'International',
    },
    homeTeam: {
      id: h.id?.toString() || '',
      name: h.name || 'Home Team',
      shortName: h.name || 'Home',
      crest: h.logo || `https://images.kickoffapi.com/images/logos/${h.id}.png`,
    },
    awayTeam: {
      id: a.id?.toString() || '',
      name: a.name || 'Away Team',
      shortName: a.name || 'Away',
      crest: a.logo || `https://images.kickoffapi.com/images/logos/${a.id}.png`,
    },
    score: {
      winner,
      duration: 'REGULAR',
      fullTime: {
        home: homeScore,
        away: awayScore,
      },
      halfTime: {
        home: item.scoreHalfHome ?? item.score?.halftime?.home ?? null,
        away: item.scoreHalfAway ?? item.score?.halftime?.away ?? null,
      },
    },
  };
}

module.exports = {
  ...exports,
  isConfigured,
  currentFootballSeason,
  LEAGUE_MAP,
};
