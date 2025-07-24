
const http = require('http');
const url = require('url');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;

// Supabase initialization
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Utility functions
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

  if (method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (path === '/api/rooms' && method === 'POST') {
    parseBody(req, async (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400);
        return;
      }

      const { host, gameSettings } = body;
      if (!host) {
        sendJSON(res, { error: 'Host name is required' }, 400);
        return;
      }

      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let roomCode = '';
      for (let i = 0; i < 5; i++) {
        roomCode += chars.charAt(Math.floor(Math.random() * chars.length));
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

      const { data, error } = await supabase.from('rooms').insert([room]);
      if (error) {
        sendJSON(res, { error: error.message }, 500);
      } else {
        sendJSON(res, data[0]);
      }
    });
  }

  else if (path.startsWith('/api/rooms/') && path.endsWith('/join') && method === 'POST') {
    const code = path.split('/')[3];
    parseBody(req, async (err, body) => {
      if (err) {
        sendJSON(res, { error: 'Invalid JSON' }, 400);
        return;
      }

      const { username } = body;
      if (!username) {
        sendJSON(res, { error: 'Username is required' }, 400);
        return;
      }

      const { data: rooms, error } = await supabase.from('rooms').select('*').eq('code', code);
      if (error || rooms.length === 0) {
        sendJSON(res, { error: 'Room not found' }, 404);
        return;
      }

      const room = rooms[0];
      if (room.players >= room.max_players) {
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

      const update = {
        players: 2,
        status: 'ready',
        opponent: username,
        opponent_id: `${username}_${Date.now()}`
      };

      const { data: updated, error: updateError } = await supabase
        .from('rooms')
        .update(update)
        .eq('code', code);

      if (updateError) {
        sendJSON(res, { error: updateError.message }, 500);
      } else {
        sendJSON(res, updated[0]);
      }
    });
  }

  else {
    sendJSON(res, { error: 'Not found' }, 404);
  }
});

server.listen(PORT, () => {
  console.log(`🚀 DDL Arena Server is running on port ${PORT}`);
});
