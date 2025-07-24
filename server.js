const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://your-frontend-domain.com'] 
      : ['http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1:5500'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://your-frontend-domain.com'] 
    : ['http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1:5500'],
  credentials: true
}));
app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'public')));
}

const PORT = process.env.PORT || 3000;

// In-memory storage (in production, use a real database)
let rooms = {};
let users = {};

// Utility functions
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  do {
    result = '';
    for (let i = 0; i < 5; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[result]);
  return result;
}

function cleanupOldRooms() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  Object.keys(rooms).forEach(code => {
    if (now - rooms[code].created > maxAge) {
      console.log('Cleaning up old room:', code);
      delete rooms[code];
    }
  });
}

// Run cleanup every hour
setInterval(cleanupOldRooms, 60 * 60 * 1000);

// API Routes
app.get('/', (req, res) => {
  res.send('DDL Arena Backend is running! 🎯');
});

// Get all active rooms
app.get('/api/rooms', (req, res) => {
  const activeRooms = Object.values(rooms).filter(room => 
    room.status !== 'completed' && 
    (Date.now() - room.created) < 24 * 60 * 60 * 1000
  );
  
  console.log(`Sending ${activeRooms.length} active rooms`);
  res.json(activeRooms);
});

// Create a new room
app.post('/api/rooms', (req, res) => {
  const { host, gameSettings } = req.body;
  
  if (!host) {
    return res.status(400).json({ error: 'Host name is required' });
  }
  
  const roomCode = generateRoomCode();
  const room = {
    code: roomCode,
    host: host,
    hostId: `${host}_${Date.now()}`,
    created: Date.now(),
    status: 'waiting',
    players: 1,
    maxPlayers: 2,
    gameSettings: gameSettings || {
      mode: '501',
      startingScore: 501,
      legsToWin: 3,
      setsToWin: 1,
      doubleOut: true,
      doubleIn: false,
      masterOut: false
    },
    opponent: null,
    opponentId: null
  };
  
  rooms[roomCode] = room;
  console.log(`Room ${roomCode} created by ${host}`);
  
  // Broadcast new room to all connected clients
  io.emit('roomCreated', room);
  
  res.json(room);
});

// Join a room
app.post('/api/rooms/:code/join', (req, res) => {
  const { code } = req.params;
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  const room = rooms[code];
  
  if (!room) {
    return res.status(404).json({ 
      error: 'Room not found',
      availableRooms: Object.keys(rooms)
    });
  }
  
  if (room.players >= room.maxPlayers) {
    return res.status(400).json({ error: 'Room is full' });
  }
  
  if (room.host === username) {
    return res.status(400).json({ error: 'Cannot join your own room' });
  }
  
  if (room.status === 'playing') {
    return res.status(400).json({ error: 'Game is already in progress' });
  }
  
  // Update room with opponent
  room.players = 2;
  room.status = 'ready';
  room.opponent = username;
  room.opponentId = `${username}_${Date.now()}`;
  
  console.log(`${username} joined room ${code}`);
  
  // Broadcast room update to all clients
  io.emit('roomUpdated', room);
  
  // Notify room participants
  io.to(code).emit('playerJoined', {
    username,
    room: room
  });
  
  res.json(room);
});

// Get specific room
app.get('/api/rooms/:code', (req, res) => {
  const { code } = req.params;
  const room = rooms[code];
  
  if (!room) {
    return res.status(404).json({ 
      error: 'Room not found',
      availableRooms: Object.keys(rooms)
    });
  }
  
  res.json(room);
});

// Update room status (for game start/end)
app.put('/api/rooms/:code/status', (req, res) => {
  const { code } = req.params;
  const { status } = req.body;
  
  const room = rooms[code];
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  room.status = status;
  console.log(`Room ${code} status updated to ${status}`);
  
  // Broadcast room update
  io.emit('roomUpdated', room);
  
  res.json(room);
});

// Delete/cleanup room
app.delete('/api/rooms/:code', (req, res) => {
  const { code } = req.params;
  
  if (rooms[code]) {
    console.log(`Deleting room ${code}`);
    delete rooms[code];
    
    // Broadcast room deletion
    io.emit('roomDeleted', code);
    
    res.json({ message: 'Room deleted successfully' });
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);
  
  // Store user info
  users[socket.id] = {
    id: socket.id,
    connectedAt: Date.now()
  };
  
  // Send current rooms to newly connected client
  socket.emit('roomsList', Object.values(rooms));
  
  // Join a specific room
  socket.on('joinRoom', (data) => {
    const { roomCode, username } = data;
    
    if (!rooms[roomCode]) {
      socket.emit('joinError', 'Room not found');
      return;
    }
    
    socket.join(roomCode);
    users[socket.id].currentRoom = roomCode;
    users[socket.id].username = username;
    
    console.log(`User ${username} (${socket.id}) joined room ${roomCode}`);
    
    // Notify others in the room
    socket.to(roomCode).emit('playerJoined', {
      username,
      socketId: socket.id
    });
    
    // Send room data to joining user
    socket.emit('roomJoined', rooms[roomCode]);
  });
  
  // Handle game state updates
  socket.on('gameStateUpdate', (data) => {
    const { roomCode, gameState } = data;
    
    if (rooms[roomCode]) {
      // Update room's game state
      rooms[roomCode].gameState = gameState;
      
      // Broadcast to all players in the room
      socket.to(roomCode).emit('gameStateUpdated', gameState);
    }
  });
  
  // Handle score updates
  socket.on('scoreUpdate', (data) => {
    const { roomCode, playerData, score, remaining } = data;
    
    console.log(`Score update in room ${roomCode}: ${playerData.name} scored ${score}, ${remaining} remaining`);
    
    // Broadcast to all players in the room
    socket.to(roomCode).emit('scoreUpdated', {
      player: playerData,
      score,
      remaining,
      timestamp: Date.now()
    });
  });
  
  // Handle WebRTC signaling
  socket.on('webrtc-offer', (data) => {
    const { roomCode, offer, targetSocketId } = data;
    
    if (targetSocketId) {
      // Send to specific user
      socket.to(targetSocketId).emit('webrtc-offer', {
        offer,
        fromSocketId: socket.id
      });
    } else {
      // Broadcast to room
      socket.to(roomCode).emit('webrtc-offer', {
        offer,
        fromSocketId: socket.id
      });
    }
  });
  
  socket.on('webrtc-answer', (data) => {
    const { answer, targetSocketId } = data;
    
    socket.to(targetSocketId).emit('webrtc-answer', {
      answer,
      fromSocketId: socket.id
    });
  });
  
  socket.on('webrtc-ice-candidate', (data) => {
    const { candidate, targetSocketId, roomCode } = data;
    
    if (targetSocketId) {
      socket.to(targetSocketId).emit('webrtc-ice-candidate', {
        candidate,
        fromSocketId: socket.id
      });
    } else {
      socket.to(roomCode).emit('webrtc-ice-candidate', {
        candidate,
        fromSocketId: socket.id
      });
    }
  });
  
  // Handle game events
  socket.on('gameEvent', (data) => {
    const { roomCode, eventType, eventData } = data;
    
    console.log(`Game event in room ${roomCode}: ${eventType}`);
    
    // Broadcast game event to room
    socket.to(roomCode).emit('gameEvent', {
      eventType,
      eventData,
      timestamp: Date.now()
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    const user = users[socket.id];
    if (user && user.currentRoom) {
      const roomCode = user.currentRoom;
      
      // Notify others in the room
      socket.to(roomCode).emit('playerDisconnected', {
        username: user.username,
        socketId: socket.id
      });
      
      // Update room if this was a player
      const room = rooms[roomCode];
      if (room) {
        if (room.host === user.username || room.opponent === user.username) {
          // If a game participant left, mark room for cleanup
          room.status = 'abandoned';
          setTimeout(() => {
            if (rooms[roomCode] && rooms[roomCode].status === 'abandoned') {
              console.log(`Cleaning up abandoned room: ${roomCode}`);
              delete rooms[roomCode];
              io.emit('roomDeleted', roomCode);
            }
          }, 30000); // 30 seconds grace period
        }
      }
    }
    
    delete users[socket.id];
  });
  
  // Handle ping for connection testing
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeRooms: Object.keys(rooms).length,
    connectedUsers: Object.keys(users).length
  });
});

// Debug endpoint (remove in production)
app.get('/debug', (req, res) => {
  res.json({
    rooms: rooms,
    users: users,
    nodeEnv: process.env.NODE_ENV
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 DDL Arena Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

module.exports = { app, server, io };