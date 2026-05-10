const db = require('../config/firebase');

const seed = async () => {
  try {
    console.log("🚀 Seeding data...");

    // 🔥 leagues
    const leagueRef = db.collection('leagues').doc();

    await leagueRef.set({
      name: "La Liga",
      country: "Spain",
      logo: "laliga.png",
      createdAt: new Date()
    });

    const leagueId = leagueRef.id;

    // 🔥 teams
    const teams = [
      { name: "Barcelona" },
      { name: "Real Madrid" },
      { name: "Atletico Madrid" }
    ];

    const batch = db.batch();

    teams.forEach(team => {
      const ref = db.collection('teams').doc();
      batch.set(ref, {
        name: team.name,
        leagueId,
        createdAt: new Date()
      });
    });

    await batch.commit();

    console.log("✅ Data seeded successfully");
    process.exit();

  } catch (error) {
    console.error("❌ Seed error:", error);
    process.exit(1);
  }
};

seed();