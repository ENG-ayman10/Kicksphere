// Product coverage choices concern competitions, never a player's nationality
// or a participating club's country. Provider IDs and biographies stay intact.
const MAJOR_CODES = new Set(['PL', 'PD', 'SA', 'BL1', 'FL1', 'PPL', 'DED', 'BSA',
  'ARG', 'TSL', 'MLS', 'ELC', 'SPL', 'FAC', 'CDR', 'CIT', 'DFB', 'CL', 'EL',
  'ECL', 'WC', 'EC', 'UNL', 'ACL', 'CAF', 'CLI']);

function text(value) {
  return typeof value === 'string' ? value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '').replace(/[’']/g, '')
    .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
const words = values => new Set(values.map(text));
const ARAB_COUNTRIES = words(['DZ', 'DZA', 'Algeria', 'الجزائر', 'BH', 'BHR', 'Bahrain', 'البحرين',
  'KM', 'COM', 'Comoros', 'جزر القمر', 'DJ', 'DJI', 'Djibouti', 'جيبوتي', 'EG', 'EGY', 'Egypt', 'مصر',
  'IQ', 'IRQ', 'Iraq', 'العراق', 'JO', 'JOR', 'Jordan', 'الأردن', 'KW', 'KWT', 'Kuwait', 'الكويت',
  'LB', 'LBN', 'Lebanon', 'لبنان', 'LY', 'LBY', 'Libya', 'ليبيا', 'MR', 'MRT', 'Mauritania', 'موريتانيا',
  'MA', 'MAR', 'Morocco', 'المغرب', 'OM', 'OMN', 'Oman', 'عمان', 'PS', 'PSE', 'Palestine', 'Palestinian Territory', 'فلسطين',
  'QA', 'QAT', 'Qatar', 'قطر', 'SA', 'SAU', 'Saudi Arabia', 'السعودية', 'المملكة العربية السعودية',
  'SO', 'SOM', 'Somalia', 'الصومال', 'SD', 'SDN', 'Sudan', 'السودان', 'SY', 'SYR', 'Syria', 'سوريا',
  'TN', 'TUN', 'Tunisia', 'تونس', 'AE', 'ARE', 'UAE', 'United Arab Emirates', 'الإمارات', 'الإمارات العربية المتحدة',
  'YE', 'YEM', 'Yemen', 'اليمن']);
const INTERNATIONAL_COUNTRIES = words(['International', 'World', 'Worldwide', 'Europe', 'European', 'UEFA',
  'Asia', 'Asian', 'AFC', 'Africa', 'African', 'CAF', 'North America', 'South America', 'Americas',
  'CONCACAF', 'CONMEBOL', 'Oceania', 'OFC', 'FIFA', 'دولي', 'العالم', 'أوروبا', 'آسيا', 'أفريقيا',
  'أمريكا الشمالية', 'أمريكا الجنوبية', 'أوقيانوسيا']);
const ISRAEL_COUNTRIES = words(['IL', 'ISR', 'Israel', 'إسرائيل', 'اسرائيل']);
const ISRAEL_LABEL_PREFIXES = words(['إسرائيل', 'الدوري الإسرائيلي']);
// Exact, distinctive provider labels also cover catalogs with no country field.
const ARAB_NAMES = words(['Saudi Pro League', 'Saudi Professional League', 'Saudi Arabia Pro League',
  'Qatar Stars League', 'Qatari Stars League', 'Qatar StarsLeague', 'Egyptian Premier League',
  'Egypt Premier League', 'Morocco Botola Pro', 'Botola Pro', 'Botola Pro 1', 'UAE Pro League',
  'UAE Arabian Gulf League', 'Algerian Ligue 1', 'Algeria Ligue 1', 'Tunisian Ligue 1',
  'Tunisia Ligue 1', 'Iraq Stars League', 'Iraqi Premier League', 'Jordanian Pro League',
  'Kuwaiti Premier League', 'Bahraini Premier League', 'Omani Professional League',
  'Yemeni League', 'Palestinian Premier League', 'Lebanese Premier League', 'Syrian Premier League',
  'الدوري السعودي', 'الدوري المصري', 'الدوري المغربي', 'الدوري القطري', 'الدوري الاماراتي',
  'الدوري الجزائري', 'الدوري التونسي', 'الدوري اليمني']);
const ARAB_DOMESTIC_PREFIX = /^(?:algeria[n]?|bahrain[i]?|comoros|djibouti|egypt(?:ian)?|iraq[i]?|jordan(?:ian)?|kuwait[i]?|leban(?:on|ese)|libya[n]?|mauritania[n]?|morocc(?:o|an)|oman[i]?|palestin(?:e|ian)|qatar[i]?|saudi(?: arabia)?|somali(?:a|an)|sudan(?:ese)?|syria[n]?|tunisia[n]?|uae|united arab emirates|yemen[i]?)\s/;
const MAJOR_NAMES = words(['English Premier League', 'Spanish La Liga', 'La Liga', 'LaLiga',
  'Italian Serie A', 'German Bundesliga', 'French Ligue 1', 'Primeira Liga',
  'Portuguese Primeira Liga', 'Portuguese Primera Liga', 'Netherlands Eredivisie', 'Eredivisie',
  'Brasileirao', 'Brasileirao Serie A', 'Brazilian Serie A', 'Brasileiro Serie A',
  'Argentine Primera Division', 'Argentina Liga Profesional', 'Liga Profesional', 'Super Lig',
  'Turkish Super League', 'Turkish Super Lig', 'Major League Soccer', 'United States Major League Soccer',
  'MLS', 'English Football League Championship', 'EFL Championship', 'English Championship',
  'FA Cup', 'Copa del Rey', 'Coppa Italia', 'DFB Pokal', 'DFB-Pokal', 'English League Cup', 'EFL Cup',
  'Carabao Cup', 'Coupe de France', 'Copa do Brasil', 'Taca de Portugal', 'Taca da Liga',
  'FA Community Shield', 'Supercopa de Espana', 'Supercoppa Italiana', 'DFL Supercup', 'Trophee des Champions',
  'الدوري الانجليزي الممتاز', 'الدوري الاسباني', 'الدوري الايطالي', 'الدوري الالماني', 'الدوري الفرنسي']);
const INTERNATIONAL_NAMES = words(['World Cup', 'FIFA World Cup', 'World Cup Qualification',
  'International Friendly', 'International Friendlies', 'International Friendly Games',
  'InternationalFriendlyGames', 'European Championship', 'Euro', 'Copa America', 'African Cup of Nations',
  'Africa Cup of Nations', 'Asian Cup', 'Arab Cup', 'Gulf Cup', 'Gulf Cup of Nations',
  'Copa Libertadores', 'Copa Sudamericana', 'Club World Cup',
  'كاس العالم', 'كاس العالم للانديه', 'كاس امم افريقيا', 'كاس اسيا', 'كاس العرب', 'كاس الخليج',
  'دوري ابطال اوروبا', 'دوري ابطال اسيا', 'دوري ابطال افريقيا', 'الدوري الاوروبي', 'دوري الامم الاوروبيه']);
const QUALIFIED_MAJOR_NAMES = new Map([
  ['premier league', words(['England', 'ENG', 'GB', 'إنجلترا'])],
  ['serie a', words(['Italy', 'Italia', 'ITA', 'IT', 'إيطاليا', 'Brazil', 'BRA', 'BR', 'البرازيل'])],
  ['ligue 1', words(['France', 'FRA', 'FR', 'فرنسا'])],
  ['championship', words(['England', 'ENG', 'GB', 'إنجلترا'])],
  ['bundesliga', words(['Germany', 'DE', 'DEU', 'GER', 'ألمانيا'])],
]);
const MAJOR_DOMESTIC_COUNTRIES = new Map([
  ['PL', words(['England', 'ENG', 'GB', 'United Kingdom', 'إنجلترا'])],
  ['PD', words(['Spain', 'ES', 'ESP', 'إسبانيا'])],
  ['SA', words(['Italy', 'Italia', 'IT', 'ITA', 'إيطاليا'])],
  ['BL1', words(['Germany', 'DE', 'DEU', 'GER', 'ألمانيا'])],
  ['FL1', words(['France', 'FR', 'FRA', 'فرنسا'])],
]);

const competitionScopeEnabled = () => process.env.SPORTS_COMPETITION_SCOPE === 'focused';
function countryValues(competition) {
  const country = competition?.country;
  return [typeof country === 'object' ? country?.name : country,
    typeof country === 'object' ? country?.code : null, competition?.countryCode,
    competition?.country_code].map(text).filter(Boolean);
}
function competitionLabels(competition) {
  if (typeof competition === 'string') return [text(competition).replace(/^sc:/, '')];
  return [competition?.name, competition?.nameEn, competition?.nameAr, competition?.slug,
    typeof competition?.code === 'string' && competition.code.startsWith('SC:') ? competition.code.slice(3) : null]
    .map(text).filter(Boolean);
}
function isCompetitionAllowed(competition) {
  if (!competitionScopeEnabled()) return true;
  const countries = countryValues(competition), labels = competitionLabels(competition);
  if (countries.some(country => ISRAEL_COUNTRIES.has(country)) || labels.some(label =>
    /^(?:israel|israeli|israeli?\s+premier)\b/.test(label) || [...ISRAEL_LABEL_PREFIXES].some(prefix => label === prefix || label.startsWith(prefix + ' ')) ||
    /^(?:ligat ha ?al|liga leumit|ligat leumit|toto cup israel)$/.test(label))) return false;
  if (countries.some(country => ARAB_COUNTRIES.has(country))) return true;
  const codes = [competition?.code, competition?.id, competition?.mappedCode]
    .filter(value => typeof value === 'string').map(value => value.toUpperCase());
  // Youth/reserve copies of familiar domestic names must not borrow a senior code.
  const juniorDomestic = labels.some(label => /\byouth\b|\breserves?\b|\bu\s?(?:17|19|20|21|23)\b|under \d|للشباب|تحت \d/.test(label));
  if (countries.some(country => INTERNATIONAL_COUNTRIES.has(country))) return true;
  if (labels.some(label => /^(?:uefa|afc|caf|concacaf|conmebol|ofc|fifa)\b/.test(label) || INTERNATIONAL_NAMES.has(label))) return true;
  if (juniorDomestic) return false;
  if (countries.length && codes.some(code => MAJOR_DOMESTIC_COUNTRIES.has(code) &&
      !countries.some(country => MAJOR_DOMESTIC_COUNTRIES.get(code).has(country)))) return false;
  if (codes.some(code => MAJOR_CODES.has(code))) return true;
  return labels.some(label => ARAB_NAMES.has(label) || ARAB_DOMESTIC_PREFIX.test(label) || MAJOR_NAMES.has(label) ||
    QUALIFIED_MAJOR_NAMES.get(label)?.size && countries.some(country => QUALIFIED_MAJOR_NAMES.get(label).has(country)));
}
function isMatchAllowed(match) {
  if (!competitionScopeEnabled()) return true;
  return isCompetitionAllowed(match?.competition ?? match?.league ?? match?.tournament ??
    { code: match?.competitionCode ?? match?.leagueId, name: match?.leagueName });
}
function scopeCoverage(coverage, total, accepted) {
  if (!competitionScopeEnabled()) return coverage;
  return { ...(coverage || {}), competitionScope: 'focused',
    excludedByScope: (Number(coverage?.excludedByScope) || 0) + Math.max(0, total - accepted),
    returned: accepted };
}
function filterMatchesToScope(rows) {
  if (!Array.isArray(rows) || !competitionScopeEnabled()) return rows;
  const selected = rows.filter(isMatchAllowed);
  if (rows.coverage) Object.defineProperty(selected, 'coverage', {
    value: scopeCoverage(rows.coverage, rows.length, selected.length), enumerable: false,
  });
  return selected;
}
function isEventAllowed(event) {
  if (!competitionScopeEnabled() || !event?.matchId) return true;
  return isCompetitionAllowed(event.competition || { code: event.competitionCode, name: event.tournament });
}
module.exports = { competitionScopeEnabled, isCompetitionAllowed, isMatchAllowed,
  isEventAllowed, scopeCoverage, filterMatchesToScope };
