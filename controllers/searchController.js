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
    
    if (!query) {
      return res.status(400).json({
        success: false,
        message: "Search query 'q' is required."
      });
    }

    const results = await searchAll(query);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error(`❌ Search Controller Error: ${error.message}`);
    next(error);
  }
};
