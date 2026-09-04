
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
const { isAdminUser, verifyAuthToken } = require('./utils/auth');
const {
  matchRoom,
  normalizeRoomValue,
  teamRoom,
  userRoom
} = require('./utils/socketRooms');

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
const proxyRoutes = require('./routes/proxyRoutes');

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
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : [];

if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  console.warn('⚠️ ALLOWED_ORIGINS not set in production, allowing all origins');
}

const corsAllowsAllOrigins = allowedOrigins.length === 0 || allowedOrigins.includes('*');
const corsOrigin = (origin, callback) => {
  if (!origin || corsAllowsAllOrigins || allowedOrigins.includes(origin)) {
    return callback(null, true);
  }

  return callback(null, false);
};

app.use(cors({
  origin: corsOrigin,
  credentials: !corsAllowsAllOrigins,
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
app.use('/api/proxy/rapidapi', proxyRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

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
    origin: corsAllowsAllOrigins
      ? '*'
      : allowedOrigins,
    credentials: !corsAllowsAllOrigins,
    methods: ['GET', 'POST']
  }
});

// Make io globally accessible
app.set('io', io);

// ==========================================
// ⚡ 8. Socket.io Logic
// ==========================================
const getSocketToken = (socket) => {
  const authToken = socket.handshake.auth?.token;
  const authHeader = socket.handshake.headers?.authorization;

  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }

  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return null;
};

const canAccessUserRoom = (socket, userId) => {
  return socket.user && (String(socket.user.id) === String(userId) || isAdminUser(socket.user));
};

io.use(async (socket, next) => {
  const token = getSocketToken(socket);

  if (!token) {
    socket.user = null;
    return next();
  }

  try {
    socket.user = await verifyAuthToken(token);
    if (!socket.user?.id) {
      return next(new Error('Authentication failed'));
    }
    return next();
  } catch (error) {
    logger.warn(`Socket authentication failed: ${error.message}`);
    return next(new Error('Authentication failed'));
  }
});

io.on('connection', (socket) => {

  logger.info(`🔥 Client connected: ${socket.id}`);

  /**
   * 👤 Join personal room
   */
  socket.on('joinUser', (userId) => {

    const roomUserId = normalizeRoomValue(userId);

    if (!roomUserId) {
      return;
    }

    if (!canAccessUserRoom(socket, roomUserId)) {
      socket.emit('authorizationError', {
        message: 'You are not allowed to join this user room.'
      });
      return;
    }

    socket.join(userRoom(roomUserId));

    logger.info(`👤 User joined room: ${userRoom(roomUserId)}`);

  });

  /**
   * ⚽ Join match room
   */
  socket.on('joinMatch', (matchId) => {

    const roomMatchId = normalizeRoomValue(matchId);

    if (!roomMatchId) {
      return;
    }

    socket.join(matchRoom(roomMatchId));

    logger.info(`⚽ User joined match room: ${matchRoom(roomMatchId)}`);

  });

  /**
   * 🔔 Subscribe to detailed match alerts
   */
  socket.on('subscribeMatchAlerts', (matchId) => {
    const roomMatchId = normalizeRoomValue(matchId);
    if (!roomMatchId) return;
    socket.join(`matchAlerts_${roomMatchId}`);
    logger.info(`🔔 User subscribed to alerts for match: ${roomMatchId}`);
  });

  /**
   * 🔕 Unsubscribe from detailed match alerts
   */
  socket.on('unsubscribeMatchAlerts', (matchId) => {
    const roomMatchId = normalizeRoomValue(matchId);
    if (!roomMatchId) return;
    socket.leave(`matchAlerts_${roomMatchId}`);
    logger.info(`🔕 User unsubscribed from alerts for match: ${roomMatchId}`);
  });

  /**
   * ⭐ Subscribe to favorite teams (for targeted notifications)
   */
  socket.on('subscribeFavorites', (data) => {
    if (!data) return;
    const { teams, userId } = data;
    if (Array.isArray(teams)) {
      const safeTeams = teams
        .map(team => normalizeRoomValue(team))
        .filter(Boolean)
        .slice(0, 50);

      safeTeams.forEach(team => {
        const roomTeam = normalizeRoomValue(String(team || ''));
        if (roomTeam) {
          socket.join(teamRoom(roomTeam));
        }
      });
      logger.info(`⭐ User subscribed to ${safeTeams.length} favorite teams`);
    }
    if (userId) {
      const roomUserId = normalizeRoomValue(userId);
      if (roomUserId && canAccessUserRoom(socket, roomUserId)) {
        socket.join(userRoom(roomUserId));
      }
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

      if (!socket.user?.id) {
        socket.emit('authorizationError', {
          message: 'Authentication required to send chat messages.'
        });
        return;
      }

      const { matchId, message } = data;

      const roomMatchId = normalizeRoomValue(matchId);

      if (!roomMatchId || !message) {
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

      const displayUser = socket.user.name || socket.user.email || socket.user.id;

      const saved = await saveMessage(roomMatchId, {
        userId: String(socket.user.id),
        username: String(displayUser).slice(0, 80),
        user: String(displayUser).slice(0, 80),
        text: sanitizedMessage,
        message: sanitizedMessage
      });

      io.to(matchRoom(roomMatchId)).emit('newMessage', saved);

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
const livePollingEnabled = process.env.ENABLE_LIVE_POLLING === 'true';
let liveMatchesRunning = false;
let liveEventsRunning = false;
let liveMatchesInterval = null;
let liveEventsInterval = null;

/**
 * ⚽ Poll live matches every 60 sec
 */
const pollLiveMatches = async () => {

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

};

/**
 * 📢 Poll live events every 90 sec
 */
const pollLiveEvents = async () => {

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

};

if (livePollingEnabled) {
  liveMatchesInterval = setInterval(pollLiveMatches, 60000);
  liveEventsInterval = setInterval(pollLiveEvents, 90000);
  logger.info('📡 Live polling enabled.');
} else {
  logger.info('📡 Live polling disabled. Set ENABLE_LIVE_POLLING=true to enable background polling.');
}

// ==========================================
// 🛑 10. Graceful Shutdown
// ==========================================
const gracefulShutdown = (signal) => {

  logger.info(`⚠️ ${signal} received. Shutting down gracefully...`);

  if (liveMatchesInterval) clearInterval(liveMatchesInterval);
  if (liveEventsInterval) clearInterval(liveEventsInterval);

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
