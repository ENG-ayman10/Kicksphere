/**
 * Integration test for sportscoreService.js
 * Tests all major functions against live SportScore API
 */

const sportscoreService = require('../services/sportscoreService');

async function runTests() {
  const results = { passed: 0, failed: 0, tests: [] };

  async function test(name, fn) {
    try {
      const result = await fn();
      if (result) {
        results.passed++;
        results.tests.push({ name, status: '✅ PASS', detail: result });
        console.log(`✅ ${name}`);
      } else {
        results.failed++;
        results.tests.push({ name, status: '❌ FAIL', detail: 'null/empty result' });
        console.log(`❌ ${name}: returned null/empty`);
      }
    } catch (e) {
      results.failed++;
      results.tests.push({ name, status: '❌ FAIL', detail: e.message });
      console.log(`❌ ${name}: ${e.message}`);
    }
  }

  console.log('\n🏟️ SportScore Service Integration Tests\n');

  await test('getMatchesByDate (today)', async () => {
    const matches = await sportscoreService.getMatchesByDate('TODAY');
    console.log(`  → ${matches.length} matches found`);
    if (matches.length > 0) {
      const m = matches[0];
      console.log(`  → First match: ${m.homeTeam.name} vs ${m.awayTeam.name} (${m.status})`);
      // Verify no artificial 0-0 for upcoming
      if (m.status === 'TIMED') {
        console.log(`  → Score for upcoming: home=${m.score.fullTime.home}, away=${m.score.fullTime.away}`);
        if (m.score.fullTime.home !== null) {
          console.log('  ⚠️ WARNING: Upcoming match has non-null score!');
        }
      }
    }
    return matches.length > 0;
  });

  await test('getLiveMatches', async () => {
    const matches = await sportscoreService.getLiveMatches();
    console.log(`  → ${matches.length} live/recent matches found`);
    return matches.length >= 0; // OK even if 0 (no live games)
  });

  await test('getStandings (PL)', async () => {
    const standings = await sportscoreService.getStandings('PL');
    console.log(`  → ${standings.length} teams in Premier League table`);
    if (standings.length > 0) {
      console.log(`  → #1: ${standings[0].team.name} (${standings[0].points} pts)`);
      console.log(`  → Logo: ${standings[0].team.crest}`);
    }
    return standings.length === 20;
  });

  await test('getStandings (BL1 - Bundesliga)', async () => {
    const standings = await sportscoreService.getStandings('BL1');
    console.log(`  → ${standings.length} teams in Bundesliga table`);
    return standings.length === 18;
  });

  await test('getTopScorers (PD - La Liga goals)', async () => {
    const scorers = await sportscoreService.getTopScorers('PD', 10, 'goals');
    console.log(`  → ${scorers.length} scorers`);
    if (scorers.length > 0) {
      console.log(`  → #1: ${scorers[0].player.name} (${scorers[0].goals} goals)`);
      console.log(`  → Image: ${scorers[0].player.image}`);
    }
    return scorers.length > 0;
  });

  await test('getTopScorers (PL - assists)', async () => {
    const assists = await sportscoreService.getTopScorers('PL', 10, 'assists');
    console.log(`  → ${assists.length} assist leaders`);
    return assists.length > 0;
  });

  await test('getMatchDetails (fc-barcelona-vs-getafe)', async () => {
    const detail = await sportscoreService.getMatchDetails('fc-barcelona-vs-getafe');
    if (detail) {
      console.log(`  → ${detail.homeTeam.name} ${detail.score.fullTime.home}-${detail.score.fullTime.away} ${detail.awayTeam.name}`);
      console.log(`  → Timeline events: ${detail.timeline?.length || 0}`);
      console.log(`  → Lineups: home=${detail.lineups?.home?.length || 0}, away=${detail.lineups?.away?.length || 0}`);
      console.log(`  → Formation: ${detail.lineups?.homeFormation} vs ${detail.lineups?.awayFormation}`);
    }
    return detail && detail.homeTeam;
  });

  await test('getPlayerDetails (erling-haaland)', async () => {
    const player = await sportscoreService.getPlayerDetails('erling-haaland');
    if (player) {
      console.log(`  → Name: ${player.name}`);
      console.log(`  → Team: ${player.team}`);
      console.log(`  → Goals: ${player.goals}, Assists: ${player.assists}`);
      console.log(`  → Image: ${player.image}`);
    }
    return player && player.name;
  });

  await test('getTeamDetails (fc-barcelona)', async () => {
    const team = await sportscoreService.getTeamDetails('fc-barcelona');
    if (team) {
      console.log(`  → Team: ${team.info.name}`);
      console.log(`  → Logo: ${team.info.logo}`);
      console.log(`  → Recent matches: ${team.matches.recent.length}`);
      console.log(`  → Upcoming matches: ${team.matches.upcoming.length}`);
    }
    return team && team.info;
  });

  await test('searchEntities (barcelona)', async () => {
    const res = await sportscoreService.searchEntities('barcelona');
    console.log(`  → Teams: ${res.teams?.length || 0}, Competitions: ${res.competitions?.length || 0}`);
    return res.teams?.length > 0;
  });

  await test('getH2H (fc-barcelona vs real-madrid)', async () => {
    const h2h = await sportscoreService.getH2H('fc-barcelona', 'real-madrid');
    if (h2h) {
      console.log(`  → Meetings: ${h2h.summary.meetings}`);
      console.log(`  → Barca wins: ${h2h.summary.team1_wins}, Madrid wins: ${h2h.summary.team2_wins}, Draws: ${h2h.summary.draws}`);
      console.log(`  → Match history: ${h2h.matches.length} games`);
    }
    return h2h && h2h.summary;
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 Results: ${results.passed} passed, ${results.failed} failed out of ${results.passed + results.failed} tests`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  process.exit(results.failed > 0 ? 1 : 0);
}

runTests();
