'use strict';

const { createHash } = require('node:crypto');
const { isConfigured, fetchResource } = require('./apiFootballClient');
const { getCached, setCache } = require('./cacheService');
const { normalizePlayerHonours } = require('../utils/playerHonours');

// Primary reference: https://api-sports.io/documentation/football/v3
// Profiles use player/search/page; search is a lastname of at least four characters.
// Single-player trophies are flat league/country/season/place rows, without player IDs.
const SOURCE = 'api-football';
const DAY = 24 * 60 * 60 * 1000, NEGATIVE_TTL = 5 * 60 * 1000;
const bounded = (name, fallback, maximum) => /^[1-9]\d*$/.test(String(process.env[name] || ''))
  ? Math.min(Number(process.env[name]), maximum) : fallback;
const MAX_PROFILE_PAGES = bounded('API_FOOTBALL_MAX_PROFILE_PAGES', 3, 3);
const MAX_PENDING_LOOKUPS = 2;
const pending = new Map();
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
function requestUnavailable(result, extra = {}) {
  return unavailable(result.reason, { ...extra,
    ...(result.retryAfterMs > 0 ? { retryAfterMs: result.retryAfterMs } : {}) });
}
function validEnvelope(data, endpoint, filter, expected, page = 1, total = 1) {
  return object(data) && data.get === endpoint && object(data.parameters) &&
    (typeof data.parameters[filter] === 'string' || typeof data.parameters[filter] === 'number') &&
    String(data.parameters[filter]) === String(expected) &&
    (Array.isArray(data.errors) || object(data.errors)) && Object.keys(data.errors).length === 0 &&
    Array.isArray(data.response) && integer(data.results) === data.response.length &&
    integer(data.paging?.current) === page && integer(data.paging?.total) === total;
}
async function obtain(expected) {
  // One budget covers both requests, including body reads, and aborts transport.
  const signal = AbortSignal.timeout(4500);
  const profiles = await fetchResource('/players/profiles', { search: expected.search, page: 1 }, signal);
  if (!profiles.data) return requestUnavailable(profiles);
  const totalPages = integer(profiles.data.paging?.total);
  if (!totalPages || !validEnvelope(profiles.data, 'players/profiles', 'search', expected.search, 1, totalPages) ||
      (profiles.data.parameters.page !== undefined && integer(profiles.data.parameters.page) !== 1)) return unavailable('provider_profile_response_unverified');
  if (totalPages > MAX_PROFILE_PAGES) return unavailable('provider_profile_page_limit');
  if (totalPages > 1 && (integer(profiles.data.parameters.page) !== 1 || profiles.data.response.length === 0)) {
    return unavailable('provider_profile_response_unverified');
  }
  const candidates = profiles.data.response.map(row => row?.player);
  for (let page = 2; page <= totalPages; page += 1) {
    const next = await fetchResource('/players/profiles', { search: expected.search, page }, signal);
    if (!next.data) return requestUnavailable(next);
    if (!validEnvelope(next.data, 'players/profiles', 'search', expected.search, page, totalPages) ||
        integer(next.data.parameters.page) !== page || next.data.response.length === 0) {
      return unavailable('provider_profile_response_unverified');
    }
    candidates.push(...next.data.response.map(row => row?.player));
  }
  // Only a complete bounded search establishes uniqueness. A later page can
  // contain a second matching ID or a contradictory profile for the first ID.
  const verifiedIds = [...new Set(candidates.filter(player => candidateMatches(player, expected)).map(player => integer(player.id)))];
  if (verifiedIds.length !== 1) return unavailable(verifiedIds.length ? 'ambiguous_player_identity' : 'player_identity_unverified');
  const sourceId = verifiedIds[0], sourcePlayerId = String(sourceId);
  if (candidates.some(player => integer(player?.id) === sourceId && !candidateMatches(player, expected))) return unavailable('provider_player_identity_conflict');
  const evidence = { identityVerified: true, sourcePlayerId };
  const matchingProfiles = candidates.filter(player => integer(player?.id) === sourceId);
  const profileSupplement = { targetId: expected.targetId, sourcePlayerId,
    provider: SOURCE, identityVerified: true };
  for (const field of ['weight', 'height', 'photo']) {
    const values = [...new Set(matchingProfiles.map(player => player[field])
      .filter(value => (typeof value === 'string' && value.trim()) || typeof value === 'number'))];
    // Conflicting duplicate rows cannot pick an arbitrary biography value.
    if (values.length === 1) profileSupplement[field] = values[0];
  }
  const withProfile = result => ({ ...result, profileSupplement });
  const trophies = await fetchResource('/trophies', { player: sourceId }, signal);
  if (!trophies.data) return withProfile(requestUnavailable(trophies, evidence));
  if (!validEnvelope(trophies.data, 'trophies', 'player', sourceId)) return withProfile(unavailable('provider_honours_response_unverified', evidence));
  if (trophies.data.response.some(row => {
    const id = row?.playerId ?? row?.player_id ?? row?.player?.id;
    return id !== undefined && id !== null && String(id) !== sourcePlayerId;
  })) return withProfile(unavailable('provider_identity_mismatch', evidence));
  const result = normalizePlayerHonours(trophies.data.response, {
    playerId: expected.targetId, rawPlayerId: sourceId, provider: SOURCE, complete: false,
  });
  if (result.honoursCoverage.rejected) return withProfile(unavailable('invalid_honour_rows', { ...evidence, rejected: result.honoursCoverage.rejected }));
  // The live resource mixes dated editions with undated competition/place
  // summaries. Only dated editions belong in history; validate all rows first.
  const honours = result.honours.filter(row => row.season);
  const undatedRowsOmitted = result.honours.length - honours.length;
  return { profileSupplement, honours: honours.map(row => ({ ...row, providerPlayerId: sourcePlayerId })),
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
  if (pending.size >= MAX_PENDING_LOOKUPS) return unavailable('provider_lookup_capacity_exceeded');
  const request = (async () => {
    const result = await obtain(expected);
    const retryAfter = result.honoursCoverage.retryAfterMs;
    setCache(key, result, result.honoursCoverage.available ? DAY :
      retryAfter > 0 ? Math.min(NEGATIVE_TTL, retryAfter) : NEGATIVE_TTL);
    return result;
  })();
  pending.set(key, request);
  try { return structuredClone(await request); } finally { pending.delete(key); }
}

module.exports = { isConfigured, getPlayerHonoursForProfile };
