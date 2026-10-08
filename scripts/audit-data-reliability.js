'use strict';

// Bounded public-GET audit. It never reads credentials, mutates an account or
// walks every entity at an upstream provider. Reuse the same sample for repair
// verification rather than presenting sample coverage as worldwide coverage.
const fs = require('node:fs/promises');
const { readBoundedResponse } = require('./smoke-sports');
const { canonicalMatchStatus } = require('../utils/matchStatus');
const { mergeProviderFixtures } = require('../utils/providerFixtureIdentity');

const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const image = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
const covered = section => ({ available: section?.available === true, complete: section?.complete === true,
  partial: section?.partial === true, reason: section?.reason || null });

async function runAudit(origin, day) {
  const report = { capturedAt: new Date().toISOString(), origin, day,
    scope: 'Three UTC matchdays; two bilingual searches; four player profiles; two clubs and one national team; three standings and scorer lists; two match details',
    independentFootballTruthVerified: false, noAccountWrites: true,
    checks: [], issues: [], sourceGaps: [], latencySamples: [] };
  const issue = (path, rule, detail) => report.issues.push({ path, rule, detail });
  async function read(path, validate) {
    const check = { path, passed: false }, started = performance.now(); report.checks.push(check);
    try {
      const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { 'Accept-Encoding': 'gzip', Accept: 'application/json' } });
      const bytes = await readBoundedResponse(response, 4194304);
      const body = JSON.parse(new TextDecoder().decode(bytes));
      Object.assign(check, { status: response.status, decodedBytes: bytes.length,
        contentEncoding: response.headers.get('content-encoding'), source: body.source || null,
        coverage: covered(body.coverage) });
      if (!response.ok || body.success !== true) {
        report.sourceGaps.push({ path, reason: body.coverage?.reason || 'entity_unavailable', status: response.status });
        return null;
      }
      const before = report.issues.length;
      const details = validate ? validate(body) : {};
      Object.assign(check, details, { passed: report.issues.length === before });
      return body;
    } catch (error) {
      check.error = ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name) ? 'read_unavailable_or_timed_out' : 'invalid_response';
      report.sourceGaps.push({ path, reason: check.error }); return null;
    } finally { check.ms = Math.round(performance.now() - started); }
  }
  async function bounded(items, work) {
    for (let i = 0; i < items.length; i += 2) await Promise.all(items.slice(i, i + 2).map(work));
  }
  const calendars = [];
  await bounded([-1, 0, 1], async offset => {
    const date = new Date(day + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + offset);
    const label = date.toISOString().slice(0, 10), path = '/api/matches/date?date=' + label;
    const body = await read(path, body => {
      const rows = Array.isArray(body.data) ? body.data.flatMap(group => Array.isArray(group.matches) ? group.matches : []) : [];
      const ids = new Set();
      const missingIdentities = new Map();
      for (const row of rows) {
        if (!row.id || ids.has(String(row.id))) issue(path, 'fixture_unique_id', row.id);
        ids.add(String(row.id));
        if (row.utcDate?.slice(0, 10) !== label) issue(path, 'fixture_date_scope', row.id);
        if (!row.homeTeam?.name || !row.awayTeam?.name) issue(path, 'fixture_team_name', row.id);
        if (row.homeTeam?.id && row.awayTeam?.id && row.homeTeam.id === row.awayTeam.id) issue(path, 'fixture_team_identity', row.id);
        // Some providers supply a match and team names without navigable team
        // identities. Record this coverage gap; a name is not proof of an ID.
        if (!row.homeTeam?.id || !row.awayTeam?.id) {
          const provider = row.provider || row.source || 'unknown';
          const gap = missingIdentities.get(provider) || { count: 0, examples: [] };
          gap.count += 1;
          if (gap.examples.length < 5) gap.examples.push(row.id);
          missingIdentities.set(provider, gap);
        }
        for (const side of ['home', 'away']) {
          const value = row.score?.fullTime?.[side];
          if (value != null && !count(value)) issue(path, 'fixture_score_counter', row.id + ':' + side);
        }
      }
      for (const [provider, gap] of missingIdentities) report.sourceGaps.push({ path, section: 'fixture_team_identity', provider, ...gap });
      let duplicateCandidates = 0;
      for (const provider of ['bsd', 'sportscore', 'kickoffapi']) {
        const preferred = rows.filter(row => (row.provider || row.source) === provider);
        const others = rows.filter(row => (row.provider || row.source) !== provider);
        duplicateCandidates = Math.max(duplicateCandidates, rows.length - mergeProviderFixtures(preferred, others).length);
      }
      if (duplicateCandidates) issue(path, 'verified_cross_provider_duplicates', duplicateCandidates);
      return { count: rows.length, duplicateCandidates };
    });
    if (body) calendars.push(...body.data.flatMap(group => Array.isArray(group.matches) ? group.matches : []));
  });
  const bilingual = new Map();
  await bounded(['هالاند', 'Haaland', 'اليمن', 'Yemen'], async query => {
    const path = '/api/search?q=' + encodeURIComponent(query);
    const result = await read(path, body => ({ counts: Object.fromEntries(['teams', 'players', 'leagues']
      .map(key => [key, Array.isArray(body.data?.[key]) ? body.data[key].length : 0])) }));
    if (result) bilingual.set(query, result.data);
  });
  for (const [arabic, english, category, id] of [['هالاند', 'Haaland', 'players', 'bsd_p_852'], ['اليمن', 'Yemen', 'teams', 'bsd_t_2284']]) {
    if (![arabic, english].every(query => bilingual.get(query)?.[category]?.some(row => row.id === id))) {
      issue('/api/search', 'bilingual_expected_identity', { arabic, english, category, id });
    }
  }
  await bounded(['bsd_p_852', 'bsd_p_9063', 'bsd_p_594', 'erling-haaland'], async id => {
    const path = '/api/stats/deep/player/' + id;
    await read(path, body => {
      const data = body.data || {}, info = data.info || {};
      if (info.id !== id || !info.name) issue(path, 'player_identity', info.id);
      const missing = ['dateOfBirth', 'nationality', 'position', 'height', 'weight', 'preferredFoot']
        .filter(key => info[key] == null || info[key] === '');
      if (missing.length) report.sourceGaps.push({ path, section: 'biography', missing });
      const stats = data.seasonStats || {};
      for (const key of ['matches', 'goals', 'assists', 'minutes', 'shots', 'shotsOnTarget', 'yellowCards', 'redCards']) {
        if (stats[key] != null && !count(stats[key])) issue(path, 'player_stat_counter', key);
      }
      const career = Array.isArray(data.careerBySeason) ? data.careerBySeason : [];
      const scopes = career.filter(row => row.teamId && (row.competitionId || row.leagueId) && row.seasonId)
        .map(row => [row.teamId, row.competitionId || row.leagueId, row.seasonId].join('|'));
      if (new Set(scopes).size !== scopes.length) issue(path, 'career_unique_scope', scopes.length - new Set(scopes).size);
      for (const section of ['career', 'transfers', 'honours', 'stats']) {
        const coverage = data.coverage?.[section] || data[section + 'Coverage'];
        if (coverage?.available === false || coverage?.complete !== true) report.sourceGaps.push({ path, section, ...covered(coverage) });
      }
      return { playerId: info.id, name: info.name, photoUrlSupplied: image(info.image || info.photo),
        biographyMissing: missing, careerScopes: career.length, statsContext: data.statsContext || null };
    });
  });
  await bounded(['bsd_t_44', 'bsd_t_57', 'bsd_t_2284'], async id => {
    const path = '/api/stats/deep/team/' + id;
    await read(path, body => {
      const data = body.data || {}, info = data.info || {}, squad = Array.isArray(data.squad) ? data.squad : [];
      if (info.id !== id || !info.name) issue(path, 'team_identity', info.id);
      const ids = squad.map(row => row.id);
      if (ids.some(id => !id) || new Set(ids).size !== ids.length) issue(path, 'squad_unique_player_id', id);
      for (const row of squad) if (row.teamId && row.teamId !== id) issue(path, 'squad_team_scope', row.id);
      for (const section of ['squad', 'stats']) if (data.coverage?.[section]?.complete !== true) {
        report.sourceGaps.push({ path, section, count: section === 'squad' ? squad.length : null, ...covered(data.coverage?.[section]) });
      }
      return { teamId: info.id, name: info.name, rosterSize: squad.length, photoUrlsSupplied: squad.filter(row => image(row.image || row.photo)).length,
        squadContext: data.squadContext || null, statsContext: data.statsContext || null };
    });
  });
  await bounded(['PL', 'PD', 'CL'], async league => {
    await read('/api/stats/teams?league=' + league, body => {
      const rows = Array.isArray(body.data) ? body.data : [], path = '/api/stats/teams?league=' + league;
      for (const row of rows) {
        for (const key of ['playedGames', 'won', 'draw', 'lost', 'goalsFor', 'goalsAgainst']) if (row[key] != null && !count(row[key])) issue(path, 'standing_counter', row.team?.id + ':' + key);
        if (['playedGames', 'won', 'draw', 'lost'].every(key => count(row[key])) && row.playedGames !== row.won + row.draw + row.lost) issue(path, 'standing_played_balance', row.team?.id);
        if (count(row.goalsFor) && count(row.goalsAgainst) && typeof row.goalDifference === 'number' && row.goalDifference !== row.goalsFor - row.goalsAgainst) issue(path, 'standing_goal_balance', row.team?.id);
      }
      return { count: rows.length };
    });
    await read('/api/stats/players?league=' + league + '&limit=10', body => ({ count: Array.isArray(body.data) ? body.data.length : 0 }));
  });
  const selected = [calendars.find(row => canonicalMatchStatus(row.status) === 'FINISHED' && row.id?.startsWith('bsd_')),
    calendars.find(row => row.id === 'bsd_213594')].filter(Boolean);
  await bounded(selected, row => read('/api/stats/deep/match/' + row.id, body => {
    const data = body.data || {}, path = '/api/stats/deep/match/' + row.id;
    if (data.matchInfo?.id !== row.id) issue(path, 'detail_fixture_identity', data.matchInfo?.id);
    if (canonicalMatchStatus(data.matchInfo?.status) === 'FINISHED' && data.prediction != null) issue(path, 'terminal_match_has_preview', row.id);
    const lineups = data.lineups || {};
    for (const side of ['home', 'away']) {
      const players = Array.isArray(lineups[side]) ? lineups[side] : [];
      const ids = players.map(player => player.id).filter(Boolean);
      if (new Set(ids).size !== ids.length || players.length > 11) issue(path, 'lineup_unique_eleven', side);
    }
    return { fixtureId: row.id, status: data.matchInfo?.status, lineups: { confirmed: lineups.confirmed === true,
      predicted: lineups.predicted === true, home: lineups.home?.length || 0, away: lineups.away?.length || 0 } };
  }));
  // Repeated loopback GETs can still refresh expired provider caches. These
  // readings are not a phone/network SLA or a provider benchmark.
  for (const path of ['/api/search?q=Haaland', '/api/stats/deep/player/bsd_p_852', '/api/matches/date?date=' + day]) {
    const readings = [];
    for (let i = 0; i < 3; i++) { const result = await read(path); readings.push(report.checks.at(-1).ms); if (!result) break; }
    report.latencySamples.push({ path, scope: 'repeated_loopback_GET_cache_state_not_controlled', ms: readings });
  }
  report.success = report.issues.length === 0 && report.checks.every(check => check.passed);
  return report;
}

if (require.main === module) (async () => {
  const [originText, day, reportPath] = process.argv.slice(2), url = new URL(originText);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use a loopback HTTP origin');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day || !reportPath) throw new Error('Provide a date and report path');
  const result = await runAudit(url.origin, day); await fs.writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ success: result.success, checked: result.checks.length, issueCount: result.issues.length,
    issuesByRule: result.issues.reduce((counts, item) => { counts[item.rule] = (counts[item.rule] || 0) + 1; return counts; }, {}),
    issueExamples: result.issues.slice(0, 10), sourceGaps: result.sourceGaps.length,
    latencySamples: result.latencySamples, reportPath }, null, 2));
  if (!result.success) process.exitCode = 1;
})().catch(() => { console.error('Data audit could not complete; use loopback origin, real YYYY-MM-DD and writable report path.'); process.exitCode = 1; });

module.exports = { runAudit };
