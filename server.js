// server.js - DDL Arena backend (updated Xirsys + improvements)
const http = require('http');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const crypto = require('crypto');

// Supabase initialization (optional)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ---------- XIRSYS CONFIG (use env vars - DO NOT commit secrets) ----------
const XIRSYS_IDENT = process.env.XIRSYS_IDENT || 'ddlarena';
const XIRSYS_SECRET = process.env.XIRSYS_SECRET || ''; // REQUIRED in env for production
const XIRSYS_GATEWAY = process.env.XIRSYS_GATEWAY || 'global.xirsys.net';
const XIRSYS_PATH = process.env.XIRSYS_PATH || '/ddlarena';

// ---------- CORS ----------
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
    try { callback(null, JSON.parse(body || '{}')); }
    catch (e) { callback(e, null); }
  });
}

// ---------- Rooms / tracking ----------
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}
const activeVideoRooms = new Map();
const userSockets = new Map();
const roomLifecycle = new Map();

// ---------- DB helpers ----------
async function updateRoomStatus(roomCode, status, participantCount) {
  try {
    if (supabase) {
      const { error } = await supabase
        .from('rooms')
        .update({
          status,
          players: participantCount,
          last_activity: new Date().toISOString(),
          is_live: participantCount > 0
        })
        .eq('code', roomCode);
      if (error) console.error('Failed to update room status:', error);
    } else {
      if (global.rooms && global.rooms.has(roomCode)) {
        const room = global.rooms.get(roomCode);
        room.status = status;
        room.players = participantCount;
        room.last_activity = new Date().toISOString();
        room.is_live = participantCount > 0;
      }
    }
  } catch (error) { console.error('Error updating room status:', error); }
}
async function cleanupRoom(roomCode) {
  try {
    console.log(`🗑️ Cleaning up room ${roomCode}`);
    if (supabase) {
      const { error } = await supabase.from('rooms').delete().eq('code', roomCode);
      if (error) console.error('Failed to cleanup room:', error);
    } else {
      if (global.rooms) global.rooms.delete(roomCode);
    }
    roomLifecycle.delete(roomCode);
  } catch (error) { console.error('Error cleaning up room:', error); }
}
async function handleUserLeaveRoom(socket, io) {
  const userInfo = userSockets.get(socket.id);
  if (!userInfo) return;
  const { roomId, username } = userInfo;
  socket.leave(roomId);
  if (activeVideoRooms.has(roomId)) {
    activeVideoRooms.get(roomId).delete(socket.id);
    const remaining = activeVideoRooms.get(roomId).size;
    if (remaining === 0) {
      activeVideoRooms.delete(roomId);
      if (roomLifecycle.has(roomId)) {
        const lifecycle = roomLifecycle.get(roomId);
        lifecycle.status = 'ended';
        lifecycle.participants.delete(socket.id);
      }
      await cleanupRoom(roomId);
      console.log(`🧹 Room ${roomId} cleaned up`);
    } else {
      await updateRoomStatus(roomId, 'active', remaining);
      if (roomLifecycle.has(roomId)) {
        const lifecycle = roomLifecycle.get(roomId);
        lifecycle.lastActivity = new Date();
        lifecycle.participants.delete(socket.id);
      }
    }
  }
  socket.to(roomId).emit('user-left', { socketId: socket.id, username });
  userSockets.delete(socket.id);
  console.log(`🚪 ${username} left room ${roomId}`);
}

// ---------- Xirsys helpers (PUT body, Basic auth, caching) ----------
let cachedIceServers = null;
let iceCacheExpiry = 0; // epoch ms

async function xirsysApiCall(service, subPath = '', method = 'GET', bodyObj = null) {
  if (!XIRSYS_SECRET) throw new Error('XIRSYS_SECRET not set in environment');
  const fullPath = `${XIRSYS_PATH}${subPath || ''}`; // path after service
  const endpointUrl = `https://${XIRSYS_GATEWAY}/${service}${fullPath}`;
  const credentials = Buffer.from(`${XIRSYS_IDENT}:${XIRSYS_SECRET}`).toString('base64');

  console.log(`🔍 Xirsys API call: ${method} ${endpointUrl} ${bodyObj ? '(body)' : ''}`);
  const opts = { method, headers: { 'Authorization': `Basic ${credentials}`, 'Accept': 'application/json' } };
  if (bodyObj) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(bodyObj);
  }

  const resp = await fetch(endpointUrl, opts);
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  if (!resp.ok) {
    const err = `Xirsys ${service}${fullPath} returned ${resp.status}: ${typeof json === 'object' ? JSON.stringify(json) : json}`;
    console.error(err);
    throw new Error(err);
  }
  return json;
}

// Get TURN servers from Xirsys, with a short cache to reduce rate usage
async function getXirsysIceServers() {
  const now = Date.now();
  if (cachedIceServers && now < iceCacheExpiry) {
    return cachedIceServers;
  }

  // Request ephemeral TURN credentials
  try {
    const turnResp = await xirsysApiCall('_turn', '', 'PUT', { format: 'urls' });
    if (turnResp && turnResp.s === 'ok' && turnResp.v && turnResp.v.iceServers) {
      cachedIceServers = turnResp.v.iceServers;
      iceCacheExpiry = now + (60 * 1000); // cache for 60s
      console.log('✅ Retrieved ICE servers from Xirsys (cached 60s)');
      return cachedIceServers;
    } else {
      throw new Error('No iceServers in response');
    }
  } catch (err) {
    console.warn('⚠️ Xirsys _turn failed:', err.message);
    // Do not throw — allow fallback
    return null;
  }
}

// ---------- Xirsys debugging / sessions ----------
async function getXirsysLiveSessions() {
  try {
    // Attempt stats and subs - graceful failures
    const sessions = [];
    try {
      const stats = await xirsysApiCall('_stats');
      if (stats && stats.s === 'ok' && Array.isArray(stats.v)) {
        stats.v.forEach((s, idx) => {
          if (s && (s.active > 0 || s.sessions > 0 || s.users > 0)) {
            sessions.push({
              roomId: s.path || s.channel || `stat_${idx}`,
              participantCount: s.active || s.users || s.sessions || 1,
              stat: s
            });
          }
        });
      }
    } catch (e) {
      console.log('📈 _stats failed:', e.message);
    }
    // subs endpoint
    try {
      const subs = await xirsysApiCall('_subs');
      if (subs && subs.s === 'ok' && subs.v && typeof subs.v === 'object') {
        Object.keys(subs.v).forEach(k => {
          const room = subs.v[k];
          const participants = Object.keys(room || {});
          if (participants.length > 0) {
            sessions.push({ roomId: k, participantCount: participants.length, participants });
          }
        });
      }
    } catch (e) {
      console.log('🗂️ _subs failed:', e.message);
    }
    return sessions;
  } catch (error) {
    console.error('❌ Failed to get Xirsys live sessions:', error);
    return [];
  }
}

// ---------- Merge local rooms with Xirsys sessions ----------
function processXirsysSubs(subsData, statsData) {
  // kept for compatibility (not heavily used)
  return [];
}
async function getCombinedLiveMatches() {
  try {
    let rooms = [];
    if (supabase) {
      const { data, error } = await supabase.from('rooms').select('*').neq('status', 'ended').order('created', { ascending: false });
      if (!error) rooms = data || [];
    } else {
      rooms = global.rooms ? Array.from(global.rooms.values()).filter(r => r.status !== 'ended') : [];
    }

    const xirsysSessions = await getXirsysLiveSessions();
    const liveMap = new Map();
    xirsysSessions.forEach(s => liveMap.set(s.roomId, s));

    const liveMatches = rooms.map(r => {
      const live = liveMap.get(r.code);
      const activeCount = activeVideoRooms.has(r.code) ? activeVideoRooms.get(r.code).size : 0;
      return {
        ...r,
        hasLiveSession: activeCount > 0 || !!live,
        liveSession: live || null,
        actualParticipants: activeCount || (live ? live.participantCount : 0),
        status: activeCount > 0 ? 'live' : (live ? 'live' : r.status),
        xirsysStatus: live ? 'connected' : 'disconnected'
      };
    });

    xirsysSessions.forEach(s => {
      const exists = rooms.find(r => r.code === s.roomId);
      if (!exists) {
        liveMatches.push({
          code: s.roomId,
          host: 'Unknown',
          opponent: s.participantCount > 1 ? 'Unknown' : null,
          players: s.participantCount,
          max_players: 4,
          status: 'live',
          created: new Date().toISOString(),
          hasLiveSession: true,
          liveSession: s,
          actualParticipants: s.participantCount,
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

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;
  const origin = req.headers.origin;
  console.log(`${method} ${path} from ${origin}`);

  if (method === 'OPTIONS') { setCORSHeaders(res, origin); res.writeHead(200); res.end(); return; }
  setCORSHeaders(res, origin);

  if (path === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h1>DDL Arena Backend</h1><p>Time: ${new Date().toISOString()}</p>`);
    return;
  }

  if (path === '/api/health' && method === 'GET') {
    let xirsysStatus = 'unknown';
    try { await xirsysApiCall('_subs'); xirsysStatus = 'connected'; } catch (e) { xirsysStatus = 'error'; }
    sendJSON(res, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      features: ['rooms', 'webrtc-signaling', 'xirsys-integration'],
      xirsys: { status: xirsysStatus, ident: XIRSYS_IDENT, gateway: XIRSYS_GATEWAY, path: XIRSYS_PATH },
      activeRooms: activeVideoRooms.size
    }, 200, origin);
    return;
  }

  if (path === '/api/xirsys/test' && method === 'GET') {
    try {
      const testResult = { config: { ident: XIRSYS_IDENT, gateway: XIRSYS_GATEWAY, path: XIRSYS_PATH }, timestamp: new Date().toISOString() };
      const endpoints = ['_ns', '_data', '_host', '_stats', '_turn', '_subs'];
      for (const ep of endpoints) {
        try {
          // try PUT for _turn, GET for others
          const methodToUse = ep === '_turn' ? 'PUT' : 'GET';
          const body = ep === '_turn' ? { format: 'urls' } : null;
          const data = await xirsysApiCall(ep, '', methodToUse, body);
          testResult[`${ep}Test`] = { success: true, data };
        } catch (e) {
          testResult[`${ep}Test`] = { success: false, error: e.message };
        }
      }
      sendJSON(res, testResult, 200, origin);
    } catch (error) {
      sendJSON(res, { error: 'Xirsys test failed', details: error.message }, 500, origin);
    }
    return;
  }

  // GET ICE servers (used by frontend)
  if (path === '/api/ice-servers' && method === 'GET') {
    try {
      const turnServers = await getXirsysIceServers();
      if (turnServers && Array.isArray(turnServers) && turnServers.length > 0) {
        sendJSON(res, { iceServers: turnServers }, 200, origin);
        return;
      }
      // fallback
      const fallback = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
        ]
      };
      console.log('🧊 Using fallback ICE servers');
      sendJSON(res, fallback, 200, origin);
    } catch (error) {
      sendJSON(res, { error: 'Failed to get ICE servers', details: error.message }, 500, origin);
    }
    return;
  }

  if (path === '/api/xirsys/live-sessions' && method === 'GET') {
    try {
      const live = await getXirsysLiveSessions();
      sendJSON(res, live, 200, origin);
    } catch (error) {
      sendJSON(res, { error: 'Failed to fetch live sessions', details: error.message }, 500, origin);
    }
    return;
  }

  if (path === '/api/live-matches' && method === 'GET') {
    try {
      const liveMatches = await getCombinedLiveMatches();
      sendJSON(res, liveMatches, 200, origin);
    } catch (error) {
      sendJSON(res, { error: 'Failed to fetch live matches', details: error.message }, 500, origin);
    }
    return;
  }

  // Rooms CRUD & join endpoints (unchanged logic, kept for compatibility)
  if (path === '/api/rooms' && method === 'POST') {
    parseBody(req, async (err, body) => {
      if (err) { sendJSON(res, { error: 'Invalid JSON' }, 400, origin); return; }
      try {
        const { host, gameSettings } = body;
        if (!host) { sendJSON(res, { error: 'Host username is required' }, 400, origin); return; }
        const roomCode = generateRoomCode();
        const roomData = {
          code: roomCode,
          host: host,
          host_id: `host_${Date.now()}`,
          players: 1,
          max_players: 2,
          status: 'waiting',
          game_settings: gameSettings || { startingScore: 501, legsToWin: 3, setsToWin: 1, doubleOut: true },
          created: new Date().toISOString(),
          is_live: false
        };
        if (supabase) {
          const { data, error } = await supabase.from('rooms').insert([roomData]).select();
          if (error) { sendJSON(res, { error: 'Database error' }, 500, origin); return; }
          sendJSON(res, data[0], 201, origin);
        } else {
          if (!global.rooms) global.rooms = new Map();
          global.rooms.set(roomCode, roomData);
          sendJSON(res, roomData, 201, origin);
        }
      } catch (error) { sendJSON(res, { error: 'Internal server error' }, 500, origin); }
    });
    return;
  }

  if (path === '/api/rooms' && method === 'GET') {
    try {
      let rooms = [];
      if (supabase) {
        const { data, error } = await supabase.from('rooms').select('*').neq('status', 'ended').order('created', { ascending: false });
        if (error) { sendJSON(res, { error: 'Database error' }, 500, origin); return; }
        rooms = data || [];
      } else {
        rooms = global.rooms ? Array.from(global.rooms.values()).filter(room => room.status !== 'ended') : [];
      }
      rooms = rooms.map(room => ({
        ...room,
        actualParticipants: activeVideoRooms.has(room.code) ? activeVideoRooms.get(room.code).size : 0,
        hasLiveSession: activeVideoRooms.has(room.code) && activeVideoRooms.get(room.code).size > 0
      }));
      sendJSON(res, rooms, 200, origin);
    } catch (error) { sendJSON(res, { error: 'Internal server error' }, 500, origin); }
    return;
  }

  if (path.startsWith('/api/rooms/') && method === 'GET') {
    const roomCode = path.split('/')[3];
    try {
      let room = null;
      if (supabase) {
        const { data, error } = await supabase.from('rooms').select('*').eq('code', roomCode).single();
        if (error) { sendJSON(res, { error: 'Room not found' }, 404, origin); return; }
        room = data;
      } else {
        if (global.rooms && global.rooms.has(roomCode)) room = global.rooms.get(roomCode);
      }
      if (!room) { sendJSON(res, { error: 'Room not found' }, 404, origin); return; }
      sendJSON(res, room, 200, origin);
    } catch (error) { sendJSON(res, { error: 'Internal server error' }, 500, origin); }
    return;
  }

  if (path.startsWith('/api/rooms/') && path.endsWith('/join') && method === 'POST') {
    const roomCode = path.split('/')[3];
    parseBody(req, async (err, body) => {
      if (err) { sendJSON(res, { error: 'Invalid JSON' }, 400, origin); return; }
      try {
        const { username } = body;
        if (!username) { sendJSON(res, { error: 'Username is required' }, 400, origin); return; }
        let room = null;
        if (supabase) {
          const { data, error } = await supabase.from('rooms').select('*').eq('code', roomCode).single();
          if (error) { sendJSON(res, { error: 'Room not found' }, 404, origin); return; }
          room = data;
          const updatedRoom = { ...room, opponent: username, opponent_id: `player_${Date.now()}`, players: 2, status: 'ready' };
          const { data: updateData, error: updateError } = await supabase.from('rooms').update(updatedRoom).eq('code', roomCode).select();
          if (updateError) { sendJSON(res, { error: 'Failed to join room' }, 500, origin); return; }
          sendJSON(res, updateData[0], 200, origin);
        } else {
          if (!global.rooms || !global.rooms.has(roomCode)) { sendJSON(res, { error: 'Room not found' }, 404, origin); return; }
          room = global.rooms.get(roomCode);
          const updatedRoom = { ...room, opponent: username, opponent_id: `player_${Date.now()}`, players: 2, status: 'ready' };
          global.rooms.set(roomCode, updatedRoom);
          sendJSON(res, updatedRoom, 200, origin);
        }
      } catch (error) { sendJSON(res, { error: 'Internal server error' }, 500, origin); }
    });
    return;
  }

  if (path.startsWith('/api/rooms/') && method === 'DELETE') {
    const roomCode = path.split('/')[3];
    try {
      if (supabase) {
        const { error } = await supabase.from('rooms').delete().eq('code', roomCode);
        if (error) { sendJSON(res, { error: 'Failed to delete room' }, 500, origin); return; }
      } else {
        if (global.rooms) global.rooms.delete(roomCode);
      }
      sendJSON(res, { message: 'Room deleted' }, 200, origin);
    } catch (error) { sendJSON(res, { error: 'Internal server error' }, 500, origin); }
    return;
  }

  if (path === '/api/rooms/end-call' && method === 'POST') {
    parseBody(req, async (err, body) => {
      if (err) { sendJSON(res, { error: 'Invalid JSON' }, 400, origin); return; }
      try {
        const { roomCode } = body;
        if (!roomCode) { sendJSON(res, { error: 'Room code is required' }, 400, origin); return; }
        await cleanupRoom(roomCode);
        io.to(roomCode).emit('room-ended', { roomCode });
        sendJSON(res, { message: 'Room ended successfully' }, 200, origin);
      } catch (error) { sendJSON(res, { error: 'Internal server error' }, 500, origin); }
    });
    return;
  }

  // default 404
  sendJSON(res, { error: 'Not found' }, 404, origin);
});

// ---------- Socket.IO signaling ----------
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true }
});

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  socket.on('join-room', roomCode => {
    socket.join(roomCode);
    socket.to(roomCode).emit('user-joined', socket.id);
  });

  socket.on('signal', ({ roomCode, data }) => {
    socket.to(roomCode).emit('signal', { sender: socket.id, data });
  });

  socket.on('join-video-room', async (data) => {
    const { roomId, username } = data;
    console.log(`🎥 ${username} joining video room: ${roomId}`);
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(roomId);
    socket.roomId = roomId; socket.username = username;
    if (!activeVideoRooms.has(roomId)) activeVideoRooms.set(roomId, new Set());
    activeVideoRooms.get(roomId).add(socket.id);
    userSockets.set(socket.id, { roomId, username });

    if (!roomLifecycle.has(roomId)) roomLifecycle.set(roomId, { created: new Date(), lastActivity: new Date(), status: 'active', participants: new Set() });
    const lifecycle = roomLifecycle.get(roomId); lifecycle.lastActivity = new Date(); lifecycle.participants.add(socket.id);

    await updateRoomStatus(roomId, 'active', activeVideoRooms.get(roomId).size);

    socket.to(roomId).emit('user-joined', { socketId: socket.id, username });
    const roomUsers = Array.from(activeVideoRooms.get(roomId)).filter(id => id !== socket.id).map(id => ({ socketId: id, username: userSockets.get(id)?.username }));
    socket.emit('room-users', roomUsers);

    console.log(`✅ ${username} joined room ${roomId}. Total users: ${activeVideoRooms.get(roomId).size}`);
  });

  socket.on('webrtc-offer', (data) => {
    const { targetSocketId, offer } = data;
    console.log(`📤 Relaying offer from ${socket.id} to ${targetSocketId}`);
    socket.to(targetSocketId).emit('webrtc-offer', { fromSocketId: socket.id, offer });
  });

  socket.on('webrtc-answer', (data) => {
    const { targetSocketId, answer } = data;
    console.log(`📥 Relaying answer from ${socket.id} to ${targetSocketId}`);
    socket.to(targetSocketId).emit('webrtc-answer', { fromSocketId: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    const { targetSocketId, candidate } = data;
    console.log(`🧊 Relaying ICE candidate from ${socket.id} to ${targetSocketId}`);
    socket.to(targetSocketId).emit('webrtc-ice-candidate', { fromSocketId: socket.id, candidate });
  });

  socket.on('webrtc-signal', (data) => {
    const { targetSocketId, signal, type } = data;
    console.log(`📡 Relaying ${type} signal from ${socket.id} to ${targetSocketId}`);
    socket.to(targetSocketId).emit('webrtc-signal', { fromSocketId: socket.id, signal, type });
  });

  socket.on('leave-room', async () => { await handleUserLeaveRoom(socket, io); });
  socket.on('leave-video-room', async () => { await handleUserLeaveRoom(socket, io); });

  socket.on('disconnect', async () => {
    console.log('📴 Client disconnected:', socket.id);
    await handleUserLeaveRoom(socket, io);
  });
});

// ---------- periodic cleanup ----------
setInterval(async () => {
  console.log('🔄 Running periodic room cleanup...');
  const now = Date.now();
  const STALE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  for (const [roomId, lifecycle] of roomLifecycle.entries()) {
    const last = lifecycle.lastActivity.getTime();
    if (lifecycle.status === 'ended' || (lifecycle.participants.size === 0 && now - last > STALE_TIMEOUT)) {
      await cleanupRoom(roomId);
      console.log(`🧹 Cleaned up stale room: ${roomId}`);
    }
  }
  if (supabase) {
    try {
      const thirtyMinutesAgo = new Date(now - STALE_TIMEOUT).toISOString();
      const { error } = await supabase.from('rooms').delete().or(`status.eq.ended,and(is_live.eq.false,last_activity.lt.${thirtyMinutesAgo})`);
      if (error) console.error('Failed to clean up stale rooms:', error);
    } catch (error) { console.error('Error in periodic cleanup:', error); }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DDL Arena Server listening on port ${PORT}`);
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`🎥 Xirsys Integration: ${XIRSYS_IDENT} @ ${XIRSYS_GATEWAY}${XIRSYS_PATH}`);
});
