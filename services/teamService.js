/**
 * @file teamService.js
 * @description Compatibility facade for public team routes.
 */

const sportscoreService = require('./sportscoreService');
const kickoffApiService = require('./kickoffApiService');
const { CLUBS } = require('./searchService');
const { normalizeCompetitionCode } = require('../utils/sportsContracts');

const normalizeText = (value) => String(value || '').trim().toLowerCase();

const localTeams = () => Object.entries(CLUBS).map(([name, data]) => ({
  id: data.id,
  targetId: name,
  provider: 'sportscore',
  providerId: data.id,
  name,
  shortName: name,
  league: data.league,
  leagueCode: data.leagueCode,
  country: data.country,
  logo: data.logo,
  crest: data.logo
}));

const resolveLocalTeam = (idOrName) => {
  const needle = normalizeText(idOrName);
  if (!needle) return null;

  return localTeams().find(team => (
    normalizeText(team.id) === needle ||
    normalizeText(team.providerId) === needle ||
    normalizeText(team.targetId) === needle ||
    normalizeText(team.name) === needle ||
    normalizeText(team.shortName) === needle
  )) || null;
};

const serviceResult = (data, source = 'sportscore') => ({
  success: true,
  source,
  data
});

exports.getTeamsService = async (competitionCode) => {
  let teams = localTeams();

  if (competitionCode) {
    const leagueCode = normalizeCompetitionCode(competitionCode, '');
    if (!leagueCode) {
      return { success: false, statusCode: 400, message: 'Unsupported league code' };
    }
    teams = teams.filter(team => team.leagueCode === leagueCode);
  }

  return serviceResult(teams);
};

exports.getTeamByIdService = async (idOrName) => {
  // Prefer stable app-facing ids/names before provider lookup because numeric
  // ids can be ambiguous outside our own compatibility contract.
  const localTeam = resolveLocalTeam(idOrName);
  if (localTeam) return serviceResult(localTeam, 'local');

  // Try KickOff API first for rich team details (HD images)
  try {
    const koTeam = await kickoffApiService.getTeamDetails(idOrName);
    if (koTeam) return serviceResult(koTeam, 'kickoffapi');
  } catch (_) {}

  // Try SportScore API fallback
  try {
    const scTeam = await sportscoreService.getTeamDetails(idOrName);
    if (scTeam?.info) return serviceResult(scTeam.info, 'sportscore');
  } catch (_) {}

  return { success: false, statusCode: 404, message: 'Team not found' };
};

exports.getTeamMatchesService = async (idOrName) => {
  const localTeam = resolveLocalTeam(idOrName);
  const lookup = localTeam?.name || idOrName;

  // Try SportScore API
  try {
    const scTeam = await sportscoreService.getTeamDetails(lookup);
    if (scTeam?.matches && (scTeam.matches.recent?.length || scTeam.matches.upcoming?.length)) {
      return serviceResult(scTeam.matches, 'sportscore');
    }
  } catch (_) {}

  return serviceResult({ recent: [], upcoming: [] }, 'empty');
};

exports.getTeamSquadService = async (idOrName) => {
  const localTeam = resolveLocalTeam(idOrName);
  const lookup = localTeam?.name || idOrName;

  // Try KickOff API first for complete squad lists and player images
  try {
    const koSquad = await kickoffApiService.getTeamSquad(lookup);
    if (koSquad && koSquad.length > 0) {
      return serviceResult(koSquad, 'kickoffapi');
    }
  } catch (_) {}

  // Try SportScore API fallback
  try {
    const scTeam = await sportscoreService.getTeamDetails(lookup);
    if (scTeam?.squad && scTeam.squad.length > 0) {
      return serviceResult(scTeam.squad, 'sportscore');
    }
  } catch (_) {}

  return serviceResult([], 'empty');
};

exports.resolveLocalTeam = resolveLocalTeam;
