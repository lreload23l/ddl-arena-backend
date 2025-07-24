const http = require('http');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;

// Supabase initialization
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CORS configuration for your Netlify frontend
const ALLOWED_ORIGINS = [
  'https://discorddartsleagues.netlify.app',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500', // Live Server
  'http://localhost:5500'
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

  // Handle CORS preflight
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

  // Health check endpoint
  if (path === '/api/health' && method === 'GET') {
    sendJSON(res, { status: 'healthy', timestamp: new Date().toISOString() }, 200, origin);
    return;
  }

  // Get all rooms
  if (path === '/api/rooms' && method === 'GET') {
    try {
      const { data: rooms, error } = await supabase
        .from('rooms')
        .select('*')
        .order('created', { ascending: false })
        .limit(50); // Limit to prevent too much data

      if (error) {
        sendJSON(res, { error: error.message }, 500, origin);
      } else {
        sendJSON(res, rooms || [], 200, origin);
      }
    } catch (err) {
      sendJSON(res, { error: 'Database error' }, 500, origin);
    }
    return;
  }

  // Create room
  if (path === '/api/rooms' && method === 'POST') {
    parseBody(req, async (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400, origin);
        return;
      }

      const { host, gameSettings } = body;
      if (!host) {
        sendJSON(res, { error: 'Host name is required' }, 400, origin);
        return;
      }

      // Generate unique room code
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let roomCode = '';
      let isUnique = false;
      
      while (!isUnique) {
        roomCode = '';
        for (let i = 0; i < 5; i++) {
          roomCode += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        
        // Check if code already exists
        const { data: existingRooms } = await supabase
          .from('rooms')
          .select('code')
          .eq('code', roomCode);
          
        isUnique = !existingRooms || existingRooms.length === 0;
      }

      const room = {
        code: roomCode,
        host,
        host_id: `${host}_${Date.now()}`,
        created: new Date().toISOString(),
        status: 'waiting',
        players: 1,
        max_players: 2,
        opponent: null,
        opponent_id: null,
        game_settings: gameSettings || {
          mode: '501',
          startingScore: 501,
          legsToWin: 3,
          setsToWin: 1,
          doubleOut: true,
          doubleIn: false,
          masterOut: false
        }
      };

      const { data, error } = await supabase.from('rooms').insert([room]).select();
      if (error) {
        sendJSON(res, { error: error.message }, 500, origin);
      } else {
        sendJSON(res, data[0], 201, origin);
      }
    });
    return;
  }

  // Join room
  if (path.startsWith('/api/rooms/') && path.endsWith('/join') && method === 'POST') {
    const code = path.split('/')[3];
    parseBody(req, async (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400, origin);
        return;
      }

      const { username } = body;
      if (!username) {
        sendJSON(res, { error: 'Username is required' }, 400, origin);
        return;
      }

      // Get room
      const { data: rooms, error } = await supabase
        .from('rooms')
        .select('*')
        .eq('code', code);
        
      if (error || !rooms || rooms.length === 0) {
        sendJSON(res, { error: 'Room not found' }, 404, origin);
        return;
      }

      const room = rooms[0];
      
      // Validation checks
      if (room.players >= room.max_players) {
        sendJSON(res, { error: 'Room is full' }, 400, origin);
        return;
      }

      if (room.host === username) {
        sendJSON(res, { error: 'Cannot join your own room' }, 400, origin);
        return;
      }

      if (room.status === 'playing') {
        sendJSON(res, { error: 'Game is already in progress' }, 400, origin);
        return;
      }

      // Update room
      const update = {
        players: 2,
        status: 'ready',
        opponent: username,
        opponent_id: `${username}_${Date.now()}`
      };

      const { data: updated, error: updateError } = await supabase
        .from('rooms')
        .update(update)
        .eq('code', code)
        .select();

      if (updateError) {
        sendJSON(res, { error: updateError.message }, 500, origin);
      } else {
        sendJSON(res, updated[0], 200, origin);
      }
    });
    return;
  }

  // Get specific room
  if (path.startsWith('/api/rooms/') && !path.endsWith('/join') && method === 'GET') {
    const code = path.split('/')[3];
    
    const { data: rooms, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('code', code);
      
    if (error) {
      sendJSON(res, { error: error.message }, 500, origin);
    } else if (!rooms || rooms.length === 0) {
      sendJSON(res, { error: 'Room not found' }, 404, origin);
    } else {
      sendJSON(res, rooms[0], 200, origin);
    }
    return;
  }

  // Delete/cleanup room
  if (path.startsWith('/api/rooms/') && method === 'DELETE') {
    const code = path.split('/')[3];
    
    const { error } = await supabase
      .from('rooms')
      .delete()
      .eq('code', code);
      
    if (error) {
      sendJSON(res, { error: error.message }, 500, origin);
    } else {
      sendJSON(res, { message: 'Room deleted successfully' }, 200, origin);
    }
    return;
  }

  // 404 for unmatched routes
  sendJSON(res, { error: 'Not found' }, 404, origin);
});

server.listen(PORT, () => {
  console.log(`🚀 DDL Arena Server is running on port ${PORT}`);
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
