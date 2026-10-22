/**
 * One bounded dispatcher is shared by every live cycle of an emitter. Admission
 * provides backpressure to paged discovery; completion belongs to the submitting
 * batch, so a slow installation cannot hold up the next observed score cycle.
 */
function createNotificationDispatchQueue({ concurrency = 8, maxPending = 400, onError = () => {} } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxPending) || maxPending < 1) {
    throw new TypeError('Notification dispatch limits must be positive integers');
  }
  const pending = [];
  const admissions = [];
  const occupied = new Set();
  let active = 0;

  function pump() {
    // Admission is FIFO even when several audience readers hit capacity at once.
    while (true) {
      while (admissions.length && pending.length < maxPending) {
        const request = admissions.shift();
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        pending.push({ ...request, finish });
        request.admit({ done });
      }
      if (active >= concurrency) return;
      const index = pending.findIndex(job => !occupied.has(job.key));
      if (index < 0) return;
      const [job] = pending.splice(index, 1);
      active++;
      occupied.add(job.key);
      Promise.resolve().then(job.work).then(
        value => job.finish({ ok: true, value }),
        error => {
          try { Promise.resolve(onError(error)).catch(() => {}); } catch (_) { /* Logging must not stall dispatch. */ }
          job.finish({ ok: false });
        }
      ).finally(() => {
        active--;
        occupied.delete(job.key);
        pump();
      });
    }
  }

  return {
    enqueue(key, work) {
      if (typeof work !== 'function' || typeof key !== 'string' || !key) {
        return Promise.reject(new TypeError('Notification dispatch requires an installation key and work'));
      }
      return new Promise(admit => { admissions.push({ key, work, admit }); pump(); });
    }
  };
}

module.exports = { createNotificationDispatchQueue };
