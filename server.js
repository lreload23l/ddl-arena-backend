const http = require('http');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');

// Supabase initialization
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CORS configuration for your Netlify frontend
const ALLOWED_ORIGINS = [
  'https://discorddartsleagues.netlify.app',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080'
];

// Utility functions
function setCORSHeaders(res, origin = null) {
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function sendJSON(res, data, statusCode = 200, origin = null) {
  setCORSHeaders(res, origin);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json'
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

// Generate room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;
  const origin = req.headers.origin;

  console.log(`${method} ${path} from ${origin}`);

  // Handle preflight OPTIONS requests
  if (method === 'OPTIONS') {
    setCORSHeaders(res, origin);
    res.writeHead(200);
    res.end();
    return;
  }

  // Set CORS headers for all responses
  setCORSHeaders(res, origin);

  // Root endpoint
  if (path === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>DDL Arena Backend Server</h1>
      <p>Server is running successfully.</p>
      <p>Time: ${new Date().toISOString()}</p>
      <p>Environment: ${process.env.NODE_ENV || 'development'}</p>
    `);
    return;
  }

  // Health check endpoint
  if (path === '/api/health' && method === 'GET') {
    sendJSON(res, { 
      status: 'healthy', 
      timestamp: new Date().toISOString(), 
      server: 'DDL Arena Backend',
      version: '1.0.0'
    }, 200, origin);
    return;
  }

  // Create room endpoint
  if (path === '/api/rooms' && method === 'POST') {
    parseBody(req, async (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400, origin);
        return;
      }

      try {
        const { host, gameSettings } = body;
        
        if (!host) {
          sendJSON(res, { error: 'Host username is required' }, 400, origin);
          return;
        }

        const roomCode = generateRoomCode();
        const roomData = {
          code: roomCode,
          host: host,
          host_id: `host_${Date.now()}`,
          players: 1,
          max_players: 2,
          status: 'waiting',
          game_settings: gameSettings || {
            startingScore: 501,
            legsToWin: 3,
            setsToWin: 1,
            doubleOut: true
          },
          created: new Date().toISOString()
        };

        console.log('Creating room:', roomData);

        // Store in Supabase if available, otherwise use in-memory storage
        if (SUPABASE_URL && SUPABASE_KEY) {
          const { data, error } = await supabase
            .from('rooms')
            .insert([roomData])
            .select();

          if (error) {
            console.error('Supabase error:', error);
            sendJSON(res, { error: 'Database error' }, 500, origin);
            return;
          }

          sendJSON(res, data[0], 201, origin);
        } else {
          // In-memory storage fallback
          if (!global.rooms) global.rooms = new Map();
          global.rooms.set(roomCode, roomData);
          sendJSON(res, roomData, 201, origin);
        }

      } catch (error) {
        console.error('Create room error:', error);
        sendJSON(res, { error: 'Internal server error' }, 500, origin);
      }
    });
    return;
  }

  // Get rooms endpoint
  if (path === '/api/rooms' && method === 'GET') {
    try {
      let rooms = [];

      if (SUPABASE_URL && SUPABASE_KEY) {
        const { data, error } = await supabase
          .from('rooms')
          .select('*')
          .order('created', { ascending: false });

        if (error) {
          console.error('Supabase error:', error);
          sendJSON(res, { error: 'Database error' }, 500, origin);
          return;
        }

        rooms = data || [];
      } else {
        // In-memory storage fallback
        if (global.rooms) {
          rooms = Array.from(global.rooms.values());
        }
      }

      sendJSON(res, rooms, 200, origin);

    } catch (error) {
      console.error('Get rooms error:', error);
      sendJSON(res, { error: 'Internal server error' }, 500, origin);
    }
    return;
  }

  // Get specific room endpoint
  if (path.startsWith('/api/rooms/') && method === 'GET') {
    const roomCode = path.split('/')[3];
    
    try {
      let room = null;

      if (SUPABASE_URL && SUPABASE_KEY) {
        const { data, error } = await supabase
          .from('rooms')
          .select('*')
          .eq('code', roomCode)
          .single();

        if (error) {
          sendJSON(res, { error: 'Room not found' }, 404, origin);
          return;
        }

        room = data;
      } else {
        // In-memory storage fallback
        if (global.rooms && global.rooms.has(roomCode)) {
          room = global.rooms.get(roomCode);
        }
      }

      if (!room) {
        sendJSON(res, { error: 'Room not found' }, 404, origin);
        return;
      }

      sendJSON(res, room, 200, origin);

    } catch (error) {
      console.error('Get room error:', error);
      sendJSON(res, { error: 'Internal server error' }, 500, origin);
    }
    return;
  }

  // Join room endpoint
  if (path.startsWith('/api/rooms/') && path.endsWith('/join') && method === 'POST') {
    const roomCode = path.split('/')[3];
    
    parseBody(req, async (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400, origin);
        return;
      }

      try {
        const { username } = body;
        
        if (!username) {
          sendJSON(res, { error: 'Username is required' }, 400, origin);
          return;
        }

        let room = null;

        if (SUPABASE_URL && SUPABASE_KEY) {
          const { data, error } = await supabase
            .from('rooms')
            .select('*')
            .eq('code', roomCode)
            .single();

          if (error) {
            sendJSON(res, { error: 'Room not found' }, 404, origin);
            return;
          }

          room = data;

          // Update room with new player
          const updatedRoom = {
            ...room,
            opponent: username,
            opponent_id: `player_${Date.now()}`,
            players: 2,
            status: 'ready'
          };

          const { data: updateData, error: updateError } = await supabase
            .from('rooms')
            .update(updatedRoom)
            .eq('code', roomCode)
            .select();

          if (updateError) {
            sendJSON(res, { error: 'Failed to join room' }, 500, origin);
            return;
          }

          sendJSON(res, updateData[0], 200, origin);

        } else {
          // In-memory storage fallback
          if (!global.rooms || !global.rooms.has(roomCode)) {
            sendJSON(res, { error: 'Room not found' }, 404, origin);
            return;
          }

          room = global.rooms.get(roomCode);
          
          const updatedRoom = {
            ...room,
            opponent: username,
            opponent_id: `player_${Date.now()}`,
            players: 2,
            status: 'ready'
          };

          global.rooms.set(roomCode, updatedRoom);
          sendJSON(res, updatedRoom, 200, origin);
        }

      } catch (error) {
        console.error('Join room error:', error);
        sendJSON(res, { error: 'Internal server error' }, 500, origin);
      }
    });
    return;
  }

  // Delete room endpoint
  if (path.startsWith('/api/rooms/') && method === 'DELETE') {
    const roomCode = path.split('/')[3];
    
    try {
      if (SUPABASE_URL && SUPABASE_KEY) {
        const { error } = await supabase
          .from('rooms')
          .delete()
          .eq('code', roomCode);

        if (error) {
          sendJSON(res, { error: 'Failed to delete room' }, 500, origin);
          return;
        }
      } else {
        // In-memory storage fallback
        if (global.rooms) {
          global.rooms.delete(roomCode);
        }
      }

      sendJSON(res, { message: 'Room deleted' }, 200, origin);

    } catch (error) {
      console.error('Delete room error:', error);
      sendJSON(res, { error: 'Internal server error' }, 500, origin);
    }
    return;
  }

  // 404 for unmatched routes
  sendJSON(res, { error: 'Not found' }, 404, origin);
});

// Attach Socket.IO to the HTTP server
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

io.on('connection', socket => {
  console.log('🔌 WebRTC client connected:', socket.id);

  socket.on('join-room', roomCode => {
    socket.join(roomCode);
    socket.to(roomCode).emit('user-joined', socket.id);
  });

  socket.on('signal', ({ roomCode, data }) => {
    socket.to(roomCode).emit('signal', { sender: socket.id, data });
  });

  socket.on('disconnect', () => {
    console.log('❌ WebRTC client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DDL Arena Server is running on port ${PORT}`);
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`🗄️ Database: ${SUPABASE_URL ? 'Supabase' : 'In-memory (fallback)'}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
