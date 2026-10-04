# KickSphere API Contract

This document is the backend-to-Flutter contract for the KickSphere mobile app.
It lists every mounted REST route, the payloads consumed by the Flutter app, and
the realtime Socket.io events exposed by the backend.

## Base URL

The current development builds point to the local backend; the previous Render
deployment is stopped. The production URL remains an explicit build setting.
For local Android development through `adb reverse tcp:3000 tcp:3000`:

```bash
flutter run --dart-define=KICKSPHERE_ENV=development --dart-define=KICKSPHERE_API_BASE_URL=http://127.0.0.1:3000/api
```

The Socket.io URL is the API base origin without `/api`.

## Verified alternative fixture identities

Merged fixture rows may contain `providerIdentities`, an ordered array of two or
three descriptors. The first descriptor anchors the displayed fixture; each
descriptor contains `id`, `provider`, `utcDate`, `competitionCode`,
`homeTeamId`, and `awayTeamId`. Native IDs, participant orientation, score and
kickoff are retained from one complete preferred provider row. Alternative
descriptors preserve the other provider's original IDs and kickoff.

Joining requires a unique cross-provider candidate with the same oriented teams
and competition context. Exact-name joins retain the existing exact-kickoff rule.
The independently verified senior MLS identities `bsd_t_302` /
`sc_t_seattle-sounders` and `bsd_t_299` /
`sc_t_sporting-kansas-city` additionally permit at most the observed ten-minute
kickoff disagreement. Country, gender, age, reserve and provider contradictions
reject a join. Ambiguous fixtures and distinct same-provider IDs remain separate.
This is not a global name alias or a general kickoff tolerance.

Consumers validate the canonical anchor, bounded scoped IDs, distinct providers,
competition and kickoff before using alternatives for bells, favorite filtering,
socket rooms or installation delivery. Old subscriptions are read as stored;
reading a fixture does not migrate preferences. Explicitly disabling its bell
removes the known subscribed alternatives; enabling adds only the displayed ID.
Native `/api/matches/:id` routes continue to return that provider's own fixture.
An old SportScore notification therefore still opens its SportScore route.

Validated match events carry the same array plus `utcDate` and `competitionCode`.
These fields also survive compact `data.event` FCM serialization. One canonical
`eventId` is retained across socket, personal inbox and push delivery; matching
both clubs or multiple alternative IDs does not produce an additional event for
the same installation. Missing or invalid provenance adds no subscription IDs.

## Request Conventions

JSON requests use:

```http
Content-Type: application/json
```

Protected endpoints require:

```http
Authorization: Bearer <token>
```

The backend accepts either:

- Custom KickSphere JWT tokens signed with `JWT_SECRET`.
- Firebase ID tokens verified by Firebase Admin SDK.

Normalized authenticated user shape:

```json
{
  "id": "user-doc-id-or-firebase-uid",
  "email": "fan@example.com",
  "name": "Fan",
  "role": "user",
  "roles": ["user"]
}
```

Admin-only actions accept `role`, `roles`, `admin`, or `isAdmin` values that
identify an admin user.

## Response Conventions

Successful responses always include:

```json
{
  "success": true
}
```

Error responses use:

```json
{
  "success": false,
  "message": "Human readable error"
}
```

Common status codes:

| Code | Meaning |
| --- | --- |
| `200` | Successful read/update/delete |
| `201` | Successful creation |
| `400` | Missing or invalid input |
| `401` | Missing or expired authentication |
| `403` | Invalid token or not allowed |
| `404` | Route or resource not found |
| `409` | Duplicate user registration |
| `429` | Rate limited |
| `500` | Server/provider configuration error |
| `503` | Requested data unavailable or server draining |

Rate limits:

| Area | Limit |
| --- | --- |
| General API | 1200 requests per 15 minutes |
| Auth routes | 20 requests per 15 minutes |
| Search routes | 60 requests per minute |

## Flutter App Usage Map

The current Flutter app calls these backend routes directly:

| Flutter service | Backend route |
| --- | --- |
| `AuthService.login` | `POST /api/auth/login` |
| `AuthService.register` | `POST /api/auth/register` |
| `LocalBackendService.getMatchesByDate` | `GET /api/matches?date=YYYY-MM-DD` |
| `LocalBackendService.getMatchesForLocalDay` | `GET /api/matches?from=<UTC-ISO>&to=<UTC-ISO>` |
| `LocalBackendService.getMatchDetails` | `GET /api/matches/:id` |
| `LocalBackendService.getMatchTimeline` | `GET /api/stats/matches/:id/timeline` |
| `LocalBackendService.getMatchLineups` | `GET /api/stats/matches/:id/lineups` |
| `LocalBackendService.getMatchDeepStats` | `GET /api/stats/deep/match/:id` |
| `LocalBackendService.getCompetitionMatches` | `GET /api/matches/competition/:code` |
| `LocalBackendService.getDeepTeamDetails` | `GET /api/stats/deep/team/:id` |
| `LocalBackendService.getDeepPlayerDetails` | `GET /api/stats/deep/player/:id` |
| `LocalBackendService.getSupportedCompetitions` | `GET /api/stats/leagues` |
| `LocalBackendService.search` | `GET /api/search?q=query` |
| `LocalBackendService.getTopScorers` | `GET /api/stats/players?league=PL&limit=20` |
| `LocalBackendService.getStandings` | `GET /api/stats/teams?league=PL` |
| `LocalBackendService.uploadAvatar` | `POST /api/users/:userId/avatar` |
| `FavoritesService.syncWithBackend` | `GET /api/users/:userId/favorites` |
| `FavoritesService.toggleFavorite*` | `POST/DELETE /api/users/:userId/favorites` |
| `NewsController.fetchNews` | `GET /api/news?limit=20` |
| `SocketService` | Socket.io client events and server events |

No current Flutter service call is missing a backend route.

## Shared Data Shapes

### Competition

Supported competition codes:

```text
PL, PD, SA, BL1, FL1, CL, PPL, ELC, DED, BSA, EC, WC
```

Competition item:

```json
{
  "id": "PL",
  "code": "PL",
  "name": "Premier League",
  "country": "England",
  "flag": "England",
  "logo": "https://example.com/logo.png",
  "emblem": "https://example.com/logo.png"
}
```

`logo` and `emblem` are treated as aliases by Flutter.

### Match

The canonical app-facing match shape is:

```json
{
  "id": "arsenal-vs-chelsea-opaque-fixture-id",
  "slug": "arsenal-vs-chelsea",
  "utcDate": "2026-08-29T16:30:00Z",
  "status": "TIMED",
  "statusText": "Upcoming",
  "matchday": 3,
  "stage": "REGULAR_SEASON",
  "minute": null,
  "league": "Premier League",
  "leagueId": "PL",
  "homeScore": null,
  "awayScore": null,
  "competition": {
    "id": "PL",
    "code": "PL",
    "name": "Premier League",
    "emblem": "https://example.com/emblem.png",
    "logo": "https://example.com/emblem.png",
    "country": "England",
    "countryFlag": ""
  },
  "homeTeam": {
    "id": "sc_t_arsenal",
    "provider": "sportscore",
    "name": "Arsenal",
    "shortName": "Arsenal",
    "fullName": "Arsenal FC",
    "crest": "https://example.com/crest.png",
    "logo": "https://example.com/crest.png"
  },
  "awayTeam": {
    "id": "sc_t_chelsea",
    "provider": "sportscore",
    "name": "Chelsea",
    "shortName": "Chelsea",
    "fullName": "Chelsea FC",
    "crest": "https://example.com/crest.png",
    "logo": "https://example.com/crest.png"
  },
  "provider": "sportscore",
  "source": "sportscore",
  "score": {
    "winner": null,
    "fullTime": { "home": null, "away": null },
    "halfTime": { "home": null, "away": null }
  }
}
```

Valid status values used by the app:

```text
TIMED, SCHEDULED, IN_PLAY, LIVE, PAUSED, HALFTIME, FINISHED, FT, AET, PEN, POSTPONED, CANCELLED, UNKNOWN
```

For upcoming matches, scores should stay `null` instead of artificial `0 - 0`.

Club IDs are nullable when the provider supplies only a display name. Verified IDs use `sc_t_<exact-provider-id-or-slug>`, `ko_t_<positive-provider-integer>` or `bsd_t_<positive-provider-integer>`; canonical IDs are at most 120 characters (raw SportScore/KickOff IDs at most 115, raw BSD IDs at most 114). Leading-zero/zero numeric IDs and contradictory provider metadata are rejected. A missing club ID never authorizes a guessed slug, name-only favorite match or another provider lookup. See [provider club identity limits](production-readiness.md#provider-club-identity-limits).

### Timeline Event

```json
{
  "minute": 52,
  "time": "52",
  "type": "goal",
  "icon": "goal",
  "label": "Goal",
  "team": "Arsenal",
  "player": "Player Name",
  "playerName": "Player Name",
  "assist": "Assistant Name",
  "playerOut": null
}
```

Known event types:

```text
goal, yellow_card, red_card, card, substitution, penalty, var, matchStart, matchEnd
```

### Lineups

```json
{
  "formation": { "home": "4-3-3", "away": "4-2-3-1" },
  "homeFormation": "4-3-3",
  "awayFormation": "4-2-3-1",
  "homeCoach": "Home Coach",
  "awayCoach": "Away Coach",
  "confirmed": true,
  "home": [
    {
      "id": "1",
      "name": "Player",
      "playerName": "Player",
      "position": "Forward",
      "shirtNumber": 9,
      "number": 9,
      "player": { "id": "1", "name": "Player", "number": 9 }
    }
  ],
  "away": [],
  "homeBench": [],
  "awayBench": []
}
```

The Flutter adapter accepts either nested `formation.home`/`formation.away` or
top-level `homeFormation`/`awayFormation`.

### Standing

Preferred flat shape:

```json
{
  "rank": 1,
  "teamId": "57",
  "name": "Arsenal",
  "shortName": "Arsenal",
  "logo": "https://example.com/crest.png",
  "crest": "https://example.com/crest.png",
  "played": 3,
  "playedGames": 3,
  "won": 2,
  "drawn": 1,
  "draw": 1,
  "lost": 0,
  "gf": 8,
  "ga": 3,
  "gd": 5,
  "goalsFor": 8,
  "goalsAgainst": 3,
  "goalDifference": 5,
  "points": 7,
  "promotion": "",
  "promoColor": ""
}
```

Flutter also accepts provider-normalized rows with nested `team`:

```json
{
  "position": 1,
  "team": {
    "id": "arsenal",
    "name": "Arsenal",
    "shortName": "Arsenal",
    "crest": "https://example.com/crest.png",
    "logo": "https://example.com/crest.png",
    "slug": "arsenal"
  },
  "playedGames": 3,
  "won": 2,
  "draw": 1,
  "lost": 0,
  "points": 7,
  "goalsFor": 8,
  "goalsAgainst": 3,
  "goalDifference": 5
}
```

### Top Scorer

Preferred flat shape:

```json
{
  "rank": 1,
  "playerId": "44",
  "name": "Player Name",
  "playerImage": "https://example.com/player.png",
  "nationality": "Norway",
  "team": "Manchester City",
  "teamName": "Manchester City",
  "teamLogo": "https://example.com/crest.png",
  "goals": 10,
  "assists": 2,
  "penalties": 1,
  "matches": 8,
  "playedMatches": 8
}
```

Flutter also accepts provider-normalized rows with nested `player` and `team`.

### Favorite Item

Canonical favorite item:

```json
{
  "type": "team",
  "targetId": "sc_t_arsenal",
  "displayName": "Arsenal",
  "provider": "sportscore",
  "providerId": "arsenal",
  "imageUrl": "https://example.com/badge.png",
  "metadata": {
    "league": "Premier League"
  }
}
```

Required fields:

- `type`: `team`, `competition`, or `athlete`.
- `targetId`: stable app-facing id. Team IDs must be scoped as `sc_t_<exact-provider-slug>`, `ko_t_<numeric-provider-id>` or `bsd_t_<numeric-provider-id>` for matching/subscriptions.

`name`/`logo` are accepted as `displayName`/`imageUrl` aliases. Legacy name-only team favorites remain readable but cannot select recommendations or notifications until a genuine provider identity is resolved. Saving a legacy record does not silently convert its name into a slug.

Accepted legacy aliases:

| Input | Stored as |
| --- | --- |
| `club` | `team` |
| `league` | `competition` |
| `player` | `athlete` |

Server-generated fields:

- `id`: Firestore document id.
- `canonicalKey`: lowercased `{type}:{targetId}` used for duplicate prevention.
- `createdAt`, `updatedAt`: timestamps.

## Health

### `GET /api/health`

Public health check.

Response:

```json
{
  "success": true,
  "message": "KickSphere Backend OK",
  "uptime": 123.45,
  "timestamp": 1788290000000,
  "environment": "development"
}
```

## Readiness

### `GET /api/ready`

Startup readiness returns `success: true`, `status: "ready"`, initialization/configuration checks and `providerReachabilityChecked: false`; HTTP 503 is returned while draining. This endpoint triggers no provider or database request and does not prove upstream availability or data completeness. See [production release gates](production-readiness.md).

## Authentication

Registration and login normalize email addresses to lowercase. Passwords must be
6 to 128 characters. Names must be 80 characters or fewer.

### `POST /api/auth/register`

Request:

```json
{
  "name": "Fan",
  "email": "fan@example.com",
  "password": "secret123"
}
```

Response `201`:

```json
{
  "success": true,
  "message": "User registered successfully",
  "user": {
    "id": "user-doc-id",
    "name": "Fan",
    "email": "fan@example.com",
    "avatarUrl": "",
    "role": "user",
    "roles": ["user"]
  },
  "token": "jwt-token"
}
```

Errors:

- `400`: missing fields, invalid email, invalid password, name too long.
- `409`: user already exists.

### `POST /api/auth/login`

Request:

```json
{
  "email": "fan@example.com",
  "password": "secret123"
}
```

Response `200`:

```json
{
  "success": true,
  "message": "Login successful",
  "user": {
    "id": "user-doc-id",
    "name": "Fan",
    "email": "fan@example.com",
    "avatarUrl": "",
    "role": "user",
    "roles": ["user"]
  },
  "token": "jwt-token"
}
```

Errors:

- `400`: missing email or password.
- `401`: invalid email or password.

## Home Feed

### `GET /api/home`

Public feed for the home screen.

### `GET /api/home?userId=:userId`

Personalized feed. Requires a bearer token for the same user id unless the
authenticated user is an admin. If a bearer token is sent without `userId`, the
feed is personalized for the authenticated user.

Response:

```json
{
  "success": true,
  "data": {
    "live": [],
    "topMatches": [],
    "recommended": [],
    "events": []
  }
}
```

All arrays contain match objects.

## Matches

### `GET /api/matches?date=:date`

Returns grouped matches for a provider UTC date. This legacy selector is preserved; local calendar screens use the explicit interval contract below.

Allowed date values:

```text
TODAY, YESTERDAY, TOMORROW, YYYY-MM-DD
```

Response:

```json
{
  "success": true,
  "date": "2026-09-02",
  "source": "sportscore",
  "total": 2,
  "data": [
    {
      "competition": {
        "id": "PL",
        "code": "PL",
        "name": "Premier League",
        "emblem": "",
        "country": "England",
        "countryFlag": ""
      },
      "matches": []
    }
  ]
}
```

Compatibility alias:

```http
GET /api/matches/date?date=:date
```

### `GET /api/matches?from=<UTC-ISO>&to=<UTC-ISO>`

Returns grouped fixtures inside the caller's half-open interval `[from, to)`. The backend fetches every overlapping provider UTC date, filters actual kickoff instants, removes duplicate fixture IDs and sorts fixtures within the interval. The end instant is exclusive, so a match at the next local midnight belongs to the next day.

Rules:

- Both bounds are required, must be exact UTC ISO timestamps ending in `Z`, and must identify valid instants.
- The duration must be positive and no greater than 26 hours. A calendar day may last 23 or 25 hours at a daylight-saving transition.
- `date` cannot be mixed with `from`/`to`. Invalid, missing, reversed, non-UTC or oversized bounds return HTTP `400` before provider reads.
- The response echoes normalized `range.from`, `range.to` and `range.toExclusive: true`; it does not return a misleading single UTC `date` selector.

For **1 October 2026 in Asia/Riyadh**, local midnight-to-midnight is:

```http
GET /api/matches?from=2026-09-30T21:00:00.000Z&to=2026-10-01T21:00:00.000Z
```

Flutter constructs both local calendar midnights using `MatchdayWindow.forLocalDate`, then calls `LocalBackendService.getMatchesForLocalDay`. It validates the echoed bounds, filters kickoff instants defensively and caches the result under a key containing the local date and both UTC bounds. Calendar days use the next local midnight instead of adding a fixed 24 hours. Saved coverage is retained even for an empty fixture list.

Example HTTP `200` with one available UTC day and one unavailable UTC day:

```json
{
  "success": true,
  "source": "sportscore",
  "range": {
    "from": "2026-09-30T21:00:00.000Z",
    "to": "2026-10-01T21:00:00.000Z",
    "toExclusive": true
  },
  "total": 0,
  "coverage": {
    "available": true,
    "complete": false,
    "partial": true,
    "possiblyTruncated": false,
    "returned": 0,
    "utcDays": [
      {"date":"2026-09-30","source":"sportscore","available":true,"returned":0,"complete":true,"possiblyTruncated":false},
      {"date":"2026-10-01","source":"unavailable","available":false,"returned":0,"complete":false,"possiblyTruncated":false}
    ]
  },
  "data": []
}
```

`data` uses the same competition groups as the legacy endpoint. A partially available interval returns HTTP `200` with usable groups and explicit `partial: true`, `complete: false`; an empty partial list does not prove that no games were scheduled. When all overlapping UTC days are unavailable, HTTP `503` returns `success: false`, `source: "unavailable"`, the echoed range, `total: 0`, `data: []` and `coverage.available: false`. A successful authoritative empty provider response remains HTTP `200`.

Coverage aggregates the availability and cap metadata of both general and supplemental league queries. A provider page at its 200-fixture limit, failed supplement or uncertified completeness cannot become `complete: true` merely because other fixtures merged successfully. These fields describe fixture-feed coverage; they do not certify worldwide coverage, club identity completeness, roster availability or advanced statistics.

SportScore documents no pagination cursor, page or offset for `/api/v1/fixtures/`. A capped daily read makes at most three additional fixture-batch requests using its documented `live`, `finished` and `upcoming` filters, retaining the original feed and merging exact fixture identities. Every batch is checked against the requested UTC day, competition and status before it is cached as a fixture. Initial or partition caps remain `possiblyTruncated: true`, `complete: false`; status partitions cannot certify coverage of postponed/cancelled or unlisted fixtures. Concurrent identical upstream reads share one request, and successful batches retain the existing short cache lifetime. All SportScore HTTP reads, including optional shared standings lookups for club identity, use at most three active slots with at most 128 distinct pending reads; queue exhaustion stays unavailable/partial. These bounds limit bursts and duplicate reads, but do not replace a daily-quota monitor.

Each query may additionally report `upstreamReturned`, `accepted`, `recovered`, `invalidRecords`, `outsideDate`, `outsideCompetition`, `outsideStatus`, `reason` and up to three `partitions`. `returned` is the merged usable row count; `upstreamReturned` includes duplicate records across batches. Each partition reports its requested status, availability, raw/accepted counts, cap flag and rejected-record counts. Rejection counts describe reads rather than unique fixtures, so a wrong record repeated in multiple batches may be counted more than once. The day-level `invalidRecords` and `outsideDate` totals preserve records already rejected by the adapter instead of disappearing during merging.

### `GET /api/matches/live`

Returns live matches. A successful empty primary feed remains HTTP `200` with an empty list; a provider outage with no usable fallback returns HTTP `503`. Finished fixtures are not used to fabricate a live list.

SportScore live reads retain genuinely active fixtures that kicked off on the previous UTC day, so a midnight boundary does not silently remove an ongoing match. Daily calendar partitions remain strictly scoped to their selected UTC day. Live query coverage includes caps and malformed/out-of-scope provider rows.

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "count": 1,
  "data": []
}
```

### `GET /api/matches/search?q=:query`

Searches today's matches by team or competition name.

Rules:

- `q` is required.
- `q` must be 120 characters or fewer.

Response:

```json
{
  "success": true,
  "count": 1,
  "data": []
}
```

### `GET /api/matches/competition/:code`

Returns matches for a supported competition. Optional query:

```http
dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
```

Rules:

- `:code` must be a supported competition code.
- `dateFrom` and `dateTo`, when present, must be concrete `YYYY-MM-DD` dates.
- `dateFrom` must not be after `dateTo`.

Response:

```json
{
  "success": true,
  "source": "football-data.org",
  "count": 20,
  "data": []
}
```

### `GET /api/matches/:id`

Returns match details. The `:id` can be a provider id or a SportScore slug.

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "data": {
    "id": "497410",
    "utcDate": "2026-08-29T16:30:00Z",
    "status": "TIMED",
    "competition": {},
    "homeTeam": {},
    "awayTeam": {},
    "score": {},
    "venue": "Stadium Name",
    "attendance": null,
    "goals": [],
    "bookings": [],
    "substitutions": [],
    "referees": [],
    "head2head": null,
    "timeline": [],
    "lineups": null,
    "tracker": null
  }
}
```

## Statistics And Detail Facades

These endpoints are backend-managed provider facades for Flutter detail screens.
Flutter should not call SportScore, SofaScore, TheSportsDB, football-data.org,
KickOff, BSD, or RapidAPI directly.

### `GET /api/stats/leagues`

Returns supported competitions.

Response:

```json
{
  "success": true,
  "data": []
}
```

### `GET /api/stats/teams?league=:code`

Returns standings for a supported competition. `league` defaults to `PL`.

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "data": []
}
```

Each item is a standing row.

### `GET /api/stats/players?league=:code&limit=20&stat=goals`

Returns top scorers or assists leaders for a supported competition.

Query:

| Name | Required | Notes |
| --- | --- | --- |
| `league` | No | Defaults to `PL` |
| `limit` | No | Defaults to `20`, max `50` |
| `stat` | No | `goals` or `assists`; any other value becomes `goals` |

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "data": []
}
```

Each item is a top scorer row.

### `GET /api/stats/matches/:id/timeline`

Returns normalized match events.

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "data": []
}
```

Each item is a timeline event.

### `GET /api/stats/matches/:id/lineups`

Returns normalized match lineups or an unavailable message.

Response when available:

```json
{
  "success": true,
  "source": "sportscore",
  "data": {
    "formation": { "home": "4-3-3", "away": "4-3-3" },
    "home": [],
    "away": [],
    "homeBench": [],
    "awayBench": [],
    "homeCoach": "Home Coach",
    "awayCoach": "Away Coach"
  }
}
```

Response when unavailable:

```json
{
  "success": true,
  "source": "unavailable",
  "data": {
    "message": "Lineups not available for this match",
    "formation": { "home": "", "away": "" },
    "home": [],
    "away": []
  }
}
```

### `GET /api/stats/deep/match/:id`

Returns full detail payload for the match details tabs.

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "data": {
    "matchInfo": {},
    "timeline": [],
    "lineups": null,
    "tracker": null,
    "goals": [],
    "bookings": [],
    "substitutions": [],
    "statistics": {
      "goals": { "home": 0, "away": 0 },
      "yellowCards": { "home": 0, "away": 0 },
      "redCards": { "home": 0, "away": 0 },
      "substitutions": { "home": 0, "away": 0 },
      "halfTimeScore": { "home": null, "away": null },
      "fullTimeScore": { "home": 0, "away": 0 },
      "hasAdvancedStats": false
    },
    "head2head": null
  }
}
```

Advanced provider statistics such as `team1.totalShots`, `team2.ballPossession`,
or `expectedGoals` are optional and must only be returned when supplied by a
real upstream provider. The API should not synthesize xG, possession, shots, or
passes from the scoreline.

When no provider has details:

```json
{
  "success": true,
  "source": "empty",
  "data": null
}
```

### `GET /api/stats/deep/team/:id`

Returns rich team detail for `ClubDetailsScreen`. App-facing ids and names from
the local team list are resolved before provider lookup so ids such as `57`
remain stable for Arsenal.

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "data": {
    "info": {
      "id": "57",
      "targetId": "Arsenal",
      "name": "Arsenal",
      "shortName": "Arsenal",
      "logo": "https://example.com/crest.png",
      "crest": "https://example.com/crest.png",
      "league": "Premier League",
      "leagueCode": "PL",
      "country": "England"
    },
    "squad": [],
    "matches": {
      "recent": [],
      "upcoming": []
    },
    "standing": null,
    "stats": null
  }
}
```

### `GET /api/stats/deep/player/:id`

Returns rich player detail for `PlayerDetailsScreen`.

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "data": {
    "info": {
      "name": "Player Name",
      "fullName": "Player Name",
      "image": "https://example.com/player.png",
      "team": "Club",
      "teamBadge": "https://example.com/club.png",
      "position": "Player"
    },
    "seasonStats": {
      "matches": 20,
      "goals": 10,
      "assists": 5,
      "minutes": 1600,
      "rating": 7.5,
      "shots": 40,
      "passes": 800,
      "passesAccuracy": 88,
      "tackles": 20,
      "dribbles": 30,
      "keyPasses": 25,
      "yellowCards": 2,
      "redCards": 0
    },
    "careerBySeason": [],
    "careerTotals": {},
    "attributes": {},
    "honours": [],
    "formerTeams": []
  }
}
```

### `GET /api/stats/deep/competitions`

Returns the same supported competition list as `/api/stats/leagues`.

Response:

```json
{
  "success": true,
  "source": "supported-contract",
  "data": []
}
```

## Universal Search

### `GET /api/search?q=:query`

Searches teams, players, and supported competitions through provider data plus
local fallback data.

Rules:

- `q` is required.
- `q` must be 120 characters or fewer.

Response:

```json
{
  "success": true,
  "data": {
    "teams": [
      {
        "id": "57",
        "targetId": "Arsenal",
        "provider": "football-data.org",
        "providerId": "57",
        "name": "Arsenal",
        "shortName": "Arsenal",
        "league": "Premier League",
        "leagueCode": "PL",
        "country": "England",
        "logo": "https://crests.football-data.org/57.png",
        "slug": "arsenal"
      }
    ],
    "players": [],
    "leagues": [
      {
        "id": "PL",
        "targetId": "PL",
        "code": "PL",
        "provider": "football-data.org",
        "providerId": "PL",
        "name": "Premier League",
        "country": "England",
        "logo": "https://crests.football-data.org/PL.png",
        "aliases": ["EPL", "English Premier League"]
      }
    ],
    "matches": []
  },
  "meta": {
    "source": "sportscore+local-fallback"
  }
}
```

## News

### `GET /api/news?limit=20`

The endpoint must not fabricate production news. By default it returns an empty
list until a real licensed news provider is configured.

Response without a provider:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "provider": "none",
    "demo": false
  }
}
```

Demo content is available only when `ENABLE_DEMO_NEWS=true`.

News item when demo mode or a provider is enabled:

```json
{
  "id": "news-id",
  "title": "Article title",
  "summary": "Short summary",
  "description": "Short summary",
  "content": "Article body",
  "category": "Football",
  "imageUrl": "https://example.com/image.jpg",
  "urlToImage": "https://example.com/image.jpg",
  "publishedAt": "2026-09-02T12:00:00.000Z",
  "author": "Source",
  "source": "Provider",
  "url": "https://example.com/article"
}
```

## Users

All user routes require `Authorization: Bearer <token>` and allow access only to
the same authenticated user or an admin.

### `GET /api/users/:userId/preferences`

Response:

```json
{
  "success": true,
  "data": {
    "teams": ["Arsenal"],
    "leagues": ["PL"],
    "content": ["goals", "lineups"]
  }
}
```

If no document exists:

```json
{
  "success": true,
  "data": {}
}
```

### `POST /api/users/:userId/preferences`

Request:

```json
{
  "teamIds": ["sc_t_arsenal", "sc_t_real-madrid"],
  "teamsV2": [{"targetId":"sc_t_real-madrid","provider":"sportscore","name":"Real Madrid"}],
  "leagues": ["PL", "PD"],
  "content": ["goals", "lineups"],
  "fcmToken": "optional-device-token"
}
```

Normalization:

- `teamIds`: up to 50 exact scoped IDs used for targeted notifications/recommendations. Records in `teams`, `teamsV2` or `teamRecords` also contribute verified IDs.
- `teamsV2`: display records normalized with the favorite item contract.
- Legacy `teams` and `leagues`: unique strings, empty values removed, max 50. Legacy names cannot route alerts. Omitting new fields preserves an existing verified index; explicitly empty new arrays clear it.
- `content`: unique strings, empty values removed, max 20.
- `fcmToken`: saved when a non-empty string, cleared when `null`.

Response:

```json
{
  "success": true,
  "message": "Preferences saved successfully"
}
```

### `GET /api/users/:userId/favorites`

Response:

```json
{
  "success": true,
  "data": [
    {
      "id": "firestore-doc-id",
      "type": "team",
      "targetId": "Arsenal",
      "canonicalKey": "team:arsenal",
      "displayName": "Arsenal",
      "provider": "football-data.org",
      "providerId": "57",
      "imageUrl": "https://example.com/badge.png",
      "metadata": {},
      "createdAt": "Firestore Timestamp",
      "updatedAt": "Firestore Timestamp"
    }
  ]
}
```

### `POST /api/users/:userId/favorites`

Request:

```json
{
  "item": {
    "type": "team",
    "targetId": "Arsenal",
    "displayName": "Arsenal"
  }
}
```

Response when created:

```json
{
  "success": true,
  "id": "firestore-doc-id",
  "created": true,
  "data": {
    "id": "firestore-doc-id",
    "type": "team",
    "targetId": "Arsenal",
    "canonicalKey": "team:arsenal",
    "displayName": "Arsenal"
  }
}
```

Response when duplicate:

```json
{
  "success": true,
  "id": "existing-firestore-doc-id",
  "created": false,
  "data": {
    "id": "existing-firestore-doc-id",
    "type": "team",
    "targetId": "Arsenal",
    "canonicalKey": "team:arsenal"
  }
}
```

### `DELETE /api/users/:userId/favorites/:favoriteId`

Response:

```json
{
  "success": true,
  "message": "Favorite removed"
}
```

### `POST /api/users/:userId/avatar`

Multipart form-data. Field:

```text
image
```

Accepted MIME types:

```text
image/jpeg, image/png, image/webp, image/gif
```

Max file size: 5 MB.

Response:

```json
{
  "success": true,
  "message": "Avatar uploaded successfully",
  "avatarUrl": "https://api.example.com/uploads/avatars/user-123.png"
}
```

## Notifications

All notification routes require `Authorization: Bearer <token>` and allow access
only to the same authenticated user or an admin.

### `GET /api/notifications/:userId`

Returns up to 50 notifications sorted newest first.

Response:

```json
{
  "success": true,
  "data": [
    {
      "id": "notification-id",
      "title": "GOAL!",
      "message": "Arsenal scored",
      "matchId": "497410",
      "type": "goal",
      "isRead": false,
      "createdAt": "Firestore Timestamp"
    }
  ]
}
```

### `PATCH /api/notifications/:userId/:notificationId`

Marks a notification as read.

Response:

```json
{
  "success": true,
  "message": "Notification marked as read"
}
```

## Chat

### `GET /api/chat/:matchId/messages`

Public route. Returns the latest 50 messages sorted oldest first.

Response:

```json
{
  "success": true,
  "data": [
    {
      "id": "message-id",
      "userId": "user-id",
      "username": "Fan",
      "user": "Fan",
      "text": "Great match",
      "message": "Great match",
      "timestamp": "Firestore Timestamp",
      "time": "12:30",
      "isSystem": false
    }
  ]
}
```

### `POST /api/chat/:matchId/send`

Protected route.

Request:

```json
{
  "text": "Great match"
}
```

Rules:

- Message must be a string.
- Message length must be 1 to 500 characters after trimming.
- `userId` and display name are derived from the token.

Response `201`:

```json
{
  "success": true,
  "data": {
    "userId": "user-id",
    "username": "Fan",
    "text": "Great match",
    "timestamp": "Firestore Timestamp"
  }
}
```

## Leagues

Compatibility public routes. New Flutter work should prefer `/api/stats/leagues`,
`/api/stats/teams`, and `/api/matches/competition/:code`.

### `GET /api/leagues`

Response:

```json
{
  "success": true,
  "source": "supported-contract",
  "data": []
}
```

### `GET /api/leagues/:id`

`:id` may be a supported code such as `PL` or lowercase `pl`.

Response:

```json
{
  "success": true,
  "source": "supported-contract",
  "data": {}
}
```

### `GET /api/leagues/:id/teams`

Returns standings rows for the league.

### `GET /api/leagues/:id/matches?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`

Returns match rows for the league.

## Teams

Compatibility public routes. Known app team ids and names resolve locally first
to avoid provider-id collisions.

### `GET /api/teams`

Optional query:

```http
league=PL
```

Response:

```json
{
  "success": true,
  "source": "sportscore",
  "data": [
    {
      "id": "57",
      "targetId": "Arsenal",
      "provider": "sportscore",
      "providerId": "57",
      "name": "Arsenal",
      "shortName": "Arsenal",
      "league": "Premier League",
      "leagueCode": "PL",
      "country": "England",
      "logo": "https://crests.football-data.org/57.png",
      "crest": "https://crests.football-data.org/57.png"
    }
  ]
}
```

### `GET /api/teams/:id`

Simple team lookup. Use `/api/stats/deep/team/:id` for rich club detail screens.

### `GET /api/teams/:id/matches`

Returns:

```json
{
  "success": true,
  "source": "sportscore",
  "data": {
    "recent": [],
    "upcoming": []
  }
}
```

### `GET /api/teams/:id/squad`

Returns:

```json
{
  "success": true,
  "source": "kickoffapi",
  "data": []
}
```

## Players Admin

### `POST /api/players/sync`

Protected admin route. Fetches provider player data and rewrites the Firestore
`players` reference collection in batches.

Response:

```json
{
  "success": true,
  "message": "123 players synced successfully"
}
```

## RapidAPI Proxy

### `GET /api/proxy/rapidapi/:endpoint`

Optional allowlisted proxy. Disabled unless `ENABLE_RAPIDAPI_PROXY=true`.

Allowed endpoints:

```text
football-current-live
football-get-match-details
football-get-match-event
football-get-match-statistics
football-get-match-lineup
football-get-standing
football-get-all-leagues
football-get-top-leagues
football-get-all-season
football-get-all-today-match
football-get-matches-by-league
```

Required when enabled:

```text
RAPID_API_KEY
RAPID_API_HOST
```

Flutter should use backend facade routes instead of this proxy unless a specific
feature intentionally needs an allowlisted RapidAPI endpoint.

## Socket.io Contract

Authentication accepts the same bearer token through either:

- `handshake.auth.token`
- `Authorization: Bearer <token>` header

Socket room names are internal:

```text
user:{id}
match:{id}
team:{name}
```

### Client to Server Events

#### `joinUser`

Payload:

```json
"user-id"
```

Requires socket authentication for the same user id unless the socket user is an
admin. On failure, server emits `authorizationError`.

#### `joinMatch`

Payload:

```json
"match-id"
```

Public subscription to a match room.

#### `subscribeFavorites`

Payload:

```json
{
  "teams": ["sc_t_arsenal", {"targetId":"ko_t_541","provider":"kickoffapi","name":"Real Madrid"}],
  "userId": "user-id"
}
```

Subscribes to up to 50 rooms using exact scoped IDs. Legacy names and ambiguous bare numeric IDs are ignored. The user room part requires self/admin access.

#### `sendMessage`

Payload:

```json
{
  "matchId": "497410",
  "message": "Great match"
}
```

Requires socket authentication. The server derives `userId`, `username`, and
`user` from the token. `message` must be 1 to 500 characters.

### Server to Client Events

#### `newMessage`

Emitted to a match room after `sendMessage`.

```json
{
  "id": "message-id",
  "userId": "user-id",
  "username": "Fan",
  "user": "Fan",
  "text": "Great match",
  "message": "Great match",
  "timestamp": "Date"
}
```

#### `liveMatches`

Broadcast to all clients when background polling is enabled.

```json
[
  {
    "id": "497410",
    "status": "IN_PLAY",
    "homeTeam": {},
    "awayTeam": {},
    "score": {}
  }
]
```

#### `liveEvent`

Emitted to match and team rooms when a live event is detected.

```json
{
  "matchId": "497410",
  "type": "goal",
  "team": "Arsenal",
  "teamId": "sc_t_arsenal",
  "againstTeamId": "sc_t_chelsea",
  "against": "Chelsea",
  "score": "1 - 0",
  "tournament": "Premier League",
  "player": "Unknown",
  "minute": 52,
  "createdAt": "Date"
}
```

#### `notification`

Emitted to a user room for saved personal notifications.

```json
{
  "title": "GOAL!",
  "message": "Arsenal scored",
  "matchId": "497410",
  "type": "goal",
  "team": "Arsenal",
  "score": "1 - 0",
  "tournament": "Premier League"
}
```

#### `authorizationError`

```json
{
  "message": "You are not allowed to join this user room."
}
```

## Environment

Production requires:

```text
NODE_ENV=production
PUBLIC_BASE_URL
JWT_SECRET
ALLOWED_ORIGINS
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
```

Optional provider settings:

```text
FOOTBALL_DATA_API_KEY
KICKOFF_API_KEY
BSD_API_TOKEN
BSD_BASE_URL=https://sports.bzzoiro.com
ENABLE_SOFASCORE_PROXY=false
ENABLE_LIVE_POLLING=false
ALLOW_FIRESTORE_SEED=false
ENABLE_RAPIDAPI_PROXY=false
RAPID_API_KEY
RAPID_API_HOST
ENABLE_DEMO_NEWS=false
```

Provider behavior:

- Configured BSD v2 is preferred for covered fixtures, standings and scorers;
  SportScore supplements wider fixture coverage. Match, club and player details
  retain their exact source identity; no name-only joins remap provider IDs.
- BSD detail IDs are `bsd_<event>`, `bsd_t_<team>` and `bsd_p_<player>`.
  The actual catalog retains known codes and uses `BSD:<league-id>` for other
  entries. Valid empty reads are authoritative; failed reads remain unavailable.
- Predicted lineups are explicitly labeled and retain supplied confidence;
  estimated xG retains its provenance. Missing fields are not zero values.
- Player current-season totals include only the selected club/competition/season
  context. Career and transfer rows are separate from these totals.
- SportScore continues to serve its own IDs and available fallback data.
- KickOff API is used for richer team/player, squad, standings, fixtures, and
  match fallback data when configured.
- football-data.org is the stable fallback for supported competitions.
- SofaScore is used only behind backend facades where configured in code.
- News returns an empty list unless demo mode or a real provider is enabled.

## Verification

### Public BSD images

`GET /api/images/bsd/:type/:id` serves public BSD PNG/JPEG/WebP images for Flutter Web. `type` is restricted to `team`, `player`, `league`, `manager` or `venue`; `id` is a positive safe integer. The upstream host is fixed, redirects are disabled, and no API token is forwarded. Requests are coalesced and the cache is limited to 16 MiB/128 images. Missing images return `404`, invalid type/ID returns `400`, and unavailable or invalid upstream image bytes return `502` (or `503` when the concurrency bound is reached). Web responses use the normal app origin policy.

Run the backend contract checks with:

```bash
npm test
```

This executes:

```bash
node scripts/validate-contracts.js
node scripts/check-js.js
```
