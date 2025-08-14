const http = require('http');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');

// Supabase initialization
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Xirsys Configuration for DDL Arena
const XIRSYS_CONFIG = {
  ident: 'ddlarena',
  secret: 'f6cd9c98-71fc-11f0-bc80-0242ac150003',
  gateway: 'global.xirsys.net',
  path: '/ddlarena'
};

// CORS configuration for your Netlify frontend
const ALLOWED_ORIGINS = [
  'https://discorddartsleagues.netlify.app',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080'
];

// Store active video rooms and users
const activeVideoRooms = new Map(); // roomId -> Set of socket IDs
const userSockets = new Map(); // socketId -> {roomId, username, isHost}
const roomLifecycle = new Map(); // roomId -> {created, lastActivity, status, participants}

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

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Database helper functions
async function updateRoomStatus(roomCode, status, participantCount) {
  try {
    if (supabase) {
      const { error } = await supabase
        .from('rooms')
        .update({
          status: status,
          players: participantCount,
          last_activity: new Date().toISOString(),
          is_live: participantCount > 0
        })
        .eq('code', roomCode);
      
      if (error) {
        console.error('Failed to update room status:', error);
      }
    } else {
      // Update in-memory storage
      if (global.rooms && global.rooms.has(roomCode)) {
        const room = global.rooms.get(roomCode);
        room.status = status;
        room.players = participantCount;
        room.last_activity = new Date().toISOString();
        room.is_live = participantCount > 0;
      }
    }
  } catch (error) {
    console.error('Error updating room status:', error);
  }
}

async function cleanupRoom(roomCode) {
  try {
    console.log(`🗑️ Cleaning up room ${roomCode}`);
    
    if (supabase) {
      const { error } = await supabase
        .from('rooms')
        .delete()
        .eq('code', roomCode);
      
      if (error) {
        console.error('Failed to cleanup room:', error);
      }
    } else {
      if (global.rooms) {
        global.rooms.delete(roomCode);
      }
    }
    
    roomLifecycle.delete(roomCode);
    
  } catch (error) {
    console.error('Error cleaning up room:', error);
  }
}

// Xirsys API Functions
async function xirsysApiCall(service, subPath = '', method = 'GET') {
  const { ident, secret, gateway, path } = XIRSYS_CONFIG;
  const fullPath = `${path}${subPath}`;
  const apiUrl = `https://${gateway}/${service}${fullPath}`;
  
  const credentials = Buffer.from(`${ident}:${secret}`).toString('base64');
  
  console.log(`🔍 Xirsys API call: ${service}${fullPath} (${method})`);
  
  try {
    const response = await fetch(apiUrl, {
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
    
    try {
      const statsData = await xirsysApiCall('_stats');
      
      if (statsData && statsData.s === 'ok') {
        if (Array.isArray(statsData.v) && statsData.v.length > 0) {
          statsData.v.forEach((stat, index) => {
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
        }
      }
    } catch (e) {
      console.log('📈 Stats processing failed:', e.message);
    }
    
    console.log(`📊 Found ${liveSessions.length} live sessions from Xirsys`);
    return liveSessions;
    
  } catch (error) {
    console.error('❌ Failed to get Xirsys live sessions:', error);
    return [];
  }
}

async function getCombinedLiveMatches() {
  try {
    let rooms = [];
    if (supabase) {
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .neq('status', 'ended')
        .order('created', { ascending: false });
      
      if (!error) {
        rooms = data || [];
      }
    } else {
      rooms = global.rooms ? Array.from(global.rooms.values()).filter(r => r.status !== 'ended') : [];
    }
    
    const xirsysLiveSessions = await getXirsysLiveSessions();
    
    const liveSessionMap = new Map();
    xirsysLiveSessions.forEach(session => {
      liveSessionMap.set(session.roomId, session);
    });
    
    const liveMatches = rooms.map(room => {
      const liveSession = liveSessionMap.get(room.code);
      const activeParticipants = activeVideoRooms.has(room.code) 
        ? activeVideoRooms.get(room.code).size 
        : 0;
      
      return {
        ...room,
        hasLiveSession: activeParticipants > 0 || !!liveSession,
        liveSession: liveSession,
        actualParticipants: activeParticipants || liveSession?.participantCount || 0,
        status: activeParticipants > 0 ? 'live' : (liveSession ? 'live' : room.status),
        xirsysStatus: liveSession ? 'connected' : 'disconnected'
      };
    });
    
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

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;
  const origin = req.headers.origin;

  console.log(`${method} ${path} from ${origin}`);

  if (method === 'OPTIONS') {
    setCORSHeaders(res, origin);
    res.writeHead(200);
    res.end();
    return;
  }

  setCORSHeaders(res, origin);

  // Root endpoint
  if (path === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>DDL Arena Backend Server</h1>
      <p>Server is running successfully.</p>
      <p>Time: ${new Date().toISOString()}</p>
      <p>Environment: ${process.env.NODE_ENV || 'development'}</p>
      <p>WebRTC Signaling: ✅ Enhanced & Fixed</p>
      <p>Xirsys Integration: ✅ Active (${XIRSYS_CONFIG.ident})</p>
      <p>Active Rooms: ${activeVideoRooms.size}</p>
      <p>Connected Users: ${userSockets.size}</p>
    `);
    return;
  }

  // Health check
  if (path === '/api/health' && method === 'GET') {
    let xirsysStatus = 'unknown';
    try {
      await xirsysApiCall('_turn');
      xirsysStatus = 'connected';
    } catch (e) {
      xirsysStatus = 'error';
    }
    
    sendJSON(res, { 
      status: 'healthy', 
      timestamp: new Date().toISOString(), 
      server: 'DDL Arena Backend',
      version: '2.0.0',
      features: ['rooms', 'webrtc-signaling-fixed', 'xirsys-integration', 'auto-cleanup'],
      xirsys: {
        status: xirsysStatus,
        ident: XIRSYS_CONFIG.ident,
        gateway: XIRSYS_CONFIG.gateway,
        path: XIRSYS_CONFIG.path
      },
      activeRooms: activeVideoRooms.size,
      connectedUsers: userSockets.size
    }, 200, origin);
    return;
  }

  // Get ICE servers from Xirsys
  if (path === '/api/ice-servers' && method === 'GET') {
    try {
      console.log('🧊 Getting ICE servers from Xirsys...');
      
      try {
        const turnData = await xirsysApiCall('_turn', '', 'PUT');
        console.log('🔄 Xirsys TURN response:', turnData);
        
        if (turnData && turnData.s === 'ok' && turnData.v && turnData.v.iceServers) {
          sendJSON(res, {
            iceServers: turnData.v.iceServers
          }, 200, origin);
          return;
        }
      } catch (e) {
        console.log('🔄 Xirsys TURN failed, using fallback:', e.message);
      }
      
      const fallbackIceServers = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
        ]
      };
      
      console.log('🧊 Using fallback ICE servers');
      sendJSON(res, fallbackIceServers, 200, origin);
      
    } catch (error) {
      console.error('❌ Error getting ICE servers:', error);
      sendJSON(res, { error: 'Failed to get ICE servers' }, 500, origin);
    }
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
      
      const endpoints = ['_ns', '_turn', '_stats'];
      
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

  // Get Xirsys live sessions
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

  // Get combined live matches
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

  // Create room endpoint (simplified - always works)
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
          created: new Date().toISOString(),
          is_live: false
        };

        console.log('Creating room:', roomData);

        // Try Supabase first, fallback to in-memory
        if (supabase) {
          try {
            const { data, error } = await supabase
              .from('rooms')
              .insert([roomData])
              .select();

            if (!error && data) {
              sendJSON(res, data[0], 201, origin);
              return;
            }
          } catch (dbError) {
            console.warn('Supabase failed, using in-memory:', dbError.message);
          }
        }
        
        // Fallback to in-memory storage
        if (!global.rooms) global.rooms = new Map();
        global.rooms.set(roomCode, roomData);
        sendJSON(res, roomData, 201, origin);

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

      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('rooms')
            .select('*')
            .neq('status', 'ended')
            .order('created', { ascending: false });

          if (!error) {
            rooms = data || [];
          }
        } catch (dbError) {
          console.warn('Supabase query failed:', dbError.message);
        }
      }
      
      if (rooms.length === 0 && global.rooms) {
        rooms = Array.from(global.rooms.values())
          .filter(room => room.status !== 'ended');
      }

      // Add real-time participant counts
      rooms = rooms.map(room => ({
        ...room,
        actualParticipants: activeVideoRooms.has(room.code) 
          ? activeVideoRooms.get(room.code).size 
          : 0,
        hasLiveSession: activeVideoRooms.has(room.code) && activeVideoRooms.get(room.code).size > 0
      }));

      sendJSON(res, rooms, 200, origin);

    } catch (error) {
      console.error('Get rooms error:', error);
      sendJSON(res, { error: 'Internal server error' }, 500, origin);
    }
    return;
  }

  // End call endpoint
  if (path === '/api/rooms/end-call' && method === 'POST') {
    parseBody(req, async (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400, origin);
        return;
      }

      try {
        const { roomCode } = body;
        
        if (!roomCode) {
          sendJSON(res, { error: 'Room code is required' }, 400, origin);
          return;
        }

        await cleanupRoom(roomCode);
        io.to(roomCode).emit('room-ended', { roomCode });
        
        sendJSON(res, { message: 'Room ended successfully' }, 200, origin);
        
      } catch (error) {
        console.error('End call error:', error);
        sendJSON(res, { error: 'Internal server error' }, 500, origin);
      }
    });
    return;
  }

  // 404 for unmatched routes
  sendJSON(res, { error: 'Not found' }, 404, origin);
});

// Socket.IO setup with FIXED signaling
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// User leave room handler
async function handleUserLeaveRoom(socket, io) {
  const userInfo = userSockets.get(socket.id);
  if (!userInfo) return;

  const { roomId, username } = userInfo;

  socket.leave(roomId);

  if (activeVideoRooms.has(roomId)) {
    activeVideoRooms.get(roomId).delete(socket.id);
    
    const remainingUsers = activeVideoRooms.get(roomId).size;
    
    if (remainingUsers === 0) {
      activeVideoRooms.delete(roomId);
      
      if (roomLifecycle.has(roomId)) {
        const lifecycle = roomLifecycle.get(roomId);
        lifecycle.status = 'ended';
        lifecycle.participants.delete(socket.id);
      }
      
      await cleanupRoom(roomId);
      console.log(`🧹 Room ${roomId} is empty - cleaned up`);
    } else {
      await updateRoomStatus(roomId, 'active', remainingUsers);
      
      if (roomLifecycle.has(roomId)) {
        const lifecycle = roomLifecycle.get(roomId);
        lifecycle.lastActivity = new Date();
        lifecycle.participants.delete(socket.id);
      }
    }
  }

  io.to(roomId).emit('user-left', {
    socketId: socket.id,
    username: username
  });

  userSockets.delete(socket.id);
  console.log(`🚪 ${username} left room ${roomId}`);
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // FIXED: Enhanced join-video-room handler
  socket.on('join-video-room', async (data) => {
    const { roomId, username, isHost } = data;
    console.log(`🎥 ${username} joining video room: ${roomId} (host: ${isHost || false})`);

    // Leave any previous rooms
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });

    // Join the new room
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;
    socket.isHost = isHost || false;

    // Track user in room
    if (!activeVideoRooms.has(roomId)) {
      activeVideoRooms.set(roomId, new Set());
    }
    activeVideoRooms.get(roomId).add(socket.id);
    userSockets.set(socket.id, { roomId, username, isHost: socket.isHost });

    // Update room lifecycle
    if (!roomLifecycle.has(roomId)) {
      roomLifecycle.set(roomId, {
        created: new Date(),
        lastActivity: new Date(),
        status: 'active',
        participants: new Set()
      });
    }
    const lifecycle = roomLifecycle.get(roomId);
    lifecycle.lastActivity = new Date();
    lifecycle.participants.add(socket.id);

    // Get all current users in room (excluding the joining user)
    const roomUsers = Array.from(activeVideoRooms.get(roomId))
      .filter(id => id !== socket.id)
      .map(id => {
        const userInfo = userSockets.get(id);
        return {
          socketId: id,
          username: userInfo?.username || 'Unknown',
          isHost: userInfo?.isHost || false
        };
      });

    console.log(`✅ ${username} joined room ${roomId}. Room has ${roomUsers.length + 1} users total`);

    // Send current room users to the new user
    socket.emit('room-users', roomUsers);

    // Notify others in room about new user
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      username: username,
      isHost: socket.isHost
    });

    // Update room status in database
    try {
      await updateRoomStatus(roomId, 'active', activeVideoRooms.get(roomId).size);
    } catch (error) {
      console.warn('Failed to update room status:', error.message);
    }
  });

  // FIXED: WebRTC offer handling
  socket.on('webrtc-offer', (data) => {
    const { targetSocketId, offer } = data;
    console.log(`📤 Routing offer from ${socket.id} to ${targetSocketId}`);
    
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    
    if (targetSocket && targetSocket.roomId === socket.roomId) {
      targetSocket.emit('webrtc-offer', {
        fromSocketId: socket.id,
        offer: offer
      });
      console.log(`✅ Offer routed successfully to ${targetSocketId}`);
    } else {
      console.warn(`❌ Failed to route offer - target ${targetSocketId} not found or not in same room`);
    }
  });

  // FIXED: WebRTC answer handling
  socket.on('webrtc-answer', (data) => {
    const { targetSocketId, answer } = data;
    console.log(`📥 Routing answer from ${socket.id} to ${targetSocketId}`);
    
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    
    if (targetSocket && targetSocket.roomId === socket.roomId) {
      targetSocket.emit('webrtc-answer', {
        fromSocketId: socket.id,
        answer: answer
      });
      console.log(`✅ Answer routed successfully to ${targetSocketId}`);
    } else {
      console.warn(`❌ Failed to route answer - target ${targetSocketId} not found`);
    }
  });

  // FIXED: ICE candidate handling
  socket.on('webrtc-ice-candidate', (data) => {
    const { targetSocketId, candidate } = data;
    console.log(`🧊 Routing ICE candidate from ${socket.id} to ${targetSocketId}`);
    
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    
    if (targetSocket && targetSocket.roomId === socket.roomId) {
      targetSocket.emit('webrtc-ice-candidate', {
        fromSocketId: socket.id,
        candidate: candidate
      });
      console.log(`✅ ICE candidate routed successfully`);
    } else {
      console.warn(`❌ Failed to route ICE candidate`);
    }
  });

  // Room ping/pong system for peer discovery
  socket.on('room-ping', (data) => {
    const { roomId, username, isHost } = data;
    console.log(`🏓 Ping in room ${roomId} from ${username}`);
    
    socket.to(roomId).emit('room-ping', {
      fromSocketId: socket.id,
      username: username,
      isHost: isHost,
      roomId: roomId
    });
    
    console.log(`🏓 Ping broadcasted to room ${roomId}`);
  });

  socket.on('room-pong', (data) => {
    const { toSocketId, username, isHost } = data;
    console.log(`🏓 Pong from ${socket.username} to ${toSocketId}`);
    
    const targetSocket = io.sockets.sockets.get(toSocketId);
    if (targetSocket) {
      targetSocket.emit('room-pong', {
        fromSocketId: socket.id,
        username: socket.username,
        isHost: socket.isHost
      });
      console.log(`✅ Pong sent to ${toSocketId}`);
    }
  });

  // Test message system for debugging
  socket.on('test-message', (data) => {
    const { roomId, message } = data;
    console.log(`🧪 Test message in room ${roomId}: ${message}`);
    
    socket.to(roomId).emit('test-message', {
      fromSocketId: socket.id,
      message: message,
      username: socket.username,
      timestamp: Date.now()
    });
  });

  // Handle disconnection and cleanup
  socket.on('disconnect', async () => {
    console.log('📴 Client disconnected:', socket.id);
    await handleUserLeaveRoom(socket, io);
  });

  socket.on('leave-video-room', async () => {
    await handleUserLeaveRoom(socket, io);
  });
});

// Periodic cleanup for stale rooms
setInterval(async () => {
  console.log('🔄 Running periodic room cleanup...');
  
  const now = Date.now();
  const STALE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  
  for (const [roomId, lifecycle] of roomLifecycle.entries()) {
    const lastActivity = lifecycle.lastActivity.getTime();
    
    if (lifecycle.status === 'ended' || 
        (lifecycle.participants.size === 0 && now - lastActivity > STALE_TIMEOUT)) {
      await cleanupRoom(roomId);
      console.log(`🧹 Cleaned up stale room: ${roomId}`);
    }
  }
  
}, 5 * 60 * 1000); // Run every 5 minutes

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DDL Arena Server v2.0 is running on port ${PORT}`);
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`🗄️ Database: ${supabase ? 'Supabase Connected' : 'In-memory fallback'}`);
  console.log(`🎥 WebRTC Signaling: ✅ FIXED & Enhanced`);
  console.log(`🎯 Xirsys Integration: ✅ Active`);
  console.log(`   - Ident: ${XIRSYS_CONFIG.ident}`);
  console.log(`   - Gateway: ${XIRSYS_CONFIG.gateway}`);
  console.log(`   - Path: ${XIRSYS_CONFIG.path}`);
  console.log(`🧹 Auto-cleanup: ✅ Enabled (5 min intervals)`);
  console.log(`🔧 Debug Features: ✅ Ping/Pong, Test Messages`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection:', err);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
