/**
 * @file sportscoreService.js
 * @description Official SportScore API integration service.
 * Base URL: https://sportscore.com
 * Adheres strictly to SportScore API Terms of Use, ~10,000 req/24h fair-use policy,
 * 60s origin caching, 429 backoff handling, and standard contract normalization.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('./cacheService');
const { normalizedTeamName, fixtureTeam, standingsTeamIdentity, buildMembershipIndex } = require('../utils/sportscoreTeamIdentity');
const { selectMatchesInInterval } = require('../utils/matchCalendar');
const { normalizeMatchTiming } = require('../utils/matchTiming');
const { normalizePlayerHonours, playerHonourInput, firstPlayerImage } = require('../utils/playerHonours');
const { validateLineupIntegrity } = require('../utils/lineupIntegrity');

const BASE_URL = 'https://sportscore.com';
const SPORT = 'football';
const APP_SRC = 'kicksphere';

// Rate-limiting & 429 backoff tracking
let retryAfterUntil = 0;
const pendingProviderReads = new Map();
const waitingProviderReadSlots = [];
let activeProviderReads = 0;
const MAX_PENDING_PROVIDER_READS = 128;
const FIXTURE_LIMIT = 200;
const FIXTURE_STATUS_PARTITIONS = ['live', 'finished', 'upcoming'];

async function withProviderReadSlot(work) {
  if (activeProviderReads < 3) activeProviderReads++;
  else await new Promise(resolve => waitingProviderReadSlots.push(resolve));
  try { return await work(); } finally {
    const next = waitingProviderReadSlots.shift();
    if (next) next();
    else activeProviderReads--;
  }
}

// Default TTLs (milliseconds)
const TTL = {
  LIVE_MATCHES: 30 * 1000,     // 30 seconds for live/active matches
  DAILY_MATCHES: 60 * 1000,    // 60 seconds (matches SportScore edge cache)
  MATCH_DETAIL: 60 * 1000,     // 60 seconds
  STANDINGS: 5 * 60 * 1000,    // 5 minutes
  TOP_SCORERS: 5 * 60 * 1000,  // 5 minutes
  TEAM: 15 * 60 * 1000,        // 15 minutes
  PLAYER: 30 * 60 * 1000,      // 30 minutes
  SEARCH: 10 * 60 * 1000,      // 10 minutes
  H2H: 30 * 60 * 1000,         // 30 minutes
};

const teamIdentityLookups = new Map();
const waitingTeamIdentityLookups = [];
let activeTeamIdentityLookups = 0;
const TEAM_IDENTITY_BUDGET_MS = 8 * 1000;

async function withTeamIdentitySlot(work) {
  if (activeTeamIdentityLookups < 3) activeTeamIdentityLookups++;
  else await new Promise(resolve => waitingTeamIdentityLookups.push(resolve));
  try { return await work(); } finally {
    const next = waitingTeamIdentityLookups.shift();
    if (next) next();
    else activeTeamIdentityLookups--;
  }
}

// Verified Competition Slug Mapping
const COMPETITION_SLUGS = {
  'PL': { slug: 'english-premier-league', name: 'Premier League', country: 'England', logo: 'https://media.api-sports.io/football/leagues/39.png' },
  'PD': { slug: 'spanish-la-liga', name: 'La Liga', country: 'Spain', logo: 'https://media.api-sports.io/football/leagues/140.png' },
  'SA': { slug: 'italian-serie-a', name: 'Serie A', country: 'Italy', logo: 'https://media.api-sports.io/football/leagues/135.png' },
  'BL1': { slug: 'bundesliga', name: 'Bundesliga', country: 'Germany', logo: 'https://media.api-sports.io/football/leagues/78.png' },
  'FL1': { slug: 'french-ligue-1', name: 'Ligue 1', country: 'France', logo: 'https://media.api-sports.io/football/leagues/61.png' },
  'CL': { slug: 'uefa-champions-league', name: 'UEFA Champions League', country: 'Europe', logo: 'https://media.api-sports.io/football/leagues/2.png' },
  'EL': { slug: 'uefa-europa-league', name: 'UEFA Europa League', country: 'Europe', logo: 'https://media.api-sports.io/football/leagues/3.png' },
  'ECL': { slug: 'uefa-europa-conference-league', name: 'UEFA Conference League', country: 'Europe', logo: 'https://media.api-sports.io/football/leagues/848.png' },
  'SPL': { slug: 'saudi-professional-league', name: 'Saudi Pro League', country: 'Saudi Arabia', logo: 'https://media.api-sports.io/football/leagues/307.png' },
  'DED': { slug: 'netherlands-eredivisie', name: 'Eredivisie', country: 'Netherlands', logo: 'https://media.api-sports.io/football/leagues/88.png' },
  'PPL': { slug: 'portuguese-primera-liga', name: 'Primeira Liga', country: 'Portugal', logo: 'https://media.api-sports.io/football/leagues/94.png' },
  'BSA': { slug: 'brazilian-serie-a', name: 'Brasileirão', country: 'Brazil', logo: 'https://media.api-sports.io/football/leagues/71.png' },
  'ELC': { slug: 'english-football-league-championship', name: 'Championship', country: 'England', logo: 'https://media.api-sports.io/football/leagues/40.png' },
  'TSL': { slug: 'turkish-super-league', name: 'Süper Lig', country: 'Turkey', logo: 'https://media.api-sports.io/football/leagues/203.png' },
  'MLS': { slug: 'united-states-major-league-soccer', name: 'MLS', country: 'USA', logo: 'https://media.api-sports.io/football/leagues/253.png' },
  'UNL': { slug: 'uefa-nations-league', name: 'UEFA Nations League', country: 'Europe', logo: 'https://media.api-sports.io/football/leagues/5.png' },
  // BSD league 65 and this exact SportScore competition were audited against
  // both provider catalogs on 2026-10-05. Team IDs still require verified
  // provider slugs/URLs from this competition's standings membership.
  'BSD:65': { slug: 'concacaf-nations-league', name: 'CONCACAF Nations League', country: 'North America', logo: '' },
  'WC': { slug: 'fifa-world-cup', name: 'FIFA World Cup', country: 'International', logo: 'https://media.api-sports.io/football/leagues/1.png' },
  'EC': { slug: 'uefa-european-championship', name: 'European Championship', country: 'Europe', logo: 'https://media.api-sports.io/football/leagues/4.png' },
  'FAC': { slug: 'fa-cup', name: 'FA Cup', country: 'England', logo: 'https://media.api-sports.io/football/leagues/45.png' },
  'CDR': { slug: 'copa-del-rey', name: 'Copa del Rey', country: 'Spain', logo: 'https://media.api-sports.io/football/leagues/143.png' },
  'ACL': { slug: 'afc-champions-league', name: 'AFC Champions League', country: 'Asia', logo: 'https://media.api-sports.io/football/leagues/17.png' },
  'CAF': { slug: 'caf-champions-league', name: 'CAF Champions League', country: 'Africa', logo: 'https://media.api-sports.io/football/leagues/12.png' }
};

const resolveCompetitionSlug = (codeOrSlug) => {
  if (!codeOrSlug) return 'english-premier-league';
  const clean = String(codeOrSlug).trim().toUpperCase();
  if (COMPETITION_SLUGS[clean]) {
    return COMPETITION_SLUGS[clean].slug;
  }
  const lower = String(codeOrSlug).trim().toLowerCase();
  for (const info of Object.values(COMPETITION_SLUGS)) {
    if (info.slug === lower) return info.slug;
  }
  return lower;
};

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedRating(value) {
  const number = numericOrNull(value);
  // The public feed returned 949 and 6060 without a documented scale/aggregation.
  // Keep the raw value for diagnosis; never turn it into a guessed 0–10 rating.
  return number !== null && number >= 0 && number <= 10 ? number : null;
}

function sameEntity(a, b) {
  const normalize = value => String(value || '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-\s]+/g, ' ').trim();
  return normalize(a) === normalize(b);
}

function cacheFixtureScores(matches) {
  for (const match of matches) {
    if (match.id) setCache('sportscore:fixture:' + match.id, match, 120 * 1000);
  }
  return matches;
}

function deduplicateMatches(matches) {
  const byFixture = new Map();
  const statusRank = { FINISHED: 4, CANCELLED: 4, SUSPENDED: 4, IN_PLAY: 3, POSTPONED: 2, TIMED: 1 };
  for (const match of matches) {
    const key = `${match.id}|${match.utcDate}`;
    const previous = byFixture.get(key);
    if (!previous || (statusRank[match.status] || 0) > (statusRank[previous.status] || 0)) {
      byFixture.set(key, match);
    }
  }
  return [...byFixture.values()];
}

async function competitionMembership(code) {
  const competition = COMPETITION_SLUGS[code];
  if (!competition) return null;
  const cacheKey = `sportscore:team-membership:${code}`;
  const cached = getCached(cacheKey);
  if (cached) return cached.verified ? cached.byName : null;
  if (teamIdentityLookups.has(code)) return teamIdentityLookups.get(code);
  const lookup = withTeamIdentitySlot(async () => {
    const raw = await fetchSportScore('/api/widget/standings/', { slug: competition.slug }, TTL.STANDINGS);
    // The requested URL alone is not evidence that the response belongs to that league.
    const scopeMatches = raw?.competition_slug ? raw.competition_slug === competition.slug :
      (typeof raw?.competition === 'string' && resolveCompetition(raw.competition)?.code === code);
    const verified = scopeMatches && Array.isArray(raw?.tables);
    const byName = verified ? buildMembershipIndex(raw.tables.flatMap(table => Array.isArray(table.rows) ? table.rows : [])) : null;
    setCache(cacheKey, { verified, byName }, verified ? TTL.STANDINGS : TTL.DAILY_MATCHES);
    return byName;
  });
  teamIdentityLookups.set(code, lookup);
  try { return await lookup; } finally { teamIdentityLookups.delete(code); }
}

async function enrichFixtureTeamIdentities(matches, { requireCompetitionSlug = false } = {}) {
  const codes = [...new Set(matches.filter(match =>
    (!match.homeTeam?.id || !match.awayTeam?.id) && COMPETITION_SLUGS[match.competition?.code] &&
    (!requireCompetitionSlug || match.competition.slug === COMPETITION_SLUGS[match.competition.code].slug)
  ).map(match => match.competition.code))];
  const memberships = new Map();
  if (codes.length) {
    const pending = Promise.all(codes.map(async code => {
      try {
        const membership = await competitionMembership(code);
        if (membership) memberships.set(code, membership);
      } catch (error) {
        // An optional identity lookup must never discard otherwise usable games.
        logger.warn(`[SportScore] Team identity unavailable for ${code}: ${error.message}`);
      }
    }));
    let timer;
    try {
      // Keep a cold league cache from adding 22 sequential provider timeouts.
      // Pending work retains the shared single-flight queue and warms the cache;
      // this response uses only identities verified before its total deadline.
      await Promise.race([pending, new Promise(resolve => {
        timer = setTimeout(resolve, TEAM_IDENTITY_BUDGET_MS);
      })]);
    } finally { clearTimeout(timer); }
  }
  return matches.map(match => {
    const code = match.competition?.code;
    if (requireCompetitionSlug && match.competition?.slug !== COMPETITION_SLUGS[code]?.slug) return match;
    const membership = memberships.get(code);
    if (!membership) return match;
    const resolve = team => {
      if (!team || team.id || team.identityConflict) return team;
      const ids = membership.get(normalizedTeamName(team.name));
      if (ids?.size !== 1) return team;
      const id = [...ids][0];
      if (!id) return team;
      return { ...team, id, provider: 'sportscore', identityBasis: 'competition_standings',
        identityCompetitionCode: code, identityCompetitionSlug: COMPETITION_SLUGS[code].slug };
    };
    return { ...match, homeTeam: resolve(match.homeTeam), awayTeam: resolve(match.awayTeam) };
  });
}

// ═══════════════════════════════════════════════════════════════════
// 🌐 UNIFIED HTTP REQUEST HANDLER WITH 429 BACKOFF & CACHING
// ═══════════════════════════════════════════════════════════════════
async function fetchSportScore(endpoint, params = {}, customTtl = TTL.DAILY_MATCHES) {
  const queryParams = new URLSearchParams({
    sport: SPORT,
    src: APP_SRC,
    ...params
  });
  queryParams.sort();

  const url = `${BASE_URL}${endpoint}?${queryParams.toString()}`;
  const cacheKey = `sportscore_${url}`;

  // 1. Check local cache
  const cached = getCached(cacheKey, customTtl);
  if (cached) {
    return cached;
  }

  // 2. Check if we are in 429 backoff window
  const now = Date.now();
  if (now < retryAfterUntil) {
    logger.warn(`[SportScore] Throttled by 429 backoff until ${new Date(retryAfterUntil).toISOString()}`);
    return null;
  }

  // A cold cache must not multiply identical upstream calls for concurrent users.
  if (pendingProviderReads.has(cacheKey)) return pendingProviderReads.get(cacheKey);
  if (pendingProviderReads.size >= MAX_PENDING_PROVIDER_READS) {
    logger.warn('[SportScore] Upstream request queue is full');
    return null;
  }
  const pending = (async () => {
    try {
      const response = await withProviderReadSlot(async () => {
        // An earlier active request may establish backoff while this one waits.
        if (Date.now() < retryAfterUntil) return null;
        return axios.get(url, {
          headers: {
            'User-Agent': 'KickSphereApp/1.0 (SportScore Integration; +https://sportscore.com)',
            'Accept': 'application/json'
          },
          timeout: 10000
        });
      });

      if (response?.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
        setCache(cacheKey, response.data, customTtl);
        return response.data;
      }
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfterSec = parseInt(error.response.headers['retry-after'] || '60', 10);
        retryAfterUntil = Date.now() + (retryAfterSec * 1000);
        logger.error(`[SportScore] Received 429 Too Many Requests. Backing off for ${retryAfterSec}s.`);
      } else {
        logger.warn(`[SportScore] Error fetching ${endpoint}: ${error.message}`);
      }
    }
    return null;
  })();
  pendingProviderReads.set(cacheKey, pending);
  try { return await pending; } finally { pendingProviderReads.delete(cacheKey); }
}

function inspectFixtureBatch(raw, { date, competition = null, status = null, includePreviousDay = false }) {
  const available = Array.isArray(raw?.matches);
  const report = { status, available, returned: available ? raw.matches.length : 0,
    accepted: 0, possiblyTruncated: available && raw.matches.length >= FIXTURE_LIMIT,
    invalidRecords: 0, outsideDate: 0, outsideCompetition: 0, outsideStatus: 0 };
  if (!available) return { matches: [], report };
  const records = [];
  // Bound malformed/oversized upstream responses as well as the documented limit.
  for (const row of raw.matches.slice(0, FIXTURE_LIMIT)) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        ![row.url, row.slug].some(value => typeof value === 'string' && value.trim())) {
      report.invalidRecords++;
      continue;
    }
    let match;
    try { match = normalizeSportScoreMatch(row); }
    catch { report.invalidRecords++; continue; }
    const expectedCompetition = match.competition?.slug || COMPETITION_SLUGS[match.competition?.code]?.slug;
    if (competition && expectedCompetition !== competition) {
      report.outsideCompetition++;
      continue;
    }
    const expectedStatus = { live: 'IN_PLAY', finished: 'FINISHED', upcoming: 'TIMED' }[status];
    if (expectedStatus && match.status !== expectedStatus) {
      report.outsideStatus++;
      continue;
    }
    records.push(match);
  }
  const start = Date.parse(`${date}T00:00:00Z`);
  // Resolve conflicting duplicate states before the interval helper retains
  // the first fixture ID, so a terminal row cannot become an upcoming one.
  const selected = selectMatchesInInterval(deduplicateMatches(records), includePreviousDay ? start - 86400000 : start, start + 86400000);
  report.invalidRecords += selected.invalidRecords;
  report.outsideDate = selected.outsideInterval;
  report.accepted = selected.data.length;
  return { matches: selected.data, report };
}

function fixtureCoverage(primary, partitions, matches) {
  const reports = [primary.report, ...partitions.map(partition => partition.report)];
  const sums = Object.fromEntries(['invalidRecords', 'outsideDate', 'outsideCompetition', 'outsideStatus']
    .map(key => [key, reports.reduce((sum, report) => sum + report[key], 0)]));
  const possiblyTruncated = reports.some(report => report.possiblyTruncated);
  const complete = reports.every(report => report.available) && !possiblyTruncated &&
    Object.values(sums).every(count => count === 0);
  return { available: true, limit: FIXTURE_LIMIT, returned: matches.length,
    upstreamReturned: reports.reduce((sum, report) => sum + report.returned, 0),
    accepted: matches.length, recovered: Math.max(0, matches.length - deduplicateMatches(primary.matches).length),
    complete, partial: !complete, possiblyTruncated,
    ...sums, partitions: partitions.map(partition => partition.report),
    ...(possiblyTruncated ? { reason: 'provider_result_limit' } :
      reports.some(report => !report.available) ? { reason: 'partition_unavailable' } :
      !complete ? { reason: 'rejected_provider_records' } : {}) };
}

// ═══════════════════════════════════════════════════════════════════
// ⚽ 1. MATCHES (LIVE & BY DATE)
// ═══════════════════════════════════════════════════════════════════
exports.getLiveMatches = async () => {
  try {
    // The widget is a capped mixed schedule, not a live-only feed. Filter upstream.
    const date = new Date().toISOString().slice(0, 10);
    const raw = await fetchSportScore('/api/v1/fixtures/', {
      date, status: 'live', limit: FIXTURE_LIMIT
    }, TTL.LIVE_MATCHES);
    if (!Array.isArray(raw?.matches)) throw new Error('Live provider unavailable');

    // Filtering and serialization share one status contract, including penalties.
    // An ongoing fixture may have kicked off before UTC midnight. Daily status
    // partitions remain strictly day-scoped; the live screen also keeps carryover.
    const batch = inspectFixtureBatch(raw, { date, status: 'live', includePreviousDay: true });
    const matches = cacheFixtureScores(await enrichFixtureTeamIdentities(deduplicateMatches(batch.matches)));
    Object.defineProperty(matches, 'coverage', { value: fixtureCoverage(batch, [], matches) });
    return matches;
  } catch (e) {
    logger.error(`[SportScore] getLiveMatches error: ${e.message}`);
    throw e;
  }
};

exports.getMatchesByDate = async (dateStr, { competition } = {}) => {
  try {
    let date = dateStr;
    if (!date || ['TODAY', 'YESTERDAY', 'TOMORROW'].includes(String(date).toUpperCase())) {
      const offset = { YESTERDAY: -1, TOMORROW: 1 }[String(date).toUpperCase()] || 0;
      date = new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    }

    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid fixture date');
    const params = { date, limit: FIXTURE_LIMIT };
    if (competition) params.competition = resolveCompetitionSlug(competition);
    const raw = await fetchSportScore('/api/v1/fixtures/', params, TTL.DAILY_MATCHES);
    if (!Array.isArray(raw?.matches)) throw new Error('Fixture provider unavailable');

    const primary = inspectFixtureBatch(raw, params);
    // The official API has no page/cursor/offset. A capped day can still recover
    // fixtures through its three documented status filters (at most 4 fixture
    // batch requests per scope, separate from optional shared identity lookups).
    // Retain partial coverage: these filters do not certify postponed/other games.
    const partitions = primary.report.possiblyTruncated ? await Promise.all(FIXTURE_STATUS_PARTITIONS.map(async status =>
      inspectFixtureBatch(await fetchSportScore('/api/v1/fixtures/', { ...params, status }, TTL.DAILY_MATCHES),
        { ...params, status }))) : [];
    const merged = deduplicateMatches([...primary.matches, ...partitions.flatMap(partition => partition.matches)]);
    const matches = cacheFixtureScores(await enrichFixtureTeamIdentities(merged));
    Object.defineProperty(matches, 'coverage', { value: {
      ...fixtureCoverage(primary, partitions, matches), competition: params.competition || null
    } });
    return matches;
  } catch (e) {
    logger.error(`[SportScore] getMatchesByDate error: ${e.message}`);
    throw e;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🔍 2. MATCH DETAILS, INCIDENTS & LINEUPS
// ═══════════════════════════════════════════════════════════════════
exports.getMatchDetails = async (matchSlugOrId) => {
  try {
    let slug = String(matchSlugOrId).trim();
    if (slug.startsWith('/football/match/')) {
      slug = slug.replace('/football/match/', '').replace(/\//g, '');
    }

    const known = getCached('sportscore:fixture:' + slug);
    const raw = await fetchSportScore('/api/widget/match/', { slug }, TTL.MATCH_DETAIL);
    if (!raw?.match) return known ? { ...known, detailsAvailable: false, timeline: [], lineups: null, providerStatistics: [] } : null;
    let details = normalizeSportScoreMatchDetail(raw.match, slug);
    if (known) {
      const identitiesMatch = sameEntity(details.homeTeam?.name, known.homeTeam?.name) && sameEntity(details.awayTeam?.name, known.awayTeam?.name);
      const datesMatch = !details.utcDate || !known.utcDate || Date.parse(details.utcDate) === Date.parse(known.utcDate);
      if (!identitiesMatch || !datesMatch) {
        logger.warn('[SportScore] Ignored mismatched detail identity for cached fixture');
        return { ...known, detailsAvailable: false, timeline: [], lineups: null, providerStatistics: [] };
      }
      if (known.competition?.code === details.competition?.code) {
        for (const side of ['homeTeam', 'awayTeam']) {
          if (!details[side]?.id && known[side]?.id && !details[side]?.identityConflict) {
            details[side] = { ...details[side], id: known[side].id, provider: 'sportscore',
              identityBasis: known[side].identityBasis, identityCompetitionCode: known[side].identityCompetitionCode,
              identityCompetitionSlug: known[side].identityCompetitionSlug };
          }
        }
      }
    }
    [details] = await enrichFixtureTeamIdentities([details]);
    return { ...details, detailsAvailable: true };
  } catch (e) {
    logger.error(`[SportScore] getMatchDetails error: ${e.message}`);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🏆 3. LEAGUE STANDINGS
// ═══════════════════════════════════════════════════════════════════
exports.getStandings = async (competitionCode) => {
  try {
    const slug = resolveCompetitionSlug(competitionCode);
    const raw = await fetchSportScore('/api/widget/standings/', { slug }, TTL.STANDINGS);
    if (!Array.isArray(raw?.tables)) return [];

    return raw.tables.flatMap(table => (table.rows || []).map(r => ({
      group: table.group || '',
      position: numericOrNull(r.pos),
      team: {
        ...standingsTeamIdentity(r),
        provider: 'sportscore',
        name: r.team || 'Team',
        shortName: r.team || 'Team',
        crest: r.team_logo || '',
        slug: r.team_slug || ''
      },
      playedGames: numericOrNull(r.p),
      won: numericOrNull(r.w),
      draw: numericOrNull(r.d),
      lost: numericOrNull(r.l),
      points: numericOrNull(r.pts),
      goalsFor: numericOrNull(r.gf),
      goalsAgainst: numericOrNull(r.ga),
      goalDifference: numericOrNull(r.gd),
      promotion: r.promo_name || '',
      promoColor: r.promo_color || '',
      form: ''
    })));
  } catch (e) {
    logger.error(`[SportScore] getStandings error: ${e.message}`);
    return [];
  }
};

// ═══════════════════════════════════════════════════════════════════
// ⚽ 4. TOP SCORERS & ASSISTS
// ═══════════════════════════════════════════════════════════════════
exports.getTopScorers = async (competitionCode, limit = 20, stat = 'goals') => {
  try {
    const slug = resolveCompetitionSlug(competitionCode);
    const raw = await fetchSportScore('/api/widget/topscorers/', {
      slug,
      limit: Math.min(limit, 50),
      stat: stat === 'assists' ? 'assists' : 'goals'
    }, TTL.TOP_SCORERS);

    if (!raw?.scorers) return [];

    return raw.scorers.map(s => ({
      rank: numericOrNull(s.rank),
      player: {
        id: s.player_slug || s.player || '',
        provider: 'sportscore',
        name: s.player || 'Player',
        image: firstPlayerImage(s.player_logo, s.player_image, s.player_photo),
        slug: s.player_slug || ''
      },
      team: {
        id: s.team_slug || '',
        name: s.team || '',
        crest: s.team_logo || '',
        slug: s.team_slug || ''
      },
      goals: numericOrNull(s.goals),
      assists: numericOrNull(s.assists),
      playedMatches: numericOrNull(s.matches),
      minutesPlayed: numericOrNull(s.minutes),
      rating: normalizedRating(s.rating),
      ratingRaw: numericOrNull(s.rating)
    }));
  } catch (e) {
    logger.error(`[SportScore] getTopScorers error: ${e.message}`);
    return [];
  }
};

// ═══════════════════════════════════════════════════════════════════
// 👤 5. PLAYER DETAILS & METRICS
// ═══════════════════════════════════════════════════════════════════
exports.getPlayerDetails = async (playerSlugOrName) => {
  try {
    let slug = String(playerSlugOrName).trim().toLowerCase().replace(/\s+/g, '-');
    if (slug.startsWith('/football/player/')) {
      slug = slug.replace('/football/player/', '').replace(/\//g, '');
    }

    const raw = await fetchSportScore('/api/widget/player/', { slug }, TTL.PLAYER);
    if (!raw?.player) {
      // Try searching player if direct slug fails
      const searchRes = await exports.searchEntities(playerSlugOrName);
      const found = searchRes?.players?.find(p => sameEntity(p.name, playerSlugOrName) || p.slug === slug);
      if (found) {
        const foundSlug = found.slug;
        if (foundSlug && foundSlug !== slug) {
          return exports.getPlayerDetails(foundSlug);
        }
      }
      return null;
    }

    const p = raw.player;
    const st = raw.stats || {};
    const identity = p.slug || slug;
    const honours = normalizePlayerHonours(playerHonourInput(p.honours, p.trophies, raw.honours, raw.trophies),
      { playerId: identity, rawPlayerId: identity, provider: 'sportscore',
        complete: p.honours_complete === true || raw.honours_complete === true });

    return {
      id: identity,
      name: p.name || '',
      fullName: p.name || '',
      image: firstPlayerImage(p.logo, p.image, p.photo, p.player_logo, raw.player_logo),
      ...honours,
      team: st.team || '',
      teamBadge: st.team_logo || '',
      competition: st.competition || '',
      matches: numericOrNull(st.matches),
      goals: numericOrNull(st.goals),
      assists: numericOrNull(st.assists),
      minutes: numericOrNull(st.minutes),
      rating: normalizedRating(st.rating),
      ratingRaw: numericOrNull(st.rating),
      yellowCards: numericOrNull(st.yellow_cards),
      redCards: numericOrNull(st.red_cards),
      shots: numericOrNull(st.shots),
      shotsOnTarget: numericOrNull(st.shots_on_target),
      passes: numericOrNull(st.passes),
      passesAccuracy: numericOrNull(st.passes_accuracy),
      tackles: numericOrNull(st.tackles),
      interceptions: numericOrNull(st.interceptions),
      dribbles: numericOrNull(st.dribbles),
      keyPasses: numericOrNull(st.key_passes),
      statsContext: { team: st.team || '', competition: st.competition || '', season: st.season || raw.season || null },
      source: 'sportscore'
    };
  } catch (e) {
    logger.error(`[SportScore] getPlayerDetails error: ${e.message}`);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🛡️ 6. TEAM DETAILS & SCHEDULE
// ═══════════════════════════════════════════════════════════════════
exports.getTeamDetails = async (teamSlugOrName) => {
  try {
    let slug = String(teamSlugOrName).trim().toLowerCase().replace(/\s+/g, '-');
    if (slug.startsWith('/football/team/')) {
      slug = slug.replace('/football/team/', '').replace(/\//g, '');
    }

    const raw = await fetchSportScore('/api/widget/team/', { slug, limit: 30 }, TTL.TEAM);
    if (!raw?.team) {
      // Try search fallback
      const searchRes = await exports.searchEntities(teamSlugOrName);
      const found = searchRes?.teams?.find(t => sameEntity(t.name, teamSlugOrName) || t.slug === slug);
      if (found) {
        const foundSlug = found.slug;
        if (foundSlug && foundSlug !== slug) {
          return exports.getTeamDetails(foundSlug);
        }
      }
      return null;
    }

    const team = raw.team;
    // A team widget is not proof of the competition of every nested fixture.
    // Only its fixtures carrying an exact provider competition slug may use
    // standings to resolve missing club IDs.
    const matches = cacheFixtureScores(await enrichFixtureTeamIdentities(
      deduplicateMatches((raw.matches || []).map(normalizeSportScoreMatch)),
      { requireCompetitionSlug: true },
    ));

    const recent = matches.filter(m => m.status === 'FINISHED').sort((a, b) => String(b.utcDate).localeCompare(String(a.utcDate)));
    const upcoming = matches.filter(m => ['TIMED', 'SCHEDULED'].includes(m.status)).sort((a, b) => String(a.utcDate).localeCompare(String(b.utcDate)));

    return {
      info: {
        id: team.slug || slug,
        name: team.name || 'Team',
        shortName: team.name || 'Team',
        logo: team.logo || '',
        crest: team.logo || '',
        slug: team.slug || slug,
        country: typeof team.country === 'string' ? team.country : (team.country?.name || ''),
      },
      matches: {
        recent,
        upcoming
      },
      source: 'sportscore'
    };
  } catch (e) {
    logger.error(`[SportScore] getTeamDetails error: ${e.message}`);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🔍 7. SEARCH (TEAMS, COMPETITIONS, PLAYERS)
// ═══════════════════════════════════════════════════════════════════
exports.searchEntities = async (query, limit = 15) => {
  try {
    const { searchQuery, playerSearchTerms, sortByRelevance } = require('../utils/searchQueries');
    const q = searchQuery(query).term;
    if (q.length < 2) return { teams: [], competitions: [], players: [] };
    const cap = Math.min(20, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 15));
    const terms = playerSearchTerms(q);
    // The documented endpoint caps each query at 20. Supplement only players;
    // extra full-name retrieval never changes the relevance of the original term.
    const batches = await Promise.all(terms.map(term => fetchSportScore('/api/v1/search/',
      { q: term, limit: 20 }, TTL.SEARCH)));
    const raw = batches[0];
    if (!batches.some(Boolean)) return { teams: [], competitions: [], players: [], coverage: { available: false, complete: false, partial: true } };
    const text = value => typeof value === 'string' ? value : typeof value?.name === 'string' ? value.name : '';
    const context = value => ({
      country: text(value.country), countryCode: value.country_code || value.country?.code || '',
      nationality: text(value.nationality), gender: text(value.gender),
      ...(typeof value.is_women === 'boolean' ? { isWomen: value.is_women } : {}),
      league: text(value.competition || value.league),
      leagueCode: value.competition_code || value.competition?.code || value.league?.code || ''
    });
    const teams = (raw?.teams || []).map(t => ({
      id: t.slug || t.id || null,
      name: t.name,
      shortName: t.short_name || t.name,
      logo: t.logo || '',
      crest: t.logo || '',
      slug: t.slug || '',
      url: t.url || '',
      ...context(t),
      type: t.is_national === true ? 'national' : 'club',
      provider: 'sportscore'
    }));

    const competitions = (raw?.competitions || []).map(c => ({
      id: c.slug || c.id || null,
      name: c.name,
      logo: c.logo || '',
      emblem: c.logo || '',
      slug: c.slug || '',
      url: c.url || '',
      ...context(c),
      type: 'league',
      provider: 'sportscore'
    }));

    const players = [...new Map(batches.flatMap(batch => (batch?.players || []).map(p => ({
      id: p.slug || p.id || null, name: p.name, fullName: p.full_name || p.name, shortName: p.short_name || p.name,
      logo: firstPlayerImage(p.logo, p.image, p.photo, p.player_logo),
      image: firstPlayerImage(p.logo, p.image, p.photo, p.player_logo), slug: p.slug || '',
      url: p.url || '', ...context(p), team: text(p.team), type: 'player', provider: 'sportscore'
    }))).filter(p => p.id).map(p => [p.id, p])).values()];

    return {
      teams: sortByRelevance(teams, q, 'teams').slice(0, cap),
      competitions: sortByRelevance(competitions, q, 'leagues').slice(0, cap),
      players: sortByRelevance(players, q, 'players').slice(0, cap),
      coverage: { available: true, complete: false, partial: true, limit: 20,
        resultLimit: teams.length > cap || competitions.length > cap || players.length > cap,
        possiblyTruncated: batches.some(batch => ['teams', 'competitions', 'players'].some(key => batch?.[key]?.length >= 20)),
        queries: terms.map((term, index) => ({ term, available: Boolean(batches[index]) })) }
    };
  } catch (e) {
    logger.error(`[SportScore] searchEntities error: ${e.message}`);
    return { teams: [], competitions: [], players: [], coverage: { available: false, complete: false, partial: true } };
  }
};

// ═══════════════════════════════════════════════════════════════════
// ⚔️ 8. HEAD TO HEAD (H2H)
// ═══════════════════════════════════════════════════════════════════
exports.getH2H = async (team1Slug, team2Slug, limit = 20) => {
  try {
    const raw = await fetchSportScore('/api/v1/h2h/', {
      team1: team1Slug,
      team2: team2Slug,
      limit: Math.min(limit, 50)
    }, TTL.H2H);

    if (!raw?.matches) return null;

    return {
      team1: raw.team1,
      team2: raw.team2,
      summary: raw.summary || { team1_wins: 0, team2_wins: 0, draws: 0, meetings: 0 },
      matches: raw.matches.map(normalizeSportScoreMatch),
      source: 'sportscore'
    };
  } catch (e) {
    logger.error(`[SportScore] getH2H error: ${e.message}`);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 📐 NORMALIZATION HELPERS
// ═══════════════════════════════════════════════════════════════════
// Known competition name → code mapping for proper identification
// IMPORTANT: Use EXACT names as they come from SportScore API - no partial matching!
const KNOWN_COMPETITIONS = {
  // English
  'premier league': { code: 'PL', name: 'Premier League', country: 'England' },
  'english premier league': { code: 'PL', name: 'Premier League', country: 'England' },
  'epl': { code: 'PL', name: 'Premier League', country: 'England' },
  'championship': { code: 'ELC', name: 'Championship', country: 'England' },
  'efl championship': { code: 'ELC', name: 'Championship', country: 'England' },
  'english championship': { code: 'ELC', name: 'Championship', country: 'England' },
  // Spanish
  'la liga': { code: 'PD', name: 'La Liga', country: 'Spain' },
  'spanish la liga': { code: 'PD', name: 'La Liga', country: 'Spain' },
  'laliga': { code: 'PD', name: 'La Liga', country: 'Spain' },
  'laliga ea sports': { code: 'PD', name: 'La Liga', country: 'Spain' },
  // Italian
  'serie a': { code: 'SA', name: 'Serie A', country: 'Italy' },
  'italian serie a': { code: 'SA', name: 'Serie A', country: 'Italy' },
  // German
  'bundesliga': { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
  'german bundesliga': { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
  // French
  'ligue 1': { code: 'FL1', name: 'Ligue 1', country: 'France' },
  'french ligue 1': { code: 'FL1', name: 'Ligue 1', country: 'France' },
  'ligue 1 uber eats': { code: 'FL1', name: 'Ligue 1', country: 'France' },
  // UEFA
  'champions league': { code: 'CL', name: 'UEFA Champions League', country: 'Europe' },
  'uefa champions league': { code: 'CL', name: 'UEFA Champions League', country: 'Europe' },
  'europa league': { code: 'EL', name: 'UEFA Europa League', country: 'Europe' },
  'uefa europa league': { code: 'EL', name: 'UEFA Europa League', country: 'Europe' },
  'conference league': { code: 'ECL', name: 'UEFA Conference League', country: 'Europe' },
  'uefa europa conference league': { code: 'ECL', name: 'UEFA Conference League', country: 'Europe' },
  // Other European
  'eredivisie': { code: 'DED', name: 'Eredivisie', country: 'Netherlands' },
  'netherlands eredivisie': { code: 'DED', name: 'Eredivisie', country: 'Netherlands' },
  'primeira liga': { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  'portuguese primeira liga': { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  'liga portugal': { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  'scottish premiership': { code: 'SPL2', name: 'Scottish Premiership', country: 'Scotland' },
  'belgian pro league': { code: 'BPL', name: 'Belgian Pro League', country: 'Belgium' },
  'super lig': { code: 'TSL', name: 'Süper Lig', country: 'Turkey' },
  'turkish super lig': { code: 'TSL', name: 'Süper Lig', country: 'Turkey' },
  // South America
  'brasileirao serie a': { code: 'BSA', name: 'Brasileirão', country: 'Brazil' },
  'brazilian serie a': { code: 'BSA', name: 'Brasileirão', country: 'Brazil' },
  'brasileirao': { code: 'BSA', name: 'Brasileirão', country: 'Brazil' },
  'copa libertadores': { code: 'CLI', name: 'Copa Libertadores', country: 'South America' },
  'conmebol libertadores': { code: 'CLI', name: 'Copa Libertadores', country: 'South America' },
  'copa sudamericana': { code: 'CSA', name: 'Copa Sudamericana', country: 'South America' },
  'ligapro serie a': { code: 'ECUA', name: 'LigaPro Serie A', country: 'Ecuador' },
  // Middle East
  'saudi pro league': { code: 'SPL', name: 'Saudi Pro League', country: 'Saudi Arabia' },
  'roshn saudi league': { code: 'SPL', name: 'Saudi Pro League', country: 'Saudi Arabia' },
  'qatar stars league': { code: 'QSL', name: 'Qatar Stars League', country: 'Qatar' },
  'united arab emirates adnoc pro-league': { code: 'UAE', name: 'UAE Pro League', country: 'UAE' },
  // North America
  'mls': { code: 'MLS', name: 'MLS', country: 'USA' },
  'major league soccer': { code: 'MLS', name: 'MLS', country: 'USA' },
  'liga mx': { code: 'LMX', name: 'Liga MX', country: 'Mexico' },
  // International
  'world cup': { code: 'WC', name: 'FIFA World Cup', country: 'International' },
  'european championship': { code: 'EC', name: 'European Championship', country: 'Europe' },
  'copa america': { code: 'COPA', name: 'Copa América', country: 'South America' },
  'africa cup of nations': { code: 'AFCON', name: 'Africa Cup of Nations', country: 'Africa' },
  'caf confederation cup': { code: 'CAFCC', name: 'CAF Confederation Cup', country: 'Africa' },
  'caf champions league': { code: 'CAFCL', name: 'CAF Champions League', country: 'Africa' },
  // Other
  'ukrainian premier league': { code: 'UPL', name: 'Ukrainian Premier League', country: 'Ukraine' },
  'categoría primera a': { code: 'COL', name: 'Liga BetPlay', country: 'Colombia' },
};

function resolveCompetition(competitionName) {
  if (!competitionName) return null;
  const lower = competitionName.toLowerCase().trim();
  
  // EXACT match only - no partial matching to avoid false positives
  if (KNOWN_COMPETITIONS[lower]) return KNOWN_COMPETITIONS[lower];
  const entry = Object.entries(COMPETITION_SLUGS).find(([, value]) => value.slug === lower.replace(/\s+/g, '-'));
  if (entry) return { code: entry[0], name: entry[1].name, country: entry[1].country };
  const namedEntry = Object.entries(COMPETITION_SLUGS).find(([, value]) =>
    value.name.toLowerCase() === lower,
  );
  if (namedEntry) return {
    code: namedEntry[0], name: namedEntry[1].name, country: namedEntry[1].country,
  };
  
  return null;
}

function normalizeSportScoreMatch(m) {
  const { canonicalMatchStatus, STATUS_LABELS } = require('../utils/matchStatus');
  const canonicalStatus = canonicalMatchStatus(m.status);
  // SportScore live partitions expose halftime as IN_PLAY; phase metadata
  // continues to carry the pause without dropping these active fixture rows.
  const normalizedStatus = canonicalStatus === 'PAUSED' ? 'IN_PLAY' : canonicalStatus;

  const scoreOrNull = value => {
    const number = numericOrNull(value);
    return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
  };
  const homeScoreNum = scoreOrNull(m.home_score);
  const awayScoreNum = scoreOrNull(m.away_score);
  const timing = normalizeMatchTiming({ status: m.status, period: m.period,
    statusText: m.status_text, minute: m.live_minute });

  const matchId = (m.url || m.slug || `${m.home}-vs-${m.away}`).replace('/football/match/', '').replace(/\//g, '');

  // Resolve known competition
  const namedCompetition = typeof m.competition === 'string' ? resolveCompetition(m.competition) : null;
  const competitionSlug = typeof m.competition_slug === 'string' ? m.competition_slug.trim() : '';
  const slugEntry = competitionSlug ? Object.entries(COMPETITION_SLUGS).find(([, info]) => info.slug === competitionSlug) : null;
  // An explicit but conflicting/unknown provider scope must never borrow the
  // identity of a league inferred from its display name.
  const knownComp = competitionSlug ?
    (slugEntry && (!namedCompetition || namedCompetition.code === slugEntry[0]) ?
      { code: slugEntry[0], name: slugEntry[1].name, country: slugEntry[1].country } : null) : namedCompetition;
  // Four-letter prefixes merged unrelated leagues (e.g. every UEFA competition).
  const compCode = knownComp ? knownComp.code : `SC:${String(competitionSlug || m.competition || 'unknown').trim().toLowerCase()}`;
  const compName = knownComp ? knownComp.name : (m.competition || 'Football Competition');

  return {
    id: matchId,
    slug: matchId,
    utcDate: m.time || null,
    status: normalizedStatus,
    statusText: ['IN_PLAY', 'PAUSED', 'TIMED', 'FINISHED'].includes(normalizedStatus) &&
      typeof m.status_text === 'string' && m.status_text.trim()
      ? m.status_text : STATUS_LABELS[canonicalStatus],
    sourceStatus: m.status ?? null,
    minute: m.live_minute ?? null,
    period: m.period || '',
    ...timing,
    homeTeam: fixtureTeam(m, 'home'),
    awayTeam: fixtureTeam(m, 'away'),
    score: {
      fullTime: {
        home: homeScoreNum,
        away: awayScoreNum
      },
      halfTime: timing.halfTimeConfirmed ? {
        home: scoreOrNull(m.home_ht_score),
        away: scoreOrNull(m.away_ht_score)
      } : null
    },
    competition: {
      id: compCode,
      name: compName,
      code: compCode,
      ...(competitionSlug ? { slug: competitionSlug } : {}),
      country: knownComp ? knownComp.country : '',
      emblem: m.competition_logo || '',
      logo: m.competition_logo || ''
    },
    source: 'sportscore',
    provider: 'sportscore'
  };
}

function normalizeSportScoreMatchDetail(m, slug) {
  const base = normalizeSportScoreMatch(m);

  // Incidents normalization (Timeline)
  const timeline = (m.incidents || []).map(inc => {
    let type = 'incident';
    let icon = '⚡';
    const typeStr = (inc.type || '').toLowerCase();

    if (inc.is_goal || typeStr.includes('goal')) {
      type = 'goal';
      icon = '⚽';
    } else if (typeStr.includes('red')) {
      type = 'red_card';
      icon = '\uD83D\uDFE5';
    } else if (inc.is_card || typeStr.includes('yellow')) {
      type = 'yellow_card';
      icon = '\uD83D\uDFE8';
    } else if (typeStr.includes('sub')) {
      type = 'substitution';
      icon = '🔄';
    }

    return {
      minute: inc.time ?? null,
      type,
      icon,
      label: inc.type || 'Event',
      side: ['home', 'away'].includes(inc.side) ? inc.side : null,
      player: inc.player || '',
      assist: inc.assist || null,
      playerOut: inc.player_out || inc.playerOut || null
    };
  });

  // Lineups normalization
  const lineups = m.lineups || {};
  const mapPlayer = p => {
    const name = p.name || p.playerName || '';
    if (!name) return null;
    const id = p.slug || p.id ? String(p.slug || p.id) : null;
    const number = p.number ?? null;
    return {
      id,
      provider: 'sportscore',
      image: p.logo || p.image || p.photo || p.player_logo || '',
      name,
      playerName: name,
      number,
      position: p.position || '',
      grid: p.grid ?? p.player?.grid ?? null,
      captain: Boolean(p.captain),
      rating: normalizedRating(p.rating),
      player: {
        id,
        provider: 'sportscore',
        image: p.logo || p.image || p.photo || p.player_logo || '',
        name,
        number
      }
    };
  };

  const homeXi = (lineups.home_xi || []).map(mapPlayer).filter(Boolean);
  const awayXi = (lineups.away_xi || []).map(mapPlayer).filter(Boolean);
  const homeSubs = (lineups.home_subs || []).map(mapPlayer).filter(Boolean);
  const awaySubs = (lineups.away_subs || []).map(mapPlayer).filter(Boolean);

  return {
    ...base,
    slug,
    timeline,
    incidentCoverage: { available: Array.isArray(m.incidents), complete: m.incidents_complete === true,
      partial: m.incidents_complete !== true },
    providerStatistics: Array.isArray(m.stats) ? m.stats : [],
    lineups: validateLineupIntegrity({
      matchId: base.id || slug,
      homeTeamId: base.homeTeam?.id,
      awayTeamId: base.awayTeam?.id,
      source: 'sportscore',
      homeFormation: lineups.home_formation || '',
      awayFormation: lineups.away_formation || '',
      homeCoach: lineups.home_coach || null,
      awayCoach: lineups.away_coach || null,
      confirmed: Boolean(lineups.confirmed),
      home: homeXi,
      away: awayXi,
      homeBench: homeSubs,
      awayBench: awaySubs
    }, { homeTeamId: base.homeTeam?.id, awayTeamId: base.awayTeam?.id, provider: 'sportscore' }),
    tracker: m.tracker || null,
    source: 'sportscore'
  };
}

module.exports = {
  getLiveMatches: exports.getLiveMatches,
  getMatchesByDate: exports.getMatchesByDate,
  getMatchDetails: exports.getMatchDetails,
  getStandings: exports.getStandings,
  getTopScorers: exports.getTopScorers,
  getPlayerDetails: exports.getPlayerDetails,
  getTeamDetails: exports.getTeamDetails,
  searchEntities: exports.searchEntities,
  getH2H: exports.getH2H,
  COMPETITION_SLUGS,
  normalizeMatch: normalizeSportScoreMatch,
  normalizeMatchDetail: normalizeSportScoreMatchDetail
};
