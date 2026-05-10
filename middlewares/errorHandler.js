const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`${err.message}\n${err.stack}`);

  // Don't expose internal error details in production
  const message = process.env.NODE_ENV === 'production'
    ? "Internal Server Error"
    : err.message || "Server Error";

  res.status(err.statusCode || 500).json({
    success: false,
    message
  });
};

module.exports = errorHandler;