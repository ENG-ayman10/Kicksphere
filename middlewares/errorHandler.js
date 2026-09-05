const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const requestLabel = `${req.method} ${req.originalUrl}`;

  if (process.env.NODE_ENV === 'production') {
    logger.error(`${requestLabel} failed: ${err.message}`);
  } else {
    logger.error(`${requestLabel} failed: ${err.message}\n${err.stack}`);
  }

  // Don't expose internal error details in production for 5xx errors
  const message = (process.env.NODE_ENV === 'production' && statusCode >= 500)
    ? "Internal Server Error"
    : err.message || "Server Error";

  res.status(statusCode).json({
    success: false,
    message
  });
};

module.exports = errorHandler;
