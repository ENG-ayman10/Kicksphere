'use strict';

// These recoveries retain the provider's identity and the scope of its evidence.
// A confirmed match selection is not a team's full/current roster, and a bounded
// fixture calendar is not a season-total feed.
const TEAM_ID = /^bsd_t_[1-9]\d{0,14}$/;
const PLAYER_ID = /^bsd_p_[1-9]\d{0,14}$/;
const FIXTURE_ID = /^bsd_[1-9]\d{0,14}$/;
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const dateOnly = Date.parse(value.slice(0, 10) + 'T00:00:00Z'), parsed = Date.parse(value);
  return Number.isFinite(dateOnly) && new Date(dateOnly).toISOString().slice(0, 10) === value.slice(0, 10) && Number.isFinite(parsed) ? parsed : null;
};
const bsdSource = row => (row?.provider === 'bsd' || row?.source === 'bsd') &&
  (!row.provider || row.provider === 'bsd') && (!row.source || row.source === 'bsd');
const memberSide = (match, teamId) => {
  if (!TEAM_ID.test(teamId) || !bsdSource(match) || !FIXTURE_ID.test(String(match?.id)) ||
      !TEAM_ID.test(String(match?.homeTeam?.id)) || !TEAM_ID.test(String(match?.awayTeam?.id)) ||
      match.homeTeam.id === match.awayTeam.id) return null;
  return match.homeTeam.id === teamId ? 'home' : match.awayTeam.id === teamId ? 'away' : null;
};

function verifiedFixtures(teamId, fixtures, now) {
  return (Array.isArray(fixtures) && fixtures.coverage?.available !== false ? fixtures : [])
    .filter(row => memberSide(row, teamId) && time(row.utcDate) !== null && time(row.utcDate) <= now);
}

function playerForSelection(raw, role, teamId, fixture) {
  const nested = raw?.player;
  const id = raw?.id, name = raw?.name || nested?.name;
  if (!PLAYER_ID.test(String(id)) || !bsdSource(raw) || typeof name !== 'string' || !name.trim() ||
      (nested?.id && nested.id !== id) || (raw.teamId && raw.teamId !== teamId) ||
      (nested?.teamId && nested.teamId !== teamId)) return null;
  return { ...raw, id, name: name.trim(), teamId, selectionRole: role,
    selectionContext: { scope: 'match_squad', source: 'bsd', fixtureId: fixture.id, fixtureDate: fixture.utcDate } };
}

async function recoverBsdMatchSquad(teamId, fixtures, loadMatchLineups, options = {}) {
  if (!TEAM_ID.test(String(teamId)) || typeof loadMatchLineups !== 'function') return null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeDays = Math.min(120, Math.max(1, options.maxAgeDays || 90));
  const maxAttempts = Math.min(2, Math.max(1, options.maxAttempts || 2));
  const candidates = verifiedFixtures(teamId, fixtures, now)
    .filter(row => ['FINISHED', 'IN_PLAY', 'PAUSED'].includes(row.status) && time(row.utcDate) >= now - maxAgeDays * 86400000)
    .sort((a, b) => time(b.utcDate) - time(a.utcDate));
  const attempted = new Set();
  for (const fixture of candidates) {
    if (attempted.has(fixture.id)) continue;
    if (attempted.size >= maxAttempts) break;
    attempted.add(fixture.id);
    let details;
    try { details = await loadMatchLineups(fixture.id, fixture); } catch (_) { continue; }
    const match = details?.matchInfo, lineup = details?.lineups;
    if (!match || match.id !== fixture.id || memberSide(match, teamId) !== memberSide(fixture, teamId) ||
        match.homeTeam.id !== fixture.homeTeam.id || match.awayTeam.id !== fixture.awayTeam.id ||
        details.coverage?.available === false || details.coverage?.fields?.lineups === false || !lineup ||
        (lineup.source && lineup.source !== 'bsd') || lineup.confirmed !== true ||
        lineup.predicted === true || (lineup.lineupStatus && lineup.lineupStatus !== 'confirmed')) continue;
    const side = memberSide(fixture, teamId);
    const starters = Array.isArray(lineup[side]) ? lineup[side] : [];
    const bench = Array.isArray(lineup[side + 'Bench']) ? lineup[side + 'Bench'] : [];
    const rows = [...starters.map(row => playerForSelection(row, 'starter', teamId, fixture)),
      ...bench.map(row => playerForSelection(row, 'bench', teamId, fixture))];
    const valid = rows.filter(Boolean), uniqueById = new Map();
    for (const row of valid) if (!uniqueById.has(row.id)) uniqueById.set(row.id, row);
    const unique = [...uniqueById.values()];
    if (!unique.length) continue;
    return { squad: unique, context: { teamId, source: 'bsd', scope: 'match_squad', fixtureId: fixture.id,
      fixtureDate: fixture.utcDate, competition: fixture.competition?.name || '',
      season: fixture.competition?.season?.name || '', confirmed: true },
    coverage: { source: 'bsd', available: true, complete: false, partial: true, rosterAvailable: false,
      scope: 'match_squad', reason: 'recent_confirmed_lineup', fixtureId: fixture.id,
      fixtureDate: fixture.utcDate, invalidRows: rows.length - valid.length,
      duplicateRows: valid.length - unique.length, reportedSelectionSize: rows.length, selectedPlayers: unique.length } };
  }
  return null;
}

function buildBsdTeamFixtureNumbers(teamId, fixtures, options = {}) {
  if (!TEAM_ID.test(String(teamId))) return null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const finished = verifiedFixtures(teamId, fixtures, now).filter(row => row.status === 'FINISHED');
  const byId = new Map(), conflicted = new Set();
  for (const row of finished) {
    const score = row.score?.fullTime;
    if (integer(score?.home) === null || integer(score?.away) === null) continue;
    const signature = JSON.stringify([row.utcDate, row.homeTeam.id, row.awayTeam.id, score.home, score.away]);
    if (byId.has(row.id) && byId.get(row.id).signature !== signature) conflicted.add(row.id);
    else byId.set(row.id, { row, signature });
  }
  const verified = [...byId.values()].map(value => value.row).filter(row => !conflicted.has(row.id))
    .sort((a, b) => time(a.utcDate) - time(b.utcDate));
  if (!verified.length) return null;
  const stats = { matches: verified.length, wins: 0, draws: 0, losses: 0, scoresFor: 0, scoresAgainst: 0, cleanSheets: 0 };
  for (const row of verified) {
    const home = memberSide(row, teamId) === 'home';
    const scored = row.score.fullTime[home ? 'home' : 'away'], conceded = row.score.fullTime[home ? 'away' : 'home'];
    stats.scoresFor += scored; stats.scoresAgainst += conceded;
    stats[scored > conceded ? 'wins' : scored < conceded ? 'losses' : 'draws'] += 1;
    if (conceded === 0) stats.cleanSheets += 1;
  }
  const contexts = new Map(verified.map(row => [String(row.competition?.id) + ':' + String(row.seasonId), row]));
  const context = { source: 'bsd', teamId, scope: 'verified_fixture_sample', dateFrom: verified[0].utcDate.slice(0, 10),
    dateTo: verified.at(-1).utcDate.slice(0, 10), sampleMatches: verified.length,
    mixedCompetitionSeasons: contexts.size > 1 };
  // A single observed competition still does not prove a complete season.
  if (contexts.size === 1) Object.assign(context, { competitionId: verified[0].competition?.id || null,
    competition: verified[0].competition?.name || '', seasonId: verified[0].seasonId || null,
    observedSeasonName: verified[0].competition?.season?.name || '' });
  return { stats, context, coverage: { source: 'bsd', available: true, complete: false, partial: true,
    scope: context.scope, reason: 'limited_fixture_window', verifiedFixtureIds: verified.map(row => row.id),
    conflictedFixtureIds: [...conflicted], excludedRows: finished.length - verified.length } };
}

function buildBsdTeamStandingNumbers(teamId, standings, context = {}) {
  const seasonId = /^[1-9]\d{0,14}$/.test(String(context.seasonId)) ? Number(context.seasonId) : null;
  const competitionId = String(context.competitionId || '');
  if (!TEAM_ID.test(String(teamId)) || !Number.isSafeInteger(seasonId) || seasonId <= 0 ||
      !/^(?:BSD:[1-9]\d*|[A-Z][A-Z0-9]{1,5})$/.test(competitionId) || !Array.isArray(standings) ||
      !bsdSource(standings.coverage) || standings.coverage?.available === false ||
      Number(standings.coverage?.season?.id) !== seasonId) return null;
  const candidates = standings.filter(row => row?.team?.id === teamId && bsdSource(row) && Number(row.season?.id) === seasonId);
  if (candidates.length !== 1) return null; // Group/phase duplicates require user-selected scope.
  const row = candidates[0];
  const played = integer(row.playedGames), wins = integer(row.won), draws = integer(row.draw), losses = integer(row.lost);
  if ([played, wins, draws, losses].includes(null) || played !== wins + draws + losses) return null;
  const goalsFor = integer(row.goalsFor), goalsAgainst = integer(row.goalsAgainst);
  if (goalsFor !== null && goalsAgainst !== null && typeof row.goalDifference === 'number' &&
      row.goalDifference !== goalsFor - goalsAgainst) return null;
  const stats = { matches: played, wins, draws, losses };
  const fields = { scoresFor: goalsFor, scoresAgainst: goalsAgainst, position: integer(row.position), points: integer(row.points) };
  for (const [key, value] of Object.entries(fields)) if (value !== null) stats[key] = value;
  return { stats, standing: row, context: { source: 'bsd', teamId, scope: 'competition_season_standings',
    competitionId, competition: String(context.competition || ''), seasonId,
    season: String(context.season || row.season.name || ''), ...(row.group ? { group: row.group } : {}) },
  coverage: { source: 'bsd', available: true, complete: standings.coverage?.complete === true && Object.values(fields).every(value => value !== null),
    partial: standings.coverage?.complete !== true || Object.values(fields).some(value => value === null),
    scope: 'competition_season_standings' } };
}

module.exports = { recoverBsdMatchSquad, buildBsdTeamFixtureNumbers, buildBsdTeamStandingNumbers };
