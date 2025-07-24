const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
  }
});

app.use(cors());
app.use(express.json());

const PORT = 3000;

app.get('/', (req, res) => {
  res.send('Darts backend is running!');
});

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  socket.on('joinRoom', (roomCode) => {
    socket.join(roomCode);
    console.log(`User ${socket.id} joined room ${roomCode}`);
    io.to(roomCode).emit('playerJoined', socket.id);
  });

  socket.on('scoreUpdate', (data) => {
    io.to(data.roomCode).emit('updateScore', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
 
