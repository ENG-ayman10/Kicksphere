# Focused competition coverage

`SPORTS_COMPETITION_SCOPE=focused` selects the product's major leagues/cups, Arab domestic competitions and international tournaments. `all` is the compatibility default. Runtime validation rejects other values and `/api/ready` reports the active setting.

The major list retains the existing stable codes: PL, PD, SA, BL1, FL1, PPL, DED, BSA, ARG, TSL, MLS, ELC, SPL, FAC, CDR, CIT, DFB, CL, EL, ECL, WC, EC, UNL, ACL, CAF and CLI. Existing continental/international competition metadata and Arab country metadata retain other provider-scoped competitions without renaming their codes. Unknown domestic scopes are excluded unless their metadata establishes inclusion. Generic names such as Premier League require a known code or the appropriate competition country. Competition-specific country evidence is retained; participant countries do not classify a competition.

Israel domestic competitions are excluded using competition country/code or distinctive league labels, including SportScore leagues with no country metadata. An Israeli participant in a retained international tournament does not exclude that tournament. Player nationality, names, portraits, biographies, career records and honours are not exclusion criteria. Arab competitions include countries supported by the source, including Yemen, Egypt, Morocco, Qatar and Saudi Arabia; this does not invent provider coverage for missing leagues.

The public catalog, matchday/live calendars, competition search, recommendations and optional match details use the same policy. Excluded league fixture/standings/scorer requests stop before those provider endpoints. Alert candidates, scheduled reminders, late detail results, future stream subscriptions and delivery retries apply the policy; excluded prior state is removed silently. Existing delivered history and user follows are preserved.

The internal BSD league catalog and source career/fixture/season reads remain unfiltered. This is essential to preserve verified club/player profile totals and classification metadata. Public BSD calendar calls explicitly pass `applyCompetitionScope:true`; internal biography reads do not. A public hidden-competition lookup returns `competition_outside_scope`, rather than claiming a provider outage or fabricating zero statistics.

Intentional exclusions are recorded as `excludedByScope` with `competitionScope:focused` in coverage. Genuine malformed records, source conflicts, unavailable sources and pagination caps retain their original diagnostics. Capped feeds still attempt documented status recovery, so excluded first-page rows cannot certify that all important fixtures were seen.

## Request savings and limits

This policy avoids per-fixture identity enrichment, optional incident/lineup/statistic reads, alert processing and (if separately enabled) stream subscriptions for excluded competitions. Broad mixed live/calendar batch requests remain necessary to discover retained competitions; filtering rows does not reduce those batch calls. Replacing them with dozens of league requests would risk increasing traffic and losing fixtures. No percentage reduction in real production request volume is claimed.

Android 4027 already consumes the filtered backend catalog and feeds. No APK replacement is required. Refresh/pull-to-refresh replaces public cached catalog/board data. A disconnected client can temporarily show older saved snapshots; saved favorite records are not destructively deleted. Search cache keys include the scope to prevent cross-mode reuse.

The offline `competition-scope`, `sportscore-competition-scope`, `alert-competition-scope` and `notification-competition-scope` tests cover retained scopes, country/participant separation, excluded heavy calls, capped feeds, late completions and durable retries with fake providers/devices. No diagnostic notification is needed to validate competition exclusions.
