const db = require('../config/firebase');

exports.getLeaguesService = async () => {
  const snapshot = await db.collection('leagues').get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
};


exports.getLeagueByIdService = async (id) => {
  const doc = await db.collection('leagues').doc(id).get();

  if (!doc.exists) return null;

  return {
    id: doc.id,
    ...doc.data()
  };
};


exports.getLeagueTeamsService = async (leagueId) => {
  const snapshot = await db.collection('teams')
    .where('leagueId', '==', leagueId)
    .get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
};


exports.getLeagueMatchesService = async (leagueId) => {
  const snapshot = await db.collection('matches')
    .where('league', '==', leagueId)
    .get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
};