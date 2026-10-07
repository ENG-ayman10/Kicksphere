const test = require('node:test');
const assert = require('node:assert/strict');
const { createLivePollingCoordinator } = require('../services/livePollingService');

test('a shared 60-second snapshot removes the independent 90-second alert wait without extra broad reads', async () => {
  let time = 0; let score = 0; let baseline;
  let broadReads = 0;
  const alerts = []; const cycles = [];
  const polling = createLivePollingCoordinator({ now: () => time,
    matchesIntervalMs: 60000, eventsIntervalMs: 90000,
    readAndEmitMatches: async () => { broadReads++; return [{ score }]; },
    emitEvents: async cycle => {
      cycles.push({ time, ...cycle });
      const incoming = cycle.liveSnapshot?.[0]?.score;
      if (incoming === undefined) return;
      if (baseline !== undefined && incoming > baseline) alerts.push(time);
      baseline = incoming;
    }
  });
  await polling.pollLiveMatches(); await polling.idleEvents();
  time = 30000; score = 1;
  time = 60000;
  await polling.pollLiveMatches(); await polling.idleEvents();
  assert.deepEqual(alerts, [60000]);
  const observedGoalAt = 30000;
  const previousAlertAt = 90000; // The former independent event interval.
  assert.equal(previousAlertAt - observedGoalAt, 60000);
  assert.equal(alerts[0] - observedGoalAt, 30000);
  assert.equal(cycles.find(cycle => cycle.time === 60000).includeDetails, false);
  time = 90000; await polling.pollLiveEvents();
  assert.equal(broadReads, 2, 'The detail timer reuses the snapshot without reading the broad source');
  assert.equal(alerts.length, 1, 'A reused snapshot cannot replay the same goal');
  assert.deepEqual(cycles.filter(cycle => cycle.includeDetails).map(cycle => cycle.time), [0, 90000]);
});

test('source reads coalesce while a slow event cycle retains the newest snapshot and does not block the scoreboard', async () => {
  let time = 0; let resolveRead; let releaseDetails;
  let reads = 0; let readResult = 0; let activeEvents = 0; let peakEvents = 0;
  const scores = []; const boards = [];
  const detailBlocked = new Promise(resolve => { releaseDetails = resolve; });
  const polling = createLivePollingCoordinator({ now: () => time,
    matchesIntervalMs: 60000, eventsIntervalMs: 90000,
    readAndEmitMatches: async () => {
      reads++;
      if (reads === 1) await new Promise(resolve => { resolveRead = resolve; });
      const result = [{ score: readResult }]; boards.push(result[0].score); return result;
    },
    emitEvents: async cycle => {
      peakEvents = Math.max(peakEvents, ++activeEvents);
      if (cycle.includeDetails) await detailBlocked;
      else scores.push(cycle.liveSnapshot[0].score);
      activeEvents--;
    }
  });
  const first = polling.pollLiveMatches();
  const duplicate = polling.pollLiveMatches();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  resolveRead(); await Promise.all([first, duplicate]);
  await new Promise(resolve => setImmediate(resolve));
  time = 60000; readResult = 1;
  await polling.pollLiveMatches();
  time = 120000; readResult = 2;
  await polling.pollLiveMatches();
  assert.deepEqual(boards, [0, 1, 2], 'Source snapshots still broadcast during event delivery');
  releaseDetails(); await polling.idleEvents();
  assert.deepEqual(scores, [0, 2], 'The queued latest snapshot is processed instead of being skipped');
  assert.equal(peakEvents, 1);
  assert.equal(reads, 3);
});

test('expired snapshots and shutdown do not trigger broad fallback reads or create new baselines', async () => {
  let time = 0; let reads = 0;
  const cycles = [];
  const polling = createLivePollingCoordinator({ now: () => time,
    matchesIntervalMs: 60000, eventsIntervalMs: 90000,
    readAndEmitMatches: async () => { reads++; return [{ score: 1 }]; },
    emitEvents: async cycle => { cycles.push(cycle); }
  });
  await polling.pollLiveMatches(); await polling.idleEvents();
  time = 90000; await polling.pollLiveEvents();
  assert.equal(cycles.at(-1).liveSnapshot, null);
  assert.equal(reads, 1);
  polling.stop();
  time = 180000;
  await polling.pollLiveMatches(); await polling.pollLiveEvents();
  assert.equal(reads, 1);
  assert.equal(cycles.length, 3);
});
