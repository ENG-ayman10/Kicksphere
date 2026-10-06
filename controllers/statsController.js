/**
 * @file statsController.js
 * @description Stats endpoints — SportScore primary with robust fallbacks.
 */

const sportscoreService = require('../services/sportscoreService');
const sportsDataService = require('../services/sportsDataService');
const kickoffApiService = require('../services/kickoffApiService');
const bsdSportsService = require('../services/bsdSportsService');
const { resolveLocalTeam, resolveProviderTeamLookup, getTeamMatchesService } = require('../services/teamService');
const { getCached, setCache } = require('../services/cacheService');
const logger = require('../utils/logger');
const { scopedTeamId } = require('../utils/teamIdentity');
const { validatedProviderIdentities } = require('../utils/matchProviderIdentities');
const { filterPresentedTimeline } = require('../utils/matchTimelineTiming');
const { validateLineupIntegrity } = require('../utils/lineupIntegrity');

const serverError = (res) => res.status(500).json({ success: false, message: 'Server Error' });

const hasItems = (value) => Array.isArray(value) && value.length > 0;

const isPresent = (value) => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

const mergePresent = (...objects) => objects.reduce((merged, object) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return merged;

  for (const [key, value] of Object.entries(object)) {
    if (isPresent(value)) merged[key] = value;
  }

  return merged;
}, {});

const firstNonEmptyArray = (...values) => values.find(hasItems) || [];

const longestArray = (...values) => values
  .filter(hasItems)
  .sort((a, b) => b.length - a.length)[0] || [];

const mergeMatches = (...sources) => ({
  recent: firstNonEmptyArray(...sources.map(source => source?.recent)),
  upcoming: firstNonEmptyArray(...sources.map(source => source?.upcoming)),
});

const callProvider = async (label, fn) => {
  try {
    return await fn();
  } catch (error) {
    logger.warn(`${label} failed: ${error.message}`);
    return null;
  }
};

const normalizeTeamInfo = (localTeam, ...providerInfos) => {
  const provided = providerInfos.filter(value => value && value.name);
  // Static aliases cannot override the name, ID, country, or league of a
  // provider entity. This matters for namesakes such as Barcelona clubs.
  const info = provided.length ? mergePresent(...provided) : mergePresent(localTeam || {});
  if (!info.manager && info.coach) info.manager = info.coach;
  if (!info.coach && info.manager) info.coach = info.manager;
  return info;
};

const toNumberOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const unixSecondsToDate = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return new Date(numeric * 1000).toISOString().split('T')[0];
};

const eventBelongsToSide = (event, side, teamNames = []) => {
  const eventSide = String(event?.side || '').toLowerCase();
  if (eventSide === side) return true;

  const team = String(event?.team || '').trim().toLowerCase();
  return Boolean(team) && teamNames.some(name => String(name || '').trim().toLowerCase() === team);
};

const hydrateTimelineTeams = (timeline = [], matchInfo = {}) => filterPresentedTimeline(timeline, matchInfo).map(event => {
  if (event?.team) return event;

  const side = String(event?.side || '').toLowerCase();
  const team = side === 'home'
    ? matchInfo?.homeTeam?.name
    : (side === 'away' ? matchInfo?.awayTeam?.name : '');

  return {
    ...event,
    team: team || ''
  };
});

const buildBasicMatchStatistics = (matchInfo = {}, goals = [], bookings = [], substitutions = []) => {
  // Event feeds can be partial. Unknown totals stay unknown unless the provider
  // explicitly confirms complete incident coverage; a missing list is not zero.
  const timeline = Array.isArray(matchInfo.timeline) ? matchInfo.timeline : [];
  const allBookings = hasItems(bookings) ? bookings : timeline.filter(e => ['yellow_card', 'red_card'].includes(e?.type));
  const allSubs = hasItems(substitutions) ? substitutions : timeline.filter(e => e?.type === 'substitution');
  const complete = matchInfo.incidentsComplete === true;
  const countFor = (events, side, predicate = () => true) => complete ? events.filter(e =>
    predicate(e) && eventBelongsToSide(e, side, [matchInfo[side + 'Team']?.name, matchInfo[side + 'Team']?.shortName])
  ).length : null;
  const stats = Array.isArray(matchInfo.providerStatistics) ? matchInfo.providerStatistics : [];
  const label = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const read = (names, side) => {
    const row = stats.find(s => names.some(name => label(s.label || s.name) === label(name)));
    if (!row) return null;
    const value = row[side];
    if (typeof value === 'string' && /^-?\d+(?:\.\d+)?%$/.test(value.trim())) return toNumberOrNull(value.trim().slice(0,-1));
    return toNumberOrNull(value);
  };
  const sideStats = side => {
    const yellow = read(['Yellow Cards'], side) ?? countFor(allBookings, side, e => !['RED','RED_CARD'].includes(String(e.card || e.type || '').toUpperCase()));
    const red = read(['Red Cards'], side) ?? countFor(allBookings, side, e => ['RED','RED_CARD'].includes(String(e.card || e.type || '').toUpperCase()));
    const onTarget = read(['Shots on Target', 'Shots on Goal'], side);
    const offTarget = read(['Shots off Target', 'Shots off Goal'], side);
    const possession = read(['Ball Possession', 'Possession'], side);
    return {
      ballPossession: possession,
      ballPossessionText: possession === null ? null : String(possession) + '%',
      expectedGoals: read(['Expected Goals (xG)', 'Expected Goals', 'xG'], side),
      totalShots: read(['Total Shots', 'Shots Total'], side) ?? (onTarget !== null && offTarget !== null ? onTarget + offTarget : null),
      shotsOnTarget: onTarget,
      bigChances: read(['Big Chances'], side),
      corners: read(['Corner Kicks', 'Corners'], side),
      offsides: read(['Offsides'], side),
      passesTotal: read(['Passes', 'Total Passes'], side),
      passesAccuracy: read(['Pass Accuracy', 'Passes Accuracy', 'Pass Accuracy %'], side),
      tackles: read(['Tackles', 'Total Tackles'], side),
      interceptions: read(['Interceptions'], side),
      saves: read(['Total Saves', 'Goalkeeper Saves', 'Saves'], side),
      fouls: read(['Fouls'], side),
      yellowCards: yellow,
      redCards: red
    };
  };
  const home = sideStats('home'), away = sideStats('away');
  const homeScore = toNumberOrNull(matchInfo.score?.fullTime?.home ?? matchInfo.homeScore);
  const awayScore = toNumberOrNull(matchInfo.score?.fullTime?.away ?? matchInfo.awayScore);
  return {
    goals: { home: homeScore, away: awayScore },
    yellowCards: { home: home.yellowCards, away: away.yellowCards },
    redCards: { home: home.redCards, away: away.redCards },
    substitutions: { home: countFor(allSubs, 'home'), away: countFor(allSubs, 'away') },
    halfTimeScore: { home: toNumberOrNull(matchInfo.score?.halfTime?.home), away: toNumberOrNull(matchInfo.score?.halfTime?.away) },
    fullTimeScore: { home: homeScore, away: awayScore },
    hasAdvancedStats: Object.values(home).some(isPresent) || Object.values(away).some(isPresent),
    team1: home,
    team2: away
  };
};

const headToHeadForMatch = (raw, match) => {
  if (!raw) return null;
  if (!Array.isArray(raw)) return typeof raw === 'object' ? raw : null;
  const homeId = match.homeTeam?.id, awayId = match.awayTeam?.id;
  const finished = raw.filter(row => row?.status === 'FINISHED' && row.id !== match.id &&
    homeId && awayId && ((row.homeTeam?.id === homeId && row.awayTeam?.id === awayId) ||
      (row.homeTeam?.id === awayId && row.awayTeam?.id === homeId)) &&
    toNumberOrNull(row.score?.fullTime?.home) !== null && toNumberOrNull(row.score?.fullTime?.away) !== null);
  let homeWins = 0, awayWins = 0, draws = 0;
  for (const row of finished) {
    const home = Number(row.score.fullTime.home), away = Number(row.score.fullTime.away);
    if (home === away) draws++;
    else if ((home > away && row.homeTeam.id === homeId) || (away > home && row.awayTeam.id === homeId)) homeWins++;
    else awayWins++;
  }
  return { matches: raw, numberOfMatches: finished.length, homeTeam: { id: homeId, wins: homeWins, draws },
    awayTeam: { id: awayId, wins: awayWins, draws }, scope: 'returnedFinishedFixtures', complete: raw.coverage?.complete === true };
};

const buildBsdDeepMatch = (details, prediction) => {
  const matchInfo = { ...details.matchInfo,
    providerStatistics: Array.isArray(details.statistics) ? details.statistics : details.matchInfo.providerStatistics || [],
    venue: details.matchInfo.venue && typeof details.matchInfo.venue === 'object'
      ? details.matchInfo.venue.name || null : details.matchInfo.venue,
    venueInfo: details.venue || details.matchInfo.venueInfo || null,
  };
  const timeline = hydrateTimelineTeams(details.timeline || details.incidents || [], matchInfo);
  const goals = timeline.filter(event => event.type === 'goal').map(event => ({ ...event,
    scorer: event.player || '', type: event.label || 'Goal' }));
  const bookings = timeline.filter(event => event.rescinded !== true && ['yellow_card', 'red_card'].includes(event.type)).map(event => ({ ...event,
    card: event.type === 'red_card' ? 'RED' : 'YELLOW' }));
  const substitutions = timeline.filter(event => event.type === 'substitution');
  const statistics = details.statistics?.team1 ? details.statistics : buildBasicMatchStatistics(matchInfo, goals, bookings, substitutions);
  const xgRow = matchInfo.providerStatistics.find(row => /xg|expected goals/i.test(row.label || row.name || ''));
  const sideFlags = ['home', 'away'].map(side => matchInfo.xg?.[side + 'Estimated'] ?? xgRow?.[side + 'Estimated']);
  // A single estimated shot does not make two explicitly measured team totals estimates.
  const teamXgEstimated = sideFlags.some(flag => flag === true) ||
    (sideFlags.some(flag => typeof flag !== 'boolean') &&
      (xgRow?.estimated === true || details.xgEstimated === true || matchInfo.xg?.estimated === true));
  Object.assign(statistics, { xgEstimated: teamXgEstimated,
    xgClassification: teamXgEstimated ? 'estimated' : sideFlags.every(flag => flag === false) ? 'actual' : 'unknown' });
  for (const [side, key] of [['home', 'team1'], ['away', 'team2']]) {
    const flag = matchInfo.xg?.[side + 'Estimated'] ?? xgRow?.[side + 'Estimated'];
    if (typeof flag === 'boolean' && statistics[key]) Object.assign(statistics[key], {
      xgEstimated: flag, expectedGoalsEstimated: flag,
    });
  }
  const head2head = headToHeadForMatch(details.h2h || details.head2head, matchInfo);
  matchInfo.head2head = head2head;
  return { matchInfo, timeline, goals, bookings, substitutions, statistics,
    providerStatistics: matchInfo.providerStatistics, lineups: details.lineups || matchInfo.lineups || null,
    playerStatistics: details.playerStatistics || [], head2head,
    shotMap: details.shotMap || details.shotmap || details.shots || null,
    pressure: details.pressure || details.momentum || null,
    momentum: details.momentum || [], averagePositions: details.averagePositions || null,
    xgEstimated: teamXgEstimated, shotMapEstimated: details.xgEstimated === true,
    tracker: details.tracker || null, prediction: prediction || null,
    aiPreview: details.aiPreview || null, venue: matchInfo.venue || null, venueInfo: details.venue || null,
    coaches: { home: details.homeCoach || null, away: details.awayCoach || null },
    availability: details.availability || {}, coverage: details.coverage || {},
    source: 'bsd' };
};

// ==========================================
// 📊 GET TOP PLAYERS (Scorers & Assists)
// ==========================================
exports.getTopPlayers = async (req, res) => {
  try {
    const stat = req.query.stat === 'assists' ? 'assists' : 'goals';
    const result = await sportsDataService.getTopScorers(req.query.league, req.query.limit, stat);

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.message,
        source: result.source,
        coverage: result.coverage,
        data: result.data || []
      });
    }

    res.json({ success: true, source: result.source, coverage: result.coverage, data: result.data });
  } catch (error) {
    logger.error(`❌ TOP PLAYERS ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// 📊 GET STANDINGS
// ==========================================
exports.getTopTeams = async (req, res) => {
  try {
    const result = await sportsDataService.getStandings(req.query.league);

    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        message: result.message,
        source: result.source,
        coverage: result.coverage,
        data: result.data || []
      });
    }

    res.json({ success: true, source: result.source, coverage: result.coverage, data: result.data });
  } catch (error) {
    logger.error(`❌ STANDINGS ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// 📊 GET LEAGUES
// ==========================================
exports.getLeaguesStandings = async (req, res) => {
  try {
    const leagues = await sportsDataService.getCompetitionCatalog();
    res.json({ success: true, source: leagues.source || 'supported-contract',
      coverage: leagues.coverage, data: leagues });
  } catch (error) {
    logger.error(`❌ LEAGUES ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// ⏱️ GET MATCH TIMELINE (goals, cards, subs from match details)
// ==========================================
exports.getMatchTimeline = async (req, res) => {
  try {
    const { id } = req.params;

    if (/^bsd_[1-9]\d*$/.test(String(id))) {
      const details = await callProvider('BSD match timeline', () => bsdSportsService.getMatchDetails(id));
      if (!details?.matchInfo) return res.status(404).json({ success: false, message: 'Match not found' });
      if (details.coverage?.fields?.incidents === false) {
        return res.json({ success: true, source: 'unavailable', data: [],
          coverage: { available: false, complete: false, partial: true, reason: 'incidents_unavailable' } });
      }
      return res.json({ success: true, source: 'bsd', coverage: details.coverage,
        data: hydrateTimelineTeams(details.timeline || details.incidents || [], details.matchInfo) });
    }
    if (String(id).startsWith('bsd_')) return res.status(404).json({ success: false, message: 'Match not found' });

    // 1. Try SportScore
    try {
      const scMatch = await sportscoreService.getMatchDetails(id);
      if (scMatch?.detailsAvailable !== false && Array.isArray(scMatch?.timeline) &&
          scMatch.incidentCoverage?.available !== false) {
        return res.json({
          success: true,
          source: 'sportscore',
          coverage: scMatch.incidentCoverage || { available: true, complete: false, partial: true },
          data: hydrateTimelineTeams(scMatch.timeline, scMatch)
        });
      }
    } catch (_) {}

    return res.json({ success: true, source: 'unavailable', data: [],
      coverage: { available: false, complete: false, partial: true, reason: 'incidents_unavailable' } });
  } catch (error) {
    logger.error(`❌ TIMELINE ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// 👥 GET MATCH LINEUPS (Multi-provider with smart slug & team resolution)
// ==========================================
function mapKickoffPlayer(item) {
  const p = item.player || item;
  const name = p.name || [p.firstname,p.lastname].filter(Boolean).join(' ').trim();
  if (!name) return null;
  const id = p.id ? 'ko_p_' + String(p.id) : null;
  const number = p.number ?? null;
  const image = p.photo || item.photo || '';
  return { id, provider: 'kickoffapi', providerId: p.id?.toString() || '', name, image,
    playerName: name, number, position: p.pos || p.position || '', grid: p.grid ?? item.grid ?? null, captain: Boolean(p.captain),
    rating: toNumberOrNull(p.rating), player: { id, name, number, image, provider: 'kickoffapi' } };
}

async function resolveMatchLineups(id) {
  const checked = (source, lineups, match, coverage) => {
    if (!lineups || (lineups.matchId && String(lineups.matchId) !== String(id))) return null;
    const data = validateLineupIntegrity({ ...lineups, matchId: id,
      homeTeamId: match?.homeTeam?.id, awayTeamId: match?.awayTeam?.id },
      { homeTeamId: match?.homeTeam?.id, awayTeamId: match?.awayTeam?.id, provider: source });
    return { source, lineups: data, matchStatus: match?.status,
      coverage: { ...coverage, available: Boolean(data.home?.length || data.away?.length),
        complete: data.integrity.complete, partial: data.integrity.partial, integrity: data.integrity } };
  };
  if (/^bsd_[1-9]\d*$/.test(String(id))) {
    const details = await callProvider('BSD match lineups', () => bsdSportsService.getMatchDetails(id));
    return details?.matchInfo?.id === id ? checked('bsd', details.lineups, details.matchInfo, details.coverage) : null;
  }
  if (String(id).startsWith('bsd_')) return null;
  // The ID must first resolve to a real fixture. Query hints cannot fabricate
  // teams/date or select another meeting between the same clubs.
  const result = await sportsDataService.getMatchDetails(id);
  const match = result?.data;
  if (!match || String(match.id) !== String(id)) return null;
  if (match.lineups && (hasItems(match.lineups.home) || hasItems(match.lineups.away))) {
    return checked(result.source, match.lineups, match, result.coverage);
  }
  const kickoffIdentity = /^ko_[1-9]\d*$/.test(String(id)) && match.id === id
    ? { id, homeTeamId: match.homeTeam?.id, awayTeamId: match.awayTeam?.id }
    : validatedProviderIdentities(match).find(identity => identity.provider === 'kickoffapi');
  const fixtureId = kickoffIdentity ? Number(String(kickoffIdentity.id).slice(3)) : null;
  if (!fixtureId) return null;
  const homeId = scopedTeamId(kickoffIdentity.homeTeamId, 'kickoffapi');
  const awayId = scopedTeamId(kickoffIdentity.awayTeamId, 'kickoffapi');
  if (!homeId?.startsWith('ko_t_') || !awayId?.startsWith('ko_t_') || homeId === awayId) return null;
  const raw = await kickoffApiService.safeFetch('/api/v1/fixtures/lineups', { fixture: fixtureId });
  if (!Array.isArray(raw?.response) || (raw.parameters?.fixture !== undefined && String(raw.parameters.fixture) !== String(fixtureId))) return null;
  const sides = raw.response;
  const sideFor = id => {
    const matches = sides.filter(side => String(side.team?.id) === id.slice(5));
    return matches.length === 1 ? matches[0] : null;
  };
  const home = sideFor(homeId), away = sideFor(awayId);
  const homePlayers = (home?.startXI || []).map(mapKickoffPlayer).filter(Boolean);
  const awayPlayers = (away?.startXI || []).map(mapKickoffPlayer).filter(Boolean);
  if (!homePlayers.length && !awayPlayers.length) return null;
  return checked('kickoffapi', {
    confirmed: homePlayers.length === 11 && awayPlayers.length === 11,
    homeFormation: home?.formation || '', awayFormation: away?.formation || '',
    homeCoach: home?.coach?.name || null, awayCoach: away?.coach?.name || null,
    home: homePlayers, away: awayPlayers,
    homeBench: (home?.substitutes || []).map(mapKickoffPlayer).filter(Boolean),
    awayBench: (away?.substitutes || []).map(mapKickoffPlayer).filter(Boolean)
  }, match);
}

exports.getMatchLineups = async (req, res) => {
  try {
    const { id } = req.params;
    const { home, away, date } = req.query;

    const cacheKey = `lineups:${id}:${date || ''}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        source: `${cached.source}_cached`,
        coverage: cached.coverage,
        data: cached.lineups
      });
    }

    const result = await resolveMatchLineups(id, home, away, date);
    if (result && result.lineups && (result.lineups.home?.length > 0 || result.lineups.away?.length > 0)) {
      // Before and during a game a confirmed list may still be corrected.
      const finished = ['FINISHED', 'FT', 'AET', 'PEN'].includes(String(result.matchStatus || '').toUpperCase());
      const ttl = finished && result.lineups.confirmed ? 15 * 60 * 1000 : result.lineups.confirmed ? 30000 : 15000;
      setCache(cacheKey, result, ttl);

      return res.json({
        success: true,
        source: result.source,
        coverage: result.coverage,
        data: result.lineups
      });
    }

    return res.json({
      success: true,
      source: 'unavailable',
      coverage: { available: false, complete: false, partial: true, reason: 'lineups_unavailable' },
      data: {
        matchId: id,
        message: 'Lineups not available for this match yet',
        formation: { home: '', away: '' },
        home: [],
        away: [],
        homeBench: [],
        awayBench: []
      },
    });
  } catch (error) {
    logger.error(`❌ LINEUPS ERROR: ${error.message}`);
    serverError(res);
  }
};

// ==========================================
// 🚀 DEEP STATS
// ==========================================
exports.getDeepTeamDetails = async (req, res) => {
  try {
    const teamId = String(req.params.id || '').trim();
    if (scopedTeamId(teamId)?.startsWith('bsd_t_')) {
      let team = await callProvider('BSD team details', () => bsdSportsService.getTeamDetails(teamId));
      if (team?.info && String(team.info.id) !== teamId) team = null;
      if (!team?.info || team.coverage?.fixtures?.available === false) {
        const calendar = await callProvider('BSD independent team calendar', () => getTeamMatchesService(teamId));
        const matches = calendar?.data;
        const rows = ['recent', 'upcoming', 'live'].flatMap(section => Array.isArray(matches?.[section]) ? matches[section] : []);
        const fixtureInfo = rows.flatMap(row => [row.homeTeam, row.awayTeam])
          .find(info => String(info?.id) === teamId && String(info.name || '').trim());
        if (calendar?.success === true && calendar.coverage?.available !== false && (team?.info || fixtureInfo)) {
          const profileCoverage = team?.coverage || { source: 'bsd',
            info: { available: true, complete: false, partial: true, reason: 'fixture_identity_only' },
            squad: { available: false, complete: false, partial: true, reason: 'squad_unavailable' } };
          team = { ...(team || {}), info: team?.info || fixtureInfo, matches,
            coverage: { ...profileCoverage, available: true, complete: false, partial: true,
              fixtures: calendar.coverage } };
        }
      }
      if (!team?.info) return res.status(404).json({ success: false, source: 'unavailable',
        coverage: { available: false, complete: false, partial: true, reason: 'provider_entity_unavailable' },
        data: null, message: 'Team details not found' });
      return res.json({ success: true, source: 'bsd', coverage: team.coverage,
        data: { ...team, info: normalizeTeamInfo(null, team.info), squad: team.squad || team.players || [],
          matches: team.matches || { recent: [], upcoming: [], live: [] },
          trophies: team.info.trophies || [], honours: team.info.honours || '' } });
    }
    if (String(teamId || '').startsWith('bsd_')) return res.status(404).json({ success: false, message: 'Team details not found' });
    const scopedSportScore = scopedTeamId(teamId)?.startsWith('sc_t_');
    const localTeam = resolveLocalTeam(teamId);
    const lookup = resolveProviderTeamLookup ? resolveProviderTeamLookup(teamId)
      : (/^\d+$/.test(String(teamId)) && localTeam ? localTeam.name : teamId);

    const scopedKickoff = /^ko_t_\d+$/.test(String(lookup));
    const scTeam = scopedKickoff ? null : await callProvider('SportScore team details', () => sportscoreService.getTeamDetails(lookup));
    const koCandidate = scopedSportScore && !scTeam?.info ? null
      : await callProvider('KickOff team details', () => kickoffApiService.getTeamDetails(scTeam?.info?.name || lookup));
    const normalizeName = value => String(value || '').normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-\s]+/g, ' ').trim();
    // A generic name search can resolve a different club (Barcelona in Chile
    // versus FC Barcelona). Resolve the secondary provider's team first, then
    // verify identity before requesting its roster or fixtures by scoped ID.
    const identitiesMatch = !scTeam?.info || (
      normalizeName(scTeam.info.name) === normalizeName(koCandidate?.name) &&
      normalizeName(scTeam.info.country) && normalizeName(koCandidate?.country) &&
      normalizeName(scTeam.info.country) === normalizeName(koCandidate.country)
    );
    const koInfo = identitiesMatch ? koCandidate : null;

    const sources = [];
    if (scTeam?.info) sources.push('sportscore');
    if (koInfo) sources.push('kickoffapi');

    const info = normalizeTeamInfo(localTeam, koInfo, scTeam?.info);
    if (scopedSportScore && scTeam?.info) {
      info.providerId = scTeam.info.id || lookup;
      info.id = teamId;
      info.targetId = teamId;
      info.provider = 'sportscore';
    }
    let squad = scTeam?.squad || [];
    let squadCoverage = scTeam?.coverage?.squad || squad.coverage;
    let squadContext = scTeam?.squadContext;
    const matches = scTeam?.matches || { recent: [], upcoming: [] };

    // 1. Enrich squad if empty from SportScore
    if (!hasItems(squad) && koInfo?.id) {
      try {
        const koSquad = await kickoffApiService.getTeamSquad(koInfo.id);
        if (koSquad?.coverage) {
          squadCoverage = koSquad.coverage;
          squadContext = { teamId: koSquad.coverage.teamId || koInfo.id,
            source: 'kickoffapi', ...(koSquad.coverage.scope ? { scope: koSquad.coverage.scope } : {}) };
        }
        if (hasItems(koSquad)) {
          squad = koSquad;
          sources.push('kickoffapi');
        }
      } catch (_) {}
    }

    // Club details must be supplied by a provider, not a static roster catalog.

    // 3. Enrich upcoming fixtures if empty
    if (!hasItems(matches.upcoming) && !hasItems(matches.recent) && koInfo?.id) {
      try {
        const koFixtures = await kickoffApiService.getTeamFixtures(koInfo.id);
        if (hasItems(koFixtures?.upcoming) || hasItems(koFixtures?.recent)) {
          matches.recent = koFixtures.recent || [];
          matches.upcoming = koFixtures.upcoming || [];
          sources.push('kickoffapi');
        }
      } catch (_) {}

    }

    if (!isPresent(info) && !hasItems(squad) && !hasItems(matches.recent) && !hasItems(matches.upcoming)) {
      return res.status(404).json({ success: false, message: 'Team details not found' });
    }

    const data = {
      info,
      squad,
      matches,
      trophies: info.trophies || [],
      honours: info.honours || ''
    };
    if (squadCoverage) data.coverage = { ...(scTeam?.coverage || {}), squad: squadCoverage };
    if (squadContext) data.squadContext = squadContext;

    if (scTeam?.standing) data.standing = scTeam.standing;
    if (scTeam?.statistics) data.stats = scTeam.statistics;
    if (scTeam?.tournament) data.tournament = scTeam.tournament;
    if (scTeam?.season) data.season = scTeam.season;

    if (Array.isArray(info.trophies) && info.trophies.length > 0) {
      if (!data.stats) data.stats = {};
      data.stats.trophies = info.trophies.reduce((sum, t) => sum + (t.count || 1), 0);
    }

    return res.json({
      success: true,
      source: sources.length > 0 ? [...new Set(sources)].join('+') : 'local',
      ...(squadCoverage ? { coverage: { source: sources.length > 0 ? [...new Set(sources)].join('+') : 'local',
        available: true, complete: false, partial: true, squad: squadCoverage } } : {}),
      data
    });
  } catch (error) {
    logger.error(`getDeepTeamDetails Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getDeepPlayerDetails = async (req, res) => {
  try {
    const playerId = String(req.params.id || '').trim();
    if (/^bsd_p_[1-9]\d*$/.test(playerId)) {
      const scope = Object.fromEntries(['seasonId', 'season', 'competition', 'teamId']
        .filter(key => req.query?.[key] !== undefined).map(key => [key, req.query[key]]));
      const player = await callProvider('BSD player details', () => bsdSportsService.getPlayerDetails(playerId, scope));
      if (!player?.name || String(player.id || '') !== playerId) {
        return res.status(404).json({ success: false, source: 'unavailable', data: null,
          message: 'Player details not found', coverage: { available: false, complete: false,
            partial: true, reason: player ? 'provider_identity_mismatch' : 'provider_entity_unavailable' } });
      }
      const context = player.statsContext || {};
      const info = { ...player, id: playerId, targetId: playerId, provider: 'bsd',
        providerId: player.providerId || playerId.slice(6), fullName: player.fullName || player.name };
      const seasonStats = player.seasonStats || {
        ...context, matches: player.matches ?? null, goals: player.goals ?? null,
        assists: player.assists ?? null, minutes: player.minutes ?? null, rating: player.rating ?? null,
        shots: player.shots ?? null, shotsOnTarget: player.shotsOnTarget ?? null,
        passes: player.passes ?? null, passesAccuracy: player.passesAccuracy ?? null,
        tackles: player.tackles ?? null, interceptions: player.interceptions ?? null,
        dribbles: player.dribbles ?? null, dribblesAttempted: player.dribblesAttempted ?? null,
        keyPasses: player.keyPasses ?? null, saves: player.saves ?? null,
        yellowCards: player.yellowCards ?? null, redCards: player.redCards ?? null,
      };
      return res.json({ success: true, source: 'bsd', coverage: player.coverage,
        data: { info, seasonStats, statsContext: context, statsCoverage: player.statsCoverage,
          coverage: player.coverage, careerCoverage: player.careerCoverage, transfersCoverage: player.transfersCoverage,
          attributes: player.attributes || {}, careerTotals: player.careerTotals || {},
          careerBySeason: player.careerBySeason || player.career || [], formerTeams: player.formerTeams || [],
          transfers: player.transfers || [], honours: player.honours || [], honoursCoverage: player.honoursCoverage,
          contracts: [], milestones: [] } });
    }
    if (playerId.startsWith('bsd_')) return res.status(404).json({ success: false, message: 'Player details not found' });
    const scopedKickoff = /^ko_p_[1-9]\d*$/.test(playerId);
    if (playerId.startsWith('ko_') && !scopedKickoff) {
      return res.status(404).json({ success: false, source: 'unavailable', data: null,
        message: 'Player details not found' });
    }
    const legacyName = /\s/.test(playerId);
    const kickoffScope = { ...(req.query?.season !== undefined ? { season: req.query.season } : {}),
      ...(req.query?.competition !== undefined ? { competition: req.query.competition } : {}),
      ...(req.query?.teamId !== undefined ? { teamId: req.query.teamId } : {}) };
    const koPlayer = scopedKickoff ? await callProvider('KickOff player details', () => kickoffApiService.getPlayerDetails(playerId, kickoffScope)) : null;
    const scPlayer = scopedKickoff ? null : await callProvider('SportScore player details', () => sportscoreService.getPlayerDetails(playerId));
    // Opaque provider IDs cannot be replaced by a namesake from another source.
    // Only a legacy human-readable name request may use a provider search.
    const fallback = legacyName && !scopedKickoff && !scPlayer
      ? await callProvider('KickOff player details', () => kickoffApiService.getPlayerDetails(playerId, kickoffScope)) : null;
    const ko = koPlayer || fallback;
    const player = ko || scPlayer;
    // Do not turn an unavailable provider response into a cached empty
    // profile. The client must distinguish a missing entity from incomplete
    // optional statistics.
    const identityMatches = legacyName || String(player?.id || '') === playerId;
    if (!player || !String(player.name || '').trim() || !identityMatches) {
      return res.status(404).json({ success: false, source: 'unavailable',
        message: 'Player details not found', data: null,
        coverage: { available: false, complete: false, partial: true,
          reason: player && !identityMatches ? 'provider_identity_mismatch' : 'provider_entity_unavailable' } });
    }
    const info = player ? {
      ...player,
      id: player.id, provider: ko ? 'kickoffapi' : 'sportscore', providerId: player.providerId || player.id,
      name: player.name, fullName: player.fullName || player.name,
      image: player.image, team: player.team, teamBadge: player.teamBadge,
      competition: player.competition || '', position: player.position || '',
      country: player.country || player.nationality || '', nationality: player.nationality || player.country || '',
      jerseyNumber: player.jerseyNumber ?? player.number ?? null,
      age: player.age ?? null,
      dateBorn: player.dateBorn || player.dateOfBirth || '', dateOfBirth: player.dateOfBirth || player.dateBorn || '',
      height: player.height ?? null, weight: player.weight ?? null,
      marketValue: player.marketValue ?? null
    } : {};
    const context = ko ? ko.statsContext || {} : (scPlayer?.statsContext || {});
    const seasonStats = ko ? ko.seasonStats || {} : scPlayer ? {
      ...context, matches: scPlayer.matches, goals: scPlayer.goals,
      assists: scPlayer.assists, minutes: scPlayer.minutes, rating: scPlayer.rating,
      ratingRaw: scPlayer.ratingRaw, shots: scPlayer.shots, shotsOnTarget: scPlayer.shotsOnTarget,
      passes: scPlayer.passes, passesAccuracyRaw: scPlayer.passesAccuracy,
      // SportScore does not document this raw metric as a pass percentage.
      passesAccuracy: null, tackles: scPlayer.tackles, interceptions: scPlayer.interceptions,
      dribbles: scPlayer.dribbles, keyPasses: scPlayer.keyPasses,
      yellowCards: scPlayer.yellowCards, redCards: scPlayer.redCards
    } : {};
    return res.json({
      success: true, source: ko ? 'kickoffapi' : scPlayer ? 'sportscore' : 'unavailable', coverage: player.coverage,
      data: { info, seasonStats, statsContext: context, statsCoverage: player.statsCoverage,
        coverage: player.coverage, careerCoverage: player.careerCoverage, transfersCoverage: player.transfersCoverage,
        attributes: player.attributes || {}, careerTotals: player.careerTotals || {},
        careerBySeason: player.careerBySeason || player.career || [], formerTeams: player.formerTeams || [],
        transfers: player.transfers || [], honours: player.honours || [],
        honoursCoverage: player.honoursCoverage, contracts: player.contracts || [], milestones: player.milestones || [] }
    });
  } catch (error) {
    logger.error('getDeepPlayerDetails Error: ' + error.message);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// ==========================================
// 🏆 COMPETITIONS
exports.getAllCompetitions = async (req, res) => {
  try {
    const competitions = await sportsDataService.getCompetitionCatalog();
    return res.json({
      success: true,
      source: competitions.source || 'supported-contract',
      coverage: competitions.coverage,
      data: competitions
    });
  } catch (error) {
    logger.error(`getAllCompetitions Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getMatchDeepStats = async (req, res) => {
  try {
    const matchId = req.params.id;

    // A scoped BSD ID selects only that fixture at that provider.
    if (/^bsd_[1-9]\d*$/.test(String(matchId))) {
      const details = await callProvider('BSD deep match', () => bsdSportsService.getMatchDetails(matchId));
      if (!details?.matchInfo) return res.status(404).json({ success: false, message: 'Match details not found' });
      const prediction = await callProvider('BSD match prediction', () => bsdSportsService.getPredictionForMatch(matchId));
      return res.json({ success: true, source: 'bsd', coverage: details.coverage,
        data: buildBsdDeepMatch(details, prediction) });
    }
    if (String(matchId).startsWith('bsd_')) return res.status(404).json({ success: false, message: 'Match details not found' });
    // 1. Try SportScore
    try {
      const scMatch = /^(ko_|bsd_|\d+$)/.test(String(matchId)) ? null : await sportscoreService.getMatchDetails(matchId);
      if (scMatch) {
        const timeline = hydrateTimelineTeams(scMatch.timeline || [], scMatch);
        const goals = timeline
          .filter(event => event.type === 'goal')
          .map(event => ({
            minute: event.minute,
            type: event.label || 'Goal',
            team: event.team || '',
            scorer: event.player || '',
            player: event.player || '',
            assist: event.assist || null,
            side: event.side || ''
          }));
        const bookings = timeline
          .filter(event => event.type === 'yellow_card' || event.type === 'red_card')
          .map(event => ({
            minute: event.minute,
            card: event.type === 'red_card' ? 'RED' : 'YELLOW',
            team: event.team || '',
            player: event.player || '',
            side: event.side || ''
          }));
        const substitutions = timeline
          .filter(event => event.type === 'substitution')
          .map(event => ({
            minute: event.minute,
            team: event.team || '',
            playerIn: event.player || '',
            playerOut: event.playerOut || null,
            side: event.side || ''
          }));

        // Fetch ML prediction from BSD if available
        let prediction = null;
        try {
          prediction = await bsdSportsService.getPredictionForMatch(
            matchId,
            scMatch.homeTeam?.name,
            scMatch.awayTeam?.name,
            scMatch.utcDate
          );
        } catch (_) {}

        return res.json({
          success: true,
          source: prediction ? 'sportscore+bsd' : 'sportscore',
          data: {
            matchInfo: scMatch,
            timeline,
            goals,
            bookings,
            substitutions,
            statistics: buildBasicMatchStatistics(scMatch, goals, bookings, substitutions),
            providerStatistics: scMatch.providerStatistics || [],
            lineups: scMatch.lineups || null,
            tracker: scMatch.tracker || null,
            head2head: null,
            prediction
          }
        });
      }
    } catch (_) {}

    // 3. Fallback: Try KickOff API for fixture details (e.g. upcoming matches like 1570411)
    try {
      const koMatch = /^ko_\d+$/.test(String(matchId)) ? await kickoffApiService.getMatchDetails(matchId) : null;
      if (koMatch) {
        let prediction = null;
        try {
          prediction = await bsdSportsService.getPredictionForMatch(
            matchId,
            koMatch.homeTeam?.name,
            koMatch.awayTeam?.name,
            koMatch.utcDate
          );
        } catch (_) {}

        return res.json({
          success: true,
          source: 'kickoffapi',
          data: {
            matchInfo: koMatch,
            timeline: [],
            goals: [],
            bookings: [],
            substitutions: [],
            statistics: buildBasicMatchStatistics(koMatch, [], [], []),
            providerStatistics: [],
            lineups: null,
            tracker: null,
            head2head: null,
            prediction
          }
        });
      }
    } catch (_) {}


    // Request hints and a slug are not evidence that a fixture exists.

    return res.status(404).json({ success: false, message: 'Match details not found' });
  } catch (error) {
    logger.error(`getMatchDeepStats Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.buildBasicMatchStatistics = buildBasicMatchStatistics;
