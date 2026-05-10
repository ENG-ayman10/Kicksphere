/**
 * @file newsController.js
 * @description Controller for the News API endpoints.
 */

const { getLatestNews } = require('../services/newsService');
const logger = require('../utils/logger');

/**
 * @route GET /api/news
 * @description Fetches the latest football news.
 */
exports.getNews = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const news = await getLatestNews(limit);
    
    res.json({
      success: true,
      data: news
    });
  } catch (error) {
    logger.error(`❌ News Controller Error: ${error.message}`);
    next(error);
  }
};
