const sportscoreService = require('./sportscoreService');
const kickoffApiService = require('./kickoffApiService');
const bsdSportsService = require('./bsdSportsService');
const {
  normalizeCompetitionCode,
  normalizeDateSelector,
  normalizeLimit
} = require('../utils/sportsContracts');
const logger = require('../utils/logger');
const { parseMatchInterval, selectMatchesInInterval } = require('../utils/matchCalendar');
const { createLiveSnapshotReader } = require('./liveSnapshotReader');
const { mergeProviderFixtures } = require('../utils/providerFixtureIdentity');
const readLiveSnapshots = createLiveSnapshotReader();

// From old footballApi for getSupportedCompetitions
const COMPETITIONS = {
  'PL': { name: 'Premier League', country: 'England', flag: 'https://crests.football-data.org/770.svg', logo: 'https://media.api-sports.io/football/leagues/39.png' },
  'PD': { name: 'La Liga', country: 'Spain', flag: 'https://crests.football-data.org/760.svg', logo: 'https://media.api-sports.io/football/leagues/140.png' },
  'SA': { name: 'Serie A', country: 'Italy', flag: 'https://crests.football-data.org/784.svg', logo: 'https://media.api-sports.io/football/leagues/135.png' },
  'BL1': { name: 'Bundesliga', country: 'Germany', flag: 'https://crests.football-data.org/759.svg', logo: 'https://media.api-sports.io/football/leagues/78.png' },
  'FL1': { name: 'Ligue 1', country: 'France', flag: 'https://crests.football-data.org/773.svg', logo: 'https://media.api-sports.io/football/leagues/61.png' },
  'CL': { name: 'UEFA Champions League', country: 'Europe', flag: 'https://crests.football-data.org/EUR.svg', logo: 'https://media.api-sports.io/football/leagues/2.png' },
  'EL': { name: 'UEFA Europa League', country: 'Europe', flag: 'https://crests.football-data.org/EUR.svg', logo: 'https://media.api-sports.io/football/leagues/3.png' },
  'ECL': { name: 'UEFA Conference League', country: 'Europe', flag: 'https://crests.football-data.org/EUR.svg', logo: 'https://media.api-sports.io/football/leagues/848.png' },
  'DED': { name: 'Eredivisie', country: 'Netherlands', flag: 'https://crests.football-data.org/8601.svg', logo: 'https://media.api-sports.io/football/leagues/88.png' },
  'PPL': { name: 'Primeira Liga', country: 'Portugal', flag: 'https://crests.football-data.org/765.svg', logo: 'https://media.api-sports.io/football/leagues/94.png' },
  'BSA': { name: 'Brasileiro Série A', country: 'Brazil', flag: 'https://crests.football-data.org/764.svg', logo: 'https://media.api-sports.io/football/leagues/71.png' },
  'SPL': { name: 'Saudi Pro League', country: 'Saudi Arabia', flag: 'https://media.api-sports.io/flags/sa.svg', logo: 'https://media.api-sports.io/football/leagues/307.png' },
  'ELC': { name: 'Championship', country: 'England', flag: 'https://crests.football-data.org/ELC.png', logo: 'https://media.api-sports.io/football/leagues/40.png' },
  'TSL': { name: 'Süper Lig', country: 'Turkey', flag: 'https://media.api-sports.io/flags/tr.svg', logo: 'https://media.api-sports.io/football/leagues/203.png' },
  'MLS': { name: 'Major League Soccer', country: 'USA', flag: 'https://media.api-sports.io/flags/us.svg', logo: 'https://media.api-sports.io/football/leagues/253.png' },
  'UNL': { name: 'UEFA Nations League', country: 'Europe', flag: 'https://crests.football-data.org/EUR.svg', logo: 'https://media.api-sports.io/football/leagues/5.png' },
  'WC': { name: 'FIFA World Cup', country: 'International', flag: 'https://media.api-sports.io/flags/world.svg', logo: 'https://media.api-sports.io/football/leagues/1.png' },
  'EC': { name: 'European Championship', country: 'Europe', flag: 'https://crests.football-data.org/EUR.svg', logo: 'https://media.api-sports.io/football/leagues/4.png' },
  'FAC': { name: 'FA Cup', country: 'England', flag: 'https://crests.football-data.org/770.svg', logo: 'https://media.api-sports.io/football/leagues/45.png' },
  'CDR': { name: 'Copa del Rey', country: 'Spain', flag: 'https://crests.football-data.org/760.svg', logo: 'https://media.api-sports.io/football/leagues/143.png' },
  'ACL': { name: 'AFC Champions League', country: 'Asia', flag: '', logo: 'https://media.api-sports.io/football/leagues/17.png' },
  'CAF': { name: 'CAF Champions League', country: 'Africa', flag: '', logo: 'https://media.api-sports.io/football/leagues/12.png' }
};

const normalizeRangeDate = (value) => {
  if (!value) return null;
  const normalized = normalizeDateSelector(value);
  return normalized && /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
};

const bsdConfigured = () => typeof bsdSportsService.isConfigured === 'function' && bsdSportsService.isConfigured();
const queryCoverage = (matches, provider, competition = null) => {
  const coverage = Array.isArray(matches) ? matches.coverage : null;
  const available = Array.isArray(matches) && coverage?.available !== false;
  return {
    provider, competition, available, limit: coverage?.limit ?? null,
    returned: available ? (coverage?.returned ?? matches.length) : 0,
    possiblyTruncated: coverage?.possiblyTruncated === true,
    complete: available && coverage?.possiblyTruncated === false &&
      coverage?.complete !== false && coverage?.partial !== true,
    ...(coverage?.pages !== undefined ? { pages: coverage.pages } : {}),
    ...Object.fromEntries(['upstreamReturned', 'accepted', 'recovered', 'invalidRecords',
      'outsideDate', 'outsideCompetition', 'outsideStatus'].filter(key => Number.isFinite(coverage?.[key]))
      .map(key => [key, coverage[key]])),
    ...(typeof coverage?.reason === 'string' ? { reason: coverage.reason } : {}),
    ...(Array.isArray(coverage?.partitions) ? { partitions: coverage.partitions.slice(0, 3) } : {}),
  };
};

async function boundedSettled(values, work, concurrency = 3) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await work(values[index]) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}

async function readBsdMatches(params) {
  try { return await bsdSportsService.getMatches(params); }
  catch (error) { logger.warn(`BSD fixtures unavailable: ${error.message}`); return null; }
}

async function canReadBsdCompetition(code) {
  if (!bsdConfigured()) return false;
  if (bsdSportsService.LEAGUE_CODE_TO_BSD_ID?.[code]) return true;
  if (!/^BSD:[1-9]\d{0,9}$/.test(code)) return false;
  // Unknown IDs must exist in the provider catalog before any fixture query.
  const catalog = await exports.getCompetitionCatalog();
  return catalog.some(competition => competition.code === code && competition.provider === 'bsd');
}

exports.getMatchesByDate = async (date) => {
  const normalizedDate = normalizeDateSelector(date || 'TODAY');
  if (!normalizedDate) {
    return { success: false, statusCode: 400, message: 'Invalid date selector' };
  }
  const offsets = { YESTERDAY: -1, TOMORROW: 1 };
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(normalizedDate) ? normalizedDate :
    new Date(Date.now() + (offsets[normalizedDate] || 0) * 86400000).toISOString().slice(0, 10);
  const startMs = Date.parse(`${targetDate}T00:00:00Z`);
  const TOP_LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'EL', 'UNL', 'WC'];
  const competitions = [null, ...TOP_LEAGUES];
  // BSD supplies rich fixtures in its covered leagues; SportScore retains the
  // wider calendar. Each read keeps its own availability/completeness contract.
  const bsdRead = bsdConfigured() ? readBsdMatches({ date: targetDate }) : null;
  const results = await boundedSettled(competitions, competition =>
    sportscoreService.getMatchesByDate(targetDate, competition ? { competition } : {}));
  const queries = results.map((result, index) => queryCoverage(
    result.status === 'fulfilled' ? result.value : null, 'sportscore', competitions[index]));
  const scAvailable = queries.some(query => query.available);
  const scRaw = results.flatMap((result, index) => queries[index].available ? result.value : []);
  // Compatibility for callers using a configured adapter without isConfigured;
  // an explicitly disabled production adapter is never mistaken for valid data.
  const bsdRaw = bsdRead ? await bsdRead : !scAvailable && typeof bsdSportsService.isConfigured !== 'function'
    ? await readBsdMatches({ date: targetDate }) : null;
  const bsdQuery = queryCoverage(bsdRaw, 'bsd');
  const bsdAvailable = bsdQuery.available && (bsdRaw.length > 0 || Boolean(bsdRaw.coverage));
  if (bsdRead || bsdAvailable) queries.push(bsdQuery);
  const scSelected = selectMatchesInInterval(scRaw, startMs, startMs + 86400000);
  const bsdSelected = selectMatchesInInterval(bsdAvailable ? bsdRaw : [], startMs, startMs + 86400000);
  const selected = selectMatchesInInterval(mergeProviderFixtures(bsdSelected.data, scSelected.data), startMs, startMs + 86400000);
  const available = scAvailable || bsdAvailable;
  const possiblyTruncated = queries.some(query => query.possiblyTruncated);
  const invalidRecords = scSelected.invalidRecords + bsdSelected.invalidRecords +
    queries.reduce((sum, query) => sum + (query.invalidRecords || 0), 0);
  const outsideDate = scSelected.outsideInterval + bsdSelected.outsideInterval +
    queries.reduce((sum, query) => sum + (query.outsideDate || 0), 0);
  const complete = available && scAvailable && queries.every(query => query.complete) &&
    !possiblyTruncated && invalidRecords === 0 && outsideDate === 0;
  const sources = [bsdAvailable ? 'bsd' : null, scAvailable ? 'sportscore' : null].filter(Boolean);
  return { success: true, source: sources.join('+') || 'unavailable', data: selected.data,
    coverage: { available, complete, partial: !complete, possiblyTruncated,
      limit: queries[0].limit, returned: selected.data.length, invalidRecords, outsideDate, queries } };
};

exports.getMatchesInInterval = async (from, to) => {
  const interval = parseMatchInterval(from, to);
  if (interval.error) return { success: false, statusCode: 400, message: interval.error };

  const results = await Promise.allSettled(interval.utcDates.map(date => exports.getMatchesByDate(date)));
  const utcDays = results.map((settled, index) => {
    const result = settled.status === 'fulfilled' ? settled.value : null;
    const available = result?.success === true && Array.isArray(result.data) &&
      result.source !== 'unavailable' && result.coverage?.available !== false;
    const complete = available && result.coverage?.complete === true &&
      result.coverage?.possiblyTruncated !== true && result.coverage?.partial !== true;
    return {
      date: interval.utcDates[index], source: result?.source || 'unavailable', available,
      returned: available ? result.data.length : 0,
      possiblyTruncated: result?.coverage?.possiblyTruncated === true,
      complete, partial: !complete,
      queries: result?.coverage?.queries || [],
    };
  });
  const allMatches = results.flatMap((result, index) => utcDays[index].available ? result.value.data : []);
  const selected = selectMatchesInInterval(allMatches, interval.fromMs, interval.toMs);
  const available = utcDays.some(day => day.available);
  const complete = utcDays.every(day => day.complete) && selected.invalidRecords === 0;
  const coverage = {
    available, complete, partial: !complete,
    possiblyTruncated: utcDays.some(day => day.possiblyTruncated),
    returned: selected.data.length, invalidRecords: selected.invalidRecords, utcDays,
  };
  if (!available) return {
    success: false, statusCode: 503, source: 'unavailable',
    message: 'Match providers unavailable for the requested interval',
    range: interval.range, coverage, data: [],
  };
  const sources = [...new Set(utcDays.filter(day => day.available).map(day => day.source))];
  return { success: true, source: sources.join('+'), range: interval.range, coverage, data: selected.data };
};

exports.getLiveMatches = async () => {
  const readBsd = bsdConfigured() || (typeof bsdSportsService.isConfigured !== 'function' &&
    typeof bsdSportsService.getLiveMatches === 'function');
  const snapshots = await readLiveSnapshots([
    { name: 'sportscore', read: () => sportscoreService.getLiveMatches() },
    ...(readBsd ? [{ name: 'bsd', read: () => bsdSportsService.getLiveMatches() }] : [])
  ]);
  const queries = snapshots.map(snapshot => {
    const coverage = queryCoverage(snapshot.data, snapshot.name);
    const complete = coverage.complete && !snapshot.pending && !snapshot.stale && !snapshot.failed;
    return { ...coverage, pending: snapshot.pending, stale: snapshot.stale, failed: snapshot.failed,
      snapshotAgeMs: snapshot.ageMs, fetchedAt: snapshot.fetchedAt,
      complete, partial: !complete };
  });
  const usable = snapshots.filter(snapshot => snapshot.available).sort((a, b) =>
    Number(a.stale) - Number(b.stale) || (bsdConfigured() ? Number(b.name === 'bsd') - Number(a.name === 'bsd') :
      Number(b.name === 'sportscore') - Number(a.name === 'sportscore')));
  const available = usable.length > 0;
  const sources = usable.map(snapshot => snapshot.name);
  const rows = snapshot => (snapshot.data || []).map(match => ({ ...match,
    liveSnapshotStale: snapshot.stale, liveSnapshotAgeMs: snapshot.ageMs,
    liveSnapshotFetchedAt: snapshot.fetchedAt }));
  const data = mergeProviderFixtures(rows(usable[0] || { data: [] }), usable.slice(1).flatMap(rows));
  if (!available) return { success: false, statusCode: 503, source: 'unavailable', message: 'Live provider unavailable',
    coverage: { available: false, complete: false, partial: true,
      possiblyTruncated: queries.some(query => query.possiblyTruncated), queries }, data: [] };
  const complete = queries.every(query => query.complete);
  return { success: true, source: sources.join('+'), data,
    coverage: { available, complete, partial: !complete,
      possiblyTruncated: queries.some(query => query.possiblyTruncated), queries } };
};
exports.getMatchDetails = async (matchId) => {
  const id = String(matchId || '').trim();
  if (/^bsd_\d+$/.test(id)) {
    const summary = typeof bsdSportsService.getMatchSummary === 'function'
      ? await bsdSportsService.getMatchSummary(id) : null;
    const details = typeof bsdSportsService.getMatchSummary === 'function'
      ? summary ? { matchInfo: summary, coverage: { source: 'bsd', available: true, complete: false,
        partial: true, scope: 'summary' } } : null
      : await bsdSportsService.getMatchDetails(id);
    return details?.matchInfo && String(details.matchInfo.id) === id ? { success: true, source: 'bsd', coverage: details.coverage,
      data: { ...details.matchInfo, venue: typeof details.matchInfo.venue === 'object'
        ? details.matchInfo.venue?.name || null : details.matchInfo.venue,
      venueInfo: details.venue || null, head2head: details.h2h || details.matchInfo.head2head || null } } :
      { success: false, source: 'unavailable', data: null };
  }
  if (id.startsWith('bsd_')) return { success: false, source: 'unavailable', data: null };
  if (/^ko_\d+$/.test(id)) {
    const details = await kickoffApiService.getMatchDetails(id);
    return details ? { success: true, source: 'kickoffapi', data: details } : { success: false, source: 'unavailable', data: null };
  }
  // SportScore match routes are opaque slugs, not football-data numeric IDs.
  if (!/^\d+$/.test(id)) {
    const details = await sportscoreService.getMatchDetails(id);
    if (details) return { success: true, source: 'sportscore', data: details };
  }
  return { success: false, source: 'unavailable', data: null };
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

  const today = new Date().toISOString().slice(0, 10);
  const first = from || to || today;
  const last = to || from || today;
  const days = Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1;
  if (days > 35) return { success: false, statusCode: 400, message: 'Date range must not exceed 35 days' };
  let bsdMatches = null;
  const bsdReadable = await canReadBsdCompetition(league);
  if (/^BSD:/.test(league) && !bsdReadable) {
    const catalog = bsdConfigured() ? await bsdSportsService.getLeagues() : null;
    return Array.isArray(catalog)
      ? { success: false, statusCode: 400, message: 'Unsupported league code', data: [] }
      : { success: false, statusCode: 503, source: 'unavailable', message: 'Competition provider unavailable', data: [] };
  }
  if (bsdReadable) {
    bsdMatches = await readBsdMatches({ competition: league, dateFrom: first, dateTo: last });
    if (Array.isArray(bsdMatches) && bsdMatches.coverage?.available !== false) {
      const filtered = bsdMatches.filter(match => {
        const day = String(match.utcDate || '').slice(0, 10);
        return match.competition?.code === league && day >= first && day <= last;
      });
      if (bsdMatches.coverage?.complete === true && bsdMatches.coverage?.possiblyTruncated !== true &&
          filtered.length === bsdMatches.length) return { success: true, source: 'bsd', data: filtered,
        coverage: { ...bsdMatches.coverage, returned: filtered.length } };
      bsdMatches = filtered;
    } else bsdMatches = null;
  }
  // A BSD-only competition can never leak into SportScore's default league feed.
  if (!sportscoreService.COMPETITION_SLUGS?.[league] && /^(BSD:|CIT$|DFB$|CLI$|ARG$)/.test(league)) {
    return Array.isArray(bsdMatches) ? { success: true, source: 'bsd', data: bsdMatches,
      coverage: { available: true, complete: false, partial: true } } :
      { success: false, statusCode: 503, source: 'unavailable', message: 'Competition provider unavailable', data: [] };
  }
  try {
    const queryDays = days;
    const results = new Array(queryDays);
    let nextDay = 0;
    // Bound provider load while avoiding seven sequential network timeouts.
    await Promise.all(Array.from({ length: Math.min(3, queryDays) }, async () => {
      while (nextDay < queryDays) {
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
    if (filtered.length > 0) {
      return { success: true, source: Array.isArray(bsdMatches) ? 'bsd+sportscore' : 'sportscore', data: mergeProviderFixtures(bsdMatches || [], filtered) };
    }

    return { success: true, source: Array.isArray(bsdMatches) ? 'bsd+sportscore' : 'sportscore', data: bsdMatches || [] };
  } catch (error) {
    logger.warn('getCompetitionMatches failed: ' + error.message);
    return Array.isArray(bsdMatches) ? { success: true, source: 'bsd', data: bsdMatches, coverage: { available: true, complete: false, partial: true } } : { success: true, source: 'unavailable', data: [], coverage: { available: false } };
  }
};

exports.getStandings = async (competitionCode) => {
  const league = normalizeCompetitionCode(competitionCode || 'PL');
  if (!league) {
    return { success: false, statusCode: 400, message: 'Unsupported league code' };
  }

  if (await canReadBsdCompetition(league)) {
    try {
      const rows = await bsdSportsService.getStandings(league);
      if (Array.isArray(rows) && rows.coverage?.available !== false) return {
        success: true, source: 'bsd', data: rows, coverage: rows.coverage,
      };
    } catch (error) { logger.warn(`BSD standings unavailable: ${error.message}`); }
  }
  if (/^(BSD:|CIT$|DFB$|CLI$|ARG$)/.test(league) && !sportscoreService.COMPETITION_SLUGS?.[league]) {
    return { success: false, statusCode: 503, source: 'unavailable', message: 'Standings provider unavailable', data: [] };
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

  if (await canReadBsdCompetition(league)) {
    try {
      const rows = await bsdSportsService.getTopScorers(league, safeLimit, stat);
      if (Array.isArray(rows) && rows.coverage?.available !== false) return {
        success: true, source: 'bsd', data: rows, coverage: rows.coverage,
      };
    } catch (error) { logger.warn(`BSD scorers unavailable: ${error.message}`); }
  }
  if (/^(BSD:|CIT$|DFB$|CLI$|ARG$)/.test(league) && !sportscoreService.COMPETITION_SLUGS?.[league]) {
    return { success: false, statusCode: 503, source: 'unavailable', message: 'Scorers provider unavailable', data: [] };
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

exports.getCompetitionCatalog = async () => {
  const fallback = exports.getSupportedCompetitions();
  if (!bsdConfigured()) return fallback;
  try {
    const catalog = await bsdSportsService.getLeagues();
    if (!Array.isArray(catalog)) return fallback;
    const preferred = catalog.map(league => {
      const providerId = String(league.providerId || league.id || '').replace(/^BSD:/, '');
      if (!/^[1-9]\d{0,9}$/.test(providerId)) return null;
      const code = normalizeCompetitionCode(league.code) ||
        bsdSportsService.BSD_ID_TO_LEAGUE_CODE?.[providerId] || `BSD:${providerId}`;
      return { ...league, id: code, code, targetId: code, provider: 'bsd', providerId,
        flag: league.flag || COMPETITIONS[code]?.flag || '', logo: league.logo || league.emblem || '',
        name: league.name || code, country: league.country || '', source: 'bsd' };
    }).filter(Boolean);
    const seen = new Set(preferred.map(league => league.code));
    const supplemental = fallback.filter(league => !seen.has(league.code));
    const combined = [...preferred, ...supplemental];
    Object.defineProperties(combined, {
      source: { value: supplemental.length ? 'bsd+supported-contract' : 'bsd' },
      coverage: { value: { ...(catalog.coverage || {}), source: 'bsd', available: true,
        complete: catalog.coverage?.complete === true, partial: catalog.coverage?.complete !== true,
        providerCount: preferred.length, supplementalCount: supplemental.length } }
    });
    return combined;
  } catch (error) { logger.warn(`BSD catalog unavailable: ${error.message}`); return fallback; }
};

exports.mergeProviderFixtures = mergeProviderFixtures;
