const axios = require('axios');
const sportscore = require('../services/sportscoreService');
const kickoff = require('../services/kickoffApiService');

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function cleanTeamName(name) {
  return String(name || '')
    .replace(/\b(FC|CF|SC|AC|AS|SS|CD|UD|RCD|CA|BV|SV|VfB|1\.|BSC|Balompie|de|la|el|los|las)\b/gi, ' ')
    .trim();
}

function mapKickoffPlayer(item) {
  const p = item.player || item;
  const fullName = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
  const playerName = p.name || fullName || 'Player';
  const playerNumber = p.number || 0;
  const playerId = String(p.id || '');
  return {
    id: playerId,
    name: playerName,
    playerName,
    number: playerNumber,
    position: p.pos || p.position || '',
    captain: Boolean(p.captain),
    rating: p.rating ? parseFloat(p.rating) : null,
    player: {
      id: playerId,
      name: playerName,
      number: playerNumber
    }
  };
}

async function resolveLineups(matchId, homeName, awayName, dateStr) {
  // 1. Direct slug if not numeric
  if (matchId && !/^\d+$/.test(matchId)) {
    try {
      const sc = await sportscore.getMatchDetails(matchId);
      if (sc?.lineups && (sc.lineups.home?.length > 0 || sc.lineups.away?.length > 0)) {
        return { source: 'sportscore_slug', lineups: sc.lineups };
      }
    } catch (_) {}
  }

  // 2. Resolve names if missing
  if (!homeName || !awayName) {
    try {
      const r = await axios.get('https://kicksphere.onrender.com/api/matches/' + matchId, { timeout: 4000 });
      if (r.data?.data) {
        homeName = r.data.data.homeTeam?.name;
        awayName = r.data.data.awayTeam?.name;
        dateStr = r.data.data.utcDate ? r.data.data.utcDate.split('T')[0] : null;
      }
    } catch (_) {}
  }

  // 3. SportScore with generated slugs
  if (homeName && awayName) {
    const sHome = slugify(homeName);
    const sAway = slugify(awayName);
    const cHome = slugify(cleanTeamName(homeName));
    const cAway = slugify(cleanTeamName(awayName));

    const candidateSlugs = [
      sHome + '-vs-' + sAway,
      sAway + '-vs-' + sHome,
      cHome + '-vs-' + cAway,
      cAway + '-vs-' + cHome,
    ];

    for (const slug of [...new Set(candidateSlugs)]) {
      try {
        const sc = await sportscore.getMatchDetails(slug);
        if (sc?.lineups && (sc.lineups.home?.length > 0 || sc.lineups.away?.length > 0)) {
          return { source: 'sportscore (' + slug + ')', lineups: sc.lineups, homeName, awayName };
        }
      } catch (_) {}
    }
  }

  // 4. KickOff API
  try {
    const targetDate = dateStr || new Date().toISOString().split('T')[0];
    const fixtures = await kickoff.safeFetch('/api/v1/fixtures', { date: targetDate });
    const list = fixtures?.response || [];

    let match = null;
    if (homeName && awayName) {
      const hLower = homeName.toLowerCase();
      const aLower = awayName.toLowerCase();
      const hClean = cleanTeamName(homeName).toLowerCase();
      const aClean = cleanTeamName(awayName).toLowerCase();

      match = list.find(f => {
        const fh = (f.homeTeam?.name || f.teams?.home?.name || '').toLowerCase();
        const fa = (f.awayTeam?.name || f.teams?.away?.name || '').toLowerCase();
        const matchHome = fh.includes(hLower) || hLower.includes(fh) || (hClean.length > 2 && fh.includes(hClean));
        const matchAway = fa.includes(aLower) || aLower.includes(fa) || (aClean.length > 2 && fa.includes(aClean));
        return matchHome && matchAway;
      });
    }

    if (match) {
      const fid = match.id || match.fixture?.id;
      const lData = await kickoff.safeFetch('/api/v1/fixtures/lineups', { fixture: fid });
      if (lData?.response?.length > 0) {
        const homeL = lData.response[0];
        const awayL = lData.response[1];
        const lineups = {
          homeFormation: homeL?.formation || '',
          awayFormation: awayL?.formation || '',
          homeCoach: homeL?.coach?.name || null,
          awayCoach: awayL?.coach?.name || null,
          confirmed: true,
          home: (homeL?.startXI || []).map(mapKickoffPlayer),
          away: (awayL?.startXI || []).map(mapKickoffPlayer),
          homeBench: (homeL?.substitutes || []).map(mapKickoffPlayer),
          awayBench: (awayL?.substitutes || []).map(mapKickoffPlayer),
        };
        if (lineups.home.length > 0 || lineups.away.length > 0) {
          return { source: 'kickoffapi (fixture ' + fid + ')', lineups, homeName, awayName };
        }
      }
    }
  } catch (e) {
    console.error('Kickoff error:', e.message);
  }

  return null;
}

async function testAll() {
  const ids = ['559699', '564667', '565791', '558609', '560566', '567299'];
  for (const id of ids) {
    const res = await resolveLineups(id);
    if (res) {
      console.log(`[FOUND] Match ${id} (${res.homeName} vs ${res.awayName}): via ${res.source} | Home: ${res.lineups.home?.length}, Away: ${res.lineups.away?.length}`);
    } else {
      console.log(`[WAITING] Match ${id}: Lineups not officially announced yet by clubs`);
    }
  }
}
testAll();
