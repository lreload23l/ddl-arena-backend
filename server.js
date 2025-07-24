const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3000;

// In-memory storage
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

function sendJSON(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      callback(null, JSON.parse(body || '{}'));
    } catch (e) {
      callback(e, null);
    }
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  console.log(`${method} ${path}`);

  // Routes
  if (path === '/') {
    sendJSON(res, { message: 'DDL Arena Backend is running! 🎯' });
  }
  
  else if (path === '/health') {
    sendJSON(res, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      activeRooms: Object.keys(rooms).length,
      connectedUsers: Object.keys(users).length
    });
  }
  
  else if (path === '/api/rooms' && method === 'GET') {
    const activeRooms = Object.values(rooms).filter(room => 
      room.status !== 'completed' && 
      (Date.now() - room.created) < 24 * 60 * 60 * 1000
    );
    sendJSON(res, activeRooms);
  }
  
  else if (path === '/api/rooms' && method === 'POST') {
    parseBody(req, (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      
      const { host, gameSettings } = body;
      
      if (!host) {
        sendJSON(res, { error: 'Host name is required' }, 400);
        return;
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
      
      sendJSON(res, room);
    });
  }
  
  else if (path.startsWith('/api/rooms/') && path.endsWith('/join') && method === 'POST') {
    const code = path.split('/')[3];
    
    parseBody(req, (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      
      const { username } = body;
      
      if (!username) {
        sendJSON(res, { error: 'Username is required' }, 400);
        return;
      }
      
      const room = rooms[code];
      
      if (!room) {
        sendJSON(res, { 
          error: 'Room not found',
          availableRooms: Object.keys(rooms)
        }, 404);
        return;
      }
      
      if (room.players >= room.maxPlayers) {
        sendJSON(res, { error: 'Room is full' }, 400);
        return;
      }
      
      if (room.host === username) {
        sendJSON(res, { error: 'Cannot join your own room' }, 400);
        return;
      }
      
      if (room.status === 'playing') {
        sendJSON(res, { error: 'Game is already in progress' }, 400);
        return;
      }
      
      // Update room with opponent
      room.players = 2;
      room.status = 'ready';
      room.opponent = username;
      room.opponentId = `${username}_${Date.now()}`;
      
      console.log(`${username} joined room ${code}`);
      
      sendJSON(res, room);
    });
  }
  
  else if (path.startsWith('/api/rooms/') && method === 'DELETE') {
    const code = path.split('/')[3];
    
    if (rooms[code]) {
      console.log(`Deleting room ${code}`);
      delete rooms[code];
      sendJSON(res, { message: 'Room deleted successfully' });
    } else {
      sendJSON(res, { error: 'Room not found' }, 404);
    }
  }
  
  else {
    sendJSON(res, { error: 'Not found' }, 404);
  }
});

// Clean up old rooms every hour
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  Object.keys(rooms).forEach(code => {
    if (now - rooms[code].created > maxAge) {
      console.log('Cleaning up old room:', code);
      delete rooms[code];
    }
  });
}, 60 * 60 * 1000);

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