# Installation notification delivery

The backend persists push registrations independently for each signed-in installation. All routes require a valid Bearer token and the authenticated user must equal `:userId`; an administrator cannot register or revoke another account's installation.

## API

`PUT /api/users/:userId/notification-devices/:deviceId` replaces that installation's registration and preferences. Use a persistent random installation ID, 8–128 characters from letters, digits, `_` and `-`.

```json
{
  "token": "FCM registration token",
  "platform": "android",
  "language": "ar",
  "preferences": {
    "sound": true,
    "vibration": true,
    "hideScores": false,
    "favoritesOnly": true,
    "teamIds": ["bsd_t_57"],
    "matchIds": ["bsd_212636"]
  }
}
```

Accepted platforms are `android`, `ios`, and `web`; languages are `ar` and `en`. Preferences require actual booleans. Team arrays contain at most 50 exact provider identities (`bsd_t_…`, `ko_t_…`, or `sc_t_…`); match arrays contain at most 100 provider identities (`bsd_…`, `ko_…`, or an exact SportScore match slug). Human-readable team names and unscoped numeric match IDs are rejected. Tokens are 20–4096 safe characters. Responses never echo tokens.

`DELETE` at the same URL idempotently revokes only that user's installation. Revoke before signing out and register again after signing in or a token refresh. The same persistent installation and token may atomically move between authenticated accounts; an unrelated installation cannot claim an owned token. Token rotation removes the old ownership index. A user can register at most ten installations; registrations older than 90 days are excluded from delivery until refreshed.

`POST /api/users/:userId/notification-devices/:deviceId/test` sends an explicitly labeled system test. It requires an existing registration and allows one test per minute; registration refresh does not reset this limit. Success means FCM accepted the send, not that a handset displayed it. The response's `data.eventId` matches the identifier in the push payload, allowing a handset test to correlate actual receipt with this request without exposing a registration token or authentication credential. An unaccepted send returns HTTP 502 and `success:false`; missing registrations return 404, throttling returns 429. The test has `kind` and `type` `systemTest` and no match identity.

## Audience and payload

Verified cross-provider fixture joins additionally supply `providerIdentities`.
The canonical descriptor must match the event's own fixture, oriented participant
IDs, competition and UTC kickoff. Bounded, distinct provider descriptors are
validated before queries, preference checks or room routing. Both old match
bells and old provider-scoped club favorites can therefore receive the same
canonical event. Multiple matching query filters collapse into one installation
and one stable event ID; detailed events still require a match bell and spoiler
suppression remains authoritative. Invalid provenance grants no extra recipients.
Compact `data.event` retains this array, `utcDate`, and `competitionCode` within
the FCM envelope budget; optional display strings and redundant scalar fields
are shortened before identity or navigation data.

Local validation uses the recently verified handset owner's restricted audience
and 30-second source polling. The guarded local launcher requires a unique
tested Android owner within 24 hours and an authenticated Android registration
for that same owner within four hours; it does not hard-code
previously observed matches or modify preferences. The application works through
`adb reverse tcp:3000 tcp:3000` while this computer, backend process and USB
connection remain active. Production polling and unattended hosting are separate
deployment work.

Background match pushes reach an installation only for one of its exact favorite team IDs or an explicitly subscribed match ID. `favoritesOnly` does not disable an explicit match bell. It does not turn background delivery into a broadcast. Detailed red-card and VAR alerts require an explicit match subscription. `hideScores:true` suppresses **every** match-event push, including goal, kickoff, final, card, and VAR messages. The system test is still permitted.

An active socket on one of a user's devices does not prevent push delivery to any installation. FCM sends `notification` and `data`; Android/iOS display the notification in the background. Foreground clients route the data through their shared event ledger and display once. They should never redisplay the background FCM notification.

The authoritative compact `data.event` JSON includes a stable `eventId`, opaque `matchId`, `type`, provider, `emittedAt` milliseconds, structured home/away teams and score, scoring side, player, minute, and card type when known. Scalar `eventId`, `matchId`, `type`, `kind`, `provider`, `emittedAt`, `sound`, `vibration`, and `recipientUserId` support routing and rejection of delayed messages for a previous account. Recipient identity is not included in the shared Socket event. Optional duplicated compatibility fields may be omitted when the message approaches the byte budget; always prefer `data.event`. Unknown players, scores, and minutes are left empty/null rather than invented.

Android notification channels are `match_events_${type}_s${sound ? 1 : 0}_v${vibration ? 1 : 0}`. The client must create these channels before registration. Event IDs also set Android tags and APNs collapse IDs. Messages expire after five minutes. iOS vibration behavior is controlled by the platform; Android channels enforce the vibration preference.

The poller establishes a baseline on first sightings and never replays historical scores or incidents. Explicit durable match subscriptions trigger bounded timeline lookups without sockets: at most six detail requests, three concurrent reads, and 200 installation documents per query page. Audience pagination reaches every installation; delivery concurrency is limited to four users, with each user's installations sent sequentially. Delivery rereads the current registration so a revoked installation or updated preference is respected. Invalid FCM tokens are removed only if the stored token still equals the failed token, preserving a concurrently refreshed token. FCM error logging records categories without request/token contents.

The top-level Firestore collections are `notificationDevices` and `notificationTokens`. Only trusted server code should access them; client Firestore rules must deny direct reads and writes. Their normal array indexes support queries on `preferences.teamIds` and `preferences.matchIds`; no new compound index is required. New registrations disable the old account-wide token path. Existing legacy account tokens remain compatible until migration, but never bypass an account's score-hiding setting.

Inbox notifications use an event-derived document ID and a transaction to preserve read state and avoid duplicate personal delivery across emitters. Inbox storage failure does not prevent push delivery. Invalid-token classification follows [Firebase's error code reference](https://firebase.google.com/docs/cloud-messaging/error-codes); an ambiguous invalid-argument payload error does not remove a valid installation.

This implementation does not enable polling or modify cloud settings. A configured Firebase Admin messaging identity, deployed backend version, active production event poller, and a real handset are needed to verify end-to-end OS delivery.

Successful registration additionally reports `automaticEventsEnabled`; a registered device must not be presented as receiving automatic match events while the source poller is disabled. The event poller establishes its first baseline immediately after enabling. Its default interval remains 90 seconds; `LIVE_EVENTS_POLL_INTERVAL_MS` and `LIVE_MATCHES_POLL_INTERVAL_MS` accept explicit intervals from 30000 to 900000 milliseconds. Lower intervals consume provider quota and cannot eliminate upstream delay.

Transient device-send errors enter an in-memory retry queue bounded to 1000 device/event entries. Retries use 30/60/120-second backoff (initial quota retry at least 60 seconds), run on subsequent poll cycles, and expire within five minutes. Every retry rereads current ownership, preferences and token. Accepted, revoked, hidden and invalid-token events are not retried. At most 100 due retries are processed per cycle with four concurrent deliveries. Process restart loses the queue; this is not a durable outbox or guaranteed delivery. FCM acceptance is distinct from receipt on a handset.

## Offline validation

`node --test test/notification-delivery.test.js test/sports-realtime.test.js test/bsd-live-personalization.test.js test/favorite-identity.test.js` checks ownership and auth guards, multiple installations, explicit match bells, spoiler suppression, provider separation, stale records, invalid-token cleanup, rotation races, paginated bounded reads, event routing and byte limits, the Firebase SDK payload validator, genuine test messages, socket coexistence, and historical-event suppression. Tests use an in-memory store and mocked FCM; they do not read credentials or contact Firebase.
