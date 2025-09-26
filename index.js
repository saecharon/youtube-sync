require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const { Server } = require('socket.io');
const winston = require('winston');
const { createAdapter } = require('@socket.io/redis-adapter');
const IORedis = require('ioredis');

const app = express();
const server = http.createServer(app);

// Logging
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level}] ${message}${extra}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

// Security & middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Healthcheck
app.get('/health', (req, res) => res.status(200).send('OK'));

// Static files
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

const PORT = process.env.PORT || 3000;

// Socket.IO
const io = new Server(server, {
  transports: ['websocket'], // prefer true WebSocket
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Optional Redis adapter
if (process.env.REDIS_URL) {
  try {
    const pubClient = new IORedis(process.env.REDIS_URL, { lazyConnect: true });
    const subClient = pubClient.duplicate();
    Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        logger.info('Socket.IO Redis adapter enabled');
      })
      .catch((err) => logger.error('Failed to connect to Redis', { err: String(err) }));
  } catch (err) {
    logger.error('Error initializing Redis adapter', { err: String(err) });
  }
}

// In-memory room state (fallback if not using Redis persistence)
// Structure: rooms[roomCode] = { hostId, videoId, playbackState, playbackTime, users: { socketId: { username } } }
const rooms = {};

io.on('connection', (socket) => {
  logger.info('Socket connected', { socketId: socket.id });

  socket.on('disconnect', (reason) => {
    logger.info('Socket disconnected', { socketId: socket.id, reason });
    // clean up user from any room
    const roomCode = socket.data?.roomCode;
    if (roomCode && rooms[roomCode]) {
      delete rooms[roomCode].users[socket.id];
      // If host disconnected, clear host; next joiner can be promoted by UI
      if (rooms[roomCode].hostId === socket.id) {
        rooms[roomCode].hostId = null;
        io.to(roomCode).emit('host_left');
      }
      io.to(roomCode).emit('room_users', { users: Object.values(rooms[roomCode].users) });
    }
  });

  // Join room
  socket.on('join_room', ({ roomCode, username, asHost }) => {
    try {
      if (!roomCode || !username) {
        socket.emit('error_message', { message: 'roomCode and username required' });
        return;
      }
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.username = username;

      if (!rooms[roomCode]) {
        rooms[roomCode] = {
          hostId: null,
          videoId: null,
          playbackState: 'paused',
          playbackTime: 0,
          users: {},
        };
      }

      rooms[roomCode].users[socket.id] = { username };
      if (asHost || !rooms[roomCode].hostId) {
        rooms[roomCode].hostId = socket.id;
        socket.emit('host_confirmed');
        logger.info('Host set', { roomCode, hostId: socket.id, username });
      }

      logger.info('User joined room', { roomCode, username, socketId: socket.id });
      io.to(roomCode).emit('room_users', { users: Object.values(rooms[roomCode].users) });

      // Send current state to the joiner
      const state = {
        hostId: rooms[roomCode].hostId,
        videoId: rooms[roomCode].videoId,
        playbackState: rooms[roomCode].playbackState,
        playbackTime: rooms[roomCode].playbackTime,
        serverTime: Date.now(),
      };
      socket.emit('room_state', state);
    } catch (err) {
      logger.error('join_room error', { err: String(err) });
      socket.emit('error_message', { message: 'Failed to join room' });
    }
  });

  // Host actions: load/play/pause/seek/heartbeat
  socket.on('host_action', (payload) => {
    try {
      const { type, roomCode, videoId, time, state, hostTime } = payload || {};
      if (!roomCode || !rooms[roomCode]) return;
      if (rooms[roomCode].hostId !== socket.id) return; // only host can broadcast

      // Update server-side snapshot
      if (type === 'load' && videoId) {
        rooms[roomCode].videoId = videoId;
      }
      if (typeof time === 'number') {
        rooms[roomCode].playbackTime = time;
      }
      if (state) {
        rooms[roomCode].playbackState = state;
      }

      const message = { type, videoId, time, state, hostTime: hostTime || Date.now() };
      socket.to(roomCode).emit('host_action', message);
      logger.info('Host action', { roomCode, type, time, state, videoId });
    } catch (err) {
      logger.error('host_action error', { err: String(err) });
    }
  });

  // Chat
  socket.on('chat_message', ({ roomCode, username, message }) => {
    try {
      if (!roomCode || !message) return;
      const safeUsername = username || socket.data?.username || 'anon';
      io.to(roomCode).emit('chat_message', {
        username: safeUsername,
        message: String(message).slice(0, 1000),
        ts: Date.now(),
      });
    } catch (err) {
      logger.error('chat_message error', { err: String(err) });
    }
  });

  // RTT ping/pong
  socket.on('rtt_ping', ({ ts }) => {
    socket.emit('rtt_pong', { ts, serverTime: Date.now() });
  });
});

server.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`, { env: process.env.NODE_ENV || 'development' });
});
