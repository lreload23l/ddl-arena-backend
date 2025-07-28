const http = require('http');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DDL Arena Server is running on port ${PORT}`);
});

// Supabase initialization
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CORS configuration for your Netlify frontend
const ALLOWED_ORIGINS = [
  'https://discorddartsleagues.netlify.app'
];

// Utility functions
function sendJSON(res, data, statusCode = 200, origin = null) {
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '*';
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
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

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;
  const origin = req.headers.origin;

  console.log(`${method} ${path}`);

  if (method === 'OPTIONS') {
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '*';
    res.writeHead(200, {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
    });
    res.end();
    return;
  }

  if (path === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>DDL Arena Backend Server</h1><p>Server is running successfully.</p>');
    return;
  }

  if (path === '/api/health' && method === 'GET') {
    sendJSON(res, { status: 'healthy', timestamp: new Date().toISOString(), server: 'DDL Arena Backend' }, 200, origin);
    return;
  }

  // Additional API routes omitted for brevity...
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

server.listen(PORT, () => {
  console.log(`🚀 DDL Arena Server is running on port ${PORT}`);
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
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
