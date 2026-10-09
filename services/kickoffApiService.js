/**
 * @file kickoffApiService.js
 * @description KickOff API Client & Data Provider (api.kickoffapi.com).
 * Features intelligent multi-tier caching (RAM cache) to protect against daily limits,
 * automated fallbacks, and standard contract transformations for KickSphere.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('./cacheService');
const { playerHonourInput, firstPlayerImage } = require('../utils/playerHonours');
const { normalizeKickoffHonoursHistory } = require('../utils/kickoffHonoursHistory');
const { playerFacts } = require('../utils/lineupPlayerMetrics');

const BASE_URL = 'https://api.kickoffapi.com';
const API_KEY = String(process.env.KICKOFF_API_KEY || '').trim();
const PLACEHOLDER_KEYS = new Set(['replace-me', 'replace-with-kickoff-api-key']);

const isConfigured = () => Boolean(API_KEY) && !PLACEHOLDER_KEYS.has(API_KEY.toLowerCase());

const currentFootballSeason = (date = new Date()) => {
  const month = date.getUTCMonth();
  return month >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
};

const ageFromBirthDate = (dateBorn, currentDate = new Date()) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateBorn || ''))) return null;
  const birth = new Date(`${dateBorn}T00:00:00Z`);
  if (!Number.isFinite(birth.getTime()) || birth.toISOString().slice(0, 10) !== dateBorn) return null;
  let age = currentDate.getUTCFullYear() - birth.getUTCFullYear();
  if (currentDate.getUTCMonth() < birth.getUTCMonth() ||
    (currentDate.getUTCMonth() === birth.getUTCMonth() && currentDate.getUTCDate() < birth.getUTCDate())) age--;
  return age >= 0 && age <= 100 ? age : null;
};

function positiveProviderId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  return /^[1-9]\d{0,14}$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}
function squadRows(rows, coverage) {
  Object.defineProperty(rows, 'coverage', { value: { source: 'kickoffapi', ...coverage },
    enumerable: false, configurable: true });
  return rows;
}
function sourceNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function normalizePlayerStatistics(block) {
  const team = block.team || {}, league = block.league || {}, games = block.games || {};
  const goals = block.goals || {}, shots = block.shots || {}, passes = block.passes || {};
  const teamId = positiveProviderId(team.id), leagueId = positiveProviderId(league.id);
  const year = positiveProviderId(league.season);
  const seasonYear = year >= 1900 && year <= 2099 ? year : null;
  // league.season is the provider's declared year, not a generic European range.
  // Preserve an explicit season ID only when the provider actually supplies it.
  const season = typeof league.season === 'string' || typeof league.season === 'number'
    ? String(league.season).trim() : '';
  const seasonId = positiveProviderId(league.season_id ?? league.seasonId);
  const matches = sourceNumber(games.appearences ?? games.appearances);
  const perGame = total => {
    const value = sourceNumber(total);
    return value !== null && matches > 0 ? Number((value / matches).toFixed(1)) : null;
  };
  const totalGoals = sourceNumber(goals.total), assists = sourceNumber(goals.assists);
  return {
    teamId: teamId ? 'ko_t_' + teamId : null, team: typeof team.name === 'string' ? team.name : '',
    teamBadge: firstPlayerImage(team.logo), teamIsNational: typeof team.national === 'boolean' ? team.national : null,
    leagueId, competitionId: leagueId ? REVERSE_LEAGUE_MAP[leagueId] || 'KO:' + leagueId : null,
    competition: typeof league.name === 'string' ? league.name : '', league: typeof league.name === 'string' ? league.name : '',
    seasonId, season, seasonInfo: { ...(seasonId ? { id: seasonId } : {}), name: season, year: seasonYear },
    scope: teamId && leagueId && seasonYear ? 'team_competition_season' : 'unverified_statistics_scope',
    source: 'kickoffapi', provider: 'kickoffapi',
    jerseyNumber: sourceNumber(games.number), position: typeof games.position === 'string' ? games.position : '',
    matches, minutes: sourceNumber(games.minutes), goals: totalGoals, assists,
    rating: sourceNumber(games.rating), shots: sourceNumber(shots.total), shotsOnTarget: sourceNumber(shots.on),
    shotsPerGame: perGame(shots.total), passes: sourceNumber(passes.total), passAccuracy: null,
    passesAccuracy: null, passesAccuracyRaw: sourceNumber(passes.accuracy),
    keyPasses: sourceNumber(passes.key), keyPassesPerGame: perGame(passes.key),
    dribbles: sourceNumber(block.dribbles?.success), dribblesPerGame: perGame(block.dribbles?.success),
    tackles: sourceNumber(block.tackles?.total), tacklesPerGame: perGame(block.tackles?.total),
    interceptions: sourceNumber(block.tackles?.interceptions),
    yellowCards: sourceNumber(block.cards?.yellow), redCards: sourceNumber(block.cards?.red),
    goalContributions: totalGoals !== null && assists !== null ? totalGoals + assists : null,
    penaltyGoals: sourceNumber(block.penalty?.scored),
    cleanSheets: games.position === 'Goalkeeper' ? sourceNumber(games.cleanSheets) : null,
    saves: sourceNumber(goals.saves),
  };
}

// League ID mapping (API-Football / KickOff API standard IDs)

const FAMOUS_CLUBS_MAP = {
  'arsenal': 42,
  'chelsea': 49,
  'liverpool': 40,
  'manchester city': 50,
  'manchester-city': 50,
  'manchester united': 33,
  'manchester-united': 33,
  'tottenham': 47,
  'tottenham hotspur': 47,
  'newcastle': 34,
  'newcastle united': 34,
  'aston villa': 66,
  'real madrid': 541,
  'real-madrid': 541,
  'barcelona': 529,
  'atletico madrid': 530,
  'atletico-madrid': 530,
  'bayern munich': 157,
  'bayern-munich': 157,
  'bayern': 157,
  'borussia dortmund': 165,
  'dortmund': 165,
  'bayer leverkusen': 168,
  'leverkusen': 168,
  'paris saint-germain': 85,
  'paris saint germain': 85,
  'psg': 85,
  'juventus': 496,
  'inter': 505,
  'inter milan': 505,
  'ac milan': 489,
  'milan': 489,
  'roma': 497,
  'as roma': 497,
  'napoli': 492,
  'al-hilal': 2542,
  'al hilal': 2542,
  'al-nassr': 2544,
  'al nassr': 2544,
  'al-ittihad': 2543,
  'al ittihad': 2543,
  'al-ahli': 2541,
  'al ahli': 2541,
  'benfica': 211,
  'porto': 212,
  'sporting cp': 228,
  'ajax': 194,
  'feyenoord': 197,
  'galatasaray': 645,
  'fenerbahce': 611,
  'flamengo': 127,
  'palmeiras': 121,
  'boca juniors': 451,
  'river plate': 435,
  'inter miami': 9568
};

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
  HONOURS: 24 * 60 * 60 * 1000, // Historical player records change infrequently.
  HONOURS_FAILURE: 5 * 60 * 1000,
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

let isQuotaExhausted = false;
let quotaExhaustedUntil = 0;
const pendingProviderReads = new Map();
const MAX_PENDING_PROVIDER_READS = 64;

function providerList(data) {
  // Access errors are often returned with HTTP 200 and response: []. They must
  // not become a successful empty cache entry that masks the next recovery.
  const errors = data?.errors;
  if (errors && (typeof errors !== 'object' || Object.keys(errors).length > 0)) return null;
  return Array.isArray(data?.response) ? data.response : null;
}
function unavailableRows(reason = 'provider_unavailable') {
  return squadRows([], { available: false, complete: false, partial: true, reason });
}
function declaredFilterMismatch(data, expected) {
  return Object.entries(expected).some(([key, value]) =>
    data?.parameters?.[key] !== undefined && String(data.parameters[key]) !== String(value));
}

/**
 * Safe fetch with logging, error handling and 429 rate limit backoff
 */
const safeFetch = async (endpoint, params = {}) => {
  if (!isConfigured()) return null;
  if (isQuotaExhausted && Date.now() < quotaExhaustedUntil) {
    return null;
  }

  const sortedParams = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  const key = JSON.stringify([endpoint, sortedParams]);
  const existing = pendingProviderReads.get(key);
  if (existing) return structuredClone(await existing);
  if (pendingProviderReads.size >= MAX_PENDING_PROVIDER_READS) {
    logger.warn('[KickOff API] Upstream request capacity reached');
    return null;
  }
  const pending = (async () => {
    try {
      const response = await client.get(endpoint, { params: sortedParams });
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) {
        isQuotaExhausted = true;
        quotaExhaustedUntil = Date.now() + 60 * 60 * 1000;
        logger.warn(`[KickOff API] Free allowance exhausted or rate limited (429). Backing off for 1 hour.`);
        return null;
      }
      logger.error(`KickOff API error on ${endpoint}: ${error.message}`);
      return null;
    }
  })();
  pendingProviderReads.set(key, pending);
  // Each consumer normalizes its own response. Sharing a mutable raw envelope
  // could let one route's normalization alter another user's result.
  try { return structuredClone(await pending); }
  finally { pendingProviderReads.delete(key); }
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
  if (data?.response && (!data.errors || Object.keys(data.errors).length === 0)) {
    setCache(cacheKey, data.response, TTL.STATUS);
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
  const rawList = providerList(data);
  if (!rawList) return unavailableRows();

  const formatted = rawList.map(item => normalizeKickoffFixture(item)).filter(Boolean);
  setCache(cacheKey, formatted, TTL.LIVE);
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
  const rawList = providerList(data);
  if (!rawList) return unavailableRows();

  const formatted = rawList.map(item => normalizeKickoffFixture(item)).filter(Boolean);
  setCache(cacheKey, formatted, TTL.FIXTURES_DAY);
  logger.info(`✅ KickOff API: ${formatted.length} matches for ${targetDate}`);
  return formatted;
};

/**
 * Fetch Upcoming Fixtures for a League
 */
exports.getLeagueFixtures = async (leagueCode, count = 15) => {
  if (!isConfigured()) return [];

  const leagueId = LEAGUE_MAP[String(leagueCode).toUpperCase()] || Number(leagueCode);
  if (!leagueId) return [];

  const cacheKey = `kickoff:league_fixtures:${leagueId}:${count}`;
  const cached = getCached(cacheKey, TTL.FIXTURES_DAY);
  if (cached) return cached;

  const data = await safeFetch('/api/v1/fixtures', { league: leagueId, next: count });
  const rawList = providerList(data);
  if (!rawList) return unavailableRows();

  const formatted = rawList.map(item => normalizeKickoffFixture(item)).filter(Boolean);
  setCache(cacheKey, formatted, TTL.FIXTURES_DAY);
  logger.info(`✅ KickOff API: ${formatted.length} upcoming fixtures for league ${leagueCode} (${leagueId})`);
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

  const data = await safeFetch('/api/v1/standings', { league: leagueId, season });
  const rawList = providerList(data);
  if (!rawList) return unavailableRows();
  if (declaredFilterMismatch(data, { league: leagueId, season })) {
    return unavailableRows('provider_statistics_scope_mismatch');
  }
  const rawLeague = data?.response?.[0]?.league;
  let table = rawList;
  if (rawLeague) {
    if (rawList.some(item => !item?.league ||
        (item.league.id !== undefined && Number(item.league.id) !== leagueId) ||
        (item.league.season !== undefined && String(item.league.season) !== String(season)))) {
      return unavailableRows('provider_statistics_scope_mismatch');
    }
    if (rawList.some(item => !Array.isArray(item.league.standings) ||
        item.league.standings.some(group => !Array.isArray(group)))) return unavailableRows();
    // Cup/group stages supply several tables, not just standings[0].
    table = rawList.flatMap(item => item.league.standings.flat());
  }
  if (!Array.isArray(table) || table.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return unavailableRows();

  const formatted = table.map((item, idx) => ({
    position: item.rank ?? item.position ?? null,
    season,
    competition: leagueCode,
    team: {
      id: item.team?.id || item.teamId ? 'ko_t_' + String(item.team?.id || item.teamId) : '',
      provider: 'kickoffapi',
      providerId: item.team?.id?.toString() || item.teamId?.toString() || '',
      name: item.team?.name || 'Unknown Team',
      shortName: item.team?.name || '',
      crest: item.team?.logo || `https://images.kickoffapi.com/images/logos/${item.teamId}.png`,
    },
    playedGames: item.allPlayed ?? item.all?.played ?? item.played ?? null,
    won: item.allWin ?? item.all?.win ?? item.won ?? null,
    draw: item.allDraw ?? item.all?.draw ?? item.draw ?? null,
    lost: item.allLose ?? item.all?.lose ?? item.lost ?? null,
    points: item.points ?? null,
    goalsFor: item.allGoalsFor ?? item.all?.goals?.for ?? item.goalsFor ?? null,
    goalsAgainst: item.allGoalsAgainst ?? item.all?.goals?.against ?? item.goalsAgainst ?? null,
    goalDifference: item.goalsDiff ?? item.goalDifference ?? null,
    form: item.form || '',
    description: item.description || '',
    group: typeof item.group === 'string' ? item.group : '',
  })).filter(row => row.team.name);

  setCache(cacheKey, formatted, TTL.STANDINGS);
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

  const data = await safeFetch('/api/v1/players/topscorers', { league: leagueId, season });
  const rawList = providerList(data);
  if (!rawList) return unavailableRows();
  if (declaredFilterMismatch(data, { league: leagueId, season })) {
    return unavailableRows('provider_statistics_scope_mismatch');
  }
  let rejectedRows = 0;
  const formatted = rawList.slice(0, limit).map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { rejectedRows++; return null; }
    const blocks = Array.isArray(item.statistics) ? item.statistics.filter(block =>
      block && typeof block === 'object' && !Array.isArray(block)) : [];
    const declared = blocks.filter(block => block.league?.id !== undefined || block.league?.season !== undefined);
    const eligible = blocks.filter(block =>
      (block.league?.id === undefined || Number(block.league.id) === leagueId) &&
      (block.league?.season === undefined || String(block.league.season) === String(season)));
    if ((item.league?.id !== undefined && Number(item.league.id) !== leagueId) ||
        (item.season !== undefined && String(item.season) !== String(season)) ||
        (declared.length > 0 && eligible.length === 0)) { rejectedRows++; return null; }
    const stats = eligible.length === 1 ? eligible[0] : null;
    if (item.team?.id !== undefined && stats?.team?.id !== undefined &&
        Number(item.team.id) !== Number(stats.team.id)) { rejectedRows++; return null; }
    const team = item.team || stats?.team || {};
    return {
    rank: idx + 1,
    season,
    competition: leagueCode,
    player: {
      id: item.player?.id || item.playerId ? 'ko_p_' + String(item.player?.id || item.playerId) : '',
      provider: 'kickoffapi',
      providerId: item.player?.id?.toString() || item.playerId?.toString() || '',
      name: item.player?.name || 'Player',
      photo: firstPlayerImage(item.photo, item.image, item.player?.photo, item.player?.image, item.player?.logo),
      nationality: item.player?.nationality || '',
      age: ageFromBirthDate(item.player?.birth?.date) ?? item.player?.age ?? null,
    },
    team: {
      id: team.id || item.teamId ? 'ko_t_' + String(team.id || item.teamId) : '',
      provider: 'kickoffapi',
      providerId: team.id?.toString() || item.teamId?.toString() || '',
      name: team.name || '',
      crest: team.logo || '',
    },
    goals: sourceNumber(item.goals) ?? sourceNumber(stats?.goals?.total),
    assists: sourceNumber(item.assists) ?? sourceNumber(stats?.goals?.assists),
    playedMatches: sourceNumber(stats?.games?.appearences ?? stats?.games?.appearances),
  };
  }).filter(Boolean);
  if (rawList.length > 0 && formatted.length === 0) return unavailableRows('provider_statistics_scope_mismatch');
  squadRows(formatted, { available: true, complete: false, partial: true,
    rejectedRows, reason: rejectedRows ? 'provider_statistics_scope_mismatch' : 'provider_statistics_scope_not_guaranteed' });

  if (rejectedRows === 0) setCache(cacheKey, formatted, TTL.SCORERS);
  logger.info(`✅ KickOff API: ${formatted.length} top scorers for league ${leagueId}`);
  return formatted;
};

/**
 * 6. Fetch Team Squad by Team ID or Name
 */
exports.getTeamSquad = async (teamIdOrName) => {
  const unavailable = (reason, context = {}) => squadRows([], { available: false, complete: false,
    partial: true, rosterAvailable: false, reason, ...context });
  if (!isConfigured()) return unavailable('provider_unconfigured');

  const rawTeamId = String(teamIdOrName || '').replace(/^ko_t_/, '');
  let numericId = positiveProviderId(rawTeamId);
  if (!numericId) {
    const team = await exports.getTeamDetails(teamIdOrName);
    numericId = positiveProviderId(team?.providerId || String(team?.id || "").replace(/^ko_t_/, ""));
  }
  if (!numericId) return unavailable('provider_team_identity_unavailable');

  const cacheKey = `kickoff:squad:${numericId}`;
  const cached = getCached(cacheKey, TTL.SQUAD);
  if (cached) return cached;

  const data = await safeFetch('/api/v1/players/squads', { team: numericId });
  const rosterContext = { teamId: 'ko_t_' + numericId };
  if (data?.parameters?.team !== undefined && positiveProviderId(data.parameters.team) !== numericId) {
    return unavailable('provider_team_identity_mismatch', rosterContext);
  }
  const rawList = data?.response;
  if (!Array.isArray(rawList) || !rawList.length ||
      (data.errors && Object.keys(data.errors).length > 0)) return unavailable('provider_squad_unavailable', rosterContext);
  // A successful filter alone does not verify the returned roster's owner.
  // Reject contradictions before any rows enter the requested team's cache.
  if (rawList.some(row => positiveProviderId(row?.team?.id) !== numericId)) {
    return unavailable('provider_team_identity_mismatch', rosterContext);
  }
  if (rawList.some(row => !Array.isArray(row.players))) return unavailable('provider_squad_unavailable', rosterContext);
  const players = rawList.flatMap(row => row.players);
  const validPlayers = players.filter(item => positiveProviderId(item?.player?.id ?? item?.id ?? item?.playerId));
  const formatted = validPlayers.map(item => {
    const p = item.player || item;
    const playerId = positiveProviderId(p.id ?? item.playerId);
    const wrapperMatchesPlayer = !item.player || [item.id, item.playerId].every(value =>
      value === undefined || value === null || value === '' || positiveProviderId(value) === playerId);
    return {
      id: 'ko_p_' + playerId,
      ...playerFacts(p),
      provider: 'kickoffapi',
      providerId: String(playerId),
      name: p.name || `${p.firstname || ''} ${p.lastname || ''}`.trim() || 'Player',
      position: item.position || p.position || '',
      number: item.number || p.number || null,
      jerseyNumber: item.number || p.number || null,
      country: p.nationality || p.birth?.country || '',
      nationality: p.nationality || '',
      dateBorn: p.birth?.date || '',
      age: ageFromBirthDate(p.birth?.date) ?? p.age ?? null,
      image: firstPlayerImage(p.photo, p.image, p.logo, wrapperMatchesPlayer ? item.photo : '', wrapperMatchesPlayer ? item.image : '') ||
        (p.id ? `https://images.kickoffapi.com/images/players/${p.id}.png` : ''),
    };
  });
  const complete = Number(data.paging?.current) === 1 && Number(data.paging?.total) === 1 &&
    Number(data.results) === rawList.length && validPlayers.length === players.length;
  squadRows(formatted, { available: true, complete, partial: !complete, rosterAvailable: true,
    scope: 'team_roster', temporalScope: 'current', teamId: 'ko_t_' + numericId, invalidRows: players.length - validPlayers.length });
  setCache(cacheKey, formatted, TTL.SQUAD);
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

  const rawTeamId = String(teamIdOrName || '').replace(/^ko_t_/, '');
  const cleanTeamName = rawTeamId.toLowerCase().trim();
  if (/^\d+$/.test(rawTeamId)) {
    params.id = Number(rawTeamId);
  } else if (FAMOUS_CLUBS_MAP[cleanTeamName]) {
    params.id = FAMOUS_CLUBS_MAP[cleanTeamName];
  } else {
    params.search = teamIdOrName.replace(/-/g, ' ');
  }

  const data = await safeFetch(endpoint, params);
  const rawList = providerList(data);
  if (!rawList) return null;
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

  const raw = params.id ? rawList.find(item => Number((item.team || item).id) === params.id) : (exact || (rawList.length === 1 ? senior : null));
  if (!raw) return null;

  const team = raw.team || raw;
  const venue = raw.venue || team.venue;

  const formatted = {
    id: team.id ? 'ko_t_' + String(team.id) : '',
    provider: 'kickoffapi',
    providerId: team.id?.toString() || '',
    name: team.name || '',
    shortName: team.name || '',
    logo: team.logo || (team.id ? `https://images.kickoffapi.com/images/logos/${team.id}.png` : ''),
    country: team.countryName || team.country || '',
    ...Object.fromEntries(['national', 'is_national', 'isNational', 'is_women', 'isWomen']
      .filter(key => typeof team[key] === 'boolean').map(key => [key, team[key]])),
    ...Object.fromEntries(['type', 'gender', 'category', 'ageGroup', 'age_group']
      .filter(key => typeof team[key] === 'string' && team[key].trim().length > 0 && team[key].trim().length <= 100)
      .map(key => [key, team[key].trim()])),
    founded: team.founded || null,
    venue: venue?.name ? `${venue.name}${venue.city ? ` (${venue.city})` : ''}` : '',
    venueImage: venue?.image || '',
    venueCapacity: venue?.capacity || null,
  };

  setCache(cacheKey, formatted, TTL.TEAM);
  return formatted;
};


/**
 * 8. Fetch Team Recent & Upcoming Fixtures
 */
exports.getTeamFixtures = async (teamIdOrName) => {
  if (!isConfigured()) return null;

  const rawTeamId = String(teamIdOrName || '').replace(/^ko_t_/, '');
  let numericId = /^\d+$/.test(rawTeamId) ? Number(rawTeamId) : null;
  if (!numericId) {
    const team = await exports.getTeamDetails(teamIdOrName);
    numericId = Number(team?.providerId || String(team?.id || "").replace(/^ko_t_/, ""));
  }
  if (!numericId) return null;

  const cacheKey = `kickoff:team_fixtures:${numericId}`;
  const cached = getCached(cacheKey, TTL.FIXTURES_DAY);
  if (cached) return cached;

  const [lastData, nextData] = await Promise.all([
    safeFetch('/api/v1/fixtures', { team: numericId, last: 5 }),
    safeFetch('/api/v1/fixtures', { team: numericId, next: 5 }),
  ]);

  const scopedBatch = (data, window) => {
    const rawRows = providerList(data);
    if (!rawRows || declaredFilterMismatch(data, { team: numericId, [window]: 5 })) return {
      rows: null, invalidRows: 0, reason: rawRows ? 'provider_fixture_scope_mismatch' : 'provider_unavailable',
    };
    const rows = rawRows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
      .map(normalizeKickoffFixture).filter(row => row &&
        [row.homeTeam.id, row.awayTeam.id].includes('ko_t_' + numericId));
    const invalidRows = rawRows.length - rows.length;
    if (rawRows.length > 0 && rows.length === 0) return { rows: null, invalidRows, reason: 'provider_fixture_scope_mismatch' };
    return { rows, invalidRows, rawRows, reason: invalidRows ? 'provider_fixture_scope_mismatch' : null };
  };
  const last = scopedBatch(lastData, 'last'), next = scopedBatch(nextData, 'next');
  if (!last.rows && !next.rows) return null;
  const recent = last.rows || [], upcoming = next.rows || [];
  const usable = Boolean(last.rows && next.rows) && last.invalidRows === 0 && next.invalidRows === 0;
  const fullPage = (data, rows) => Number(data?.paging?.current) === 1 &&
    Number(data?.paging?.total) === 1 && Number(data?.results) === rows?.length;
  const complete = usable && fullPage(lastData, last.rawRows) && fullPage(nextData, next.rawRows);
  const result = { recent, upcoming, coverage: { source: 'kickoffapi', available: true,
    complete, partial: !complete, scope: 'team_fixture_window',
    recentAvailable: Boolean(last.rows), upcomingAvailable: Boolean(next.rows),
    rejectedRows: last.invalidRows + next.invalidRows,
    ...(last.reason || next.reason ? { reason: last.reason || next.reason } : {}) } };
  // Keep a valid half for this request, but retry the missing half next time.
  if (usable) setCache(cacheKey, result, TTL.FIXTURES_DAY);
  return result;
};

const pendingPlayerHonours = new Map();

exports.getPlayerHonours = async (playerId) => {
  const rawId = String(playerId || '').replace(/^ko_p_/, '');
  const scoped = 'ko_p_' + rawId;
  const unavailable = () => normalizeKickoffHonoursHistory(undefined, { playerId: scoped, rawPlayerId: rawId });
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) return unavailable();
  const key = `kickoff:player-honours:${rawId}`;
  const cached = getCached(key);
  if (cached) return cached;
  if (pendingPlayerHonours.has(key)) return pendingPlayerHonours.get(key);
  const pending = (async () => {
    // This endpoint and player filter are documented in the provider's v1 reference.
    const data = await safeFetch('/api/v1/trophies', { player: Number(rawId) });
    const errors = data?.errors;
    const valid = Array.isArray(data?.response) && (!errors || Object.keys(errors).length === 0) &&
      (data.parameters?.player === undefined || String(data.parameters.player) === rawId);
    if (!valid) {
      const result = unavailable();
      setCache(key, result, TTL.HONOURS_FAILURE);
      return result;
    }
    const total = Number(data.paging?.total), current = Number(data.paging?.current);
    const responseComplete = total === 1 && current === 1 && Number(data.results) === data.response.length;
    const result = normalizeKickoffHonoursHistory(data.response, { playerId: scoped, rawPlayerId: rawId, responseComplete });
    setCache(key, result, result.honoursCoverage.rejected > 0 ? TTL.HONOURS_FAILURE : TTL.HONOURS);
    return result;
  })();
  pendingPlayerHonours.set(key, pending);
  try { return await pending; } finally { pendingPlayerHonours.delete(key); }
};

/**
 * 9. Fetch Player Details by ID or Name
 */
exports.getPlayerDetails = async (playerIdOrName, options = {}) => {
  const scopeKey = [options.season ?? '', options.competition ?? '', options.teamId ?? ''].join(':');
  const cacheKey = `kickoff:player:${playerIdOrName}:${scopeKey}`;
  const cached = getCached(cacheKey, TTL.SQUAD);
  if (cached) {
    if (cached.honoursCoverage?.available === false || cached.honoursCoverage?.rejected > 0) {
      // Honour failures retry after their own TTL, without reloading biography
      // or resetting the full profile's two-hour cache lifetime.
      const honours = await exports.getPlayerHonours(cached.id);
      return { ...cached, ...honours };
    }
    return cached;
  }

  const suppliedSeason = options.season === undefined ? currentFootballSeason() : positiveProviderId(options.season);
  const season = suppliedSeason >= 1900 && suppliedSeason <= 2099 ? suppliedSeason : null;
  if (!season) return null;
  let params = { season };
  const rawPlayerId = String(playerIdOrName || '').replace(/^ko_p_/, '');
  if (/^\d+$/.test(rawPlayerId)) {
    params.id = Number(rawPlayerId);
  } else {
    params.search = rawPlayerId.replace(/-/g, ' ').trim();
  }

  const data = await safeFetch('/api/v1/players', params);
  const rawList = providerList(data);
  if (!rawList) return null;
  if (params.id && data?.parameters?.id !== undefined && positiveProviderId(data.parameters.id) !== params.id) return null;
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
    return fn.trim() === removeAccentsAndDashes(searchStr).trim() || n.trim() === removeAccentsAndDashes(searchStr).trim();
  });

  const raw = params.id ? rawList.find(item => Number((item.player || item).id) === params.id) : (exact || (rawList.length === 1 ? rawList[0] : null));
  if (!raw) return null;

  const player = raw.player || raw;
  const embeddedHonours = playerHonourInput(player.honours, player.trophies, raw.honours, raw.trophies);
  const honours = Array.isArray(embeddedHonours) && embeddedHonours.length > 0
    ? normalizeKickoffHonoursHistory(embeddedHonours, { playerId: 'ko_p_' + String(player.id), rawPlayerId: player.id,
      responseComplete: player.honours_complete === true || raw.honours_complete === true })
    : await exports.getPlayerHonours('ko_p_' + String(player.id));
  const rawStatistics = Array.isArray(raw.statistics) ? raw.statistics : [];
  const careerBySeason = rawStatistics.filter(block => block && typeof block === 'object' && !Array.isArray(block))
    .map(normalizePlayerStatistics);
  const eligible = careerBySeason.filter(row => row.scope === 'team_competition_season' && row.seasonInfo.year === season &&
    (options.competition === undefined || [row.competitionId, String(row.leagueId), 'KO:' + row.leagueId].includes(String(options.competition))) &&
    (options.teamId === undefined || row.teamId === String(options.teamId) || row.teamId === 'ko_t_' + options.teamId));
  // Multiple club/national or competition blocks are alternatives, never a sum
  // and never an arbitrary first block. The client can select the retained rows.
  const selected = eligible.length === 1 ? eligible[0] : null;
  const statsContext = selected ? { teamId: selected.teamId, team: selected.team,
    competitionId: selected.competitionId, competition: selected.competition, leagueId: selected.leagueId,
    seasonId: selected.seasonId, season: selected.season, seasonInfo: selected.seasonInfo,
    scope: selected.scope, source: 'kickoffapi' } : null;

  const formatted = {
    id: player.id ? 'ko_p_' + String(player.id) : '',
    provider: 'kickoffapi',
    providerId: player.id?.toString() || '',
    name: `${player.firstname || ''} ${player.lastname || ''}`.trim() || player.name || '',
    shortName: player.name || '',
    team: selected?.team || '',
    teamId: selected?.teamId || null,
    teamBadge: selected?.teamBadge || '',
    competition: selected?.competition || '',
    jerseyNumber: selected?.jerseyNumber ?? null,
    position: selected?.position || player.position || '',
    country: player.nationality || player.birth?.country || '',
    flag: '',
    dateBorn: player.birth?.date || '',
    age: ageFromBirthDate(player.birth?.date) ?? player.age ?? null,
    birthLocation: player.birth?.place || '',
    height: player.height || '',
    weight: player.weight || '',
    preferredFoot: player.foot || '',
    marketValue: player.marketValue || null,
    wage: null,
    contractUntil: null,
    image: firstPlayerImage(player.photo, player.image, player.logo, raw.photo, raw.image) ||
      (player.id ? `https://images.kickoffapi.com/images/players/${player.id}.png` : ''),
    description: '',
    seasonStats: selected ? { ...selected } : {},
    statsContext,
    statsCoverage: { source: 'kickoffapi', available: Boolean(selected), complete: false, partial: true,
      reason: selected ? 'provider_statistics_scope_not_guaranteed' : eligible.length > 1
        ? 'ambiguous_statistics_scope' : 'requested_season_statistics_unavailable',
      scopesAvailable: careerBySeason.length, rejectedRows: rawStatistics.length - careerBySeason.length },
    careerBySeason,
    formerTeams: (raw.transfers || []).map(tr => ({
      team: tr.teams?.out?.name || '',
      teamBadge: tr.teams?.out?.logo || '',
      joined: tr.date ? tr.date.split('-')[0] : '',
      departed: '',
      moveType: tr.type || '',
    })),
    ...honours,
    contracts: [],
    milestones: [],
  };

  setCache(cacheKey, formatted, TTL.SQUAD);
  return formatted;
};



/**
 * Normalizer: transforms a raw KickOff fixture into standard KickSphere MatchModel format
 */
function normalizeKickoffFixture(item) {
  if (!item) return null;
  const rawId = item.fixture?.id || item.id;
  const date = item.fixture?.date || item.date;
  if (!rawId || !date || !Number.isFinite(Date.parse(date))) return null;

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
  } else if (statusShort === 'PST' || statusShort === 'POST') {
    mappedStatus = 'POSTPONED';
  } else if (statusShort === 'CANC') {
    mappedStatus = 'CANCELLED';
  } else if (statusShort === 'ABD') {
    mappedStatus = 'ABANDONED';
  } else if (statusShort === 'SUSP' || statusShort === 'INT') {
    mappedStatus = 'SUSPENDED';
  }

  // Determine winner
  let winner = null;
  if (mappedStatus === "FINISHED" && homeScore !== null && awayScore !== null) {
    if (homeScore > awayScore) winner = 'HOME_TEAM';
    else if (awayScore > homeScore) winner = 'AWAY_TEAM';
    else winner = 'DRAW';
  }

  const leagueCode = REVERSE_LEAGUE_MAP[league.id || item.leagueId] || 'OTHER';

  return {
    id: 'ko_' + String(rawId),
    provider: 'kickoffapi',
    providerId: String(rawId),
    utcDate: date,
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
      id: h.id ? 'ko_t_' + String(h.id) : (h.name || ''),
      provider: 'kickoffapi',
      providerId: h.id?.toString() || '',
      name: h.name || 'Home Team',
      shortName: h.name || 'Home',
      crest: h.logo || `https://images.kickoffapi.com/images/logos/${h.id}.png`,
    },
    awayTeam: {
      id: a.id ? 'ko_t_' + String(a.id) : (a.name || ''),
      provider: 'kickoffapi',
      providerId: a.id?.toString() || '',
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

/**
 * Fetch Single Fixture Details
 */
exports.getMatchDetails = async (fixtureId) => {
  if (!isConfigured()) return null;
  const rawFixtureId = String(fixtureId).replace(/^ko_/, '');
  if (!/^\d+$/.test(rawFixtureId)) return null;
  const numId = Number(rawFixtureId);
  if (!Number.isSafeInteger(numId) || numId <= 0) return null;

  const cacheKey = `kickoff:match:${numId}`;
  const cached = getCached(cacheKey, TTL.FIXTURES_DAY);
  if (cached) return cached;

  const data = await safeFetch('/api/v1/fixtures', { id: numId });
  const raw = providerList(data)?.find(item => Number(item?.fixture?.id ?? item?.id) === numId);
  if (!raw) return null;

  const formatted = normalizeKickoffFixture(raw);
  if (formatted) setCache(cacheKey, formatted, TTL.FIXTURES_DAY);
  return formatted;
};


module.exports = {
  ...exports,
  isConfigured,
  currentFootballSeason,
  ageFromBirthDate,
  LEAGUE_MAP,
  normalizeFixture: normalizeKickoffFixture,
};
