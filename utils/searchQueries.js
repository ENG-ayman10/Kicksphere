/** Query aliases improve discovery only; they never establish an entity ID. */
const normalizeTerm = value => String(value || '').normalize('NFKD')
  .replace(/[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g, '')
  .replace(/\u0640/g, '').replace(/[\u0671]/g, 'ا').replace(/[ىی]/g, 'ي')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const aliasGroups = [
  ['Barcelona', 'برشلونة', 'بارشلونة'],
  ['Real Madrid', 'ريال مدريد'],
  ['Manchester City', 'مانشستر سيتي'],
  ['Manchester United', 'مانشستر يونايتد'],
  ['Liverpool', 'ليفربول'], ['Arsenal', 'ارسنال', 'أرسنال'], ['Chelsea', 'تشيلسي'],
  ['Al-Hilal', 'Al Hilal', 'الهلال'], ['Al-Nassr', 'Al Nassr', 'النصر'],
  ['Al-Ittihad', 'Al Ittihad', 'الاتحاد'],
  ['Messi', 'ميسي'], ['Lionel Messi', 'ليونيل ميسي', 'ليو ميسي'],
  ['Mbappe', 'مبابي'], ['Kylian Mbappe', 'كيليان مبابي'], ['Ethan Mbappe', 'إيثان مبابي', 'ايثان مبابي'],
  ['Haaland', 'هالاند'], ['Mohamed Salah', 'محمد صلاح'],
  ['Premier League', 'الدوري الإنجليزي', 'الدوري الانجليزي', 'الدوري الإنجليزي الممتاز', 'English Premier League', 'EPL'],
  ['La Liga', 'الدوري الإسباني', 'الدوري الاسباني', 'لاليغا', 'LaLiga'],
  ['Serie A', 'الدوري الإيطالي', 'الدوري الايطالي'],
  ['Bundesliga', 'الدوري الألماني', 'الدوري الالماني'],
  ['Ligue 1', 'الدوري الفرنسي'], ['Champions League', 'دوري أبطال أوروبا', 'دوري ابطال اوروبا', 'UEFA Champions League', 'UCL'],
  ['World Cup', 'كأس العالم', 'كاس العالم', 'FIFA World Cup'],
  ['Argentina', 'الأرجنتين', 'الارجنتين'], ['England', 'إنجلترا', 'انجلترا'],
  ['Spain', 'إسبانيا', 'اسبانيا'], ['France', 'فرنسا'], ['Germany', 'ألمانيا', 'المانيا'],
  ['Italy', 'إيطاليا', 'ايطاليا'], ['Brazil', 'البرازيل'], ['Portugal', 'البرتغال'],
  ['Saudi Arabia', 'السعودية'],
];
const aliases = new Map(aliasGroups.flatMap(([term, ...names]) =>
  [term, ...names].map(name => [normalizeTerm(name), term])));

function searchQuery(value) {
  const normalized = normalizeTerm(String(value || '').slice(0, 120));
  const term = aliases.get(normalized) || normalized;
  return { term, key: normalizeTerm(term) };
}

// A bounded, curated extra query recovers candidates hidden by substring search.
// It is retrieval only: a Messi query still ranks every row by the surname Messi.
function playerSearchTerms(value) {
  const query = searchQuery(value);
  return query.key === 'messi' ? [query.term, 'Lionel Messi'] : [query.term];
}

const tokens = value => normalizeTerm(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const nameScore = (value, query) => {
  const name = tokens(value), q = tokens(query);
  if (!name || !q) return 6;
  if (name === q) return 0;
  if (` ${name} `.includes(` ${q} `)) return 1;
  if (q.split(' ').every(word => name.split(' ').includes(word))) return 2;
  if (name.split(' ').some(word => word.startsWith(q)) || name.startsWith(q)) return 3;
  if (name.includes(q)) return 4;
  return 6;
};

function relevanceScore(item, query, category = 'players') {
  const q = searchQuery(query).key;
  const names = [item.name, item.fullName, item.shortName, ...(Array.isArray(item.aliases) ? item.aliases : [])];
  if (category === 'teams') {
    // Club abbreviations do not make FC Barcelona less exact than Barcelona.
    names.push(...names.map(name => tokens(name).replace(/^(?:fc|cf|ac|sc|afc)\s+/, '')));
  }
  const direct = Math.min(...names.map(name => nameScore(name, q)));
  if (direct < 6) return direct;
  return ['country', 'nationality', 'league', 'competition', 'leagueCode', 'code']
    .some(field => nameScore(item[field], q) < 6) ? 5 : 6;
}

function sortByRelevance(items, query, category = 'players') {
  return items.map((item, index) => ({ item, index, score: relevanceScore(item, query, category) }))
    .sort((a, b) => a.score - b.score || a.index - b.index).map(row => row.item);
}

module.exports = { normalizeTerm, searchQuery, playerSearchTerms, relevanceScore, sortByRelevance };
