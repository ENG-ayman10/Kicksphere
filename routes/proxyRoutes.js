/**
 * @file proxyRoutes.js
 * @description Secure proxy for RapidAPI requests.
 * Keeps the API key on the server side — never exposed to client apps.
 * 
 * Usage: GET /api/proxy/rapidapi/football-current-live
 *   → proxied to https://free-api-live-football-data.p.rapidapi.com/football-current-live
 */

const express = require('express');
const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('../services/cacheService');

const router = express.Router();

const RAPID_API_KEY = process.env.RAPID_API_KEY || '';
const RAPID_API_HOST = process.env.RAPID_API_HOST || 'free-api-live-football-data.p.rapidapi.com';
const RAPID_BASE = `https://${RAPID_API_HOST}`;

// Cache TTLs per endpoint pattern
const CACHE_TTL = {
  'football-current-live': 30 * 1000,          // 30s for live matches
  'football-get-match-details': 60 * 1000,     // 1 min
  'football-get-match-event': 60 * 1000,       // 1 min
  'football-get-match-statistics': 2 * 60 * 1000, // 2 min
  'football-get-match-lineup': 5 * 60 * 1000,  // 5 min
  'football-get-standing': 10 * 60 * 1000,     // 10 min
  'football-get-all-leagues': 60 * 60 * 1000,  // 1 hour
  'football-get-top-leagues': 60 * 60 * 1000,  // 1 hour
  'football-get-all-season': 60 * 60 * 1000,   // 1 hour
  'football-get-all-today-match': 5 * 60 * 1000, // 5 min
  'football-get-matches-by-league': 10 * 60 * 1000, // 10 min
  DEFAULT: 5 * 60 * 1000,                      // 5 min default
};

function getTTL(path) {
  for (const [pattern, ttl] of Object.entries(CACHE_TTL)) {
    if (pattern !== 'DEFAULT' && path.includes(pattern)) return ttl;
  }
  return CACHE_TTL.DEFAULT;
}

// ==========================================
// 🔄 Wildcard Proxy: /api/proxy/rapidapi/*
// ==========================================
router.get('/*', async (req, res) => {
  if (!RAPID_API_KEY) {
    return res.status(500).json({
      success: false,
      message: 'RapidAPI key not configured on server.',
    });
  }

  // Build the target URL: strip the leading "/" from params[0]
  const endpoint = req.params[0];
  const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const targetUrl = `${RAPID_BASE}/${endpoint}${queryString}`;

  // Check cache
  const cacheKey = `rapidapi:${endpoint}${queryString}`;
  const ttl = getTTL(endpoint);
  const cached = getCached(cacheKey, ttl);
  if (cached) {
    return res.json(cached);
  }

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'x-rapidapi-host': RAPID_API_HOST,
        'x-rapidapi-key': RAPID_API_KEY,
        'Accept': 'application/json',
      },
      timeout: 10000,
    });

    // Cache and return
    setCache(cacheKey, response.data);
    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    logger.error(`❌ RapidAPI Proxy Error [${endpoint}]: ${status} — ${message}`);

    res.status(status).json({
      success: false,
      message: `Proxy error: ${message}`,
    });
  }
});

module.exports = router;
