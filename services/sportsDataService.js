const sportscoreService = require('./sportscoreService');
const {
  normalizeCompetitionCode,
  normalizeDateSelector,
  normalizeLimit
} = require('../utils/sportsContracts');
const logger = require('../utils/logger');

// From old footballApi for getSupportedCompetitions
const COMPETITIONS = {
  'PL': { name: 'Premier League', country: 'England', flag: 'https://crests.football-data.org/770.svg' },
  'PD': { name: 'La Liga', country: 'Spain', flag: 'https://crests.football-data.org/760.svg' },
  'SA': { name: 'Serie A', country: 'Italy', flag: 'https://crests.football-data.org/784.svg' },
  'BL1': { name: 'Bundesliga', country: 'Germany', flag: 'https://crests.football-data.org/759.svg' },
  'FL1': { name: 'Ligue 1', country: 'France', flag: 'https://crests.football-data.org/773.svg' },
  'CL': { name: 'UEFA Champions League', country: 'Europe', flag: 'https://crests.football-data.org/CL.png' },
  'EL': { name: 'UEFA Europa League', country: 'Europe', flag: 'https://crests.football-data.org/EL.png' },
  'DED': { name: 'Eredivisie', country: 'Netherlands', flag: 'https://crests.football-data.org/8601.svg' },
  'PPL': { name: 'Primeira Liga', country: 'Portugal', flag: 'https://crests.football-data.org/765.svg' },
  'BSA': { name: 'Brasileiro Série A', country: 'Brazil', flag: 'https://crests.football-data.org/764.svg' },
  'SPL': { name: 'Saudi Pro League', country: 'Saudi Arabia', flag: 'https://images.kickoffapi.com/images/leagues/307.png' },
  'ELC': { name: 'Championship', country: 'England', flag: 'https://crests.football-data.org/ELC.png' },
  'TSL': { name: 'Süper Lig', country: 'Turkey', flag: 'https://images.kickoffapi.com/images/leagues/203.png' },
  'MLS': { name: 'Major League Soccer', country: 'USA', flag: 'https://images.kickoffapi.com/images/leagues/253.png' }
};

const normalizeRangeDate = (value) => {
  if (!value) return null;
  const normalized = normalizeDateSelector(value);
  return normalized && /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
};

exports.getMatchesByDate = async (date) => {
  const normalizedDate = normalizeDateSelector(date || 'TODAY');
  if (!normalizedDate) {
    return { success: false, statusCode: 400, message: 'Invalid date selector' };
  }

    try {
    const generalPromise = sportscoreService.getMatchesByDate(normalizedDate);
    const TOP_LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'EL', 'UNL', 'WC'];
    const topPromises = TOP_LEAGUES.map(league => 
      sportscoreService.getMatchesByDate(normalizedDate, { competition: league }).catch(() => [])
    );

    const [generalResult, ...topResults] = await Promise.all([generalPromise, ...topPromises]);
    
    if (Array.isArray(generalResult)) {
      const allMatches = [...generalResult];
      for (const res of topResults) {
        if (Array.isArray(res)) allMatches.push(...res);
      }
      
      const seen = new Set();
      const uniqueMatches = allMatches.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      return { success: true, source: 'sportscore', data: uniqueMatches, coverage: generalResult.coverage };
    }
  } catch (error) {
    logger.warn(`SportScore getMatchesByDate failed: ${error.message}`);
  }

  return { success: false, statusCode: 503, source: 'unavailable', message: 'Fixture provider unavailable', data: [] };
};

exports.getLiveMatches = async () => {
  try {
    const liveMatches = await sportscoreService.getLiveMatches();
    if (Array.isArray(liveMatches)) {
      return { success: true, source: 'sportscore', data: liveMatches };
    }
  } catch (error) {
    logger.warn(`SportScore getLiveMatches failed: ${error.message}`);
  }

  return { success: false, statusCode: 503, source: 'unavailable', message: 'Live provider unavailable', data: [] };
};

exports.getMatchDetails = async (matchId) => {
  try {
    const sportscoreDetails = await sportscoreService.getMatchDetails(matchId);
    if (sportscoreDetails) {
      return {
        success: true,
        source: 'sportscore',
        data: sportscoreDetails
      };
    }
  } catch (error) {
    logger.warn(`SportScore getMatchDetails failed: ${error.message}`);
  }

  // 2. Fallback to footballApi (for numeric match IDs)
  try {
    const footballApi = require('./footballApi');
    if (footballApi && typeof footballApi.fetchMatchDetails === 'function') {
      const data = await footballApi.fetchMatchDetails(matchId);
      if (data) {
        return {
          success: true,
          source: 'football-data.org',
          data
        };
      }
    }
  } catch (error) {
    logger.warn(`footballApi fetchMatchDetails failed: ${error.message}`);
  }

  return {
    success: false,
    source: 'empty',
    data: null
  };
};

exports.getCompetitionMatches = async (competitionCode, dateFrom, dateTo) => {
  const league = normalizeCompetitionCode(competitionCode);
  if (!league) {
    return { success: false, statusCode: 400, message: 'Unsupported league code' };
  }

  const from = normalizeRangeDate(dateFrom);
  const to = normalizeRangeDate(dateTo);

  if ((dateFrom && !from) || (dateTo && !to) || (from && to && from > to)) {
    return { success: false, statusCode: 400, message: 'Invalid date range' };
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const first = from || to || today;
    const last = to || from || today;
    const days = Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1;
    if (days > 7) return { success: false, statusCode: 400, message: 'Date range cannot exceed 7 days' };
    const results = new Array(days);
    let nextDay = 0;
    // Bound provider load while avoiding seven sequential network timeouts.
    await Promise.all(Array.from({ length: Math.min(3, days) }, async () => {
      while (nextDay < days) {
        const day = nextDay++;
        const date = new Date(Date.parse(first) + day * 86400000).toISOString().slice(0, 10);
        // Filter upstream: the unfiltered day feed may stop before this league's games.
        const result = await sportscoreService.getMatchesByDate(date, { competition: league });
        if (!Array.isArray(result)) throw new Error('Invalid fixture response');
        results[day] = result;
      }
    }));
    const matches = results.flat();
    const seen = new Set();
    const filtered = matches.filter(m => {
      const date = String(m.utcDate || '').slice(0, 10);
      const key = `${m.id}|${m.utcDate}`;
      if (date < first || date > last || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { success: true, source: 'sportscore', data: filtered };
  } catch (error) {
    logger.warn(`getCompetitionMatches failed: ${error.message}`);
  }

  return { success: false, statusCode: 503, source: 'unavailable', message: 'Fixture provider unavailable', data: [] };
};

exports.getStandings = async (competitionCode) => {
  const league = normalizeCompetitionCode(competitionCode || 'PL');
  if (!league) {
    return { success: false, statusCode: 400, message: 'Unsupported league code' };
  }

  try {
    const sportscoreStandings = await sportscoreService.getStandings(league);
    if (sportscoreStandings && sportscoreStandings.length > 0) {
      return { success: true, source: 'sportscore', data: sportscoreStandings };
    }
  } catch (error) {
    logger.warn(`SportScore getStandings failed: ${error.message}`);
  }

  return { success: true, source: 'unavailable', data: [] };
};

exports.getTopScorers = async (competitionCode, limit, stat = 'goals') => {
  const league = normalizeCompetitionCode(competitionCode || 'PL');
  const safeLimit = normalizeLimit(limit, 20, 50);

  if (!league) {
    return { success: false, statusCode: 400, message: 'Unsupported league code' };
  }

  try {
    const sportscoreScorers = await sportscoreService.getTopScorers(league, safeLimit, stat);
    if (sportscoreScorers && sportscoreScorers.length > 0) {
      return { success: true, source: 'sportscore', data: sportscoreScorers };
    }
  } catch (error) {
    logger.warn(`SportScore getTopScorers failed: ${error.message}`);
  }

  return { success: true, source: 'unavailable', data: [] };
};

exports.getSupportedCompetitions = () => {
  return Object.entries(sportscoreService.COMPETITION_SLUGS).map(([code, info]) => ({
    id: code,
    code,
    name: info.name,
    country: info.country,
    flag: COMPETITIONS[code]?.flag || '',
    logo: info.logo,
    slug: info.slug
  }));
};
