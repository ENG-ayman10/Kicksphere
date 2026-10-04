/** Coalesce provider refreshes without making a healthy feed wait for its peer. */
function createLiveSnapshotReader(options = {}) {
  const now = options.now || Date.now;
  const refreshMs = options.refreshMs ?? 15000;
  const retainMs = options.retainMs ?? 60000;
  const waitMs = options.waitMs ?? 1000;
  const entries = new Map();

  return async function readSnapshots(sources) {
    const time = now();
    const active = sources.map(source => {
      let entry = entries.get(source.name);
      if (!entry) {
        entry = { value: null, completedAt: null, attemptedAt: -Infinity, pending: null, failed: false };
        entries.set(source.name, entry);
      }
      if (!entry.pending && time - entry.attemptedAt >= refreshMs) {
        entry.attemptedAt = time;
        entry.pending = Promise.resolve().then(source.read).then(value => {
          if (Array.isArray(value) && value.coverage?.available !== false) {
            entry.value = value; entry.completedAt = now(); entry.failed = false;
          } else entry.failed = true;
        }).catch(() => { entry.failed = true; }).finally(() => { entry.pending = null; });
      }
      return { source, entry };
    });
    const fresh = entry => entry.value !== null && entry.completedAt !== null && now() - entry.completedAt < refreshMs;
    if (!active.some(({ entry }) => fresh(entry))) {
      const pending = active.filter(({ entry }) => entry.pending);
      if (pending.length) {
        let timer;
        try {
          await Promise.race([
            Promise.any(pending.map(({ entry }) => entry.pending.then(() => {
              if (!fresh(entry)) throw new Error('No current provider snapshot');
            }))).catch(() => {}),
            new Promise(resolve => { timer = setTimeout(resolve, waitMs); })
          ]);
        } finally { clearTimeout(timer); }
      }
    }
    const observedAt = now();
    return active.map(({ source, entry }) => {
      const ageMs = entry.completedAt === null ? null : Math.max(0, observedAt - entry.completedAt);
      const available = entry.value !== null && ageMs !== null && ageMs <= retainMs;
      return { name: source.name, data: available ? entry.value : null, available,
        pending: Boolean(entry.pending), stale: available && ageMs >= refreshMs,
        failed: entry.failed, ageMs, fetchedAt: entry.completedAt === null ? null : new Date(entry.completedAt).toISOString() };
    });
  };
}

module.exports = { createLiveSnapshotReader };
