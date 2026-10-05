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

const unavailableCoverage = (source, reason) => ({ source, available: false, complete: false, partial: true, reason });
const reservedTeamId = value => /^(?:bsd_|ko_|sc_)/.test(String(value || '').trim());
const positiveId = value => /^[1-9]\d{0,14}$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const squadCoverage = (rows, source) => rows?.coverage || {
  source, available: Array.isArray(rows), complete: false, partial: true,
  ...(Array.isArray(rows) && rows.length === 0 ? { reason: 'empty_squad' } : {}),
};

exports.getTeamsService = async (competitionCode, options = {}) => {
  let teams = localTeams();
  let leagueCode;
  if (competitionCode) {
    leagueCode = normalizeCompetitionCode(competitionCode, '');
    if (!leagueCode) {
      return { success: false, statusCode: 400, message: 'Unsupported league code' };
    }
    teams = teams.filter(team => team.leagueCode === leagueCode);
  }
  const suppliedSeason = options.seasonId ?? options.season_id ?? options.season;
  let seasonId = suppliedSeason === undefined ? null : positiveId(suppliedSeason);
  if (suppliedSeason !== undefined && (!seasonId || !leagueCode)) return {
    success: false, statusCode: 400, message: 'Valid season and competition required',
  };
  const name = typeof options.name === 'string' ? options.name.trim().slice(0, 100) : '';
  if (bsdSportsService.isConfigured?.()) {
    try {
      if (leagueCode && !seasonId && typeof bsdSportsService.getLeagueDetails === 'function') {
        const league = await bsdSportsService.getLeagueDetails(leagueCode);
        seasonId = positiveId(league?.currentSeason?.id);
      }
      const provided = await bsdSportsService.getTeams({
        ...(leagueCode ? { competition: leagueCode, in_competition: true } : {}),
        ...(seasonId ? { seasonId } : {}), ...(name ? { name } : {}),
      });
      if (Array.isArray(provided) && provided.coverage?.available !== false) {
        const coverage = provided.coverage || { available: true, complete: false, partial: true };
        const unknownSeason = Boolean(leagueCode && !seasonId);
        return { ...serviceResult(provided, 'bsd'), coverage: {
          ...coverage, scope: leagueCode ? 'competition_season_teams' : 'provider_team_catalog',
          ...(leagueCode ? { competitionCode: leagueCode, seasonId } : {}),
          ...(unknownSeason ? { complete: false, partial: true, reason: 'season_unknown' } : {}),
        } };
      }
    } catch (_) {}
  }
  // The bundled shortlist cannot represent a historical season or BSD-only
  // tournament when its provider is unavailable.
  if (suppliedSeason !== undefined || /^BSD:/.test(leagueCode || '')) return {
    success: false, statusCode: 503, source: 'bsd', message: 'Team catalog unavailable',
    coverage: unavailableCoverage('bsd', 'provider_unavailable'), data: [],
  };
  if (name) teams = teams.filter(team => normalizeText(team.name).includes(normalizeText(name)));
  return { ...serviceResult(teams, 'local-catalog'), coverage: {
    source: 'local-catalog', available: true, complete: false, partial: true, reason: 'local_shortlist',
  } };
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
      if (team?.info && [scopedId, scopedId.slice(5)].includes(String(team.info.id))) return serviceResult({ ...team.info, id: scopedId, targetId: scopedId,
        provider: 'sportscore', providerId: scopedId.slice(5) }, 'sportscore');
    } catch (_) {}
    return { success: false, statusCode: 404, message: 'Team not found' };
  }
  if (scopedId?.startsWith('ko_t_')) {
    try {
      const team = await kickoffApiService.getTeamDetails(scopedId);
      if (team && scopedTeamId(team.id || team.providerId, 'kickoffapi') === scopedId) return serviceResult(team, 'kickoffapi');
    } catch (_) {}
    return { success: false, statusCode: 404, message: 'Team not found' };
  }
  if (reservedTeamId(idOrName)) return { success: false, statusCode: 404, message: 'Team not found' };
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
  if (reservedTeamId(idOrName) && !scopedTeamId(idOrName)) return { success: false, statusCode: 404, message: 'Team not found' };
  const lookup = resolveProviderTeamLookup(idOrName);
  if (/^ko_t_\d+$/.test(lookup)) {
    try {
      const fixtures = await kickoffApiService.getTeamFixtures(lookup);
      if (fixtures) return { ...serviceResult(fixtures, 'kickoffapi'), coverage: fixtures.coverage || {
        source: 'kickoffapi', available: true, complete: false, partial: true,
      } };
    } catch (_) {}
    return { success: false, statusCode: 503, source: 'kickoffapi', message: 'Team fixtures unavailable',
      coverage: unavailableCoverage('kickoffapi', 'provider_unavailable') };
  }
  if (/^\d+$/.test(String(idOrName)) && !resolveLocalTeam(idOrName)) return serviceResult({ recent: [], upcoming: [] }, "unavailable");

  // Try SportScore API
  try {
    const scTeam = await sportscoreService.getTeamDetails(lookup);
    if (scTeam?.matches && (!scopedTeamId(idOrName)?.startsWith('sc_t_') || [String(idOrName).trim(), lookup].includes(String(scTeam.info?.id)))) {
      return { ...serviceResult(scTeam.matches, 'sportscore'), coverage: scTeam.coverage?.fixtures || {
        source: 'sportscore', available: true, complete: false, partial: true,
      } };
    }
  } catch (_) {}

  return { ...serviceResult({ recent: [], upcoming: [] }, 'empty'), coverage: unavailableCoverage('sportscore', 'provider_unavailable') };
};

exports.getTeamSquadService = async (idOrName) => {
  if (scopedTeamId(idOrName)?.startsWith('bsd_t_')) {
    try {
      const squad = await bsdSportsService.getTeamSquad(idOrName);
      if (Array.isArray(squad) && squad.coverage?.available !== false) return { ...serviceResult(squad, 'bsd'), coverage: squad.coverage };
    } catch (_) {}
    return { success: false, statusCode: 503, message: 'Team squad unavailable' };
  }
  if (reservedTeamId(idOrName) && !scopedTeamId(idOrName)) return { success: false, statusCode: 404, message: 'Team not found' };
  if (/^\d+$/.test(String(idOrName)) && !resolveLocalTeam(idOrName)) return serviceResult([], "unavailable");
  const lookup = resolveProviderTeamLookup(idOrName);
  if (/^ko_t_[1-9]\d*$/.test(lookup)) {
    try {
      const squad = await kickoffApiService.getTeamSquad(lookup);
      if (Array.isArray(squad)) return { ...serviceResult(squad, 'kickoffapi'), coverage: squadCoverage(squad, 'kickoffapi') };
    } catch (_) {}
    return { success: false, statusCode: 503, source: 'kickoffapi', message: 'Team squad unavailable',
      coverage: unavailableCoverage('kickoffapi', 'provider_unavailable') };
  }
  if (scopedTeamId(idOrName)?.startsWith('sc_t_')) {
    try {
      const team = await sportscoreService.getTeamDetails(lookup);
      if (team && [String(idOrName).trim(), lookup].includes(String(team.info?.id)) && Array.isArray(team.squad)) return {
        ...serviceResult(team.squad, 'sportscore'), coverage: team.coverage?.squad || squadCoverage(team.squad, 'sportscore'),
      };
      return { ...serviceResult([], 'unavailable'), coverage: unavailableCoverage('sportscore', 'provider_squad_unavailable') };
    } catch (_) { return { ...serviceResult([], 'unavailable'), coverage: unavailableCoverage('sportscore', 'provider_unavailable') }; }
  }

  // Try KickOff API first for complete squad lists and player images
  try {
    const koSquad = await kickoffApiService.getTeamSquad(lookup);
    if (koSquad && koSquad.length > 0) {
      return { ...serviceResult(koSquad, 'kickoffapi'), coverage: squadCoverage(koSquad, 'kickoffapi') };
    }
  } catch (_) {}

  // Try SportScore API fallback
  try {
    const scTeam = await sportscoreService.getTeamDetails(lookup);
    if (scTeam?.squad && scTeam.squad.length > 0) {
      return { ...serviceResult(scTeam.squad, 'sportscore'), coverage: scTeam.coverage?.squad || squadCoverage(scTeam.squad, 'sportscore') };
    }
  } catch (_) {}

  // No static roster is presented as a current squad.
  return { ...serviceResult([], 'empty'), coverage: unavailableCoverage('unavailable', 'provider_squad_unavailable') };
};

exports.resolveLocalTeam = resolveLocalTeam;
exports.resolveProviderTeamLookup = resolveProviderTeamLookup;
