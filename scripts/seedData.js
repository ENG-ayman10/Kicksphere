require('dotenv').config();

const seed = async () => {
  if (process.env.ALLOW_FIRESTORE_SEED !== 'true') {
    console.error('Firestore seeding is disabled. Set ALLOW_FIRESTORE_SEED=true to run this script.');
    process.exit(1);
  }

  const db = require('../config/firebase');
  const { COMPETITIONS } = require('../services/footballApi');
  const { CLUBS } = require('../services/searchService');

  const now = new Date();
  const batch = db.batch();

  Object.entries(COMPETITIONS).forEach(([code, info]) => {
    batch.set(db.collection('competitions').doc(code), {
      code,
      ...info,
      updatedAt: now
    }, { merge: true });
  });

  Object.entries(CLUBS).forEach(([name, data]) => {
    batch.set(db.collection('teams').doc(String(data.id)), {
      name,
      ...data,
      updatedAt: now
    }, { merge: true });
  });

  await batch.commit();

  console.log(`Seeded ${Object.keys(COMPETITIONS).length} competitions and ${Object.keys(CLUBS).length} teams.`);
};

if (require.main === module) {
  seed().catch((error) => {
    console.error('Seed error:', error);
    process.exit(1);
  });
}

module.exports = seed;
