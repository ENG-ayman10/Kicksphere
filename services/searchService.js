/**
 * @file searchService.js
 * @description Universal search facade for teams, players, and supported competitions.
 */

const logger = require('../utils/logger');
const sportscoreService = require('./sportscoreService');
const { COMPETITION_SLUGS } = require('./sportscoreService');

const normalizeTerm = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

const toText = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
};

const CLUBS = {
  'Real Madrid': {
    id: '86',
    league: 'La Liga',
    leagueCode: 'PD',
    country: 'Spain',
    logo: 'https://crests.football-data.org/86.png'
  },
  Barcelona: {
    id: '81',
    league: 'La Liga',
    leagueCode: 'PD',
    country: 'Spain',
    logo: 'https://crests.football-data.org/81.png'
  },
  'Manchester City': {
    id: '65',
    league: 'Premier League',
    leagueCode: 'PL',
    country: 'England',
    logo: 'https://crests.football-data.org/65.png'
  },
  Arsenal: {
    id: '57',
    league: 'Premier League',
    leagueCode: 'PL',
    country: 'England',
    logo: 'https://crests.football-data.org/57.png'
  },
  Liverpool: {
    id: '64',
    league: 'Premier League',
    leagueCode: 'PL',
    country: 'England',
    logo: 'https://crests.football-data.org/64.png'
  },
  'Manchester United': {
    id: '66',
    league: 'Premier League',
    leagueCode: 'PL',
    country: 'England',
    logo: 'https://crests.football-data.org/66.png'
  },
  Chelsea: {
    id: '61',
    league: 'Premier League',
    leagueCode: 'PL',
    country: 'England',
    logo: 'https://crests.football-data.org/61.png'
  },
  Tottenham: {
    id: '73',
    league: 'Premier League',
    leagueCode: 'PL',
    country: 'England',
    logo: 'https://crests.football-data.org/73.png'
  },
  'Bayern Munich': {
    id: '5',
    league: 'Bundesliga',
    leagueCode: 'BL1',
    country: 'Germany',
    logo: 'https://crests.football-data.org/5.png'
  },
  'Bayer Leverkusen': {
    id: '3',
    league: 'Bundesliga',
    leagueCode: 'BL1',
    country: 'Germany',
    logo: 'https://crests.football-data.org/3.png'
  },
  'Inter Milan': {
    id: '108',
    league: 'Serie A',
    leagueCode: 'SA',
    country: 'Italy',
    logo: 'https://crests.football-data.org/108.png'
  },
  'AC Milan': {
    id: '98',
    league: 'Serie A',
    leagueCode: 'SA',
    country: 'Italy',
    logo: 'https://crests.football-data.org/98.png'
  },
  Juventus: {
    id: '109',
    league: 'Serie A',
    leagueCode: 'SA',
    country: 'Italy',
    logo: 'https://crests.football-data.org/109.png'
  },
  Napoli: {
    id: '113',
    league: 'Serie A',
    leagueCode: 'SA',
    country: 'Italy',
    logo: 'https://crests.football-data.org/113.png'
  },
  PSG: {
    id: '524',
    league: 'Ligue 1',
    leagueCode: 'FL1',
    country: 'France',
    logo: 'https://crests.football-data.org/524.png'
  },
};

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

const LEAGUE_ALIASES = {
  PL: ['EPL', 'English Premier League'],
  PD: ['LaLiga', 'Primera Division'],
  SA: ['Italian Serie A'],
  BL1: ['German Bundesliga'],
  FL1: ['French Ligue 1'],
  CL: ['UEFA Champions League', 'UCL'],
  PPL: ['Liga Portugal'],
  ELC: ['English Championship', 'EFL Championship'],
  DED: ['Dutch Eredivisie'],
  BSA: ['Brazil Serie A', 'Brasileirao'],
  EC: ['Euro', 'European Championship'],
  WC: ['FIFA World Cup'],
};

const emptyResult = (source = 'empty') => ({
  teams: [],
  players: [],
  leagues: [],
  matches: [],
  source
});

const hasMatches = (results = {}) => (
  (results.teams || []).length > 0 ||
  (results.players || []).length > 0 ||
  (results.leagues || []).length > 0 ||
  (results.matches || []).length > 0
);

const relevanceScore = (item, q, fields) => {
  const values = fields.map(field => normalizeTerm(item[field]));
  if (values.some(value => value === q)) return 0;
  if (values.some(value => value.startsWith(q))) return 1;
  if (values.some(value => value.includes(q))) return 2;
  return 3;
};

const sortByRelevance = (items, q, fields) => items.sort((a, b) => {
  const score = relevanceScore(a, q, fields) - relevanceScore(b, q, fields);
  if (score !== 0) return score;
  return toText(a.name).localeCompare(toText(b.name));
});

const mapLocalTeam = ([name, data]) => ({
  id: data.id,
  targetId: name,
  provider: 'football-data.org',
  providerId: data.id,
  name,
  shortName: name,
  league: data.league,
  leagueCode: data.leagueCode,
  country: data.country,
  logo: data.logo
});

const mapLocalPlayer = (player) => {
  const team = CLUBS[player.team] || {};
  return {
    id: player.id || player.name,
    targetId: player.id || player.name,
    provider: 'local-fallback',
    providerId: player.id || null,
    name: player.name,
    shortName: player.name,
    team: player.team,
    teamId: team.id || null,
    teamLogo: team.logo || '',
    position: player.position,
    nationality: player.nationality,
    country: player.nationality,
    number: player.number
  };
};

const mapLeague = ([code, info]) => ({
  id: code,
  targetId: code,
  code,
  provider: 'sportscore',
  providerId: info.slug,
  name: info.name,
  country: info.country,
  logo: info.logo,
  aliases: LEAGUE_ALIASES[code] || []
});

const searchLocal = (q) => {
  const teams = Object.entries(CLUBS)
    .map(mapLocalTeam)
    .filter(team => [
      team.name,
      team.shortName,
      team.league,
      team.leagueCode,
      team.country
    ].some(value => normalizeTerm(value).includes(q)));

  const players = PLAYERS
    .map(mapLocalPlayer)
    .filter(player => [
      player.name,
      player.team,
      player.position,
      player.nationality
    ].some(value => normalizeTerm(value).includes(q)));

  const leagues = Object.entries(COMPETITION_SLUGS)
    .map(mapLeague)
    .filter(league => [
      league.id,
      league.code,
      league.name,
      league.country,
      ...league.aliases
    ].some(value => normalizeTerm(value).includes(q)));

  return {
    teams: sortByRelevance(teams, q, ['name', 'league', 'country']).slice(0, 10),
    players: sortByRelevance(players, q, ['name', 'team', 'nationality']).slice(0, 10),
    leagues: sortByRelevance(leagues, q, ['code', 'name', 'country']).slice(0, 8),
    matches: []
  };
};

const mergeUnique = (primary = [], fallback = [], fields = ['name']) => {
  const seen = new Set();
  const merged = [];

  const add = (item) => {
    if (!item || typeof item !== 'object') return;
    const key = fields
      .map(field => normalizeTerm(item[field]))
      .filter(Boolean)
      .join(':');
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  };

  primary.forEach(add);
  fallback.forEach(add);
  return merged;
};

exports.searchAll = async (query, options = {}) => {
  const rawQuery = toText(query);
  const q = normalizeTerm(rawQuery);
  if (!q) return emptyResult();

  const fallback = searchLocal(q);
  let sportscoreProvider = emptyResult('sportscore');
  const providerSources = [];

  // 1. Try SportScore search
  if (options.useProvider !== false && q.length >= 2) {
    try {
      const scResult = await sportscoreService.searchEntities(rawQuery, 10);
      if (scResult && (scResult.teams?.length > 0 || scResult.competitions?.length > 0 || scResult.players?.length > 0)) {
        sportscoreProvider = {
          teams: (scResult.teams || []).map(t => ({
            id: t.slug || t.id,
            targetId: t.slug || t.id,
            provider: 'sportscore',
            providerId: t.slug,
            name: t.name,
            shortName: t.name,
            logo: t.logo || t.crest || '',
            slug: t.slug || ''
          })),
          players: (scResult.players || []).map(p => ({
             id: p.slug || p.id,
             targetId: p.slug || p.id,
             provider: 'sportscore',
             providerId: p.slug,
             name: p.name,
             shortName: p.name,
             logo: p.logo || '',
             slug: p.slug || ''
          })),
          leagues: (scResult.competitions || []).map(c => ({
            id: c.slug || c.id,
            targetId: c.slug || c.id,
            code: c.slug,
            provider: 'sportscore',
            providerId: c.slug,
            name: c.name,
            logo: c.logo || c.emblem || '',
            slug: c.slug || ''
          })),
          matches: [],
          source: 'sportscore'
        };
        if (hasMatches(sportscoreProvider)) providerSources.push('sportscore');
      }
    } catch (error) {
      logger.warn(`SportScore search failed for "${rawQuery}": ${error.message}`);
    }
  }

  const provider = sportscoreProvider;
  const usedProvider = hasMatches(provider);

  const teams = mergeUnique(provider.teams, fallback.teams, ['name']).slice(0, 10);
  const players = mergeUnique(provider.players, fallback.players, ['name']).slice(0, 10);
  const leagues = mergeUnique(provider.leagues || [], fallback.leagues, ['name']).slice(0, 8);

  return {
    teams,
    players,
    leagues,
    matches: [],
    source: usedProvider ? `sportscore+local-fallback` : 'local-fallback'
  };
};

exports.CLUBS = CLUBS;
exports.PLAYERS = PLAYERS;
exports.LEAGUES = Object.entries(COMPETITION_SLUGS).map(mapLeague);
