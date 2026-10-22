const NOTIFICATION_TTL_MS = 5 * 60 * 1000;

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  try {
    return typeof value?.toMillis === 'function' ? value.toMillis()
      : typeof value === 'number' ? value : new Date(value).getTime();
  } catch (_) { return NaN; }
}

// Keep wire ordering, durable score heads and expiry on the same clock even
// when a legacy envelope only carries emittedAt or has an invalid createdAt.
function notificationObservedAt(event = {}, fallback = Date.now()) {
  event = event && typeof event === 'object' ? event : {};
  const createdAt = timestampMs(event.createdAt);
  const emittedAt = timestampMs(event.emittedAt);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt
    : Number.isFinite(emittedAt) && emittedAt > 0 ? emittedAt : fallback;
}

// Delivery retries, registration reads and OS storage share one event lifetime.
// A delayed sender must never turn an old event into a fresh five-minute alert.
function notificationExpiresAt(event = {}, now = Date.now(), upperBound) {
  event = event && typeof event === 'object' ? event : {};
  const observedAt = notificationObservedAt(event, now);
  let expiresAt = Math.min(now + NOTIFICATION_TTL_MS, observedAt + NOTIFICATION_TTL_MS);
  if (Number.isFinite(upperBound)) expiresAt = Math.min(expiresAt, upperBound);
  const kickoff = event.type === 'matchReminder' ? timestampMs(event.utcDate) : NaN;
  if (Number.isFinite(kickoff) && kickoff > 0) expiresAt = Math.min(expiresAt, kickoff);
  return expiresAt;
}

module.exports = { NOTIFICATION_TTL_MS, notificationObservedAt, notificationExpiresAt };
