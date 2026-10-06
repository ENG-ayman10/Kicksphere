'use strict';

// A formation describes the team, not the order in which a feed returns people.
// Preserve evidence supplied by the provider; never assign a player to a tactical
// slot merely because they happen to be the next element in an array.
function formationRows(value) {
  if (typeof value !== 'string' || !/^\d+(?:-\d+){1,4}$/.test(value.trim())) return null;
  const rows = value.trim().split('-').map(Number);
  return rows.every(row => row > 0 && row <= 5) && rows.reduce((sum, row) => sum + row, 0) === 10
    ? [1, ...rows] : null;
}

function positionGroup(value) {
  const text = String(value ?? '').trim().toUpperCase().replace(/[ _-]+/g, '');
  if (['G', 'GK', 'GOALKEEPER', 'KEEPER'].includes(text)) return 'G';
  if (['D', 'DF', 'DEF', 'DEFENDER', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CENTREBACK', 'CENTERBACK', 'LEFTBACK', 'RIGHTBACK'].includes(text)) return 'D';
  if (['M', 'MF', 'MID', 'MIDFIELDER', 'DM', 'CDM', 'CM', 'AM', 'CAM', 'LM', 'RM', 'DEFENSIVEMIDFIELDER', 'CENTRALMIDFIELDER', 'ATTACKINGMIDFIELDER'].includes(text)) return 'M';
  if (['F', 'FW', 'ATT', 'A', 'FORWARD', 'ATTACKER', 'ST', 'CF', 'LW', 'RW', 'STRIKER', 'LEFTWING', 'RIGHTWING'].includes(text)) return 'F';
  return null;
}

function playerId(player) {
  if (!player || typeof player !== 'object') return '';
  return String(player.player?.id ?? player.id ?? '').trim();
}

function explicitPlayerProvider(player) {
  const id = playerId(player);
  if (id.startsWith('bsd_p_')) return 'bsd';
  if (id.startsWith('ko_p_')) return 'kickoffapi';
  if (id.startsWith('sc_p_')) return 'sportscore';
  const value = player?.player?.provider || player?.provider;
  if (typeof value === 'string' && value) return value;
  return null;
}

function parseGrid(value) {
  if (typeof value !== 'string' || !/^[1-6]:[1-5]$/.test(value)) return null;
  const [row, column] = value.split(':').map(Number);
  return { row, column };
}

function buildLineupLayout(players, formation) {
  const rows = formationRows(formation);
  const unavailable = reason => ({ mode: 'unavailable', reason, rows: [] });
  if (!Array.isArray(players) || players.length !== 11) return unavailable('incomplete_starting_xi');
  const ids = players.map(playerId);
  if (ids.some(id => !id) || new Set(ids).size !== 11) return unavailable('unverified_player_identity');
  if (!rows) return unavailable('formation_unavailable');
  const grids = players.map(player => player.grid ?? player.player?.grid);
  if (grids.some(grid => grid !== undefined && grid !== null && grid !== '')) {
    const parsed = grids.map(parseGrid);
    if (parsed.some(grid => !grid)) return unavailable('incomplete_position_grid');
    const assigned = rows.map((count, index) => {
      const row = players.map((player, i) => ({ player, grid: parsed[i] }))
        .filter(item => item.grid.row === index + 1).sort((a, b) => a.grid.column - b.grid.column);
      return row.length === count && row.every((item, i) => item.grid.column === i + 1)
        ? row.map(item => playerId(item.player)) : null;
    });
    if (assigned.some(row => !row)) return unavailable('position_grid_conflict');
    return { mode: 'grid', reason: null, rows: assigned };
  }
  const groups = players.map(player => positionGroup(player.positionGroup || player.position || player.player?.position));
  if (groups.some(group => !group)) return unavailable('positions_unavailable');
  const byGroup = ['G', 'D', 'M', 'F'].map(group => ids.filter((_, index) => groups[index] === group));
  if (byGroup[0].length !== 1 || byGroup[1].length !== rows[1]) return unavailable('source_position_conflict');
  // Grouping G/D/M/F is supported by the source. Splitting five midfielders into
  // "2 holding + 3 attacking" or labelling a left/right slot is not.
  return { mode: 'position_groups', reason: 'exact_positions_unavailable', rows: byGroup.filter(row => row.length) };
}

function comparableTeamId(value, provider) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const prefix = { bsd: 'bsd_t_', kickoffapi: 'ko_t_' }[provider];
  if (prefix && text.startsWith(prefix)) return text.slice(prefix.length);
  return text;
}

function validateLineupIntegrity(lineup, { homeTeamId, awayTeamId, provider = lineup?.source || lineup?.provider || '' } = {}) {
  if (!lineup || typeof lineup !== 'object') return lineup;
  const result = { ...lineup };
  const reasons = new Set();
  const issues = { home: new Set(), away: new Set() };
  const knownReasons = new Set(['invalid_player_row', 'player_identity_missing', 'player_identity_conflict',
    'invalid_player_identity', 'player_provider_conflict', 'player_team_conflict', 'duplicate_player',
    'cross_team_player_conflict', 'incomplete_starting_xi', 'source_position_conflict',
    'position_grid_conflict', 'incomplete_position_grid']);
  // A controller may check an already sanitized adapter payload. Keep the
  // exclusion evidence so the second check cannot hide why a player was removed.
  for (const side of ['home', 'away']) {
    const previous = lineup.integrity?.[side]?.reasons;
    for (const reason of Array.isArray(previous) ? previous : []) {
      if (knownReasons.has(reason)) { issues[side].add(reason); reasons.add(reason); }
    }
  }
  const expected = { home: comparableTeamId(homeTeamId, provider), away: comparableTeamId(awayTeamId, provider) };
  const reject = (side, reason) => { issues[side].add(reason); reasons.add(reason); };
  const seen = { home: new Set(), away: new Set() };
  for (const side of ['home', 'away']) {
    for (const key of [side, side + 'Bench']) {
      result[key] = (Array.isArray(lineup[key]) ? lineup[key] : []).filter(player => {
        const id = playerId(player);
        if (!player || typeof player !== 'object') { reject(side, 'invalid_player_row'); return false; }
        if (!id) {
          reject(side, 'player_identity_missing');
          // A source may know the player name but not a navigable profile ID.
          // Keep that display evidence instead of inventing an ID or hiding it.
          if (!String(player.player?.name ?? player.name ?? player.playerName ?? '').trim()) return false;
        }
        if (player.id && player.player?.id && String(player.id) !== String(player.player.id)) {
          reject(side, 'player_identity_conflict'); return false;
        }
        const rowProvider = explicitPlayerProvider(player);
        if ((id.startsWith('bsd_p_') && !/^bsd_p_[1-9]\d*$/.test(id)) ||
            (id.startsWith('ko_p_') && !/^ko_p_[1-9]\d*$/.test(id))) {
          reject(side, 'invalid_player_identity'); return false;
        }
        const declaredProviders = [player.provider, player.player?.provider].filter(value => typeof value === 'string' && value);
        if (rowProvider && declaredProviders.some(value => value !== rowProvider)) {
          reject(side, 'player_provider_conflict'); return false;
        }
        if (provider && rowProvider && rowProvider !== provider) {
          reject(side, 'player_provider_conflict'); return false;
        }
        // team_id/current_team_id on a national player may be their club.
        // Only a field explicitly bound to the event lineup side is comparable.
        const teamId = comparableTeamId(player.lineupTeamId ?? player.player?.lineupTeamId, provider);
        if (teamId !== null && expected[side] !== null && teamId !== expected[side]) {
          reject(side, 'player_team_conflict'); return false;
        }
        if (id && seen[side].has(id)) { reject(side, 'duplicate_player'); return false; }
        if (id) seen[side].add(id);
        return true;
      });
    }
  }
  const crossTeam = new Set([...seen.home].filter(id => seen.away.has(id)));
  if (crossTeam.size) for (const side of ['home', 'away']) {
    reject(side, 'cross_team_player_conflict');
    for (const key of [side, side + 'Bench']) result[key] = result[key].filter(player => !crossTeam.has(playerId(player)));
  }
  const sides = {};
  for (const side of ['home', 'away']) {
    const startingXiComplete = result[side].length === 11;
    if (!startingXiComplete) reject(side, 'incomplete_starting_xi');
    const layout = buildLineupLayout(result[side], result[side + 'Formation']);
    result[side + 'Layout'] = layout;
    if (['source_position_conflict', 'position_grid_conflict', 'incomplete_position_grid'].includes(layout.reason)) reject(side, layout.reason);
    sides[side] = { startingXiComplete, complete: startingXiComplete && issues[side].size === 0, reasons: [...issues[side]] };
  }
  result.integrity = { complete: sides.home.complete && sides.away.complete, partial: !(sides.home.complete && sides.away.complete), reasons: [...reasons], ...sides };
  return result;
}

module.exports = { buildLineupLayout, formationRows, positionGroup, validateLineupIntegrity };
