const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLineupLayout, validateLineupIntegrity } = require('../utils/lineupIntegrity');

const player = (id, position, extra = {}) => ({ id: 'bsd_p_' + id, name: 'Player ' + id, position, ...extra });
const xi = (start = 1) => ['G','D','D','D','D','M','M','M','M','M','F'].map((role, i) => player(start + i, role));
const lineups = () => ({ source: 'bsd', confirmed: true, lineupStatus: 'confirmed', home: xi(), away: xi(20), homeBench: [], awayBench: [], homeFormation: '4-2-3-1', awayFormation: '4-2-3-1' });

test('unordered provider roles use position groups without inventing tactical midfield slots', () => {
  const rows = xi().reverse();
  const layout = buildLineupLayout(rows, '4-2-3-1');
  assert.equal(layout.mode, 'position_groups');
  assert.deepEqual(layout.rows.map(row => row.length), [1, 4, 5, 1]);
  assert.deepEqual(layout.rows[0], ['bsd_p_1']);
  assert.equal(layout.reason, 'exact_positions_unavailable');
});

test('explicit provider grid restores exact rows from a shuffled starting XI', () => {
  const grids = ['1:1', '2:1', '2:2', '2:3', '2:4', '3:1', '3:2', '4:1', '4:2', '4:3', '5:1'];
  const rows = xi().map((item, i) => ({ ...item, grid: grids[i] })).reverse();
  const layout = buildLineupLayout(rows, '4-2-3-1');
  assert.equal(layout.mode, 'grid');
  assert.deepEqual(layout.rows.map(row => row.length), [1, 4, 2, 3, 1]);
  assert.deepEqual(layout.rows[1], ['bsd_p_2', 'bsd_p_3', 'bsd_p_4', 'bsd_p_5']);
});

test('a complete contiguous provider grid survives a missing formation label without inventing a formation', () => {
  const grids = ['1:1', '2:1', '2:2', '2:3', '2:4', '3:1', '3:2', '4:1', '4:2', '4:3', '5:1'];
  const players = xi().map((item, i) => ({ ...item, grid: grids[i] })).reverse();
  const layout = buildLineupLayout(players, '');
  assert.equal(layout.mode, 'grid'); assert.equal(layout.reason, 'formation_unavailable');
  assert.deepEqual(layout.rows.map(row => row.length), [1, 4, 2, 3, 1]);
  assert.equal(buildLineupLayout(players, '4-4-2').reason, 'position_grid_conflict');
  const disconnected = players.map(item => ({ ...item, grid: item.grid.startsWith('4:') ? item.grid.replace('4:', '6:') : item.grid }));
  assert.equal(buildLineupLayout(disconnected, '').reason, 'position_grid_conflict');
});

test('explicit grids cannot place a known outfield player in goal or a known goalkeeper outside its row', () => {
  const grids = ['1:1', '2:1', '2:2', '2:3', '2:4', '3:1', '3:2', '3:3', '3:4', '4:1', '4:2'];
  const valid = ['G','D','D','D','D','M','M','M','M','F','F'].map((position, index) =>
    player(index + 1, position, { grid: grids[index] }));
  for (const mutate of [rows => { rows[0].position = 'D'; rows[1].position = 'G'; },
    rows => { rows[1].position = 'G'; }, rows => { rows[0].position = 'D'; },
    rows => { rows[0].position = 'D'; rows[1].position = ''; }]) {
    const rows = structuredClone(valid); mutate(rows);
    assert.equal(buildLineupLayout(rows, '4-4-2').reason, 'position_grid_conflict');
    assert.equal(buildLineupLayout(rows, '').reason, 'position_grid_conflict');
  }
  assert.equal(buildLineupLayout(valid.map(row => ({ ...row, position: '' })), '4-4-2').mode, 'grid');
});

test('partial or duplicate grids cannot silently fall back to made-up pitch slots', () => {
  const partial = xi(); partial[0].grid = '1:1';
  assert.equal(buildLineupLayout(partial, '4-2-3-1').reason, 'incomplete_position_grid');
  const wrong = xi().map(item => ({ ...item, grid: '2:1' }));
  assert.equal(buildLineupLayout(wrong, '4-2-3-1').reason, 'position_grid_conflict');
});

test('the same player cannot be shown for both opponents or simultaneously in XI and bench', () => {
  const input = lineups(); input.homeBench = [input.home[0]]; input.away[0] = input.home[1];
  const result = validateLineupIntegrity(input, { homeTeamId: 'bsd_t_1', awayTeamId: 'bsd_t_2' });
  assert.equal(result.homeBench.length, 0);
  assert.equal(result.home.some(item => item.id === 'bsd_p_2'), false);
  assert.equal(result.away.some(item => item.id === 'bsd_p_2'), false);
  assert.equal(result.integrity.complete, false);
  assert.ok(result.integrity.reasons.includes('cross_team_player_conflict'));
  assert.ok(result.integrity.reasons.includes('duplicate_player'));
  assert.equal(input.home.length, 11); // No mutation of cached provider records.
  assert.equal(input.homeBench.length, 1);
  assert.equal(result.lineupStatus, 'confirmed'); // Announcement provenance is not fabricated.
});

test('per-player team and nested player identity conflicts are excluded, not repaired by guessing', () => {
  const input = lineups(); input.home[0].lineupTeamId = 'bsd_t_2';
  input.home[1].player = { id: 'bsd_p_999', name: 'Different person' };
  const result = validateLineupIntegrity(input, { homeTeamId: 'bsd_t_1', awayTeamId: 'bsd_t_2' });
  assert.equal(result.home.length, 9);
  assert.deepEqual(result.integrity.home.reasons, ['player_team_conflict', 'player_identity_conflict', 'incomplete_starting_xi']);
  assert.equal(result.integrity.away.complete, true);
});

test('a national-team player may retain a different current club; unnamed missing-ID rows are not fabricated', () => {
  const input = lineups();
  input.home[0].teamId = 'bsd_t_900';
  input.home[0].team_id = 900;
  input.home[0].current_team_id = 900;
  delete input.home[1].id;
  input.home[1].name = 'Known source name without profile ID';
  const result = validateLineupIntegrity(input, { homeTeamId: 'bsd_t_1', awayTeamId: 'bsd_t_2' });
  assert.equal(result.home.length, 11);
  assert.equal(result.home[0].teamId, 'bsd_t_900');
  assert.equal(result.home[1].name, 'Known source name without profile ID');
  assert.equal(result.home[1].id, undefined);
  assert.equal(result.integrity.partial, true);
  assert.equal(result.homeLayout.reason, 'unverified_player_identity');
});

test('missing formation and roles do not change verified XI completeness or claim tactical slots', () => {
  const input = lineups(); input.homeFormation = ''; input.away = input.away.map(item => ({ ...item, position: '' }));
  const result = validateLineupIntegrity(input);
  assert.equal(result.integrity.complete, true);
  assert.equal(result.homeLayout.reason, 'formation_unavailable');
  assert.equal(result.homeLayout.mode, 'position_groups');
  assert.deepEqual(result.homeLayout.rows.map(row => row.length), [1, 4, 5, 1]);
  assert.equal(result.awayLayout.reason, 'positions_unavailable');
});

test('same numeric ID from another provider cannot become this provider’s lineup player', () => {
  const input = lineups();
  input.home[0] = { id: 'ko_p_1', name: 'Another provider player', position: 'G' };
  const result = validateLineupIntegrity(input, { provider: 'bsd' });
  assert.equal(result.home.length, 10);
  assert.ok(result.integrity.home.reasons.includes('player_provider_conflict'));
});

test('saved BSD Germany–Serbia source conflict does not place a midfielder as fourth defender', () => {
  // Recorded event 212636, GET /api/v2/events/212636/lineups/, 2026-10-01.
  // Source says 4-2-3-1 but its fifth entry is a midfielder, not a defender.
  const germany = ['G','D','D','D','M','M','M','F','M','M','F'].map((role, i) => player(i + 1, role));
  germany[4].name = 'Lennart Karl';
  const serbia = ['G','D','D','D','M','M','M','M','M','M','F'].map((role, i) => player(i + 20, role));
  serbia[4].name = 'Nemanja Gudelj';
  for (const players of [germany, serbia]) {
    const layout = buildLineupLayout(players, '4-2-3-1');
    assert.equal(layout.reason, 'source_position_conflict');
    assert.equal(layout.mode, 'position_groups');
    assert.equal(layout.rows[1].length, 3);
    assert.equal(layout.rows.flat().length, 11);
  }
  const checked = validateLineupIntegrity({ ...lineups(), home: germany, away: serbia });
  assert.equal(checked.integrity.complete, false);
  assert.ok(checked.integrity.reasons.includes('source_position_conflict'));
});

test('broad groups still reject an unverifiable XI, missing roles or a second goalkeeper', () => {
  const input = xi();
  assert.equal(buildLineupLayout(input.slice(1), '').mode, 'unavailable');
  input[1].position = 'G';
  assert.equal(buildLineupLayout(input, '').reason, 'source_position_conflict');
  input[1].position = '';
  assert.equal(buildLineupLayout(input, '').reason, 'positions_unavailable');
  input[1].position = 'D';
  input[1].id = input[0].id;
  assert.equal(buildLineupLayout(input, '').reason, 'unverified_player_identity');
});
