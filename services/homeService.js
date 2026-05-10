const db = require('../config/firebase');
const { fetchMatchesFromAPI } = require('./footballApi');

exports.getHomeData = async (userId) => {

  let matches = [];
  let preferences = {};
  let favorites = [];

  // ================================
  // 🔥 1. GET USER DATA
  // ================================
  if (userId) {
    const userDoc = await db.collection('users').doc(userId).get();

    if (userDoc.exists) {
      preferences = userDoc.data().preferences || {};
    }
  }

  // ================================
  // 🔥 2. GET FAVORITES
  // ================================
  if (userId) {
    const favSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('favorites')
      .orderBy('createdAt', 'desc')
      .get();

    favorites = favSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  }


  // ================================
  // 🔥 3. GET MATCHES (API + FALLBACK)
  // ================================
  try {
    matches = await fetchMatchesFromAPI();
  } catch (err) {
    const snapshot = await db.collection('matches')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    matches = snapshot.docs.map(doc => doc.data());
  }

  // ================================
  // 🔥 4. CLEAN DATA
  // ================================
  const cleanedMatches = matches.map(m => ({
    id: m.matchId || m.id || null,
    home: {
      name: m.homeTeam || m.home?.name,
      score: m.homeScore ?? m.home?.score ?? 0
    },
    away: {
      name: m.awayTeam || m.away?.name,
      score: m.awayScore ?? m.away?.score ?? 0
    },
    league: m.league || m.leagueId,
    status: m.status,
    team: m.team || m.homeTeam || m.home?.name
  }));


  // ================================
  // 🔥 5. RECOMMENDATIONS
  // ================================
  let recommended = cleanedMatches;

  if (preferences.teams && preferences.teams.length > 0) {
    recommended = cleanedMatches.filter(m =>
      preferences.teams.some(team =>
        (m.team || '').toLowerCase().includes(team.toLowerCase()) ||
        (m.away?.name || '').toLowerCase().includes(team.toLowerCase())
      )
    );
  }

  return {
    matches: cleanedMatches,
    recommended,
    favorites,
    preferences
  };
};