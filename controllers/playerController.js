/**
 * @file playerController.js
 * @description Controller for player sync operations.
 * Syncs player squads without destructive collection-wide deletes.
 */

const db = require('../config/firebase');
const { fetchPlayersFromAPI } = require('../services/playerService');
const logger = require('../utils/logger');

exports.syncPlayers = async (req, res) => {
  try {
    const BATCH_LIMIT = 500;
    const players = await fetchPlayersFromAPI({
      league: req.query.league || req.body?.league,
      competition: req.query.competition || req.body?.competition,
      teamLimit: req.query.teamLimit || req.body?.teamLimit,
    });

    if (players.length === 0) {
      return res.json({
        success: true,
        message: "No players found to sync"
      });
    }

    // Upsert by stable provider/team/player key so partial league syncs do not erase data.
    for (let i = 0; i < players.length; i += BATCH_LIMIT) {
      const chunk = players.slice(i, i + BATCH_LIMIT);
      const batch = db.batch();

      chunk.forEach(p => {
        const ref = db.collection('players').doc(p.key);
        batch.set(ref, {
          externalId: p.externalId || null,
          name: p.name,
          fullName: p.fullName || p.name,
          shortName: p.shortName || p.name,
          position: p.position,
          team: p.team,
          teamId: p.teamId || null,
          teamLogo: p.teamLogo || '',
          shirtNumber: p.shirtNumber || null,
          country: p.country || '',
          nationality: p.nationality || '',
          dateBorn: p.dateBorn || '',
          image: p.image || '',
          leagueCode: p.leagueCode || '',
          source: p.source || '',
          updatedAt: new Date()
        }, { merge: true });
      });

      await batch.commit();
    }

    logger.info(`✅ Synced ${players.length} players successfully`);

    res.json({
      success: true,
      message: `${players.length} players synced successfully`
    });

  } catch (error) {
    logger.error(`❌ Player Sync Error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
