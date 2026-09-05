const cache = new Map();

function getCached(key, customTtl) {
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = customTtl !== undefined ? customTtl : (entry.ttl || 60000);
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

