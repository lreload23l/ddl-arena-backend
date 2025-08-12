// server.js

const http = require('http');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');

// Supabase initialization
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Xirsys Configuration
const XIRSYS_CONFIG = {
  ident: 'ddlarena',
  secret: 'f6cd9c98-71fc-11f0-bc80-0242ac150003',
  gateway: 'global.xirsys.net',
  path: '/ddlarena'
};

// Allowed CORS Origins
const ALLOWED_ORIGINS = [
  'https://discorddartsleagues.netlify.app',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080'
];

function setCORSHeaders(res, origin = null) {
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function sendJSON(res, data, statusCode = 200, origin = null) {
  setCORSHeaders(res, origin);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req, callback) {
  let body = '';
  req.on('data', chunk => (body += chunk.toString()));
  req.on('end', () => {
    try {
      callback(null, JSON.parse(body || '{}'));
    } catch (e) {
      callback(e, null);
    }
  });
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

const activeVideoRooms = new Map();
const userSockets = new Map();
const roomLifecycle = new Map();

// Xirsys API Call
async function xirsysApiCall(service, subPath = '', method = 'GET') {
  const { ident, secret, gateway, path } = XIRSYS_CONFIG;
  const fullPath = `${path}${subPath}`;
  const apiUrl = `https://${gateway}/${service}${fullPath}`;
  const credentials = Buffer.from(`${ident}:${secret}`).toString('base64');

  try {
    const response = await fetch(apiUrl, {
      method,
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Xirsys API error: ${response.status} - ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`❌ Xirsys API call failed (${service}):`, error.message);
    throw error;
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;
  const origin = req.headers.origin;

  if (method === 'OPTIONS') {
    setCORSHeaders(res, origin);
    res.writeHead(200);
    res.end();
    return;
  }

  setCORSHeaders(res, origin);

  // Health check
  if (path === '/api/health' && method === 'GET') {
    let xirsysStatus = 'unknown';
    try {
      await xirsysApiCall('_turn');
      xirsysStatus = 'connected';
    } catch {
      xirsysStatus = 'error';
    }

    sendJSON(res, { status: 'healthy', xirsysStatus }, 200, origin);
    return;
  }

  // Get ICE servers (Xirsys-first)
  if (path === '/api/ice-servers' && method === 'GET') {
    try {
      let iceData;
      try {
        console.log('🧊 Fetching ICE servers from Xirsys...');
        iceData = await xirsysApiCall('_turn', '', 'PUT');
        if (iceData?.s === 'ok' && iceData.v?.iceServers) {
          sendJSON(res, { iceServers: iceData.v.iceServers }, 200, origin);
          return;
        }
      } catch (e) {
        console.error('Xirsys TURN fetch failed, using fallback:', e.message);
      }

      const fallbackIceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ];

      sendJSON(res, { iceServers: fallbackIceServers }, 200, origin);
    } catch (error) {
      sendJSON(res, { error: 'Failed to get ICE servers' }, 500, origin);
    }
    return;
  }

  sendJSON(res, { error: 'Not Found' }, 404, origin);
});

// WebSocket / Socket.IO
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

io.on('connection', socket => {
  console.log('🔌 Client connected:', socket.id);

  socket.on('join-video-room', ({ roomId, username }) => {
    socket.join(roomId);
    if (!activeVideoRooms.has(roomId)) {
      activeVideoRooms.set(roomId, new Set());
    }
    activeVideoRooms.get(roomId).add(socket.id);
    userSockets.set(socket.id, { roomId, username });
    socket.to(roomId).emit('user-joined', { socketId: socket.id, username });
  });

  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    socket.to(targetSocketId).emit('webrtc-offer', { fromSocketId: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    socket.to(targetSocketId).emit('webrtc-answer', { fromSocketId: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    socket.to(targetSocketId).emit('webrtc-ice-candidate', { fromSocketId: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId } = userInfo;
      activeVideoRooms.get(roomId)?.delete(socket.id);
      socket.to(roomId).emit('user-left', { socketId: socket.id });
      userSockets.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
