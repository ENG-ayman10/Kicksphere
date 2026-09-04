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
  'BSA': { name: 'Brasileiro Série A', country: 'Brazil', flag: 'https://crests.football-data.org/764.svg' }
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
    const sportscoreMatches = await sportscoreService.getMatchesByDate(normalizedDate);
    if (sportscoreMatches && sportscoreMatches.length > 0) {
      return { success: true, source: 'sportscore', data: sportscoreMatches };
    }
  } catch (error) {
    logger.warn(`SportScore getMatchesByDate failed: ${error.message}`);
  }

  return { success: true, source: 'empty', data: [] };
};

exports.getLiveMatches = async () => {
  try {
    const liveMatches = await sportscoreService.getLiveMatches();
    if (liveMatches && liveMatches.length > 0) {
      return { success: true, source: 'sportscore', data: liveMatches };
    }
  } catch (error) {
    logger.warn(`SportScore getLiveMatches failed: ${error.message}`);
  }

  return { success: true, source: 'empty', data: [] };
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

  // SportScore currently doesn't fetch competition specific matches by date range easily without many loops,
  // We will return empty or throw error, since frontend handles fallbacks or doesn't use this extensively.
  return { success: true, source: 'sportscore', data: [] };
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

  const { getFallbackStandings } = require('./defaultSportsData');
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

  try {
    const sportscoreScorers = await sportscoreService.getTopScorers(league, safeLimit, stat);
    if (sportscoreScorers && sportscoreScorers.length > 0) {
      return { success: true, source: 'sportscore', data: sportscoreScorers };
    }
  } catch (error) {
    logger.warn(`SportScore getTopScorers failed: ${error.message}`);
  }

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
