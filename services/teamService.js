/**
 * @file teamService.js
 * @description Service layer for team data operations.
 */

const db = require('../config/firebase');
const logger = require('../utils/logger');

// ==========================================
// 🔥 GET ALL TEAMS
// ==========================================
exports.getTeamsService = async () => {
  const snapshot = await db.collection('teams').get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
};


// ==========================================
// 🔥 GET TEAM BY ID
// ==========================================
exports.getTeamByIdService = async (id) => {
  const doc = await db.collection('teams').doc(id).get();

  if (!doc.exists) return null;

  return {
    id: doc.id,
    ...doc.data()
  };
};


// ==========================================
// 🔥 GET TEAM MATCHES (searches both homeTeam and awayTeam)
// ==========================================
exports.getTeamMatchesService = async (teamName) => {
  const snapshot = await db.collection('matches')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  let data = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

  // Search both home and away teams
  const lowerName = teamName.toLowerCase();
  data = data.filter(m =>
    (m.homeTeam || '').toLowerCase().includes(lowerName) ||
    (m.awayTeam || '').toLowerCase().includes(lowerName)
  );

  return data;
};


// ==========================================
// 🔥 GET TEAM SQUAD (searches by both team name and teamId)
// ==========================================
exports.getTeamSquadService = async (teamId) => {
  // Try by teamId first
  let snapshot = await db.collection('players')
    .where('teamId', '==', teamId)
    .get();

  // Fallback: try by team name (for backward compatibility)
  if (snapshot.empty) {
    const teamDoc = await db.collection('teams').doc(teamId).get();
    if (teamDoc.exists) {
      const teamName = teamDoc.data().name;
      snapshot = await db.collection('players')
        .where('team', '==', teamName)
        .get();
    }
  }

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
};