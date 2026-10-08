const express = require('express');
const axios = require('axios');
const router = express.Router();
const client = axios.create({ timeout: 7000, maxRedirects: 0, maxContentLength: 1024 * 1024,
  responseType: 'arraybuffer', headers: { Accept: 'image/png,image/jpeg,image/webp' } });
const cache = new Map(), pending = new Map();
const TTL = 60 * 60 * 1000, MAX_BYTES = 16 * 1024 * 1024;
const MISSING_TTL = 60 * 1000;
const MAX_ACTIVE = 8, MAX_PENDING = 64;
const waiting = [];
let storedBytes = 0;
let active = 0;

function acquireImageSlot() {
  if (active < MAX_ACTIVE) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => waiting.push(resolve));
}
function releaseImageSlot() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
function rememberImage(key, result, ttl) {
  const previous = cache.get(key);
  if (previous) storedBytes -= previous.bytes?.length || 0;
  const entry = { ...result, time: Date.now(), ttl };
  cache.set(key, entry); storedBytes += entry.bytes?.length || 0;
  while (storedBytes > MAX_BYTES || cache.size > 128) {
    const oldest = cache.keys().next().value;
    storedBytes -= cache.get(oldest).bytes?.length || 0; cache.delete(oldest);
  }
  return entry;
}
async function readImage(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < entry.ttl) return entry;
  if (entry) { cache.delete(key); storedBytes -= entry.bytes?.length || 0; }
  if (pending.has(key)) return pending.get(key);
  // A lineup can display 22 distinct portraits at once. Queue normal bursts,
  // instead of turning the ninth available image into a permanent UI fallback.
  // Both the upstream concurrency and total outstanding requests stay bounded.
  if (pending.size >= MAX_PENDING) return { status: 503 };
  const request = (async () => {
    await acquireImageSlot();
    try {
      // Images are public. No token, caller URL, redirect or auth header is sent.
      const response = await client.get('https://sports.bzzoiro.com/img/' + key + '/');
      // A missing portrait is retried after a short interval, without sending
      // the same failed lookup for every rebuild or profile visit.
      if (response.status === 204 || response.status === 404) {
        return rememberImage(key, { status: 404 }, MISSING_TTL);
      }
      if (response.status !== 200) return { status: 502 };
      if (!response.data?.byteLength) return rememberImage(key, { status: 404 }, MISSING_TTL);
      const bytes = Buffer.from(response.data), type = imageType(bytes);
      if (!type) return { status: 502 };
      return rememberImage(key, { bytes, type, status: 200 }, TTL);
    } catch (error) {
      return error.response?.status === 404
        ? rememberImage(key, { status: 404 }, MISSING_TTL) : { status: 502 };
    } finally {
      releaseImageSlot();
    }
  })();
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}
router.get('/bsd/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!['team', 'player', 'league', 'manager', 'venue'].includes(type) ||
      !/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id))) return res.status(400).end();
  const result = await readImage(type + '/' + id);
  if (result.status !== 200) {
    if (result.status === 503) res.set('Retry-After', '1');
    if (result.status === 404) res.set('Cache-Control', 'public, max-age=60');
    else res.set('Cache-Control', 'no-store');
    return res.status(result.status).end();
  }
  res.set({ 'Content-Type': result.type, 'Cache-Control': 'public, max-age=3600',
    'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' });
  return res.send(result.bytes);
});
module.exports = router;
