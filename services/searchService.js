/**
 * @file searchService.js
 * @description Universal search — searches clubs, players, and leagues from local database.
 */

// Removed invalid require for CLUBS
const logger = require('../utils/logger');

// ==========================================
// 🛡️ CLUBS DATABASE
// ==========================================
const CLUBS = {
  'Real Madrid': { league: 'La Liga', logo: 'https://crests.football-data.org/86.png' },
  'Barcelona': { league: 'La Liga', logo: 'https://crests.football-data.org/81.png' },
  'Manchester City': { league: 'Premier League', logo: 'https://crests.football-data.org/65.png' },
  'Arsenal': { league: 'Premier League', logo: 'https://crests.football-data.org/57.png' },
  'Liverpool': { league: 'Premier League', logo: 'https://crests.football-data.org/64.png' },
  'Manchester United': { league: 'Premier League', logo: 'https://crests.football-data.org/66.png' },
  'Chelsea': { league: 'Premier League', logo: 'https://crests.football-data.org/61.png' },
  'Tottenham': { league: 'Premier League', logo: 'https://crests.football-data.org/73.png' },
  'Bayern Munich': { league: 'Bundesliga', logo: 'https://crests.football-data.org/5.png' },
  'Bayer Leverkusen': { league: 'Bundesliga', logo: 'https://crests.football-data.org/3.png' },
  'Inter Milan': { league: 'Serie A', logo: 'https://crests.football-data.org/108.png' },
  'AC Milan': { league: 'Serie A', logo: 'https://crests.football-data.org/98.png' },
  'Juventus': { league: 'Serie A', logo: 'https://crests.football-data.org/109.png' },
  'Napoli': { league: 'Serie A', logo: 'https://crests.football-data.org/113.png' },
  'PSG': { league: 'Ligue 1', logo: 'https://crests.football-data.org/524.png' },
};

// ==========================================
// 🌟 PLAYER DATABASE
// ==========================================
const PLAYERS = [
  { name: 'Kylian Mbappé', team: 'Real Madrid', position: 'Forward', nationality: 'France', number: 9 },
  { name: 'Erling Haaland', team: 'Manchester City', position: 'Forward', nationality: 'Norway', number: 9 },
  { name: 'Jude Bellingham', team: 'Real Madrid', position: 'Midfielder', nationality: 'England', number: 5 },
  { name: 'Vinicius Jr', team: 'Real Madrid', position: 'Forward', nationality: 'Brazil', number: 7 },
  { name: 'Mohamed Salah', team: 'Liverpool', position: 'Forward', nationality: 'Egypt', number: 11 },
  { name: 'Bukayo Saka', team: 'Arsenal', position: 'Forward', nationality: 'England', number: 7 },
  { name: 'Lamine Yamal', team: 'Barcelona', position: 'Forward', nationality: 'Spain', number: 19 },
  { name: 'Robert Lewandowski', team: 'Barcelona', position: 'Forward', nationality: 'Poland', number: 9 },
  { name: 'Rodri', team: 'Manchester City', position: 'Midfielder', nationality: 'Spain', number: 16 },
  { name: 'Bruno Fernandes', team: 'Manchester United', position: 'Midfielder', nationality: 'Portugal', number: 8 },
  { name: 'Harry Kane', team: 'Bayern Munich', position: 'Forward', nationality: 'England', number: 9 },
  { name: 'Jamal Musiala', team: 'Bayern Munich', position: 'Midfielder', nationality: 'Germany', number: 42 },
  { name: 'Lautaro Martinez', team: 'Inter Milan', position: 'Forward', nationality: 'Argentina', number: 10 },
  { name: 'Victor Osimhen', team: 'Napoli', position: 'Forward', nationality: 'Nigeria', number: 9 },
  { name: 'Martin Ødegaard', team: 'Arsenal', position: 'Midfielder', nationality: 'Norway', number: 8 },
  { name: 'Pedri', team: 'Barcelona', position: 'Midfielder', nationality: 'Spain', number: 8 },
  { name: 'Florian Wirtz', team: 'Bayer Leverkusen', position: 'Midfielder', nationality: 'Germany', number: 10 },
  { name: 'Cole Palmer', team: 'Chelsea', position: 'Forward', nationality: 'England', number: 20 },
  { name: 'Son Heung-min', team: 'Tottenham', position: 'Forward', nationality: 'South Korea', number: 7 },
  { name: 'Rafael Leão', team: 'AC Milan', position: 'Forward', nationality: 'Portugal', number: 10 },
  { name: 'Dušan Vlahović', team: 'Juventus', position: 'Forward', nationality: 'Serbia', number: 9 },
  { name: 'Ousmane Dembélé', team: 'PSG', position: 'Forward', nationality: 'France', number: 10 },
];

// ==========================================
// 🔥 LEAGUE DATABASE
// ==========================================
const LEAGUES = [
  { name: 'Premier League', country: 'England', logo: 'https://crests.football-data.org/PL.png' },
  { name: 'La Liga', country: 'Spain', logo: 'https://crests.football-data.org/PD.png' },
  { name: 'Serie A', country: 'Italy', logo: 'https://crests.football-data.org/SA.png' },
  { name: 'Bundesliga', country: 'Germany', logo: 'https://crests.football-data.org/BL1.png' },
  { name: 'Ligue 1', country: 'France', logo: 'https://crests.football-data.org/FL1.png' },
  { name: 'UEFA Champions League', country: 'Europe', logo: 'https://crests.football-data.org/CL.png' },
];

/**
 * Perform a universal search for teams, players, and leagues.
 */
exports.searchAll = async (query) => {
  const q = query.toLowerCase().trim();
  if (!q) return { teams: [], players: [], leagues: [], matches: [] };

  // Search Teams
  const teams = Object.entries(CLUBS)
    .filter(([name]) => name.toLowerCase().includes(q))
    .map(([name, data]) => ({
      name,
      league: data.league,
      logo: data.logo
    }))
    .slice(0, 10);

  // Search Players
  const players = PLAYERS
    .filter(p => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q))
    .map(p => ({
      name: p.name,
      team: p.team,
      position: p.position,
      nationality: p.nationality,
      number: p.number,
      teamLogo: CLUBS[p.team]?.logo || ''
    }))
    .slice(0, 10);

  // Search Leagues
  const leagues = LEAGUES
    .filter(l => l.name.toLowerCase().includes(q) || l.country.toLowerCase().includes(q))
    .slice(0, 5);

  return { teams, players, leagues, matches: [] };
};

exports.PLAYERS = PLAYERS;
exports.LEAGUES = LEAGUES;
