# KickSphere Backend API

> Real-time football backend powered by Node.js, Express, Firebase, and Socket.io.

## Setup

```bash
npm install
cp .env.example .env   # Then fill in your values
npm run dev             # Development with hot-reload
npm start               # Production
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | `development` or `production` |
| `JWT_SECRET` | Yes | Secret key for JWT token signing |
| `JWT_EXPIRY` | No | Token expiration (default: `30d`) |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins (default: *) |
| `FIREBASE_PROJECT_ID` | Yes* | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes* | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Yes* | Firebase private key |

*Or provide `serviceAccountKey.json` in root for development.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/home` | Home feed |
| GET | `/api/matches` | All matches (paginated) |
| GET | `/api/matches/live` | Live matches |
| GET | `/api/matches/search?q=` | Search matches |
| GET | `/api/matches/:id` | Match details |
| GET | `/api/leagues` | All leagues |
| GET | `/api/teams` | All teams |
| GET | `/api/news` | Latest news |
| GET | `/api/search?q=` | Universal search |
| GET/POST | `/api/users/:id/preferences` | User preferences |
| GET/POST | `/api/users/:id/favorites` | User favorites |
| GET | `/api/notifications/:userId` | User notifications |

## WebSocket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `joinUser` | Client → Server | Join personal room |
| `joinMatch` | Client → Server | Join match room |
| `sendMessage` | Client → Server | Send chat message |
| `newMessage` | Server → Client | New chat message |
| `liveMatches` | Server → Client | Live match updates |
| `liveEvent` | Server → Client | Goal/event alerts |
| `notification` | Server → Client | Push notification |
