const cache = new Map();

function getCached(key, customTtl) {
  const entry = cache.get(key);
  if (!entry) return null;
  const storedTtl = entry.ttl || 60000;
  const validStoredTtl = Number.isFinite(storedTtl) && storedTtl > 0 ? storedTtl : 60000;
  // A caller may require fresher data, but cannot prolong a shorter cache
  // lifetime chosen for partial responses or temporary provider gaps.
  const ttl = Number.isFinite(customTtl) && customTtl > 0 ? Math.min(validStoredTtl, customTtl) : storedTtl;
  if (Date.now() - entry.ts < ttl) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key, data, ttl = 60000) {
  cache.set(key, { data, ts: Date.now(), ttl });
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

