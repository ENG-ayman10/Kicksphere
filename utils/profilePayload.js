'use strict';

// Details consumers read these sections at the profile root. Preserve any
// provider-only information until the caller supplies its canonical section.
const PLAYER_SECTION_KEYS = Object.freeze({
  career: 'careerBySeason',
  careerBySeason: 'careerBySeason',
  seasonStats: 'seasonStats',
  statsContext: 'statsContext',
  statsCoverage: 'statsCoverage',
  coverage: 'coverage',
  careerCoverage: 'careerCoverage',
  transfersCoverage: 'transfersCoverage',
  attributes: 'attributes',
  careerTotals: 'careerTotals',
  formerTeams: 'formerTeams',
  transfers: 'transfers',
  honours: 'honours',
  honoursCoverage: 'honoursCoverage',
  contracts: 'contracts',
  milestones: 'milestones',
});

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/** Remove duplicate sections without restricting biography fields or IDs. */
function compactPlayerInfo(info, canonicalSections) {
  if (!record(info)) return {};
  const result = { ...info };
  if (!record(canonicalSections)) return result;
  for (const [key, canonicalKey] of Object.entries(PLAYER_SECTION_KEYS)) {
    // An undefined root field is not serialized, so it cannot replace info.
    if (Object.hasOwn(canonicalSections, canonicalKey) && canonicalSections[canonicalKey] !== undefined) {
      delete result[key];
    }
  }
  return result;
}

/** BSD supplies one roster under two names; the client uses canonical squad. */
function compactTeamProfile(team) {
  if (!record(team)) return {};
  const result = { ...team };
  if (Array.isArray(team.squad) && team.players === team.squad) delete result.players;
  return result;
}

module.exports = { compactPlayerInfo, compactTeamProfile };
