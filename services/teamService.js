/**
 * @file teamService.js
 * @description Compatibility facade for public team routes.
 */

const sportscoreService = require('./sportscoreService');
const kickoffApiService = require('./kickoffApiService');
const bsdSportsService = require('./bsdSportsService');
const { CLUBS } = require('./searchService');
const { normalizeCompetitionCode } = require('../utils/sportsContracts');
const { scopedTeamId } = require('../utils/teamIdentity');

const normalizeText = (value) => String(value || '').trim().toLowerCase();

// Legacy football-data ID 81 identifies the Spanish FC Barcelona. The generic
// SportScore slug "barcelona" belongs to a different club, so this verified
// compatibility identity must resolve through its explicit KickOff team ID.
const VERIFIED_LEGACY_TEAM_IDS = { '81': 'ko_t_529' };

const localTeams = () => Object.entries(CLUBS).map(([name, data]) => ({
  id: data.id,
  targetId: name,
  provider: 'local',
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

  const found = localTeams().find(team => (
    normalizeText(team.id) === needle ||
    normalizeText(team.providerId) === needle ||
    normalizeText(team.targetId) === needle ||
    normalizeText(team.name) === needle ||
    normalizeText(team.shortName) === needle
  ));
  if (found) return found;

  return null;
};

const resolveProviderTeamLookup = (idOrName) => {
  const id = String(idOrName || '').trim();
  if (scopedTeamId(id)?.startsWith('sc_t_')) return id.slice(5);
  if (VERIFIED_LEGACY_TEAM_IDS[id]) return VERIFIED_LEGACY_TEAM_IDS[id];
  const localTeam = resolveLocalTeam(id);
  return /^\d+$/.test(id) && localTeam ? localTeam.name : id;
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
    if (bsdSportsService.isConfigured?.()) {
      try {
        const provided = await bsdSportsService.getTeams({ competition: leagueCode });
        if (Array.isArray(provided) && provided.coverage?.available !== false) return {
          ...serviceResult(provided, 'bsd'), coverage: provided.coverage || { complete: false },
        };
      } catch (_) {}
    }
    teams = teams.filter(team => team.leagueCode === leagueCode);
  }

  return { ...serviceResult(teams, 'local-catalog'), coverage: { complete: false } };
};

exports.getTeamByIdService = async (idOrName) => {
  const scopedId = scopedTeamId(idOrName);
  if (scopedId?.startsWith('bsd_t_')) {
    try {
      const team = await bsdSportsService.getTeamDetails(scopedId);
      if (team?.info) return serviceResult(team.info, 'bsd');
    } catch (_) {}
    return { success: false, statusCode: 404, message: 'Team not found' };
  }
  if (String(idOrName || '').startsWith('bsd_')) return { success: false, statusCode: 404, message: 'Team not found' };
  if (scopedId?.startsWith('sc_t_')) {
    try {
      const team = await sportscoreService.getTeamDetails(scopedId.slice(5));
      if (team?.info) return serviceResult({ ...team.info, id: scopedId, targetId: scopedId,
        provider: 'sportscore', providerId: scopedId.slice(5) }, 'sportscore');
    } catch (_) {}
    return { success: false, statusCode: 404, message: 'Team not found' };
  }
  // Prefer stable app-facing ids/names before provider lookup because numeric
  // ids can be ambiguous outside our own compatibility contract.
  const localTeam = resolveLocalTeam(idOrName);
  if (localTeam) return serviceResult(localTeam, 'local');
  if (/^\d+$/.test(String(idOrName))) return { success: false, statusCode: 404, message: 'Team provider ID required' };

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
  if (scopedTeamId(idOrName)?.startsWith('bsd_t_')) {
    try {
      const team = await bsdSportsService.getTeamDetails(idOrName);
      if (team?.info) return { ...serviceResult(team.matches || { recent: [], upcoming: [], live: [] }, 'bsd'), coverage: team.coverage };
    } catch (_) {}
    return { success: false, statusCode: 503, message: 'Team fixtures unavailable' };
  }
  if (String(idOrName || '').startsWith('bsd_')) return { success: false, statusCode: 404, message: 'Team not found' };
  const lookup = resolveProviderTeamLookup(idOrName);
  if (/^ko_t_\d+$/.test(lookup)) return serviceResult(await kickoffApiService.getTeamFixtures(lookup), "kickoffapi");
  if (/^\d+$/.test(String(idOrName)) && !resolveLocalTeam(idOrName)) return serviceResult({ recent: [], upcoming: [] }, "unavailable");

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
  if (scopedTeamId(idOrName)?.startsWith('bsd_t_')) {
    try {
      const squad = await bsdSportsService.getTeamSquad(idOrName);
      if (Array.isArray(squad) && squad.coverage?.available !== false) return { ...serviceResult(squad, 'bsd'), coverage: squad.coverage };
    } catch (_) {}
    return { success: false, statusCode: 503, message: 'Team squad unavailable' };
  }
  if (String(idOrName || '').startsWith('bsd_')) return { success: false, statusCode: 404, message: 'Team not found' };
  if (/^\d+$/.test(String(idOrName)) && !resolveLocalTeam(idOrName)) return serviceResult([], "unavailable");
  const lookup = resolveProviderTeamLookup(idOrName);
  if (scopedTeamId(idOrName)?.startsWith('sc_t_')) {
    try {
      const team = await sportscoreService.getTeamDetails(lookup);
      return serviceResult(team?.squad || [], team ? 'sportscore' : 'unavailable');
    } catch (_) { return serviceResult([], 'unavailable'); }
  }

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

  // No static roster is presented as a current squad.
  return serviceResult([], 'empty');
};

exports.resolveLocalTeam = resolveLocalTeam;
exports.resolveProviderTeamLookup = resolveProviderTeamLookup;
