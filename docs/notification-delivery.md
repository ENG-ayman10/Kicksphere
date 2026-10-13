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
    "alerts": {
      "enabled": true,
      "reminders": true,
      "lineups": true,
      "goals": true,
      "cards": true,
      "matchStatus": true,
      "other": true
    },
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
and one stable event ID; optional detailed incidents require a match bell and spoiler
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

Background match pushes reach an installation only for one of its exact favorite team IDs or an explicitly subscribed match ID. `favoritesOnly` does not disable an explicit match bell. It does not turn background delivery into a broadcast. Red cards, official lineups and lifecycle alerts can reach followed-club fans; optional yellow-card, substitution, penalty and VAR incidents require a match bell. `hideScores:true` suppresses **every** match-event push. Optional `preferences.alerts` applies the master switch and event categories independently per installation. Omitted category settings default to enabled for existing installs; provided settings require actual booleans. The explicitly requested system test is still permitted when match alerts are paused.

An active socket on one of a user's devices does not prevent push delivery to any installation. FCM sends `notification` and `data`; Android/iOS display the notification in the background. Foreground clients route the data through their shared event ledger and display once. They should never redisplay the background FCM notification.

The authoritative compact `data.event` JSON includes a stable `eventId`, opaque `matchId`, `type`, provider, `emittedAt` milliseconds, structured home/away teams and score, scoring side, player, minute, and card type when known. Scalar `eventId`, `matchId`, `type`, `kind`, `provider`, `emittedAt`, `sound`, `vibration`, and `recipientUserId` support routing and rejection of delayed messages for a previous account. Recipient identity is not included in the shared Socket event. Optional duplicated compatibility fields may be omitted when the message approaches the byte budget; always prefer `data.event`. Unknown players, scores, and minutes are left empty/null rather than invented.

Android notification channels are `match_events_${type}_s${sound ? 1 : 0}_v${vibration ? 1 : 0}`. The client creates all supported channels before registration. Android and APNs use high delivery priority for visible alerts. Event IDs normally set Android tags and APNs collapse IDs; score-changing messages share a fixture-derived tag so a correction replaces the older displayed score notification. The compact event ID remains distinct in history. Messages expire after five minutes; reminders are also rejected once kickoff has passed. iOS vibration behavior is controlled by the platform; Android channels enforce the vibration preference. High priority and display tags do not guarantee immediate or ordered delivery; see [FCM priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority) and [message ordering/collapse limitations](https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types).

The poller establishes a baseline on first sightings and never replays historical scores or incidents. Canonical events include `matchReminder` (15 minutes), `lineup`, `matchStart`, `goal`, `goalCancelled`, `scoreCorrection`, `halfTime`, `secondHalfStart`, `extraTimeStart`, `penaltyShootout`, `matchEnd`, `matchPostponed`, `matchCancelled`, `card`, `var`, `substitution` and `penalty`. An official lineup requires two complete confirmed starting elevens with consistent fixture/team identities; predictions cannot trigger the alert. Phase alerts require explicit source phase evidence. A verified score decrease triggers goal cancellation without inventing a VAR reason; a score reallocation triggers one correction. Stable incident identity suppresses later text enrichment and rescinded historical cards. A genuinely new goal after a cancellation receives a distinct event ID even at the same score.

Followed clubs and durable match subscriptions trigger bounded detail lookups without sockets: at most six detail requests per batch, three concurrent reads, and 200 installation documents per query page. The lightweight BSD alert read fetches only event summary, requested incidents and requested lineups. Production score cycles do not wait for those detail requests; late completions pass the same source-clock checks. Installation discovery and delivery start independently of event storage and legacy inbox/fan queries. Up to eight installation delivery pipelines run concurrently; legacy inbox work uses four recipients. Delivery rereads current registration so revoked installations and changed preferences are respected. Invalid tokens are removed only if the stored token still equals the failed token, preserving rotation. Logs record error categories without token contents.

The top-level Firestore collections are `notificationDevices`, `notificationTokens`, `notificationDeliveries` and `notificationScoreDeliveryHeads`. Only trusted server code should access them; client Firestore rules must deny direct reads and writes. Their normal array indexes support queries on `preferences.teamIds` and `preferences.matchIds`; pending deliveries use status and expired receipts use expiry single-field indexes, without a new compound index. New registrations disable the old account-wide token path. Existing legacy account tokens remain compatible until migration, but never bypass an account's score-hiding setting.

Inbox notifications use an event-derived document ID and a transaction to preserve read state and avoid duplicate personal delivery across emitters. Inbox storage failure does not prevent push delivery. Invalid-token classification follows [Firebase's error code reference](https://firebase.google.com/docs/cloud-messaging/error-codes); an ambiguous invalid-argument payload error does not remove a valid installation.

Deploying this code alone does not enable a disabled poller. A configured Firebase Admin messaging identity, active production event poller and a real handset are needed to verify end-to-end OS delivery.

Successful registration reports `automaticEventsEnabled`; registration must not promise automatic match alerts while the poller is disabled. The detector establishes its first baseline immediately after enabling. Defaults are 5000 ms for shared score checks and 15000 ms for optional details; `LIVE_EVENTS_POLL_INTERVAL_MS` and `LIVE_MATCHES_POLL_INTERVAL_MS` accept explicit intervals from 5000 to 900000 ms. Shared provider reads retain the 15-second cache/coalescing boundary: a 5-second check does not turn the upstream feed into a subsecond feed. Upcoming calendars refresh asynchronously every 60 seconds and include tomorrow within 90 minutes of UTC midnight. Identical live boards are broadcast at most once per 30-second heartbeat; real score/status changes broadcast immediately on observation.

Source publication delay, cache refresh, network latency and OS delivery must be measured separately. Subsecond end-to-end delivery is not guaranteed. [Render Free](https://render.com/docs/free) can spin down after inactivity and restart; outbound polling alone is not an always-running service. Reliable unattended production monitoring needs continuous compute or an appropriate worker and a sufficiently fresh source feed.

Transient device-send errors enter a bounded restart-safe delivery ledger; no FCM token is stored with an event. Up to 1000 pending records are restored, with 30-second transaction leases and 30/60/120-second retry backoff (initial quota retry at least 60 seconds). Source-age expiry is five minutes; reminders also expire by kickoff. Every retry rereads current ownership, preferences and token. Accepted receipts and newest-score heads remain for 24 hours, with bounded expiry cleanup. Accepted, revoked, hidden, predicted-lineup and invalid-token events are not retried. At most 100 due retries are processed per cycle with four concurrent deliveries.

Score-changing sends serialize per installation/fixture; a durable newest-score head suppresses an older queued goal after a correction, including different occurrences observed within the same millisecond. Acceptance receipts suppress replay across restart. FCM and Firestore cannot commit atomically: a crash after FCM acceptance but before the receipt write can repeat a transport send. Ledger work has a 1500-ms deadline and can fail open during a storage outage, so independent processes can also send a duplicate when both cannot establish a claim. A hung FCM send can delay that installation's score queue while other fixtures proceed. Stable event IDs and OS replacement tags limit visible duplicates, but neither exactly-once nor ordered handset delivery is guaranteed. FCM acceptance is distinct from actual OS receipt.

## Offline validation

`node --test test/notification-delivery.test.js test/sports-realtime.test.js test/bsd-live-personalization.test.js test/favorite-identity.test.js` checks ownership and auth guards, multiple installations, explicit match bells, spoiler suppression, provider separation, stale records, invalid-token cleanup, rotation races, paginated bounded reads, event routing and byte limits, the Firebase SDK payload validator, genuine test messages, socket coexistence, and historical-event suppression. Tests use an in-memory store and mocked FCM; they do not read credentials or contact Firebase.
