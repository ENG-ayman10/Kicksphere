const { normalizeCompetitionCode } = require('./sportsContracts');
const { matchTeamId } = require('./teamIdentity');
const { validatedProviderIdentities } = require('./matchProviderIdentities');

// Provider feeds frequently differ only by accents (for example Curaçao /
// Curacao). Fold combining marks for the exact same competition/date/fixture
// comparison; IDs and country/scope checks still prevent namesake joins.
const normalized = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[-\s]+/g, ' ').trim();
const country = value => {
  const name = normalized(value);
  return ['us', 'usa', 'united states', 'united states of america'].includes(name) ? 'usa' :
    ['es', 'esp', 'spain'].includes(name) ? 'spain' :
    ['ar', 'arg', 'argentina'].includes(name) ? 'argentina' :
    ['bf', 'bfa', 'burkina faso'].includes(name) ? 'burkina faso' :
    ['mx', 'mex', 'mexico'].includes(name) ? 'mexico' : name;
};
const sameCountry = (a, b) => !country(a) || !country(b) || country(a) === country(b);

// Explicit, source-scoped senior-club identities verified independently against
// both provider catalogs. MLS was checked on 2026-10-02; the full PD senior
// catalog and BL1/FL1 catalogs on 2026-10-10 (provider-fixture-*-catalog-2026-10-10.json). This is
// intentionally not a global name alias or a rule that removes FC/age suffixes.
// Evidence and both unmodified kickoff values are captured in the regression fixture.
const VERIFIED_CLUB_TEAMS = Object.freeze({
  bsd_t_302: { club: 'seattle-sounders', provider: 'bsd', name: 'Seattle Sounders FC', competition: 'MLS', country: 'USA' },
  'sc_t_seattle-sounders': { club: 'seattle-sounders', provider: 'sportscore', name: 'Seattle Sounders', competition: 'MLS', country: 'USA' },
  bsd_t_299: { club: 'sporting-kansas-city', provider: 'bsd', name: 'Sporting Kansas City', competition: 'MLS', country: 'USA' },
  'sc_t_sporting-kansas-city': { club: 'sporting-kansas-city', provider: 'sportscore', name: 'Sporting Kansas City', competition: 'MLS', country: 'USA' },
  bsd_t_1259: { club: 'malaga', provider: 'bsd', name: 'Málaga CF', competition: 'PD', country: 'Spain' },
  sc_t_malaga: { club: 'malaga', provider: 'sportscore', name: 'Malaga', competition: 'PD', country: 'Spain' },
  bsd_t_53: { club: 'espanyol', provider: 'bsd', name: 'Espanyol', competition: 'PD', country: 'Spain' },
  'sc_t_rcd-espanyol-de-barcelona': { club: 'espanyol', provider: 'sportscore', name: 'RCD Espanyol de Barcelona', competition: 'PD', country: 'Spain' },
  bsd_t_51: { club: 'athletic-club', provider: 'bsd', name: 'Athletic Club', competition: 'PD', country: 'Spain' },
  'sc_t_athletic-club': { club: 'athletic-club', provider: 'sportscore', name: 'Athletic Club', competition: 'PD', country: 'Spain' },
  bsd_t_54: { club: 'atletico-madrid', provider: 'bsd', name: 'Atlético Madrid', competition: 'PD', country: 'Spain' },
  'sc_t_atletico-madrid': { club: 'atletico-madrid', provider: 'sportscore', name: 'Atletico Madrid', competition: 'PD', country: 'Spain' },
  bsd_t_49: { club: 'celta-vigo', provider: 'bsd', name: 'Celta Vigo', competition: 'PD', country: 'Spain' },
  'sc_t_rc-celta': { club: 'celta-vigo', provider: 'sportscore', name: 'RC Celta', competition: 'PD', country: 'Spain' },
  bsd_t_45: { club: 'alaves', provider: 'bsd', name: 'Deportivo Alavés', competition: 'PD', country: 'Spain' },
  'sc_t_deportivo-alaves': { club: 'alaves', provider: 'sportscore', name: 'Deportivo Alavés', competition: 'PD', country: 'Spain' },
  bsd_t_1260: { club: 'deportivo', provider: 'bsd', name: 'Deportivo de A Coruña', competition: 'PD', country: 'Spain' },
  'sc_t_rc-deportivo': { club: 'deportivo', provider: 'sportscore', name: 'RC Deportivo', competition: 'PD', country: 'Spain' },
  bsd_t_55: { club: 'elche', provider: 'bsd', name: 'Elche', competition: 'PD', country: 'Spain' },
  'sc_t_elche-cf': { club: 'elche', provider: 'sportscore', name: 'Elche CF', competition: 'PD', country: 'Spain' },
  bsd_t_44: { club: 'barcelona', provider: 'bsd', name: 'FC Barcelona', competition: 'PD', country: 'Spain' },
  'sc_t_fc-barcelona': { club: 'barcelona', provider: 'sportscore', name: 'FC Barcelona', competition: 'PD', country: 'Spain' },
  bsd_t_50: { club: 'getafe', provider: 'bsd', name: 'Getafe', competition: 'PD', country: 'Spain' },
  sc_t_getafe: { club: 'getafe', provider: 'sportscore', name: 'Getafe', competition: 'PD', country: 'Spain' },
  bsd_t_46: { club: 'levante', provider: 'bsd', name: 'Levante UD', competition: 'PD', country: 'Spain' },
  sc_t_levante: { club: 'levante', provider: 'sportscore', name: 'Levante', competition: 'PD', country: 'Spain' },
  bsd_t_58: { club: 'osasuna', provider: 'bsd', name: 'Osasuna', competition: 'PD', country: 'Spain' },
  'sc_t_ca-osasuna': { club: 'osasuna', provider: 'sportscore', name: 'CA Osasuna', competition: 'PD', country: 'Spain' },
  bsd_t_40: { club: 'rayo-vallecano', provider: 'bsd', name: 'Rayo Vallecano', competition: 'PD', country: 'Spain' },
  'sc_t_rayo-vallecano': { club: 'rayo-vallecano', provider: 'sportscore', name: 'Rayo Vallecano', competition: 'PD', country: 'Spain' },
  bsd_t_56: { club: 'real-betis', provider: 'bsd', name: 'Real Betis', competition: 'PD', country: 'Spain' },
  'sc_t_real-betis': { club: 'real-betis', provider: 'sportscore', name: 'Real Betis', competition: 'PD', country: 'Spain' },
  bsd_t_57: { club: 'real-madrid', provider: 'bsd', name: 'Real Madrid', competition: 'PD', country: 'Spain' },
  'sc_t_real-madrid': { club: 'real-madrid', provider: 'sportscore', name: 'Real Madrid', competition: 'PD', country: 'Spain' },
  bsd_t_1400: { club: 'racing-santander', provider: 'bsd', name: 'Real Racing Club', competition: 'PD', country: 'Spain' },
  'sc_t_racing-santander': { club: 'racing-santander', provider: 'sportscore', name: 'Racing Santander', competition: 'PD', country: 'Spain' },
  bsd_t_48: { club: 'real-sociedad', provider: 'bsd', name: 'Real Sociedad', competition: 'PD', country: 'Spain' },
  'sc_t_real-sociedad': { club: 'real-sociedad', provider: 'sportscore', name: 'Real Sociedad', competition: 'PD', country: 'Spain' },
  bsd_t_52: { club: 'sevilla', provider: 'bsd', name: 'Sevilla', competition: 'PD', country: 'Spain' },
  'sc_t_sevilla-fc': { club: 'sevilla', provider: 'sportscore', name: 'Sevilla FC', competition: 'PD', country: 'Spain' },
  bsd_t_47: { club: 'valencia', provider: 'bsd', name: 'Valencia', competition: 'PD', country: 'Spain' },
  'sc_t_valencia-cf': { club: 'valencia', provider: 'sportscore', name: 'Valencia CF', competition: 'PD', country: 'Spain' },
  bsd_t_41: { club: 'villarreal', provider: 'bsd', name: 'Villarreal', competition: 'PD', country: 'Spain' },
  'sc_t_villarreal-cf': { club: 'villarreal', provider: 'sportscore', name: 'Villarreal CF', competition: 'PD', country: 'Spain' },
  bsd_t_2: { club: 'bournemouth', provider: 'bsd', name: 'Bournemouth', competition: 'PL', country: 'England' },
  'sc_t_bournemouth-afc': { club: 'bournemouth', provider: 'sportscore', name: 'Bournemouth AFC', competition: 'PL', country: 'England' },
  bsd_t_1: { club: 'liverpool', provider: 'bsd', name: 'Liverpool FC', competition: 'PL', country: 'England' },
  sc_t_liverpool: { club: 'liverpool', provider: 'sportscore', name: 'Liverpool', competition: 'PL', country: 'England' },
  bsd_t_68: { club: 'fiorentina', provider: 'bsd', name: 'Fiorentina', competition: 'SA', country: 'Italy' },
  sc_t_fiorentina: { club: 'fiorentina', provider: 'sportscore', name: 'Fiorentina', competition: 'SA', country: 'Italy' },
  bsd_t_62: { club: 'napoli', provider: 'bsd', name: 'SSC Napoli', competition: 'SA', country: 'Italy' },
  sc_t_napoli: { club: 'napoli', provider: 'sportscore', name: 'Napoli', competition: 'SA', country: 'Italy' },
  bsd_t_1290: { club: 'schalke', provider: 'bsd', name: 'FC Schalke 04', competition: 'BL1', country: 'Germany' },
  'sc_t_schalke-04': { club: 'schalke', provider: 'sportscore', name: 'Schalke 04', competition: 'BL1', country: 'Germany' },
  bsd_t_1833: { club: 'elversberg', provider: 'bsd', name: 'SV 07 Elversberg', competition: 'BL1', country: 'Germany' },
  'sc_t_sv-07-elversberg': { club: 'elversberg', provider: 'sportscore', name: 'SV 07 Elversberg', competition: 'BL1', country: 'Germany' },
  bsd_t_109: { club: 'auxerre', provider: 'bsd', name: 'Auxerre', competition: 'FL1', country: 'France' },
  'sc_t_aj-auxerre': { club: 'auxerre', provider: 'sportscore', name: 'AJ Auxerre', competition: 'FL1', country: 'France' },
  bsd_t_105: { club: 'brest', provider: 'bsd', name: 'Stade Brestois', competition: 'FL1', country: 'France' },
  'sc_t_stade-brestois-29': { club: 'brest', provider: 'sportscore', name: 'Stade Brestois 29', competition: 'FL1', country: 'France' },
  bsd_t_103: { club: 'nice', provider: 'bsd', name: 'Nice', competition: 'FL1', country: 'France' },
  'sc_t_ogc-nice': { club: 'nice', provider: 'sportscore', name: 'OGC Nice', competition: 'FL1', country: 'France' },
  bsd_t_106: { club: 'lille', provider: 'bsd', name: 'Lille', competition: 'FL1', country: 'France' },
  'sc_t_losc-lille': { club: 'lille', provider: 'sportscore', name: 'LOSC Lille', competition: 'FL1', country: 'France' },
  bsd_t_98: { club: 'marseille', provider: 'bsd', name: 'Olympique de Marseille', competition: 'FL1', country: 'France' },
  sc_t_marseille: { club: 'marseille', provider: 'sportscore', name: 'Marseille', competition: 'FL1', country: 'France' },
  bsd_t_114: { club: 'psg', provider: 'bsd', name: 'Paris Saint-Germain', competition: 'FL1', country: 'France' },
  'sc_t_paris-saint-germain': { club: 'psg', provider: 'sportscore', name: 'Paris Saint Germain', competition: 'FL1', country: 'France' },
  bsd_t_158: { club: 'sao-paulo', provider: 'bsd', name: 'São Paulo', competition: 'BSA', country: 'Brazil' },
  'sc_t_sao-paulo-sp': { club: 'sao-paulo', provider: 'sportscore', name: 'São Paulo - SP', competition: 'BSA', country: 'Brazil' },
  bsd_t_161: { club: 'internacional', provider: 'bsd', name: 'Internacional', competition: 'BSA', country: 'Brazil' },
  'sc_t_internacional-rs': { club: 'internacional', provider: 'sportscore', name: 'Internacional - RS', competition: 'BSA', country: 'Brazil' },
  bsd_t_303: { club: 'colorado', provider: 'bsd', name: 'Colorado Rapids', competition: 'MLS', country: 'USA' },
  'sc_t_colorado-rapids': { club: 'colorado', provider: 'sportscore', name: 'Colorado Rapids', competition: 'MLS', country: 'USA' },
  'bsd_t_94': { club: 'koln', provider: 'bsd', name: "1. FC Köln", competition: 'BL1', country: 'Germany' },
  'sc_t_fc-koln': { club: 'koln', provider: 'sportscore', name: "FC Köln", competition: 'BL1', country: 'Germany' },
  'bsd_t_83': { club: 'union-berlin', provider: 'bsd', name: "1. FC Union Berlin", competition: 'BL1', country: 'Germany' },
  'sc_t_1-fc-union-berlin': { club: 'union-berlin', provider: 'sportscore', name: "1. FC Union Berlin", competition: 'BL1', country: 'Germany' },
  'bsd_t_93': { club: 'mainz', provider: 'bsd', name: "1. FSV Mainz 05", competition: 'BL1', country: 'Germany' },
  'sc_t_1-fsv-mainz-05': { club: 'mainz', provider: 'sportscore', name: "1. FSV Mainz 05", competition: 'BL1', country: 'Germany' },
  'bsd_t_85': { club: 'leverkusen', provider: 'bsd', name: "Bayer 04 Leverkusen", competition: 'BL1', country: 'Germany' },
  'sc_t_bayer-04-leverkusen': { club: 'leverkusen', provider: 'sportscore', name: "Bayer 04 Leverkusen", competition: 'BL1', country: 'Germany' },
  'bsd_t_92': { club: 'dortmund', provider: 'bsd', name: "Borussia Dortmund", competition: 'BL1', country: 'Germany' },
  'sc_t_borussia-dortmund': { club: 'dortmund', provider: 'sportscore', name: "Borussia Dortmund", competition: 'BL1', country: 'Germany' },
  'bsd_t_95': { club: 'monchengladbach', provider: 'bsd', name: "Borussia M'gladbach", competition: 'BL1', country: 'Germany' },
  'sc_t_borussia-monchengladbach': { club: 'monchengladbach', provider: 'sportscore', name: "Borussia Monchengladbach", competition: 'BL1', country: 'Germany' },
  'bsd_t_87': { club: 'frankfurt', provider: 'bsd', name: "Eintracht Frankfurt", competition: 'BL1', country: 'Germany' },
  'sc_t_eintracht-frankfurt': { club: 'frankfurt', provider: 'sportscore', name: "Eintracht Frankfurt", competition: 'BL1', country: 'Germany' },
  'bsd_t_90': { club: 'augsburg', provider: 'bsd', name: "FC Augsburg", competition: 'BL1', country: 'Germany' },
  'sc_t_fc-augsburg': { club: 'augsburg', provider: 'sportscore', name: "FC Augsburg", competition: 'BL1', country: 'Germany' },
  'bsd_t_79': { club: 'bayern', provider: 'bsd', name: "FC Bayern München", competition: 'BL1', country: 'Germany' },
  'sc_t_fc-bayern-munich': { club: 'bayern', provider: 'sportscore', name: "FC Bayern Munich", competition: 'BL1', country: 'Germany' },
  'bsd_t_96': { club: 'hamburg', provider: 'bsd', name: "Hamburger SV", competition: 'BL1', country: 'Germany' },
  'sc_t_hamburger-sv': { club: 'hamburg', provider: 'sportscore', name: "Hamburger SV", competition: 'BL1', country: 'Germany' },
  'bsd_t_80': { club: 'leipzig', provider: 'bsd', name: "RB Leipzig", competition: 'BL1', country: 'Germany' },
  'sc_t_rb-leipzig': { club: 'leipzig', provider: 'sportscore', name: "RB Leipzig", competition: 'BL1', country: 'Germany' },
  'bsd_t_89': { club: 'freiburg', provider: 'bsd', name: "SC Freiburg", competition: 'BL1', country: 'Germany' },
  'sc_t_sc-freiburg': { club: 'freiburg', provider: 'sportscore', name: "SC Freiburg", competition: 'BL1', country: 'Germany' },
  'bsd_t_1293': { club: 'paderborn', provider: 'bsd', name: "SC Paderborn 07", competition: 'BL1', country: 'Germany' },
  'sc_t_sc-paderborn-07': { club: 'paderborn', provider: 'sportscore', name: "SC Paderborn 07", competition: 'BL1', country: 'Germany' },
  'bsd_t_88': { club: 'bremen', provider: 'bsd', name: "SV Werder Bremen", competition: 'BL1', country: 'Germany' },
  'sc_t_sv-werder-bremen': { club: 'bremen', provider: 'sportscore', name: "SV Werder Bremen", competition: 'BL1', country: 'Germany' },
  'bsd_t_86': { club: 'hoffenheim', provider: 'bsd', name: "TSG Hoffenheim", competition: 'BL1', country: 'Germany' },
  'sc_t_tsg-hoffenheim': { club: 'hoffenheim', provider: 'sportscore', name: "TSG Hoffenheim", competition: 'BL1', country: 'Germany' },
  'bsd_t_84': { club: 'stuttgart', provider: 'bsd', name: "VfB Stuttgart", competition: 'BL1', country: 'Germany' },
  'sc_t_vfb-stuttgart': { club: 'stuttgart', provider: 'sportscore', name: "VfB Stuttgart", competition: 'BL1', country: 'Germany' },
  'bsd_t_107': { club: 'angers', provider: 'bsd', name: "Angers", competition: 'FL1', country: 'France' },
  'sc_t_angers-sco': { club: 'angers', provider: 'sportscore', name: "Angers SCO", competition: 'FL1', country: 'France' },
  'bsd_t_102': { club: 'le-havre', provider: 'bsd', name: "Le Havre", competition: 'FL1', country: 'France' },
  'sc_t_havre-athletic-club': { club: 'le-havre', provider: 'sportscore', name: "Havre Athletic Club", competition: 'FL1', country: 'France' },
  'bsd_t_1619': { club: 'le-mans', provider: 'bsd', name: "Le Mans", competition: 'FL1', country: 'France' },
  'sc_t_le-mans': { club: 'le-mans', provider: 'sportscore', name: "Le Mans", competition: 'FL1', country: 'France' },
  'bsd_t_110': { club: 'lorient', provider: 'bsd', name: "Lorient", competition: 'FL1', country: 'France' },
  'sc_t_lorient': { club: 'lorient', provider: 'sportscore', name: "Lorient", competition: 'FL1', country: 'France' },
  'bsd_t_100': { club: 'lyon', provider: 'bsd', name: "Olympique Lyonnais", competition: 'FL1', country: 'France' },
  'sc_t_lyon': { club: 'lyon', provider: 'sportscore', name: "Lyon", competition: 'FL1', country: 'France' },
  'bsd_t_108': { club: 'paris-fc', provider: 'bsd', name: "Paris FC", competition: 'FL1', country: 'France' },
  'sc_t_paris-fc': { club: 'paris-fc', provider: 'sportscore', name: "Paris FC", competition: 'FL1', country: 'France' },
  'bsd_t_99': { club: 'lens', provider: 'bsd', name: "RC Lens", competition: 'FL1', country: 'France' },
  'sc_t_rc-lens': { club: 'lens', provider: 'sportscore', name: "RC Lens", competition: 'FL1', country: 'France' },
  'bsd_t_112': { club: 'strasbourg', provider: 'bsd', name: "RC Strasbourg", competition: 'FL1', country: 'France' },
  'sc_t_rc-strasbourg-alsace': { club: 'strasbourg', provider: 'sportscore', name: "RC Strasbourg Alsace", competition: 'FL1', country: 'France' },
  'bsd_t_97': { club: 'rennes', provider: 'bsd', name: "Stade Rennais", competition: 'FL1', country: 'France' },
  'sc_t_stade-rennais-fc': { club: 'rennes', provider: 'sportscore', name: "Stade Rennais FC", competition: 'FL1', country: 'France' },
  'bsd_t_104': { club: 'toulouse', provider: 'bsd', name: "Toulouse", competition: 'FL1', country: 'France' },
  'sc_t_toulouse-fc': { club: 'toulouse', provider: 'sportscore', name: "Toulouse FC", competition: 'FL1', country: 'France' },
  'bsd_t_1303': { club: 'troyes', provider: 'bsd', name: "Troyes", competition: 'FL1', country: 'France' },
  'sc_t_troyes': { club: 'troyes', provider: 'sportscore', name: "Troyes", competition: 'FL1', country: 'France' },
  // Both catalogs put AS Monaco in FL1. Its club country remains Monaco;
  // membership in a French league never turns its country into France.
  bsd_t_101: { club: 'monaco', provider: 'bsd', name: 'AS Monaco', competition: 'FL1', country: 'Monaco', competitionCountry: 'France' },
  'sc_t_as-monaco': { club: 'monaco', provider: 'sportscore', name: 'AS Monaco', competition: 'FL1', country: 'Monaco', competitionCountry: 'France' },
});
// The audited providers disagree by exactly ten minutes for the verified pair.
// No other clubs or name-based fixture joins get a kickoff tolerance.
const MAX_VERIFIED_KICKOFF_DRIFT_MS = 10 * 60 * 1000;

// These audited competition labels describe the same national friendly scope.
// With no SportScore team IDs, equal oriented full names and an exact kickoff
// may suppress one display row only. They never certify identities or routes.
const FRIENDLY_COMPETITIONS = Object.freeze({
  bsd: { code: 'BSD:31', name: 'International Friendly Games' },
  sportscore: { code: 'SC:international friendly', name: 'International Friendly' },
});
const FRIENDLY_KICKOFF_EXCEPTION = Object.freeze({
  bsd: { id: 'bsd_587776', time: Date.parse('2026-10-04T02:00:00Z'), homeId: 'bsd_t_457', awayId: 'bsd_t_451' },
  sportscore: { id: 'mexico-vs-usak82rekh2z693rep', time: Date.parse('2026-10-04T02:10:00Z') },
  homeName: 'USA', awayName: 'Mexico', score: { home: 3, away: 0 },
});

function kickoffTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
  const instant = Date.parse(value);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10) && Number.isFinite(instant) ? instant : null;
}

function fixtureProviderIdentity(match) {
  const provider = match?.provider || match?.source;
  if (!['bsd', 'sportscore', 'kickoffapi'].includes(provider) ||
      (match.provider && match.source && match.provider !== match.source)) return null;
  if ([match.homeTeam, match.awayTeam].some(team => (team?.provider && team.provider !== provider) ||
      (team?.source && team.source !== provider))) return null;
  const id = typeof match.id === 'string' || typeof match.id === 'number' ? String(match.id) : '';
  const validId = provider === 'bsd' ? /^bsd_[1-9]\d*$/.test(id) : provider === 'kickoffapi' ?
    /^ko_[1-9]\d*$/.test(id) : /^[a-z0-9][a-z0-9_-]{0,199}$/.test(id) && !/^(?:bsd_|ko_|\d+$)/.test(id);
  const competitionCode = normalizeCompetitionCode(match.competition?.code);
  const homeTeamId = matchTeamId(match.homeTeam, provider);
  const awayTeamId = matchTeamId(match.awayTeam, provider);
  if (!validId || id.length > 120 || !competitionCode || !homeTeamId || !awayTeamId || homeTeamId === awayTeamId || kickoffTime(match.utcDate) === null) return null;
  return { id, provider, utcDate: match.utcDate, competitionCode, homeTeamId, awayTeamId };
}

const marked = (object, keys) => keys.some(key => object?.[key] === true);
const gender = object => marked(object, ['isWomen', 'is_women', 'isFemale']) ? 'female' :
  normalized(object?.gender || object?.sex) || 'male';
const ageGroup = object => normalized(object?.ageGroup || object?.age_group || object?.category) ||
  (marked(object, ['isYouth', 'is_youth']) ? 'youth' : 'senior');
const reserves = object => marked(object, ['isReserve', 'is_reserve', 'isReserves']) ? 'reserves' :
  normalized(object?.squadType || object?.squad_type) || 'first';
const teamType = object => normalized(object?.type) || 'team';
function classSignature(match) {
  return [match, match.competition, match.homeTeam, match.awayTeam].map(object =>
    [gender(object), ageGroup(object), reserves(object)].join(':')).join('|') +
    `|${teamType(match.homeTeam)}|${teamType(match.awayTeam)}`;
}
function compatibleScopes(first, second) {
  return classSignature(first) === classSignature(second) &&
    // Distinct reported legs/rounds cannot be erased even if a provider reuses
    // the same participants and kickoff. Provider-specific season IDs are not
    // compared across services.
    ['leg', 'round', 'group', 'stage'].every(key => !normalized(first[key]) || !normalized(second[key]) ||
      normalized(first[key]) === normalized(second[key])) &&
    sameCountry(first.competition?.countryCode || first.competition?.country, second.competition?.countryCode || second.competition?.country) &&
    ['homeTeam', 'awayTeam'].every(side => sameCountry(first[side]?.countryCode || first[side]?.country, second[side]?.countryCode || second[side]?.country));
}

function verifiedClub(team, provider, competitionCode) {
  const id = matchTeamId(team, provider);
  const verified = VERIFIED_CLUB_TEAMS[id];
  if (!verified || verified.provider !== provider || verified.competition !== competitionCode ||
      normalized(team?.name) !== normalized(verified.name) ||
      !sameCountry(team.countryCode || team.country, verified.country) ||
      (team.identityCompetitionCode && normalizeCompetitionCode(team.identityCompetitionCode) !== competitionCode)) return null;
  return verified;
}
function verifiedBsdTeamIdForSportScoreTeam(team, competitionCode) {
  const code = normalizeCompetitionCode(competitionCode || team?.identityCompetitionCode);
  if ((team?.provider || team?.source) !== 'sportscore' ||
      (team.provider && team.source && team.provider !== team.source) ||
      !['male', 'men', 'm'].includes(gender(team)) || !['senior', 'adult', 'open'].includes(ageGroup(team)) ||
      !['first', 'first team', 'senior'].includes(reserves(team)) || !['team', 'club'].includes(teamType(team))) return null;
  const catalog = verifiedClub(team, 'sportscore', code);
  if (!catalog) return null;
  return Object.entries(VERIFIED_CLUB_TEAMS).find(([, entry]) => entry.provider === 'bsd' &&
    entry.club === catalog.club && entry.competition === code && entry.country === catalog.country)?.[0] || null;
}
function seniorClubContext(match, identity) {
  const home = verifiedClub(match.homeTeam, identity.provider, identity.competitionCode);
  const away = verifiedClub(match.awayTeam, identity.provider, identity.competitionCode);
  const homeLeagueCountry = home?.competitionCountry || home?.country;
  const awayLeagueCountry = away?.competitionCountry || away?.country;
  if (!home || !away || homeLeagueCountry !== awayLeagueCountry ||
      !sameCountry(match.competition?.countryCode || match.competition?.country, homeLeagueCountry)) return null;
  for (const object of [match, match.competition, match.homeTeam, match.awayTeam]) {
    if (!['male', 'men', 'm'].includes(gender(object)) || !['senior', 'adult', 'open'].includes(ageGroup(object)) ||
        !['first', 'first team', 'senior'].includes(reserves(object))) return null;
  }
  if (!['team', 'club'].includes(teamType(match.homeTeam)) || !['team', 'club'].includes(teamType(match.awayTeam))) return null;
  return `${identity.competitionCode}|${home.club}|${away.club}`;
}
function context(match) {
  const identity = fixtureProviderIdentity(match);
  if (!identity) return null;
  const home = normalized(match.homeTeam?.name), away = normalized(match.awayTeam?.name);
  const verified = seniorClubContext(match, identity);
  return { identity, time: kickoffTime(match.utcDate),
    exact: home && away ? `${identity.competitionCode}|${kickoffTime(match.utcDate)}|${home}|${away}` : null,
    verified,
    // Only the observed oriented Seattle–Kansas pair receives ten minutes.
    verifiedKickoffDriftMs: verified === 'MLS|seattle-sounders|sporting-kansas-city' ? MAX_VERIFIED_KICKOFF_DRIFT_MS : 0 };
}

function displayOnlyContext(match) {
  const provider = match?.provider || match?.source;
  if (!['bsd', 'sportscore'].includes(provider) || (match.provider && match.source && match.provider !== match.source)) return null;
  const time = kickoffTime(match.utcDate), homeName = normalized(match.homeTeam?.name), awayName = normalized(match.awayTeam?.name);
  if (time === null || !homeName || !awayName || homeName === awayName ||
      [homeName, awayName].some(name => /\b(?:women|female|ladies|u[\s-]?\d{1,2}|under[\s-]?\d{1,2}|reserves?|ii)\b/.test(name))) return null;
  const expected = FRIENDLY_COMPETITIONS[provider];
  if (typeof match.id !== 'string' || match.id.length > 120 || (provider === 'bsd' ? !/^bsd_[1-9]\d*$/.test(match.id) :
    !/^[a-z0-9][a-z0-9_-]*$/.test(match.id) || /^(?:bsd_|ko_|\d+$)/.test(match.id)) || match.competition?.code !== expected.code ||
      normalized(match.competition?.name) !== normalized(expected.name) ||
      !sameCountry(match.competition?.countryCode || match.competition?.country, 'International')) return null;
  for (const object of [match, match.competition, match.homeTeam, match.awayTeam]) {
    if (!['male', 'men', 'm'].includes(gender(object)) || !['senior', 'adult', 'open'].includes(ageGroup(object)) ||
        !['first', 'first team', 'senior'].includes(reserves(object))) return null;
  }
  if (!['team', 'national', 'national-team', 'national_team'].includes(teamType(match.homeTeam)) ||
      !['team', 'national', 'national-team', 'national_team'].includes(teamType(match.awayTeam))) return null;
  if ([match.homeTeam, match.awayTeam].some(team => (team.provider && team.provider !== provider) ||
      (team.source && team.source !== provider))) return null;
  const home = matchTeamId(match.homeTeam, provider), away = matchTeamId(match.awayTeam, provider);
  if (provider === 'bsd' && (!home || !away || home === away)) return null;
  if (provider === 'sportscore' && (home || away || match.homeTeam?.id || match.awayTeam?.id)) return null;
  if (['homeTeam', 'awayTeam'].some(side => !sameCountry(match[side].countryCode || match[side].country, match[side].name))) return null;
  const exception = FRIENDLY_KICKOFF_EXCEPTION[provider];
  if (time === exception.time &&
      homeName === normalized(FRIENDLY_KICKOFF_EXCEPTION.homeName) && awayName === normalized(FRIENDLY_KICKOFF_EXCEPTION.awayName) &&
      match.status === 'FINISHED' && ['home', 'away'].every(side => match.score?.fullTime?.[side] === FRIENDLY_KICKOFF_EXCEPTION.score[side])) {
    const verified = match.id === exception.id && (provider !== 'bsd' || (home === exception.homeId && away === exception.awayId));
    return `${FRIENDLY_KICKOFF_EXCEPTION.bsd.time}|${homeName}|${awayName}|audited-kickoff${verified ? '' : '-unverified'}`;
  }
  return `${time}|${homeName}|${awayName}`;
}

function contradictoryFinishedScores(first, second) {
  if (first.status !== 'FINISHED' || second.status !== 'FINISHED') return false;
  const scores = [first.score?.fullTime, second.score?.fullTime];
  return ['home', 'away'].some(side => scores.every(score => typeof score?.[side] === 'number' &&
    Number.isFinite(score[side]) && score[side] >= 0) && scores[0][side] !== scores[1][side]);
}

function aliasEntries(match, identity) {
  const previous = validatedProviderIdentities(match);
  return previous.length ? previous : [identity];
}

// Select one complete provider fixture. Never splice scores/statistics/child
// entities, infer IDs from names, or merge distinct IDs within the same provider.
// Ambiguous candidate sets remain visible rather than silently losing fixtures.
function mergeProviderFixtures(preferred = [], supplement = []) {
  const seen = new Set(), rows = [];
  for (const [preferredSource, matches] of [[true, preferred], [false, supplement]]) {
    for (const match of matches) {
      if (!match) continue;
      const key = match.id ? `${match.provider || match.source || ''}|${match.id}` : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push({ match, preferred: preferredSource, context: context(match), displayOnly: displayOnlyContext(match) });
    }
  }
  const byExact = new Map(), byVerified = new Map();
  const index = (map, key, value) => { if (key) { if (!map.has(key)) map.set(key, []); map.get(key).push(value); } };
  rows.forEach((row, i) => {
    if (row.preferred && row.context) { index(byExact, row.context.exact, i); index(byVerified, row.context.verified, i); }
  });
  const edges = new Map();
  const addEdge = (a, b) => { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a).add(b); };
  rows.forEach((row, i) => {
    if (row.preferred || !row.context) return;
    const candidates = new Set([...(byExact.get(row.context.exact) || []), ...(byVerified.get(row.context.verified) || [])]);
    for (const j of candidates) {
      const other = rows[j];
      if (other.context.identity.provider === row.context.identity.provider || !compatibleScopes(other.match, row.match)) continue;
      const exact = row.context.exact && row.context.exact === other.context.exact;
      const verified = row.context.verified && row.context.verified === other.context.verified &&
        Math.abs(row.context.time - other.context.time) <= Math.min(row.context.verifiedKickoffDriftMs, other.context.verifiedKickoffDriftMs);
      if (exact || verified) { addEdge(i, j); addEdge(j, i); }
    }
  });
  const removed = new Set(), merged = new Map();
  rows.forEach((row, i) => {
    if (!row.preferred || edges.get(i)?.size !== 1) return;
    const j = [...edges.get(i)][0];
    if (edges.get(j)?.size !== 1) return;
    const identities = [...aliasEntries(row.match, row.context.identity),
      ...aliasEntries(rows[j].match, rows[j].context.identity)];
    const keys = new Map();
    let conflictingIdentity = false;
    const providerIdentities = identities.filter(entry => {
      const key = `${entry.provider}|${entry.id}`;
      const previous = keys.get(key);
      if (previous) {
        if (previous.homeTeamId !== entry.homeTeamId || previous.awayTeamId !== entry.awayTeamId ||
            previous.competitionCode !== entry.competitionCode || kickoffTime(previous.utcDate) !== kickoffTime(entry.utcDate)) {
          conflictingIdentity = true;
        }
        return false;
      }
      keys.set(key, entry); return true;
    });
    const joined = { ...row.match, providerIdentities };
    // Existing aliases are observations too. A different ID from an already
    // represented provider is ambiguous and cannot erase a row or its prior
    // subscription identities.
    if (conflictingIdentity || !validatedProviderIdentities(joined).length) return;
    merged.set(i, joined); removed.add(j);
  });
  const byDisplay = new Map();
  rows.forEach((row, index) => { if (row.displayOnly) indexDisplay(row.displayOnly.replace(/-unverified$/, ''), { ...row, index }); });
  function indexDisplay(key, row) { if (!byDisplay.has(key)) byDisplay.set(key, []); byDisplay.get(key).push(row); }
  for (const candidates of byDisplay.values()) {
    const bsd = candidates.filter(row => (row.match.provider || row.match.source) === 'bsd');
    const sc = candidates.filter(row => (row.match.provider || row.match.source) === 'sportscore');
    if (candidates.some(row => row.displayOnly.endsWith('-unverified')) || bsd.length !== 1 || sc.length !== 1 || !compatibleScopes(bsd[0].match, sc[0].match) ||
        contradictoryFinishedScores(bsd[0].match, sc[0].match)) continue;
    // The original SC detail route stays usable. No inferred team aliases.
    removed.add(sc[0].index);
  }
  return rows.flatMap((row, i) => removed.has(i) ? [] : [merged.get(i) || row.match]);
}

function findVerifiedCanonicalFixture(matchId, preferred = [], supplement = []) {
  if (typeof matchId !== 'string' || !matchId || matchId.length > 120) return null;
  return mergeProviderFixtures(preferred, supplement).find(match =>
    validatedProviderIdentities(match).some(identity => identity.id === matchId)) || null;
}

module.exports = { mergeProviderFixtures, fixtureProviderIdentity, findVerifiedCanonicalFixture,
  verifiedBsdTeamIdForSportScoreTeam, MAX_VERIFIED_KICKOFF_DRIFT_MS };
