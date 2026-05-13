
/**
 * @file server.js
 * @description Main entry point for the KickSphere Backend API and WebSocket server.
 */

require('dotenv').config();

// ==========================================
// 📦 1. Core Dependencies
// ==========================================
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const path = require('path');

// ==========================================
// 🛠️ 2. Custom Modules & Config
// ==========================================
const logger = require('./utils/logger');
const errorHandler = require('./middlewares/errorHandler');
const { sanitizeInput } = require('./middlewares/validate');

// ==========================================
// 🔀 3. Route Handlers
// ==========================================
const matchRoutes = require('./routes/matchRoutes');
const chatRoutes = require('./routes/chatRoutes');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const homeRoutes = require('./routes/homeRoutes');
const leagueRoutes = require('./routes/leagueRoutes');
const teamRoutes = require('./routes/teamRoutes');
const playerRoutes = require('./routes/playerRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const newsRoutes = require('./routes/newsRoutes');
const searchRoutes = require('./routes/searchRoutes');
const statsRoutes = require('./routes/statsRoutes');

// ==========================================
// ⚙️ 4. Background Services
// ==========================================
const { emitLiveMatches } = require('./services/liveService');
const { emitLiveEvents } = require('./services/liveEventsService');
const { saveMessage } = require('./services/chatService');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 🛡️ 5. Global Middlewares
// ==========================================

// Security headers
app.use(helmet());

// Compress JSON responses
app.use(compression());

// HTTP request logging
app.use(morgan('dev'));

// ==========================================
// 🚦 Rate Limiters
// ==========================================

// General API limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP. Please try again later.'
  }
});

// Auth limiter
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please try again later.'
  }
});

// Search limiter
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many search requests. Please slow down.'
  }
});

app.use(generalLimiter);

// ==========================================
// 🌍 CORS Configuration
// ==========================================
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['*'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ==========================================
// 📦 Body Parser
// ==========================================
app.use(express.json({
  limit: '1mb'
}));

// ==========================================
// 🧹 Input Sanitization
// ==========================================
app.use(sanitizeInput);

// ==========================================
// 📁 Static Uploads
// ==========================================
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==========================================
// ❤️ Health Check Endpoint
// ==========================================
app.get('/api/health', (req, res) => {

  res.json({
    success: true,
    message: 'KickSphere Backend OK 🚀',
    uptime: process.uptime(),
    timestamp: Date.now(),
    environment: process.env.NODE_ENV || 'development'
  });

});

// ==========================================
// 🌐 6. REST API Routes
// ==========================================
app.use('/api/auth', strictLimiter, authRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/leagues', leagueRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/search', searchLimiter, searchRoutes);
app.use('/api/stats', statsRoutes);

// ==========================================
// ❌ Global Error Handler
// ==========================================
app.use(errorHandler);

// ==========================================
// 🔌 7. HTTP & Socket.io Server
// ==========================================
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes('*')
      ? '*'
      : allowedOrigins,
    methods: ['GET', 'POST']
  }
});

// Make io globally accessible
app.set('io', io);

// ==========================================
// ⚡ 8. Socket.io Logic
// ==========================================
io.on('connection', (socket) => {

  logger.info(`🔥 Client connected: ${socket.id}`);

  /**
   * 👤 Join personal room
   */
  socket.on('joinUser', (userId) => {

    if (!userId || typeof userId !== 'string') {
      return;
    }

    socket.join(userId);

    logger.info(`👤 User joined room: ${userId}`);

  });

  /**
   * ⚽ Join match room
   */
  socket.on('joinMatch', (matchId) => {

    if (!matchId || typeof matchId !== 'string') {
      return;
    }

    socket.join(matchId);

    logger.info(`⚽ User joined match room: ${matchId}`);

  });

  /**
   * ⭐ Subscribe to favorite teams (for targeted notifications)
   */
  socket.on('subscribeFavorites', (data) => {
    if (!data) return;
    const { teams, userId } = data;
    if (Array.isArray(teams)) {
      teams.forEach(team => {
        socket.join(`team_${team}`);
      });
      logger.info(`⭐ User subscribed to ${teams.length} favorite teams`);
    }
    if (userId) {
      socket.join(userId);
    }
  });

  /**
   * 💬 Match Chat Messaging
   */
  socket.on('sendMessage', async (data) => {

    try {

      if (!data || typeof data !== 'object') {
        return;
      }

      const { matchId, user, message } = data;

      if (!matchId || !message) {
        return;
      }

      if (typeof message !== 'string') {
        return;
      }

      if (message.length > 500) {
        return;
      }

      const sanitizedMessage = message.trim();

      if (!sanitizedMessage) {
        return;
      }

      const saved = await saveMessage(matchId, {
        user: user || 'Anonymous',
        message: sanitizedMessage
      });

      io.to(matchId).emit('newMessage', saved);

    } catch (error) {

      logger.error(`❌ Chat Error: ${error.message}`);

    }

  });

  /**
   * ❌ Disconnect
   */
  socket.on('disconnect', () => {

    logger.info(`❌ Client disconnected: ${socket.id}`);

    socket.removeAllListeners();

  });

});

// ==========================================
// 🔄 9. Live Polling System
// ==========================================
let liveMatchesRunning = false;
let liveEventsRunning = false;

/**
 * ⚽ Poll live matches every 60 sec
 */
const liveMatchesInterval = setInterval(async () => {

  if (liveMatchesRunning) {

    logger.warn('⚠️ Skipping live matches poll (already running)');
    return;

  }

  try {

    liveMatchesRunning = true;

    logger.info('📡 Polling live matches...');

    await emitLiveMatches(io);

  } catch (error) {

    logger.error(`❌ Live Matches Error: ${error.message}`);

  } finally {

    liveMatchesRunning = false;

  }

}, 60000);

/**
 * 📢 Poll live events every 90 sec
 */
const liveEventsInterval = setInterval(async () => {

  if (liveEventsRunning) {

    logger.warn('⚠️ Skipping live events poll (already running)');
    return;

  }

  try {

    liveEventsRunning = true;

    logger.info('📡 Polling live events...');

    await emitLiveEvents(io);

  } catch (error) {

    logger.error(`❌ Live Events Error: ${error.message}`);

  } finally {

    liveEventsRunning = false;

  }

}, 30000);

// ==========================================
// 🛑 10. Graceful Shutdown
// ==========================================
const gracefulShutdown = (signal) => {

  logger.info(`⚠️ ${signal} received. Shutting down gracefully...`);

  clearInterval(liveMatchesInterval);
  clearInterval(liveEventsInterval);

  io.close(() => {
    logger.info('🔌 Socket.io closed.');
  });

  server.close(() => {

    logger.info('🛑 HTTP server closed.');

    process.exit(0);

  });

  setTimeout(() => {

    logger.error('⚠️ Forced shutdown.');

    process.exit(1);

  }, 10000);

};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {

  logger.error(`Uncaught Exception: ${error.message}`);

  gracefulShutdown('uncaughtException');

});

// ==========================================
// 🚀 11. Start Server
// ==========================================
server.listen(PORT, () => {

  logger.info('====================================');
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info('⚽ KickSphere Backend Started');
  logger.info('====================================');

});
