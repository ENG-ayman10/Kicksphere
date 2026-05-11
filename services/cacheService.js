/**
 * @file cacheService.js
 * @description Centralized in-memory cache system
 */

const cache = new Map();

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Evict oldest if cache too large
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

module.exports = {
  getCached,
  setCache
};
