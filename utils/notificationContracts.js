const { scopedTeamId } = require('./teamIdentity');
const { matchIdentityIds, teamIdentityIds } = require('./matchProviderIdentities');
const MAX_DEVICES_PER_USER = 10;
const MAX_TOKEN_LENGTH = 4096;
const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_PREFERENCES = Object.freeze({ sound: true, vibration: true, hideScores: false,
  favoritesOnly: false, teamIds: [], matchIds: [] });

function validationError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function normalizeDeviceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw validationError('deviceId must be an installation identifier of 8 to 128 safe characters.');
  }
  return value;
}
function normalizeToken(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > MAX_TOKEN_LENGTH || !/^[!-~]+$/.test(value)) {
    throw validationError('A valid bounded FCM token is required.');
  }
  return value;
}
function normalizeIds(value, field, limit) {
  if (!Array.isArray(value) || value.length > limit) throw validationError(`${field} must contain at most ${limit} IDs.`);
  return [...new Set(value.map(id => {
    const valid = typeof id === 'string' && id.length <= 120 && (field === 'teamIds'
      ? scopedTeamId(id) === id
      // SportScore exposes opaque match slugs. Numeric IDs require a provider prefix.
      : /^(?:ko|bsd)_/.test(id) ? /^(?:ko|bsd)_[1-9]\d*$/.test(id)
        : !/^sc_t_/.test(id) && /^(?=[a-z0-9_-]*[a-z])[a-z0-9][a-z0-9_-]*$/.test(id));
    if (!valid) throw validationError(`${field} contains an invalid provider-scoped ID.`);
    return id;
  }))];
}
function normalizeNotificationPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('preferences must be an object.');
  const result = { ...DEFAULT_PREFERENCES, teamIds: [], matchIds: [] };
  for (const field of ['sound', 'vibration', 'hideScores', 'favoritesOnly']) {
    if (Object.hasOwn(value, field)) {
      if (typeof value[field] !== 'boolean') throw validationError(`${field} must be boolean.`);
      result[field] = value[field];
    }
  }
  for (const [field, limit] of [['teamIds', 50], ['matchIds', 100]]) {
    if (Object.hasOwn(value, field)) result[field] = normalizeIds(value[field], field, limit);
  }
  return result;
}
function normalizeDeviceRegistration(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('Device registration must be an object.');
  if (!['android', 'ios', 'web'].includes(body.platform)) throw validationError('platform must be android, ios, or web.');
  if (!['ar', 'en'].includes(body.language)) throw validationError('language must be ar or en.');
  return { token: normalizeToken(body.token), platform: body.platform, language: body.language,
    preferences: normalizeNotificationPreferences(body.preferences) };
}
function eventMatchesPreferences(event, preferences = {}) {
  // Score hiding protects against every match spoiler, including a generic goal alert.
  if (preferences.hideScores === true) return false;
  const matchIds = Array.isArray(preferences.matchIds) ? preferences.matchIds : [];
  const teamIds = Array.isArray(preferences.teamIds) ? preferences.teamIds : [];
  // An explicit match bell is always honored, including with favoritesOnly enabled.
  return matchIdentityIds(event).some(id => matchIds.includes(id)) ||
    (!event.isDetailed && teamIdentityIds(event).some(id => teamIds.includes(id)));
}
module.exports = { MAX_DEVICES_PER_USER, DEVICE_TTL_MS, DEFAULT_PREFERENCES, validationError,
  normalizeDeviceId, normalizeToken, normalizeNotificationPreferences, normalizeDeviceRegistration, eventMatchesPreferences };
