/** BSD v2: retain provider identities, missing-data states and prediction provenance. */
const axios = require('axios');
const { getCached, setCache } = require('./cacheService');
const logger = require('../utils/logger');
const { normalizeMatchTiming } = require('../utils/matchTiming');
const { getFixtureSourceConflict, requiresFixtureSourceReview } = require('../utils/fixtureSourceQuality');
const { annotateFixtureSourceStage } = require('../utils/fixtureSourceAnnotations');
const { normalizeCareerCompetitionLabels } = require('../utils/careerCompetitionLabels');
const { normalizePlayerHonours, playerHonourInput } = require('../utils/playerHonours');
const { validateLineupIntegrity } = require('../utils/lineupIntegrity');
const { selectBsdPlayerScope, aggregateBsdPlayerStatistics } = require('../utils/playerStatisticsScope');
const { recoverBsdMatchSquad, buildBsdTeamFixtureNumbers, buildBsdTeamStandingNumbers } = require('./teamTabCoverageService');
const API_TOKEN = String(process.env.BSD_API_TOKEN || '').trim();
const BASE_URL = String(process.env.BSD_BASE_URL || 'https://sports.bzzoiro.com').replace(/\/+$/, '');
const isConfigured = () => Boolean(API_TOKEN);
const TTL = { live: 15000, matches: 120000, details: 300000, catalog: 3600000, predictions: 600000 };
const bounded = (value, fallback, min, max) => /^\d+$/.test(String(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const MAX_PAGES = bounded(process.env.BSD_MAX_PAGES, 10, 1, 20);
const MAX_ROWS = bounded(process.env.BSD_MAX_ROWS, 2000, 200, 4000);
const LEAGUE_CODE_TO_BSD_ID = Object.freeze({
  PL: 1, PPL: 2, PD: 3, SA: 4, BL1: 5, FL1: 6, CL: 7, EL: 8, BSA: 9, DED: 10,
  TSL: 11, ELC: 12, SPL: 17, MLS: 18, WC: 27, CAF: 29, CLI: 32, FAC: 39,
  CDR: 41, CIT: 42, DFB: 43, UNL: 64, EC: 66, ECL: 83, ARG: 85,
});
const BSD_ID_TO_LEAGUE_CODE = Object.freeze(Object.fromEntries(Object.entries(LEAGUE_CODE_TO_BSD_ID).map(([code, id]) => [id, code])));
const PRIMARY_LEAGUE_IDS = new Set([1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 17, 18, 85]);
const origin = (() => { try { return new URL(BASE_URL).origin; } catch (_) { return null; } })();
const inflight = new Map();
const bsdClient = axios.create({
  baseURL: BASE_URL, headers: { Authorization: 'Token ' + API_TOKEN, Accept: 'application/json', 'User-Agent': 'KickSphereApp/2.0 (BSD Integration)' },
  timeout: 10000, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024,
});
function positiveId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d{0,14}$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}
function scopedId(value, prefix) { const text = String(value ?? ''); return text.startsWith(prefix) ? positiveId(text.slice(prefix.length)) : null; }
function numeric(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object' || String(value).trim() === '') return null;
  const n = Number(typeof value === 'string' ? value.trim().replace(/%$/, '') : value);
  return Number.isFinite(n) ? n : null;
}
function confidencePercent(value) { const n = numeric(value); return n !== null && n >= 0 && n <= 1 ? Number((n * 100).toFixed(1)) : null; }
function integer(value) { const n = numeric(value); return n !== null && n >= 0 && Number.isInteger(n) ? n : null; }
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !calendarDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}
function imageUrl(type, id) { return positiveId(id) && origin ? origin + '/img/' + type + '/' + id + '/' : ''; }
function safeImage(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
}
function withCoverage(rows, coverage) {
  Object.defineProperty(rows, 'coverage', { value: { source: 'bsd', ...coverage }, enumerable: false, configurable: true });
  return rows;
}
function unavailableCoverage() { return { source: 'bsd', available: false, complete: false, partial: true, possiblyTruncated: false, pages: 0 }; }
function normalizedCoverage(raw, invalidRows = 0, rejectedRows = 0) {
  const coverage = raw.coverage || unavailableCoverage();
  const complete = coverage.complete && invalidRows === 0 && rejectedRows === 0;
  return { ...coverage, complete, partial: !complete, invalidRows, rejectedRows };
}
function fixtureSourceConflict(raw) {
  return getFixtureSourceConflict({ provider: 'bsd', id: 'bsd_' + positiveId(raw?.id ?? raw?.event_id),
    competitionId: positiveId(raw?.league_id ?? raw?.league?.id ?? raw?.season?.league?.id),
    seasonId: positiveId(raw?.season_id ?? raw?.season?.id),
    homeTeamId: positiveId(raw?.home_team_obj?.id ?? raw?.home_team_id),
    awayTeamId: positiveId(raw?.away_team_obj?.id ?? raw?.away_team_id),
    utcDate: instant(raw?.event_date || raw?.date), status: normalizeStatus(raw?.status) });
}
function fixtureCoverage(raw, normalized, rejectedRows = 0) {
  const sourceConflicts = raw.map(fixtureSourceConflict).filter(Boolean);
  const count = sourceConflicts.length;
  return { ...normalizedCoverage(raw, Math.max(0, raw.length - normalized.length - count), rejectedRows + count),
    ...(count ? { sourceConflictRows: count, sourceConflicts,
      reason: raw.coverage?.reason || 'official_schedule_conflict' } : {}) };
}
function paramsSorted(params) { return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => a.localeCompare(b))); }
function safeRequest(path, expectedPath) {
  try {
    const url = new URL(path, BASE_URL + '/');
    if (!origin || url.origin !== origin || url.username || url.password || url.hash || !url.pathname.startsWith('/api/v2/')) return null;
    if (expectedPath && url.pathname !== expectedPath) return null;
    return url.pathname + url.search;
  } catch (_) { return null; }
}
async function fetchBsd(endpoint, params = {}, ttl = TTL.matches, timeoutMs) {
  if (!isConfigured()) return null;
  const path = safeRequest(endpoint);
  if (!path) return null;
  const cleanParams = paramsSorted(params);
  const key = 'bsd:v2:' + path + ':' + new URLSearchParams(cleanParams);
  const cached = getCached(key);
  if (cached !== undefined && cached !== null) return cached;
  const timeout = integer(timeoutMs), requestTimeout = timeout !== null && timeout > 0 ? Math.min(timeout, 10000) : null;
  // A shorter budget must not join an earlier request with a longer deadline.
  const inflightKey = requestTimeout === null ? key : key + ':timeout:' + requestTimeout;
  if (inflight.has(inflightKey)) return inflight.get(inflightKey);
  const pending = (async () => {
    try {
      const response = await bsdClient.get(path, { params: cleanParams, maxRedirects: 0,
        ...(requestTimeout === null ? {} : { timeout: requestTimeout, signal: AbortSignal.timeout(requestTimeout) }) });
      if (response.data !== undefined && response.data !== null && typeof response.data === 'object') {
        setCache(key, response.data, ttl); return response.data;
      }
    } catch (error) {
      // Never log Axios errors or their config: they include the authorization header.
      const reason = error.response?.status || (/^[A-Z_]+$/.test(String(error.code)) ? error.code : 'unavailable');
      logger.warn('[BSD v2] ' + path.split('?')[0] + ' unavailable (' + reason + ')');
    }
    return null;
  })();
  inflight.set(inflightKey, pending);
  try { return await pending; } finally { inflight.delete(inflightKey); }
}
function listRows(body, keys) { if (Array.isArray(body)) return body; for (const key of keys) if (Array.isArray(body?.[key])) return body[key]; return null; }
async function fetchList(endpoint, params = {}, ttl = TTL.matches, keys = ['results'], options = {}) {
  let body = await fetchBsd(endpoint, params, ttl);
  let pageRows = listRows(body, keys);
  if (!pageRows) return null;
  const endpointPath = new URL(endpoint, BASE_URL + '/').pathname;
  const originalParams = paramsSorted(params);
  const reported = integer(body?.count);
  const rows = [], seen = new Set(), visited = new Set();
  let pages = 0, complete = true, reason = null, duplicateRows = 0;
  const maxPages = Math.min(MAX_PAGES, options.maxPages || MAX_PAGES), maxRows = Math.min(MAX_ROWS, options.maxRows || MAX_ROWS);
  while (pageRows) {
    pages += 1;
    for (const row of pageRows) {
      const key = options.key ? options.key(row) : positiveId(row?.id);
      if (key && seen.has(String(key))) { duplicateRows += 1; continue; }
      if (key) seen.add(String(key));
      if (rows.length >= maxRows) { complete = false; reason = 'row_limit'; break; }
      rows.push(row);
    }
    if (!complete) break;
    const next = body?.next;
    if (!next) { if (reported !== null && rows.length < reported) { complete = false; reason = 'count_mismatch'; } break; }
    if (pages >= maxPages || rows.length >= maxRows) { complete = false; reason = 'page_limit'; break; }
    const nextPath = safeRequest(next, endpointPath);
    if (!nextPath || visited.has(nextPath)) { complete = false; reason = 'invalid_pagination'; break; }
    const nextUrl = new URL(nextPath, BASE_URL + '/');
    if (Object.entries(originalParams).some(([key, value]) => !['offset', 'limit'].includes(key) && nextUrl.searchParams.get(key) !== String(value))) { complete = false; reason = 'changed_pagination_scope'; break; }
    visited.add(nextPath);
    body = await fetchBsd(nextPath, {}, ttl);
    pageRows = listRows(body, keys);
    if (!pageRows) { complete = false; reason = 'page_unavailable'; break; }
    if (pageRows.length === 0 && body?.next) { complete = false; reason = 'empty_pagination'; break; }
  }
  return withCoverage(rows, { available: true, complete, partial: !complete, possiblyTruncated: !complete, reportedTotal: reported, pages, duplicateRows, reason });
}
function leagueId(code) { return LEAGUE_CODE_TO_BSD_ID[String(code)] || (/^BSD:[1-9]\d*$/.test(String(code)) ? positiveId(String(code).slice(4)) : positiveId(code)); }
function normalizeLeague(raw) {
  const id = positiveId(raw?.id); if (!id || !raw.name) return null;
  const code = BSD_ID_TO_LEAGUE_CODE[id] || 'BSD:' + id;
  return { id: code, rawId: id, providerId: String(id), code, mappedCode: BSD_ID_TO_LEAGUE_CODE[id] || null, name: String(raw.name), country: raw.country || '', countryCode: raw.country_code || '', isWomen: raw.is_women === true, currentSeason: raw.current_season || null, season: raw.current_season || null, logo: safeImage(raw.logo) || imageUrl('league', id), emblem: safeImage(raw.logo) || imageUrl('league', id), provider: 'bsd', source: 'bsd' };
}
function normalizeTeam(raw, fallback = {}) {
  const id = positiveId(raw?.id ?? fallback.id), name = raw?.name ?? fallback.name;
  if (!id || typeof name !== 'string' || !name.trim()) return null;
  const logo = safeImage(raw?.logo) || imageUrl('team', id);
  return { id: 'bsd_t_' + id, rawId: id, providerId: String(id), provider: 'bsd', source: 'bsd', name: name.trim(), shortName: raw?.short_name || name.trim(), country: raw?.country || '', countryCode: raw?.country_code || '', crest: logo, logo, slug: 'bsd_t_' + id, type: raw?.is_national === true ? 'national' : 'team', venueId: positiveId(raw?.venue_id), coach: raw?.coach?.name || '', founded: integer(raw?.founded) };
}
function availability(raw) {
  const status = ['available', 'injured', 'doubtful', 'suspended'].includes(raw?.availability) ? raw.availability : null;
  return { status, confirmedFit: false, reason: raw?.injury_type || '', expectedReturn: calendarDate(raw?.injury_expected_return), source: 'bsd' };
}
function ageFromBirth(date) {
  const valid = calendarDate(date); if (!valid) return null;
  const born = new Date(valid + 'T00:00:00Z'), now = new Date();
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age -= 1;
  return age >= 0 && age < 100 ? age : null;
}
function normalizePlayer(raw) {
  const id = positiveId(raw?.id ?? raw?.player_id), name = raw?.name ?? raw?.player_name;
  if (!id || typeof name !== 'string' || !name.trim()) return null;
  const photo = safeImage(raw.image) || safeImage(raw.photo) || imageUrl('player', id), born = calendarDate(raw.date_of_birth), number = integer(raw.jersey_number);
  return { id: 'bsd_p_' + id, rawId: id, providerId: String(id), provider: 'bsd', source: 'bsd', name: name.trim(), fullName: name.trim(), shortName: raw.short_name || name.trim(), playerName: name.trim(), image: photo, photo, position: raw.specific_position || raw.position || '', positionGroup: raw.position || '', specificPosition: raw.specific_position || '', number, jerseyNumber: number, nationality: raw.nationality || '', country: raw.nationality || '', dateBorn: born || '', dateOfBirth: born, age: ageFromBirth(born), height: numeric(raw.height_cm), weight: numeric(raw.weight_kg), preferredFoot: raw.preferred_foot || '', availability: availability(raw), captain: raw.captain === true, aiScore: numeric(raw.ai_score), player: { id: 'bsd_p_' + id, name: name.trim(), number, photo, image: photo, provider: 'bsd' } };
}
function normalizeStatus(raw) {
  const status = require('../utils/matchStatus').canonicalMatchStatus(raw);
  return status === 'UNKNOWN' ? null : status;
}
function normalizeBsdMatch(raw, leagues = []) {
  if (!raw || raw.replaced_by) return null;
  const id = positiveId(raw.id ?? raw.event_id), date = instant(raw.event_date || raw.date), status = normalizeStatus(raw.status);
  const home = normalizeTeam(raw.home_team_obj, { id: raw.home_team_id, name: raw.home_team }), away = normalizeTeam(raw.away_team_obj, { id: raw.away_team_id, name: raw.away_team });
  const competitionId = positiveId(raw.league_id ?? raw.league?.id ?? raw.season?.league?.id);
  if (!id || !date || !status || !home || !away || !competitionId || home.id === away.id) return null;
  if (fixtureSourceConflict(raw)) return null;
  const catalog = leagues.find(value => Number(value.rawId) === competitionId), code = BSD_ID_TO_LEAGUE_CODE[competitionId] || 'BSD:' + competitionId;
  const seasonId = positiveId(raw.season_id ?? raw.season?.id);
  const season = Number(catalog?.currentSeason?.id) === seasonId ? catalog.currentSeason : (Number(raw.season?.id) === seasonId ? raw.season : (seasonId ? { id: seasonId } : null));
  const timing = normalizeMatchTiming({ status: raw.status, period: raw.period, minute: raw.current_minute });
  return annotateFixtureSourceStage({
    id: 'bsd_' + id, rawId: id, slug: 'bsd_' + id, provider: 'bsd', source: 'bsd', utcDate: date, status,
    statusText: ['IN_PLAY', 'PAUSED'].includes(status) ? (raw.current_minute != null ? raw.current_minute + "'" : (raw.period || 'Live')) : status === 'FINISHED' ? 'Finished' : status === 'TIMED' ? 'Upcoming' : status,
    minute: integer(raw.current_minute), period: raw.period || '', ...timing, homeTeam: home, awayTeam: away,
    score: { fullTime: { home: integer(raw.home_score), away: integer(raw.away_score) }, halfTime: timing.halfTimeConfirmed ? { home: integer(raw.home_score_ht), away: integer(raw.away_score_ht) } : null },
    competition: { id: code, code, rawId: competitionId, providerId: String(competitionId), provider: 'bsd', name: raw.league_name || raw.league?.name || catalog?.name || '', country: catalog?.country || raw.league?.country || '', emblem: catalog?.logo || imageUrl('league', competitionId), logo: catalog?.logo || imageUrl('league', competitionId), season },
    seasonId, round: integer(raw.round_number), roundLabel: raw.round_label || raw.round_name || '', group: raw.group_name || '', stage: raw.stage || '', stageName: raw.stage_name || '',
    venueId: positiveId(raw.venue_id), venue: null, refereeId: positiveId(raw.referee_id), homeCoachId: positiveId(raw.home_coach_id), awayCoachId: positiveId(raw.away_coach_id),
    penaltyShootout: raw.penalty_shootout || null, extraTimeScore: raw.extra_time_score || null,
    xg: { liveHome: null, liveAway: null, actualHome: null, actualAway: null, homeEstimated: null, awayEstimated: null, estimated: null, source: 'bsd' },
    lastUpdated: instant(raw.last_updated || raw.updated_at), hasXg: raw.has_xg === true, aiPreview: null,
  });
}
function normalizeBsdStatistics(raw) {
  const stats = raw?.stats || raw;
  if (!stats?.home || !stats?.away) return [];
  const fields = [['Ball Possession','ball_possession','%'], ['Expected Goals (xG)','xg',''], ['Total Shots','total_shots',''], ['Shots on Target','shots_on_target',''], ['Big Chances','big_chances',''], ['Corner Kicks','corner_kicks',''], ['Fouls','fouls',''], ['Passes','passes',''], ['Accurate Passes','accurate_passes',''], ['Tackles Won','tackles_won',''], ['Total Saves','total_saves',''], ['Yellow Cards','yellow_cards',''], ['Red Cards','red_cards','']];
  if (raw?.stats) fields.push(['Pass Accuracy', 'pass_accuracy_pct', '%'], ['Offsides', 'offsides', ''], ['Interceptions', 'interceptions', '']);
  return fields.map(([rawLabel, rawKey, rawSuffix]) => {
    // v2's tackles_won is a success percentage, not the number of tackles.
    const isV2 = Boolean(raw?.stats);
    const label = isV2 && rawKey === 'tackles_won' ? 'Tackles' : rawLabel;
    const key = isV2 && rawKey === 'tackles_won' ? 'total_tackles' : rawKey;
    const suffix = rawSuffix;
    const value = side => key === 'xg' ? numeric(stats[side].xg?.actual ?? stats[side].xg ?? stats[side].expected_goals ?? stats[side + '_xg_live']) : numeric(stats[side][key]?.value ?? stats[side][key]);
    const row = { label, home: value('home'), away: value('away'), suffix };
    if (key === 'xg' && (typeof stats.home.xg === 'object' || typeof stats.away.xg === 'object')) {
      row.homeEstimated = typeof stats.home.xg?.estimated === 'boolean' ? stats.home.xg.estimated : null;
      row.awayEstimated = typeof stats.away.xg?.estimated === 'boolean' ? stats.away.xg.estimated : null;
      row.estimated = row.homeEstimated === true || row.awayEstimated === true;
    }
    return row;
  }).filter(row => row.home !== null || row.away !== null);
}
function normalizeMissing(raw) {
  const player = normalizePlayer(raw);
  return player ? { ...player, availability: { status: raw.status || null, reason: raw.reason || '', confirmedFit: false, expectedReturn: null, source: 'bsd' } } : null;
}
function normalizeBsdLineups(raw, match) {
  if (!raw || (raw.event_id && Number(raw.event_id) !== match?.rawId)) return null;
  const data = raw.lineups || raw, status = ['confirmed', 'predicted'].includes(raw.lineup_status) ? raw.lineup_status : raw.confirmed === true ? 'confirmed' : 'unavailable';
  const side = name => {
    const value = data[name], expected = match?.[name + 'Team']?.rawId;
    if (value?.team_id && expected && Number(value.team_id) !== expected) return { players: [], bench: [], formation: '', confidence: null };
    const mapPlayer = row => {
      if (!row || typeof row !== 'object') return null;
      const player = normalizePlayer(row);
      if (player) return { ...player, grid: row.grid ?? row.player?.grid ?? null };
      const name = typeof (row.name ?? row.player_name) === 'string' ? (row.name ?? row.player_name).trim() : '';
      return name ? { id: null, name, playerName: name, provider: 'bsd', source: 'bsd',
        image: safeImage(row.image) || safeImage(row.photo) || '',
        position: row.position || '', number: integer(row.jersey_number), grid: row.grid ?? null } : null;
    };
    return { players: (Array.isArray(value) ? value : Array.isArray(value?.players) ? value.players : []).map(mapPlayer).filter(Boolean), bench: (Array.isArray(value?.substitutes) ? value.substitutes : []).map(mapPlayer).filter(Boolean), formation: value?.formation || '', confidence: confidencePercent(value?.confidence), confidenceRaw: numeric(value?.confidence) };
  };
  const home = side('home'), away = side('away');
  return validateLineupIntegrity({ matchId: match?.id, homeTeamId: match?.homeTeam?.id, awayTeamId: match?.awayTeam?.id, confirmed: status === 'confirmed', predicted: status === 'predicted', lineupStatus: status, beta: raw.beta === true, home: home.players, away: away.players, homeBench: home.bench, awayBench: away.bench, homeFormation: home.formation, awayFormation: away.formation, homeCoach: null, awayCoach: null, confidence: { home: home.confidence, away: away.confidence }, confidenceRaw: { home: home.confidenceRaw ?? null, away: away.confidenceRaw ?? null }, confidenceScale: 100, updatedAt: instant(raw.updated_at), unavailablePlayers: { home: (raw.unavailable_players?.home || []).map(normalizeMissing).filter(Boolean), away: (raw.unavailable_players?.away || []).map(normalizeMissing).filter(Boolean) }, source: 'bsd' }, { homeTeamId: match?.homeTeam?.id, awayTeamId: match?.awayTeam?.id, provider: 'bsd' });
}
function normalizeIncident(raw) {
  if (!raw || typeof raw.type !== 'string') return null;
  const card = String(raw.card_type || '').toLowerCase(), type = raw.type === 'card' ? (card.includes('red') ? 'red_card' : card === 'yellow' ? 'yellow_card' : 'card') : raw.type;
  return { id: positiveId(raw.id) ? 'bsd_inc_' + raw.id : null, minute: integer(raw.minute), addedTime: integer(raw.added_time), period: raw.period || '', periodSecond: integer(raw.period_second), ...(typeof raw.is_live === 'boolean' ? { isLive: raw.is_live } : {}), type, icon: { goal: '⚽', red_card: '🟥', yellow_card: '🟨', substitution: '🔄' }[type] || '', label: raw.text || raw.type, text: typeof raw.text === 'string' ? raw.text : '', side: raw.is_home === true ? 'home' : raw.is_home === false ? 'away' : null, player: raw.player || raw.player_in || '', playerId: positiveId(raw.player_id || raw.player_in_id) ? 'bsd_p_' + (raw.player_id || raw.player_in_id) : null, assist: raw.assist || null, playerOut: raw.player_out || null, playerOutId: positiveId(raw.player_out_id) ? 'bsd_p_' + raw.player_out_id : null, reason: raw.reason || '', goalType: raw.goal_type || null, rescinded: raw.rescinded === true || raw.is_rescinded === true, score: { home: integer(raw.home_score), away: integer(raw.away_score) }, source: 'bsd' };
}
function normalizeXg(raw) {
  const side = name => raw?.stats?.[name]?.xg;
  const value = name => numeric(side(name)?.actual ?? (typeof side(name) !== 'object' ? side(name) : null) ?? raw?.stats?.[name]?.expected_goals);
  const estimated = name => typeof side(name)?.estimated === 'boolean' ? side(name).estimated : null;
  return { liveHome: value('home'), liveAway: value('away'), actualHome: estimated('home') === false ? value('home') : null, actualAway: estimated('away') === false ? value('away') : null, homeEstimated: estimated('home'), awayEstimated: estimated('away'), estimated: raw?.xg_estimated === true || estimated('home') === true || estimated('away') === true, source: 'bsd' };
}
function normalizeVenue(raw) { return raw ? { id: positiveId(raw.id), name: raw.name || '', city: raw.city || '', country: raw.country || '', capacity: integer(raw.capacity), latitude: numeric(raw.latitude), longitude: numeric(raw.longitude), source: 'bsd' } : null; }
function resource(raw, id, key = 'event_id') { return raw && Number(raw[key]) === id ? raw : null; }
exports.getLeagues = async () => {
  const raw = await fetchList('/api/v2/leagues/', { limit: 200 }, TTL.catalog);
  if (!raw) return null;
  const rows = raw.map(normalizeLeague).filter(Boolean);
  return withCoverage(rows, normalizedCoverage(raw, raw.length - rows.length));
};
exports.getLeagueDetails = async code => {
  const id = leagueId(code); if (!id) return null;
  const raw = await fetchBsd('/api/v2/leagues/' + id + '/', {}, TTL.catalog);
  return positiveId(raw?.id) === id ? normalizeLeague(raw) : null;
};
function normalizeSeason(raw, expectedLeagueId) {
  const id = positiveId(raw?.id); if (!id) return null;
  if ((raw.league_id !== undefined && positiveId(raw.league_id) !== expectedLeagueId) ||
      (raw.league?.id !== undefined && positiveId(raw.league.id) !== expectedLeagueId)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '', rawYear = integer(raw.year);
  const year = rawYear !== null && rawYear >= 1000 && rawYear <= 9999 ? rawYear : null;
  if (!name && year === null) return null;
  return { id, name, year, start_date: calendarDate(raw.start_date), end_date: calendarDate(raw.end_date), is_current: raw.is_current === true };
}
exports.getLeagueSeasons = async (code, options = {}) => {
  const id = leagueId(code); if (!id) return null;
  const raw = await fetchBsd('/api/v2/leagues/' + id + '/seasons/', {}, TTL.catalog, options.timeoutMs);
  if (positiveId(raw?.league_id) !== id || !Array.isArray(raw.seasons)) return null;
  const limit = Math.min(MAX_ROWS, 200), byId = new Map(), ambiguousIds = new Set();
  let invalidRows = 0, duplicateRows = 0;
  for (const value of raw.seasons.slice(0, limit)) {
    const season = normalizeSeason(value, id);
    if (!season) { invalidRows += 1; continue; }
    if (byId.has(season.id) || ambiguousIds.has(season.id)) {
      byId.delete(season.id); ambiguousIds.add(season.id); duplicateRows += 1; continue;
    }
    byId.set(season.id, season);
  }
  const rows = [...byId.values()], reportedTotal = integer(raw.count);
  const possiblyTruncated = raw.seasons.length > limit || (reportedTotal !== null && reportedTotal > raw.seasons.length);
  const complete = !possiblyTruncated && invalidRows === 0 && duplicateRows === 0 && (reportedTotal === null || reportedTotal === rows.length);
  return withCoverage(rows, { available: true, complete, partial: !complete, possiblyTruncated, reportedTotal, invalidRows, duplicateRows });
};
function matchFilters(input = {}) {
  const params = { limit: bounded(input.limit, 200, 1, 200) };
  const from = input.date_from ?? input.dateFrom ?? input.date, to = input.date_to ?? input.dateTo ?? input.date;
  if ((from !== undefined && !calendarDate(from)) || (to !== undefined && !calendarDate(to)) || (from && to && from > to)) return null;
  if (from) params.date_from = from; if (to) params.date_to = to;
  const competition = input.league_id ?? input.leagueId ?? input.competition ?? input.competitionCode, team = input.team_id ?? input.teamId;
  if (competition !== undefined) { params.league_id = leagueId(competition); if (!params.league_id) return null; }
  if (team !== undefined) { params.team_id = scopedId(team, 'bsd_t_') || positiveId(team); if (!params.team_id) return null; }
  if (input.season_id !== undefined || input.seasonId !== undefined) { params.season_id = positiveId(input.season_id ?? input.seasonId); if (!params.season_id) return null; }
  if (input.status) {
    const value = String(input.status).toLowerCase(); params.status = ['upcoming', 'scheduled', 'timed'].includes(value) ? 'notstarted' : value;
    if (!['notstarted', 'finished', 'live', 'postponed', 'cancelled', 'suspended'].includes(params.status)) return null;
  }
  return params;
}
function matchesFilters(match, params) {
  const date = match.utcDate.slice(0, 10);
  if ((params.date_from && date < params.date_from) || (params.date_to && date > params.date_to)) return false;
  if (params.league_id && match.competition.rawId !== params.league_id) return false;
  if (params.season_id && match.seasonId !== params.season_id) return false;
  if (params.team_id && match.homeTeam.rawId !== params.team_id && match.awayTeam.rawId !== params.team_id) return false;
  const allowed = { notstarted: ['TIMED'], finished: ['FINISHED'], live: ['IN_PLAY', 'PAUSED'], postponed: ['POSTPONED'], cancelled: ['CANCELLED'], suspended: ['SUSPENDED'] };
  return !params.status || allowed[params.status].includes(match.status);
}
exports.getMatches = async (input = {}) => {
  const params = matchFilters(input); if (!params) return null;
  const [raw, leagues] = await Promise.all([fetchList('/api/v2/events/', params), exports.getLeagues()]);
  if (!raw) return null;
  const normalized = raw.map(value => normalizeBsdMatch(value, leagues || [])).filter(Boolean);
  const rows = normalized.filter(value => matchesFilters(value, params)).sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  return withCoverage(rows, fixtureCoverage(raw, normalized, normalized.length - rows.length));
};
exports.getLiveMatches = async () => {
  const [raw, leagues] = await Promise.all([fetchList('/api/v2/events/live/', {}, TTL.live, ['events', 'results']), exports.getLeagues()]);
  if (!raw) return null;
  const normalized = raw.map(value => normalizeBsdMatch(value, leagues || [])).filter(Boolean);
  // The feed retains recently finished games; only active canonical states qualify as live.
  return withCoverage(normalized.filter(value => ['IN_PLAY', 'PAUSED'].includes(value.status)), fixtureCoverage(raw, normalized));
};
exports.getMatchSummary = async matchId => {
  const id = scopedId(matchId, 'bsd_'); if (!id) return null;
  const [raw, leagues] = await Promise.all([fetchBsd('/api/v2/events/' + id + '/', {}, TTL.live), exports.getLeagues()]);
  return positiveId(raw?.id) === id ? normalizeBsdMatch(raw, leagues || []) : null;
};
exports.getMatchTimeline = async matchId => {
  const id = scopedId(matchId, 'bsd_'); if (!id) return null;
  if (requiresFixtureSourceReview('bsd', matchId) && !await exports.getMatchSummary(matchId)) return null;
  const raw = resource(await fetchBsd('/api/v2/events/' + id + '/incidents/', {}, TTL.live), id);
  if (!raw || !Array.isArray(raw.incidents)) return null;
  const rows = raw.incidents.map(normalizeIncident).filter(Boolean);
  return withCoverage(rows, { available: true, complete: rows.length === raw.incidents.length, partial: rows.length !== raw.incidents.length, possiblyTruncated: false });
};
function normalizeH2h(raw, match) {
  if (!raw || typeof raw !== 'object') return null;
  const rows = (raw.recent_matches || []).filter(value => [match.homeTeam.rawId, match.awayTeam.rawId].includes(Number(value.home_team_id)) && [match.homeTeam.rawId, match.awayTeam.rawId].includes(Number(value.away_team_id)) && Number(value.home_team_id) !== Number(value.away_team_id)).map(value => {
    const date = instant(value.date), id = positiveId(value.event_id), home = normalizeTeam(null, { id: value.home_team_id, name: value.home }), away = normalizeTeam(null, { id: value.away_team_id, name: value.away });
    return date && id && home && away ? { id: 'bsd_' + id, utcDate: date, status: 'FINISHED', homeTeam: home, awayTeam: away, score: { fullTime: { home: integer(value.home_score), away: integer(value.away_score) } }, source: 'bsd', provider: 'bsd' } : null;
  }).filter(Boolean);
  return { numberOfMatches: integer(raw.total_matches), totalMatches: integer(raw.total_matches), homeWins: integer(raw.home_wins), draws: integer(raw.draws), awayWins: integer(raw.away_wins), homeTeam: { id: match.homeTeam.id, wins: integer(raw.home_wins), draws: integer(raw.draws) }, awayTeam: { id: match.awayTeam.id, wins: integer(raw.away_wins), draws: integer(raw.draws) }, recentMatches: rows, source: 'bsd', orientation: { homeTeamId: match.homeTeam.id, awayTeamId: match.awayTeam.id } };
}
exports.getMatchDetails = async (matchId, options = {}) => {
  if (options.summaryOnly) return exports.getMatchSummary(matchId);
  const id = scopedId(matchId, 'bsd_'); if (!id) return null;
  const [raw, leagues, availableRaw] = await Promise.all([fetchBsd('/api/v2/events/' + id + '/', {}, TTL.live), exports.getLeagues(), fetchBsd('/api/v2/events/' + id + '/availability/', {}, TTL.live)]);
  const match = positiveId(raw?.id) === id ? normalizeBsdMatch(raw, leagues || []) : null; if (!match) return null;
  const available = resource(availableRaw, id), shouldFetch = name => !available || available.available?.[name] !== false;
  const [statsRaw, lineupRaw, incidentsRaw, playersRaw, venueRaw, homeCoach, awayCoach] = await Promise.all([
    shouldFetch('stats') ? fetchBsd('/api/v2/events/' + id + '/stats/', {}, TTL.live) : null,
    shouldFetch('lineups') ? fetchBsd('/api/v2/events/' + id + '/lineups/', {}, TTL.live) : null,
    shouldFetch('incidents') ? fetchBsd('/api/v2/events/' + id + '/incidents/', {}, TTL.live) : null,
    shouldFetch('player_stats') ? fetchBsd('/api/v2/events/' + id + '/player-stats/', {}, TTL.live) : null,
    match.venueId ? fetchBsd('/api/v2/venues/' + match.venueId + '/', {}, TTL.catalog) : null,
    match.homeCoachId ? fetchBsd('/api/v2/managers/' + match.homeCoachId + '/', {}, TTL.catalog) : null,
    match.awayCoachId ? fetchBsd('/api/v2/managers/' + match.awayCoachId + '/', {}, TTL.catalog) : null,
  ]);
  const stats = resource(statsRaw, id), lineup = resource(lineupRaw, id), incidentData = resource(incidentsRaw, id), playerData = resource(playersRaw, id);
  const statistics = normalizeBsdStatistics(stats), lineups = normalizeBsdLineups(lineup, match);
  const incidents = (incidentData?.incidents || []).map(normalizeIncident).filter(Boolean);
  const byPlayer = new Map((lineups ? [...lineups.home, ...lineups.away, ...lineups.homeBench, ...lineups.awayBench] : []).map(player => [player.rawId, player]));
  const playerStatistics = (playerData?.player_stats || []).filter(row => positiveId(row.player_id) && Number(row.event_id) === id && [match.homeTeam.rawId, match.awayTeam.rawId].includes(Number(row.team_id))).map(row => ({ ...row, id: 'bsd_p_' + row.player_id, playerId: 'bsd_p_' + row.player_id, teamId: 'bsd_t_' + row.team_id, eventId: match.id, name: byPlayer.get(Number(row.player_id))?.name || '', image: imageUrl('player', row.player_id), provider: 'bsd', source: 'bsd' }));
  const venue = match.venueId && positiveId(venueRaw?.id) === match.venueId ? normalizeVenue(venueRaw) : null;
  Object.assign(match, { venue, providerStatistics: statistics, lineups, timeline: incidents, detailsAvailable: true, xg: normalizeXg(stats) });
  const coverage = { source: 'bsd', available: true, complete: Boolean(available) && ['stats', 'lineups', 'incidents', 'player_stats'].every(name => available.available?.[name] === false || ({ stats, lineups: lineup, incidents: incidentData, player_stats: playerData })[name]), fields: { stats: Boolean(stats), lineups: Boolean(lineup), incidents: Boolean(incidentData), playerStatistics: Boolean(playerData) } };
  coverage.lineups = { available: Boolean(lineups), complete: lineups?.integrity?.complete === true, partial: lineups?.integrity?.complete !== true, integrity: lineups?.integrity || null };
  if (lineups?.integrity?.partial) coverage.complete = false;
  coverage.partial = !coverage.complete;
  return { matchInfo: match, statistics, lineups, incidents, timeline: incidents, playerStatistics, h2h: normalizeH2h(raw.head_to_head, match), availability: available ? { ...available, source: 'bsd' } : null, coverage, liveStats: stats?.stats || null, shotmap: stats?.shotmap || [], momentum: stats?.momentum || [], averagePositions: stats?.average_positions || null, xgEstimated: stats?.xg_estimated === true, aiPreview: null, venue, homeCoach: match.homeCoachId && positiveId(homeCoach?.id) === match.homeCoachId ? { ...homeCoach, source: 'bsd' } : null, awayCoach: match.awayCoachId && positiveId(awayCoach?.id) === match.awayCoachId ? { ...awayCoach, source: 'bsd' } : null, source: 'bsd', provider: 'bsd' };
};
exports.getStandings = async (code, seasonId) => {
  const id = leagueId(code); if (!id) return null;
  const league = await exports.getLeagueDetails(id), selectedSeason = positiveId(seasonId ?? league?.currentSeason?.id); if (!selectedSeason) return null;
  const raw = await fetchBsd('/api/v2/leagues/' + id + '/standings/', { season_id: selectedSeason }, TTL.matches);
  if (!raw || Number(raw.league_id) !== id || Number(raw.season?.id) !== selectedSeason) return null;
  let list = Array.isArray(raw.standings) ? raw.standings : null;
  if (raw.grouped && Array.isArray(raw.groups)) list = raw.groups.flatMap(group => (group.standings || []).map(row => ({ ...row, group: group.name || group.group || '' })));
  if (!list) return null;
  const rows = list.map(row => {
    const team = normalizeTeam(null, { id: row.team_id, name: row.team_name });
    return team ? { group: row.group || '', position: integer(row.position), team, playedGames: integer(row.played), won: integer(row.won), draw: integer(row.drawn), lost: integer(row.lost), points: integer(row.pts), goalsFor: integer(row.gf), goalsAgainst: integer(row.ga), goalDifference: numeric(row.gd), form: row.form || '', promotion: row.zone?.label || '', promoColor: '', live: row.live === true, season: raw.season, source: 'bsd', provider: 'bsd' } : null;
  }).filter(Boolean);
  return withCoverage(rows, { available: true, complete: rows.length === list.length, partial: rows.length !== list.length, possiblyTruncated: false, season: raw.season, invalidRows: list.length - rows.length });
};
exports.getTopScorers = async (code, limit = 20, stat = 'goals', seasonId) => {
  const id = leagueId(code); if (!id) return null;
  const league = await exports.getLeagueDetails(id), selectedSeason = positiveId(seasonId ?? league?.currentSeason?.id); if (!selectedSeason) return null;
  const mode = stat === 'assists' ? 'assists' : 'scorers';
  const raw = await fetchBsd('/api/v2/leagues/' + id + '/top/' + mode + '/', { season_id: selectedSeason, limit: bounded(limit, 20, 1, 50) }, TTL.details);
  if (!raw || Number(raw.league_id) !== id || Number(raw.season?.id) !== selectedSeason || !Array.isArray(raw.leaders)) return null;
  const rows = raw.leaders.map(row => {
    const player = normalizePlayer(row), team = normalizeTeam(null, { id: row.team_id, name: row.team_name });
    return player && team ? { rank: integer(row.rank), player, team, goals: mode === 'scorers' ? integer(row.value) : integer(row.goals), assists: mode === 'assists' ? integer(row.value) : integer(row.assists), playedMatches: integer(row.matches), minutesPlayed: integer(row.minutes), rating: null, season: raw.season, source: 'bsd' } : null;
  }).filter(Boolean);
  return withCoverage(rows, { available: true, complete: rows.length === raw.leaders.length, partial: rows.length !== raw.leaders.length, possiblyTruncated: false, season: raw.season });
};
exports.getTeams = async (input = {}) => {
  const params = { limit: bounded(input.limit, 200, 1, 200) }, competition = input.competition ?? input.league_id ?? input.leagueId;
  if (competition !== undefined) { params.league_id = leagueId(competition); if (!params.league_id) return null; }
  const season = input.season_id ?? input.seasonId;
  if (season !== undefined) { params.season_id = positiveId(season); if (!params.season_id) return null; }
  if (input.name || input.search) params.name = String(input.name || input.search).trim().slice(0, 100);
  if (input.country_code) params.country_code = String(input.country_code).slice(0, 2);
  if (typeof input.is_women === 'boolean') params.is_women = input.is_women;
  if (typeof input.in_competition === 'boolean') params.in_competition = input.in_competition;
  const raw = await fetchList('/api/v2/teams/', params, TTL.catalog); if (!raw) return null;
  const rows = raw.map(normalizeTeam).filter(Boolean);
  return withCoverage(rows, normalizedCoverage(raw, raw.length - rows.length));
};
exports.getTeamSquad = async teamId => {
  const id = scopedId(teamId, 'bsd_t_'); if (!id) return null;
  const raw = await fetchBsd('/api/v2/teams/' + id + '/squad/', {}, TTL.details);
  if (!raw || Number(raw.team_id) !== id || !Array.isArray(raw.players)) return null;
  const rows = raw.players.map(normalizePlayer).filter(Boolean), unique = [...new Map(rows.map(row => [row.id, row])).values()];
  const reportedTotal = integer(raw.count), empty = raw.players.length === 0;
  const consistent = unique.length === raw.players.length && (reportedTotal === null || unique.length === reportedTotal);
  // The provider can return a zero-count roster for teams with confirmed match
  // lineups. An empty feed proves no roster coverage, not that the team has none.
  const complete = !empty && consistent;
  return withCoverage(unique, { available: true, complete, partial: !complete, possiblyTruncated: !consistent, invalidRows: raw.players.length - rows.length, reportedTotal, ...(empty ? { reason: 'empty_squad' } : {}) });
};
exports.getTeamFixtures = async (teamId, options = {}) => {
  const id = scopedId(teamId, 'bsd_t_'); if (!id) return null;
  const today = new Date(), from = options.dateFrom ?? options.date_from ?? new Date(today.getTime() - 60 * 86400000).toISOString().slice(0, 10), to = options.dateTo ?? options.date_to ?? new Date(today.getTime() + 120 * 86400000).toISOString().slice(0, 10);
  // The audited /teams/{id}/fixtures/ endpoint incorrectly returned zero fixtures.
  return exports.getMatches({ date_from: from, date_to: to, team_id: id, ...(options.competition ? { competition: options.competition } : {}), ...(options.status ? { status: options.status } : {}) });
};
exports.getTeamMatchLineups = async matchId => {
  const id = scopedId(matchId, 'bsd_'); if (!id) return null;
  // Roster recovery needs only the exact match and confirmed lineup.
  const [matchInfo, raw] = await Promise.all([
    exports.getMatchSummary(matchId),
    fetchBsd('/api/v2/events/' + id + '/lineups/', {}, TTL.details, 3500),
  ]);
  const checked = resource(raw, id);
  return matchInfo && checked ? { matchInfo, lineups: normalizeBsdLineups(checked, matchInfo),
    coverage: { fields: { lineups: true } } } : null;
};
async function teamNumberScopes(teamId, fixtures, options) {
  const candidates = new Map();
  for (const fixture of fixtures || []) {
    const competition = fixture.competition, season = competition?.season;
    // The provider also manufactures ranking/points tables for friendlies;
    // these are not competitive league standings. Show dated match numbers.
    if (/friendl|ودية|وديّة/i.test(String(competition?.name || ''))) continue;
    if (season?.is_current !== true || !positiveId(fixture.seasonId) ||
        Number(season.id) !== fixture.seasonId ||
        (options.competition && competition.rawId !== leagueId(options.competition))) continue;
    const key = competition.id + ':' + fixture.seasonId;
    if (!candidates.has(key)) candidates.set(key, fixture);
  }
  const chosen = [...candidates.values()].sort((a, b) =>
    Number(PRIMARY_LEAGUE_IDS.has(b.competition.rawId)) - Number(PRIMARY_LEAGUE_IDS.has(a.competition.rawId)) ||
    b.utcDate.localeCompare(a.utcDate)).slice(0, 3);
  const scopes = (await Promise.all(chosen.map(async fixture => {
    const standings = await exports.getStandings(fixture.competition.id, fixture.seasonId);
    return buildBsdTeamStandingNumbers(teamId, standings, { competitionId: fixture.competition.id,
      competition: fixture.competition.name, seasonId: fixture.seasonId, season: fixture.competition.season.name });
  }))).filter(Boolean);
  const sample = buildBsdTeamFixtureNumbers(teamId, fixtures);
  if (sample) scopes.push(sample);
  return scopes;
}
exports.getTeamDetails = async (teamId, options = {}) => {
  const id = scopedId(teamId, 'bsd_t_'); if (!id) return null;
  const raw = await fetchBsd('/api/v2/teams/' + id + '/', {}, TTL.catalog), info = positiveId(raw?.id) === id ? normalizeTeam(raw) : null;
  if (!info) return null;
  const [squad, fixtures, venueRaw] = await Promise.all([exports.getTeamSquad(teamId), exports.getTeamFixtures(teamId, options), info.venueId ? fetchBsd('/api/v2/venues/' + info.venueId + '/', {}, TTL.catalog) : null]);
  const [recovered, statsScopes] = await Promise.all([
    squad?.length ? null : recoverBsdMatchSquad(teamId, fixtures, exports.getTeamMatchLineups),
    teamNumberScopes(teamId, fixtures, options),
  ]);
  const selection = recovered?.squad || squad || [], squadCoverage = recovered?.coverage || squad?.coverage || unavailableCoverage();
  const numbers = statsScopes[0];
  const venue = info.venueId && positiveId(venueRaw?.id) === info.venueId ? normalizeVenue(venueRaw) : null, now = Date.now();
  const recent = (fixtures || []).filter(row => row.status === 'FINISHED').sort((a, b) => b.utcDate.localeCompare(a.utcDate));
  const upcoming = (fixtures || []).filter(row => row.status === 'TIMED' && Date.parse(row.utcDate) >= now).sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  const live = (fixtures || []).filter(row => ['IN_PLAY', 'PAUSED'].includes(row.status));
  return { info: { ...info, venue: venue?.name || '', venueCapacity: venue?.capacity ?? null },
    squad: selection, players: selection, squadContext: recovered?.context || null,
    stats: numbers?.stats || {}, standing: numbers?.standing || null,
    statsContext: numbers?.context || null, statsCoverage: numbers?.coverage || unavailableCoverage(), statsScopes,
    matches: { recent, upcoming, live }, venue,
    coverage: { source: 'bsd', available: true, complete: Boolean(squadCoverage.complete && fixtures?.coverage.complete && numbers?.coverage.complete),
      partial: !squadCoverage.complete || !fixtures?.coverage.complete || !numbers?.coverage.complete,
      squad: squadCoverage, stats: numbers?.coverage || unavailableCoverage(), fixtures: fixtures?.coverage || unavailableCoverage() }, source: 'bsd' };
};
exports.searchPlayers = async (query, limit = 20) => {
  const { searchQuery, playerSearchTerms, sortByRelevance } = require('../utils/searchQueries');
  const name = searchQuery(query).term.slice(0, 100), cap = bounded(limit, 20, 1, 50);
  if (name.length < 2) return withCoverage([], { available: true, complete: true, partial: false });
  const terms = playerSearchTerms(name);
  const batches = await Promise.all(terms.map(term => fetchList('/api/v2/players/',
    { name: term, limit: 50 }, TTL.catalog, ['results'], { maxRows: 100, maxPages: 5 })));
  if (!batches.some(Boolean)) return null;
  const rows = [...new Map(batches.flatMap(raw => (raw || []).map(normalizePlayer).filter(Boolean))
    .map(row => [row.id, row])).values()];
  const queries = batches.map((raw, index) => ({ term: terms[index],
    ...(raw ? normalizedCoverage(raw, raw.filter(row => !normalizePlayer(row)).length) : unavailableCoverage()) }));
  const complete = queries.every(report => report.complete === true);
  return withCoverage(sortByRelevance(rows, name, 'players').slice(0, cap), {
    available: true, complete: complete && rows.length <= cap, partial: !complete || rows.length > cap,
    possiblyTruncated: queries.some(report => report.possiblyTruncated),
    resultLimit: rows.length > cap, queries
  });
};
exports.searchEntities = async (query, limit = 15) => {
  const { searchQuery, normalizeTerm, sortByRelevance } = require('../utils/searchQueries');
  const name = searchQuery(query).term.slice(0, 100), cap = bounded(limit, 15, 1, 50);
  if (name.length < 2) return { teams: [], players: [], competitions: [], coverage: { available: true, complete: true, partial: false }, source: 'bsd' };
  const searchTeams = async term => {
    const raw = await fetchList('/api/v2/teams/', { name: term, limit: 50 }, TTL.catalog,
      ['results'], { maxRows: 100, maxPages: 5 });
    if (!raw) return null;
    const rows = raw.map(value => {
      const team = normalizeTeam(value);
      if (!team) return null;
      return { ...team, ...(typeof value.is_women === 'boolean' ? { isWomen: value.is_women } : {}),
        gender: typeof value.gender === 'string' ? value.gender : '',
        league: typeof value.competition === 'string' ? value.competition : value.competition?.name || value.league?.name || '',
        leagueCode: value.competition?.code || value.league?.code || '' };
    }).filter(Boolean);
    return withCoverage(rows, normalizedCoverage(raw, raw.length - rows.length));
  };
  const variant = /^al[ -]+\S/i.test(name) ? name.replace(/^al[ -]+/i, /^al-/i.test(name) ? 'Al ' : 'Al-') : null;
  const [teams, alternative, players, leagues] = await Promise.all([
    searchTeams(name), variant ? searchTeams(variant) : null,
    exports.searchPlayers(name, cap), exports.getLeagues()
  ]);
  const combined = sortByRelevance([...new Map([...(teams || []), ...(alternative || [])]
    .map(row => [row.id, row])).values()], name, 'teams');
  const namesakes = combined.filter(row => combined.some(other => other.id !== row.id &&
    normalizeTerm(other.name) === normalizeTerm(row.name) && other.country === row.country)).slice(0, 4);
  await Promise.all(namesakes.map(async team => {
    // List rows omit gender and competition. Resolve ambiguous rows only through
    // exact same-provider fixture IDs, never through a name or guessed club map.
    const fixtures = await exports.getTeamFixtures(team.id, {
      dateFrom: new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10),
      dateTo: new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10)
    });
    const eligible = (fixtures || []).filter(row => row.competition?.season?.is_current === true &&
      (PRIMARY_LEAGUE_IDS.has(row.competition.rawId) || leagues?.some(league =>
        league.rawId === row.competition.rawId && league.isWomen === true)));
    const contexts = new Map(eligible.map(row => [row.competition.code, row.competition]));
    if (contexts.size === 1) {
      const competition = [...contexts.values()][0];
      team.league = competition.name; team.leagueCode = competition.code;
      if (typeof competition.isWomen === 'boolean') team.isWomen = competition.isWomen;
    }
  }));
  const complete = Boolean(teams?.coverage.complete && (!variant || alternative?.coverage.complete) && players?.coverage.complete && leagues?.coverage.complete);
  const competitions = sortByRelevance((leagues || []).filter(row => normalizeTerm(row.name).includes(normalizeTerm(name))), name, 'leagues');
  const resultLimit = combined.length > cap || competitions.length > cap || players?.coverage.resultLimit === true;
  return { teams: combined.slice(0, cap), players: players || [], competitions: competitions.slice(0, cap), coverage: { source: 'bsd', available: Boolean(teams || alternative || players || leagues), complete: complete && !resultLimit, partial: !complete || resultLimit, resultLimit }, source: 'bsd' };
};
function matchRating(value) { const n = numeric(value); return n !== null && n >= 0 && n <= 10 ? n : null; }
function normalizeCareer(raw, leagues) {
  return (Array.isArray(raw?.seasons) ? raw.seasons : []).filter(row => positiveId(row?.team_id) && positiveId(row?.league_id) && positiveId(row?.season_id)).map(row => {
    const league = leagues.find(value => value.rawId === Number(row.league_id));
    const seasonInfo = Number(league?.currentSeason?.id) === Number(row.season_id) ? league.currentSeason : null;
    return { teamId: 'bsd_t_' + row.team_id, team: '', leagueId: row.league_id, competitionId: BSD_ID_TO_LEAGUE_CODE[row.league_id] || 'BSD:' + row.league_id, competition: league?.name || '', league: league?.name || '', seasonId: row.season_id, season: seasonInfo?.name || '', seasonInfo, matches: integer(row.matches), minutes: integer(row.minutes), goals: integer(row.goals), assists: integer(row.assists), rating: matchRating(row.avg_rating), source: 'bsd' };
  });
}
async function enrichCareerSeasonLabels(career) {
  // The endpoint is scoped to a league. Never infer a year from the provider ID.
  // Bound unusual careers, total wait and parallel requests. Each batch fully
  // settles before continuing, so no enrichment can mutate a returned profile.
  const leagueIds = [...new Set(career.filter(row => !row.seasonInfo).map(row => Number(row.leagueId)))].slice(0, 20);
  const deadline = Date.now() + 8000;
  for (let offset = 0; offset < leagueIds.length; offset += 3) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeoutMs = Math.min(4000, remaining);
    await Promise.all(leagueIds.slice(offset, offset + 3).map(async id => {
      const seasons = await exports.getLeagueSeasons(id, { timeoutMs });
      if (!seasons) return;
      const byId = new Map(seasons.map(season => [season.id, season]));
      for (const row of career) {
        if (Number(row.leagueId) !== id || row.seasonInfo) continue;
        const season = byId.get(Number(row.seasonId));
        if (season) { row.seasonInfo = season; row.season = season.name || String(season.year); }
      }
    }));
  }
}
function normalizeTransfer(raw) {
  return { id: positiveId(raw.id), date: calendarDate(raw.transfer_date), fromTeamId: positiveId(raw.from_team_id) ? 'bsd_t_' + raw.from_team_id : null, fromTeam: raw.from_team_name || '', toTeamId: positiveId(raw.to_team_id) ? 'bsd_t_' + raw.to_team_id : null, toTeam: raw.to_team_name || '', fee: numeric(raw.fee_eur), feeDescription: raw.fee_description || '', type: raw.transfer_type_name || '', rawType: raw.transfer_type ?? null, source: 'bsd' };
}
function enrichCareerTeamLabels(career, currentTeam, nationalTeam, transfers) {
  // Reuse scoped records already fetched for this player. Matching a name or
  // copying the current club to every career row would change its identity.
  const detailed = new Map(), transferNames = new Map(), conflicts = new Set();
  const label = value => typeof value === 'string' ? value.trim() : '';
  const canonical = value => value.replace(/\s+/g, ' ').toLowerCase();
  for (const team of [currentTeam, nationalTeam]) {
    const id = scopedId(team?.id, 'bsd_t_'), name = label(team?.name);
    if (!id || !name) continue;
    if (detailed.has(id) && canonical(detailed.get(id)) !== canonical(name)) {
      conflicts.add(id); detailed.delete(id);
    } else if (!conflicts.has(id)) detailed.set(id, name);
  }
  for (const transfer of transfers) {
    for (const [key, nameKey] of [['fromTeamId', 'fromTeam'], ['toTeamId', 'toTeam']]) {
      const id = scopedId(transfer[key], 'bsd_t_'), name = label(transfer[nameKey]);
      if (!id || !name) continue;
      if (!transferNames.has(id)) transferNames.set(id, new Map());
      transferNames.get(id).set(canonical(name), name);
    }
  }
  for (const row of career) {
    if (label(row.team)) continue;
    const id = scopedId(row.teamId, 'bsd_t_');
    if (!id || conflicts.has(id)) continue;
    const names = transferNames.get(id);
    // Detail records outrank transfer aliases. Conflicting transfer-only names
    // stay unavailable until an authoritative team detail is supplied.
    const name = detailed.get(id) || (names?.size === 1 ? [...names.values()][0] : '');
    if (name) row.team = name;
  }
}
async function recoverCareerTeamLabels(career) {
  // Historical clubs may be absent from both the current profile and transfers.
  // Resolve only exact BSD identities, once per missing team, with a small budget.
  const ids = [...new Set(career.filter(row => !String(row.team || '').trim())
    .map(row => scopedId(row.teamId, 'bsd_t_')).filter(Boolean))].slice(0, 12);
  const deadline = Date.now() + 4000;
  for (let offset = 0; offset < ids.length; offset += 3) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Promise.all(ids.slice(offset, offset + 3).map(async id => {
      const raw = await fetchBsd('/api/v2/teams/' + id + '/', {}, TTL.catalog, Math.min(2000, remaining));
      if (positiveId(raw?.id) !== id || typeof raw.name !== 'string') return;
      const name = raw.name.trim();
      // A matching numeric identity cannot make an explicitly foreign-sport
      // label valid for a football career (the source has supplied such rows).
      if (!name || name.length > 180 || /\b(?:cricket|basketball|volleyball|ice hockey|baseball)\b/i.test(name)) return;
      for (const row of career) {
        if (scopedId(row.teamId, 'bsd_t_') === id && !String(row.team || '').trim()) row.team = name;
      }
    }));
  }
}
const EXTRA_PLAYER_FIELDS = { shots: 'total_shots', shotsOnTarget: 'shots_on_target', passes: 'total_pass', tackles: 'total_tackle', tacklesWon: 'won_tackle', interceptions: 'interception', dribbles: 'won_contest', dribblesAttempted: 'total_contest', keyPasses: 'key_pass', yellowCards: 'yellow_card', redCards: 'red_card', saves: 'saves', goalsConceded: 'goals_conceded', touches: 'touches', duelsWon: 'duel_won', duelsLost: 'duel_lost', aerialDuelsWon: 'aerial_won', clearances: 'total_clearance', ballRecoveries: 'ball_recovery', bigChancesCreated: 'big_chance_created', bigChancesMissed: 'big_chance_missed', foulsCommitted: 'fouls', foulsWon: 'was_fouled', offsides: 'total_offside' };
exports.getPlayerDetails = async (playerId, options = {}) => {
  const id = scopedId(playerId, 'bsd_p_'); if (!id) return null;
  const [raw, careerRaw, transfersRaw, leagues] = await Promise.all([fetchBsd('/api/v2/players/' + id + '/', {}, TTL.details), fetchBsd('/api/v2/players/' + id + '/career/', {}, TTL.details), fetchBsd('/api/v2/players/' + id + '/transfers/', {}, TTL.catalog), exports.getLeagues()]);
  const info = positiveId(raw?.id) === id ? normalizePlayer(raw) : null; if (!info) return null;
  const clubId = positiveId(raw.current_team_id ?? raw.current_team?.id), currentTeam = raw.current_team && positiveId(raw.current_team.id) === clubId ? normalizeTeam(raw.current_team) : null;
  const nationalId = positiveId(raw.national_team_id ?? raw.national_team?.id);
  const nationalTeam = raw.national_team && positiveId(raw.national_team.id) === nationalId ? normalizeTeam(raw.national_team) : null;
  const transferResource = resource(transfersRaw, id, 'player_id'), careerResource = resource(careerRaw, id, 'player_id');
  const transferRows = Array.isArray(transferResource?.transfers) ? transferResource.transfers : null;
  const transfers = (transferRows || []).filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(normalizeTransfer);
  const career = normalizeCareer(careerResource, leagues || []);
  enrichCareerTeamLabels(career, currentTeam, nationalTeam, transfers);
  // Default selection continues to use the catalog's authoritative current
  // edition; historical metadata may independently mark an old season current.
  let selection = selectBsdPlayerScope(career, options, clubId, leagueId, PRIMARY_LEAGUE_IDS);
  const seasonEnrichment = enrichCareerSeasonLabels(career);
  const teamEnrichment = recoverCareerTeamLabels(career);
  if (options.seasonId !== undefined || options.season !== undefined) {
    await seasonEnrichment;
    selection = selectBsdPlayerScope(career, options, clubId, leagueId, PRIMARY_LEAGUE_IDS);
  }
  const selected = selection.row, selectedTeamId = scopedId(selected?.teamId, 'bsd_t_');
  let extra = Object.fromEntries([...Object.keys(EXTRA_PLAYER_FIELDS), 'passesAccuracy'].map(field => [field, null]));
  let statsCoverage = { ...unavailableCoverage(), reason: selection.reason };
  if (selected && selectedTeamId) {
    const [stats, fixtures] = await Promise.all([
      fetchList('/api/v2/players/' + id + '/stats/', { team_id: selectedTeamId, season_id: selected.seasonId, limit: 200 }, TTL.details, ['results'], { key: row => positiveId(row?.id) }),
      exports.getMatches({ team_id: selectedTeamId, league_id: selected.leagueId, season_id: selected.seasonId, date_from: selected.seasonInfo?.start_date, date_to: selected.seasonInfo?.end_date }),
    ]);
    const aggregated = aggregateBsdPlayerStatistics(stats, fixtures, selected, id, EXTRA_PLAYER_FIELDS);
    extra = aggregated.metrics; statsCoverage = aggregated.coverage;
    Object.assign(selected, extra, { statsCoverage });
  }
  await Promise.all([seasonEnrichment, teamEnrichment]);
  for (const row of career) Object.assign(row, normalizeCareerCompetitionLabels(row));
  const honours = normalizePlayerHonours(playerHonourInput(raw.honours, raw.trophies), { playerId: info.id, rawPlayerId: id, provider: 'bsd', complete: raw.honours_complete === true });
  const bioFields = { dateOfBirth: Boolean(info.dateOfBirth), nationality: Boolean(info.nationality), position: Boolean(info.position), height: info.height !== null, weight: info.weight !== null, preferredFoot: Boolean(info.preferredFoot), currentTeam: Boolean(currentTeam) };
  const profileCoverage = { source: 'bsd', available: true, fields: bioFields, missingFields: Object.keys(bioFields).filter(field => !bioFields[field]) };
  profileCoverage.complete = profileCoverage.missingFields.length === 0; profileCoverage.partial = !profileCoverage.complete;
  const careerRows = Array.isArray(careerResource?.seasons) ? careerResource.seasons : null;
  const careerCoverage = { source: 'bsd', available: Boolean(careerRows), complete: Boolean(careerRows && careerRows.length === career.length && career.every(row => row.seasonInfo && row.team)), returned: career.length, reportedTotal: careerRows?.length ?? null,
    reason: !careerRows ? (careerRaw && !careerResource ? 'provider_identity_mismatch' : 'career_not_supplied') : careerRows.length !== career.length ? 'invalid_career_rows' : career.some(row => !row.seasonInfo || !row.team) ? 'career_context_incomplete' : null };
  careerCoverage.partial = !careerCoverage.complete;
  const transfersCoverage = { source: 'bsd', available: Boolean(transferRows), complete: Boolean(transferRows && transferRows.length === transfers.length), returned: transfers.length,
    reason: !transferRows ? (transfersRaw && !transferResource ? 'provider_identity_mismatch' : 'transfers_not_supplied') : transferRows.length !== transfers.length ? 'invalid_transfer_rows' : null };
  transfersCoverage.partial = !transfersCoverage.complete;
  const coverage = { source: 'bsd', available: true, profile: profileCoverage, career: careerCoverage, transfers: transfersCoverage, stats: statsCoverage, honours: honours.honoursCoverage };
  coverage.complete = [profileCoverage, careerCoverage, transfersCoverage, statsCoverage, honours.honoursCoverage].every(section => section.complete === true); coverage.partial = !coverage.complete;
  const statsContext = selected ? { teamId: selected.teamId, team: selected.team || '', competitionId: selected.competitionId, competition: selected.competition, seasonId: selected.seasonId, season: selected.season, scope: 'team_competition_season', source: 'bsd' } : null;
  const attributes = raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)
    ? Object.fromEntries(Object.entries(raw.attributes).filter(([key, value]) => key.length <= 100 && numeric(value) !== null).map(([key, value]) => [key, numeric(value)])) : {};
  return { ...info, ...honours, currentTeam, teamId: currentTeam?.id || (clubId ? 'bsd_t_' + clubId : null), team: currentTeam?.name || '', teamBadge: currentTeam?.crest || imageUrl('team', clubId), nationalTeam,
    contractUntil: calendarDate(raw.contract_until), marketValue: numeric(raw.market_value_eur), abilityRating: numeric(raw.rating), wageAnnual: numeric(raw.wage_eur_annual),
    attributes, strengths: Array.isArray(raw.strengths) ? raw.strengths.filter(value => typeof value === 'string') : [], weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses.filter(value => typeof value === 'string') : [],
    potential: typeof raw.potential === 'string' ? raw.potential : '', injuryRisk: typeof raw.injury_risk === 'string' ? raw.injury_risk : '',
    competition: selected?.competition || '', matches: selected?.matches ?? null, goals: selected?.goals ?? null, assists: selected?.assists ?? null, minutes: selected?.minutes ?? null, rating: selected?.rating ?? null, ...extra,
    career, careerBySeason: career, careerCoverage, transfers, transfersCoverage, statsContext, statsCoverage, coverage,
    seasonStats: selected ? { ...selected, ...statsContext, ...extra } : {}, source: 'bsd' };
};
exports.getPlayer = exports.getPlayerDetails;
function normalizePrediction(raw) {
  if (!raw || !positiveId(raw.event?.id)) return null;
  if (fixtureSourceConflict(raw.event)) return null;
  if (requiresFixtureSourceReview('bsd', 'bsd_' + positiveId(raw.event.id)) && !normalizeBsdMatch(raw.event)) return null;
  const m = raw.markets || {}, percent = value => { const n = numeric(value); return n !== null && n >= 0 && n <= 100 ? n : null; };
  return { id: positiveId(raw.id), eventId: positiveId(raw.event.id), match: normalizeBsdMatch(raw.event), probHomeWin: percent(m.match_result?.prob_home ?? raw.prob_home_win), probDraw: percent(m.match_result?.prob_draw ?? raw.prob_draw), probAwayWin: percent(m.match_result?.prob_away ?? raw.prob_away_win), predictedResult: m.match_result?.predicted || raw.predicted_result || '', mostLikelyScore: m.score?.most_likely || raw.most_likely_score || '', expectedHomeGoals: numeric(m.expected_goals?.home ?? raw.expected_home_goals), expectedAwayGoals: numeric(m.expected_goals?.away ?? raw.expected_away_goals), probOver15: percent(m.over_under?.prob_over_15 ?? raw.prob_over_15), probOver25: percent(m.over_under?.prob_over_25 ?? raw.prob_over_25), probOver35: percent(m.over_under?.prob_over_35 ?? raw.prob_over_35), probBttsYes: percent(m.btts?.prob_yes ?? raw.prob_btts_yes), confidence: confidencePercent(raw.model?.confidence ?? raw.confidence), confidenceRaw: numeric(raw.model?.confidence ?? raw.confidence), confidenceScale: 100, modelVersion: raw.model?.version || raw.model_version || '', probabilityScale: 100, prediction: true, aiPreview: raw.ai_preview?.text || null, source: 'bsd_catboost_ml' };
}
exports.getPredictions = async (input = {}) => {
  const params = matchFilters(input); if (!params) return null;
  const raw = await fetchList('/api/v2/predictions/', params, TTL.predictions); if (!raw) return null;
  const rows = raw.map(normalizePrediction).filter(Boolean);
  const events = raw.map(row => row?.event);
  Object.defineProperty(events, 'coverage', { value: raw.coverage });
  return withCoverage(rows, fixtureCoverage(events, rows));
};
exports.getPredictionForMatch = async matchId => {
  const id = scopedId(matchId, 'bsd_'); if (!id) return null;
  if (requiresFixtureSourceReview('bsd', matchId) && !await exports.getMatchSummary(matchId)) return null;
  const raw = await fetchBsd('/api/v2/events/' + id + '/prediction/', {}, TTL.predictions), value = normalizePrediction(raw);
  return value?.eventId === id ? value : null;
};
exports.LEAGUE_CODE_TO_BSD_ID = LEAGUE_CODE_TO_BSD_ID;
exports.BSD_ID_TO_LEAGUE_CODE = BSD_ID_TO_LEAGUE_CODE;
exports.isConfigured = isConfigured;
exports.normalizeMatch = normalizeBsdMatch;
exports.normalizeStatistics = normalizeBsdStatistics;
exports.normalizeLineups = normalizeBsdLineups;
exports.normalizeStatus = normalizeStatus;
