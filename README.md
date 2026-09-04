# KickSphere Backend API

> Real-time football backend powered by Node.js, Express, Firebase, and Socket.io.

## Setup

Requires Node.js 22 or newer.

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
| `PUBLIC_BASE_URL` | Yes in production | Public backend origin used for uploaded asset URLs |
| `JWT_SECRET` | Yes in production | Secret key for JWT token signing |
| `JWT_EXPIRY` | No | Token expiration (default: `30d`) |
| `ALLOWED_ORIGINS` | Yes in production | Comma-separated CORS origins |
| `FIREBASE_PROJECT_ID` | Yes in production* | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes in production* | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Yes in production* | Firebase private key |
| `FOOTBALL_DATA_API_KEY` | Recommended | football-data.org API token |
| `KICKOFF_API_KEY` | Optional | KickOff API token for richer live, standings, squad, and fixture fallback data |
| `ENABLE_SOFASCORE_PROXY` | No | Set to `true` only if live polling may fall back to the public Sofascore proxy |
| `ENABLE_LIVE_POLLING` | No | Set to `true` to enable background Socket.io live polling |
| `ALLOW_FIRESTORE_SEED` | No | Set to `true` only for an intentional `npm run seed` reference-data merge |
| `ENABLE_RAPIDAPI_PROXY` | No | Set to `true` only if the allowlisted RapidAPI proxy is needed |
| `RAPID_API_KEY` | Only if proxy enabled | RapidAPI key kept on the server |
| `RAPID_API_HOST` | Only if proxy enabled | RapidAPI host |

*Or provide `serviceAccountKey.json` in root for development.

## API Endpoints

Full request/response shapes are documented in [`docs/api-contract.md`](docs/api-contract.md).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/auth/register` | Register and return user + JWT |
| POST | `/api/auth/login` | Login and return user + JWT |
| GET | `/api/home` | Public or personalized home feed |
| GET | `/api/matches?date=` | Grouped matches by `TODAY`, `YESTERDAY`, `TOMORROW`, or `YYYY-MM-DD` |
| GET | `/api/matches/date?date=` | Compatibility alias for date matches |
| GET | `/api/matches/live` | Live matches |
| GET | `/api/matches/search?q=` | Search matches |
| GET | `/api/matches/competition/:code` | Competition fixtures, optional `dateFrom`/`dateTo` |
| GET | `/api/matches/:id` | Match details |
| GET | `/api/stats/leagues` | Supported competitions |
| GET | `/api/stats/teams?league=` | League standings |
| GET | `/api/stats/players?league=&limit=&stat=` | Top scorers or assists |
| GET | `/api/stats/matches/:id/timeline` | Match events |
| GET | `/api/stats/matches/:id/lineups` | Match lineups |
| GET | `/api/stats/deep/match/:id` | Rich match details |
| GET | `/api/stats/deep/team/:id` | Rich team details |
| GET | `/api/stats/deep/player/:id` | Rich player details |
| GET | `/api/stats/deep/competitions` | Supported competitions alias |
| GET | `/api/search?q=` | Universal search |
| GET | `/api/news?limit=` | Latest news facade |
| GET/POST | `/api/users/:userId/preferences` | Protected user preferences |
| GET/POST | `/api/users/:userId/favorites` | Protected user favorites |
| DELETE | `/api/users/:userId/favorites/:favoriteId` | Remove favorite |
| POST | `/api/users/:userId/avatar` | Protected avatar upload |
| GET/PATCH | `/api/notifications/:userId/:notificationId?` | Protected notifications |
| GET/POST | `/api/chat/:matchId/messages` / `/api/chat/:matchId/send` | Match chat |
| GET | `/api/leagues`, `/api/leagues/:id`, `/api/leagues/:id/teams`, `/api/leagues/:id/matches` | League compatibility routes |
| GET | `/api/teams`, `/api/teams/:id`, `/api/teams/:id/matches`, `/api/teams/:id/squad` | Team compatibility routes |
| POST | `/api/players/sync` | Admin player sync |
| GET | `/api/proxy/rapidapi/:endpoint` | Optional disabled-by-default RapidAPI proxy |

## WebSocket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `joinUser` | Client -> Server | Join personal room |
| `joinMatch` | Client -> Server | Join match room |
| `subscribeFavorites` | Client -> Server | Join favorite team rooms and personal room when authorized |
| `sendMessage` | Client -> Server | Send chat message; requires socket authentication |
| `newMessage` | Server -> Client | New chat message |
| `liveMatches` | Server -> Client | Live match updates |
| `liveEvent` | Server -> Client | Goal/event alerts |
| `notification` | Server -> Client | Push notification |
| `authorizationError` | Server -> Client | Socket room/auth failure |

Socket rooms are namespaced internally as `user:{id}`, `match:{id}`, and `team:{name}` to avoid cross-room collisions.
