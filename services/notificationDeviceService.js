const { createHash, randomUUID } = require('node:crypto');
const db = require('../config/firebase');
const { sendPushNotification, buildEventNotification } = require('./pushNotificationService');
const logger = require('../utils/logger');
const { createLiveRecipientPolicy } = require('../utils/liveDeliveryScope');
const { matchIdentityIds, teamIdentityIds } = require('../utils/matchProviderIdentities');
const { MAX_DEVICES_PER_USER, DEVICE_TTL_MS, validationError, normalizeDeviceId,
  normalizeDeviceRegistration, eventMatchesPreferences } = require('../utils/notificationContracts');
const PAGE_SIZE = 200;
const digest = value => createHash('sha256').update(value).digest('hex');
const deviceKey = (userId, deviceId) => digest(JSON.stringify([userId, deviceId]));
const timestampMs = value => value?.toMillis ? value.toMillis() : new Date(value || 0).getTime();
const isFresh = (device, now) => Number.isFinite(timestampMs(device.lastSeenAt)) && now - timestampMs(device.lastSeenAt) <= DEVICE_TTL_MS;

function createNotificationDeviceService(database, options = {}) {
  const send = options.send || sendPushNotification;
  const recipientAllowed = options.recipientAllowed || createLiveRecipientPolicy();
  const now = options.now || Date.now;
  const devices = database.collection('notificationDevices');
  const tokens = database.collection('notificationTokens');
  const retryQueue = new Map();
  const accepted = new Map();
  const inFlight = new Set();
  const RETRY_DELAYS = [30000, 60000, 120000];
  const RETRY_TTL = 5 * 60 * 1000;
  const retryLimit = options.retryQueueLimit || 1000;
  let flushing = false;
  const retryKey = (device, event) => event.eventId ? `${deviceKey(device.userId, device.deviceId)}:${event.eventId}` : null;
  function markAccepted(key) {
    if (!key) return;
    retryQueue.delete(key); accepted.set(key, now());
    while (accepted.size > 2000) accepted.delete(accepted.keys().next().value);
  }
  function enqueue(device, event, result) {
    const key = retryKey(device, event);
    if (!key || retryQueue.has(key) || accepted.has(key)) return;
    const observedAt = timestampMs(event.createdAt || event.emittedAt);
    const expiresAt = Number.isFinite(observedAt) && observedAt > 0
      ? Math.min(now() + RETRY_TTL, observedAt + RETRY_TTL) : now() + RETRY_TTL;
    const quota = /quota|rate-exceeded/.test(result.errorCode || '');
    const nextAt = now() + (quota ? 60000 : RETRY_DELAYS[0]);
    if (nextAt >= expiresAt) return;
    if (retryQueue.size >= retryLimit) {
      retryQueue.delete(retryQueue.keys().next().value);
      logger.warn('Push retry queue reached its bounded capacity.');
    }
    retryQueue.set(key, { device: { userId: device.userId, deviceId: device.deviceId }, event, retryIndex: 0, nextAt, expiresAt });
  }

  async function register(userId, rawDeviceId, body) {
    const deviceId = normalizeDeviceId(rawDeviceId);
    const registration = normalizeDeviceRegistration(body);
    const key = deviceKey(userId, deviceId);
    const ref = devices.doc(key);
    const tokenRef = tokens.doc(digest(registration.token));
    await database.runTransaction(async transaction => {
      const [existing, owner, audience] = await Promise.all([
        transaction.get(ref), transaction.get(tokenRef),
        transaction.get(devices.where('userId', '==', userId).limit(MAX_DEVICES_PER_USER + 1))
      ]);
      const ownership = owner.exists ? owner.data() : null;
      if (ownership && ownership.deviceKey !== key && ownership.deviceId !== deviceId) {
        throw validationError('This push token is already registered to another installation.', 409);
      }
      if (!existing.exists && audience.docs.length >= MAX_DEVICES_PER_USER) {
        throw validationError('The installation limit has been reached. Revoke an old installation first.', 409);
      }
      const previous = existing.exists ? existing.data() : null;
      const previousTokenRef = previous?.token && previous.token !== registration.token ? tokens.doc(digest(previous.token)) : null;
      const previousOwner = previousTokenRef ? await transaction.get(previousTokenRef) : null;
      const transferredRef = ownership && ownership.deviceKey !== key ? devices.doc(ownership.deviceKey) : null;
      const transferred = transferredRef ? await transaction.get(transferredRef) : null;
      // All reads precede writes. Rotation and account transfer remain atomic on retries.
      if (previousOwner?.exists && previousOwner.data().deviceKey === key) transaction.delete(previousTokenRef);
      if (transferred?.exists && transferred.data().token === registration.token && transferred.data().deviceId === deviceId) {
        transaction.delete(transferredRef);
      }
      transaction.set(ref, { ...registration, userId, deviceId, createdAt: previous?.createdAt || new Date(now()),
        ...(previous?.lastTestAt ? { lastTestAt: previous.lastTestAt } : {}),
        updatedAt: new Date(now()), lastSeenAt: new Date(now()) });
      transaction.set(tokenRef, { userId, deviceId, deviceKey: key });
      transaction.set(database.collection('users').doc(userId), { notificationDeviceVersion: 1, fcmToken: null }, { merge: true });
    });
    return { deviceId, registered: true };
  }

  async function revoke(userId, rawDeviceId, expectedToken) {
    const deviceId = normalizeDeviceId(rawDeviceId);
    const key = deviceKey(userId, deviceId);
    const ref = devices.doc(key);
    let removed = false;
    await database.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const device = snapshot.data();
      if (device.userId !== userId || device.deviceId !== deviceId || (expectedToken && device.token !== expectedToken)) return;
      const tokenRef = tokens.doc(digest(device.token));
      const owner = await transaction.get(tokenRef);
      transaction.delete(ref);
      if (owner.exists && owner.data().deviceKey === key) transaction.delete(tokenRef);
      removed = true;
    });
    return removed;
  }

  async function findRecipients(events) {
    const recipients = new Map();
    const indexedEvents = new Map();
    const addFilter = (field, value, event) => {
      const key = JSON.stringify([field, value]);
      const filter = indexedEvents.get(key) || { field, value, events: new Map() };
      filter.events.set(event.eventId, event);
      indexedEvents.set(key, filter);
    };
    for (const event of events) {
      for (const id of matchIdentityIds(event)) addFilter('preferences.matchIds', id, event);
      if (!event.isDetailed) {
        for (const id of teamIdentityIds(event)) addFilter('preferences.teamIds', id, event);
      }
    }
    const filters = [...indexedEvents.values()];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, filters.length) }, async () => {
      while (cursor < filters.length) {
        const filter = filters[cursor++];
        const query = devices.where(filter.field, 'array-contains', filter.value).orderBy('__name__').limit(PAGE_SIZE);
        let page = query;
        while (true) {
          const snapshot = await page.get();
          for (const document of snapshot.docs) {
            const device = document.data();
            if (!device.userId || !recipientAllowed(device.userId) || !device.token || !isFresh(device, now())) continue;
            const recipient = recipients.get(document.id) || { ...device, key: document.id, events: new Map() };
            for (const event of filter.events.values()) {
              if (eventMatchesPreferences(event, device.preferences)) recipient.events.set(event.eventId, event);
            }
            if (recipient.events.size) recipients.set(document.id, recipient);
          }
          if (snapshot.docs.length < PAGE_SIZE) break;
          page = query.startAfter(snapshot.docs[snapshot.docs.length - 1]);
        }
      }
    }));
    return recipients;
  }

  async function getSubscribedMatchIds(matchIds) {
    // Query observed matches in small disjunctions using the normal array index.
    const subscribed = new Set();
    const chunks = [];
    for (let offset = 0; offset < matchIds.length; offset += 10) chunks.push(matchIds.slice(offset, offset + 10));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        const query = devices.where('preferences.matchIds', 'array-contains-any', chunk).orderBy('__name__').limit(PAGE_SIZE);
        let page = query;
        while (true) {
          const snapshot = await page.get();
          for (const document of snapshot.docs) {
            const device = document.data();
            if (!recipientAllowed(device.userId) || !device.token || device.preferences?.hideScores === true || !isFresh(device, now())) continue;
            for (const matchId of chunk) if (device.preferences?.matchIds?.includes(matchId)) subscribed.add(matchId);
          }
          if (chunk.every(matchId => subscribed.has(matchId)) || snapshot.docs.length < PAGE_SIZE) break;
          page = query.startAfter(snapshot.docs[snapshot.docs.length - 1]);
        }
      }
    }));
    return subscribed;
  }

  async function attemptDelivery(device, event, expiresAt) {
    if (!recipientAllowed(device.userId)) return { sent: false, suppressed: true };
    const snapshot = await devices.doc(deviceKey(device.userId, device.deviceId)).get();
    if (!snapshot.exists) return { sent: false, revoked: true };
    const current = snapshot.data();
    if (!recipientAllowed(current.userId) || current.userId !== device.userId || current.deviceId !== device.deviceId || !isFresh(current, now()) ||
        !eventMatchesPreferences(event, current.preferences)) return { sent: false, suppressed: true };
    const ttlMs = expiresAt ? expiresAt - now() : null;
    if (ttlMs !== null && ttlMs <= 0) return { sent: false, expired: true };
    const notification = buildEventNotification(event, current.language);
    const result = await send(current.token, notification.title, notification.message,
      { event, preferences: current.preferences, language: current.language, recipientUserId: current.userId, ...(ttlMs ? { ttlMs } : {}) });
    if (result?.invalidToken) {
      try { await revoke(current.userId, current.deviceId, current.token); }
      catch (error) { logger.warn('Invalid installation token cleanup failed.'); }
    }
    return result;
  }

  async function deliver(device, event) {
    const key = retryKey(device, event);
    if (key && accepted.has(key)) return { sent: true, duplicate: true };
    if (key && inFlight.has(key)) return { sent: false, pending: true };
    if (key) inFlight.add(key);
    try {
      let result;
      try { result = await attemptDelivery(device, event); }
      catch (error) { result = { sent: false, retryable: true }; }
      if (result?.sent) markAccepted(key);
      else if (result?.retryable && !result.invalidToken) enqueue(device, event, result);
      else if (key) retryQueue.delete(key);
      return result;
    } finally { if (key) inFlight.delete(key); }
  }

  async function flushRetries() {
    if (flushing) return { attempted: 0, queued: retryQueue.size };
    flushing = true;
    let attempted = 0;
    try {
      const time = now();
      for (const [key, recordedAt] of accepted) if (time - recordedAt > RETRY_TTL) accepted.delete(key);
      for (const [key, entry] of retryQueue) if (time >= entry.expiresAt) retryQueue.delete(key);
      const due = [...retryQueue].filter(([, entry]) => entry.nextAt <= time).slice(0, 100);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, due.length) }, async () => {
        while (cursor < due.length) {
          const [key, entry] = due[cursor++];
          if (inFlight.has(key) || retryQueue.get(key) !== entry) continue;
          if (now() >= entry.expiresAt) { retryQueue.delete(key); continue; }
          inFlight.add(key); attempted++;
          try {
            let result;
            try { result = await attemptDelivery(entry.device, entry.event, entry.expiresAt); }
            catch (error) { result = { sent: false, retryable: true }; }
            if (result?.sent) { markAccepted(key); continue; }
            if (!result?.retryable || result.invalidToken || ++entry.retryIndex >= RETRY_DELAYS.length) {
              retryQueue.delete(key); continue;
            }
            entry.nextAt = now() + RETRY_DELAYS[entry.retryIndex];
            if (entry.nextAt >= entry.expiresAt) retryQueue.delete(key);
          } finally { inFlight.delete(key); }
        }
      }));
      return { attempted, queued: retryQueue.size };
    } finally { flushing = false; }
  }

  async function testDevice(userId, rawDeviceId) {
    const deviceId = normalizeDeviceId(rawDeviceId);
    const ref = devices.doc(deviceKey(userId, deviceId));
    let device;
    await database.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().userId !== userId) throw validationError('Installation is not registered.', 404);
      device = snapshot.data();
      if (now() - timestampMs(device.lastTestAt) < 60000) throw validationError('Wait one minute before sending another test.', 429);
      transaction.set(ref, { lastTestAt: new Date(now()) }, { merge: true });
    });
    const arabic = device.language === 'ar';
    const event = { type: 'systemTest', kind: 'systemTest', eventId: `test_${randomUUID()}`, createdAt: new Date(now()) };
    const result = await send(device.token, arabic ? 'اختبار الإشعارات' : 'Notification test',
      arabic ? 'هذا إشعار تجريبي من KickSphere.' : 'This is a KickSphere test notification.',
      { event, preferences: device.preferences, language: device.language, recipientUserId: userId });
    if (result?.invalidToken) await revoke(userId, deviceId, device.token);
    return { sent: result?.sent === true, invalidToken: result?.invalidToken === true, eventId: event.eventId };
  }
  return { register, revoke, findRecipients, getSubscribedMatchIds, deliver, flushRetries, testDevice };
}
module.exports = { ...createNotificationDeviceService(db), createNotificationDeviceService, deviceKey };
