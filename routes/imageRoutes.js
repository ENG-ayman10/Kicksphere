const express = require('express');
const axios = require('axios');
const router = express.Router();
const client = axios.create({ timeout: 7000, maxRedirects: 0, maxContentLength: 1024 * 1024,
  responseType: 'arraybuffer', headers: { Accept: 'image/png,image/jpeg,image/webp' } });
const cache = new Map(), pending = new Map();
const TTL = 60 * 60 * 1000, MAX_BYTES = 16 * 1024 * 1024;
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
async function readImage(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < TTL) return entry;
  if (entry) { cache.delete(key); storedBytes -= entry.bytes.length; }
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
      if (response.status === 204 || !response.data?.byteLength) return { status: 404 };
      const bytes = Buffer.from(response.data), type = imageType(bytes);
      if (!type) return { status: 502 };
      const result = { bytes, type, time: Date.now(), status: 200 };
      cache.set(key, result); storedBytes += bytes.length;
      while (storedBytes > MAX_BYTES || cache.size > 128) {
        const oldest = cache.keys().next().value;
        storedBytes -= cache.get(oldest).bytes.length; cache.delete(oldest);
      }
      return result;
    } catch (error) {
      return { status: error.response?.status === 404 ? 404 : 502 };
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
    return res.status(result.status).end();
  }
  res.set({ 'Content-Type': result.type, 'Cache-Control': 'public, max-age=3600',
    'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' });
  return res.send(result.bytes);
});
module.exports = router;
