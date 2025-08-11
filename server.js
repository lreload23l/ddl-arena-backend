const http = require('http');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');

// Supabase initialization
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Xirsys Configuration for DDL Arena
const XIRSYS_CONFIG = {
  ident: 'ddlarena',
  secret: 'f6cd9c98-71fc-11f0-bc80-0242ac150003',
  gateway: 'global.xirsys.net',
  path: '/ddlarena'  // Simplified path - let Xirsys create default structure
};

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

// Xirsys API Functions
async function xirsysApiCall(service, subPath = '', method = 'GET') {
  const { ident, secret, gateway, path } = XIRSYS_CONFIG;
  const fullPath = `${path}${subPath}`;
  const url = `https://${gateway}/${service}${fullPath}`;
  
  // Create Basic Auth header
  const credentials = Buffer.from(`${ident}:${secret}`).toString('base64');
  
  console.log(`🔍 Making Xirsys API call to: ${service}${fullPath} (${method})`);
  
  try {
    const response = await fetch(url, {
      method: method,
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Xirsys API error: ${response.status} - ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log(`✅ Xirsys ${service} response:`, data);
    return data;
    
  } catch (error) {
    console.error(`❌ Xirsys API call failed for ${service}:`, error.message);
    throw error;
  }
}

async function getXirsysLiveSessions() {
  try {
    console.log('🔍 Fetching Xirsys live sessions...');
    
    let liveSessions = [];
    
    // First, try to ensure the namespace exists
    try {
      console.log('🏗️ Ensuring Xirsys namespace exists...');
      const createNs = await xirsysApiCall('_ns', '', 'PUT');
      console.log('🏗️ Namespace creation result:', createNs);
    } catch (e) {
      console.log('🏗️ Namespace creation skipped:', e.message);
    }
    
    // Method 1: Check TURN service activity (most reliable for active calls)
    try {
      const turnData = await xirsysApiCall('_turn');
      console.log('🔄 TURN data:', turnData);
      if (turnData && turnData.s === 'ok' && turnData.v) {
        // TURN service shows active ICE sessions
        if (turnData.v.iceServers || turnData.v.length > 0) {
          console.log('🔄 TURN service indicates potential active sessions');
        }
      }
    } catch (e) {
      console.log('🔄 TURN endpoint not accessible:', e.message);
    }
    
    // Method 2: Check stats for any activity
    try {
      const statsData = await xirsysApiCall('_stats');
      console.log('📈 Full stats response:', JSON.stringify(statsData, null, 2));
      
      if (statsData && statsData.s === 'ok') {
        if (Array.isArray(statsData.v) && statsData.v.length > 0) {
          // Process stats data
          statsData.v.forEach((stat, index) => {
            console.log(`📊 Stat ${index}:`, stat);
            if (stat && (stat.active > 0 || stat.sessions > 0 || stat.users > 0)) {
              liveSessions.push({
                roomId: stat.path || stat.channel || `session_${index}`,
                roomCode: stat.path || stat.channel || `session_${index}`,
                participants: [],
                participantCount: stat.active || stat.users || 1,
                status: 'live',
                type: 'webrtc_call',
                startTime: new Date().toISOString(),
                platform: 'xirsys',
                lastUpdated: new Date().toISOString(),
                statData: stat
              });
            }
          });
        } else if (statsData.v && typeof statsData.v === 'object') {
          // Handle object format stats
          Object.keys(statsData.v).forEach(key => {
            const value = statsData.v[key];
            console.log(`📊 Stats key ${key}:`, value);
            if (value && value > 0) {
              liveSessions.push({
                roomId: key,
                roomCode: key,
                participants: [],
                participantCount: value,
                status: 'live',
                type: 'webrtc_call',
                startTime: new Date().toISOString(),
                platform: 'xirsys',
                lastUpdated: new Date().toISOString()
              });
            }
          });
        }
      }
    } catch (e) {
      console.log('📈 Stats processing failed:', e.message);
    }
    
    // Method 3: Try simpler namespace check
    try {
      const nsData = await xirsysApiCall('_ns', '');
      console.log('🗂️ Root namespace check:', nsData);
    } catch (e) {
      console.log('🗂️ Root namespace error:', e.message);
    }
    
    console.log(`📊 Found ${liveSessions.length} live sessions from Xirsys`);
    
    // For testing: Create a mock session when your match.html is used
    if (liveSessions.length === 0) {
      console.log('🧪 No live sessions detected - this is normal if no video calls are active');
    }
    
    return liveSessions;
    
  } catch (error) {
    console.error('❌ Failed to get Xirsys live sessions:', error);
    return [];
  }
}

function processXirsysData(subsData, statsData) {
  const liveSessions = [];
  
  if (subsData && subsData.s === 'ok' && subsData.v) {
    const subscriptionData = subsData.v;
    
    if (typeof subscriptionData === 'object') {
      Object.keys(subscriptionData).forEach(roomKey => {
        const roomData = subscriptionData[roomKey];
        
        if (roomData && typeof roomData === 'object') {
          const participants = Object.keys(roomData).map(userId => ({
            userId: userId,
            socketId: userId,
            connectionTime: roomData[userId]?.connected || new Date().toISOString(),
            connectionInfo: roomData[userId]
          }));
          
          if (participants.length > 0) {
            liveSessions.push({
              roomId: roomKey,
              roomCode: roomKey,
              participants: participants,
              participantCount: participants.length,
              status: 'live',
              type: 'webrtc_call',
              startTime: new Date().toISOString(),
              platform: 'xirsys',
              lastUpdated: new Date().toISOString()
            });
          }
        }
      });
    }
  }
  
  return liveSessions;
}

async function getCombinedLiveMatches() {
  try {
    // Get your local rooms
    let rooms = [];
    if (SUPABASE_URL && SUPABASE_KEY) {
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .order('created', { ascending: false });
      
      if (!error) {
        rooms = data || [];
      }
    } else {
      rooms = global.rooms ? Array.from(global.rooms.values()) : [];
    }
    
    // Get live Xirsys sessions
    const xirsysLiveSessions = await getXirsysLiveSessions();
    
    // Create a map of live sessions by room code
    const liveSessionMap = new Map();
    xirsysLiveSessions.forEach(session => {
      liveSessionMap.set(session.roomId, session);
    });
    
    // Merge room data with live session data
    const liveMatches = rooms.map(room => {
      const liveSession = liveSessionMap.get(room.code);
      
      return {
        ...room,
        hasLiveSession: !!liveSession,
        liveSession: liveSession,
        actualParticipants: liveSession?.participantCount || 0,
        status: liveSession ? 'live' : room.status,
        xirsysStatus: liveSession ? 'connected' : 'disconnected'
      };
    });
    
    // Also include Xirsys sessions that don't match existing rooms
    xirsysLiveSessions.forEach(session => {
      const existingRoom = rooms.find(room => room.code === session.roomId);
      if (!existingRoom) {
        liveMatches.push({
          code: session.roomId,
          host: 'Unknown',
          opponent: session.participantCount > 1 ? 'Unknown' : null,
          players: session.participantCount,
          max_players: 4,
          status: 'live',
          created: session.startTime,
          hasLiveSession: true,
          liveSession: session,
          actualParticipants: session.participantCount,
          xirsysStatus: 'connected',
          isXirsysOnly: true
        });
      }
    });
    
    return liveMatches;
    
  } catch (error) {
    console.error('❌ Error getting combined live matches:', error);
    throw error;
  }
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
      <p>WebRTC Signaling: ✅ Enabled</p>
      <p>Xirsys Integration: ✅ Active (${XIRSYS_CONFIG.ident})</p>
    `);
    return;
  }

  // Enhanced health check endpoint with Xirsys status
  if (path === '/api/health' && method === 'GET') {
    let xirsysStatus = 'unknown';
    try {
      await xirsysApiCall('_subs');
      xirsysStatus = 'connected';
    } catch (e) {
      xirsysStatus = 'error';
    }
    
    sendJSON(res, { 
      status: 'healthy', 
      timestamp: new Date().toISOString(), 
      server: 'DDL Arena Backend',
      version: '1.0.0',
      features: ['rooms', 'webrtc-signaling', 'xirsys-integration'],
      xirsys: {
        status: xirsysStatus,
        ident: XIRSYS_CONFIG.ident,
        gateway: XIRSYS_CONFIG.gateway,
        path: XIRSYS_CONFIG.path
      }
    }, 200, origin);
    return;
  }

  // Test Xirsys connection
  if (path === '/api/xirsys/test' && method === 'GET') {
    try {
      console.log('🧪 Testing Xirsys connection...');
      
      const testResult = {
        config: {
          ident: XIRSYS_CONFIG.ident,
          gateway: XIRSYS_CONFIG.gateway,
          path: XIRSYS_CONFIG.path
        },
        timestamp: new Date().toISOString()
      };
      
      // Test different endpoints to find what works
      const endpoints = ['_ns', '_data', '_host', '_stats', '_turn'];
      
      for (const endpoint of endpoints) {
        try {
          const data = await xirsysApiCall(endpoint);
          testResult[`${endpoint}Test`] = { success: true, data: data };
        } catch (e) {
          testResult[`${endpoint}Test`] = { success: false, error: e.message };
        }
      }
      
      sendJSON(res, testResult, 200, origin);
      
    } catch (error) {
      console.error('❌ Xirsys test failed:', error);
      sendJSON(res, { error: 'Xirsys test failed', details: error.message }, 500, origin);
    }
    return;
  }

  // Get live Xirsys sessions only
  if (path === '/api/xirsys/live-sessions' && method === 'GET') {
    try {
      const liveSessions = await getXirsysLiveSessions();
      sendJSON(res, liveSessions, 200, origin);
    } catch (error) {
      console.error('❌ Error fetching Xirsys live sessions:', error);
      sendJSON(res, { error: 'Failed to fetch live sessions', details: error.message }, 500, origin);
    }
    return;
  }

  // Get combined live matches (your rooms + Xirsys data)
  if (path === '/api/live-matches' && method === 'GET') {
    try {
      const liveMatches = await getCombinedLiveMatches();
      sendJSON(res, liveMatches, 200, origin);
    } catch (error) {
      console.error('❌ Error fetching live matches:', error);
      sendJSON(res, { error: 'Failed to fetch live matches', details: error.message }, 500, origin);
    }
    return;
  }

  // Check specific room status in Xirsys
  if (path.startsWith('/api/xirsys/room/') && method === 'GET') {
    const roomId = path.split('/')[4];
    
    try {
      const roomData = await xirsysApiCall('_subs', `/${roomId}`);
      const isLive = roomData && roomData.v && Object.keys(roomData.v || {}).length > 0;
      
      sendJSON(res, {
        roomId: roomId,
        isLive: isLive,
        participants: isLive ? Object.keys(roomData.v || {}) : [],
        participantCount: isLive ? Object.keys(roomData.v || {}).length : 0,
        xirsysData: roomData
      }, 200, origin);
      
    } catch (error) {
      console.error(`❌ Error checking room ${roomId} status:`, error);
      sendJSON(res, { error: 'Failed to check room status', details: error.message }, 500, origin);
    }
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

// Enhanced Socket.IO setup with WebRTC signaling
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Store active video rooms and users
const activeVideoRooms = new Map();
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Legacy room functionality (keep for compatibility)
  socket.on('join-room', roomCode => {
    console.log(`📱 Legacy join-room: ${socket.id} -> ${roomCode}`);
    socket.join(roomCode);
    socket.to(roomCode).emit('user-joined', socket.id);
  });

  socket.on('signal', ({ roomCode, data }) => {
    console.log(`📡 Legacy signal: ${socket.id} -> ${roomCode}`);
    socket.to(roomCode).emit('signal', { sender: socket.id, data });
  });

  // Enhanced WebRTC video room functionality
  socket.on('join-video-room', (data) => {
    const { roomId, username } = data;
    console.log(`🎥 ${username} joining video room: ${roomId}`);

    // Leave any previous room
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });

    // Join the new room
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;

    // Track user in room
    if (!activeVideoRooms.has(roomId)) {
      activeVideoRooms.set(roomId, new Set());
    }
    activeVideoRooms.get(roomId).add(socket.id);
    userSockets.set(socket.id, { roomId, username });

    // Notify others in room
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      username: username
    });

    // Send current room users to the new user
    const roomUsers = Array.from(activeVideoRooms.get(roomId))
      .filter(id => id !== socket.id)
      .map(id => ({
        socketId: id,
        username: userSockets.get(id)?.username
      }));

    socket.emit('room-users', roomUsers);

    console.log(`✅ ${username} joined room ${roomId}. Total users: ${activeVideoRooms.get(roomId).size}`);
  });

  // WebRTC offer handling
  socket.on('webrtc-offer', (data) => {
    const { targetSocketId, offer } = data;
    console.log(`📤 Relaying offer from ${socket.id} to ${targetSocketId}`);

    socket.to(targetSocketId).emit('webrtc-offer', {
      fromSocketId: socket.id,
      offer: offer
    });
  });

  // WebRTC answer handling
  socket.on('webrtc-answer', (data) => {
    const { targetSocketId, answer } = data;
    console.log(`📥 Relaying answer from ${socket.id} to ${targetSocketId}`);

    socket.to(targetSocketId).emit('webrtc-answer', {
      fromSocketId: socket.id,
      answer: answer
    });
  });

  // ICE candidate handling
  socket.on('webrtc-ice-candidate', (data) => {
    const { targetSocketId, candidate } = data;
    console.log(`🧊 Relaying ICE candidate from ${socket.id} to ${targetSocketId}`);

    socket.to(targetSocketId).emit('webrtc-ice-candidate', {
      fromSocketId: socket.id,
      candidate: candidate
    });
  });

  // Generic WebRTC signal handling (for flexibility)
  socket.on('webrtc-signal', (data) => {
    const { targetSocketId, signal, type } = data;
    console.log(`📡 Relaying ${type} signal from ${socket.id} to ${targetSocketId}`);

    socket.to(targetSocketId).emit('webrtc-signal', {
      fromSocketId: socket.id,
      signal: signal,
      type: type
    });
  });

  // Handle explicit leave room
  socket.on('leave-video-room', () => {
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId, username } = userInfo;

      socket.leave(roomId);

      // Remove from tracking
      if (activeVideoRooms.has(roomId)) {
        activeVideoRooms.get(roomId).delete(socket.id);
        if (activeVideoRooms.get(roomId).size === 0) {
          activeVideoRooms.delete(roomId);
        }
      }

      // Notify others
      socket.to(roomId).emit('user-left', {
        socketId: socket.id,
        username: username
      });

      userSockets.delete(socket.id);
      console.log(`🚪 ${username} explicitly left room ${roomId}`);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('📴 Client disconnected:', socket.id);

    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId, username } = userInfo;

      // Remove user from room tracking
      if (activeVideoRooms.has(roomId)) {
        activeVideoRooms.get(roomId).delete(socket.id);
        if (activeVideoRooms.get(roomId).size === 0) {
          activeVideoRooms.delete(roomId);
        }
      }

      // Notify others in room
      socket.to(roomId).emit('user-left', {
        socketId: socket.id,
        username: username
      });

      userSockets.delete(socket.id);
      console.log(`👋 ${username} disconnected from room ${roomId}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DDL Arena Server is running on port ${PORT}`);
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`🗄️ Database: ${SUPABASE_URL ? 'Supabase' : 'In-memory (fallback)'}`);
  console.log(`🎥 WebRTC Signaling: ✅ Enhanced & Ready`);
  console.log(`🎯 Xirsys Integration: ✅ Active`);
  console.log(`   - Ident: ${XIRSYS_CONFIG.ident}`);
  console.log(`   - Gateway: ${XIRSYS_CONFIG.gateway}`);
  console.log(`   - Path: ${XIRSYS_CONFIG.path}`);
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
