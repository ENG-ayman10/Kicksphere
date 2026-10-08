# Player honours: verified sections and provider audit

The player profile identity and statistics remain anchored to their original provider.
Missing trophy history is not evidence that a player has never won a trophy.

## Current source findings — 2026-10-08

The live BSD records for Lionel Messi (`bsd_p_9063`) and Erling Haaland (`bsd_p_852`)
did not include `honours` or `trophies`. This is a two-player sample, not a universal
coverage guarantee.

KickOff's separate trophy endpoint returned 94 rows for Messi and 38 for Haaland.
Only 70 and 22 respectively supplied a season. Every undated row had a dated
counterpart with the same competition, country and placement in this sample.
The undated rows appear to describe categories rather than additional editions;
they must not inflate trophy totals or appear as additional achievements.

The source also includes friendly cups and uses current competition names for
some historical editions. For example, its `FIFA Intercontinental Cup` rows for
Messi in 2009/2011/2015 and Haaland in 2023 correspond to the historical Club World
Cup. A raw `Winner` count is not an official career title total.

The latest direct API-Football audit with the replacement key succeeded for both
players. Identity was independently resolved to source IDs 154 and 1100 using
their names, birth dates and nationalities. It returned the same 94/38 raw and
70/22 dated rows as the KickOff sample. Agreement between these two responses is
not independent proof of completeness or official career totals. The direct
adapter now omits undated summaries as well, and reports `rawRecords` and
`undatedRowsOmitted` without certifying a complete lifetime history.

Primary checks:

- [Barcelona's Club World Cup history](https://www.fcbarcelona.com/en/news/1074318/iniesta-messi-and-suarez-make-club-world-cup-podium/amp)
- [City's 2023 Club World Cup review](https://www.mancity.com/news/mens/fifa-club-world-cup-2023-review-63885182)
- [Joan Gamper is a preseason friendly](https://www.fcbarcelona.com/en/news/1832020/how-to-watch-the-joan-gamper-trophy-live)
- [KickOff V1 reference](https://docs.kickoffapi.com/api-v1-reference.html)
- [API-Football reference](https://api-sports.io/documentation/football/v3)

## Optional direct API-Football source

Keep `API_FOOTBALL_KEY` only on the backend. Do not embed it in Flutter, commit it,
include it in URLs, or paste it into an audit artifact. The direct API hostname is
fixed and redirects are disabled.

`ENABLE_API_FOOTBALL_HONOURS=false` is the default. Run the live audit before
enabling the integration; the key being configured is not evidence of coverage.

The adapter searches player profiles independently of season statistics, then
requires an unambiguous match on the player name, birth date and nationality.
BSD numeric IDs are never reused as API-Football IDs. An incomplete search page,
a missing birth date, a conflicting profile or an ignored filter leaves the
original BSD profile intact.

The captured Messi and Haaland full-name variants have curated aliases, scoped
to the exact BSD ID, canonical name, date of birth and nationality. Their full
names are also attested by [Barcelona](https://www.fcbarcelona.com/en/news/886918/the-14year-anniversary-of-leo-messis-official-bara-debut)
and [Manchester City](https://www.mancity.com/features/erling-haaland/rise/).
This does not permit general initials, substring matching or choosing a source
ID without searching. An ambiguous or conflicting candidate is still rejected.

The trophy request uses only the independently verified source player ID. The
display row keeps the BSD player ID and separately records the API-Football player
ID and source. Only the honours section is supplemented: image, team, biography,
season statistics and career rows cannot be overwritten by this integration.

Successful histories are cached for 24 hours; failed lookups for five minutes.
Concurrent lookups share one request chain. Rate-limit responses back off without
retry loops. The entire supplementary lookup has one 4.5-second transport budget.
Restart the backend after setting the key or feature flag; configuration is read
at startup. Full pagination proves completeness of the returned resource, not
of every lifetime trophy or individual award; enriched coverage remains partial.

The Free plan's 100 daily requests support at most about 50 uncached successful
enrichments when each takes two calls, before other account usage. Cache and
quota backoff are process-local; concurrent different-player lookups are not
proactively paced. Keep broad production enrichment disabled until a shared
quota budget and rate limiter, or sufficient provider capacity, are in place.

## Reproducible live audits

Run from the backend directory with credentials in the local `.env`:

```powershell
node scripts/audit-player-honours.js
node scripts/audit-api-football-honours.js
```

These audits save public football fields under
`D:/kicksphere/artifacts/Player-Honours-2026-10-08`. The second command needs the
direct API-Football key. Compare season labels, placements, friendly cups,
historical names and coverage before enabling enrichment. Neither command changes
user accounts, subscriptions, Firebase configuration or the hosted service.

## Earlier key restriction — 2026-10-08

The supplied key was configured in the ignored local backend `.env`, with
`ENABLE_API_FOOTBALL_HONOURS` still disabled. The logged-in dashboard showed a
Free football plan with 100 requests/day, but also a Proxy/VPN warning.
The direct `/players/profiles?search=messi&page=1` request returned HTTP 200
with `errors.access`: `Your account is suspended, check on
https://dashboard.api-football.com.` It returned no player records. The response
still showed 99 daily requests remaining, so this evidence does not indicate
that the daily quota was exhausted or establish why the account was suspended.

The adapter now distinguishes this provider error from a missing player. It
pauses all lookups for five minutes, including different players, and preserves
the original profile. Both profile-stage and trophy-stage suspension have
regression coverage. A subsequent audit reported `provider_account_suspended`
for both sample profiles; the second profile did not require a new request.
No trophy request or identity match was possible with that earlier key.
`api-football-envelope-diagnostic.json` is historical evidence of that restriction,
not the current account's status. The cause of that restriction and regional
service eligibility were not established.

## Replacement key verification — 2026-10-08

The user supplied screenshots of a successful countries request (171 results)
and a different key. That replacement key is now configured in the ignored local
backend `.env`. Live server-side profile searches and trophy requests succeeded.
The current `api-football-source-audit.json` records verified identities and only
dated rows after filtering; `api-football-live-unfiltered.json` preserves the
pre-filter public audit for comparison. `api-football-profiles-live.json` contains
the captured public profile search responses. None contains a key.

Access is restored for these tested endpoints; this two-player sample does not
establish complete coverage for all players, individual awards or team-per-edition
fields. `ENABLE_API_FOOTBALL_HONOURS` remains false. The replacement key has not
been transferred to Render or included in a client build.
