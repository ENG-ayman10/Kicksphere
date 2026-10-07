
/**
 * @file server.js
 * @description Main entry point for the KickSphere Backend API and WebSocket server.
 */

require('dotenv').config();
const { loadRuntimeConfig, createOriginPolicy } = require('./utils/runtimeConfig');
// Validate before loading routes, Firebase, or starting any background work.
const runtimeConfig = loadRuntimeConfig();
const originPolicy = createOriginPolicy(runtimeConfig);
const { favoriteTeamIds } = require('./utils/teamIdentity');

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
const imageRoutes = require('./routes/imageRoutes');

// ==========================================
// ⚙️ 4. Background Services
// ==========================================
const { emitLiveMatches } = require('./services/liveService');
const { emitLiveEvents } = require('./services/liveEventsService');
const { createLivePollingCoordinator } = require('./services/livePollingService');
const { saveMessage } = require('./services/chatService');

const app = express();
const PORT = runtimeConfig.port;

// Trust reverse proxy (essential for Render / Cloudflare rate-limiting by actual client IP)
app.set('trust proxy', runtimeConfig.trustProxy);

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
  max: 1200,
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
const corsAllowsAllOrigins = runtimeConfig.allowAllOrigins;
const corsOrigin = originPolicy.corsOrigin;
app.use(originPolicy.middleware);

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

let shuttingDown = false;
app.get('/api/ready', (req, res) => {
  // These checks describe successful startup configuration, not connectivity
  // to Firestore or football providers. No paid/provider request is triggered.
  res.status(shuttingDown ? 503 : 200).json({
    success: !shuttingDown,
    status: shuttingDown ? 'draining' : 'ready',
    checks: { configuration: true, firebaseInitialized: true, http: !shuttingDown },
    livePollingEnabled: runtimeConfig.livePollingEnabled,
    liveMatchesPollIntervalMs: runtimeConfig.liveMatchesPollIntervalMs,
    liveEventsPollIntervalMs: runtimeConfig.liveEventsPollIntervalMs,
    liveEventsShareMatchSnapshot: true,
    providerReachabilityChecked: false,
    timestamp: Date.now()
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
app.use('/api/images', imageRoutes);
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
    origin: corsOrigin,
    credentials: !corsAllowsAllOrigins,
    methods: ['GET', 'POST']
  },
  // Socket CORS alone protects long polling, not direct WebSocket handshakes.
  allowRequest: originPolicy.allowSocketRequest
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
  if (socket.user?.id) socket.join(userRoom(String(socket.user.id)));

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
  socket.on('leaveMatch', matchId => {
    const id = normalizeRoomValue(matchId);
    if (id) socket.leave(matchRoom(id));
  });

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
      for (const room of socket.rooms) { if (room.startsWith('team:')) socket.leave(room); }
      const safeTeams = favoriteTeamIds(teams);

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
  let lastChatAt = 0;
  socket.on('sendMessage', async (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (Date.now() - lastChatAt < 1500) return reply({ success: false, message: 'Please wait before sending again' });
    lastChatAt = Date.now();

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
      reply({ success: true, data: saved });

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
const livePollingEnabled = runtimeConfig.livePollingEnabled;
let liveMatchesInterval = null;
let liveEventsInterval = null;
const livePolling = createLivePollingCoordinator({
  readAndEmitMatches: () => emitLiveMatches(io),
  emitEvents: cycle => emitLiveEvents(io, cycle),
  matchesIntervalMs: runtimeConfig.liveMatchesPollIntervalMs,
  eventsIntervalMs: runtimeConfig.liveEventsPollIntervalMs,
  onError: (kind, error) => logger.error(`Live ${kind} poll failed: ${error.message}`)
});
const { pollLiveMatches, pollLiveEvents } = livePolling;

if (livePollingEnabled) {
  // Establish the initial baseline immediately, rather than waiting a full
  // interval before new score/status changes can be detected.
  void pollLiveMatches();
  liveMatchesInterval = setInterval(pollLiveMatches, runtimeConfig.liveMatchesPollIntervalMs);
  liveEventsInterval = setInterval(pollLiveEvents, runtimeConfig.liveEventsPollIntervalMs);
  logger.info(`📡 Live polling enabled; shared snapshot ${runtimeConfig.liveMatchesPollIntervalMs}ms, bounded details ${runtimeConfig.liveEventsPollIntervalMs}ms.`);
} else {
  logger.info('📡 Live polling disabled. Set ENABLE_LIVE_POLLING=true to enable background polling.');
}

// ==========================================
// 🛑 10. Graceful Shutdown
// ==========================================
const gracefulShutdown = (signal) => {

  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`⚠️ ${signal} received. Shutting down gracefully...`);

  if (liveMatchesInterval) clearInterval(liveMatchesInterval);
  if (liveEventsInterval) clearInterval(liveEventsInterval);
  livePolling.stop();

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
