const test = require('node:test');
const assert = require('node:assert/strict');
const { scopedTeamId, favoriteTeamIds, matchTeamId } = require('../utils/teamIdentity');
const { normalizeFavoriteItem, normalizePreferences } = require('../utils/userContracts');

test('BSD favorites retain exact provider identity independently of namesake sources', () => {
  const favorite = normalizeFavoriteItem({ type: 'club', targetId: 'bsd_t_44', provider: 'bsd',
    name: 'Barcelona', logo: 'https://sports.bzzoiro.com/img/team/44/' });
  assert.equal(favorite.targetId, 'bsd_t_44');
  assert.equal(favorite.provider, 'bsd');
  assert.equal(favorite.canonicalKey, 'team:bsd_t_44');
  assert.equal(favorite.imageUrl, 'https://sports.bzzoiro.com/img/team/44/');
  assert.equal(normalizeFavoriteItem({ type: 'team', targetId: 'bsd_t_44' }).provider, 'bsd');
  assert.deepEqual(favoriteTeamIds([favorite, 'ko_t_529', 'sc_t_barcelona', 'Barcelona', '44']),
    ['bsd_t_44', 'ko_t_529', 'sc_t_barcelona']);
  assert.equal(matchTeamId({ id: 'bsd_t_44', provider: 'bsd' }, 'bsd+sportscore'), 'bsd_t_44');
  assert.equal(matchTeamId({ id: 44, provider: 'bsd' }), 'bsd_t_44');
});

test('BSD identity rejects wrong providers, event/player IDs, guessed names and malformed integers', () => {
  for (const id of ['0', '00', '01', '-1', 'bsd_t_0', 'bsd_t_01', 'bsd_44', 'bsd_p_44', 'Real Madrid']) {
    assert.equal(scopedTeamId(id, 'bsd'), null);
  }
  for (const provider of ['sportscore', 'kickoffapi', 'unknown']) {
    assert.equal(scopedTeamId('bsd_t_44', provider), null);
    assert.throws(() => normalizeFavoriteItem({ type: 'team', targetId: 'bsd_t_44', provider }), /provider/);
  }
  assert.equal(scopedTeamId('ko_t_44', 'bsd'), null);
  assert.equal(scopedTeamId('sc_t_44', 'bsd'), null);
  assert.equal(scopedTeamId('1'.repeat(114), 'bsd').length, 120);
  assert.equal(scopedTeamId('1'.repeat(115), 'bsd'), null);
});

test('BSD preference index and records preserve the same identity for personalization and alerts', () => {
  const preferences = normalizePreferences({ teams: ['Old Club'], teamIds: ['bsd_t_57', 'sc_t_real-madrid'],
    teamsV2: [{ id: 57, provider: 'bsd', name: 'Real Madrid' }] });
  assert.deepEqual(preferences.teams, ['Old Club']);
  assert.deepEqual(preferences.teamIds, ['bsd_t_57', 'sc_t_real-madrid']);
  assert.equal(preferences.teamsV2[0].targetId, 'bsd_t_57');
  assert.equal(preferences.teamsV2[0].provider, 'bsd');
});
