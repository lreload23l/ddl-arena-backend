# DDL Arena Backend

Backend server for DDL Arena - Professional Online Darts Game with real-time multiplayer functionality.

## 🚀 Features

- **Real-time Room Management**: Create and join game rooms across different browsers/devices
- **WebSocket Communication**: Live updates using Socket.IO
- **RESTful API**: Room creation, joining, and management endpoints
- **WebRTC Signaling**: Peer-to-peer video chat support
- **Auto-cleanup**: Removes old/abandoned rooms automatically
- **Health Monitoring**: Built-in health check endpoints

## 🛠️ Installation

```bash
# Clone the repository
git clone https://github.com/lreload23l/ddl-arena-backend.git
cd ddl-arena-backend

# Install dependencies
npm install

# Start development server
npm run dev
```

## 🌐 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/rooms` | Get all active rooms |
| POST | `/api/rooms` | Create new room |
| POST | `/api/rooms/:code/join` | Join specific room |
| GET | `/api/rooms/:code` | Get room details |
| PUT | `/api/rooms/:code/status` | Update room status |
| DELETE | `/api/rooms/:code` | Delete room |
| GET | `/health` | Server health check |

## 🔌 WebSocket Events

### Client to Server:
- `joinRoom` - Join a game room
- `gameStateUpdate` - Update game state
- `scoreUpdate` - Update player score
- `webrtc-offer/answer/ice-candidate` - WebRTC signaling

### Server to Client:
- `roomCreated` - New room available
- `roomUpdated` - Room status changed
- `playerJoined` - Player joined room
- `gameStateUpdated` - Game state changed
- `scoreUpdated` - Score updated

## 🚀 Deployment

### Local Development:
```bash
npm run dev
# Server runs on http://localhost:3000
```

### Production (Render.com):
1. Push to GitHub repository
2. Connect repository to Render.com
3. Deploy automatically using `render.yaml` configuration

## 🔧 Environment Variables

- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 3000)

## 📊 Health Check

Visit `/health` endpoint to check server status:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "activeRooms": 5,
  "connectedUsers": 12
}
```

## 🎮 Room Management

Rooms are automatically cleaned up:
- **24 hours**: Old rooms are deleted
- **30 seconds**: Abandoned rooms (after player disconnect)

## 🔗 Frontend Integration

Connect your frontend using Socket.IO client:
```javascript
const socket = io('http://localhost:3000');
// or in production:
const socket = io('https://your-app.onrender.com');
```

## 📝 License

MIT License - see LICENSE file for details