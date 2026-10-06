'use strict';

const positiveId = value => ['string', 'number'].includes(typeof value) && /^[1-9]\d{0,14}$/.test(String(value ?? '')) &&
  Number.isSafeInteger(Number(value)) ? Number(value) : null;
const count = value => value !== null && value !== undefined && String(value).trim() !== '' &&
  typeof value !== 'boolean' && typeof value !== 'object' && Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0 ? Number(value) : null;
const supplied = (options, key) => options[key] !== undefined;

/** Select only an existing career scope. Provider season IDs are never calendar years. */
function selectBsdPlayerScope(career, options, clubId, leagueId, primaryLeagueIds) {
  const explicit = ['seasonId', 'season', 'competition', 'teamId'].some(key => supplied(options, key));
  let rows = career;
  if (supplied(options, 'teamId')) {
    const match = /^bsd_t_([1-9]\d{0,14})$/.exec(String(options.teamId));
    if (!match || !positiveId(match[1])) return { row: null, reason: 'invalid_statistics_scope' };
    rows = rows.filter(row => row.teamId === options.teamId);
  } else rows = rows.filter(row => row.teamId === 'bsd_t_' + clubId);
  if (supplied(options, 'competition')) {
    if (!['string', 'number'].includes(typeof options.competition)) return { row: null, reason: 'invalid_statistics_scope' };
    const id = leagueId(options.competition);
    if (!id) return { row: null, reason: 'invalid_statistics_scope' };
    rows = rows.filter(row => Number(row.leagueId) === id);
  }
  if (supplied(options, 'seasonId')) {
    const id = positiveId(options.seasonId);
    if (!id) return { row: null, reason: 'invalid_statistics_scope' };
    rows = rows.filter(row => Number(row.seasonId) === id);
  }
  if (supplied(options, 'season')) {
    const label = typeof options.season === 'string' || typeof options.season === 'number'
      ? String(options.season).trim() : '';
    if (!label || label.length > 100) return { row: null, reason: 'invalid_statistics_scope' };
    rows = rows.filter(row => row.seasonInfo &&
      (String(row.seasonInfo.year ?? '') === label || row.season === label));
  }
  if (!supplied(options, 'seasonId') && !supplied(options, 'season')) {
    rows = rows.filter(row => row.seasonInfo?.is_current === true);
  }
  if (!explicit || !supplied(options, 'competition')) {
    const primary = rows.filter(row => primaryLeagueIds.has(Number(row.leagueId)));
    if (primary.length === 1) rows = primary;
  }
  return { row: rows.length === 1 ? rows[0] : null,
    reason: rows.length > 1 ? 'ambiguous_statistics_scope' : rows.length === 0
      ? 'requested_statistics_scope_unavailable' : null };
}

/** Per-match numbers may form season totals only after checking their entire scope. */
function aggregateBsdPlayerStatistics(stats, fixtures, selected, playerId, fieldMap) {
  const empty = Object.fromEntries([...Object.keys(fieldMap), 'passesAccuracy'].map(key => [key, null]));
  const teamId = positiveId(String(selected.teamId).replace(/^bsd_t_/, ''));
  const eventIds = new Set((fixtures || []).map(row => positiveId(row.rawId)).filter(Boolean));
  const seen = new Set();
  let invalidRows = 0, duplicateEvents = 0;
  const checked = [];
  for (const row of stats || []) {
    const eventId = positiveId(row?.event_id);
    if (positiveId(row?.player_id) !== playerId || positiveId(row?.team_id) !== teamId ||
        !eventId || !eventIds.has(eventId) || count(row?.minutes_played) === null) { invalidRows++; continue; }
    if (seen.has(eventId)) { duplicateEvents++; continue; }
    seen.add(eventId); checked.push(row);
  }
  const appearances = checked.filter(row => count(row.minutes_played) > 0);
  // BSD can include zero-minute records in its reported career match count.
  // Keep those real source records for counters, while reporting the discrepancy
  // separately instead of discarding a whole season of verified metrics.
  const sum = field => {
    if (!checked.every(row => count(row[field]) !== null)) return null;
    const total = checked.reduce((total, row) => total + count(row[field]), 0);
    return Number.isSafeInteger(total) ? total : null;
  };
  const disagreements = [];
  for (const [careerField, matchField] of [['goals', 'goals'], ['assists', 'goal_assist'], ['minutes', 'minutes_played']]) {
    const observed = checked.length ? sum(matchField) : 0;
    if (selected[careerField] !== null && selected[careerField] !== undefined && observed !== null &&
        count(selected[careerField]) !== observed) disagreements.push(careerField);
  }
  const metricsComplete = Boolean(stats?.coverage?.complete && fixtures?.coverage?.complete &&
    invalidRows === 0 && duplicateEvents === 0 && count(selected.matches) !== null &&
    checked.length === selected.matches && disagreements.length === 0);
  const complete = metricsComplete && appearances.length === selected.matches;
  const coverage = { ...(stats?.coverage || { source: 'bsd', available: false }),
    complete, partial: !complete, observedAppearances: appearances.length,
    reportedAppearances: selected.matches, verifiedEventScope: Boolean(fixtures?.coverage?.complete),
    verifiedStatisticsRecords: checked.length, zeroMinuteRecords: checked.length - appearances.length, metricsComplete,
    invalidRows, duplicateEvents, ...(disagreements.length ? { disagreements } : {}),
    reason: !stats ? 'player_match_statistics_unavailable' : !fixtures?.coverage?.complete
      ? 'fixture_scope_incomplete' : invalidRows ? 'statistics_identity_mismatch'
        : duplicateEvents ? 'duplicate_player_event_statistics' : disagreements.length
          ? 'career_match_statistics_disagree' : !stats.coverage?.complete
            ? stats.coverage?.reason || 'player_statistics_scope_incomplete' : metricsComplete && !complete
            ? 'provider_appearance_count_includes_zero_minute_records' : !complete ? 'appearance_coverage_incomplete' : null };
  if (!metricsComplete || checked.length === 0) return { metrics: empty, coverage };
  for (const [field, rawField] of Object.entries(fieldMap)) empty[field] = sum(rawField);
  const passes = sum('total_pass'), accurate = sum('accurate_pass');
  const validPassCounts = checked.every(row => count(row.accurate_pass) !== null &&
    count(row.total_pass) !== null && count(row.accurate_pass) <= count(row.total_pass));
  empty.passesAccuracy = validPassCounts && passes > 0 && accurate !== null
    ? Number((accurate / passes * 100).toFixed(1)) : null;
  coverage.availableFields = Object.keys(empty).filter(key => empty[key] !== null);
  return { metrics: empty, coverage };
}

module.exports = { selectBsdPlayerScope, aggregateBsdPlayerStatistics };
