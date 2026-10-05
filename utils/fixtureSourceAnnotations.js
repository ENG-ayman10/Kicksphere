'use strict';

// Organizer-confirmed exceptions for two audited fixtures, not a competition
// remap. BSD groups these Kirin Cup games under its general friendly season.
// Keep their provider identity and competition intact while exposing the stage.
const VERIFIED_AT = '2026-10-05T09:35:10.000Z';
const JFA_STAGE_SOURCE = 'https://www.jfa.jp/eng/samuraiblue/news/00036851/';
const VERIFIED_STAGES = Object.freeze({
  bsd_605568: Object.freeze({
    rawId: 605568,
    kickoff: Date.parse('2026-10-05T10:30:00.000Z'),
    homeId: 470, homeName: 'Japan', awayId: 482, awayName: 'New Zealand',
    stage: 'final', label: 'Final',
  }),
  bsd_605595: Object.freeze({
    rawId: 605595,
    kickoff: Date.parse('2026-10-05T06:30:00.000Z'),
    homeId: 472, homeName: 'Ecuador', awayId: 496, awayName: 'Panama',
    stage: 'third-place', label: 'Third place play-off',
  }),
});

function exactId(value, expected) {
  return value === expected || value === String(expected);
}

function normalizedName(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function zonedInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function seniorMensContext(object) {
  if (!object || typeof object !== 'object') return false;
  const incompatibleFlags = ['isWomen', 'is_women', 'isFemale', 'isYouth', 'is_youth', 'isReserve', 'is_reserve', 'isReserves'];
  if (incompatibleFlags.some(key => object[key] === true)) return false;
  const gender = normalizedName(object.gender || object.sex);
  const age = normalizedName(object.ageGroup || object.age_group || object.category);
  const squad = normalizedName(object.squadType || object.squad_type);
  return (!gender || ['male', 'men', 'm'].includes(gender)) &&
    (!age || ['senior', 'adult', 'open'].includes(age)) &&
    (!squad || ['first', 'first team', 'senior'].includes(squad));
}

function matchesTeam(team, id, name) {
  return team?.id === `bsd_t_${id}` && exactId(team.rawId, id) &&
    team.provider === 'bsd' && team.source === 'bsd' &&
    normalizedName(team.name) === normalizedName(name) && seniorMensContext(team) &&
    (!team.type || ['team', 'national', 'national-team', 'national_team', 'nationalteam'].includes(team.type));
}

function matchesFixture(match, verified) {
  const competition = match.competition;
  const season = competition?.season;
  return match.provider === 'bsd' && match.source === 'bsd' && exactId(match.rawId, verified.rawId) &&
    (!match.slug || match.slug === match.id) && zonedInstant(match.utcDate) === verified.kickoff &&
    competition?.provider === 'bsd' && competition.id === 'BSD:31' && competition.code === 'BSD:31' &&
    exactId(competition.rawId, 31) && (!competition.providerId || exactId(competition.providerId, 31)) &&
    exactId(match.seasonId, 133) && exactId(season?.id, 133) &&
    (season.year === undefined || exactId(season.year, 2026)) &&
    matchesTeam(match.homeTeam, verified.homeId, verified.homeName) &&
    matchesTeam(match.awayTeam, verified.awayId, verified.awayName) &&
    seniorMensContext(match) && seniorMensContext(competition);
}

/**
 * Adds a narrowly verified organizer stage without changing fixture identity,
 * competition, timing, scores, or BSD provenance. Unknown tuples are untouched.
 * Evidence time is when the official source was checked, not response time.
 */
function annotateFixtureSourceStage(match) {
  if (!match || typeof match !== 'object' || typeof match.id !== 'string') return match;
  if (!Object.hasOwn(VERIFIED_STAGES, match.id)) return match;
  const verified = VERIFIED_STAGES[match.id];
  if (!verified || !matchesFixture(match, verified)) return match;
  const existingEvidence = match.fixtureStageEvidence;
  const previousStage = existingEvidence?.sourceURL === JFA_STAGE_SOURCE &&
    existingEvidence?.fixtureId === match.id && existingEvidence?.checkedAt === VERIFIED_AT
    ? existingEvidence.previousStage
    : { stage: match.stage ?? null, stageName: match.stageName ?? null, roundLabel: match.roundLabel ?? null };
  return {
    ...match,
    stage: verified.stage,
    stageName: verified.label,
    roundLabel: verified.label,
    fixtureStageEvidence: {
      source: 'organizer', organizer: 'Japan Football Association',
      sourceURL: JFA_STAGE_SOURCE, checkedAt: VERIFIED_AT, fixtureId: match.id,
      previousStage,
    },
  };
}

module.exports = { annotateFixtureSourceStage };
