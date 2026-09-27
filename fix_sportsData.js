const fs = require('fs');

const path = 'd:\\kicksphere\\KickSphere-Backend\\services\\sportsDataService.js';
let content = fs.readFileSync(path, 'utf8');

const target = `  try {
    const sportscoreMatches = await sportscoreService.getMatchesByDate(normalizedDate);
    if (Array.isArray(sportscoreMatches)) {
      return { success: true, source: 'sportscore', data: sportscoreMatches, coverage: sportscoreMatches.coverage };
    }`;

const replacement = `  try {
    const generalPromise = sportscoreService.getMatchesByDate(normalizedDate);
    const TOP_LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'EL', 'UNL', 'WC'];
    const topPromises = TOP_LEAGUES.map(league => 
      sportscoreService.getMatchesByDate(normalizedDate, { competition: league }).catch(() => [])
    );

    const [generalResult, ...topResults] = await Promise.all([generalPromise, ...topPromises]);
    
    if (Array.isArray(generalResult)) {
      const allMatches = [...generalResult];
      for (const res of topResults) {
        if (Array.isArray(res)) allMatches.push(...res);
      }
      
      const seen = new Set();
      const uniqueMatches = allMatches.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      return { success: true, source: 'sportscore', data: uniqueMatches, coverage: generalResult.coverage };
    }`;

// Replace ignoring line endings
content = content.replace(/try\s*\{\s*const sportscoreMatches = await sportscoreService\.getMatchesByDate\(normalizedDate\);\s*if \(Array\.isArray\(sportscoreMatches\)\)\s*\{\s*return \{ success: true, source: 'sportscore', data: sportscoreMatches, coverage: sportscoreMatches\.coverage \};\s*\}/m, replacement);

fs.writeFileSync(path, content, 'utf8');
console.log('✅ Updated successfully');
