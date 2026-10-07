/** Share each broad live snapshot with score detection; bound detail work separately. */
function createLivePollingCoordinator(options) {
  const { readAndEmitMatches, emitEvents, matchesIntervalMs, eventsIntervalMs } = options;
  const now = options.now || Date.now;
  const onError = options.onError || (() => {});
  let matchRead = null;
  let eventWork = null;
  let snapshot = null;
  let snapshotAt = -Infinity;
  let scorePending = false;
  let detailsPending = false;
  let nextDetailsAt = -Infinity;
  let stopped = false;

  const currentSnapshot = () => now() - snapshotAt <= matchesIntervalMs ? snapshot : null;
  const drainEvents = () => {
    if (stopped || eventWork) return eventWork;
    eventWork = Promise.resolve().then(async () => {
      while (!stopped && (scorePending || detailsPending)) {
        // Broadcast score/status changes before optional provider details. A
        // fresh source snapshot never waits for the 90-second detail timer.
        const includeDetails = !scorePending;
        if (scorePending) scorePending = false;
        else {
          detailsPending = false;
          if (now() < nextDetailsAt) continue;
          nextDetailsAt = now() + eventsIntervalMs;
        }
        try { await emitEvents({ liveSnapshot: currentSnapshot(), includeDetails,
          detailOverrideTtlMs: 2 * eventsIntervalMs }); }
        catch (error) { onError('events', error); }
      }
    }).finally(() => {
      eventWork = null;
      if (!stopped && (scorePending || detailsPending)) void drainEvents();
    });
    return eventWork;
  };

  const pollLiveMatches = () => {
    if (stopped) return Promise.resolve();
    if (matchRead) return matchRead;
    matchRead = Promise.resolve().then(readAndEmitMatches).then(result => {
      if (stopped) return;
      snapshot = result ?? null;
      snapshotAt = now();
      scorePending = true;
      if (now() >= nextDetailsAt) detailsPending = true;
      void drainEvents();
      return result;
    }).catch(error => { onError('matches', error); }).finally(() => { matchRead = null; });
    return matchRead;
  };

  const pollLiveEvents = () => {
    if (stopped || now() < nextDetailsAt) return eventWork || Promise.resolve();
    detailsPending = true;
    return drainEvents();
  };

  return { pollLiveMatches, pollLiveEvents,
    idleEvents: () => eventWork || Promise.resolve(),
    stop() { stopped = true; scorePending = false; detailsPending = false; } };
}

module.exports = { createLivePollingCoordinator };
