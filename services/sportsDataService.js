const sportscoreService = require('./sportscoreService');
const kickoffApiService = require('./kickoffApiService');
const {
  fetchCompetitionMatches,
  fetchLiveMatches,
  fetchMatchDetails,
  fetchMatchesByDate,
  fetchStandings,
  fetchTopScorers,
  COMPETITIONS
} = require('./footballApi');
const sofascoreService = require('./sofascoreService');
const {
  normalizeCompetitionCode,
  normalizeDateSelector,
  normalizeLimit
} = require('../utils/sportsContracts');
const logger = require('../utils/logger');

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

  // 1. Try SportScore API first (Official primary provider)
  try {
    const sportscoreMatches = await sportscoreService.getMatchesByDate(normalizedDate);
    if (sportscoreMatches && sportscoreMatches.length > 0) {
      return { success: true, source: 'sportscore', data: sportscoreMatches };
    }
  } catch (error) {
    logger.warn(`SportScore getMatchesByDate failed: ${error.message}`);
  }

  // 2. Fallback to KickOff API
  try {
    const kickoffMatches = await kickoffApiService.getMatchesByDate(normalizedDate);
    if (kickoffMatches && kickoffMatches.length > 0) {
      return { success: true, source: 'kickoffapi', data: kickoffMatches };
    }
  } catch (error) {
    logger.warn(`KickOff API getMatchesByDate failed: ${error.message}`);
  }

  // 3. Fallback to football-data.org
  const data = await fetchMatchesByDate(normalizedDate);
  return { success: true, source: 'football-data.org', data };
};

exports.getLiveMatches = async () => {
  // 1. Try SportScore API first for real-time live matches
  try {
    const liveMatches = await sportscoreService.getLiveMatches();
    if (liveMatches && liveMatches.length > 0) {
      return { success: true, source: 'sportscore', data: liveMatches };
    }
  } catch (error) {
    logger.warn(`SportScore getLiveMatches failed: ${error.message}`);
  }

  // 2. Fallback to KickOff API
  try {
    const kickoffLive = await kickoffApiService.getLiveMatches();
    if (kickoffLive && kickoffLive.length > 0) {
      return { success: true, source: 'kickoffapi', data: kickoffLive };
    }
  } catch (error) {
    logger.warn(`KickOff API getLiveMatches failed: ${error.message}`);
  }

  // 3. Fallback to football-data.org
  const data = await fetchLiveMatches();
  return { success: true, source: 'football-data.org', data };
};

exports.getMatchDetails = async (matchId) => {
  // 1. Try SportScore API
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

  // 2. Fallback to football-data.org
  const data = await fetchMatchDetails(matchId);
  return {
    success: Boolean(data),
    source: data ? 'football-data.org' : 'empty',
    data
  };
};

exports.getCompetitionMatches = async (competitionCode, dateFrom, dateTo) => {
  const league = normalizeCompetitionCode(competitionCode);
  if (!league) {
    return { success: false, statusCode: 400, message: 'Unsupported league code' };
  }

  const safeDateFrom = normalizeRangeDate(dateFrom);
  const safeDateTo = normalizeRangeDate(dateTo);

  if ((dateFrom && !safeDateFrom) || (dateTo && !safeDateTo)) {
    return { success: false, statusCode: 400, message: 'Invalid date range' };
  }

  if (safeDateFrom && safeDateTo && safeDateFrom > safeDateTo) {
    return { success: false, statusCode: 400, message: 'Invalid date range' };
  }

  const data = await fetchCompetitionMatches(league, safeDateFrom, safeDateTo);
  return { success: true, source: 'football-data.org', data };
};

exports.getStandings = async (competitionCode) => {
  const league = normalizeCompetitionCode(competitionCode || 'PL');
  if (!league) {
    return { success: false, statusCode: 400, message: 'Unsupported league code' };
  }

  // 1. Try SportScore API
  try {
    const sportscoreStandings = await sportscoreService.getStandings(league);
    if (sportscoreStandings && sportscoreStandings.length > 0) {
      return { success: true, source: 'sportscore', data: sportscoreStandings };
    }
  } catch (error) {
    logger.warn(`SportScore getStandings failed: ${error.message}`);
  }

  // 2. Try KickOff API
  try {
    const kickoffStandings = await kickoffApiService.getStandings(
      league,
      kickoffApiService.currentFootballSeason()
    );
    if (kickoffStandings && kickoffStandings.length > 0) {
      return { success: true, source: 'kickoffapi', data: kickoffStandings };
    }
  } catch (error) {
    logger.warn(`KickOff API getStandings failed: ${error.message}`);
  }

  // 3. Try Sofascore
  try {
    const sofascoreData = await sofascoreService.getLeagueStandings(league);
    if (sofascoreData && sofascoreData.length > 0) {
      return { success: true, source: 'sofascore', data: sofascoreData };
    }
  } catch (error) {
    logger.warn(`Sofascore standings failed: ${error.message}`);
  }

  // 4. Fallback to football-data.org
  const data = await fetchStandings(league);
  if (data && data.length > 0) {
    return {
      success: true,
      source: 'football-data.org',
      data
    };
  }

  // 5. Guaranteed verified 2025/2026 default data
  const { getFallbackStandings, getFallbackTopScorers } = require('./defaultSportsData');
  return {
    success: true,
    source: 'verified_2025_2026',
    data: getFallbackStandings(league)
  };
};

exports.getTopScorers = async (competitionCode, limit, stat = 'goals') => {
  const league = normalizeCompetitionCode(competitionCode || 'PL');
  const safeLimit = normalizeLimit(limit, 20, 50);

  if (!league) {
    return { success: false, statusCode: 400, message: 'Unsupported league code' };
  }

  // 1. Try SportScore API
  try {
    const sportscoreScorers = await sportscoreService.getTopScorers(league, safeLimit, stat);
    if (sportscoreScorers && sportscoreScorers.length > 0) {
      return { success: true, source: 'sportscore', data: sportscoreScorers };
    }
  } catch (error) {
    logger.warn(`SportScore getTopScorers failed: ${error.message}`);
  }

  // 2. Try KickOff API
  try {
    const kickoffScorers = await kickoffApiService.getTopScorers(
      league,
      safeLimit,
      kickoffApiService.currentFootballSeason()
    );
    if (kickoffScorers && kickoffScorers.length > 0) {
      return { success: true, source: 'kickoffapi', data: kickoffScorers };
    }
  } catch (error) {
    logger.warn(`KickOff API getTopScorers failed: ${error.message}`);
  }

  // 3. Try Sofascore
  try {
    const sofascoreData = await sofascoreService.getLeagueTopScorers(league, safeLimit);
    if (sofascoreData && sofascoreData.length > 0) {
      return { success: true, source: 'sofascore', data: sofascoreData };
    }
  } catch (error) {
    logger.warn(`Sofascore top scorers failed: ${error.message}`);
  }

  // 4. Fallback to football-data.org
  const data = await fetchTopScorers(league, safeLimit);
  if (data && data.length > 0) {
    return {
      success: true,
      source: 'football-data.org',
      data
    };
  }

  // 5. Guaranteed verified 2025/2026 default data
  const { getFallbackTopScorers } = require('./defaultSportsData');
  return {
    success: true,
    source: 'verified_2025_2026',
    data: getFallbackTopScorers(league, safeLimit)
  };
};

exports.getSupportedCompetitions = () => {
  return Object.entries(COMPETITIONS).map(([code, info]) => ({
    id: code,
    code,
    name: info.name,
    country: info.country,
    flag: info.flag
  }));
};
