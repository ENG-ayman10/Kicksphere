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

For the Android build that uses `http://127.0.0.1:3000/api`, open
`Run-KickSphere-Local.cmd` on Windows or run `npm run start:android:local`.
Keep the launcher open and the computer awake; it starts the local API and
restores the USB reverse mapping when an authorized phone reconnects. It does
not install the app or reset login data. The local build still requires the
computer and USB connection. [Arabic running guide](docs/LOCAL_ANDROID_RUNNING_AR.md).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | `development` or `production` |
| `PUBLIC_BASE_URL` | Yes in production | Public backend origin used for uploaded asset URLs |
| `JWT_SECRET` | Yes in production | Secret key for JWT token signing |
| `JWT_EXPIRY` | No | Token expiration (default: `30d`) |
| `ALLOWED_ORIGINS` | Yes in production | Comma-separated CORS origins |
| `TRUST_PROXY` | Deployment dependent | `false`, 0–5 trusted ingress hops, or explicit IP/CIDR list. Development defaults to false; production retains the previous one-hop assumption until configured. |
| `FIREBASE_PROJECT_ID` | Yes in production* | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes in production* | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Yes in production* | Firebase private key |
| `FOOTBALL_DATA_API_KEY` | Recommended | football-data.org API token |
| `KICKOFF_API_KEY` | Optional | KickOff API token for richer live, standings, squad, and fixture fallback data |
| `BSD_API_TOKEN` | Optional | BSD v2 token for covered fixtures, squads, player profiles and advanced match details; server only |
| `BSD_BASE_URL` | No | BSD origin, default `https://sports.bzzoiro.com` |
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
| GET | `/api/ready` | Startup configuration readiness; 503 while draining, no upstream requests |
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

Socket rooms are namespaced internally as `user:{id}`, `match:{id}`, and `team:{provider-scoped-id}`. Team favorites use `sc_t_<exact-sportscore-slug>`, `ko_t_<kickoff-id>` or `bsd_t_<positive-bsd-id>`; names are display metadata and never notification subscription keys. Legacy name-only favorites remain readable and require explicit resolution before subscriptions resume.

## BSD v2 integration

Set `BSD_API_TOKEN` in the backend's ignored `.env` or host secret settings, then restart the server. Never put the token in Flutter, images, browser requests or committed files. Requests are centrally cached, concurrent reads of the same resource share one request, and pagination is bounded; incomplete pages remain explicitly partial.

BSD is preferred for covered calendar fixtures, standings and scorers. SportScore supplements wider fixture coverage and existing provider IDs keep their own detail routes. Only an exact competition, kickoff and oriented team-name fixture context can suppress a duplicate; it never remaps team or player identities. A valid empty provider response is different from an outage.

BSD detail routes accept `bsd_<event-id>`, `bsd_t_<team-id>` and `bsd_p_<player-id>`. `/api/stats/deep/competitions` exposes the actual BSD catalog, retaining known competition codes and using `BSD:<league-id>` for other catalog entries. Unsupported IDs cannot become an unfiltered query. Upcoming team fixtures use the events feed because the provider's team-fixtures resource is incomplete.

Predicted lineups remain labeled as predictions with supplied confidence. Unavailable lineups and statistics remain unavailable. Player totals are scoped to a verified current club, competition and season; national-team and historical rows are not added to those totals. Estimated xG retains its estimate flags. Profiles expose available career and transfer rows without inventing missing fees, ratings or biographical facts. Public `/img/` URLs do not contain credentials.

Flutter Web displays BSD images through `/api/images/bsd/{type}/{id}` because the image host omits CORS headers. This route accepts only fixed image types and positive numeric IDs, sends no credentials, follows no redirects, validates PNG/JPEG/WebP bytes and bounds its requests and cache. Android retains the original public image URLs. Search terms such as `Al Hilal`, `Al-Hilal` and `الهلال` preserve separate provider entities; ambiguous same-name clubs gain competition context only from their own fixtures.

## Production verification

Follow [`docs/production-readiness.md`](docs/production-readiness.md). Production startup fails if trusted browser origins, public HTTPS backend origin, JWT secret, or Firebase environment credentials are absent or invalid. Native requests without an `Origin` remain possible; all existing protected-route and personal socket-room authorization still applies. Both HTTP and direct WebSocket handshakes enforce the same origin list.

```bash
npm ci --ignore-scripts
npm test
npm run audit:prod
npm run check:production
npm run smoke:health -- https://your-backend.example.com
npm run smoke:sports -- http://127.0.0.1:3000 --allow-local --date 2026-10-01
```

These commands never publish, seed databases, register accounts, or send messages. The environment check validates configuration without initializing Firebase or contacting football providers. Health smoke testing calls only the two readiness endpoints on the explicitly supplied host.

The separate sports smoke checks the active BSD catalog, scoped club/player identities, exact exclusive UTC-day fixtures, complete image containers and malformed-ID rejection using public GET requests. Partial coverage remains an explicit warning; successful integration does not certify worldwide data accuracy. See the production readiness guide for its scope and optional JSON report. Current work is local preparation only; the prior Render service is stopped and hosted Flutter builds require an explicit API URL.
