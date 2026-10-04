# Production release gates

This is a local review and verification workflow. None of the commands deploys the service or modifies user records.

## 1. Validate the implementation offline

Use Node.js 22 or newer, install the committed lockfile with `npm ci --ignore-scripts`, then run `npm test`. Contract checks and unit tests use mocks for database and provider effects. Run `npm run audit:prod` and review any dependency advisory before release.

## 2. Validate production configuration

Set environment variables on the intended host or in a local ignored environment file, then run `npm run check:production`. The command forces production validation regardless of the local `NODE_ENV`, never prints secrets, and does not initialize Firebase or contact a provider.

Required production variables:

- `ALLOWED_ORIGINS`: exact browser HTTPS origins, separated by commas. No wildcard, localhost, URL credentials, path, query or fragment. Add each intended web/admin origin explicitly.
- `PUBLIC_BASE_URL`: the public HTTPS backend origin, without `/api`; uploaded image URLs use it.
- `JWT_SECRET`: at least 32 bytes of unpredictable material. Supply the real value through the hosting secret store. The validator cannot measure entropy and does not prove a copied/repeated secret is safe.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: real environment credentials. A development service-account file does not satisfy production validation. The check proves presence/configuration shape, not account permissions or database reachability.
- `TRUST_PROXY`: set according to the actual ingress path. Accepts `false`/`0`, a bounded count from `1` to `5`, or explicit IP/CIDR ranges. `true`, hostname guesses and unrestricted `/0` networks are rejected. The current production default is one hop for compatibility with the previous configuration; the actual Render/proxy topology has not been independently verified. Prefer host-published stable proxy ranges when available. Wrong hop assumptions may let a direct client spoof forwarded IP headers and bypass IP limits.
- If `ENABLE_RAPIDAPI_PROXY=true`, configure both its key and host. Background live polling remains opt-in with `ENABLE_LIVE_POLLING=true`.

The origin list applies to HTTP and direct Socket.io WebSocket handshakes. Originless native clients can access the public API; protected routes and personal rooms still require their existing token/ownership checks. CORS does not replace authentication.

## 3. Check a running candidate

After the candidate has been started on the intended host, run:

```bash
npm run smoke:health -- https://your-backend.example.com
```

For an explicitly local test only:

```bash
npm run smoke:health -- http://127.0.0.1:3000 --allow-local
```

The gate requires HTTP 200 and `success: true` from `/api/health` and `/api/ready`. Readiness reports successful startup configuration/Firebase initialization and stops returning ready when shutdown begins. It performs no per-request football API calls or Firestore reads. It does not prove provider freshness, full data coverage, database availability, notification delivery, or production capacity. Those require separate integration/coverage checks.

Run the separate public sports integration gate against the local candidate:

```powershell
npm run smoke:sports -- http://127.0.0.1:3000 --allow-local --date 2026-10-01 --report D:\kicksphere\artifacts\local-sports-smoke.json
```

For a future hosted candidate use its HTTPS origin without `--allow-local`. The command performs nine public GET checks: health, readiness, active BSD catalog, an explicit exclusive UTC calendar interval, a reference BSD club, its squad, a verified player round trip, a complete supported image container and malformed-ID rejection. Responses are streamed with bounded byte limits and canceled on overflow. Image container checks do not replace browser/device rendering verification. The default reference club is `bsd_t_57`; `--team bsd_t_ID` selects another verified club. Results contain only public counts, paths and validation diagnostics, never credentials or full API bodies. Empty/partial calendar coverage stays explicit and does not certify worldwide completeness; partial coverage is a warning, while availability/identity/range/image contract failures return a nonzero exit code. A club whose image or squad is unavailable fails this reference integration probe rather than being silently declared ready. These requests consume the providers' ordinary GET quotas. They do not create user records, favorites or push notifications.

## 4. Review and publish separately

Confirm ingress trust, accepted web origins, the Android HTTPS API build setting, provider limits, secret storage, and a rollback revision before authorizing an external deployment. Health success alone must not bypass the data coverage review.

On 4 October 2026 the user reported that Render is ready and hosting preparation resumed. The actual service URL and configuration still need to be verified; this document does not certify a deployed service. See `RENDER_SETUP_AR.md` for the prepared free-service settings and known hosting limits. Hosted Flutter builds require an explicit `KICKSPHERE_API_BASE_URL`; they do not silently select the previous Render service. Keep the local runtime available until the hosted data and phone build have been verified.

`deploy.sh` now starts a production service from the backend repository root using the lockfile and existing host-managed secrets. It must be invoked by the host process manager against an already reviewed checkout. It does not clone, delete, upload secrets or create a background duplicate server. The old local SFTP/FTPS helpers are excluded from version control because they contain credential assignments or unsafe legacy transfer behavior; they are not part of the release workflow.

## Favorites migration contract

New favorite item examples:

```json
{"type":"team","targetId":"sc_t_real-madrid","provider":"sportscore","name":"Real Madrid","logo":"https://example.com/logo.png"}
```

```json
{"type":"team","targetId":"ko_t_529","provider":"kickoffapi","name":"Barcelona"}
```

The API returns normalized `displayName`/`imageUrl` aliases. `providerId` is optional metadata and must never replace the scoped `targetId` as identity. Club profile/matches/squad endpoints accept the scoped SportScore form by unwrapping its exact slug only at the provider lookup; it does not authorize name-based fallback to a different provider.

`POST /api/users/:userId/preferences` accepts `teamIds` (scoped string array) and `teamsV2` (favorite records), or team records in `teams`. The backend derives a deduplicated `teamIds` index for Firestore notification queries and preserves display records in `teamsV2`. Empty explicit new arrays clear the verified index. Older clients that omit new fields retain any previously verified index when saving legacy preferences.

`subscribeFavorites.teams` accepts scoped IDs or records. Existing `userId` room access remains ownership/admin protected. Legacy names stay stored/readable but do not subscribe to rooms, qualify for targeted notifications, or select recommendations until the client resolves a genuine provider identity. No server task silently migrates legacy names or modifies live account records.

## Provider club identity limits

SportScore fixture display names are not club IDs. The service accepts explicit provider club IDs/slugs/URLs, or resolves an exact unique club name inside a standings response whose competition is independently confirmed. Unknown or conflicting competition scopes, duplicate names, unresolved duplicate rows and contradictory club identifiers stay unresolved. Team widget fixtures require their own exact provider competition slug before standings-based enrichment.

Standings membership requests share a cache and one in-flight lookup per competition, with at most three upstream lookups at once. Identity enrichment waits at most eight seconds in total per fixture response. A cold or unavailable league cache can therefore return usable fixtures with null club IDs; remaining bounded lookups may finish and warm the cache for later requests. It never guesses IDs or mutates an already returned fixture. This protects schedule latency, but following/targeted alerts for unresolved clubs remain unavailable until a genuine ID is verified. Provider data completeness and availability are separate from club identity verification.

On 4 October 2026, the lockfile was updated from `@fastify/busboy` 3.2.0 to 3.2.2 after a runtime advisory was found. All 238 backend tests passed afterward, and `npm run audit:prod` reported zero vulnerabilities for the runtime installed with `npm ci --omit=dev --omit=optional --ignore-scripts`. The broader development dependency tree still reports advisories in the `nodemon` chain. The production audit excludes development and optional dependencies; an install that includes those packages must audit its actual dependency tree separately. Re-run the production audit before deploying a new revision because advisory results change over time.
