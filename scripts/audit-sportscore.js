/** Read-only integration audit. No Firebase access, credentials, or writes to services. */
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');
const { COMPETITION_SLUGS } = require('../services/sportscoreService');

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const date = option('date') || new Date().toISOString().slice(0, 10);
const output = option('output');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !output) {
  console.error('Usage: node scripts/audit-sportscore.js --date=YYYY-MM-DD --output=absolute-report.json');
  process.exit(1);
}
const results = [];
const payloads = new Map();
const jobs = [];
const add = (name, endpoint, params = {}, backend = false) => jobs.push({ name, endpoint, params, backend });
const count = value => Array.isArray(value) ? value.length : null;
function summarize(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { invalidJsonObject: true };
  const match = data.match || {};
  const matches = data.matches || (Array.isArray(data.data) ? data.data.flatMap(g => g.matches || []) : []);
  const times = matches.map(m => m.time || m.utcDate).filter(Boolean).sort();
  const lineup = match.lineups || {};
  return {
    keys: Object.keys(data), success: data.success, source: data.source, count: data.count,
    matchCount: matches.length, uniqueMatches: new Set(matches.map(m => `${m.url || m.id}|${m.time || m.utcDate}`)).size,
    earliest: times[0], latest: times.at(-1), statuses: [...new Set(matches.map(m => m.status))],
    competitions: [...new Set(matches.map(m => typeof m.competition === 'string' ? m.competition : m.competition?.name))],
    tables: data.tables?.map(t => ({ group: t.group, rows: count(t.rows) })),
    scorers: count(data.scorers), firstScorer: data.scorers?.[0],
    teams: count(data.teams), players: count(data.players), searchCompetitions: count(data.competitions),
    player: data.player, playerStats: data.stats, team: data.team,
    match: data.match ? { home: match.home, away: match.away, time: match.time, status: match.status,
      keys: Object.keys(match), incidents: count(match.incidents), stats: count(match.stats),
      homeXI: count(lineup.home_xi), awayXI: count(lineup.away_xi), homeBench: count(lineup.home_subs),
      confirmed: lineup.confirmed, firstPlayer: lineup.home_xi?.[0], tracker: match.tracker } : undefined,
    h2h: data.summary, rounds: count(data.rounds), backendDataKeys: data.data && !Array.isArray(data.data) ? Object.keys(data.data) : undefined,
  };
}
async function run(job) {
  const start = Date.now();
  const base = job.backend ? 'https://kicksphere.onrender.com' : 'https://sportscore.com';
  const params = job.backend ? job.params : { sport: 'football', src: 'kicksphere', ...job.params };
  try {
    const r = await axios.get(base + job.endpoint, { params, timeout: 20000, validateStatus: () => true,
      headers: { Accept: 'application/json', 'User-Agent': 'KickSphereApp/1.0 (data audit)' } });
    payloads.set(job.name, r.data);
    results.push({ name: job.name, url: axios.getUri({ url: base + job.endpoint, params }),
      status: r.status, elapsedMs: Date.now() - start, contentType: r.headers['content-type'], ...summarize(r.data) });
    console.log(`${job.name}: HTTP ${r.status}`);
  } catch (e) {
    results.push({ name: job.name, elapsedMs: Date.now() - start, error: e.message });
    console.log(`${job.name}: ${e.message}`);
  }
}
add('fixtures-current', '/api/v1/fixtures/', { date, limit: 200 });
add('fixtures-live', '/api/v1/fixtures/', { date, status: 'live', limit: 200 });
add('fixtures-international', '/api/v1/fixtures/', { date, competition: 'uefa-nations-league', limit: 200 });
add('widget-live-current', '/api/widget/matches/', { limit: 50 });
for (const [code, info] of Object.entries(COMPETITION_SLUGS)) {
  add(`standings-${code}`, '/api/widget/standings/', { slug: info.slug });
  add(`scorers-${code}`, '/api/widget/topscorers/', { slug: info.slug, limit: 5 });
}
add('assists-PL', '/api/widget/topscorers/', { slug: COMPETITION_SLUGS.PL.slug, limit: 5, stat: 'assists' });
add('search-teams', '/api/v1/search/', { q: 'barcelona', limit: 20 });
add('search-players', '/api/v1/search/', { q: 'haaland', limit: 20 });
add('search-leagues', '/api/v1/search/', { q: 'premier league', limit: 20 });
add('player', '/api/widget/player/', { slug: 'erling-haaland' });
add('team', '/api/widget/team/', { slug: 'fc-barcelona', limit: 30 });
add('team-name-collision', '/api/widget/team/', { slug: 'barcelona', limit: 1 });
add('match-major', '/api/widget/match/', { slug: 'real-madrid-vs-fc-barcelona' });
add('match-other', '/api/widget/match/', { slug: 'aguila-vs-luis-angel-firpo' });
add('h2h', '/api/v1/h2h/', { team1: 'fc-barcelona', team2: 'real-madrid', limit: 10 });
add('bracket', '/api/widget/bracket/', { slug: 'uefa-champions-league' });
for (const [name, endpoint, params] of [
  ['health', '/api/health', {}], ['matches', '/api/matches', { date }],
  ['live', '/api/matches/live', {}], ['search', '/api/search', { q: 'haaland' }],
  ['standings', '/api/stats/teams', { league: 'PL' }], ['scorers', '/api/stats/players', { league: 'PL' }],
  ['player', '/api/stats/deep/player/erling-haaland', {}], ['team', '/api/stats/deep/team/fc-barcelona', {}],
  ['match', '/api/stats/deep/match/real-madrid-vs-fc-barcelona', {}], ['news', '/api/news', {}],
]) add(`deployed-${name}`, endpoint, params, true);

(async () => {
  let next = 0;
  await Promise.all(Array.from({ length: 2 }, async () => { while (next < jobs.length) await run(jobs[next++]); }));
  const images = [payloads.get('player')?.player?.logo, payloads.get('team')?.team?.logo,
    payloads.get('standings-PL')?.competition_logo].filter(Boolean);
  for (const url of new Set(images)) {
    try {
      const r = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer', validateStatus: () => true });
      results.push({ name: 'image', url, status: r.status, contentType: r.headers['content-type'], bytes: r.data.length });
    } catch (e) { results.push({ name: 'image', url, error: e.message }); }
  }
  const deployed = {};
  for (const [key, value] of payloads) if (key.startsWith('deployed-')) deployed[key] = value;
  fs.writeFileSync(path.resolve(output), JSON.stringify({ checkedAt: new Date().toISOString(), requestedDate: date, results, deployed }, null, 2));
  console.log(`Saved ${results.length} checks to ${path.resolve(output)}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
