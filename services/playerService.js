const crypto = require('crypto');
const sportsDataService = require('./sportsDataService');
const { getTeamSquadService } = require('./teamService');
const {
  normalizeCompetitionCode,
  normalizeLimit,
} = require('../utils/sportsContracts');
const logger = require('../utils/logger');

const normalizeText = (value) => String(value || '').trim();

const stableKey = (...parts) => crypto
  .createHash('sha1')
  .update(parts.map(part => normalizeText(part).toLowerCase()).filter(Boolean).join('|'))
  .digest('hex');

const normalizeTeamFromStanding = (row = {}) => {
  const team = row.team || row;
  return {
    id: normalizeText(team.id || team.teamId || row.teamId || row.id),
    name: normalizeText(team.name || team.shortName || row.name),
    logo: normalizeText(team.crest || team.logo || row.logo),
  };
};

const normalizeSquadPlayer = (player = {}, team = {}, leagueCode = '') => {
  const name = normalizeText(player.name || player.fullName || player.shortName);
  if (!name) return null;

  const id = normalizeText(player.id || player.playerId || player.providerId);
  const teamName = normalizeText(player.team || team.name);
  const teamId = normalizeText(player.teamId || team.id);

  return {
    key: stableKey(id || name, teamId || teamName, leagueCode),
    externalId: id || null,
    name,
    fullName: normalizeText(player.fullName || name),
    shortName: normalizeText(player.shortName || name),
    position: normalizeText(player.position),
    team: teamName,
    teamId: teamId || null,
    teamLogo: normalizeText(player.teamBadge || player.teamLogo || team.logo),
    shirtNumber: player.jerseyNumber ?? player.shirtNumber ?? player.number ?? null,
    country: normalizeText(player.country || player.nationality),
    nationality: normalizeText(player.nationality || player.country),
    dateBorn: normalizeText(player.dateBorn || player.dateOfBirth),
    image: normalizeText(player.image || player.photo),
    leagueCode,
    source: normalizeText(player.source || 'provider-squad'),
  };
};

const uniquePlayers = (players = []) => {
  const seen = new Set();
  const result = [];

  for (const player of players) {
    if (!player?.key || seen.has(player.key)) continue;
    seen.add(player.key);
    result.push(player);
  }

  return result;
};

const fetchLeagueSquads = async (leagueCode, teamLimit) => {
  const standingsResult = await sportsDataService.getStandings(leagueCode);
  if (!standingsResult.success || !Array.isArray(standingsResult.data)) {
    return [];
  }

  const teams = standingsResult.data
    .map(normalizeTeamFromStanding)
    .filter(team => team.name || team.id)
    .slice(0, teamLimit);

  const players = [];

  for (const team of teams) {
    try {
      const squadResult = await getTeamSquadService(team.name || team.id);
      const squad = Array.isArray(squadResult.data) ? squadResult.data : [];
      players.push(
        ...squad
          .map(player => normalizeSquadPlayer(player, team, leagueCode))
          .filter(Boolean)
      );
    } catch (error) {
      logger.warn(`Player squad sync skipped ${team.name || team.id}: ${error.message}`);
    }
  }

  return players;
};

exports.fetchPlayersFromAPI = async (options = {}) => {
  try {
    const supported = sportsDataService.getSupportedCompetitions().map(competition => competition.code);
    const requestedLeagues = normalizeText(options.league || options.competition || '')
      .split(',')
      .map(code => normalizeCompetitionCode(code.trim()))
      .filter(Boolean);

    const leagues = requestedLeagues.length > 0
      ? requestedLeagues
      : supported;
    const teamLimit = normalizeLimit(options.teamLimit, 20, 80);

    const players = [];
    for (const leagueCode of leagues) {
      players.push(...await fetchLeagueSquads(leagueCode, teamLimit));
    }

    return uniquePlayers(players);
  } catch (error) {
    logger.error(`Players fetch error: ${error.message}`);
    return [];
  }
};
