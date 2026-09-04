/**
 * @file proxyRoutes.js
 * @description Optional allowlisted proxy for RapidAPI football endpoints.
 */

const express = require('express');
const axios = require('axios');
const logger = require('../utils/logger');
const { getCached, setCache } = require('../services/cacheService');

const router = express.Router();

const RAPID_API_KEY = String(process.env.RAPID_API_KEY || '').trim();
const RAPID_API_HOST = process.env.RAPID_API_HOST || 'free-api-live-football-data.p.rapidapi.com';
const RAPID_PROXY_ENABLED = process.env.ENABLE_RAPIDAPI_PROXY === 'true';
const RAPID_BASE = `https://${RAPID_API_HOST}`;

const CACHE_TTL = {
  'football-current-live': 30 * 1000,
  'football-get-match-details': 60 * 1000,
  'football-get-match-event': 60 * 1000,
  'football-get-match-statistics': 2 * 60 * 1000,
  'football-get-match-lineup': 5 * 60 * 1000,
  'football-get-standing': 10 * 60 * 1000,
  'football-get-all-leagues': 60 * 60 * 1000,
  'football-get-top-leagues': 60 * 60 * 1000,
  'football-get-all-season': 60 * 60 * 1000,
  'football-get-all-today-match': 5 * 60 * 1000,
  'football-get-matches-by-league': 10 * 60 * 1000,
};

const ALLOWED_ENDPOINTS = new Set(Object.keys(CACHE_TTL));

const stableQueryString = (query = {}) => Object.keys(query)
  .sort()
  .flatMap((key) => {
    const values = Array.isArray(query[key]) ? query[key] : [query[key]];
    return values.map(value => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  })
  .join('&');

const normalizeEndpoint = (endpoint) => {
  const value = String(endpoint || '').trim();
  if (!/^[a-z0-9-]+$/.test(value)) return null;
  return ALLOWED_ENDPOINTS.has(value) ? value : null;
};

router.get('/:endpoint', async (req, res) => {
  if (!RAPID_PROXY_ENABLED) {
    return res.status(404).json({
      success: false,
      message: 'RapidAPI proxy is disabled.'
    });
  }

  if (!RAPID_API_KEY || RAPID_API_KEY === 'replace-me') {
    return res.status(500).json({
      success: false,
      message: 'RapidAPI key not configured on server.'
    });
  }

  const endpoint = normalizeEndpoint(req.params.endpoint);
  if (!endpoint) {
    return res.status(404).json({
      success: false,
      message: 'RapidAPI endpoint is not supported.'
    });
  }

  const queryString = stableQueryString(req.query);
  const cacheKey = `rapidapi:${endpoint}${queryString ? `?${queryString}` : ''}`;
  const cached = getCached(cacheKey, CACHE_TTL[endpoint]);
  if (cached) {
    return res.json(cached);
  }

  try {
    const response = await axios.get(`${RAPID_BASE}/${endpoint}`, {
      params: req.query,
      headers: {
        'x-rapidapi-host': RAPID_API_HOST,
        'x-rapidapi-key': RAPID_API_KEY,
        Accept: 'application/json'
      },
      timeout: 10000,
    });

    setCache(cacheKey, response.data);
    return res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    logger.error(`RapidAPI proxy error [${endpoint}]: ${status} - ${message}`);

    return res.status(status).json({
      success: false,
      message: `Proxy error: ${message}`,
    });
  }
});

module.exports = router;
