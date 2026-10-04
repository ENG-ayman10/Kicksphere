const FAVORITE_TYPE_ALIASES = {
  team: 'team',
  club: 'team',
  competition: 'competition',
  league: 'competition',
  athlete: 'athlete',
  player: 'athlete'
};

const MAX_STRING_LENGTH = 160;
const MAX_TARGET_ID_LENGTH = 120;
const MAX_METADATA_KEYS = 20;
const { favoriteTeamId, favoriteTeamIds } = require('./teamIdentity');

const createValidationError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const toTrimmedString = (value, maxLength = MAX_STRING_LENGTH) => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim().slice(0, maxLength);
};

const normalizeFavoriteType = (value) => {
  const rawType = toTrimmedString(value).toLowerCase();
  return FAVORITE_TYPE_ALIASES[rawType] || null;
};

const normalizeMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const normalized = {};
  const entries = Object.entries(metadata).slice(0, MAX_METADATA_KEYS);

  for (const [key, value] of entries) {
    const safeKey = toTrimmedString(key, 60);
    if (!safeKey) continue;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[safeKey] = value;
    } else if (Array.isArray(value)) {
      normalized[safeKey] = value
        .filter(item => ['string', 'number', 'boolean'].includes(typeof item))
        .slice(0, 20);
    }
  }

  return normalized;
};

const normalizeFavoriteItem = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw createValidationError('Favorite item must be an object.');
  }

  const type = normalizeFavoriteType(item.type || item.itemType || item.entityType);
  if (!type) {
    throw createValidationError('Favorite item type must be team, competition, or athlete.');
  }

  const rawTargetId = String(item.targetId || item.id || item.providerId || item.externalId || '').trim();
  if (rawTargetId.length > MAX_TARGET_ID_LENGTH) {
    throw createValidationError('Favorite item targetId is too long.');
  }
  const targetId = rawTargetId;

  if (!targetId) {
    throw createValidationError('Favorite item targetId is required.');
  }

  const provider = toTrimmedString(item.provider || item.source || item.externalProvider, 60);
  const scopedId = type === 'team' ? favoriteTeamId({ ...item, targetId, provider }) : null;
  if (type === 'team' && /^((ko|sc|bsd)_t_)/.test(targetId) && !scopedId) {
    throw createValidationError('Favorite team provider does not match its scoped targetId.');
  }
  const favorite = {
    type,
    targetId: scopedId || targetId,
    canonicalKey: `${type}:${(scopedId || targetId).toLowerCase()}`
  };

  const displayName = toTrimmedString(item.displayName || item.name || item.title);
  const providerId = toTrimmedString(item.providerId || item.externalId, MAX_TARGET_ID_LENGTH);
  const imageUrl = toTrimmedString(item.imageUrl || item.logo || item.avatar || item.image, 2048);
  const metadata = normalizeMetadata(item.metadata);

  if (displayName) favorite.displayName = displayName;
  if (provider || scopedId) favorite.provider = scopedId?.startsWith('ko_t_') ? 'kickoffapi' :
    scopedId?.startsWith('bsd_t_') ? 'bsd' : scopedId ? 'sportscore' : provider;
  if (providerId) favorite.providerId = providerId;
  if (imageUrl) favorite.imageUrl = imageUrl;
  if (Object.keys(metadata).length > 0) favorite.metadata = metadata;

  return favorite;
};

const normalizeStoredFavorite = (data = {}) => {
  try {
    return {
      ...data,
      ...normalizeFavoriteItem(data)
    };
  } catch (error) {
    return data;
  }
};

const normalizeStringArray = (value, maxItems = 50) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  for (const item of value) {
    if (!['string', 'number'].includes(typeof item)) continue;
    const text = toTrimmedString(item, MAX_TARGET_ID_LENGTH);
    const key = text.toLowerCase();

    if (!text || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(text);

    if (normalized.length >= maxItems) {
      break;
    }
  }

  return normalized;
};

const normalizePreferences = (body = {}) => {
  const preferences = {
    teams: normalizeStringArray(body.teams),
    leagues: normalizeStringArray(body.leagues),
    content: normalizeStringArray(body.content, 20)
  };
  const records = [...(Array.isArray(body.teams) ? body.teams : []),
    ...(Array.isArray(body.teamIds) ? body.teamIds : []),
    ...(Array.isArray(body.teamsV2) ? body.teamsV2 : []),
    ...(Array.isArray(body.teamRecords) ? body.teamRecords : [])];
  if (Object.hasOwn(body, 'teamIds') || Object.hasOwn(body, 'teamsV2') || Object.hasOwn(body, 'teamRecords') ||
      records.some(item => favoriteTeamId(item))) {
    preferences.teamIds = favoriteTeamIds(records);
    const seen = new Set();
    preferences.teamsV2 = records.filter(record => record && typeof record === 'object' && favoriteTeamId(record))
      .map(record => normalizeFavoriteItem({ ...record, type: 'team' }))
      .filter(record => { if (seen.has(record.targetId)) return false; seen.add(record.targetId); return true; })
      .slice(0, 50);
  }
  return preferences;
};

module.exports = {
  normalizeFavoriteItem,
  normalizePreferences,
  normalizeStoredFavorite
};
