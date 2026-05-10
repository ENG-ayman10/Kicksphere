/**
 * @file validate.js
 * @description Input validation and sanitization middleware.
 * Lightweight validation without external dependencies.
 */

const logger = require('../utils/logger');

/**
 * Sanitize a string to prevent injection attacks.
 * Removes HTML tags and trims whitespace.
 */
const sanitizeString = (str) => {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
};

/**
 * Deep sanitize an object — recursively sanitize all string values.
 */
const sanitizeObject = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
};

/**
 * Middleware: Sanitize req.body, req.query, req.params
 */
const sanitizeInput = (req, res, next) => {
  if (req.body) req.body = sanitizeObject(req.body);
  if (req.query) req.query = sanitizeObject(req.query);
  if (req.params) req.params = sanitizeObject(req.params);
  next();
};

/**
 * Validate required fields in req.body
 * @param {string[]} fields - Array of required field names
 */
const requireFields = (fields) => (req, res, next) => {
  const missing = fields.filter(field => {
    const value = req.body[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required fields: ${missing.join(', ')}`
    });
  }
  next();
};

/**
 * Validate required params in req.params
 * @param {string[]} params - Array of required param names
 */
const requireParams = (params) => (req, res, next) => {
  const missing = params.filter(param => !req.params[param]);

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required parameters: ${missing.join(', ')}`
    });
  }
  next();
};

/**
 * Validate that a query parameter exists
 * @param {string[]} queryParams - Array of required query param names
 */
const requireQuery = (queryParams) => (req, res, next) => {
  const missing = queryParams.filter(param => !req.query[param]);

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required query parameters: ${missing.join(', ')}`
    });
  }
  next();
};

module.exports = {
  sanitizeInput,
  sanitizeString,
  sanitizeObject,
  requireFields,
  requireParams,
  requireQuery
};
