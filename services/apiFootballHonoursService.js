'use strict';

const axios = require('axios');
const { createHash } = require('node:crypto');
const { getCached, setCache } = require('./cacheService');
const { normalizePlayerHonours } = require('../utils/playerHonours');

// Primary reference: https://api-sports.io/documentation/football/v3
// Profiles use player/search/page; search is a lastname of at least four characters.
// Single-player trophies are flat league/country/season/place rows, without player IDs.
const SOURCE = 'api-football';
const API_KEY = String(process.env.API_FOOTBALL_KEY || '').trim();
const DAY = 24 * 60 * 60 * 1000, NEGATIVE_TTL = 5 * 60 * 1000;
const isConfigured = () => Boolean(API_KEY) && !/^(replace(?:[-_].*)?|your(?:[-_].*)?|changeme)$/i.test(API_KEY);
const client = axios.create({
  baseURL: 'https://v3.football.api-sports.io', timeout: 3500, maxRedirects: 0,
  maxContentLength: 1024 * 1024,
  headers: { 'x-apisports-key': API_KEY, Accept: 'application/json', 'User-Agent': 'KickSphere/2.0' },
});
const pending = new Map();
let blockedUntil = 0, blockedReason = 'provider_rate_limited';
const text = value => typeof value === 'string' ? value.trim() : '';
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const normalized = value => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[.'’]/g, '').replace(/[-\s]+/g, ' ').trim();
const integer = value => (typeof value === 'number' || typeof value === 'string') &&
  /^(0|[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value))) return null;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? value : null;
}
function unavailable(reason, extra = {}) {
  return { honours: [], honoursCoverage: { source: SOURCE, available: false, complete: false,
    partial: true, returned: 0, rejected: 0, identityVerified: false, sourcePlayerId: null,
    responseComplete: false, reason, ...extra } };
}
// Exact provider names observed in the 2026-10-08 live profile audit. These aliases
// apply only to the same canonical BSD identity; source IDs still come from search.
const VERIFIED_NAME_ALIASES = [
  // https://www.fcbarcelona.com/en/news/886918/the-14year-anniversary-of-leo-messis-official-bara-debut
  { targetId: 'bsd_p_9063', name: 'Lionel Messi', dob: '1987-06-24', nationality: 'Argentina',
    names: ['L. Messi', 'Lionel Andrés Messi Cuccittini'] },
  // https://www.mancity.com/features/erling-haaland/rise/
  { targetId: 'bsd_p_852', name: 'Erling Haaland', dob: '2000-07-21', nationality: 'Norway',
    names: ['E. Haaland', 'Erling Braut Haaland'] },
];
function identity(profile) {
  if (!object(profile) || !/^bsd_p_[1-9]\d{0,14}$/.test(text(profile.id)) ||
      ['provider', 'source'].some(key => profile[key] !== undefined && profile[key] !== 'bsd')) return null;
  const names = [...new Set([profile.name, profile.fullName, profile.shortName].map(normalized).filter(Boolean))].sort();
  const suppliedDates = [profile.dateOfBirth, profile.dateBorn].filter(value => value !== undefined && value !== null && value !== '');
  const dates = [...new Set(suppliedDates.map(date))];
  const nationality = normalized(profile.nationality || profile.country);
  if (!names.length || names.some(name => name.length > 200) || dates.length !== 1 || !dates[0] || !nationality) return null;
  const surname = text(profile.lastname || profile.lastName) || text(profile.fullName || profile.name).split(/\s+/).at(-1);
  const search = normalized(surname);
  if (search.length < 4 || search.length > 100) return null;
  const aliases = VERIFIED_NAME_ALIASES.find(entry => profile.id === entry.targetId &&
    text(profile.name) === entry.name && dates[0] === entry.dob &&
    text(profile.nationality || profile.country) === entry.nationality);
  const verifiedNames = aliases ? [...new Set([...names, ...aliases.names.map(normalized)])].sort() : names;
  return { targetId: profile.id, names: verifiedNames, dob: dates[0], nationality, search };
}
function candidateMatches(player, expected) {
  if (!object(player) || !integer(player.id) || date(player.birth?.date) !== expected.dob ||
      !normalized(player.nationality) || normalized(player.nationality) !== expected.nationality) return false;
  const names = [normalized(player.name), normalized([text(player.firstname), text(player.lastname)].filter(Boolean).join(' '))].filter(Boolean);
  return names.some(name => expected.names.includes(name));
}
function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
function resetAt(value) {
  const number = integer(value);
  const timestamp = number !== null ? number > 1e12 ? number : number * 1000 : Date.parse(text(value));
  return Number.isFinite(timestamp) && timestamp > Date.now() ? Math.min(timestamp, Date.now() + DAY) : null;
}
function dailyReset(headers) {
  return resetAt(header(headers, 'x-ratelimit-requests-reset')) || resetAt(header(headers, 'x-ratelimit-daily-reset'));
}
function block(until, reason) {
  if (until > blockedUntil) { blockedUntil = until; blockedReason = reason; }
}
function inspectQuota(headers) {
  if (integer(header(headers, 'x-ratelimit-requests-remaining')) === 0) {
    // The official daily reset time is not universal across subscriptions.
    block(dailyReset(headers) || Date.now() + DAY, 'provider_daily_quota_exhausted');
  } else if (integer(header(headers, 'x-ratelimit-remaining')) === 0) {
    block(resetAt(header(headers, 'x-ratelimit-reset')) || Date.now() + 60000, 'provider_rate_limited');
  }
}
async function fetchResource(path, params, signal) {
  if (Date.now() < blockedUntil) return { reason: blockedReason };
  try {
    const response = await client.get(path, { params, maxRedirects: 0, timeout: 3500, signal });
    inspectQuota(response.headers);
    if (response.status !== 200 || !object(response.data)) return { reason: 'provider_invalid_response' };
    // API-Sports can return account restrictions inside a successful HTTP response.
    // Preserve the original player data and pause all lookups, not just this player.
    if (/\baccount\s+is\s+suspended\b/i.test(text(response.data.errors?.access))) {
      block(Date.now() + NEGATIVE_TTL, 'provider_account_suspended');
      return { reason: 'provider_account_suspended' };
    }
    return { data: response.data };
  } catch (error) {
    // Never log or return Axios errors/config: they contain the authentication header.
    const status = error.response?.status, headers = error.response?.headers;
    inspectQuota(headers);
    if (status === 429) {
      const retry = header(headers, 'retry-after');
      const seconds = integer(retry);
      const retryAt = seconds !== null ? Date.now() + Math.min(seconds * 1000, DAY) : resetAt(retry);
      block(dailyReset(headers) || retryAt || Date.now() + 60000, 'provider_rate_limited');
      return { reason: blockedReason };
    }
    if (status === 401 || status === 403) return { reason: 'provider_auth_failed' };
    if (status >= 300 && status < 400) return { reason: 'provider_redirect_refused' };
    return { reason: ['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'].includes(error.code)
      ? 'provider_timeout' : 'provider_request_failed' };
  }
}
function validEnvelope(data, endpoint, filter, expected) {
  return object(data) && data.get === endpoint && object(data.parameters) &&
    (typeof data.parameters[filter] === 'string' || typeof data.parameters[filter] === 'number') &&
    String(data.parameters[filter]) === String(expected) &&
    (Array.isArray(data.errors) || object(data.errors)) && Object.keys(data.errors).length === 0 &&
    Array.isArray(data.response) && integer(data.results) === data.response.length &&
    integer(data.paging?.current) === 1 && integer(data.paging?.total) === 1;
}
async function obtain(expected) {
  // One budget covers both requests, including body reads, and aborts transport.
  const signal = AbortSignal.timeout(4500);
  const profiles = await fetchResource('/players/profiles', { search: expected.search, page: 1 }, signal);
  if (!profiles.data) return unavailable(profiles.reason);
  if (!validEnvelope(profiles.data, 'players/profiles', 'search', expected.search) ||
      (profiles.data.parameters.page !== undefined && integer(profiles.data.parameters.page) !== 1)) return unavailable('provider_profile_response_unverified');
  const candidates = profiles.data.response.map(row => row?.player);
  const verifiedIds = [...new Set(candidates.filter(player => candidateMatches(player, expected)).map(player => integer(player.id)))];
  if (verifiedIds.length !== 1) return unavailable(verifiedIds.length ? 'ambiguous_player_identity' : 'player_identity_unverified');
  const sourceId = verifiedIds[0], sourcePlayerId = String(sourceId);
  if (candidates.some(player => integer(player?.id) === sourceId && !candidateMatches(player, expected))) return unavailable('provider_player_identity_conflict');
  const evidence = { identityVerified: true, sourcePlayerId };
  const trophies = await fetchResource('/trophies', { player: sourceId }, signal);
  if (!trophies.data) return unavailable(trophies.reason, evidence);
  if (!validEnvelope(trophies.data, 'trophies', 'player', sourceId)) return unavailable('provider_honours_response_unverified', evidence);
  if (trophies.data.response.some(row => {
    const id = row?.playerId ?? row?.player_id ?? row?.player?.id;
    return id !== undefined && id !== null && String(id) !== sourcePlayerId;
  })) return unavailable('provider_identity_mismatch', evidence);
  const result = normalizePlayerHonours(trophies.data.response, {
    playerId: expected.targetId, rawPlayerId: sourceId, provider: SOURCE, complete: false,
  });
  if (result.honoursCoverage.rejected) return unavailable('invalid_honour_rows', { ...evidence, rejected: result.honoursCoverage.rejected });
  // The live resource mixes dated editions with undated competition/place
  // summaries. Only dated editions belong in history; validate all rows first.
  const honours = result.honours.filter(row => row.season);
  const undatedRowsOmitted = result.honours.length - honours.length;
  return { honours: honours.map(row => ({ ...row, providerPlayerId: sourcePlayerId })),
    honoursCoverage: { ...result.honoursCoverage, ...evidence, returned: honours.length,
      rawRecords: trophies.data.response.length, undatedRowsOmitted,
      responseComplete: true, complete: false, partial: true,
      reason: undatedRowsOmitted ? 'undated_honour_rows_omitted' :
        honours.length ? 'provider_history_scope_not_guaranteed' : 'empty_provider_record' } };
}

async function getPlayerHonoursForProfile(profile) {
  if (!isConfigured()) return unavailable('provider_unconfigured');
  const expected = identity(profile);
  if (!expected) return unavailable('player_identity_evidence_missing');
  const fingerprint = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  const key = SOURCE + ':player-honours:' + fingerprint;
  const cached = getCached(key);
  if (cached) return structuredClone(cached);
  if (pending.has(key)) return structuredClone(await pending.get(key));
  const request = (async () => {
    const result = await obtain(expected);
    setCache(key, result, result.honoursCoverage.available ? DAY : NEGATIVE_TTL);
    return result;
  })();
  pending.set(key, request);
  try { return structuredClone(await request); } finally { pending.delete(key); }
}

module.exports = { isConfigured, getPlayerHonoursForProfile };
