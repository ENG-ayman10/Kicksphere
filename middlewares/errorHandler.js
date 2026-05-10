const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`${err.message}\n${err.stack}`);

  const message = err.message || "Server Error";
  const stack = err.stack;

  res.status(err.statusCode || 500).json({
    success: false,
    message,
    stack
  });
};

module.exports = errorHandler;