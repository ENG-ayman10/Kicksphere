/**
 * @file playerController.js
 * @description Controller for player sync operations.
 * Clears old players before inserting new ones to prevent duplicates.
 */

const db = require('../config/firebase');
const { fetchPlayersFromAPI } = require('../services/playerService');
const logger = require('../utils/logger');

exports.syncPlayers = async (req, res) => {
  try {
    const players = await fetchPlayersFromAPI();

    if (players.length === 0) {
      return res.json({
        success: true,
        message: "No players found to sync"
      });
    }

    // ❌ Delete old players first to prevent duplicates
    const oldDocs = await db.collection('players').get();
    if (!oldDocs.empty) {
      const BATCH_LIMIT = 500;
      const refs = oldDocs.docs.map(doc => doc.ref);

      for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
        const chunk = refs.slice(i, i + BATCH_LIMIT);
        const deleteBatch = db.batch();
        chunk.forEach(ref => deleteBatch.delete(ref));
        await deleteBatch.commit();
      }
    }

    // ✅ Insert new players with teamId field for squad lookups
    for (let i = 0; i < players.length; i += BATCH_LIMIT) {
      const chunk = players.slice(i, i + BATCH_LIMIT);
      const batch = db.batch();

      chunk.forEach(p => {
        const ref = db.collection('players').doc();
        batch.set(ref, {
          name: p.name,
          position: p.position,
          team: p.team,
          teamId: p.teamId || null,
          createdAt: new Date()
        });
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