/**
 * @file searchController.js
 * @description Controller for the Universal Search API.
 */

const { searchAll } = require('../services/searchService');
const logger = require('../utils/logger');

/**
 * @route GET /api/search?q=query
 * @description Performs a universal search.
 */
exports.search = async (req, res, next) => {
  try {
    const query = req.query.q;
    
    if (!query || !String(query).trim()) {
      return res.status(400).json({
        success: false,
        message: "Search query 'q' is required."
      });
    }

    if (String(query).trim().length > 120) {
      return res.status(400).json({
        success: false,
        message: "Search query 'q' must be 120 characters or fewer."
      });
    }

    const results = await searchAll(query);
    const { source, ...data } = results;
    
    res.json({
      success: true,
      data,
      meta: { source }
    });
  } catch (error) {
    logger.error(`❌ Search Controller Error: ${error.message}`);
    next(error);
  }
};
