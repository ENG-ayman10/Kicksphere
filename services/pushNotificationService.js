const { getMessaging } = require('firebase-admin/messaging');
const { createHash } = require('node:crypto');
const logger = require('../utils/logger');
const { normalizeProviderTimestamp } = require('../utils/providerTimestamp');
const { validatedProviderIdentities } = require('../utils/matchProviderIdentities');
const { eventCategoryEnabled } = require('../utils/notificationContracts');
const clean = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : '';
const finiteScore = value => Number.isFinite(Number(value)) && value !== null && value !== '' && value !== undefined ? Number(value) : null;
const penaltyTitles = Object.freeze({
  penalty_awarded: ['احتُسبت ركلة جزاء', 'Penalty awarded'],
  penalty_missed: ['ركلة جزاء ضائعة', 'Penalty missed'],
  penalty_saved: ['تصدى الحارس لركلة الجزاء', 'Penalty saved'],
  shootout_scored: ['ركلة ترجيح ناجحة', 'Shootout penalty scored'],
  shootout_missed: ['ركلة ترجيح ضائعة', 'Shootout penalty missed'],
  shootout_saved: ['تصدى الحارس لركلة الترجيح', 'Shootout penalty saved'],
});

function buildEventNotification(event, language = 'en') {
  const arabic = language === 'ar';
  const titles = {
    goal: ['⚽ هدف!', '⚽ Goal!'], goalCancelled: ['إلغاء هدف', 'Goal cancelled'],
    scoreCorrection: ['تصحيح النتيجة', 'Score corrected'],
    matchReminder: ['المباراة تبدأ بعد 15 دقيقة', 'Kickoff in 15 minutes'],
    lineup: ['التشكيلة الرسمية جاهزة', 'Confirmed lineups are ready'],
    matchStart: ['بدأت المباراة', 'Kickoff'], matchEnd: ['نهاية المباراة', 'Full time'],
    halfTime: ['نهاية الشوط الأول', 'Half time'], secondHalfStart: ['بدأ الشوط الثاني', 'Second half started'],
    extraTimeStart: ['بدأ الوقت الإضافي', 'Extra time started'], penaltyShootout: ['ركلات الترجيح', 'Penalty shootout'],
    matchPostponed: ['تأجيل المباراة', 'Match postponed'], matchCancelled: ['إلغاء المباراة', 'Match cancelled'],
    redCard: ['🟥 بطاقة حمراء', '🟥 Red card'], yellowCard: ['بطاقة صفراء', 'Yellow card'],
    substitution: ['تبديل لاعب', 'Substitution'], penalty: ['ركلة جزاء', 'Penalty'],
    var: ['تحديث تقنية الفيديو', 'VAR update'],
  };
  const card = event.type === 'card' ? (event.cardType === 'yellow' ? 'yellowCard' : 'redCard') : event.type;
  const title = (event.type === 'penalty' ? penaltyTitles[event.penaltyType]?.[arabic ? 0 : 1] : null) ||
    titles[card]?.[arabic ? 0 : 1] || clean(event.title) || (arabic ? 'تحديث المباراة' : 'Match update');
  const homeName = event.homeTeam ? event.homeTeam.name : event.side === 'away' ? event.against : event.team;
  const awayName = event.awayTeam ? event.awayTeam.name : event.side === 'away' ? event.team : event.against;
  const teams = [clean(homeName), clean(awayName)].filter(Boolean).join(arabic ? ' ضد ' : ' vs ');
  const score = typeof event.score === 'string' ? clean(event.score, 32)
    : event.score?.home !== null && event.score?.home !== undefined ? `${event.score.home} - ${event.score.away ?? '-'}` : '';
  const incoming = clean(event.player);
  const outgoing = clean(event.playerOut);
  const details = [event.type === 'substitution' && incoming && outgoing
    ? `${arabic ? 'دخول: ' : 'In: '}${incoming} · ${arabic ? 'خروج: ' : 'Out: '}${outgoing}` : incoming,
    event.assist ? (arabic ? 'صناعة: ' : 'Assist: ') + clean(event.assist) : '']
    .filter(Boolean).join(' · ') || clean(event.isDetailed ? event.message : '');
  const minute = event.minute !== null && event.minute !== undefined && /^\d{1,3}(?:\+\d{1,2})?$/.test(String(event.minute))
    ? `${event.minute}′` : '';
  const preMatch = ['matchReminder', 'lineup', 'matchPostponed', 'matchCancelled'].includes(event.type);
  return { title, message: [teams, preMatch ? '' : score, details, preMatch ? '' : minute].filter(Boolean).join(' — ') };
}

function normalizedEvent(event) {
  const homeTeam = { id: clean(event.homeTeam ? event.homeTeam.id : Object.hasOwn(event, 'homeTeamId')
    ? event.homeTeamId : event.side === 'away' ? event.againstTeamId : event.teamId, 120),
    name: clean(event.homeTeam ? event.homeTeam.name : event.side === 'away' ? event.against : event.team) };
  const awayTeam = { id: clean(event.awayTeam ? event.awayTeam.id : Object.hasOwn(event, 'awayTeamId')
    ? event.awayTeamId : event.side === 'away' ? event.teamId : event.againstTeamId, 120),
    name: clean(event.awayTeam ? event.awayTeam.name : event.side === 'away' ? event.team : event.against) };
  const legacyScore = typeof event.score === 'string' ? event.score.split(/\s*-\s*/) : [];
  const score = { home: finiteScore(event.score?.home ?? event.scoreValues?.home ?? legacyScore[0]),
    away: finiteScore(event.score?.away ?? event.scoreValues?.away ?? legacyScore[1]) };
  const createdAt = event.createdAt?.toMillis ? event.createdAt.toMillis() : new Date(event.createdAt || Date.now()).getTime();
  const lastUpdated = normalizeProviderTimestamp(event.lastUpdated);
  const providerIdentities = validatedProviderIdentities(event);
  return { eventId: clean(event.eventId, 128), ...(event.matchId ? { matchId: clean(event.matchId, 120) } : {}),
    type: clean(event.type, 32), kind: event.kind === 'systemTest' ? 'systemTest' : 'match',
    provider: clean(event.provider || event.source || (event.matchId?.startsWith('bsd_') ? 'bsd' : event.matchId?.startsWith('ko_') ? 'kickoffapi' : 'sportscore'), 32),
    emittedAt: Number.isFinite(createdAt) ? createdAt : Date.now(), homeTeam, awayTeam,
    ...(lastUpdated ? { lastUpdated } : {}),
    ...(providerIdentities.length >= 2 ? { providerIdentities,
      utcDate: providerIdentities[0].utcDate, competitionCode: providerIdentities[0].competitionCode } : {}),
    team: clean(event.team), against: clean(event.against), teamId: clean(event.teamId, 120),
    againstTeamId: clean(event.againstTeamId, 120), side: ['home', 'away'].includes(event.side) ? event.side : '',
    score, player: clean(event.player), minute: event.minute === null || event.minute === undefined ? null : clean(String(event.minute), 12),
    cardType: clean(event.cardType, 32), tournament: clean(event.tournament),
    ...(event.assist ? { assist: clean(event.assist, 96) } : {}),
    ...(event.playerOut ? { playerOut: clean(event.playerOut, 96) } : {}),
    ...(event.penaltyType === 'penalty' || Object.hasOwn(penaltyTitles, event.penaltyType || '')
      ? { penaltyType: event.penaltyType } : {}),
    ...(normalizeProviderTimestamp(event.utcDate) ? { utcDate: normalizeProviderTimestamp(event.utcDate) } : {}),
    ...(event.previousScore ? { previousScore: {
      home: finiteScore(event.previousScore.home), away: finiteScore(event.previousScore.away) } } : {}),
    ...(event.reminderMinutes === 15 ? { reminderMinutes: 15 } : {}),
    ...(event.lineupConfirmed === true ? { lineupConfirmed: true } : {}),
    ...(event.phase ? { phase: clean(event.phase, 32) } : {}),
    ...(event.incidentId ? { incidentId: clean(String(event.incidentId), 120) } : {}) };
}

function buildPushMessage(token, title, body, options = {}) {
  const preferences = options.preferences || {};
  const event = options.event ? normalizedEvent(options.event) : null;
  const type = event?.type || 'systemTest';
  // Keep the latest score/correction on the OS card. The inbox and payload
  // retain each distinct event ID, including a goal after a cancellation.
  const notificationTag = event?.matchId && ['goal', 'goalCancelled', 'scoreCorrection'].includes(type)
    ? `score_${createHash('sha256').update(event.matchId).digest('hex').slice(0, 40)}` : event?.eventId;
  const sound = preferences.sound !== false;
  const vibration = preferences.vibration !== false;
  const ttl = Number.isFinite(options.ttlMs) ? Math.max(1000, Math.min(5 * 60 * 1000, options.ttlMs)) : 5 * 60 * 1000;
  let data = event ? { event: JSON.stringify(event), eventId: event.eventId, type, kind: event.kind,
    ...(event.matchId ? { matchId: event.matchId } : {}), provider: event.provider, emittedAt: String(event.emittedAt),
    ...(event.lastUpdated ? { lastUpdated: event.lastUpdated } : {}),
    homeTeam: JSON.stringify(event.homeTeam), awayTeam: JSON.stringify(event.awayTeam),
    team: event.team, against: event.against, teamId: event.teamId, againstTeamId: event.againstTeamId,
    side: event.side, scoreHome: event.score.home === null ? '' : String(event.score.home),
    scoreAway: event.score.away === null ? '' : String(event.score.away), player: event.player,
    minute: event.minute ?? '', cardType: event.cardType, sound: String(sound), vibration: String(vibration) } : {};
  const notification = { title: clean(title, 96), body: clean(body, 180) };
  const recipient = options.recipientUserId ? clean(options.recipientUserId, 128) : null;
  if (recipient) data.recipientUserId = recipient;
  const payloadBytes = () => Buffer.byteLength(JSON.stringify({ notification, data }), 'utf8');
  if (event && payloadBytes() > 3500) {
    // The compact JSON is authoritative; duplicated compatibility fields can be omitted.
    for (const field of ['team', 'against', 'player', 'tournament']) event[field] = clean(event[field], 64);
    event.homeTeam.name = clean(event.homeTeam.name, 64);
    event.awayTeam.name = clean(event.awayTeam.name, 64);
    data = { event: JSON.stringify(event), eventId: event.eventId, type, kind: event.kind,
      ...(event.matchId ? { matchId: event.matchId } : {}), provider: event.provider, emittedAt: String(event.emittedAt),
      ...(event.lastUpdated ? { lastUpdated: event.lastUpdated } : {}),
      sound: String(sound), vibration: String(vibration) };
    if (recipient) data.recipientUserId = recipient;
    if (payloadBytes() > 3500) {
      // Preserve every verified identity and the oriented canonical participants.
      // Optional display text cannot crowd navigation or subscription provenance
      // out of the bounded FCM envelope for long IDs and multibyte names.
      for (const field of ['team', 'against', 'player', 'tournament', 'assist', 'playerOut']) if (Object.hasOwn(event, field)) event[field] = '';
      event.homeTeam.name = '';
      event.awayTeam.name = '';
      notification.title = clean(notification.title, 48);
      notification.body = clean(notification.body, 80);
      data.event = JSON.stringify(event);
    }
    if (payloadBytes() > 3500) {
      // These legacy fields repeat the participants already kept in homeTeam
      // and awayTeam; the event side retains which participant caused a goal.
      delete event.teamId;
      delete event.againstTeamId;
      notification.title = clean(notification.title, 32);
      notification.body = clean(notification.body, 48);
      data.event = JSON.stringify(event);
    }
  }
  return { token, notification, data,
    android: { priority: 'high', ttl, notification: {
      channelId: `match_events_${type}_s${sound ? 1 : 0}_v${vibration ? 1 : 0}`,
      icon: 'ic_notification', color: '#40607A', priority: 'max',
      ...(notificationTag ? { tag: notificationTag } : {}),
      ...(sound ? { defaultSound: true } : {}), ...(vibration ? { defaultVibrateTimings: true } : {})
    } },
    apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'alert',
      'apns-expiration': String(Math.floor((Date.now() + ttl) / 1000)),
      ...(notificationTag ? { 'apns-collapse-id': notificationTag.slice(0, 64) } : {}) },
      payload: { aps: { ...(sound ? { sound: 'default' } : {}), threadId: event?.matchId || 'system' } } }
  };
}

async function sendPushNotification(token, title, body, options = {}) {
  if (!token) return { sent: false };
  if (options.event?.matchId && (options.preferences?.hideScores === true ||
      !eventCategoryEnabled(options.event.type, options.preferences))) return { sent: false, suppressed: true };
  const kickoff = Date.parse(normalizeProviderTimestamp(options.event?.utcDate) || '');
  if (options.event?.type === 'matchReminder' && Number.isFinite(kickoff) && kickoff <= Date.now()) {
    return { sent: false, expired: true };
  }
  try {
    await getMessaging().send(buildPushMessage(token, title, body, options));
    return { sent: true };
  } catch (error) {
    const invalidToken = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code) ||
      (error.code === 'messaging/invalid-argument' && /registration token is not a valid|invalid registration token/i.test(error.message || ''));
    // FCM errors may contain the request/token; record the error category only.
    if (invalidToken) logger.warn('FCM installation token expired or invalid.');
    else logger.warn(`FCM delivery failed (${clean(error.code || 'unknown', 80)}).`);
    const retryable = !invalidToken && ['messaging/server-unavailable', 'messaging/internal-error', 'messaging/unknown-error',
      'messaging/quota-exceeded', 'messaging/message-rate-exceeded', 'messaging/device-message-rate-exceeded',
      'app/network-error', 'app/network-timeout'].includes(error.code);
    return { sent: false, invalidToken, retryable, errorCode: clean(error.code || 'unknown', 80) };
  }
}
module.exports = { sendPushNotification, buildPushMessage, buildEventNotification };
