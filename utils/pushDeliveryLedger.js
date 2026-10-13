const { createHash, randomUUID } = require('node:crypto');
const { validatedProviderIdentities } = require('./matchProviderIdentities');

const timestampMs = value => value?.toMillis ? value.toMillis() : new Date(value || 0).getTime();
const recordKey = key => createHash('sha256').update(key).digest('hex');
const LEASE_MS = 30000;
const ACCEPTED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_BYTES = 32 * 1024;
const scoreEvent = event => ['goal', 'goalCancelled', 'scoreCorrection'].includes(event.type) && event.matchId;

// Persist public event data only. Tokens are always reread from the current
// installation before sending; credential-bearing envelopes never enter here.
function storedEvent(event) {
  const safe = {};
  for (const field of ['eventId', 'matchId', 'type', 'kind', 'provider', 'source',
    'homeTeam', 'awayTeam', 'homeTeamId', 'awayTeamId', 'team', 'against', 'teamId',
    'againstTeamId', 'side', 'score', 'scoreValues', 'previousScore', 'player',
    'assist', 'playerOut', 'penaltyType', 'minute', 'cardType', 'tournament', 'createdAt', 'emittedAt',
    'lastUpdated', 'providerIdentities', 'utcDate', 'competitionCode',
    'reminderMinutes', 'phase', 'lineupConfirmed', 'incidentId', 'isDetailed',
    'title', 'message']) {
    if (event[field] !== undefined) safe[field] = event[field];
  }
  for (const field of ['homeTeam', 'awayTeam', 'team', 'against']) {
    const value = safe[field];
    if (value && typeof value === 'object') safe[field] = {
      ...(typeof value.id === 'string' || typeof value.id === 'number' ? { id: value.id } : {}),
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
    };
  }
  for (const field of ['score', 'scoreValues', 'previousScore']) {
    const value = safe[field];
    if (value && typeof value === 'object') safe[field] = {
      home: ['number', 'string'].includes(typeof value.home) ? value.home : null,
      away: ['number', 'string'].includes(typeof value.away) ? value.away : null,
    };
  }
  for (const [field, value] of Object.entries(safe)) {
    if (value && typeof value === 'object' && !(value instanceof Date) &&
        !value.toMillis && !['homeTeam', 'awayTeam', 'team', 'against', 'score',
          'scoreValues', 'previousScore', 'providerIdentities'].includes(field)) delete safe[field];
  }
  if (safe.providerIdentities) {
    const identities = validatedProviderIdentities(event);
    if (identities.length >= 2) safe.providerIdentities = identities;
    else delete safe.providerIdentities;
  }
  if (safe.createdAt?.toMillis) safe.createdAt = new Date(safe.createdAt.toMillis()).toISOString();
  const serialized = JSON.stringify(safe, (_, value) =>
    value?.toMillis ? new Date(value.toMillis()).toISOString() : value);
  return Buffer.byteLength(serialized, 'utf8') <= MAX_EVENT_BYTES
    ? JSON.parse(serialized) : null;
}

/** A restart-safe lease/receipt ledger. FCM and Firestore cannot participate in
 * one atomic transaction: a crash after FCM acceptance but before its receipt
 * write can still repeat a transport send. Stable platform notification tags
 * and app event IDs limit duplicate visible alerts. FCM still does not promise
 * device arrival order, even when server score submissions are serialized. */
function createPushDeliveryLedger(database, { now = Date.now, recipientAllowed = () => true,
  queueLimit = 1000 } = {}) {
  const collection = database.collection('notificationDeliveries');
  const heads = database.collection('notificationScoreDeliveryHeads');
  const owner = randomUUID();
  let restoredAt = null;

  async function claim(key, device, event, expiresAt) {
    const publicEvent = storedEvent(event);
    if (!publicEvent) return { status: 'unavailable' };
    const ref = collection.doc(recordKey(key));
    const headRef = scoreEvent(event) ? heads.doc(recordKey(JSON.stringify([
      device.userId, device.deviceId, event.matchId,
    ]))) : null;
    const observedAt = timestampMs(event.createdAt || event.emittedAt);
    return database.runTransaction(async transaction => {
      const [snapshot, headSnapshot] = await Promise.all([
        transaction.get(ref), headRef ? transaction.get(headRef) : null,
      ]);
      const record = snapshot.exists ? snapshot.data() : null;
      const head = headSnapshot?.exists ? headSnapshot.data() : null;
      const time = now();
      if (record?.status === 'accepted' && timestampMs(record.expiresAt) > time) {
        return { status: 'accepted' };
      }
      const headObservedAt = timestampMs(head?.observedAt);
      // Two observed score changes can share the same millisecond. A previously
      // queued occurrence must not replace a later correction at that clock;
      // a new occurrence with no pending record still establishes the next head.
      const supersededAtSameClock = record?.status === 'pending' && head?.eventId &&
        head.eventId !== event.eventId && observedAt === headObservedAt;
      if (head && Number.isFinite(observedAt) && observedAt > 0 &&
          (observedAt < headObservedAt || supersededAtSameClock) && timestampMs(head.expiresAt) > time) {
        return { status: 'obsolete' };
      }
      if (record?.status === 'pending' && timestampMs(record.expiresAt) > time &&
          (timestampMs(record.leaseUntil) > time || timestampMs(record.nextAt) > time)) {
        return { status: 'pending' };
      }
      transaction.set(ref, {
        status: 'pending', device: { userId: device.userId, deviceId: device.deviceId },
        event: publicEvent, retryIndex: record?.retryIndex || 0,
        nextAt: new Date(time), expiresAt: new Date(expiresAt),
        leaseOwner: owner, leaseUntil: new Date(time + LEASE_MS),
        updatedAt: new Date(time),
      });
      if (headRef && Number.isFinite(observedAt) && observedAt > 0) {
        transaction.set(headRef, {
          device: { userId: device.userId, deviceId: device.deviceId },
          eventId: event.eventId,
          observedAt: new Date(observedAt), expiresAt: new Date(time + ACCEPTED_TTL_MS),
        });
      }
      return { status: 'claimed' };
    });
  }

  async function accepted(key, device) {
    await collection.doc(recordKey(key)).set({
      status: 'accepted', acceptedAt: new Date(now()),
      device: { userId: device.userId, deviceId: device.deviceId },
      expiresAt: new Date(now() + ACCEPTED_TTL_MS),
      leaseUntil: null, leaseOwner: null,
    });
  }

  async function queued(key, entry) {
    const publicEvent = storedEvent(entry.event);
    if (!publicEvent) return;
    const ref = collection.doc(recordKey(key));
    await database.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() : null;
      if (current?.status === 'accepted' && timestampMs(current.expiresAt) > now()) return;
      if (current?.leaseOwner && current.leaseOwner !== owner && timestampMs(current.leaseUntil) > now()) return;
      transaction.set(ref, {
        status: 'pending', device: entry.device, event: publicEvent,
        retryIndex: entry.retryIndex, nextAt: new Date(entry.nextAt),
        expiresAt: new Date(entry.expiresAt), leaseUntil: null,
        leaseOwner: null, updatedAt: new Date(now()),
      });
    });
  }

  async function remove(key) {
    const ref = collection.doc(recordKey(key));
    await database.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() : null;
      if (current?.status === 'accepted' && timestampMs(current.expiresAt) > now()) return;
      if (current?.leaseOwner && current.leaseOwner !== owner && timestampMs(current.leaseUntil) > now()) return;
      transaction.delete(ref);
    });
  }

  async function restore(keyFor) {
    const time = now();
    if (restoredAt !== null && time - restoredAt < 15000) return [];
    // Single-field status index; no custom composite index or full account scan.
    const snapshot = await collection.where('status', '==', 'pending')
      .orderBy('__name__').limit(queueLimit).get();
    restoredAt = time;
    const entries = [];
    for (const doc of snapshot.docs) {
      const value = doc.data();
      if (!recipientAllowed(value.device?.userId)) continue;
      const key = value.device?.deviceId && value.event?.eventId
        ? keyFor(value.device, value.event) : null;
      const expiresAt = timestampMs(value.expiresAt);
      if (!key || recordKey(key) !== doc.id || !Number.isFinite(expiresAt) || expiresAt <= time) {
        try { await doc.ref.delete(); } catch (_) { /* Retry cleanup on the next restore. */ }
        continue;
      }
      const nextAt = Math.max(timestampMs(value.nextAt), timestampMs(value.leaseUntil));
      if (!Number.isFinite(nextAt)) {
        try { await doc.ref.delete(); } catch (_) { /* Retry cleanup on the next restore. */ }
        continue;
      }
      entries.push([key, {
        device: value.device, event: value.event,
        retryIndex: Number.isInteger(value.retryIndex) ? value.retryIndex : 0,
        nextAt, expiresAt,
      }]);
    }
    // Expiry cleanup stays bounded and uses its own single-field index. A
    // Firestore TTL policy may also use this Date field for eventual removal.
    try {
      const [expired, expiredHeads] = await Promise.all([
        collection.where('expiresAt', '<=', new Date(time)).limit(100).get(),
        heads.where('expiresAt', '<=', new Date(time)).limit(100).get(),
      ]);
      await Promise.all([...expired.docs, ...expiredHeads.docs].filter(doc => recipientAllowed(doc.data().device?.userId))
        .map(doc => doc.ref.delete()));
    } catch (_) {
      // Cleanup is independent of delivery: a cleanup write outage must not
      // throw away already-restored, otherwise valid pending retries.
    }
    return entries;
  }

  return { claim, accepted, queued, remove, restore };
}

module.exports = { createPushDeliveryLedger, storedEvent };
