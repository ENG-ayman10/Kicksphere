const SUPPORTED_COMPETITIONS = new Set([
  'PL',
  'PD',
  'SA',
  'BL1',
  'FL1',
  'CL',
  'PPL',
  'ELC',
  'DED',
  'BSA',
  'EC',
  'WC'
]);

const toText = (value, fallback = '') => {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
};

const toId = (value) => {
  const text = toText(value);
  return text || null;
};

const toNumberOrNull = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const LEAGUE_ALIAS_MAP = {
  // Football-Data IDs
  '2021': 'PL',
  '2014': 'PD',
  '2019': 'SA',
  '2002': 'BL1',
  '2015': 'FL1',
  '2001': 'CL',
  '2016': 'ELC',
  '2017': 'PPL',
  '2003': 'DED',
  '2013': 'BSA',
  '2018': 'EC',
  '2000': 'WC',

  // TheSports / SportScore IDs
  '4328': 'PL',
  '4335': 'PD',
  '4332': 'SA',
  '4331': 'BL1',
  '4334': 'FL1',
  '4480': 'CL',
  '4329': 'ELC',
  '4337': 'PPL',
  '4344': 'DED',
  '4351': 'BSA',

  // Names and slugs
  'premier league': 'PL',
  'premierleague': 'PL',
  'premier': 'PL',
  'epl': 'PL',
  'england': 'PL',
  'la liga': 'PD',
  'laliga': 'PD',
  'spain': 'PD',
  'primera division': 'PD',
  'serie a': 'SA',
  'seriea': 'SA',
  'italy': 'SA',
  'bundesliga': 'BL1',
  'germany': 'BL1',
  'ligue 1': 'FL1',
  'ligue1': 'FL1',
  'france': 'FL1',
  'champions league': 'CL',
  'uefa champions league': 'CL',
  'ucl': 'CL',
  'championship': 'ELC',
  'primeira liga': 'PPL',
  'portugal': 'PPL',
  'eredivisie': 'DED',
  'netherlands': 'DED',
  'brasileirao': 'BSA',
  'brasileirão': 'BSA',
  'brazil': 'BSA',
  'euro': 'EC',
  'european championship': 'EC',
  'world cup': 'WC',
  'fifa world cup': 'WC'
};

const normalizeCompetitionCode = (value, fallback = null) => {
  if (!value) return fallback;
  const raw = toText(value).trim().toLowerCase();

  if (LEAGUE_ALIAS_MAP[raw]) {
    return LEAGUE_ALIAS_MAP[raw];
  }

  const upper = raw.toUpperCase();
  if (SUPPORTED_COMPETITIONS.has(upper)) {
    return upper;
  }

  // Partial match search
  for (const [alias, target] of Object.entries(LEAGUE_ALIAS_MAP)) {
    if (raw.length >= 3 && (raw.includes(alias) || alias.includes(raw))) {
      return target;
    }
  }

  return fallback;
};

const normalizeLimit = (value, fallback = 20, max = 100) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
};

const normalizeDateSelector = (value = 'TODAY') => {
  const text = toText(value, 'TODAY').toUpperCase();
  if (['TODAY', 'YESTERDAY', 'TOMORROW'].includes(text)) {
    return text;
  }

  const raw = toText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().split('T')[0] === raw) {
      return raw;
    }
  }

  return null;
};

const normalizeCompetition = (competition = {}, area = {}) => ({
  code: toText(competition.code || competition.id),
  name: toText(competition.name),
  emblem: toText(competition.emblem || competition.logo),
  country: toText(area.name || competition.country),
  countryFlag: toText(area.flag || competition.countryFlag)
});

const normalizeTeam = (team = {}) => ({
  id: toId(team.id),
  name: toText(team.shortName || team.name, 'Unknown'),
  fullName: toText(team.name || team.shortName, 'Unknown'),
  crest: toText(team.crest || team.logo || team.image),
  logo: toText(team.logo || team.crest || team.image)
});

const normalizeScore = (score = {}) => ({
  winner: score.winner || null,
  fullTime: {
    home: toNumberOrNull(score.fullTime?.home),
    away: toNumberOrNull(score.fullTime?.away)
  },
  halfTime: {
    home: toNumberOrNull(score.halfTime?.home),
    away: toNumberOrNull(score.halfTime?.away)
  }
});

const normalizeFootballDataMatch = (match = {}) => {
  const competition = normalizeCompetition(match.competition, match.area);
  const homeTeam = normalizeTeam(match.homeTeam);
  const awayTeam = normalizeTeam(match.awayTeam);
  const score = normalizeScore(match.score);

  return {
    id: toId(match.id),
    utcDate: match.utcDate || null,
    status: toText(match.status, 'UNKNOWN'),
    matchday: match.matchday || null,
    stage: match.stage || null,
    minute: match.minute || null,
    league: competition.name,
    leagueId: competition.code,
    homeScore: score.fullTime.home,
    awayScore: score.fullTime.away,
    competition,
    homeTeam,
    awayTeam,
    score
  };
};

const normalizePlayerListItem = (player = {}) => ({
  id: toId(player.id),
  name: toText(player.name, 'Unknown'),
  position: toText(player.position),
  shirtNumber: player.shirtNumber || player.jerseyNumber || null
});

const normalizeFootballDataMatchDetails = (payload = {}) => {
  const match = payload.match || payload;
  const normalized = normalizeFootballDataMatch(match);

  return {
    ...normalized,
    venue: match.venue || null,
    attendance: match.attendance || null,
    homeTeam: {
      ...normalized.homeTeam,
      coach: match.homeTeam?.coach?.name || null,
      formation: match.homeTeam?.formation || null,
      lineup: (match.homeTeam?.lineup || []).map(normalizePlayerListItem),
      bench: (match.homeTeam?.bench || []).map(normalizePlayerListItem)
    },
    awayTeam: {
      ...normalized.awayTeam,
      coach: match.awayTeam?.coach?.name || null,
      formation: match.awayTeam?.formation || null,
      lineup: (match.awayTeam?.lineup || []).map(normalizePlayerListItem),
      bench: (match.awayTeam?.bench || []).map(normalizePlayerListItem)
    },
    goals: (match.goals || []).map(goal => ({
      minute: goal.minute,
      type: goal.type,
      team: toText(goal.team?.name),
      scorer: toText(goal.scorer?.name),
      assist: goal.assist?.name || null
    })),
    bookings: (match.bookings || []).map(booking => ({
      minute: booking.minute,
      team: toText(booking.team?.name),
      player: toText(booking.player?.name),
      card: booking.card
    })),
    substitutions: (match.substitutions || []).map(substitution => ({
      minute: substitution.minute,
      team: toText(substitution.team?.name),
      playerIn: toText(substitution.playerIn?.name),
      playerOut: toText(substitution.playerOut?.name)
    })),
    referees: (match.referees || []).map(referee => ({
      name: referee.name,
      type: referee.type,
      nationality: referee.nationality
    })),
    head2head: payload.head2head || match.head2head || null
  };
};

const normalizeFootballDataStanding = (row = {}) => ({
  rank: row.position || 0,
  name: row.team?.shortName || row.team?.name || 'Unknown',
  logo: row.team?.crest || '',
  teamId: toId(row.team?.id),
  played: row.playedGames || 0,
  won: row.won || 0,
  drawn: row.draw || 0,
  lost: row.lost || 0,
  gf: row.goalsFor || 0,
  ga: row.goalsAgainst || 0,
  gd: row.goalDifference || 0,
  points: row.points || 0
});

const normalizeFootballDataScorer = (scorer = {}, index = 0) => ({
  rank: index + 1,
  name: scorer.player?.name || 'Unknown',
  playerId: toId(scorer.player?.id),
  nationality: scorer.player?.nationality || '',
  team: scorer.team?.shortName || scorer.team?.name || '',
  teamLogo: scorer.team?.crest || '',
  goals: scorer.goals || 0,
  assists: scorer.assists || 0,
  penalties: scorer.penalties || 0,
  matches: scorer.playedMatches || 0
});

const normalizeLineupPlayers = (lineups = {}, match = {}) => {
  const homeName = match.homeTeam?.name || match.homeTeam?.fullName || 'Home';
  const awayName = match.awayTeam?.name || match.awayTeam?.fullName || 'Away';

  const mapPlayer = (player, team, teamId) => ({
    id: toId(player.id),
    name: player.name || 'Unknown',
    position: player.position || 'Unknown',
    shirtNumber: player.shirtNumber || null,
    team,
    teamId: toId(teamId)
  });

  return [
    ...(lineups.home || []).map(player => mapPlayer(player, homeName, match.homeTeam?.id)),
    ...(lineups.away || []).map(player => mapPlayer(player, awayName, match.awayTeam?.id))
  ];
};

module.exports = {
  SUPPORTED_COMPETITIONS,
  normalizeCompetitionCode,
  normalizeDateSelector,
  normalizeFootballDataMatch,
  normalizeFootballDataMatchDetails,
  normalizeFootballDataScorer,
  normalizeFootballDataStanding,
  normalizeLimit,
  normalizeLineupPlayers
};
