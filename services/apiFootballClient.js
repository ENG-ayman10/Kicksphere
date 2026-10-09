'use strict';

const axios = require('axios');
const DAY = 24 * 60 * 60 * 1000, MINUTE = 60 * 1000, ACCESS_PAUSE = 5 * MINUTE;
const API_KEY = String(process.env.API_FOOTBALL_KEY || '').trim();
const bounded = (name, fallback, maximum) => /^[1-9]\d*$/.test(String(process.env[name] || ''))
  ? Math.min(Number(process.env[name]), maximum) : fallback;
// These process-wide budgets apply to every supplement and leave headroom on
// the Free plan. Headers can further reduce capacity used by other account users.
const DAILY_BUDGET = bounded('API_FOOTBALL_DAILY_REQUEST_BUDGET', 80, 100);
const MINUTE_BUDGET = bounded('API_FOOTBALL_MINUTE_REQUEST_BUDGET', 8, 10);
const MAX_ACTIVE_REQUESTS = 2;
const ENDPOINTS = new Set(['/players/profiles', '/trophies', '/teams', '/players/squads']);
const isConfigured = () => Boolean(API_KEY) && !/^(replace(?:[-_].*)?|your(?:[-_].*)?|changeme)$/i.test(API_KEY);
const client = axios.create({
  baseURL: 'https://v3.football.api-sports.io', timeout: 3500, maxRedirects: 0,
  maxContentLength: 1024 * 1024,
  headers: { 'x-apisports-key': API_KEY, Accept: 'application/json', 'User-Agent': 'KickSphere/2.0' },
});
let blockedUntil = 0, blockedReason = 'provider_rate_limited', activeRequests = 0;
let dailyWindowStart = Date.now(), dailyRequests = 0, minuteRequests = [];
let dailyRemaining = null, dailyRemainingUntil = 0;
let minuteRemaining = null, minuteRemainingUntil = 0;
const text = value => typeof value === 'string' ? value.trim() : '';
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const integer = value => (typeof value === 'number' || typeof value === 'string') &&
  /^(0|[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

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
  const now = Date.now();
  const suppliedDaily = integer(header(headers, 'x-ratelimit-requests-remaining'));
  const suppliedMinute = integer(header(headers, 'x-ratelimit-remaining'));
  if (suppliedDaily !== null) {
    if (now >= dailyRemainingUntil) dailyRemaining = null;
    dailyRemaining = dailyRemaining === null ? suppliedDaily : Math.min(dailyRemaining, suppliedDaily);
    dailyRemainingUntil = dailyReset(headers) || now + DAY;
  }
  if (suppliedMinute !== null) {
    if (now >= minuteRemainingUntil) minuteRemaining = null;
    minuteRemaining = minuteRemaining === null ? suppliedMinute : Math.min(minuteRemaining, suppliedMinute);
    minuteRemainingUntil = resetAt(header(headers, 'x-ratelimit-reset')) || now + MINUTE;
  }
  if (suppliedDaily === 0) {
    // Reset time differs across subscriptions; do not invent a midnight reset.
    block(dailyReset(headers) || now + DAY, 'provider_daily_quota_exhausted');
  } else if (suppliedMinute === 0) {
    block(resetAt(header(headers, 'x-ratelimit-reset')) || now + MINUTE, 'provider_rate_limited');
  }
}
function reserveRequest() {
  const now = Date.now();
  if (now < blockedUntil) return { reason: blockedReason, retryAfterMs: blockedUntil - now };
  if (activeRequests >= MAX_ACTIVE_REQUESTS) return { reason: 'provider_request_capacity_exceeded' };
  if (now - dailyWindowStart >= DAY) { dailyWindowStart = now; dailyRequests = 0; }
  minuteRequests = minuteRequests.filter(time => now - time < MINUTE);
  if (now >= dailyRemainingUntil) dailyRemaining = null;
  if (now >= minuteRemainingUntil) minuteRemaining = null;
  if (dailyRequests >= DAILY_BUDGET) return {
    reason: 'provider_daily_request_budget_exhausted', retryAfterMs: dailyWindowStart + DAY - now,
  };
  if (dailyRemaining === 0) return { reason: 'provider_daily_quota_exhausted', retryAfterMs: dailyRemainingUntil - now };
  if (minuteRequests.length >= MINUTE_BUDGET) return {
    reason: 'provider_minute_request_budget_exhausted', retryAfterMs: minuteRequests[0] + MINUTE - now,
  };
  if (minuteRemaining === 0) return { reason: 'provider_rate_limited', retryAfterMs: minuteRemainingUntil - now };
  // Reserve synchronously. Distinct supplements cannot spend the same last token.
  dailyRequests += 1;
  minuteRequests.push(now);
  if (dailyRemaining !== null) dailyRemaining -= 1;
  if (minuteRemaining !== null) minuteRemaining -= 1;
  activeRequests += 1;
  return null;
}
async function fetchResource(path, params = {}, signal) {
  if (!isConfigured()) return { reason: 'provider_unconfigured' };
  if (!ENDPOINTS.has(path)) return { reason: 'provider_endpoint_refused' };
  if (signal?.aborted) return { reason: 'provider_timeout' };
  const capacity = reserveRequest();
  if (capacity) return capacity;
  try {
    const response = await client.get(path, { params, maxRedirects: 0, timeout: 3500,
      signal: signal || AbortSignal.timeout(3500) });
    inspectQuota(response.headers);
    if (response.status !== 200 || !object(response.data)) return { reason: 'provider_invalid_response' };
    if (/\baccount\s+is\s+suspended\b/i.test(text(response.data.errors?.access))) {
      block(Date.now() + ACCESS_PAUSE, 'provider_account_suspended');
      return { reason: 'provider_account_suspended' };
    }
    return { data: response.data };
  } catch (error) {
    // Axios errors contain the key in config; never log or return them.
    const status = error.response?.status, headers = error.response?.headers;
    inspectQuota(headers);
    if (status === 429) {
      const retry = header(headers, 'retry-after');
      const seconds = integer(retry);
      const retryAt = seconds !== null ? Date.now() + Math.min(seconds * 1000, DAY) : resetAt(retry);
      block(dailyReset(headers) || retryAt || Date.now() + MINUTE, 'provider_rate_limited');
      return { reason: blockedReason, retryAfterMs: blockedUntil - Date.now() };
    }
    if (status === 401 || status === 403) {
      block(Date.now() + ACCESS_PAUSE, 'provider_auth_failed');
      return { reason: 'provider_auth_failed' };
    }
    if (status >= 300 && status < 400) return { reason: 'provider_redirect_refused' };
    return { reason: ['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'].includes(error.code)
      ? 'provider_timeout' : 'provider_request_failed' };
  } finally { activeRequests -= 1; }
}

module.exports = { isConfigured, fetchResource };
