'use strict';

function positiveInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function verifiedSeason(row) {
  const season = row.seasonInfo;
  if (!season || typeof season !== 'object' || Array.isArray(season)) return null;
  const id = positiveInteger(row.seasonId);
  if (!id || positiveInteger(season.id) !== id) return null;
  const year = positiveInteger(season.year);
  if (!year || year < 1900 || year > 2099) return null;
  // Keep conflicting metadata visible rather than repairing its year from the
  // provider's opaque season ID or from the current competition's edition.
  const namedYears = typeof season.name === 'string'
    ? season.name.match(/\b(?:19|20)\d{2}\b/g) || [] : [];
  if (namedYears.length && !namedYears.includes(String(year))) return null;
  if (typeof season.start_date === 'string' && season.start_date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(season.start_date) ||
       Number(season.start_date.slice(0, 4)) !== year)) return null;
  return { id, year };
}

/**
 * Use edition-neutral names for explicitly verified BSD tournament contexts.
 * BSD's league catalog currently calls league 69 "CONCACAF Gold Cup 2025",
 * including when a career row belongs to the separately verified 2023 edition.
 * The year stays in the existing season field. Identity, stats and provider
 * labels remain inspectable; no generic stripping of years or entity joins.
 */
function normalizeCareerCompetitionLabels(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const result = { ...row };
  const provider = row.provider ?? row.source;
  const leagueId = positiveInteger(row.leagueId);
  const context = leagueId === 69
    ? { ids: ['BSD:69'], label: 'CONCACAF Gold Cup', editionLabel: /^(?:CONCACAF\s+)?Gold\s+Cup\s+(?:19|20)\d{2}$/i }
    : leagueId === 27
      ? { ids: ['WC', 'BSD:27'], label: 'World Cup', editionLabel: /^(?:FIFA\s+)?World\s+Cup\s+(?:19|20)\d{2}$/i }
      : null;
  if (provider !== 'bsd' || !context ||
      (row.competitionId !== undefined && !context.ids.includes(row.competitionId))) return result;
  const season = verifiedSeason(row);
  if (!season) return result;
  const originals = {};
  for (const field of ['competition', 'league']) {
    if (typeof row[field] !== 'string' || !context.editionLabel.test(row[field].trim())) continue;
    originals[field] = row[field];
    result[field] = context.label;
  }
  if (Object.keys(originals).length) {
    result.competitionLabelProvenance = {
      source: 'bsd',
      method: 'season_catalog_edition_neutral_name',
      leagueId,
      seasonId: season.id,
      seasonYear: season.year,
      originalLabels: originals,
    };
  }
  return result;
}

module.exports = { normalizeCareerCompetitionLabels };
